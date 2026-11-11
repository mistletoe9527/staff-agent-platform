import type { RunStatus } from '@staff-agent/shared';
import type { Db } from '../db/client.js';
import { isoAfterMs, newId, newToken, nowIso } from '../util/ids.js';

/** runs 表行结构。 */
export interface RunRow {
  id: string;
  agent_id: string;
  device_id: string;
  conversation_id: string;
  prompt: string;
  status: RunStatus;
  attempt: number;
  lease_id: string | null;
  lease_expires_at: string | null;
  result: string | null;
  error: string | null;
  duration_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  session_ref: string | null;
  feishu_chat_id: string;
  feishu_message_id: string | null;
  created_by_open_id: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

/** 对外暴露的任务实体。 */
export interface Run {
  id: string;
  agentId: string;
  deviceId: string;
  conversationId: string;
  prompt: string;
  status: RunStatus;
  attempt: number;
  leaseId: string | null;
  leaseExpiresAt: string | null;
  result: string | null;
  error: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  sessionRef: string | null;
  feishuChatId: string;
  feishuMessageId: string | null;
  createdByOpenId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/** 行转实体。 */
export function toRun(row: RunRow): Run {
  return {
    id: row.id,
    agentId: row.agent_id,
    deviceId: row.device_id,
    conversationId: row.conversation_id,
    prompt: row.prompt,
    status: row.status,
    attempt: row.attempt,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
    result: row.result,
    error: row.error,
    durationMs: row.duration_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    sessionRef: row.session_ref,
    feishuChatId: row.feishu_chat_id,
    feishuMessageId: row.feishu_message_id,
    createdByOpenId: row.created_by_open_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/** 创建待执行任务。 */
export function createRun(
  db: Db,
  input: {
    agentId: string;
    deviceId: string;
    conversationId: string;
    prompt: string;
    feishuChatId: string;
    feishuMessageId: string | null;
    createdByOpenId: string | null;
    sessionRef: string | null;
  },
): Run {
  const id = newId('run');
  const now = nowIso();
  db.prepare(
    `INSERT INTO runs (id, agent_id, device_id, conversation_id, prompt, status, attempt, lease_id, lease_expires_at,
       result, error, duration_ms, input_tokens, output_tokens, session_ref, feishu_chat_id, feishu_message_id,
       created_by_open_id, created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, NULL, NULL, 0, 0, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    id,
    input.agentId,
    input.deviceId,
    input.conversationId,
    input.prompt,
    input.sessionRef,
    input.feishuChatId,
    input.feishuMessageId,
    input.createdByOpenId,
    now,
  );
  return {
    id,
    agentId: input.agentId,
    deviceId: input.deviceId,
    conversationId: input.conversationId,
    prompt: input.prompt,
    status: 'queued',
    attempt: 0,
    leaseId: null,
    leaseExpiresAt: null,
    result: null,
    error: null,
    durationMs: null,
    inputTokens: 0,
    outputTokens: 0,
    sessionRef: input.sessionRef,
    feishuChatId: input.feishuChatId,
    feishuMessageId: input.feishuMessageId,
    createdByOpenId: input.createdByOpenId,
    createdAt: now,
    startedAt: null,
    endedAt: null,
  };
}

/** 该 Agent 是否有正在执行的任务（用于飞书侧提示「已排队」）。 */
export function hasRunningRun(db: Db, agentId: string): boolean {
  const row = db
    .prepare("SELECT 1 AS hit FROM runs WHERE agent_id = ? AND status = 'running' LIMIT 1")
    .get(agentId) as { hit: number } | undefined;
  return Boolean(row);
}

/** 排队中任务数量。 */
export function countQueuedRuns(db: Db, agentId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM runs WHERE agent_id = ? AND status = 'queued'")
    .get(agentId) as { c: number };
  return Number(row.c);
}

/**
 * 认领下一个任务。
 * 单实例 + 同步 SQLite，两步读写天然原子：先查候选，再带 status 条件更新。
 * 同一 Agent 串行执行，避免两个任务抢同一段会话上下文。
 */
export function claimNextRun(
  db: Db,
  input: { agentId: string; deviceId: string; leaseMs: number },
): Run | null {
  const candidate = db
    .prepare(
      `SELECT * FROM runs
       WHERE agent_id = ? AND status = 'queued'
         AND NOT EXISTS (SELECT 1 FROM runs r2 WHERE r2.agent_id = ? AND r2.status = 'running')
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(input.agentId, input.agentId) as unknown as RunRow | undefined;
  if (!candidate) return null;
  const leaseId = newToken(16);
  const now = nowIso();
  const result = db
    .prepare(
      `UPDATE runs SET status = 'running', attempt = attempt + 1, lease_id = ?, lease_expires_at = ?,
         started_at = COALESCE(started_at, ?), device_id = ?
       WHERE id = ? AND status = 'queued'`,
    )
    .run(leaseId, isoAfterMs(input.leaseMs), now, input.deviceId, candidate.id);
  if (Number(result.changes) === 0) return null;
  return toRun({
    ...candidate,
    status: 'running',
    attempt: candidate.attempt + 1,
    lease_id: leaseId,
    lease_expires_at: isoAfterMs(input.leaseMs),
    started_at: candidate.started_at ?? now,
    device_id: input.deviceId,
  });
}

/** 网关确认收到任务。幂等，重复 ack 不影响状态。 */
export function ackRun(
  db: Db,
  input: { runId: string; deviceId: string; leaseId: string; leaseMs: number },
): boolean {
  const result = db
    .prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ? AND device_id = ? AND lease_id = ? AND status = 'running'")
    .run(isoAfterMs(input.leaseMs), input.runId, input.deviceId, input.leaseId);
  return Number(result.changes) > 0;
}

/** 任务结束上报。只接受终态，且必须持有当前租约。 */
export function finishRun(
  db: Db,
  input: {
    runId: string;
    deviceId: string;
    leaseId: string;
    status: 'succeeded' | 'failed' | 'canceled' | 'timeout';
    result?: string | null;
    error?: string | null;
    durationMs?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    sessionRef?: string | null;
  },
): RunRow | null {
  const now = nowIso();
  const current = db
    .prepare("SELECT * FROM runs WHERE id = ? AND device_id = ? AND lease_id = ? AND status = 'running'")
    .get(input.runId, input.deviceId, input.leaseId) as unknown as RunRow | undefined;
  if (!current) return null;
  db.prepare(
    `UPDATE runs SET status = ?, result = ?, error = ?, duration_ms = ?, input_tokens = ?, output_tokens = ?,
       session_ref = COALESCE(?, session_ref), ended_at = ?, lease_id = NULL, lease_expires_at = NULL
     WHERE id = ?`,
  ).run(
    input.status,
    input.result ?? null,
    input.error ?? null,
    input.durationMs ?? null,
    input.inputTokens ?? 0,
    input.outputTokens ?? 0,
    input.sessionRef ?? null,
    now,
    input.runId,
  );
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(input.runId) as unknown as RunRow;
}

/** 查询任务。 */
export function findRunById(db: Db, id: string): Run | null {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
  return row ? toRun(row) : null;
}

/**
 * 回收过期租约：网关崩溃或断网时任务不会永久卡在 running。
 * 未超过最大重投次数的回到队列，超出的标记失败。
 */
export function reapExpiredLeases(
  db: Db,
  input: { maxAttempts: number },
): { requeued: Run[]; failed: Run[] } {
  const now = nowIso();
  const expired = db
    .prepare("SELECT * FROM runs WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?")
    .all(now) as unknown as RunRow[];
  const requeued: Run[] = [];
  const failed: Run[] = [];
  for (const row of expired) {
    if (row.attempt >= input.maxAttempts) {
      db.prepare(
        `UPDATE runs SET status = 'failed', error = COALESCE(error, ?), ended_at = ?, lease_id = NULL, lease_expires_at = NULL WHERE id = ?`,
      ).run('网关租约过期且已达最大重投次数', now, row.id);
      const updated = db.prepare('SELECT * FROM runs WHERE id = ?').get(row.id) as unknown as RunRow;
      failed.push(toRun(updated));
      continue;
    }
    db.prepare(
      `UPDATE runs SET status = 'queued', lease_id = NULL, lease_expires_at = NULL WHERE id = ?`,
    ).run(row.id);
    requeued.push(toRun({ ...row, status: 'queued', lease_id: null, lease_expires_at: null }));
  }
  return { requeued, failed };
}

/** 列表查询条件。 */
export interface ListRunsFilter {
  agentId?: string;
  status?: RunStatus;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}

/** 游标编码：created_at + id，避免同一毫秒多条任务翻页错位。 */
function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

/** 游标解码。 */
function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const index = raw.indexOf('|');
    if (index <= 0) return null;
    return { createdAt: raw.slice(0, index), id: raw.slice(index + 1) };
  } catch {
    return null;
  }
}

/**
 * 分页查询任务，JOIN agents 一次取回 Agent 名称，避免逐行查询。
 */
export function listRuns(
  db: Db,
  filter: ListRunsFilter,
): { items: Array<RunRow & { agent_name: string }>; nextCursor: string | null } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.agentId) {
    where.push('r.agent_id = ?');
    params.push(filter.agentId);
  }
  if (filter.status) {
    where.push('r.status = ?');
    params.push(filter.status);
  }
  if (filter.from) {
    where.push('r.created_at >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('r.created_at <= ?');
    params.push(filter.to);
  }
  if (filter.cursor) {
    const cursor = decodeCursor(filter.cursor);
    if (cursor) {
      where.push('(r.created_at < ? OR (r.created_at = ? AND r.id < ?))');
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT r.*, a.name AS agent_name FROM runs r JOIN agents a ON a.id = r.agent_id
       ${clause}
       ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
    )
    .all(...params, filter.limit + 1) as unknown as Array<RunRow & { agent_name: string }>;
  const hasMore = rows.length > filter.limit;
  const items = hasMore ? rows.slice(0, filter.limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

/** 批量统计每个 Agent 在时间窗口内的任务数与成功数，避免 N+1 查询。 */
export function countRunsByAgentIds(
  db: Db,
  agentIds: string[],
  since: string,
): Map<string, { runs: number; succeeded: number }> {
  const map = new Map<string, { runs: number; succeeded: number }>();
  if (agentIds.length === 0) return map;
  const placeholders = agentIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT agent_id, COUNT(*) AS runs, SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded
       FROM runs WHERE agent_id IN (${placeholders}) AND created_at >= ? GROUP BY agent_id`,
    )
    .all(...agentIds, since) as unknown as Array<{ agent_id: string; runs: number; succeeded: number }>;
  for (const row of rows) {
    map.set(row.agent_id, { runs: Number(row.runs), succeeded: Number(row.succeeded ?? 0) });
  }
  return map;
}
