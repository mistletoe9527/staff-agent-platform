import { createHmac } from 'node:crypto';
import type { Db } from '../db/client.js';
import { isoAfter, newEnrollCode, nowIso } from '../util/ids.js';

/** 绑定码记录。 */
export interface EnrollRecord {
  codeHash: string;
  deviceId: string;
  expiresAt: string;
  consumedAt: string | null;
}

/**
 * 绑定码哈希：用 HMAC + 服务端密钥，即使数据库泄露也无法反推 6 位码。
 */
export function hashEnrollCode(code: string, pepper: string): string {
  return createHmac('sha256', pepper).update(code).digest('hex');
}

/** 为设备创建绑定码，旧未使用的码保持不变（ttl 内可重试）。 */
export function createEnrollCode(
  db: Db,
  input: { deviceId: string; ttlSec: number; pepper: string },
): { code: string; expiresAt: string } {
  // 先清理该设备已过期的码，避免无限堆积
  db.prepare('DELETE FROM enroll_codes WHERE device_id = ? AND expires_at < ?').run(input.deviceId, nowIso());
  const code = newEnrollCode();
  const expiresAt = isoAfter(input.ttlSec);
  db.prepare('INSERT INTO enroll_codes (code_hash, device_id, expires_at, consumed_at, created_at) VALUES (?, ?, ?, NULL, ?)').run(
    hashEnrollCode(code, input.pepper),
    input.deviceId,
    expiresAt,
    nowIso(),
  );
  return { code, expiresAt };
}

/** 按明文绑定码查询记录；过期或不存在返回 null。 */
export function findEnrollRecord(db: Db, code: string, pepper: string): EnrollRecord | null {
  const codeHash = hashEnrollCode(code, pepper);
  const row = db
    .prepare('SELECT code_hash, device_id, expires_at, consumed_at FROM enroll_codes WHERE code_hash = ?')
    .get(codeHash) as
    | { code_hash: string; device_id: string; expires_at: string; consumed_at: string | null }
    | undefined;
  if (!row) return null;
  return {
    codeHash: row.code_hash,
    deviceId: row.device_id,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

/** 标记绑定码已消费。 */
export function consumeEnrollCode(db: Db, codeHash: string): void {
  db.prepare('UPDATE enroll_codes SET consumed_at = ? WHERE code_hash = ?').run(nowIso(), codeHash);
}

/** 清理已过期或已消费的绑定码。 */
export function purgeEnrollCodes(db: Db): number {
  const result = db.prepare('DELETE FROM enroll_codes WHERE expires_at < ? OR consumed_at IS NOT NULL').run(nowIso());
  return Number(result.changes);
}

/** 绑定成功后暂存待下发的设备令牌（网关轮询取走后立即清空）。 */
export function setPendingToken(db: Db, codeHash: string, token: string): void {
  db.prepare('UPDATE enroll_codes SET pending_token = ? WHERE code_hash = ?').run(token, codeHash);
}

/** 取出并清空待下发令牌。取走后不再重复下发，避免令牌在库里长期驻留。 */
export function takePendingToken(db: Db, codeHash: string): string | null {
  const row = db.prepare('SELECT pending_token FROM enroll_codes WHERE code_hash = ?').get(codeHash) as
    | { pending_token: string | null }
    | undefined;
  const token = row?.pending_token ?? null;
  if (token) {
    db.prepare('UPDATE enroll_codes SET pending_token = NULL WHERE code_hash = ?').run(codeHash);
  }
  return token;
}
