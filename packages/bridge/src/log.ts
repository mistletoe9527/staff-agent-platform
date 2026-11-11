import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { appendFileSync, mkdirSync } from 'node:fs';
import { logDir, logPath } from './paths.js';

/** 日志级别。只打 info / warn / error。 */
type Level = 'info' | 'warn' | 'error';

/** 单行日志：终端 + 文件双写，daemon 模式下主要看文件。 */
export function log(level: Level, message: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    msg: message,
    ...(fields ?? {}),
  });
  const prefix = level === 'error' ? '✖' : level === 'warn' ? '!' : '·';
  console.log(`${prefix} ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`);
  try {
    mkdirSync(logDir(), { recursive: true });
    appendFileSync(logPath(), `${line}\n`);
  } catch {
    // 日志落盘失败不影响主流程
  }
}

/** 稳定机器标识：hostname + 用户名 + 平台地址的哈希。重装后仍能复用设备记录。 */
export function machineId(platformUrl: string): string {
  const user = userInfo().username;
  return createHash('sha256').update(`${hostname()}|${user}|${platformUrl}`).digest('hex').slice(0, 32);
}

/** 机器名，给管理员识别。 */
export function machineName(): string {
  return `${hostname()} (${userInfo().username})`;
}

/** 错误转可读文本。 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
