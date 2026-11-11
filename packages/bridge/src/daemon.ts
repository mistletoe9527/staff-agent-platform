import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pidPath } from './paths.js';
import { log, errorText } from './log.js';

/** 读取守护进程 PID。 */
export function readPid(): number | null {
  const path = pidPath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8').trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** 进程是否存活。 */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 后台启动：以 detached 方式拉起自身 `start --foreground`，父进程立即返回。
 * 日志已由 log() 双写到 ~/.staff-agent/logs/bridge.log。
 */
export function startDaemon(): number {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    throw new Error(`网关已在运行（PID ${pid}）`);
  }
  const selfPath = fileURLToPath(import.meta.url);
  // tsup 打包后入口是 dist/cli.js，这里用当前脚本路径拉起同一个入口
  const entry = process.argv[1] ?? selfPath;
  const logFile = `${pidPath().replace(/bridge\.pid$/, '')}logs/daemon.log`;
  const out = openSync(logFile, 'a');
  const child = spawn(process.execPath, [entry, 'start', '--foreground'], {
    detached: true,
    stdio: ['ignore', out, out],
    // 标记一下：子进程退出时自己清 PID 文件，否则 401 退出会留下陈 PID
    env: { ...process.env, STAFF_AGENT_DAEMON: '1' },
  });
  closeSync(out);
  child.unref();
  if (!child.pid) throw new Error('后台进程启动失败');
  writeFileSync(pidPath(), `${child.pid}\n`, 'utf8');
  log('info', '网关已在后台启动', { pid: child.pid, log: logFile });
  return child.pid;
}

/** 停止后台进程。 */
export function stopDaemon(): boolean {
  const pid = readPid();
  if (!pid) return false;
  if (!isRunning(pid)) {
    safeUnlinkPid();
    return false;
  }
  try {
    process.kill(pid, 'SIGTERM');
    safeUnlinkPid();
    log('info', '已发送停止信号', { pid });
    return true;
  } catch (error) {
    log('error', '停止进程失败', { pid, error: errorText(error) });
    return false;
  }
}

/** 删除 PID 文件。 */
export function safeUnlinkPid(): void {
  try {
    if (existsSync(pidPath())) unlinkSync(pidPath());
  } catch {
    // 忽略
  }
}
