import { spawn, type ChildProcess } from 'node:child_process';

/** 把 stdout 按 LF 切成 JSON 记录。不能用 readline：它会把 U+2028 也当换行。 */
export async function* readJsonLines(stream: NodeJS.ReadableStream): AsyncGenerator<Record<string, unknown>> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += String(chunk);
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '').trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        const parsed = tryParse(line);
        if (parsed) yield parsed;
      }
      index = buffer.indexOf('\n');
    }
  }
  const tail = buffer.replace(/\r$/, '').trim();
  if (tail) {
    const parsed = tryParse(tail);
    if (parsed) yield parsed;
  }
}

/** 宽容解析：非 JSON 行直接丢弃，不影响主流程。 */
function tryParse(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (value && typeof value === 'object') return value as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

/** 启动子进程。 */
export function spawnCli(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): ChildProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * 向子进程 stdin 写入内容并关闭。
 * 大 prompt 必须走 stdin，避免命令行参数长度上限（Windows 约 32KB）。
 */
export function writeStdin(child: ChildProcess, content: string): void {
  if (!child.stdin) return;
  child.stdin.write(content);
  child.stdin.end();
}

/** 终止子进程：先 SIGTERM，3 秒后 SIGKILL。 */
export function killProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 3_000);
  timer.unref();
}

/** 把 AbortSignal 绑定到子进程。 */
export function bindAbort(child: ChildProcess, signal: AbortSignal): () => void {
  const onAbort = (): void => killProcess(child);
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return () => signal.removeEventListener('abort', onAbort);
}

/** 等待子进程退出。 */
export function waitExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
