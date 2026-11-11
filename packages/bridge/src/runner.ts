import type { RunAssignment, StepInput } from '@staff-agent/shared';
import type { PlatformApi } from './api.js';
import type { BridgeConfig } from './config.js';
import { log, errorText } from './log.js';
import { createAdapter } from './runtimes/index.js';
import type { StepEvent } from './runtimes/types.js';

/** 步骤批量上报的触发阈值。 */
const STEP_FLUSH_SIZE = 20;
/** 步骤批量上报的定时阈值（毫秒）。 */
const STEP_FLUSH_MS = 800;

/**
 * 任务执行器：一次只跑一个任务（平台侧同 Agent 也串行）。
 *
 * 职责：
 * - 调对应 runtime adapter
 * - 把事件流切成 trace 步骤，批量上报
 * - 把最终结果 / 用量 / 会话标识回传平台
 * - 超时中断，保证不挂死
 */
export class Runner {
  constructor(
    private readonly api: PlatformApi,
    private readonly config: BridgeConfig,
  ) {}

  /** 执行一个已认领的任务。 */
  async execute(run: RunAssignment): Promise<void> {
    const startedAt = Date.now();
    const adapter = createAdapter(this.config.runtime);
    log('info', '开始执行任务', { runId: run.runId, runtime: this.config.runtime });

    // 先 ack：平台据此把状态推进到 running，并刷新租约
    try {
      await this.api.ack(run.runId, run.leaseId);
    } catch (error) {
      log('warn', '任务认领失败，跳过执行', { runId: run.runId, error: errorText(error) });
      return;
    }

    let seq = 0;
    const buffer: StepInput[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    let flushing = false;

    const flush = async (): Promise<void> => {
      if (flushing || buffer.length === 0) return;
      flushing = true;
      const batch = buffer.splice(0, buffer.length);
      try {
        await this.api.steps(run.runId, run.leaseId, batch);
      } catch (error) {
        log('warn', 'trace 步骤上报失败', { runId: run.runId, error: errorText(error) });
      } finally {
        flushing = false;
      }
    };

    const scheduleFlush = (): void => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flush();
      }, STEP_FLUSH_MS);
      flushTimer.unref();
    };

    const onStep = (step: StepEvent): void => {
      buffer.push({
        seq: seq++,
        type: step.type,
        name: step.name,
        inputSummary: step.inputSummary,
        outputSummary: step.outputSummary,
        durationMs: step.durationMs,
        inputTokens: step.inputTokens,
        outputTokens: step.outputTokens,
        isError: step.isError,
      });
      if (buffer.length >= STEP_FLUSH_SIZE) {
        void flush();
      } else {
        scheduleFlush();
      }
    };

    const controller = new AbortController();
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, run.timeoutSec * 1000);
    timeoutTimer.unref();

    try {
      const outcome = await adapter.run({
        prompt: run.prompt,
        cwd: run.cwd ?? this.config.cwd,
        sessionRef: run.sessionRef,
        timeoutMs: run.timeoutSec * 1000,
        signal: controller.signal,
        onStep,
      });
      if (timedOut) {
        controller.abort();
      }
      if (flushTimer) clearTimeout(flushTimer);
      await flush();

      const status = timedOut ? 'timeout' : outcome.ok ? 'succeeded' : 'failed';
      await this.api.report(run.runId, {
        leaseId: run.leaseId,
        status,
        result: outcome.result.slice(0, 60_000),
        error: outcome.ok ? undefined : outcome.error?.slice(0, 4_000),
        durationMs: Date.now() - startedAt,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        sessionRef: outcome.sessionRef || null,
      });
      log('info', '任务结束', {
        runId: run.runId,
        status,
        durationMs: Date.now() - startedAt,
        steps: seq,
      });
    } catch (error) {
      if (flushTimer) clearTimeout(flushTimer);
      void flush();
      const message = errorText(error);
      log('error', '任务执行异常', { runId: run.runId, error: message });
      try {
        await this.api.report(run.runId, {
          leaseId: run.leaseId,
          status: timedOut ? 'timeout' : 'failed',
          error: message.slice(0, 4_000),
          durationMs: Date.now() - startedAt,
        });
      } catch (reportError) {
        log('error', '任务失败状态上报失败', { runId: run.runId, error: errorText(reportError) });
      }
    } finally {
      clearTimeout(timeoutTimer);
    }
  }
}
