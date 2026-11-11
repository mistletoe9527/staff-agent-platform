import type { Db } from '../db/client.js';
import { findAgentById, updateAgent, type Agent } from '../domain/agents.js';
import type { FeishuApiError, FeishuPort } from '../feishu/client.js';
import { errorText, type Logger } from '../util/logger.js';

/** 同步结果：拿到的 agent + 失败时飞书给的原因（成功为 null）。 */
export interface ProfileSyncResult {
  agent: Agent;
  /** 拿不到身份时的飞书错误；用户存在但没姓名/头像时为 null */
  error: FeishuApiError | null;
}

/**
 * 把飞书里的姓名 / 头像同步到平台。
 *
 * 平台的展示单位是「数字员工」= 一台机器上的主 Agent，管理员要能认出这是谁，
 * 所以绑定成功后立刻拉一次通讯录；后续管理员也可以在后台手动「同步身份」。
 *
 * 缺 `contact:contact.base:readonly` 权限时飞书会报错，这里只降级（保留 agent-xxxx + 首字母占位），
 * 不影响登录和任务执行；但要把飞书的错误码/建议带回去，否则权限问题无从排查。
 */
export async function syncAgentProfile(
  db: Db,
  feishu: FeishuPort,
  agentId: string,
  logger: Logger,
): Promise<ProfileSyncResult | null> {
  const agent = findAgentById(db, agentId);
  if (!agent) return null;
  const { profile, error } = await feishu.getProfile(agent.feishuOpenId);
  if (!profile) {
    if (error) logger.warn({ agentId: agent.id, feishuCode: error.code, hint: error.hint }, '没有拿到飞书身份');
    return { agent, error };
  }

  const patch: { feishuName?: string | null; feishuAvatarUrl?: string | null; name?: string } = {};
  if (profile.name) {
    patch.feishuName = profile.name;
    // 主 Agent 的显示名直接跟着飞书姓名走；子 Agent（工作区）的名字是用户起的，不动
    if (agent.isPrimary) patch.name = profile.name;
  }
  if (profile.avatarUrl) patch.feishuAvatarUrl = profile.avatarUrl;
  if (Object.keys(patch).length === 0) return { agent, error: null };

  updateAgent(db, agent.id, patch);
  logger.info(
    { agentId: agent.id, name: patch.name ?? agent.name, hasAvatar: Boolean(profile.avatarUrl) },
    '飞书身份已同步',
  );
  const updated = findAgentById(db, agent.id);
  return updated ? { agent: updated, error: null } : null;
}

/** 同步失败不阻断主流程（绑定 / 后台操作都适用）。 */
export async function syncAgentProfileSafely(
  db: Db,
  feishu: FeishuPort,
  agentId: string,
  logger: Logger,
): Promise<void> {
  try {
    await syncAgentProfile(db, feishu, agentId, logger);
  } catch (error) {
    logger.warn({ err: errorText(error), agentId }, '同步飞书身份失败');
  }
}
