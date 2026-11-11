import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

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

/**
 * 读子进程的 JSONL 输出。
 *
 * 与 readJsonLines 的区别：进程根本没起来时 stdout 会被 Node 直接销毁并抛错，
 * 这里只吞掉这类错误，真正的启动失败原因由 describeSpawnFailure 统一翻译。
 */
export async function* readChildJsonLines(child: ChildProcess): AsyncGenerator<Record<string, unknown>> {
  if (!child.stdout) return;
  try {
    yield* readJsonLines(child.stdout);
  } catch (error) {
    if (!spawnFailures.has(child)) throw error;
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

/** spawn 的 error 事件。挂监听避免未捕获异常把整个网关打挂。 */
const spawnFailures = new WeakMap<ChildProcess, Error>();

/**
 * 兜底的可执行文件搜索目录。
 * 后台进程常由 launchd / GUI 拉起，PATH 往往只有 /usr/bin:/bin，
 * 找不到 npm / pip 装到用户目录的 pi、claude、codex。
 */
const FALLBACK_BIN_DIRS = [
  join(homedir(), '.pi/agent/bin'),
  join(homedir(), '.local/bin'),
  join(homedir(), '.claude/local'),
  join(homedir(), '.npm-global/bin'),
  join(homedir(), '.bun/bin'),
  join(homedir(), '.volta/bin'),
  join(homedir(), '.asdf/shims'),
  join(homedir(), '.cargo/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

/** 在 PATH 与常见安装目录里查找可执行文件，找不到返回 null。 */
export function resolveExecutable(command: string): string | null {
  if (!command) return null;
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return isExecutableFile(command) ? command : null;
  }
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...FALLBACK_BIN_DIRS];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of candidateNames(command)) {
      const full = join(dir, name);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

/** Windows 下可执行文件带扩展名，其余平台按原名。 */
function candidateNames(command: string): string[] {
  if (process.platform !== 'win32') return [command];
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  return [command, ...exts.map((ext) => `${command}${ext.toLowerCase()}`)];
}

/** 是否为可执行文件（POSIX 校验执行位，Windows 只校验存在）。 */
function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    return process.platform === 'win32' ? true : (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * 子进程环境变量。
 *
 * pi / claude / codex 大多是 `#!/usr/bin/env node` 的包装脚本，
 * 只补 PATH 上的 CLI 目录不够，还得把 node 所在目录一起补上，
 * 否则在 launchd / GUI 这种精简 PATH 下会报 `env: node: No such file or directory`。
 */
export function cliEnv(command?: string): NodeJS.ProcessEnv {
  const dirs = [
    ...(command && isAbsolute(command) ? [dirname(command)] : []),
    dirname(process.execPath),
    ...(process.env.PATH ?? '').split(delimiter),
  ].filter(Boolean);
  return { ...process.env, PATH: [...new Set(dirs)].join(delimiter) };
}

/** 启动计划：可执行文件绝对路径；error 非空表示不该启动。 */
export interface SpawnPlan {
  command: string;
  error: string | null;
}

/**
 * 启动前校验，把 spawn 的 ENOENT 提前成可读提示。
 *
 * ENOENT 有两个来源：可执行文件不在 PATH 里，或者 cwd 不存在。
 * 原来这类错误以未捕获 'error' 事件的形式直接终止网关进程。
 */
export function planSpawn(command: string, cwd: string): SpawnPlan {
  if (!existsSync(cwd)) {
    return {
      command,
      error: `工作目录 ${cwd} 不存在，请先创建该目录，或用 sa login --cwd <dir> 重新指定`,
    };
  }
  const resolved = resolveExecutable(command);
  if (!resolved) {
    return { command, error: `本机未找到可执行文件 ${command}，请安装后重试，或用环境变量指定其绝对路径` };
  }
  return { command: resolved, error: null };
}

/** 启动子进程。 */
export function spawnCli(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): ChildProcess {
  const bin = resolveExecutable(command) ?? command;
  const child = spawn(bin, args, {
    cwd: options.cwd,
    env: options.env ?? cliEnv(bin),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.on('error', (error: Error) => {
    if (!spawnFailures.has(child)) spawnFailures.set(child, error);
  });
  // 启动失败时 stdio 会被立即销毁，写入触发 EPIPE；逐个挂监听避免二次打挂网关
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.on('error', () => {});
  }
  return child;
}

/** 子进程是否启动失败。 */
export function spawnFailure(child: ChildProcess): Error | null {
  return spawnFailures.get(child) ?? null;
}

/** 把启动失败翻译成可读原因；进程正常启动返回 null。 */
export function describeSpawnFailure(child: ChildProcess, command: string, cwd: string): string | null {
  const error = spawnFailures.get(child);
  if (!error) return null;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return existsSync(cwd)
      ? `本机未找到可执行文件 ${command}，请安装后重试，或用环境变量指定其绝对路径`
      : `工作目录 ${cwd} 不存在，请先创建该目录，或用 sa login --cwd <dir> 重新指定`;
  }
  if (code === 'EACCES') return `没有权限执行 ${command}：${error.message}`;
  return `启动 ${command} 失败：${error.message}`;
}

/**
 * 向长驻子进程 stdin 写入一行，保持打开。
 *
 * pi 的 RPC 模式是长驻会话：stdin 一旦 EOF 它就直接退出，
 * 所以这里不能像一次性的 claude / codex 那样写完全量就 end()。
 */
export function writeStdinLine(child: ChildProcess, content: string): void {
  if (!child.stdin || child.stdin.destroyed) return;
  child.stdin.write(content);
}

/**
 * 优雅收尾：先关 stdin 让进程自己退出，超时才 SIGTERM / SIGKILL。
 * 直接 SIGTERM 可能让运行时来不及落盘会话文件。
 */
export async function shutdownCli(child: ChildProcess, graceMs = 3_000): Promise<void> {
  if (spawnFailures.has(child)) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.stdin?.destroyed) child.stdin?.end();
  const exited = await Promise.race([
    waitExit(child).then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), graceMs);
      timer.unref();
    }),
  ]);
  if (!exited) {
    killProcess(child);
    await waitExit(child);
  }
}

/**
 * 向子进程 stdin 写入内容并关闭。
 * 大 prompt 必须走 stdin，避免命令行参数长度上限（Windows 约 32KB）。
 */
export function writeStdin(child: ChildProcess, content: string): void {
  if (!child.stdin || child.stdin.destroyed) return;
  child.stdin.write(content);
  child.stdin.end();
}

/** 终止子进程：先 SIGTERM，3 秒后 SIGKILL。 */
export function killProcess(child: ChildProcess): void {
  if (spawnFailures.has(child)) return;
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

/**
 * 等待子进程退出。
 *
 * 同时监听 close / error：启动失败的进程只会触发 error + close，
 * 永远不会有 exit，只等 exit 会挂死任务。
 */
export function waitExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const done = (): void => resolve({ code: child.exitCode, signal: child.signalCode });
    child.once('exit', done);
    child.once('close', done);
    child.once('error', done);
  });
}
