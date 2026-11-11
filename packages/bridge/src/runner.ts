import { mkdirSync, existsSync } from 'node:fs';
import type { RunAssignment, StepInput } from '@staff-agent/shared';
import type { PlatformApi } from './api.js';
import type { BridgeConfig, ConfigHandle } from './config.js';
import { log, errorText } from './log.js';
import { composePrompt, findWorkspace, parseAgentCommand, renderWorkspaceList } from './routing.js';
import { createAdapter } from './runtimes/index.js';
import type { StepEvent } from './runtimes/types.js';
import { prettyPath } from './workspaces.js';

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
    private readonly config: ConfigHandle,
  ) {}

  /** 执行一个已认领的任务。 */
  async execute(run: RunAssignment): Promise<void> {
    const startedAt = Date.now();
    // 每个任务都取一次最新配置：`agents add/update/remove` 只改 config.json，
    // 用启动时的快照会把任务路由到旧工作区（新工作区得重启网关才生效）
    const config: BridgeConfig = this.config.get();
    const adapter = createAdapter(config.runtime);
    // 工作区路由完全在本机：平台把飞书原文原样下发，这里解析 #名字 / #列表
    const command = parseAgentCommand(run.prompt);
    log('info', '开始执行任务', {
      runId: run.runId,
      runtime: config.runtime,
      command: command.kind,
      workspaces: config.workspaces.length,
    });

    // 先 ack：平台据此把状态推进到 running，并刷新租约
    try {
      await this.api.ack(run.runId, run.leaseId);
    } catch (error) {
      log('warn', '任务认领失败，跳过执行', { runId: run.runId, error: errorText(error) });
      return;
    }

    // `#列表` 本地就能答，不花模型 token，也不占执行时间
    if (command.kind === 'list') {
      const text = renderWorkspaceList(config.cwd, config.agentName, config.workspaces);
      await this.api.report(run.runId, {
        leaseId: run.leaseId,
        status: 'succeeded',
        result: text,
        durationMs: Date.now() - startedAt,
        cwd: config.cwd,
      });
      log('info', '已本地回复工作区列表', { runId: run.runId, workspaces: config.workspaces.length });
      return;
    }

    const selected = command.kind === 'workspace' ? findWorkspace(config.workspaces, command.name) : null;
    if (command.kind === 'workspace' && !command.prompt) {
      // 只发了 `#名字`：本机直接提示，不必叫醒模型
      const hint = selected
        ? `请在「${selected.name}」后面写上要做什么，例如：#${selected.name} 帮我跑一下测试。`
        : `没有找到叫「${command.name}」的工作区。发 #列表 看本机有哪些工作区。`;
      await this.api.report(run.runId, {
        leaseId: run.leaseId,
        status: 'succeeded',
        result: hint,
        durationMs: Date.now() - startedAt,
        cwd: config.cwd,
      });
      log('info', '已本地回复工作区提示', { runId: run.runId, name: command.name });
      return;
    }
    if (command.kind === 'workspace' && !selected) {
      // 名字打错时不要静默换目录，明确提示后交给主 Agent 自己判断
      log('warn', '指定的工作区不存在，按主工作区执行', { runId: run.runId, name: command.name });
    }
    const userPrompt = command.kind === 'workspace' ? command.prompt : run.prompt;
    const prompt = composePrompt({
      prompt: userPrompt,
      mainName: config.agentName,
      mainCwd: config.cwd,
      workspaces: config.workspaces,
      selected,
    });

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

    // 本地工作区优先；平台下发的 cwd 只作为老版本兜底
    const cwd = ensureCwd(selected?.cwd ?? run.cwd ?? config.cwd);

    try {
      const outcome = await adapter.run({
        prompt,
        cwd,
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
        cwd,
      });
      log('info', '任务结束', {
        runId: run.runId,
        status,
        workspace: selected?.name ?? 'main',
        cwd: prettyPath(cwd),
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

/**
 * 确保任务工作目录存在。
 *
 * 配置里的 cwd 常是登录时随手填的路径，目录不存在时 spawn 会直接报 ENOENT（且曾以未捕获事件打挂网关）。
 * 缺失时按 mkdir -p 语义补齐，创建失败则交给 planSpawn 给出可读错误。
 */
function ensureCwd(dir: string): string {
  if (existsSync(dir)) return dir;
  try {
    mkdirSync(dir, { recursive: true });
    log('warn', '任务工作目录不存在，已自动创建', { cwd: dir });
  } catch (error) {
    log('warn', '任务工作目录创建失败', { cwd: dir, error: errorText(error) });
  }
  return dir;
}
