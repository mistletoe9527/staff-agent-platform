import { homedir } from 'node:os';
import { join } from 'node:path';

/** 网关数据目录。 */
export function homeDir(): string {
  return process.env.STAFF_AGENT_HOME ?? join(homedir(), '.staff-agent');
}

/** 配置文件路径。 */
export function configPath(): string {
  return join(homeDir(), 'config.json');
}

/** 日志目录。 */
export function logDir(): string {
  return join(homeDir(), 'logs');
}

/** 日志文件路径。 */
export function logPath(): string {
  return join(logDir(), 'bridge.log');
}

/** 守护进程 PID 文件。 */
export function pidPath(): string {
  return join(homeDir(), 'bridge.pid');
}
