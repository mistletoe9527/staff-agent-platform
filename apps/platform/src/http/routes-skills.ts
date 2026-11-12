import { createReadStream, existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  AuthViewer,
  SkillDetail,
  SkillListResponse,
  SkillStatus,
  SkillSummary,
  SkillVersionView,
} from '@staff-agent/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import {
  addSkillVersion,
  createSkill,
  deleteSkill,
  findLatestVersion,
  findSkillById,
  findSkillVersion,
  listCategories,
  listSkills,
  listSkillVersions,
  nextVersion,
  recordDownload,
  toSkill,
  updateSkill,
  type Skill,
  type SkillListRow,
  type SkillVersion,
} from '../domain/skills.js';
import { audit } from '../domain/audit.js';
import {
  SkillValidationError,
  deleteSkillFile,
  deleteSkillFiles,
  deriveSkillName,
  deriveSkillSummary,
  inspectSkillZip,
  markdownSkillZip,
  resolveSkillFile,
  saveSkillFile,
  slugify,
} from '../services/skill-storage.js';
import { readViewer, viewerKey } from '../services/web-auth.js';
import { newId } from '../util/ids.js';
import { errorText, type Logger } from '../util/logger.js';

/** Skill 路由依赖。 */
export interface SkillRouteDeps {
  db: Db;
  config: Config;
  logger: Logger;
}

/** 列表查询参数。 */
const ListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(32).optional(),
  sort: z.enum(['latest', 'popular', 'name']).default('latest'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(60).default(24),
  mine: z.enum(['0', '1']).optional(),
  includeHidden: z.enum(['0', '1']).optional(),
});

/** 上传参数（包体本身走 raw body，元数据放 query）。 */
const UploadQuerySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  summary: z.string().trim().max(200).optional(),
  description: z.string().trim().max(5000).optional(),
  category: z.string().trim().max(32).optional(),
  tags: z.string().trim().max(400).optional(),
  version: z.string().trim().max(32).optional(),
  changelog: z.string().trim().max(1000).optional(),
  filename: z.string().trim().max(255).optional(),
});

/** 编辑请求。 */
const PatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  summary: z.string().trim().max(200).optional(),
  description: z.string().max(5000).optional(),
  category: z.string().trim().min(1).max(32).optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(12).optional(),
  status: z.enum(['active', 'hidden']).optional(),
});

/** 把逗号分隔的 tags 归一化。 */
function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(/[,，]/)) {
    const tag = part.trim().slice(0, 24);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    result.push(tag);
    if (result.length >= 12) break;
  }
  return result;
}

/** 文件名只保留 basename，避免把路径写进数据库。 */
function sanitizeFilename(value: string | undefined, fallback: string): string {
  const name = basename((value ?? '').trim().replace(/\\/g, '/')) || fallback;
  return name.replace(/[\u0000-\u001f]/g, '').slice(0, 255) || fallback;
}

/** 当前用户是否可管理该 Skill。 */
function canManage(skill: Skill, viewer: AuthViewer): boolean {
  return viewer.isAdmin || (viewer.openId !== null && skill.ownerOpenId === viewer.openId);
}

/** 当前用户是否可见：隐藏 Skill 仅作者与管理员可见。 */
function canView(skill: Skill, viewer: AuthViewer): boolean {
  return skill.status === 'active' || canManage(skill, viewer);
}

/** 作者 key：管理员上传的 Skill 归属 `admin`。 */
function ownerKey(viewer: AuthViewer): string {
  return viewer.openId ?? 'admin';
}

/** 列表行转视图。 */
function toSummary(row: SkillListRow, viewer: AuthViewer): SkillSummary {
  const skill = toSkill(row);
  return {
    ...skill,
    latestVersion: row.latest_version,
    latestVersionId: row.latest_version_id,
    fileSizeBytes: row.latest_size_bytes,
    versionCount: row.version_count,
    canManage: canManage(skill, viewer),
  };
}

/** 版本转视图。 */
function toVersionView(version: SkillVersion, latestId: string | null): SkillVersionView {
  return {
    id: version.id,
    version: version.version,
    filename: version.filename,
    sizeBytes: version.sizeBytes,
    sha256: version.sha256,
    changelog: version.changelog,
    createdAt: version.createdAt,
    createdByOpenId: version.createdByOpenId,
    downloads: version.downloads,
    files: version.files,
    isLatest: version.id === latestId,
  };
}

/** 详情聚合。 */
function toDetail(skill: Skill, versions: SkillVersion[], viewer: AuthViewer): SkillDetail {
  const latest = versions[0] ?? null;
  return {
    ...skill,
    latestVersion: latest?.version ?? null,
    latestVersionId: latest?.id ?? null,
    fileSizeBytes: latest?.sizeBytes ?? null,
    versionCount: versions.length,
    canManage: canManage(skill, viewer),
    description: skill.description,
    readme: latest?.readme ?? '',
    versions: versions.map((version) => toVersionView(version, latest?.id ?? null)),
  };
}

/** 统一鉴权：未登录返回 401。 */
function requireViewer(request: FastifyRequest, reply: FastifyReply, config: Config): AuthViewer | null {
  const viewer = readViewer(request, config);
  if (!viewer) {
    void reply.code(401).send({ ok: false, error: '请先登录后再访问 Skill 广场', code: 'UNAUTHORIZED' });
    return null;
  }
  return viewer;
}

/** 读取原始包体；`text/markdown` 会在服务端包成 zip。 */
function readUploadBody(request: FastifyRequest): Buffer {
  const body = request.body;
  if (!Buffer.isBuffer(body)) {
    throw new SkillValidationError('请以 application/zip 或 text/markdown 上传 Skill 包');
  }
  const contentType = (request.headers['content-type'] ?? '').toLowerCase();
  if (contentType.includes('text/markdown') || contentType.includes('text/plain')) {
    return markdownSkillZip(body.toString('utf8'));
  }
  return body;
}

/** 组合上传元数据。 */
function buildMeta(
  inspected: ReturnType<typeof inspectSkillZip>,
  query: z.infer<typeof UploadQuerySchema>,
  viewer: AuthViewer,
  fallbackName: string,
): {
  name: string;
  summary: string;
  description: string;
  category: string;
  tags: string[];
} {
  const name = (query.name ?? deriveSkillName(inspected.frontmatter, inspected.readme, fallbackName)).slice(0, 80);
  const summary = (
    query.summary ??
    deriveSkillSummary(inspected.frontmatter, inspected.readme, `来自 ${viewer.name} 的 Skill`)
  ).slice(0, 200);
  const description = (query.description ?? inspected.frontmatter.description ?? summary).slice(0, 5000);
  return {
    name,
    summary,
    description,
    category: (query.category || '通用').slice(0, 32),
    tags: parseTags(query.tags),
  };
}

/** 是否为版本唯一键冲突。 */
function isVersionConflict(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: skill_versions/.test(error.message);
}

/**
 * Skill 广场 API。
 *
 * 所有接口都要求登录（管理员口令会话或飞书员工会话）。
 * 上传走 raw zip body，避免引入 multipart 依赖；
 * 前端会把文件夹 / 单个 Markdown 在浏览器里打包成 zip。
 */
export function registerSkillRoutes(app: FastifyInstance, deps: SkillRouteDeps): void {
  const { db, config, logger } = deps;

  const limits = {
    maxBytes: config.SKILL_MAX_BYTES,
    maxExtractedBytes: config.SKILL_MAX_EXTRACTED_BYTES,
    maxFiles: config.SKILL_MAX_FILES,
  };

  // 列表 / 搜索 / 分类
  app.get('/api/skills', async (request, reply) => {
    const viewer = requireViewer(request, reply, config);
    if (!viewer) return;
    const parsed = ListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') });
    }
    const query = parsed.data;
    const includeHidden = viewer.isAdmin && query.includeHidden === '1';
    // 「只看我上传的」时把自己的隐藏 Skill 也列出来，方便作者看到下架状态
    const showHidden = includeHidden || query.mine === '1';
    const result = listSkills(db, {
      q: query.q,
      category: query.category,
      sort: query.sort,
      status: showHidden ? 'all' : 'active',
      ownerOpenId: query.mine === '1' ? ownerKey(viewer) : undefined,
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    });
    const response: SkillListResponse = {
      items: result.rows.map((row) => toSummary(row, viewer)),
      total: result.total,
      page: query.page,
      limit: query.limit,
      categories: listCategories(db, viewer.isAdmin),
    };
    return response;
  });

  // 详情
  app.get('/api/skills/:id', async (request, reply) => {
    const viewer = requireViewer(request, reply, config);
    if (!viewer) return;
    const params = request.params as { id: string };
    const skill = findSkillById(db, params.id);
    if (!skill || !canView(skill, viewer)) {
      return reply.code(404).send({ ok: false, error: 'Skill 不存在或已被隐藏' });
    }
    return toDetail(skill, listSkillVersions(db, skill.id), viewer);
  });

  // 下载指定版本（不传 version 取最新）
  app.get('/api/skills/:id/download', async (request, reply) => {
    const viewer = requireViewer(request, reply, config);
    if (!viewer) return;
    const params = request.params as { id: string };
    const query = request.query as { version?: string };
    const skill = findSkillById(db, params.id);
    if (!skill || !canView(skill, viewer)) {
      return reply.code(404).send({ ok: false, error: 'Skill 不存在或已被隐藏' });
    }
    const version = query.version
      ? findSkillVersion(db, skill.id, query.version.trim())
      : findLatestVersion(db, skill.id);
    if (!version) {
      return reply.code(404).send({ ok: false, error: '版本不存在' });
    }
    let absolute: string;
    try {
      absolute = resolveSkillFile(config.DATA_DIR, version.filePath);
    } catch (error) {
      logger.error({ err: errorText(error), skillId: skill.id, version: version.version }, 'Skill 文件路径非法');
      return reply.code(500).send({ ok: false, error: 'Skill 文件路径非法' });
    }
    if (!existsSync(absolute)) {
      logger.error({ skillId: skill.id, version: version.version, path: absolute }, 'Skill 文件缺失');
      return reply.code(410).send({ ok: false, error: 'Skill 包文件已丢失，请联系管理员' });
    }
    try {
      recordDownload(db, { skillId: skill.id, versionId: version.id, viewerKey: viewerKey(viewer) });
    } catch (error) {
      // 下载统计失败不阻断下载
      logger.warn({ err: errorText(error), skillId: skill.id }, 'Skill 下载统计失败');
    }
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', `attachment; filename="${skill.slug}-${version.version}.zip"`);
    reply.header('cache-control', 'no-store');
    reply.header('content-length', String(version.sizeBytes));
    return reply.send(createReadStream(absolute));
  });

  // 创建 Skill（首版）
  app.post(
    '/api/skills',
    { bodyLimit: config.SKILL_MAX_BYTES + 4096 },
    async (request, reply) => {
      const viewer = requireViewer(request, reply, config);
      if (!viewer) return;
      const parsed = UploadQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') });
      }
      const query = parsed.data;
      const filename = sanitizeFilename(query.filename, 'skill.zip');
      let inspected: ReturnType<typeof inspectSkillZip>;
      try {
        inspected = inspectSkillZip(readUploadBody(request), limits);
      } catch (error) {
        if (error instanceof SkillValidationError) return reply.code(400).send({ ok: false, error: error.message });
        throw error;
      }
      const fallbackName = filename.replace(/\.(zip|md)$/i, '');
      const meta = buildMeta(inspected, query, viewer, fallbackName || '未命名 Skill');
      let version: string;
      try {
        // 首版允许直接沿用 SKILL.md frontmatter 里的 version
        version = nextVersion(query.version || inspected.frontmatter.version, null);
      } catch (error) {
        return reply.code(400).send({ ok: false, error: error instanceof Error ? error.message : '版本号非法' });
      }
      const skill = createSkill(db, {
        slug: slugify(meta.name),
        name: meta.name,
        summary: meta.summary,
        description: meta.description,
        category: meta.category,
        tags: meta.tags,
        ownerOpenId: ownerKey(viewer),
        ownerName: viewer.name,
      });
      const versionId = newId('skv');
      let stored: ReturnType<typeof saveSkillFile>;
      try {
        stored = saveSkillFile(config.DATA_DIR, skill.id, versionId, inspected.zip);
        addSkillVersion(db, {
          id: versionId,
          skillId: skill.id,
          version,
          filename,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          filePath: stored.relativePath,
          readme: inspected.readme,
          changelog: query.changelog || '初始版本',
          files: inspected.files,
          createdByOpenId: ownerKey(viewer),
        });
      } catch (error) {
        deleteSkill(db, skill.id);
        deleteSkillFiles(config.DATA_DIR, skill.id);
        if (isVersionConflict(error)) {
          return reply.code(409).send({ ok: false, error: `版本 ${version} 已存在` });
        }
        throw error;
      }
      audit(db, {
        actor: viewerKey(viewer),
        action: 'skill.create',
        target: skill.id,
        detail: JSON.stringify({ name: skill.name, version }),
      });
      logger.info({ skillId: skill.id, name: skill.name, version, size: stored.sizeBytes }, 'Skill 已上传');
      const created = findSkillById(db, skill.id);
      return reply.code(201).send(toDetail(created ?? skill, listSkillVersions(db, skill.id), viewer));
    },
  );

  // 上传新版本
  app.post(
    '/api/skills/:id/versions',
    { bodyLimit: config.SKILL_MAX_BYTES + 4096 },
    async (request, reply) => {
      const viewer = requireViewer(request, reply, config);
      if (!viewer) return;
      const params = request.params as { id: string };
      const skill = findSkillById(db, params.id);
      if (!skill) return reply.code(404).send({ ok: false, error: 'Skill 不存在' });
      if (!canManage(skill, viewer)) {
        return reply.code(403).send({ ok: false, error: '只有作者或管理员可以上传新版本' });
      }
      const parsed = UploadQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') });
      }
      const query = parsed.data;
      const filename = sanitizeFilename(query.filename, 'skill.zip');
      let inspected: ReturnType<typeof inspectSkillZip>;
      try {
        inspected = inspectSkillZip(readUploadBody(request), limits);
      } catch (error) {
        if (error instanceof SkillValidationError) return reply.code(400).send({ ok: false, error: error.message });
        throw error;
      }
      const latest = findLatestVersion(db, skill.id);
      let version: string;
      try {
        version = nextVersion(query.version, latest?.version ?? null);
      } catch (error) {
        return reply.code(400).send({ ok: false, error: error instanceof Error ? error.message : '版本号非法' });
      }
      if (findSkillVersion(db, skill.id, version)) {
        return reply.code(409).send({ ok: false, error: `版本 ${version} 已存在，请修改版本号` });
      }
      const versionId = newId('skv');
      let stored: ReturnType<typeof saveSkillFile> | null = null;
      try {
        stored = saveSkillFile(config.DATA_DIR, skill.id, versionId, inspected.zip);
        addSkillVersion(db, {
          id: versionId,
          skillId: skill.id,
          version,
          filename,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          filePath: stored.relativePath,
          readme: inspected.readme,
          changelog: query.changelog || `更新到 ${version}`,
          files: inspected.files,
          createdByOpenId: ownerKey(viewer),
        });
      } catch (error) {
        // 只回滚本次新写入的文件，不能删掉历史版本
        if (stored) deleteSkillFile(config.DATA_DIR, stored.relativePath);
        if (isVersionConflict(error)) {
          return reply.code(409).send({ ok: false, error: `版本 ${version} 已存在` });
        }
        throw error;
      }
      // 允许在传新版时顺手更新元数据；不传则保持原样
      const meta = buildMeta(inspected, query, viewer, skill.name);
      const patch: Parameters<typeof updateSkill>[2] = {};
      if (query.name) patch.name = meta.name;
      if (query.summary) patch.summary = meta.summary;
      if (query.description) patch.description = meta.description;
      if (query.category) patch.category = meta.category;
      if (query.tags) patch.tags = meta.tags;
      if (Object.keys(patch).length > 0) updateSkill(db, skill.id, patch);
      audit(db, {
        actor: viewerKey(viewer),
        action: 'skill.version.create',
        target: skill.id,
        detail: JSON.stringify({ name: skill.name, version }),
      });
      logger.info({ skillId: skill.id, version, size: stored.sizeBytes }, 'Skill 新版本已上传');
      const updated = findSkillById(db, skill.id) ?? skill;
      return reply.code(201).send(toDetail(updated, listSkillVersions(db, skill.id), viewer));
    },
  );

  // 编辑元数据 / 管理员隐藏
  app.patch('/api/skills/:id', async (request, reply) => {
    const viewer = requireViewer(request, reply, config);
    if (!viewer) return;
    const params = request.params as { id: string };
    const skill = findSkillById(db, params.id);
    if (!skill) return reply.code(404).send({ ok: false, error: 'Skill 不存在' });
    if (!canManage(skill, viewer)) {
      return reply.code(403).send({ ok: false, error: '只有作者或管理员可以修改' });
    }
    const parsed = PatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') });
    }
    if (parsed.data.status !== undefined && !viewer.isAdmin) {
      return reply.code(403).send({ ok: false, error: '只有管理员可以隐藏 / 恢复 Skill' });
    }
    const patch: Parameters<typeof updateSkill>[2] = { ...parsed.data };
    if (parsed.data.status) patch.status = parsed.data.status as SkillStatus;
    if (patch.tags) {
      const seen = new Set<string>();
      patch.tags = patch.tags.filter((tag) => {
        const key = tag.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    updateSkill(db, skill.id, patch);
    audit(db, {
      actor: viewerKey(viewer),
      action: 'skill.update',
      target: skill.id,
      detail: JSON.stringify(parsed.data),
    });
    const updated = findSkillById(db, skill.id) ?? skill;
    return toDetail(updated, listSkillVersions(db, skill.id), viewer);
  });

  // 删除：需要带上名称二次确认
  app.delete('/api/skills/:id', async (request, reply) => {
    const viewer = requireViewer(request, reply, config);
    if (!viewer) return;
    const params = request.params as { id: string };
    const query = request.query as { confirm?: string };
    const skill = findSkillById(db, params.id);
    if (!skill) return reply.code(404).send({ ok: false, error: 'Skill 不存在' });
    if (!canManage(skill, viewer)) {
      return reply.code(403).send({ ok: false, error: '只有作者或管理员可以删除' });
    }
    if ((query.confirm ?? '').trim().toLowerCase() !== skill.name.trim().toLowerCase()) {
      return reply.code(400).send({
        ok: false,
        error: `确认参数不匹配：请带上 ?confirm=${encodeURIComponent(skill.name)}`,
      });
    }
    deleteSkill(db, skill.id);
    deleteSkillFiles(config.DATA_DIR, skill.id);
    audit(db, {
      actor: viewerKey(viewer),
      action: 'skill.delete',
      target: skill.id,
      detail: JSON.stringify({ name: skill.name, owner: skill.ownerName }),
    });
    logger.info({ skillId: skill.id, name: skill.name }, 'Skill 已删除');
    return { ok: true };
  });
}
