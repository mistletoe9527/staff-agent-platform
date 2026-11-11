import type { Db } from '../db/client.js';
import { newId, nowIso } from '../util/ids.js';

/** 管理操作审计日志。 */
export function audit(
  db: Db,
  input: { actor: string; action: string; target?: string | null; detail?: string | null },
): void {
  db.prepare('INSERT INTO audit_logs (id, actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    newId('aud'),
    input.actor,
    input.action,
    input.target ?? null,
    input.detail ?? null,
    nowIso(),
  );
}
