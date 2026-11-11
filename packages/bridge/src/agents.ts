import type { AgentRuntime } from '@staff-agent/shared';
import { readConfig, writeConfig, type BridgeConfig, type Workspace } from './config.js';
import { errorText, log } from './log.js';
import { createAdapter } from './runtimes/index.js';
import { findWorkspace } from './routing.js';
import { defaultWorkspaceDir, ensureDir, prettyPath, workspacesRoot } from './workspaces.js';

/** 自动生成工作区说明的超时时间（毫秒）。Agent 会翻目录，给足时间。 */
const DESCRIBE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 让 Agent 阅读目录并总结工作区说明用的提示词。
 * 这段说明会成为主 Agent 判断「什么任务该进这个工作区」的职责边界。
 */
const DESCRIBE_PROMPT = [
  '你正在为公司同事整理一个新的工作区说明，它会作为主 Agent 判断任务归属的职责边界。',
  '请先浏览当前目录（README、package.json、目录结构等，必要时读几个关键文件），',
  '然后用一句中文说明：这个工作区负责什么（职责边界）、是什么项目或用途、给谁用。',
  '要求：80 字以内；只输出说明正文；不要 Markdown 标题或代码块；不要寒暄；不要反问。',
].join('\n');

/** 新增工作区的参数。 */
export interface AddAgentOptions {
  name: string;
  /** 工作目录；不传则自动生成 ~/staff-agent-workspaces/<名字> */
  cwd?: string;
  /** 工作区说明；不传则让 Agent 自己阅读目录生成 */
  description?: string;
  /** 显式关闭自动生成说明（--no-ai-description） */
  aiDescription?: boolean;
}

/** 修改工作区的参数。 */
export interface UpdateAgentOptions {
  name: string;
  cwd?: string;
  description?: string;
  aiDescription?: boolean;
}

/** 读取配置，未登录直接报错。 */
function requireConfig(): BridgeConfig {
  const config = readConfig();
  if (!config) {
    throw new Error('尚未登录，请先运行 sa login --platform <url>');
  }
  return config;
}

/** 打印一个工作区。 */
function printWorkspace(label: string, workspace: Workspace): void {
  process.stdout.write(`● [${label}] ${workspace.name}  (${prettyPath(workspace.cwd)})\n`);
  process.stdout.write(`    职责：${workspace.description ?? '（空）'}\n\n`);
}

/**
 * 新增工作区（子 Agent）。
 *
 * 工作区只写本机配置 `~/.staff-agent/config.json`，不上传平台：
 * 目录是本机路径，放到平台上只会变成一份会过期的副本。
 *
 * 描述留空时用运行时 CLI 真的去读目录，总结一句职责说明。
 */
export async function addAgent(options: AddAgentOptions): Promise<void> {
  const config = requireConfig();
  const name = options.name.trim();
  if (!name) throw new Error('工作区名称不能为空');
  if (name.toLowerCase() === config.agentName.toLowerCase()) {
    throw new Error(`「${name}」是主 Agent 的名字，工作区换个名字`);
  }
  if (findWorkspace(config.workspaces, name)) {
    throw new Error(`本机已经有叫「${name}」的工作区，换个名字或先运行 sa agents list 看看`);
  }

  const cwd = ensureDir(options.cwd ?? defaultWorkspaceDir(name));
  let description = options.description?.trim() || null;
  if (!description && options.aiDescription !== false) {
    log('info', '未填写描述，正在让 Agent 阅读工作目录并总结', { cwd });
    description = await describeWorkspace(config.runtime, cwd);
    if (!description) {
      log('warn', '没能自动生成描述，可以先留空，稍后用 sa agents update 补上');
    }
  }

  const workspace: Workspace = { name, cwd, description, createdAt: new Date().toISOString() };
  writeConfig({ ...config, workspaces: [...config.workspaces, workspace] });
  log('info', '工作区已创建', { workspace: name, cwd: prettyPath(cwd) });
  process.stdout.write(`\n  名称：${workspace.name}\n  目录：${prettyPath(workspace.cwd)}\n`);
  process.stdout.write(`  职责：${workspace.description ?? '（空）'}\n`);
  process.stdout.write(`  主 Agent 会按职责判断进哪个目录；也可以用 #${workspace.name} 直接指定。\n\n`);
}

/** 修改工作区：换目录 / 改描述（描述可重新让 Agent 生成）。 */
export async function updateAgent(options: UpdateAgentOptions): Promise<void> {
  const config = requireConfig();
  const workspace = findWorkspace(config.workspaces, options.name.trim());
  if (!workspace) throw new Error(`没有找到叫「${options.name}」的工作区，用 sa agents list 看看`);

  const next: Workspace = { ...workspace };
  if (options.cwd) next.cwd = ensureDir(options.cwd);
  if (options.description !== undefined) next.description = options.description.trim() || null;
  if (options.aiDescription) {
    // 只有显式要求时才重新生成，避免改个目录就多一次模型调用
    log('info', '正在让 Agent 重新总结工作区说明', { cwd: prettyPath(next.cwd) });
    const summary = await describeWorkspace(config.runtime, next.cwd);
    if (summary) next.description = summary;
  }
  if (next.cwd === workspace.cwd && next.description === workspace.description) {
    log('warn', '没有需要更新的内容，可用 --cwd / --description / --ai-description');
    return;
  }

  writeConfig({
    ...config,
    workspaces: config.workspaces.map((item) => (item.name === workspace.name ? next : item)),
  });
  log('info', '工作区已更新', { workspace: next.name, cwd: prettyPath(next.cwd) });
  process.stdout.write(`  职责：${next.description ?? '（空）'}\n`);
}

/** 删除工作区：只删本机配置，目录原样保留（避免把没提交的活删掉）。 */
export async function removeAgent(name: string): Promise<void> {
  const config = requireConfig();
  const workspace = findWorkspace(config.workspaces, name.trim());
  if (!workspace) throw new Error(`没有找到叫「${name}」的工作区，用 sa agents list 看看`);
  writeConfig({ ...config, workspaces: config.workspaces.filter((item) => item.name !== workspace.name) });
  log('info', '工作区已删除', { workspace: workspace.name });
  process.stdout.write(`\n  已删除工作区：${workspace.name}\n`);
  process.stdout.write(`  本地目录保留：${prettyPath(workspace.cwd)}（需要的话自己删）\n\n`);
}

/** 列出本机工作区（主工作区 + 自定义工作区）。 */
export async function listAgents(): Promise<void> {
  const config = requireConfig();
  process.stdout.write(`\n本机工作区（共 ${config.workspaces.length + 1} 个，根目录 ${prettyPath(workspacesRoot())}）\n\n`);
  printWorkspace('主', {
    name: config.agentName,
    cwd: config.cwd,
    description: config.description ?? null,
    createdAt: config.createdAt,
  });
  for (const workspace of config.workspaces) printWorkspace('子', workspace);
  process.stdout.write('  主 Agent 按职责挑工作区，也可用 #名称 指定；新增：sa agents add --name <名称>\n');
  process.stdout.write('  工作区只存在本机，平台后台看不到。\n\n');
}

/** 让运行时阅读目录，总结一句工作区说明。失败返回 null（不阻断新增）。 */
async function describeWorkspace(runtime: AgentRuntime, cwd: string): Promise<string | null> {
  const adapter = createAdapter(runtime);
  const check = await adapter.check();
  if (!check.ok) {
    log('warn', '运行时不可用，跳过自动生成描述', { runtime, detail: check.detail });
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DESCRIBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const outcome = await adapter.run({
      prompt: DESCRIBE_PROMPT,
      cwd,
      sessionRef: null,
      timeoutMs: DESCRIBE_TIMEOUT_MS,
      signal: controller.signal,
      onStep: () => {},
    });
    if (!outcome.ok) {
      log('warn', '自动生成描述失败', { error: outcome.error ?? '运行失败' });
      return null;
    }
    const description = cleanDescription(outcome.result);
    if (!description) {
      log('warn', 'Agent 没有返回可用的描述', { preview: outcome.result.slice(0, 200) });
      return null;
    }
    return description;
  } catch (error) {
    log('warn', '自动生成描述异常', { error: errorText(error) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 清理模型输出：去掉代码块围栏与多行结构，压成一句 300 字以内的说明。 */
function cleanDescription(text: string): string | null {
  const flat = text
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/^[\s>*\-+\d.、]+/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!flat) return null;
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}
