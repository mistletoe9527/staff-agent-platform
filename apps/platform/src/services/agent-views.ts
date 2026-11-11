import type { AgentStatus, AgentView } from '@staff-agent/shared';
import type { Db } from '../db/client.js';
import type { AgentRow } from '../domain/agents.js';
import { listDevicesByAgentIds } from '../domain/devices.js';
import { countRunsByAgentIds } from '../domain/runs.js';

/** 列表查询条件。 */
export interface AgentListFilter {
  q?: string;
  status?: AgentStatus;
  onlineWindowSec: number;
}

/**
 * 组装管理后台的 Agent 视图。
 * 设备与 7 日统计都批量取回后内存合并，避免每个 Agent 两次查询（N+1）。
 * 只返回主 Agent：子 Agent 只是员工本机的工作区，不进后台。
 */
export function listAgentViews(db: Db, filter: AgentListFilter): AgentView[] {
  const where: string[] = [];
  const params: Array<string> = [];
  if (filter.q) {
    where.push('(name LIKE ? OR feishu_open_id LIKE ? OR feishu_name LIKE ? OR description LIKE ? OR cwd LIKE ?)');
    const like = `%${filter.q}%`;
    params.push(like, like, like, like, like);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  // 平台只展示「数字员工」= 主 Agent；子 Agent 是员工本机的工作区，不属于管理后台视角
  where.push('is_primary = 1');
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM agents ${clause} ORDER BY created_at DESC`)
    .all(...params) as unknown as AgentRow[];

  const agentIds = rows.map((row) => row.id);
  const devices = listDevicesByAgentIds(db, agentIds);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const counts = countRunsByAgentIds(db, agentIds, since7d);
  const onlineBefore = new Date(Date.now() - filter.onlineWindowSec * 1000).toISOString();

  return rows.map((row) => {
    const device = devices.get(row.id) ?? null;
    const count = counts.get(row.id) ?? { runs: 0, succeeded: 0 };
    return {
      id: row.id,
      name: row.name,
      feishuOpenId: row.feishu_open_id,
      feishuName: row.feishu_name,
      feishuAvatarUrl: row.feishu_avatar ?? null,
      runtime: row.runtime,
      status: row.status,
      isPrimary: row.is_primary === 1,
      cwd: row.cwd,
      description: row.description,
      createdAt: row.created_at,
      device: device
        ? {
            id: device.id,
            machineName: device.machineName,
            runtimeVersion: device.runtimeVersion,
            lastSeenAt: device.lastSeenAt,
            online: Boolean(device.lastSeenAt && device.lastSeenAt >= onlineBefore),
            bridgeState: device.bridgeState,
          }
        : null,
      runs7d: count.runs,
      success7d: count.succeeded,
    };
  });
}
