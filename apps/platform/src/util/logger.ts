/** 日志级别：只允许 info / warn / error，避免生产环境噪音。 */
export type LogLevel = 'info' | 'warn' | 'error';

/** 结构化日志器。 */
export interface Logger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

/**
 * 创建日志器。
 * 输出单行 JSON，直接对接 docker logs / 公司日志采集，不需要额外依赖。
 */
export function createLogger(level: LogLevel): Logger {
  const threshold = LEVEL_WEIGHT[level];
  const write = (logLevel: LogLevel, fields: Record<string, unknown>, message: string): void => {
    if (LEVEL_WEIGHT[logLevel] < threshold) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: logLevel,
      msg: message,
      ...fields,
    });
    if (logLevel === 'error') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  };
  return {
    info: (fields, message) => write('info', fields, message),
    warn: (fields, message) => write('warn', fields, message),
    error: (fields, message) => write('error', fields, message),
  };
}

/** 把未知异常转成可读字符串，避免日志里出现 [object Object]。 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}
