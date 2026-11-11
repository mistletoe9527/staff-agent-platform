import type { EnrollPollResponse } from '@staff-agent/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { createAgent, findAgentById, findAgentByOpenId, updateAgent } from '../domain/agents.js';
import { bindDeviceToAgent, findDeviceById, revokeOtherDevices, setDeviceToken, type Device } from '../domain/devices.js';
import { consumeEnrollCode, findEnrollRecord, setPendingToken, takePendingToken, type EnrollRecord } from '../domain/enroll.js';
import type { FeishuPort, IncomingMessage } from '../feishu/client.js';
import { syncAgentProfileSafely } from './identity-service.js';
import { newToken } from '../util/ids.js';
import { sha256 } from '../util/hash.js';
import { errorText, type Logger } from '../util/logger.js';

/** 绑定结果。两条入口（飞书发码 / 扫码 OAuth）共用。 */
export interface BindOutcome {
  ok: boolean;
  /** 面向用户的说明文案 */
  message: string;
  /** 绑定成功时的 Agent 名称 */
  agentName?: string;
}

/** 校验通过后的绑定上下文。 */
interface BindContext {
  record: EnrollRecord;
  device: Device;
}

/**
 * 绑定服务：把「一台机器上的 Agent」和「一个飞书人」一对一绑起来。
 *
 * 三条入口共用同一套校验与落库：
 * - 飞书里发 6 位码
 * - 手机扫二维码（配置了飞书网页授权时）
 * - 管理员在后台生成绑定码交给员工
 */
export class EnrollService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly client: FeishuPort,
    private readonly logger: Logger,
  ) {}

  /**
   * 前置校验：绑定码是否存在、是否可用、机器是否已归属别人。
   * @returns 通过时返回上下文，否则返回失败原因
   */
  private check(code: string, openId: string): { ok: true; context: BindContext } | { ok: false; message: string } {
    const record = findEnrollRecord(this.db, code, this.config.sessionSecret);
    if (!record) {
      return { ok: false, message: '绑定码无效。请在电脑上重新运行 sa login 生成新的绑定码。' };
    }
    if (record.consumedAt) {
      return { ok: false, message: '这个绑定码已经用过了。如果电脑端没有拿到凭据，请重新运行 sa login。' };
    }
    if (new Date(record.expiresAt).getTime() < Date.now()) {
      return { ok: false, message: '绑定码已过期（有效期 5 分钟）。请重新运行 sa login。' };
    }
    const device = findDeviceById(this.db, record.deviceId);
    if (!device || device.status !== 'active') {
      return { ok: false, message: '设备记录已失效。请重新运行 sa login。' };
    }
    const existing = findAgentByOpenId(this.db, openId);
    if (existing && existing.status === 'disabled') {
      return { ok: false, message: '你的 Agent 已被管理员禁用，请联系管理员。' };
    }
    if (device.agentId && (!existing || device.agentId !== existing.id)) {
      return { ok: false, message: '这台电脑已经绑定了其他 Agent，请联系管理员先解绑，再重新绑定。' };
    }
    return { ok: true, context: { record, device } };
  }

  /** 落库：创建或复用 Agent，绑定设备，签发一次性设备令牌。 */
  private finalize(context: BindContext, openId: string): { agentId: string; agentName: string } {
    const { record, device } = context;
    const existing = findAgentByOpenId(this.db, openId);
    let agentId: string;
    let agentName: string;
    if (existing) {
      agentId = existing.id;
      agentName = existing.name;
      bindDeviceToAgent(this.db, device.id, existing.id);
      // 迁移后的老数据 device_id 为空，这里顺手补齐
      updateAgent(this.db, existing.id, { deviceId: device.id });
    } else {
      // 姓名在调用方补齐（飞书通讯录需要异步查询），这里只做落库。
      // 主 Agent 由绑定流程创建，工作目录与说明稍后由客户端上报。
      const name = `agent-${openId.slice(-4)}`;
      const agent = createAgent(this.db, {
        feishuOpenId: openId,
        feishuName: null,
        name,
        runtime: device.runtime,
        deviceId: device.id,
      });
      agentId = agent.id;
      agentName = agent.name;
      bindDeviceToAgent(this.db, device.id, agent.id);
    }
    // 单活：同一 Agent 换机器时把旧设备踢下线
    const revoked = revokeOtherDevices(this.db, agentId, device.id);
    const token = newToken(32);
    setDeviceToken(this.db, device.id, sha256(token));
    consumeEnrollCode(this.db, record.codeHash);
    setPendingToken(this.db, record.codeHash, token);
    this.logger.info({ agentId, deviceId: device.id, revoked }, 'Agent 绑定成功');
    return { agentId, agentName };
  }

  /**
   * 绑定后补齐飞书姓名与头像。
   * 已绑定过的人也重新拉一次：管理员刚开通通讯录权限时，重登就能把名字头像补上。
   */
  private async finalizeWithProfile(
    context: BindContext,
    openId: string,
  ): Promise<{ agentId: string; agentName: string }> {
    const result = this.finalize(context, openId);
    await syncAgentProfileSafely(this.db, this.client, result.agentId, this.logger);
    const agent = findAgentById(this.db, result.agentId);
    return { agentId: result.agentId, agentName: agent?.name ?? result.agentName };
  }

  /**
   * 处理飞书里的 6 位绑定码消息。
   * @returns false 表示不是绑定码，交给任务派发流程
   */
  async handleCodeMessage(message: IncomingMessage): Promise<boolean> {
    if (message.messageType !== 'text') return false;
    // 飞书把 @ 渲染成 @_user_1 这类占位符，去掉后再判断，否则「@机器人 123456」识别不出来
    const code = message.text.replace(/@_user_\d+/g, ' ').replace(/@_all/g, ' ').trim();
    if (!/^\d{6}$/.test(code)) return false;
    // 群聊里必须 @机器人，避免群里其他人随手发的 6 位数字把码绑走
    if (message.chatType === 'group' && !message.mentionedBot) return false;

    this.logger.info(
      { messageId: message.messageId, chatType: message.chatType },
      '收到绑定码消息，开始绑定',
    );
    const outcome = await this.bindByCode(code, message.senderOpenId);
    await this.client.replyText(message.messageId, outcome.message);
    return true;
  }

  /**
   * 用绑定码完成绑定（飞书发码与扫码共用）。
   * @param code 6 位绑定码
   * @param openId 飞书 open_id
   */
  async bindByCode(code: string, openId: string): Promise<BindOutcome> {
    try {
      const checked = this.check(code, openId);
      if (!checked.ok) return { ok: false, message: checked.message };
      const result = await this.finalizeWithProfile(checked.context, openId);
      return {
        ok: true,
        agentName: result.agentName,
        message: `✅ 绑定成功\nAgent：${result.agentName}\n运行时：${checked.context.device.runtime}\n机器：${checked.context.device.machineName}\n\n电脑端会自动完成登录，之后在飞书里 @机器人 发任务即可。`,
      };
    } catch (error) {
      this.logger.error({ err: errorText(error) }, '绑定流程失败');
      return { ok: false, message: '绑定失败，请稍后重试；反复失败请联系管理员。' };
    }
  }

  /** 本机轮询绑定结果。绑定成功后一次性下发设备令牌。 */
  poll(code: string): EnrollPollResponse {
    const record = findEnrollRecord(this.db, code, this.config.sessionSecret);
    if (!record) {
      return { state: 'expired', deviceToken: null, agentId: null, agentName: null };
    }
    const device = findDeviceById(this.db, record.deviceId);
    if (record.consumedAt && device?.agentId) {
      const token = takePendingToken(this.db, record.codeHash);
      const agent = findAgentById(this.db, device.agentId);
      return {
        state: 'bound',
        deviceToken: token,
        agentId: device.agentId,
        agentName: agent?.name ?? null,
      };
    }
    if (new Date(record.expiresAt).getTime() < Date.now()) {
      return { state: 'expired', deviceToken: null, agentId: null, agentName: null };
    }
    return { state: 'pending', deviceToken: null, agentId: null, agentName: null };
  }
}
