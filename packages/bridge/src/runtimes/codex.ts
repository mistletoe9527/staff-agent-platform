import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunOptions, RunOutcome, RuntimeAdapter } from './types.js';
import { readNumber, summarize } from './types.js';
import {
  bindAbort,
  cliEnv,
  describeCheckFailure,
  describeSpawnFailure,
  killProcess,
  needsShell,
  planSpawn,
  readChildJsonLines,
  resolveExecutable,
  spawnCli,
  waitExit,
  writeStdin,
} from './process.js';

const execFileAsync = promisify(execFile);

/**
 * Codex 适配器：`codex exec --json`。
 *
 * 会话复用：首轮从 thread.started 拿到 thread_id，后续 `codex exec resume <id>`。
 * prompt 走 stdin（`-`），避免中文多行在 Windows 命令行被截断。
 */
export class CodexAdapter implements RuntimeAdapter {
  readonly id = 'codex' as const;

  constructor(private readonly bin: string = process.env.STAFF_AGENT_CODEX_BIN ?? 'codex') {}

  /** 检查 codex 是否可用。 */
  async check(): Promise<{ ok: boolean; version?: string; detail?: string }> {
    try {
      const bin = resolveExecutable(this.bin) ?? this.bin;
      const { stdout } = await execFileAsync(bin, ['--version'], {
        timeout: 10_000,
        env: cliEnv(bin),
        // Windows 下 npm 装出来的 claude / codex 是 .cmd，execFile 必须经 shell
        shell: needsShell(bin),
        windowsHide: true,
      });
      return { ok: true, version: stdout.trim().split('\n')[0] };
    } catch (error) {
      return { ok: false, detail: describeCheckFailure(this.bin, error, 'STAFF_AGENT_CODEX_BIN') };
    }
  }

  /** 执行一次任务。 */
  async run(options: RunOptions): Promise<RunOutcome> {
    const extraArgs = (process.env.STAFF_AGENT_CODEX_ARGS ?? '').split(' ').filter(Boolean);
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', options.cwd, ...extraArgs];
    if (options.sessionRef) {
      args.push('resume', options.sessionRef, '-');
    } else {
      args.push('-');
    }
    // 先校验可执行文件与工作目录，避免 spawn ENOENT 直接打挂网关
    const plan = planSpawn(this.bin, options.cwd);
    if (plan.error) {
      return { ok: false, result: '', sessionRef: options.sessionRef ?? '', inputTokens: 0, outputTokens: 0, error: plan.error };
    }

    const child = spawnCli(plan.command, args, { cwd: options.cwd });
    const unbind = bindAbort(child, options.signal);

    let finalText = '';
    let threadId = options.sessionRef ?? '';
    let inputTokens = 0;
    let outputTokens = 0;
    let failure: string | null = null;
    let completed = false;
    let stderrTail = '';
    /** 命令执行开始时间，用于补 durationMs。 */
    const commandStarts = new Map<string, number>();

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-4000);
    });
    writeStdin(child, options.prompt);

    try {
      for await (const event of readChildJsonLines(child)) {
        const type = String(event.type ?? '');
        if (type === 'thread.started') {
          if (typeof event.thread_id === 'string') threadId = event.thread_id;
          continue;
        }
        if (type === 'item.started') {
          const item = event.item as { id?: string; type?: string } | undefined;
          if (item?.id) commandStarts.set(item.id, Date.now());
          continue;
        }
        if (type === 'item.completed') {
          const item = event.item as Record<string, unknown> | undefined;
          if (!item) continue;
          const itemType = String(item.type ?? '');
          const itemId = typeof item.id === 'string' ? item.id : '';
          const startedAt = itemId ? commandStarts.get(itemId) : undefined;
          const durationMs = startedAt ? Date.now() - startedAt : undefined;
          if (itemId) commandStarts.delete(itemId);

          if (itemType === 'agent_message') {
            if (typeof item.text === 'string') finalText = item.text;
          } else if (itemType === 'reasoning') {
            this.emit(options, {
              type: 'thinking',
              name: 'reasoning',
              outputSummary: summarize(item.text, 1_000),
              durationMs,
            });
          } else if (itemType === 'command_execution') {
            this.emit(options, {
              type: 'tool',
              name: 'shell',
              inputSummary: summarize(item.command),
              outputSummary: summarize(item.aggregated_output),
              durationMs,
              isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
            });
          } else if (itemType === 'file_change') {
            this.emit(options, {
              type: 'tool',
              name: 'file_change',
              inputSummary: summarize(item.changes),
              durationMs,
            });
          } else if (itemType === 'mcp_tool_call') {
            this.emit(options, {
              type: 'tool',
              name: `${String(item.server ?? 'mcp')}.${String(item.tool ?? 'call')}`,
              inputSummary: summarize(item.arguments),
              outputSummary: summarize(item.result),
              durationMs,
              isError: Boolean(item.error),
            });
          } else if (itemType === 'web_search') {
            this.emit(options, {
              type: 'tool',
              name: 'web_search',
              inputSummary: summarize(item.query),
              durationMs,
            });
          }
          continue;
        }
        if (type === 'turn.completed') {
          completed = true;
          const usage = event.usage as unknown;
          const totalInput = readNumber(usage, 'input_tokens', 'inputTokens');
          const totalOutput = readNumber(usage, 'output_tokens', 'outputTokens');
          if (totalInput > 0) inputTokens = totalInput;
          if (totalOutput > 0) outputTokens = totalOutput;
          continue;
        }
        if (type === 'turn.failed') {
          const error = event.error as { message?: string } | undefined;
          failure = error?.message ?? '执行失败';
          continue;
        }
        if (type === 'error') {
          failure = String(event.message ?? '执行失败');
          continue;
        }
      }
    } finally {
      unbind();
      killProcess(child);
    }

    const exit = await waitExit(child);
    const spawnError = describeSpawnFailure(child, this.bin, options.cwd);
    if (spawnError) {
      return { ok: false, result: finalText, sessionRef: threadId, inputTokens, outputTokens, error: spawnError };
    }
    if (failure) {
      return { ok: false, result: finalText, sessionRef: threadId, inputTokens, outputTokens, error: failure };
    }
    if (!completed) {
      return {
        ok: false,
        result: finalText,
        sessionRef: threadId,
        inputTokens,
        outputTokens,
        error: stderrTail.trim() || `codex 进程异常退出（code=${exit.code ?? 'null'}）`,
      };
    }
    return { ok: true, result: finalText.trim(), sessionRef: threadId, inputTokens, outputTokens };
  }

  /** 统一发出步骤。 */
  private emit(options: RunOptions, step: Parameters<RunOptions['onStep']>[0]): void {
    options.onStep(step);
  }
}
