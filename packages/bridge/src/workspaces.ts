import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * 工作区根目录。
 * 默认 `~/staff-agent-workspaces`，可用 STAFF_AGENT_WORKSPACES 覆盖（Docker / 自定义盘符）。
 */
export function workspacesRoot(): string {
  return process.env.STAFF_AGENT_WORKSPACES ?? join(homedir(), 'staff-agent-workspaces');
}

/** 把 Agent 名转成目录名：保留中英文数字，其余字符折叠成 -。 */
export function slugifyAgentName(name: string): string {
  const slug = name
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'agent';
}

/** 默认工作区目录：按 Agent 名生成，同一个 Agent 再次登录复用同一路径。 */
export function defaultWorkspaceDir(name: string): string {
  return join(workspacesRoot(), slugifyAgentName(name));
}

/** 确保目录存在，返回绝对路径。 */
export function ensureDir(dir: string): string {
  const absolute = isAbsolute(dir) ? dir : resolve(dir);
  mkdirSync(absolute, { recursive: true });
  return absolute;
}

/** 展示用路径：家目录前缀折叠成 ~。 */
export function prettyPath(dir: string): string {
  const home = homedir();
  return dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}
