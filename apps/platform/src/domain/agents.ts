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
  is_primary: number;
  device_id: string | null;
  cwd: string | null;
  description: string | null;
  feishu_avatar: string | null;
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
  /** 主 Agent 由绑定流程创建，客户端不能删除 */
  isPrimary: boolean;
  /** 执行该 Agent 的设备；空表示还没绑定设备 */
  deviceId: string | null;
  /** 工作目录（员工机器上的绝对路径） */
  cwd: string | null;
  /** 工作区说明；客户端新增 Agent 时未填则由 Agent 自己总结 */
  description: string | null;
  /** 飞书头像 URL（绑定 / 手动同步时拉取，无权限时为空） */
  feishuAvatarUrl: string | null;
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
    isPrimary: row.is_primary === 1,
    deviceId: row.device_id,
    cwd: row.cwd,
    description: row.description,
    feishuAvatarUrl: row.feishu_avatar ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 通过飞书 open_id 查询该用户的 Agent（数字员工）。
 *
 * 一个飞书人只有一个 Agent；工作区（子 Agent）是员工本机的概念，平台不感知。
 */
export function findAgentByOpenId(db: Db, openId: string): Agent | null {
  const row = db
    .prepare('SELECT * FROM agents WHERE feishu_open_id = ? AND is_primary = 1')
    .get(openId) as unknown as AgentRow | undefined;
  return row ? toAgent(row) : null;
}

/** 通过 ID 查询 Agent。 */
export function findAgentById(db: Db, id: string): Agent | null {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as unknown as AgentRow | undefined;
  return row ? toAgent(row) : null;
}

/** 生成不重复的 Agent 名：同一人多台设备重复绑定时追加 -2、-3…，避免后台重名。 */
function uniqueName(db: Db, openId: string, name: string): string {
  const taken = new Set(
    (db.prepare('SELECT name FROM agents WHERE feishu_open_id = ?').all(openId) as unknown as Array<{ name: string }>).map(
      (row) => row.name.toLowerCase(),
    ),
  );
  if (!taken.has(name.toLowerCase())) return name;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${name}-${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${name}-${Date.now().toString(36)}`;
}

/**
 * 创建 Agent（只由绑定流程调用，平台侧不存在子 Agent）。
 */
export function createAgent(
  db: Db,
  input: {
    feishuOpenId: string;
    feishuName: string | null;
    name: string;
    runtime: AgentRuntime;
    deviceId?: string | null;
    cwd?: string | null;
    description?: string | null;
  },
): Agent {
  const now = nowIso();
  const id = newId('agt');
  const name = uniqueName(db, input.feishuOpenId, input.name);
  db.prepare(
    `INSERT INTO agents (id, feishu_open_id, feishu_name, name, runtime, status, is_primary, device_id, cwd, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.feishuOpenId,
    input.feishuName,
    name,
    input.runtime,
    1,
    input.deviceId ?? null,
    input.cwd ?? null,
    input.description ?? null,
    now,
    now,
  );
  return {
    id,
    feishuOpenId: input.feishuOpenId,
    feishuName: input.feishuName,
    name,
    runtime: input.runtime,
    status: 'active',
    isPrimary: true,
    deviceId: input.deviceId ?? null,
    cwd: input.cwd ?? null,
    description: input.description ?? null,
    feishuAvatarUrl: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** 修改 Agent 的名称 / 状态 / 工作目录 / 说明。 */
export function updateAgent(
  db: Db,
  id: string,
  patch: {
    name?: string;
    status?: AgentStatus;
    cwd?: string;
    description?: string | null;
    deviceId?: string | null;
    feishuName?: string | null;
    feishuAvatarUrl?: string | null;
  },
): void {
  const fields: string[] = [];
  const values: Array<string | null> = [];
  if (patch.name !== undefined) {
    fields.push('name = ?');
    values.push(patch.name);
  }
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (patch.cwd !== undefined) {
    fields.push('cwd = ?');
    values.push(patch.cwd);
  }
  if (patch.description !== undefined) {
    fields.push('description = ?');
    values.push(patch.description);
  }
  if (patch.deviceId !== undefined) {
    fields.push('device_id = ?');
    values.push(patch.deviceId);
  }
  if (patch.feishuName !== undefined) {
    fields.push('feishu_name = ?');
    values.push(patch.feishuName);
  }
  if (patch.feishuAvatarUrl !== undefined) {
    fields.push('feishu_avatar = ?');
    values.push(patch.feishuAvatarUrl);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(nowIso());
  values.push(id);
  db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/** 删除主 Agent 的结果，返回被清理的关联数据量。 */
export interface DeleteAgentResult {
  /** 被撤销令牌的设备数 */
  devices: number;
  /** 删除的会话数（旧会话上下文作废，重新绑定后开启新会话） */
  conversations: number;
  /** 清理的绑定码数 */
  enrollCodes: number;
}

/**
 * 删除主 Agent（数字员工）。
 *
 * 与「禁用」的区别：禁用保留身份与设备归属，随时可恢复；
 * 删除是把这个飞书人从平台移除，设备归属一起清掉，之后任何人都能在这台机器上重新 `login`。
 *
 * 有意保留的：
 * - `runs` / `steps`：历史任务与 trace 用于追责，后台仍能看到（显示为「已删除的 Agent」）
 * - 员工机器上的工作目录：平台从不碰本机文件系统
 */
export function deleteAgentAccount(db: Db, id: string): DeleteAgentResult {
  const deviceIds = (db.prepare('SELECT id FROM devices WHERE agent_id = ?').all(id) as unknown as Array<{ id: string }>).map(
    (row) => row.id,
  );
  db.exec('BEGIN');
  try {
    const devices = Number(
      db
        .prepare("UPDATE devices SET status = 'revoked', token_hash = NULL, agent_id = NULL, bridge_state = NULL WHERE agent_id = ?")
        .run(id).changes,
    );
    // 该设备的未使用绑定码一起清掉，避免删完还能用旧码绑回来
    const enrollCodes =
      deviceIds.length > 0
        ? Number(
            db
              .prepare(`DELETE FROM enroll_codes WHERE device_id IN (${deviceIds.map(() => '?').join(', ')})`)
              .run(...deviceIds).changes,
          )
        : 0;
    const conversations = Number(db.prepare('DELETE FROM conversations WHERE agent_id = ?').run(id).changes);
    db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    db.exec('COMMIT');
    return { devices, conversations, enrollCodes };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 统计主 Agent（数字员工）总数与各运行时分布。子 Agent 是本地工作区，不计入人头。 */
export function countAgents(db: Db): { total: number; online: number; byRuntime: Array<{ runtime: AgentRuntime; agents: number }> } {
  const total = Number((db.prepare('SELECT COUNT(*) AS c FROM agents WHERE is_primary = 1').get() as { c: number }).c);
  const byRuntime = db
    .prepare('SELECT runtime, COUNT(*) AS agents FROM agents WHERE is_primary = 1 GROUP BY runtime')
    .all() as unknown as Array<{ runtime: AgentRuntime; agents: number }>;
  return { total, online: 0, byRuntime };
}
