import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
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
const POSIX_BIN_DIRS = [
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

/**
 * Windows 的 CLI 落在 npm / pnpm 全局目录或用户目录里，
 * 目录结构与 POSIX 完全不同，兜底目录必须单独给。
 */
function windowsBinDirs(): string[] {
  const home = homedir();
  const roaming = process.env.APPDATA ?? join(home, 'AppData/Roaming');
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData/Local');
  return [
    join(home, '.pi/agent/bin'),
    join(home, '.claude/local'),
    join(home, '.bun/bin'),
    join(home, '.cargo/bin'),
    join(roaming, 'npm'),
    join(local, 'pnpm'),
    join(local, 'Programs/pi/bin'),
    join(local, 'Microsoft/WinGet/Links'),
    join(process.env.ProgramData ?? 'C:/ProgramData', 'chocolatey/bin'),
  ];
}

/** PATH 里可能有带引号的目录（Windows 常见），去掉引号再查。 */
function pathDirs(pathValue: string | undefined): string[] {
  return (pathValue ?? '')
    .split(delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

/** 在 PATH 与常见安装目录里查找可执行文件，找不到返回 null。 */
export function resolveExecutable(command: string): string | null {
  if (!command) return null;
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return isExecutableFile(command) ? command : null;
  }
  const fallback = process.platform === 'win32' ? windowsBinDirs() : POSIX_BIN_DIRS;
  const dirs = [...pathDirs(process.env.PATH), ...fallback];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of candidateNames(command)) {
      const full = join(dir, name);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

/** Windows 上 CreateProcess 能直接启动的扩展名。 */
const WINDOWS_SPAWNABLE_EXTS = ['.com', '.exe', '.bat', '.cmd'];

/**
 * Windows 下候选文件名。
 *
 * npm / pnpm 在 Windows 上会装三份 shim：`codex`（git-bash 的 sh 脚本）、
 * `codex.cmd`、`codex.ps1`。按原名优先会挑到 sh 脚本，CreateProcess 起不来（ENOENT），
 * 所以必须先按 PATHEXT 找 .exe / .cmd / .bat，最后才退回无扩展名文件。
 */
function candidateNames(command: string): string[] {
  if (process.platform !== 'win32') return [command];
  if (WINDOWS_SPAWNABLE_EXTS.some((ext) => command.toLowerCase().endsWith(ext))) return [command];
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => WINDOWS_SPAWNABLE_EXTS.includes(ext));
  const names = [...new Set(exts)].map((ext) => `${command}${ext}`);
  return [...names, command];
}

/**
 * 是否为可执行文件。
 *
 * POSIX 校验执行位；Windows 上 .exe / .com 与 .cmd / .bat 可执行，
 * 无扩展名文件必须是真正的 PE 二进制（否则就是 git-bash 的 sh shim，spawn 会 ENOENT）。
 */
function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') return (stat.mode & 0o111) !== 0;
    const lower = path.toLowerCase();
    if (WINDOWS_SPAWNABLE_EXTS.some((ext) => lower.endsWith(ext))) return true;
    return isPeBinary(path);
  } catch {
    return false;
  }
}

/** 读文件头判断是否为 PE 可执行文件（"MZ"）。 */
function isPeBinary(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(2);
    const read = readSync(fd, head, 0, 2, 0);
    return read === 2 && head[0] === 0x4d && head[1] === 0x5a;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** .cmd / .bat 不能直接 CreateProcess，必须经 cmd.exe 拉起。 */
export function needsShell(bin: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
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
    // Windows 的 npm shim 是 .cmd，只能经 cmd.exe 启动
    shell: needsShell(bin),
    windowsHide: true,
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

/**
 * 把 `--version` 探测失败翻译成可读提示。
 *
 * doctor 直接把 detail 打给员工看，所以这里顺带告诉对方该设哪个环境变量。
 */
export function describeCheckFailure(command: string, error: unknown, envVar?: string): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'ENOENT' || code === 'EINVAL') {
    if (process.platform === 'win32' && code === 'EINVAL') {
      return `无法直接启动 ${command}（${message}），它可能是 .cmd/.bat 包装脚本，请升级 sa 到最新版本`;
    }
    return envVar
      ? `本机未找到可执行文件 ${command}，请安装后重试，或用环境变量 ${envVar} 指定其绝对路径（Windows 下要指向 .exe 或 .cmd）`
      : `本机未找到可执行文件 ${command}，请安装后重试`;
  }
  return message;
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

/**
 * Windows 没有 SIGTERM，child.kill 只终结直接子进程。
 * 走 cmd.exe 拉起的 .cmd shim 下面还挂着 node 子进程，必须用 taskkill /T 收整棵树。
 */
function killTreeWindows(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    child.kill();
    return;
  }
  const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  if (result.error) child.kill();
}

/** 终止子进程：先 SIGTERM，3 秒后 SIGKILL。 */
export function killProcess(child: ChildProcess): void {
  if (spawnFailures.has(child)) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    killTreeWindows(child);
    return;
  }
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
