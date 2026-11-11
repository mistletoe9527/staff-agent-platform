import type { PollResponse } from '@staff-agent/shared';
import { PlatformApi, PlatformError, isRunAssignment } from './api.js';
import type { ConfigHandle } from './config.js';
import { Runner } from './runner.js';
import { log, errorText } from './log.js';
import { createAdapter } from './runtimes/index.js';

/** 网关版本，随包发布。 */
export const BRIDGE_VERSION = '0.1.0';

/**
 * 长轮询主循环。
 *
 * 关键设计：轮询与执行并行。
 * 平台侧同一 Agent 串行（有 running 时不发新任务），所以并行轮询不会导致并发执行，
 * 但能保证「任务执行 30 分钟」期间心跳不断，管理员看到的永远是在线。
 */
export class Poller {
  private active = 0;
  private runtimeVersion: string | undefined;
  private stopping = false;

  constructor(
    private readonly api: PlatformApi,
    private readonly config: ConfigHandle,
  ) {}

  /** 启动主循环，直到 signal 中断。 */
  async run(signal: AbortSignal): Promise<void> {
    const initial = this.config.get();
    const adapter = createAdapter(initial.runtime);
    const check = await adapter.check();
    if (check.ok) {
      this.runtimeVersion = check.version;
      log('info', '运行时可用', { runtime: initial.runtime, version: check.version });
    } else {
      log('error', '本机未找到可用的运行时，任务会失败', {
        runtime: initial.runtime,
        detail: check.detail,
      });
    }
    log('info', '网关已连接平台，开始接收任务', {
      platform: initial.platformUrl,
      agent: initial.agentName,
      cwd: initial.cwd,
      workspaces: initial.workspaces.length,
      bridge: BRIDGE_VERSION,
    });

    const runner = new Runner(this.api, this.config);
    let backoffMs = 1_000;

    while (!signal.aborted && !this.stopping) {
      try {
        // 每次轮询取最新配置：工作区在另一个进程里增删，重启不应该是生效前提
        const config = this.config.get();
        const response: PollResponse = await this.api.poll(
          {
            state: this.active > 0 ? 'busy' : 'idle',
            activeRuns: this.active,
            runtimeVersion: this.runtimeVersion,
            bridgeVersion: BRIDGE_VERSION,
            // 主工作区只报上去展示；子工作区（#名字）完全留在本机
            cwd: config.cwd,
            description: config.description ?? null,
          },
          signal,
        );
        backoffMs = 1_000;
        if (!response.run) continue;
        if (!isRunAssignment(response.run)) {
          log('warn', '收到格式不正确的任务，已忽略');
          continue;
        }
        const assignment = response.run;
        this.active += 1;
        void runner
          .execute(assignment)
          .catch((error: unknown) => {
            log('error', '任务执行未捕获异常', { runId: assignment.runId, error: errorText(error) });
          })
          .finally(() => {
            this.active = Math.max(0, this.active - 1);
          });
      } catch (error) {
        if (signal.aborted || this.stopping) break;
        if (error instanceof PlatformError && error.status === 401) {
          log('error', '设备令牌已失效，请重新运行 sa login', { reason: error.message });
          process.exitCode = 2;
          break;
        }
        log('warn', '长轮询失败，稍后重试', { error: errorText(error), backoffMs });
        await sleep(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
    // 等待正在执行的任务收尾
    while (this.active > 0) {
      await sleep(500, signal);
    }
    log('info', '网关已停止');
  }

  /** 请求停止。 */
  stop(): void {
    this.stopping = true;
  }
}

/** 可被 signal 中断的 sleep。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
