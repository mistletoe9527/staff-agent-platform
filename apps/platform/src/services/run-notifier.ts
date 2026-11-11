import type { Db } from '../db/client.js';
import { findAgentById } from '../domain/agents.js';
import { findRunById, type Run } from '../domain/runs.js';
import type { FeishuPort } from '../feishu/client.js';
import { errorText, type Logger } from '../util/logger.js';

/** 把毫秒耗时格式化成「1m23s」。 */
function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return '不足 1s';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h${minutes % 60}m`;
  }
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

/**
 * 任务结束通知：把 Agent 的最终结果回传到发起任务的飞书会话。
 *
 * 优先用「引用回复」挂在原消息下，飞书里能直接看到上下文；
 * 原消息超过 7 天或已被删除时退回普通发送。
 */
export class RunNotifier {
  constructor(
    private readonly db: Db,
    private readonly client: FeishuPort,
    private readonly logger: Logger,
  ) {}

  /**
   * 发送任务终态通知。
   * @param runId 任务 ID：内部重新读取，保证通知内容与库里最终状态一致
   */
  async notifyFinished(runId: string): Promise<void> {
    const run = findRunById(this.db, runId);
    if (!run) {
      this.logger.warn({ runId }, '任务不存在，跳过通知');
      return;
    }
    await this.notifyRun(run);
  }

  /** 按任务实体发送通知。 */
  private async notifyRun(run: Run): Promise<void> {
    const agent = findAgentById(this.db, run.agentId);
    const name = agent?.name ?? 'Agent';
    const duration = formatDuration(run.durationMs);
    const usage =
      run.inputTokens + run.outputTokens > 0
        ? `\n\n用量：输入 ${run.inputTokens} / 输出 ${run.outputTokens} tokens`
        : '';

    let text: string;
    switch (run.status) {
      case 'succeeded':
        text = `✅ ${name} 已完成（${duration}）\n\n${(run.result ?? '').trim() || '（没有输出）'}${usage}`;
        break;
      case 'timeout':
        text = `⏱ ${name} 执行超时（${duration}）\n\n${run.error ?? '已中断'}${usage}`;
        break;
      case 'canceled':
        text = `🚫 ${name} 已取消（${duration}）${usage}`;
        break;
      default:
        text = `❌ ${name} 执行失败（${duration}）\n\n${run.error ?? '未知错误'}${usage}`;
        break;
    }

    try {
      if (run.feishuMessageId) {
        await this.client.replyText(run.feishuMessageId, text);
      } else {
        await this.client.sendText(run.feishuChatId, text);
      }
    } catch (error) {
      this.logger.warn({ err: errorText(error), runId: run.id }, '引用回复失败，改用普通发送');
      try {
        await this.client.sendText(run.feishuChatId, text);
      } catch (sendError) {
        this.logger.error({ err: errorText(sendError), runId: run.id }, '任务结果回传飞书失败');
      }
    }
  }
}
