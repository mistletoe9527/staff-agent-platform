import type { SkillFileEntry, SkillStatus } from '@staff-agent/shared';
import type { Db } from '../db/client.js';
import { newId, nowIso } from '../util/ids.js';

/** skills 表行。 */
export interface SkillRow {
  id: string;
  slug: string;
  name: string;
  summary: string;
  description: string;
  category: string;
  tags: string;
  owner_open_id: string;
  owner_name: string;
  status: SkillStatus;
  download_count: number;
  created_at: string;
  updated_at: string;
}

/** skill_versions 表行。 */
export interface SkillVersionRow {
  id: string;
  skill_id: string;
  version: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  file_path: string;
  readme: string;
  changelog: string;
  files_json: string;
  created_by_open_id: string;
  download_count: number;
  created_at: string;
}

/** 列表查询时附带最新版本信息。 */
export interface SkillListRow extends SkillRow {
  latest_version: string | null;
  latest_version_id: string | null;
  latest_size_bytes: number | null;
  version_count: number;
}

/** 对外实体。 */
export interface Skill {
  id: string;
  slug: string;
  name: string;
  summary: string;
  description: string;
  category: string;
  tags: string[];
  ownerOpenId: string;
  ownerName: string;
  status: SkillStatus;
  downloads: number;
  createdAt: string;
  updatedAt: string;
}

/** 对外版本实体。 */
export interface SkillVersion {
  id: string;
  skillId: string;
  version: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  filePath: string;
  readme: string;
  changelog: string;
  files: SkillFileEntry[];
  createdByOpenId: string;
  downloads: number;
  createdAt: string;
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string').slice(0, 12);
  } catch {
    return [];
  }
}

function parseFiles(value: string): SkillFileEntry[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is SkillFileEntry =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as SkillFileEntry).path === 'string' &&
          typeof (item as SkillFileEntry).size === 'number',
      )
      .slice(0, 800);
  } catch {
    return [];
  }
}

/** 行转实体。 */
export function toSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    description: row.description,
    category: row.category,
    tags: parseTags(row.tags),
    ownerOpenId: row.owner_open_id,
    ownerName: row.owner_name,
    status: row.status,
    downloads: row.download_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 行转版本实体。 */
export function toSkillVersion(row: SkillVersionRow): SkillVersion {
  return {
    id: row.id,
    skillId: row.skill_id,
    version: row.version,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    filePath: row.file_path,
    readme: row.readme,
    changelog: row.changelog,
    files: parseFiles(row.files_json),
    createdByOpenId: row.created_by_open_id,
    downloads: row.download_count,
    createdAt: row.created_at,
  };
}

/** 通过 ID 查询 Skill。 */
export function findSkillById(db: Db, id: string): Skill | null {
  const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as unknown as SkillRow | undefined;
  return row ? toSkill(row) : null;
}

/** 通过 slug 查询 Skill。 */
export function findSkillBySlug(db: Db, slug: string): Skill | null {
  const row = db.prepare('SELECT * FROM skills WHERE slug = ?').get(slug) as unknown as SkillRow | undefined;
  return row ? toSkill(row) : null;
}

/** 查询某个 Skill 的版本。 */
export function findSkillVersion(db: Db, skillId: string, version: string): SkillVersion | null {
  const row = db
    .prepare('SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?')
    .get(skillId, version) as unknown as SkillVersionRow | undefined;
  return row ? toSkillVersion(row) : null;
}

/** 查询最新版本。 */
export function findLatestVersion(db: Db, skillId: string): SkillVersion | null {
  const row = db
    .prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(skillId) as unknown as SkillVersionRow | undefined;
  return row ? toSkillVersion(row) : null;
}

/** 列出所有版本（新到旧）。 */
export function listSkillVersions(db: Db, skillId: string): SkillVersion[] {
  const rows = db
    .prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(skillId) as unknown as SkillVersionRow[];
  return rows.map(toSkillVersion);
}

/** 生成不重复的 slug。 */
function uniqueSlug(db: Db, base: string): string {
  let candidate = base;
  for (let index = 2; index < 1000; index += 1) {
    const existing = db.prepare('SELECT 1 AS hit FROM skills WHERE slug = ?').get(candidate) as
      | { hit: number }
      | undefined;
    if (!existing) return candidate;
    candidate = `${base.slice(0, 44)}-${index}`;
  }
  return `${base.slice(0, 40)}-${Date.now().toString(36)}`;
}

/** 创建 Skill 聚合根（版本随后添加）。 */
export function createSkill(
  db: Db,
  input: {
    slug: string;
    name: string;
    summary: string;
    description: string;
    category: string;
    tags: string[];
    ownerOpenId: string;
    ownerName: string;
  },
): Skill {
  const now = nowIso();
  const id = newId('skl');
  const slug = uniqueSlug(db, input.slug);
  db.prepare(
    `INSERT INTO skills (id, slug, name, summary, description, category, tags, owner_open_id, owner_name, status, download_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
  ).run(
    id,
    slug,
    input.name,
    input.summary,
    input.description,
    input.category,
    JSON.stringify(input.tags),
    input.ownerOpenId,
    input.ownerName,
    now,
    now,
  );
  return {
    id,
    slug,
    name: input.name,
    summary: input.summary,
    description: input.description,
    category: input.category,
    tags: input.tags,
    ownerOpenId: input.ownerOpenId,
    ownerName: input.ownerName,
    status: 'active',
    downloads: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** 修改 Skill 元数据；管理员还可以改状态。 */
export function updateSkill(
  db: Db,
  id: string,
  patch: {
    name?: string;
    summary?: string;
    description?: string;
    category?: string;
    tags?: string[];
    status?: SkillStatus;
  },
): void {
  const fields: string[] = [];
  const values: Array<string | number> = [];
  if (patch.name !== undefined) {
    fields.push('name = ?');
    values.push(patch.name);
  }
  if (patch.summary !== undefined) {
    fields.push('summary = ?');
    values.push(patch.summary);
  }
  if (patch.description !== undefined) {
    fields.push('description = ?');
    values.push(patch.description);
  }
  if (patch.category !== undefined) {
    fields.push('category = ?');
    values.push(patch.category);
  }
  if (patch.tags !== undefined) {
    fields.push('tags = ?');
    values.push(JSON.stringify(patch.tags));
  }
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(nowIso());
  values.push(id);
  db.prepare(`UPDATE skills SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/** 添加版本；`(skill_id, version)` 唯一。 */
export function addSkillVersion(
  db: Db,
  input: {
    /** 可预生成版本 ID，便于先落盘文件再写库；不传则自动生成 */
    id?: string;
    skillId: string;
    version: string;
    filename: string;
    sizeBytes: number;
    sha256: string;
    filePath: string;
    readme: string;
    changelog: string;
    files: SkillFileEntry[];
    createdByOpenId: string;
  },
): SkillVersion {
  const now = nowIso();
  const id = input.id ?? newId('skv');
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO skill_versions (id, skill_id, version, filename, size_bytes, sha256, file_path, readme, changelog, files_json, created_by_open_id, download_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      id,
      input.skillId,
      input.version,
      input.filename,
      input.sizeBytes,
      input.sha256,
      input.filePath,
      input.readme,
      input.changelog,
      JSON.stringify(input.files),
      input.createdByOpenId,
      now,
    );
    db.prepare('UPDATE skills SET updated_at = ? WHERE id = ?').run(now, input.skillId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    id,
    skillId: input.skillId,
    version: input.version,
    filename: input.filename,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    filePath: input.filePath,
    readme: input.readme,
    changelog: input.changelog,
    files: input.files,
    createdByOpenId: input.createdByOpenId,
    downloads: 0,
    createdAt: now,
  };
}

/** 删除 Skill 及其版本（文件由调用方删除）。 */
export function deleteSkill(db: Db, id: string): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM skill_downloads WHERE skill_id = ?').run(id);
    db.prepare('DELETE FROM skill_versions WHERE skill_id = ?').run(id);
    db.prepare('DELETE FROM skills WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 下载计数：累计值 + 明细。 */
export function recordDownload(
  db: Db,
  input: { skillId: string; versionId: string; viewerKey: string },
): void {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE skills SET download_count = download_count + 1 WHERE id = ?').run(input.skillId);
    db.prepare('UPDATE skill_versions SET download_count = download_count + 1 WHERE id = ?').run(input.versionId);
    db.prepare(
      'INSERT INTO skill_downloads (id, skill_id, version_id, viewer_key, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(newId('sdl'), input.skillId, input.versionId, input.viewerKey, nowIso());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 列表查询条件。 */
export interface SkillListFilter {
  q?: string;
  category?: string;
  status?: SkillStatus | 'all';
  ownerOpenId?: string;
  sort?: 'latest' | 'popular' | 'name';
  limit: number;
  offset: number;
}

/** 列表查询结果。 */
export interface SkillListResult {
  rows: SkillListRow[];
  total: number;
}

/** 列表查询。 */
export function listSkills(db: Db, filter: SkillListFilter): SkillListResult {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.status !== 'all') {
    where.push('s.status = ?');
    params.push(filter.status ?? 'active');
  }
  if (filter.ownerOpenId) {
    where.push('s.owner_open_id = ?');
    params.push(filter.ownerOpenId);
  }
  if (filter.category) {
    where.push('s.category = ?');
    params.push(filter.category);
  }
  if (filter.q) {
    where.push('(s.name LIKE ? OR s.summary LIKE ? OR s.description LIKE ? OR s.tags LIKE ? OR s.owner_name LIKE ?)');
    const like = `%${filter.q}%`;
    params.push(like, like, like, like, like);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const order =
    filter.sort === 'popular'
      ? 's.download_count DESC, s.updated_at DESC'
      : filter.sort === 'name'
        ? 's.name ASC'
        : 's.updated_at DESC';

  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS c FROM skills s ${clause}`).get(...params) as { c: number }).c,
  );
  const rows = db
    .prepare(
      `SELECT s.*,
              v.version AS latest_version,
              v.id AS latest_version_id,
              v.size_bytes AS latest_size_bytes,
              (SELECT COUNT(*) FROM skill_versions vc WHERE vc.skill_id = s.id) AS version_count
       FROM skills s
       LEFT JOIN skill_versions v ON v.id = (
         SELECT id FROM skill_versions WHERE skill_id = s.id ORDER BY created_at DESC, rowid DESC LIMIT 1
       )
       ${clause}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit, filter.offset) as unknown as SkillListRow[];
  return { rows, total };
}

/** 当前可选分类。 */
export function listCategories(db: Db, includeHidden: boolean): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT category FROM skills ${includeHidden ? '' : "WHERE status = 'active'"} ORDER BY category`,
    )
    .all() as unknown as Array<{ category: string }>;
  return rows.map((row) => row.category).filter(Boolean);
}

/** 计算下一个版本号：显式传入优先，否则在最新版本上递增 patch。 */
export function nextVersion(requested: string | undefined, latest: string | null): string {
  const explicit = requested?.trim();
  if (explicit) {
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(explicit)) {
      throw new Error('版本号只能包含字母、数字、点、下划线和短横线，且不超过 32 个字符');
    }
    return explicit;
  }
  if (!latest) return '1.0.0';
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(latest);
  if (match) return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
  return `${latest}.1`.slice(0, 32);
}
