import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunOptions, RunOutcome, RuntimeAdapter } from './types.js';
import { extractText, readNumber, summarize } from './types.js';
import {
  bindAbort,
  cliEnv,
  describeSpawnFailure,
  killProcess,
  planSpawn,
  readChildJsonLines,
  resolveExecutable,
  spawnCli,
  waitExit,
  writeStdin,
} from './process.js';

const execFileAsync = promisify(execFile);

/**
 * Claude Code 适配器：`claude -p --output-format stream-json --verbose`。
 *
 * 会话复用：首轮用 --session-id 固定 UUID，后续用 --resume 续聊，
 * 这样平台侧 conversation 的 sessionRef 永远指向同一个会话。
 * 权限模式默认 acceptEdits（headless 下能改文件），可用 STAFF_AGENT_CLAUDE_ARGS 覆盖。
 */
export class ClaudeAdapter implements RuntimeAdapter {
  readonly id = 'claude' as const;

  constructor(private readonly bin: string = process.env.STAFF_AGENT_CLAUDE_BIN ?? 'claude') {}

  /** 检查 claude 是否可用。 */
  async check(): Promise<{ ok: boolean; version?: string; detail?: string }> {
    try {
      const bin = resolveExecutable(this.bin) ?? this.bin;
      const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 10_000, env: cliEnv(bin) });
      return { ok: true, version: stdout.trim().split('\n')[0] };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 执行一次任务。 */
  async run(options: RunOptions): Promise<RunOutcome> {
    const sessionRef = options.sessionRef ?? randomUUID();
    const extraArgs = (process.env.STAFF_AGENT_CLAUDE_ARGS ?? '--permission-mode acceptEdits')
      .split(' ')
      .filter(Boolean);
    const args = ['-p', '--output-format', 'stream-json', '--verbose', ...extraArgs];
    if (options.sessionRef) {
      args.push('--resume', options.sessionRef);
    } else {
      args.push('--session-id', sessionRef);
    }
    // 先校验可执行文件与工作目录，避免 spawn ENOENT 直接打挂网关
    const plan = planSpawn(this.bin, options.cwd);
    if (plan.error) {
      return { ok: false, result: '', sessionRef, inputTokens: 0, outputTokens: 0, error: plan.error };
    }

    const child = spawnCli(plan.command, args, { cwd: options.cwd });
    const unbind = bindAbort(child, options.signal);

    let finalText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let sessionId = sessionRef;
    let failure: string | null = null;
    let completed = false;
    let stderrTail = '';

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-4000);
    });
    // prompt 走 stdin，避免超长参数
    writeStdin(child, options.prompt);

    try {
      for await (const event of readChildJsonLines(child)) {
        const type = String(event.type ?? '');
        if (type === 'system') {
          if (event.subtype === 'init' && typeof event.session_id === 'string') {
            sessionId = event.session_id;
          }
          continue;
        }
        if (type === 'assistant') {
          const message = event.message as { content?: unknown; usage?: unknown } | undefined;
          if (Array.isArray(message?.content)) {
            for (const block of message.content as Array<Record<string, unknown>>) {
              if (block.type === 'text' && typeof block.text === 'string') {
                finalText = block.text;
              } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
                this.emit(options, {
                  type: 'thinking',
                  name: 'thinking',
                  outputSummary: summarize(block.thinking, 1_000),
                });
              } else if (block.type === 'tool_use') {
                this.emit(options, {
                  type: 'tool',
                  name: String(block.name ?? 'tool'),
                  inputSummary: summarize(block.input),
                });
              }
            }
          }
          inputTokens += readNumber(message?.usage, 'input_tokens', 'inputTokens');
          outputTokens += readNumber(message?.usage, 'output_tokens', 'outputTokens');
          continue;
        }
        if (type === 'user') {
          const message = event.message as { content?: unknown } | undefined;
          if (Array.isArray(message?.content)) {
            for (const block of message.content as Array<Record<string, unknown>>) {
              if (block.type !== 'tool_result') continue;
              this.emit(options, {
                type: 'tool',
                name: 'tool_result',
                outputSummary: summarize(block.content),
                isError: Boolean(block.is_error),
              });
            }
          }
          continue;
        }
        if (type === 'result') {
          completed = event.subtype === 'success';
          if (typeof event.result === 'string' && event.result.trim()) {
            finalText = event.result;
          }
          if (typeof event.session_id === 'string') sessionId = event.session_id;
          // result.usage 是本轮累计值，优先级高于逐条累加
          const usage = event.usage as unknown;
          const totalInput = readNumber(usage, 'input_tokens', 'inputTokens');
          const totalOutput = readNumber(usage, 'output_tokens', 'outputTokens');
          if (totalInput > 0) inputTokens = totalInput;
          if (totalOutput > 0) outputTokens = totalOutput;
          if (!completed) {
            failure = String(event.result ?? event.subtype ?? '执行失败');
          }
          break;
        }
      }
    } finally {
      unbind();
      killProcess(child);
    }

    const exit = await waitExit(child);
    const spawnError = describeSpawnFailure(child, this.bin, options.cwd);
    if (spawnError) {
      return { ok: false, result: finalText, sessionRef: sessionId, inputTokens, outputTokens, error: spawnError };
    }
    if (failure) {
      return { ok: false, result: finalText, sessionRef: sessionId, inputTokens, outputTokens, error: failure };
    }
    if (!completed) {
      return {
        ok: false,
        result: finalText,
        sessionRef: sessionId,
        inputTokens,
        outputTokens,
        error: stderrTail.trim() || `claude 进程异常退出（code=${exit.code ?? 'null'}）`,
      };
    }
    return { ok: true, result: finalText.trim(), sessionRef: sessionId, inputTokens, outputTokens };
  }

  /** 统一发出步骤。 */
  private emit(options: RunOptions, step: Parameters<RunOptions['onStep']>[0]): void {
    options.onStep(step);
  }
}
