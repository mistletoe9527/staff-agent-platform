import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { parseSkillFrontmatter, type SkillFileEntry } from '@staff-agent/shared';

/** Skill 包校验限制。 */
export interface SkillLimits {
  /** 压缩包最大字节数 */
  maxBytes: number;
  /** 解压后总字节数上限 */
  maxExtractedBytes: number;
  /** 包内文件数上限 */
  maxFiles: number;
}

/** 校验失败：信息直接展示给上传者。 */
export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillValidationError';
  }
}

/** 校验并规范化后的 Skill 包。 */
export interface InspectedSkill {
  /** 去掉顶层目录、垃圾文件后的 zip 字节 */
  zip: Buffer;
  /** SKILL.md 原文（截断） */
  readme: string;
  /** SKILL.md frontmatter */
  frontmatter: Record<string, string>;
  /** 包内文件清单 */
  files: SkillFileEntry[];
  /** 解压后总大小 */
  totalBytes: number;
}

/** SKILL.md 入库上限，避免某个包把详情页撑爆。 */
const README_MAX_CHARS = 200_000;
/** 单个文件上限，防止解压后单文件过大。 */
const SINGLE_FILE_MAX_BYTES = 40 * 1024 * 1024;

/**
 * 规范化 zip 内路径。
 * @returns 安全路径；目录项/垃圾文件返回 null；越界路径直接抛错
 */
function normalizeEntryPath(raw: string): string | null {
  if (/[\u0000-\u001f]/.test(raw)) throw new SkillValidationError('包内路径包含非法字符');
  const clean = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean || clean.endsWith('/')) return null;
  if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean)) {
    throw new SkillValidationError(`包内路径不能是绝对路径：${raw}`);
  }
  const parts = clean.split('/');
  if (parts.some((part) => part === '..')) {
    throw new SkillValidationError(`包内路径不能包含 ..：${raw}`);
  }
  // macOS / Windows 生成的垃圾文件不影响安装
  if (parts[0] === '__MACOSX' || parts.some((part) => part === '.DS_Store' || part === 'Thumbs.db')) {
    return null;
  }
  return parts.filter((part) => part !== '' && part !== '.').join('/');
}

/** 把单个 Markdown 包成只有 SKILL.md 的 zip，方便 API 直接上传 .md。 */
export function markdownSkillZip(text: string): Buffer {
  return Buffer.from(zipSync({ 'SKILL.md': strToU8(text) }, { level: 6 }));
}

/** 从 markdown 中提取标题作为兜底名称。 */
function titleFromMarkdown(text: string): string | null {
  const match = /^#\s+(.+)$/m.exec(text);
  return match?.[1]?.trim() || null;
}

/**
 * 校验 zip、定位 SKILL.md、重新打包为「根目录即 Skill」的规范包。
 *
 * 支持用户直接压缩一个文件夹上传（顶层目录会被剥掉），
 * 也拒绝绝对路径 / `..` / 超过限制的包。
 */
export function inspectSkillZip(input: Buffer, limits: SkillLimits): InspectedSkill {
  if (input.length === 0) throw new SkillValidationError('上传内容为空');
  if (input.length > limits.maxBytes) {
    throw new SkillValidationError(`Skill 包超过 ${Math.round(limits.maxBytes / 1024 / 1024)}MB 限制`);
  }
  // 先读 zip 中央目录的声明大小，在真正解压前拦掉超大包 / 路径穿越 / 文件数超限，
  // 避免压缩炸弹在 unzipSync 里先把内存打爆。
  let filterError: SkillValidationError | null = null;
  let declaredFiles = 0;
  let declaredBytes = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(input), {
      filter: (file) => {
        if (filterError) return false;
        try {
          const path = normalizeEntryPath(file.name);
          if (!path) return false;
          declaredFiles += 1;
          if (declaredFiles > limits.maxFiles) {
            throw new SkillValidationError(`Skill 包内文件数超过 ${limits.maxFiles} 个限制`);
          }
          if (file.originalSize > SINGLE_FILE_MAX_BYTES) {
            throw new SkillValidationError(`文件过大：${path}`);
          }
          declaredBytes += file.originalSize;
          if (declaredBytes > limits.maxExtractedBytes) {
            throw new SkillValidationError(
              `Skill 解压后超过 ${Math.round(limits.maxExtractedBytes / 1024 / 1024)}MB 限制`,
            );
          }
          return true;
        } catch (error) {
          filterError = error instanceof SkillValidationError ? error : new SkillValidationError('读取 zip 目录失败');
          return false;
        }
      },
    });
  } catch (error) {
    if (error instanceof SkillValidationError) throw error;
    throw new SkillValidationError('不是有效的 zip 文件，请重新打包后再上传');
  }
  if (filterError) throw filterError;

  const files = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const [rawPath, data] of Object.entries(entries)) {
    const path = normalizeEntryPath(rawPath);
    if (!path) continue;
    if (files.size >= limits.maxFiles) {
      throw new SkillValidationError(`Skill 包内文件数超过 ${limits.maxFiles} 个限制`);
    }
    if (data.byteLength > SINGLE_FILE_MAX_BYTES) {
      throw new SkillValidationError(`文件过大：${path}`);
    }
    totalBytes += data.byteLength;
    if (totalBytes > limits.maxExtractedBytes) {
      throw new SkillValidationError(
        `Skill 解压后超过 ${Math.round(limits.maxExtractedBytes / 1024 / 1024)}MB 限制`,
      );
    }
    files.set(path, data);
  }

  if (files.size === 0) throw new SkillValidationError('Skill 包里没有文件');

  // 定位根目录：支持根目录直接放 SKILL.md，或整个包在一个文件夹里
  let rootPrefix = '';
  if (!files.has('SKILL.md')) {
    const topLevel = new Set(Array.from(files.keys()).map((path) => path.split('/')[0]));
    if (topLevel.size !== 1) {
      throw new SkillValidationError('zip 根目录或唯一顶层目录下必须有 SKILL.md');
    }
    const top = Array.from(topLevel)[0] as string;
    if (!files.has(`${top}/SKILL.md`)) {
      throw new SkillValidationError('zip 根目录或唯一顶层目录下必须有 SKILL.md');
    }
    rootPrefix = `${top}/`;
  }

  const normalized: Zippable = {};
  const fileList: SkillFileEntry[] = [];
  for (const [path, data] of files) {
    const relative = rootPrefix ? path.slice(rootPrefix.length) : path;
    if (!relative) continue;
    normalized[relative] = data;
    fileList.push({ path: relative, size: data.byteLength });
  }
  fileList.sort((a, b) => a.path.localeCompare(b.path));

  const skillMd = files.get(`${rootPrefix}SKILL.md`);
  if (!skillMd) throw new SkillValidationError('缺少 SKILL.md');
  const readme = strFromU8(skillMd).slice(0, README_MAX_CHARS);
  if (!readme.trim()) throw new SkillValidationError('SKILL.md 不能为空');

  const zip = Buffer.from(zipSync(normalized, { level: 6 }));
  if (zip.length > limits.maxBytes) {
    throw new SkillValidationError(`规范化后的 Skill 包超过 ${Math.round(limits.maxBytes / 1024 / 1024)}MB 限制`);
  }

  return {
    zip,
    readme,
    frontmatter: parseSkillFrontmatter(readme),
    files: fileList,
    totalBytes,
  };
}

/** 从 frontmatter / 标题推导 Skill 名称。 */
export function deriveSkillName(frontmatter: Record<string, string>, readme: string, fallback: string): string {
  return (frontmatter.name ?? titleFromMarkdown(readme) ?? fallback).trim().slice(0, 80);
}

/** 从 frontmatter / 正文推导一句话简介。 */
export function deriveSkillSummary(
  frontmatter: Record<string, string>,
  readme: string,
  fallback: string,
): string {
  const description = frontmatter.description?.trim();
  if (description) return description.slice(0, 200);
  const body = readme
    .replace(/^\uFEFF/, '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#'));
  return (body ?? fallback).slice(0, 200);
}

/** 生成 URL 友好的 slug；中文名会得到随机后缀，保证唯一性。 */
export function slugify(value: string): string {
  const base = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || `skill-${randomBytes(3).toString('hex')}`;
}

/** 存储目录：`${DATA_DIR}/skills`。 */
function storageRoot(dataDir: string): string {
  return join(resolve(dataDir), 'skills');
}

/** 保存版本包，返回相对 DATA_DIR 的路径。 */
export function saveSkillFile(
  dataDir: string,
  skillId: string,
  versionId: string,
  bytes: Buffer,
): { relativePath: string; sizeBytes: number; sha256: string } {
  const dir = join(storageRoot(dataDir), skillId);
  mkdirSync(dir, { recursive: true });
  const filename = `${versionId}.zip`;
  writeFileSync(join(dir, filename), bytes);
  return {
    relativePath: join('skills', skillId, filename),
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** 把相对路径解析成绝对路径，并确保不会逃出 skills 目录。 */
export function resolveSkillFile(dataDir: string, relativePath: string): string {
  const root = storageRoot(dataDir);
  const absolute = resolve(root, relativePath.replace(/^skills[\\/]/, ''));
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new SkillValidationError('Skill 文件路径非法');
  }
  return absolute;
}

/** 删除某个版本包（上传新版本失败时回滚单个文件）。 */
export function deleteSkillFile(dataDir: string, relativePath: string): void {
  try {
    rmSync(resolveSkillFile(dataDir, relativePath), { force: true });
  } catch {
    // 路径非法或文件已不存在：回滚清理失败不影响主流程，交给运维排查
  }
}

/** 删除某个 Skill 的全部版本包。 */
export function deleteSkillFiles(dataDir: string, skillId: string): void {
  rmSync(join(storageRoot(dataDir), skillId), { recursive: true, force: true });
}
