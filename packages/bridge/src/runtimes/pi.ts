import { randomUUID } from 'node:crypto';
import type { RunOptions, RunOutcome, RuntimeAdapter, StepEvent } from './types.js';
import { extractText, readNumber, summarize } from './types.js';
import {
  bindAbort,
  cliEnv,
  describeSpawnFailure,
  planSpawn,
  readChildJsonLines,
  resolveExecutable,
  shutdownCli,
  spawnCli,
  waitExit,
  writeStdinLine,
} from './process.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 工具调用起始信息，用于在结束事件里补 durationMs。 */
interface ToolStart {
  name: string;
  args: unknown;
  startedAt: number;
}

/**
 * pi 适配器：走 `pi --mode rpc` 长驻 JSONL 协议。
 *
 * 这是三种运行时里事件最完整的：tool_execution_start/end 带 durationMs，
 * message_end 带 usage，agent_settled 表示一轮真正结束。
 */
export class PiAdapter implements RuntimeAdapter {
  readonly id = 'pi' as const;

  constructor(private readonly bin: string = process.env.STAFF_AGENT_PI_BIN ?? 'pi') {}

  /** 检查 pi 是否可用。 */
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
    const extraArgs = (process.env.STAFF_AGENT_PI_ARGS ?? '').split(' ').filter(Boolean);
    const args = ['--mode', 'rpc', '--session-id', sessionRef, ...extraArgs];
    // 先校验可执行文件与工作目录，避免 spawn ENOENT 直接打挂网关
    const plan = planSpawn(this.bin, options.cwd);
    if (plan.error) {
      return { ok: false, result: '', sessionRef, inputTokens: 0, outputTokens: 0, error: plan.error };
    }
    const child = spawnCli(plan.command, args, { cwd: options.cwd });
    const unbind = bindAbort(child, options.signal);

    let finalText = '';
    let streamedText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let settled = false;
    let promptError: string | null = null;
    let stderrTail = '';
    const toolStarts = new Map<string, ToolStart>();

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-4000);
    });

    // prompt 必须在开始读事件前写入，避免极快的完成事件被漏掉。
    // 注意不能 end()：RPC 模式 stdin EOF 会让 pi 在本轮跑完前就退出。
    writeStdinLine(child, `${JSON.stringify({ id: 'prompt-1', type: 'prompt', message: options.prompt })}\n`);

    try {
      for await (const event of readChildJsonLines(child)) {
        const type = String(event.type ?? '');
        switch (type) {
          case 'tool_execution_start': {
            const id = String(event.toolCallId ?? '');
            toolStarts.set(id, {
              name: String(event.toolName ?? 'tool'),
              args: event.args,
              startedAt: Date.now(),
            });
            break;
          }
          case 'tool_execution_end': {
            const id = String(event.toolCallId ?? '');
            const start = toolStarts.get(id);
            toolStarts.delete(id);
            const name = String(event.toolName ?? start?.name ?? 'tool');
            const duration =
              typeof event.durationMs === 'number'
                ? event.durationMs
                : start
                  ? Date.now() - start.startedAt
                  : undefined;
            this.emit(options, {
              type: 'tool',
              name,
              inputSummary: summarize(start?.args),
              outputSummary: summarize(event.result),
              durationMs: duration,
              isError: Boolean(event.isError),
            });
            break;
          }
          case 'message_update': {
            const inner = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
            if (inner?.type === 'text_delta' && typeof inner.delta === 'string') {
              streamedText += inner.delta;
            }
            break;
          }
          case 'message_end': {
            const message = event.message as
              | { role?: string; content?: unknown; usage?: unknown }
              | undefined;
            if (message?.role !== 'assistant') break;
            const text = extractText(message.content);
            if (text) finalText = text;
            // pi 的 usage 键名是 input / output，兼容其他运行时风格
            inputTokens += readNumber(message.usage, 'inputTokens', 'input_tokens', 'input');
            outputTokens += readNumber(message.usage, 'outputTokens', 'output_tokens', 'output');
            break;
          }
          case 'turn_end': {
            // turn_end.usage 是本轮汇总，优先级高于逐条 message_end 累加，避免重复计数
            const turnInput = readNumber(event.usage, 'inputTokens', 'input_tokens', 'input');
            const turnOutput = readNumber(event.usage, 'outputTokens', 'output_tokens', 'output');
            if (turnInput > 0) inputTokens = turnInput;
            if (turnOutput > 0) outputTokens = turnOutput;
            break;
          }
          case 'response': {
            if (event.command === 'prompt' && event.success === false) {
              promptError = String(event.error ?? 'prompt 被拒绝');
            }
            break;
          }
          case 'agent_settled': {
            settled = true;
            break;
          }
          case 'extension_error': {
            this.emit(options, {
              type: 'error',
              name: 'extension_error',
              outputSummary: summarize(event.error),
              isError: true,
            });
            break;
          }
          default:
            break;
        }
        // agent_settled 表示本轮真正结束；pi 是长驻进程，不主动跳出会一直等 stdin
        if (settled) break;
      }
    } finally {
      unbind();
      await shutdownCli(child);
    }

    const exit = await waitExit(child);
    const resultText = (finalText || streamedText).trim();
    const spawnError = describeSpawnFailure(child, this.bin, options.cwd);
    if (spawnError) {
      return { ok: false, result: resultText, sessionRef, inputTokens, outputTokens, error: spawnError };
    }
    if (promptError) {
      return {
        ok: false,
        result: resultText,
        sessionRef,
        inputTokens,
        outputTokens,
        error: promptError,
      };
    }
    if (!settled && exit.code !== 0) {
      return {
        ok: false,
        result: resultText,
        sessionRef,
        inputTokens,
        outputTokens,
        error: stderrTail.trim() || `pi 进程异常退出（code=${exit.code ?? 'null'}）`,
      };
    }
    return { ok: true, result: resultText, sessionRef, inputTokens, outputTokens };
  }

  /** 统一发出步骤。 */
  private emit(options: RunOptions, step: StepEvent): void {
    options.onStep(step);
  }
}
