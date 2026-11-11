import type { AgentRuntime } from '@staff-agent/shared';

/** 单个 trace 步骤事件，由 adapter 产出、由 runner 批量上报。 */
export interface StepEvent {
  type: 'llm' | 'tool' | 'message' | 'thinking' | 'error';
  name: string;
  inputSummary?: string;
  outputSummary?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  isError?: boolean;
}

/** 一次任务执行的入参。 */
export interface RunOptions {
  prompt: string;
  cwd: string;
  /** 上一轮留下的运行时会话标识；为空表示新会话 */
  sessionRef: string | null;
  /** 超时毫秒 */
  timeoutMs: number;
  /** 中断信号（超时或进程退出时触发） */
  signal: AbortSignal;
  /** 产生一步 trace */
  onStep: (step: StepEvent) => void;
}

/** 一次任务执行的结果。 */
export interface RunOutcome {
  ok: boolean;
  /** 面向飞书的最终回复 */
  result: string;
  /** 本轮的运行时会话标识，下一轮续聊使用 */
  sessionRef: string;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

/** 运行时适配器：把不同 CLI 的事件流统一成 StepEvent + 最终文本。 */
export interface RuntimeAdapter {
  readonly id: AgentRuntime;
  /** 检查本地 CLI 是否可用。 */
  check(): Promise<{ ok: boolean; version?: string; detail?: string }>;
  /** 执行一次任务。 */
  run(options: RunOptions): Promise<RunOutcome>;
}

/** 把任意值转成可读摘要，避免 trace 里塞超大对象。 */
export function summarize(value: unknown, maxChars = 4_000): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length === 0) return undefined;
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** 从 pi / claude 的消息 content 中提取纯文本。 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typed = block as { type?: string; text?: string };
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text);
  }
  return parts.join('');
}

/** 安全读取数字字段，兼容 input_tokens / inputTokens 两种风格。 */
export function readNumber(source: unknown, ...keys: string[]): number {
  if (!source || typeof source !== 'object') return 0;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}
