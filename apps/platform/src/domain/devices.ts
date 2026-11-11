import type { AgentRuntime, BridgeState, DeviceStatus } from '@staff-agent/shared';
import type { Db } from '../db/client.js';
import { newId, nowIso } from '../util/ids.js';

/** devices 表行结构。 */
export interface DeviceRow {
  id: string;
  agent_id: string | null;
  machine_id: string;
  machine_name: string;
  runtime: AgentRuntime;
  runtime_version: string | null;
  bridge_version: string | null;
  token_hash: string | null;
  status: DeviceStatus;
  bridge_state: BridgeState | null;
  last_seen_at: string | null;
  created_at: string;
}

/** 对外暴露的设备实体。 */
export interface Device {
  id: string;
  agentId: string | null;
  machineId: string;
  machineName: string;
  runtime: AgentRuntime;
  runtimeVersion: string | null;
  bridgeVersion: string | null;
  status: DeviceStatus;
  bridgeState: BridgeState | null;
  lastSeenAt: string | null;
  createdAt: string;
}

/** 行转实体。 */
function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    agentId: row.agent_id,
    machineId: row.machine_id,
    machineName: row.machine_name,
    runtime: row.runtime,
    runtimeVersion: row.runtime_version,
    bridgeVersion: row.bridge_version,
    status: row.status,
    bridgeState: row.bridge_state,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

/**
 * 注册设备：同一台机器重复 login 时复用记录并刷新运行时信息，避免产生僵尸设备。
 */
export function upsertDevice(
  db: Db,
  input: {
    machineId: string;
    machineName: string;
    runtime: AgentRuntime;
    runtimeVersion?: string | null;
    bridgeVersion?: string | null;
  },
): Device {
  const existing = db
    .prepare('SELECT * FROM devices WHERE machine_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1')
    .get(input.machineId, 'active') as unknown as DeviceRow | undefined;
  if (existing) {
    db.prepare(
      `UPDATE devices SET machine_name = ?, runtime = ?, runtime_version = ?, bridge_version = ? WHERE id = ?`,
    ).run(input.machineName, input.runtime, input.runtimeVersion ?? null, input.bridgeVersion ?? null, existing.id);
    return {
      ...toDevice(existing),
      machineName: input.machineName,
      runtime: input.runtime,
      runtimeVersion: input.runtimeVersion ?? null,
      bridgeVersion: input.bridgeVersion ?? null,
    };
  }
  const id = newId('dev');
  const now = nowIso();
  db.prepare(
    `INSERT INTO devices (id, agent_id, machine_id, machine_name, runtime, runtime_version, bridge_version, token_hash, status, bridge_state, last_seen_at, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, 'active', NULL, NULL, ?)`,
  ).run(id, input.machineId, input.machineName, input.runtime, input.runtimeVersion ?? null, input.bridgeVersion ?? null, now);
  return {
    id,
    agentId: null,
    machineId: input.machineId,
    machineName: input.machineName,
    runtime: input.runtime,
    runtimeVersion: input.runtimeVersion ?? null,
    bridgeVersion: input.bridgeVersion ?? null,
    status: 'active',
    bridgeState: null,
    lastSeenAt: null,
    createdAt: now,
  };
}

/** 通过设备令牌哈希查询设备（长轮询鉴权入口）。 */
export function findDeviceByTokenHash(db: Db, tokenHash: string): Device | null {
  const row = db
    .prepare('SELECT * FROM devices WHERE token_hash = ? AND status = ?')
    .get(tokenHash, 'active') as unknown as DeviceRow | undefined;
  return row ? toDevice(row) : null;
}

/** 通过 ID 查询设备。 */
export function findDeviceById(db: Db, id: string): Device | null {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as unknown as DeviceRow | undefined;
  return row ? toDevice(row) : null;
}

/** 查询 Agent 当前绑定的活跃设备（单活：取最近心跳的一台）。 */
export function findActiveDeviceByAgent(db: Db, agentId: string): Device | null {
  const row = db
    .prepare(
      `SELECT * FROM devices WHERE agent_id = ? AND status = 'active'
       ORDER BY COALESCE(last_seen_at, '') DESC LIMIT 1`,
    )
    .get(agentId) as unknown as DeviceRow | undefined;
  return row ? toDevice(row) : null;
}

/** 设备绑定到 Agent（绑定流程成功后调用）。 */
export function bindDeviceToAgent(db: Db, deviceId: string, agentId: string): void {
  db.prepare('UPDATE devices SET agent_id = ?, status = ? WHERE id = ?').run(agentId, 'active', deviceId);
}

/** 写入设备令牌哈希。令牌明文只在绑定响应里出现一次，数据库只存哈希。 */
export function setDeviceToken(db: Db, deviceId: string, tokenHash: string): void {
  db.prepare('UPDATE devices SET token_hash = ? WHERE id = ?').run(tokenHash, deviceId);
}

/** 刷新设备心跳信息（随长轮询上报）。 */
export function touchDevice(
  db: Db,
  deviceId: string,
  input: { bridgeState: BridgeState; runtimeVersion?: string | null; bridgeVersion?: string | null },
): void {
  db.prepare(
    `UPDATE devices SET last_seen_at = ?, bridge_state = ?, runtime_version = COALESCE(?, runtime_version), bridge_version = COALESCE(?, bridge_version) WHERE id = ?`,
  ).run(nowIso(), input.bridgeState, input.runtimeVersion ?? null, input.bridgeVersion ?? null, deviceId);
}

/** 撤销 Agent 下所有设备（换机、离职、强制下线）。 */
export function revokeDevicesByAgent(db: Db, agentId: string): number {
  const result = db
    .prepare("UPDATE devices SET status = 'revoked', token_hash = NULL WHERE agent_id = ? AND status = 'active'")
    .run(agentId);
  return Number(result.changes);
}

/** 列出所有设备，用于管理后台一次性取回，避免 N+1 查询。 */
export function listDevicesByAgentIds(db: Db, agentIds: string[]): Map<string, Device> {
  const map = new Map<string, Device>();
  if (agentIds.length === 0) return map;
  const placeholders = agentIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT * FROM devices WHERE agent_id IN (${placeholders}) AND status = 'active'
       ORDER BY COALESCE(last_seen_at, '') ASC`,
    )
    .all(...agentIds) as unknown as DeviceRow[];
  // 后写覆盖先写，保证留下 last_seen 最新的一台
  for (const row of rows) {
    const device = toDevice(row);
    if (device.agentId) map.set(device.agentId, device);
  }
  return map;
}

/** 撤销同一 Agent 下的其他设备，保证「一个 Agent 同一时刻只有一台机器在线」。 */
export function revokeOtherDevices(db: Db, agentId: string, keepDeviceId: string): number {
  const result = db
    .prepare("UPDATE devices SET status = 'revoked', token_hash = NULL WHERE agent_id = ? AND id <> ? AND status = 'active'")
    .run(agentId, keepDeviceId);
  return Number(result.changes);
}
