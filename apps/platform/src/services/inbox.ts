import type { Db } from '../db/client.js';
import { claimNextRun, type Run } from '../domain/runs.js';

/** 等待者：某个 Agent 有新任务时立即唤醒对应的长轮询请求。 */
interface Waiter {
  agentId: string;
  resolve: () => void;
}

/**
 * 任务投递箱。
 * 长轮询靠「事件唤醒 + 定时兜底」两条腿：入队即唤醒，网络抖动或进程重启后靠 3 秒兜底复查。
 * 不使用轮询查库的方式唤醒，避免 500 个 Agent 带来每秒上千次空查询。
 */
export class Inbox {
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly db: Db) {}

  /** 有新任务入队时调用，唤醒该 Agent 挂起的长轮询（等待者可能订阅多个 Agent）。 */
  notify(agentId: string): void {
    for (const waiter of this.waiters) {
      const ids = waiter.agentId.split(',');
      if (ids.length > 1 ? !ids.includes(agentId) : waiter.agentId !== agentId) continue;
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  }

  /** 唤醒所有等待者（例如进程刚启动，需要重新检查队列）。 */
  notifyAll(): void {
    for (const waiter of this.waiters) {
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  }

  /**
   * 等待任务或超时。
   * @param agentIds 该设备上的 Agent 集合，任一有任务即唤醒
   * @param ms 最长等待毫秒
   */
  private waitFor(agentIds: string[], ms: number): Promise<void> {
    const key = agentIds.join(',');
    return new Promise<void>((resolve) => {
      const waiter: Waiter = {
        agentId: key,
        resolve: () => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve();
        },
      };
      const timer = setTimeout(() => waiter.resolve(), Math.max(0, ms));
      // 长轮询挂起不能让进程无法退出
      timer.unref?.();
      this.waiters.add(waiter);
    });
  }

  /**
   * 认领任务：有则立即返回，没有则挂起直到新任务或超时。
   * @param input 该设备上的 Agent 集合与设备信息
   */
  async claim(input: {
    agentIds: string[];
    deviceId: string;
    leaseMs: number;
    holdMs: number;
  }): Promise<Run | null> {
    const deadline = Date.now() + input.holdMs;
    for (;;) {
      const run = claimNextRun(this.db, {
        agentIds: input.agentIds,
        deviceId: input.deviceId,
        leaseMs: input.leaseMs,
      });
      if (run) return run;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      // 上限 3 秒复查一次，兜底覆盖「入队没唤醒」的极端情况
      await this.waitFor(input.agentIds, Math.min(remaining, 3_000));
    }
  }
}
