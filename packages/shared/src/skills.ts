/**
 * Skill 广场共享类型。
 *
 * 一个 Skill 由若干版本组成：上传新版本只追加历史，不覆盖旧包；
 * 下载默认取最新版本，也可以指定版本回退。
 */

/** Skill 状态：隐藏后普通员工不可见，管理员和作者仍可管理。 */
export type SkillStatus = 'active' | 'hidden';

/** 当前登录者：管理员口令会话，或飞书员工会话。 */
export interface AuthViewer {
  kind: 'admin' | 'employee';
  /** 员工为飞书 open_id；管理员为 null */
  openId: string | null;
  /** 展示名 */
  name: string;
  isAdmin: boolean;
}

/** 登录态探测结果。 */
export interface MeResponse {
  authenticated: boolean;
  user: AuthViewer | null;
  /** 是否配置了飞书网页授权，前端据此决定是否展示「飞书登录」 */
  feishuLoginReady: boolean;
}

/** Skill 包内的一个文件。 */
export interface SkillFileEntry {
  path: string;
  size: number;
}

/** 单个版本的元数据。 */
export interface SkillVersionView {
  id: string;
  version: string;
  /** 上传时的文件名（展示用） */
  filename: string;
  sizeBytes: number;
  sha256: string;
  changelog: string;
  createdAt: string;
  createdByOpenId: string;
  downloads: number;
  files: SkillFileEntry[];
  isLatest: boolean;
}

/** 列表项。 */
export interface SkillSummary {
  id: string;
  slug: string;
  name: string;
  summary: string;
  category: string;
  tags: string[];
  ownerOpenId: string;
  ownerName: string;
  status: SkillStatus;
  createdAt: string;
  updatedAt: string;
  latestVersion: string | null;
  latestVersionId: string | null;
  /** 所有版本累计下载次数 */
  downloads: number;
  /** 最新版本包大小 */
  fileSizeBytes: number | null;
  versionCount: number;
  /** 当前登录者是否可以编辑 / 删除 / 上传新版本 */
  canManage: boolean;
}

/** 详情：在列表项基础上补充说明、SKILL.md 全文与版本历史。 */
export interface SkillDetail extends SkillSummary {
  description: string;
  /** SKILL.md 原文（截断到服务端上限） */
  readme: string;
  versions: SkillVersionView[];
}

/** 列表响应。 */
export interface SkillListResponse {
  items: SkillSummary[];
  total: number;
  page: number;
  limit: number;
  /** 当前可选分类（来自已有 Skill） */
  categories: string[];
}

/**
 * 解析 SKILL.md 的 YAML frontmatter（只支持单行 key: value，足够覆盖 name/description/version）。
 * 服务端与前端共用，避免两边解析结果不一致。
 */
export function parseSkillFrontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^\uFEFF/, ''));
  if (!match?.[1]) return {};
  const lines = match[1].split(/\r?\n/);
  const result: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[index] ?? '');
    if (!field?.[1] || field[2] === undefined) continue;
    const key = field[1].toLowerCase();
    let value = field[2].trim();

    // YAML 块标量：description: | / > / |- / >-，收集后续缩进行
    if (/^[|>][+-]?$/.test(value)) {
      const folded = value.startsWith('>');
      const collected: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? '';
        if (next.trim() === '') {
          collected.push('');
          index += 1;
          continue;
        }
        if (!/^\s+/.test(next)) break;
        collected.push(next.trim());
        index += 1;
      }
      value = (folded ? collected.join(' ') : collected.join('\n')).trim();
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }
  return result;
}
