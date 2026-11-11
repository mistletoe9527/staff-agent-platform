import type { AgentRuntime, StatsView } from '@staff-agent/shared';
import type { Db } from '../db/client.js';

/** 统计窗口起始时间（ISO）。 */
function sinceIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * 管理后台统计。
 * 所有查询都是聚合 SQL，不逐行取回，500 Agent 规模下毫秒级返回。
 */
export function buildStats(db: Db, input: { days: number; onlineWindowSec: number }): StatsView {
  const since = sinceIso(input.days);
  const onlineBefore = new Date(Date.now() - input.onlineWindowSec * 1000).toISOString();

  const totalsRow = db
    .prepare(
      `SELECT COUNT(*) AS runs,
              SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
              SUM(CASE WHEN status IN ('failed','canceled','timeout') THEN 1 ELSE 0 END) AS failed,
              AVG(duration_ms) AS avg_duration,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens
       FROM runs WHERE created_at >= ?`,
    )
    .get(since) as {
    runs: number;
    succeeded: number | null;
    failed: number | null;
    avg_duration: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
  };

  const agentCounts = db.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number };
  const onlineCounts = db
    .prepare(
      `SELECT COUNT(DISTINCT agent_id) AS c FROM devices
       WHERE status = 'active' AND agent_id IS NOT NULL AND last_seen_at >= ?`,
    )
    .get(onlineBefore) as { c: number };

  const daily = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS date,
              COUNT(*) AS runs,
              SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
              SUM(CASE WHEN status IN ('failed','canceled','timeout') THEN 1 ELSE 0 END) AS failed,
              AVG(duration_ms) AS avg_duration,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens
       FROM runs WHERE created_at >= ?
       GROUP BY date ORDER BY date ASC`,
    )
    .all(since) as Array<{
    date: string;
    runs: number;
    succeeded: number | null;
    failed: number | null;
    avg_duration: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
  }>;

  const topAgents = db
    .prepare(
      `SELECT r.agent_id AS agent_id, a.name AS name, COUNT(*) AS runs,
              SUM(CASE WHEN r.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded
       FROM runs r JOIN agents a ON a.id = r.agent_id
       WHERE r.created_at >= ?
       GROUP BY r.agent_id ORDER BY runs DESC LIMIT 10`,
    )
    .all(since) as unknown as Array<{ agent_id: string; name: string; runs: number; succeeded: number | null }>;

  const toolTop = db
    .prepare(
      `SELECT s.name AS name, COUNT(*) AS count, AVG(s.duration_ms) AS avg_duration,
              SUM(CASE WHEN s.is_error = 1 THEN 1 ELSE 0 END) AS errors
       FROM steps s JOIN runs r ON r.id = s.run_id
       WHERE s.type = 'tool' AND r.created_at >= ?
       GROUP BY s.name ORDER BY count DESC LIMIT 10`,
    )
    .all(since) as unknown as Array<{ name: string; count: number; avg_duration: number | null; errors: number | null }>;

  const runtimeSplit = db
    .prepare('SELECT runtime, COUNT(*) AS agents FROM agents GROUP BY runtime')
    .all() as unknown as unknown as Array<{ runtime: AgentRuntime; agents: number }>;

  const runs = Number(totalsRow.runs);
  const succeeded = Number(totalsRow.succeeded ?? 0);
  return {
    rangeDays: input.days,
    totals: {
      agents: Number(agentCounts.c),
      agentsOnline: Number(onlineCounts.c),
      runs,
      succeeded,
      failed: Number(totalsRow.failed ?? 0),
      successRate: runs > 0 ? succeeded / runs : 0,
      avgDurationMs: Math.round(Number(totalsRow.avg_duration ?? 0)),
      inputTokens: Number(totalsRow.input_tokens ?? 0),
      outputTokens: Number(totalsRow.output_tokens ?? 0),
    },
    daily: daily.map((row) => ({
      date: row.date,
      runs: Number(row.runs),
      succeeded: Number(row.succeeded ?? 0),
      failed: Number(row.failed ?? 0),
      avgDurationMs: Math.round(Number(row.avg_duration ?? 0)),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
    })),
    topAgents: topAgents.map((row) => ({
      agentId: row.agent_id,
      name: row.name,
      runs: Number(row.runs),
      successRate: Number(row.runs) > 0 ? Number(row.succeeded ?? 0) / Number(row.runs) : 0,
    })),
    toolTop: toolTop.map((row) => ({
      name: row.name,
      count: Number(row.count),
      avgDurationMs: Math.round(Number(row.avg_duration ?? 0)),
      errorRate: Number(row.count) > 0 ? Number(row.errors ?? 0) / Number(row.count) : 0,
    })),
    runtimeSplit,
  };
}
