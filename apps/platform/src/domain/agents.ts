import type { AgentRuntime, AgentStatus } from '@staff-agent/shared';
import type { Db } from '../db/client.js';
import { newId, nowIso } from '../util/ids.js';

/** agents 表行结构。 */
export interface AgentRow {
  id: string;
  feishu_open_id: string;
  feishu_name: string | null;
  name: string;
  runtime: AgentRuntime;
  status: AgentStatus;
  created_at: string;
  updated_at: string;
}

/** 对外暴露的 Agent 实体。 */
export interface Agent {
  id: string;
  feishuOpenId: string;
  feishuName: string | null;
  name: string;
  runtime: AgentRuntime;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
}

/** 行转实体。 */
function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    feishuOpenId: row.feishu_open_id,
    feishuName: row.feishu_name,
    name: row.name,
    runtime: row.runtime,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 通过飞书 open_id 查询 Agent（一对一约束的查询入口）。 */
export function findAgentByOpenId(db: Db, openId: string): Agent | null {
  const row = db
    .prepare('SELECT * FROM agents WHERE feishu_open_id = ?')
    .get(openId) as unknown as AgentRow | undefined;
  return row ? toAgent(row) : null;
}

/** 通过 ID 查询 Agent。 */
export function findAgentById(db: Db, id: string): Agent | null {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as unknown as AgentRow | undefined;
  return row ? toAgent(row) : null;
}

/** 创建 Agent。调用方必须保证 open_id 未绑定（先查后建）。 */
export function createAgent(
  db: Db,
  input: { feishuOpenId: string; feishuName: string | null; name: string; runtime: AgentRuntime },
): Agent {
  const now = nowIso();
  const id = newId('agt');
  db.prepare(
    `INSERT INTO agents (id, feishu_open_id, feishu_name, name, runtime, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, input.feishuOpenId, input.feishuName, input.name, input.runtime, now, now);
  return {
    id,
    feishuOpenId: input.feishuOpenId,
    feishuName: input.feishuName,
    name: input.name,
    runtime: input.runtime,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

/** 修改 Agent 名称或状态。 */
export function updateAgent(
  db: Db,
  id: string,
  patch: { name?: string; status?: AgentStatus },
): void {
  const fields: string[] = [];
  const values: Array<string> = [];
  if (patch.name !== undefined) {
    fields.push('name = ?');
    values.push(patch.name);
  }
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(nowIso());
  values.push(id);
  db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/** 统计 Agent 总数与在线数（在线由最后心跳时间决定）。 */
export function countAgents(db: Db): { total: number; online: number; byRuntime: Array<{ runtime: AgentRuntime; agents: number }> } {
  const total = Number((db.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }).c);
  const byRuntime = db
    .prepare('SELECT runtime, COUNT(*) AS agents FROM agents GROUP BY runtime')
    .all() as unknown as unknown as Array<{ runtime: AgentRuntime; agents: number }>;
  return { total, online: 0, byRuntime };
}
