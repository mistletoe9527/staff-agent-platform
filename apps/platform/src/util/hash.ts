import { createHash, timingSafeEqual } from 'node:crypto';

/** 计算字符串 SHA-256 十六进制摘要。用于设备令牌与口令比对。 */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 常量时间比较，避免口令/令牌被计时攻击逐位猜解。
 */
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    // 长度不同也要走一次比较，避免通过耗时判断长度
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
