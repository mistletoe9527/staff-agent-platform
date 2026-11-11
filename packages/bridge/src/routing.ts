import type { Workspace } from './config.js';
import { prettyPath } from './workspaces.js';

/** 一条飞书消息的指令解析结果。 */
export type AgentCommand =
  | { kind: 'task' }
  | { kind: 'list' }
  | { kind: 'workspace'; name: string; prompt: string };

/**
 * 解析 `#名字 任务` 与 `#列表`。
 *
 * 这一步以前在平台侧做，现在完全在本机：平台不知道有哪些工作区，
 * 所以它把飞书原文原样下发，由网关决定去哪个目录执行。
 */
export function parseAgentCommand(prompt: string): AgentCommand {
  const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (!match) return { kind: 'task' };
  const name = match[1] as string;
  if (/^(列表|workspaces?|agents?|list)$/i.test(name)) return { kind: 'list' };
  return { kind: 'workspace', name, prompt: (match[2] ?? '').trim() };
}

/** 按名字找本机工作区（大小写不敏感）。 */
export function findWorkspace(workspaces: Workspace[], name: string): Workspace | null {
  return workspaces.find((workspace) => workspace.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/**
 * 不写 `#名字` 时的确定性兑底：任务正文里直接出现了工作区名字（或名字里的词）。
 * 例：工作区「健康管理+商城」+ 问题「健康管理有哪些功能」-> 命中。
 * 只作为提示写进提示词，不强制切目录：猜错也不会把模型锁在错目录里。
 */
export function hintWorkspaceByText(workspaces: Workspace[], prompt: string): Workspace | null {
  const text = prompt.toLowerCase();
  const candidates = workspaces
    .map((workspace) => ({
      workspace,
      tokens: workspace.name
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((token) => token.length >= 2),
    }))
    // 长名字优先，避免短词抢走长工作区
    .sort((left, right) => right.workspace.name.length - left.workspace.name.length);
  for (const candidate of candidates) {
    if (text.includes(candidate.workspace.name.toLowerCase())) return candidate.workspace;
    if (candidate.tokens.some((token) => text.includes(token))) return candidate.workspace;
  }
  return null;
}

/** `#列表` 的回复正文，直接在本地生成，不花模型 token。 */
export function renderWorkspaceList(mainCwd: string, mainName: string, workspaces: Workspace[]): string {
  const lines = [`主工作区：${mainName}\n  目录：${prettyPath(mainCwd)}\n  职责：默认工作区，未匹配到其他工作区时在这里干活`];
  for (const workspace of workspaces) {
    lines.push(
      `${workspace.name}\n  目录：${prettyPath(workspace.cwd)}\n  职责：${workspace.description?.trim() || '未填写职责说明'}`,
    );
  }
  const hint = workspaces.length > 0 ? '，也可以用 #名字 直接指定' : '';
  return `本机共有 ${workspaces.length + 1} 个工作区：\n\n${lines.join('\n\n')}\n\n主 Agent 会按职责判断去哪个工作区${hint}。工作区只在本机，平台后台看不到。`;
}

/** 拼给运行时的提示词：告诉主 Agent 本机有哪些工作区、这次在哪个目录，以及回复的边界。 */
export function composePrompt(input: {
  prompt: string;
  mainName: string;
  mainCwd: string;
  workspaces: Workspace[];
  /** 显式指定（`#名字`）的工作区 */
  selected: Workspace | null;
}): string {
  const { prompt, mainName, mainCwd, workspaces, selected } = input;
  // 没显式指定时，按「任务里提到的名字」给一个确定的提示，减少模型看错目录
  const hinted = selected ? null : hintWorkspaceByText(workspaces, prompt);
  const lines = [
    '【工作区】以下是本机工作区，只给你自己选目录用，属于内部信息：',
    `- ${mainName}（主工作区：${prettyPath(mainCwd)}）：默认工作区`,
  ];
  for (const workspace of workspaces) {
    lines.push(
      `- ${workspace.name}（${prettyPath(workspace.cwd)}）：${workspace.description?.trim() || '未填写职责说明'}`,
    );
  }
  lines.push('');
  if (selected) {
    lines.push(`本次任务指定在「${selected.name}」（${prettyPath(selected.cwd)}）执行：文件读写与命令都针对该目录。`);
  } else if (hinted) {
    lines.push(`任务里提到了「${hinted.name}」，对应目录 ${prettyPath(hinted.cwd)}：先在这个目录里找答案。`);
  } else if (workspaces.length > 0) {
    lines.push(
      '任务没有指定工作区：如果它明显属于某个工作区，先 cd 到该目录再工作；都不匹配就留在主工作区。',
    );
  } else {
    lines.push('本机只有主工作区，直接在主工作区干活。');
  }
  lines.push(
    '',
    '【回复边界】上面这些目录与工作区都是内部细节，只在你自己执行时使用：',
    '- 只给任务本身的结论/结果，不要描述执行过程（切目录、搜索、读了哪些文件）。',
    '- 回复里不要出现本机路径、家目录、工作区名称，也不要说你“在哪个目录里干活”。',
    '- 目录里没有相关材料时，不要解释“目录是空的/没找到项目”，直接用你能掌握的信息给出最有用的回答；必要时说明这是通用回答而非项目内事实。',
  );
  return `${lines.join('\n')}\n\n【任务】\n${prompt}`;
}
