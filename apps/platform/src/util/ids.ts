import { randomBytes, randomUUID } from 'node:crypto';

/** 生成带前缀的短 ID，便于日志与排查时区分实体类型。 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** 生成不可预测的令牌（设备令牌 / 租约 / 会话）。 */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** 生成 6 位数字绑定码。 */
export function newEnrollCode(): string {
  // 用 crypto 保证不可预测，避免被枚举抢绑
  const max = 1_000_000;
  const value = randomBytes(4).readUInt32BE(0) % max;
  return value.toString().padStart(6, '0');
}

/** 当前时间 ISO 字符串。 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 计算 N 秒后的 ISO 字符串。 */
export function isoAfter(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** 计算 N 毫秒后的 ISO 字符串。 */
export function isoAfterMs(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** 把毫秒时间戳转 ISO；空值安全。 */
export function msToIso(ms: number | undefined): string | null {
  return typeof ms === 'number' ? new Date(ms).toISOString() : null;
}
