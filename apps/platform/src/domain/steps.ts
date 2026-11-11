import type { StepInput, StepType } from '@staff-agent/shared';
import type { Db } from '../db/client.js';
import { nowIso } from '../util/ids.js';

/** 步骤实体。 */
export interface Step {
  seq: number;
  type: StepType;
  name: string;
  inputSummary: string | null;
  outputSummary: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  isError: boolean;
  createdAt: string;
}

/**
 * 批量写入步骤。
 * 以 (run_id, seq) 唯一约束做幂等：网关重传不会产生重复 trace。
 * @returns 实际写入条数
 */
export function insertSteps(db: Db, runId: string, steps: StepInput[]): number {
  const statement = db.prepare(
    `INSERT INTO steps (id, run_id, seq, type, name, input_summary, output_summary, duration_ms, input_tokens, output_tokens, is_error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, seq) DO NOTHING`,
  );
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const step of steps) {
      const result = statement.run(
        `${runId}:${step.seq}`,
        runId,
        step.seq,
        step.type,
        step.name.slice(0, 256),
        step.inputSummary ?? null,
        step.outputSummary ?? null,
        step.durationMs ?? null,
        step.inputTokens ?? null,
        step.outputTokens ?? null,
        step.isError ? 1 : 0,
        step.occurredAt ?? nowIso(),
      );
      inserted += Number(result.changes);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return inserted;
}

/** 查询某任务的全部步骤，按 seq 升序。 */
export function listSteps(db: Db, runId: string): Step[] {
  const rows = db
    .prepare('SELECT seq, type, name, input_summary, output_summary, duration_ms, input_tokens, output_tokens, is_error, created_at FROM steps WHERE run_id = ? ORDER BY seq ASC')
    .all(runId) as Array<{
    seq: number;
    type: StepType;
    name: string;
    input_summary: string | null;
    output_summary: string | null;
    duration_ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    is_error: number;
    created_at: string;
  }>;
  return rows.map((row) => ({
    seq: Number(row.seq),
    type: row.type,
    name: row.name,
    inputSummary: row.input_summary,
    outputSummary: row.output_summary,
    durationMs: row.duration_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    isError: Number(row.is_error) === 1,
    createdAt: row.created_at,
  }));
}

/**
 * 清理超出保留期的步骤明细。
 * 任务级记录保留，聚合统计不受影响。
 */
export function purgeExpiredSteps(db: Db, cutoffIso: string): number {
  const result = db.prepare('DELETE FROM steps WHERE created_at < ?').run(cutoffIso);
  return Number(result.changes);
}
