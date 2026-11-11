import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { findAgentByOpenId } from '../domain/agents.js';
import { findActiveDeviceByAgent } from '../domain/devices.js';
import { upsertConversation } from '../domain/conversations.js';
import { countQueuedRuns, createRun, hasRunningRun } from '../domain/runs.js';
import type { FeishuPort, IncomingMessage } from '../feishu/client.js';
import type { Inbox } from './inbox.js';
import { errorText, type Logger } from '../util/logger.js';

/**
 * 任务派发：把飞书消息翻译成 Agent 任务。
 *
 * 路由规则：
 * - 私聊：消息发给机器人主人自己的 Agent
 * - 群聊：必须 @机器人 + @某个人，任务投给被 @ 的那个人的 Agent
 * - 只 @机器人 不 @人：提示补充，不猜默认执行者
 */
export class DispatchService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly client: FeishuPort,
    private readonly inbox: Inbox,
    private readonly logger: Logger,
  ) {}

  /** 处理一条非绑定码消息。 */
  async handle(message: IncomingMessage): Promise<void> {
    if (message.messageType !== 'text') {
      await this.client.replyText(message.messageId, '目前只支持文本指令。');
      return;
    }
    const prompt = message.text.replace(/@_user_\d+/g, '').replace(/@_all/g, '').trim();
    if (!prompt) {
      await this.client.replyText(message.messageId, '指令内容为空。');
      return;
    }

    const isGroup = message.chatType === 'group';
    if (isGroup && !message.mentionedBot) {
      // 群聊里没有 @机器人 的消息不对用户可见，静默忽略
      return;
    }

    let targetOpenId = message.senderOpenId;
    if (isGroup) {
      if (message.mentionedOpenIds.length === 0) {
        await this.client.replyText(
          message.messageId,
          '请同时 @ 你要指派的同事，例如：@机器人 @张三 帮我看下这个报错。',
        );
        return;
      }
      targetOpenId = message.mentionedOpenIds[0] as string;
      if (message.mentionedOpenIds.length > 1) {
        await this.client.replyText(
          message.messageId,
          '一次只支持指派给一个人，已按第一个被 @ 的人执行。',
        );
      }
    }

    const agent = findAgentByOpenId(this.db, targetOpenId);
    if (!agent) {
      await this.client.replyText(
        message.messageId,
        isGroup
          ? '这个人还没有绑定 Agent。请对方在自己的电脑上运行 staff-agent login 完成绑定。'
          : '你还没有绑定 Agent。请在电脑上运行 staff-agent login 完成绑定。',
      );
      return;
    }
    if (agent.status === 'disabled') {
      await this.client.replyText(message.messageId, '该 Agent 已被管理员禁用。');
      return;
    }

    const device = findActiveDeviceByAgent(this.db, agent.id);
    if (!device) {
      await this.client.replyText(message.messageId, '该 Agent 还没有绑定设备，无法执行任务。');
      return;
    }

    const conversation = upsertConversation(this.db, {
      agentId: agent.id,
      feishuChatId: message.chatId,
      feishuChatType: message.chatType,
      feishuThreadId: message.threadId,
    });
    const run = createRun(this.db, {
      agentId: agent.id,
      deviceId: device.id,
      conversationId: conversation.id,
      prompt,
      feishuChatId: message.chatId,
      feishuMessageId: message.messageId,
      createdByOpenId: message.senderOpenId,
      sessionRef: conversation.sessionRef,
    });
    this.inbox.notify(agent.id);

    const busy = hasRunningRun(this.db, agent.id);
    const queued = countQueuedRuns(this.db, agent.id);
    const onlineBefore = new Date(Date.now() - this.config.ONLINE_WINDOW_SEC * 1000).toISOString();
    const online = Boolean(device.lastSeenAt && device.lastSeenAt >= onlineBefore);

    if (!online) {
      await this.client.replyText(
        message.messageId,
        `已排队（任务 ${run.id}）。${agent.name} 的机器当前离线，联网后会自动执行。`,
      );
      return;
    }
    await this.client.replyText(
      message.messageId,
      busy
        ? `已排队（任务 ${run.id}，前面还有 ${Math.max(queued - 1, 0)} 个）。执行完会在这里回复结果。`
        : `已收到（任务 ${run.id}），${agent.name} 开始执行，完成后会在这里回复。`,
    );
    this.logger.info({ runId: run.id, agentId: agent.id }, '任务已入队');
  }

  /** 包一层错误处理，任何派发异常都要回一条可读提示。 */
  async handleSafely(message: IncomingMessage): Promise<void> {
    try {
      await this.handle(message);
    } catch (error) {
      this.logger.error({ err: errorText(error), messageId: message.messageId }, '任务派发失败');
      await this.client.replyText(message.messageId, '派发任务失败，请稍后重试。').catch((replyError: unknown) => {
        this.logger.error({ err: errorText(replyError) }, '失败提示发送失败');
      });
    }
  }
}
