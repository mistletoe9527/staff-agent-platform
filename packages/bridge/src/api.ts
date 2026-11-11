import type {
  EnrollPollResponse,
  PollResponse,
  RegisterRequest,
  RegisterResponse,
  RunAssignment,
  RunReportRequest,
  StepInput,
} from '@staff-agent/shared';

/** 平台返回的业务错误。 */
export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'PlatformError';
  }
}

/** 网络层重试次数（仅对幂等请求生效）。 */
const RETRY_ATTEMPTS = 3;
/** 单次请求基础超时（毫秒）。长轮询单独设置。 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * 平台 HTTP 客户端。
 * 所有请求都是网关主动外连，不需要平台访问本机。
 */
export class PlatformApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null = null,
  ) {}

  /** 设置/替换设备令牌（登录完成后使用）。 */
  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  /** 注册设备，返回绑定码。 */
  async register(request: RegisterRequest): Promise<RegisterResponse> {
    return this.request<RegisterResponse>('POST', '/api/bridge/register', request);
  }

  /** 轮询绑定结果。 */
  async enrollPoll(code: string): Promise<EnrollPollResponse> {
    return this.request<EnrollPollResponse>('POST', '/api/bridge/enroll/poll', { code });
  }

  /**
   * 长轮询接任务。
   * @param payload 状态上报
   * @param signal 中断信号（退出时取消挂起请求）
   */
  async poll(
    payload: { state: 'idle' | 'busy'; activeRuns: number; runtimeVersion?: string; bridgeVersion?: string },
    signal: AbortSignal,
  ): Promise<PollResponse> {
    return this.request<PollResponse>('POST', '/api/bridge/poll', payload, {
      signal,
      timeoutMs: 40_000,
    });
  }

  /** 认领任务。 */
  async ack(runId: string, leaseId: string): Promise<void> {
    await this.request('POST', `/api/bridge/runs/${encodeURIComponent(runId)}/ack`, { leaseId });
  }

  /** 上报步骤。 */
  async steps(runId: string, leaseId: string, steps: StepInput[]): Promise<void> {
    await this.request('POST', `/api/bridge/runs/${encodeURIComponent(runId)}/steps`, { leaseId, steps });
  }

  /** 上报任务终态。 */
  async report(runId: string, body: RunReportRequest): Promise<void> {
    await this.request('POST', `/api/bridge/runs/${encodeURIComponent(runId)}/report`, body);
  }

  /** 通用请求，带重试与超时。 */
  private async request<T = unknown>(
    method: string,
    path: string,
    body: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number; retry?: boolean } = {},
  ): Promise<T> {
    const attempts = options.retry === false ? 1 : RETRY_ATTEMPTS;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
      const onAbort = (): void => controller.abort();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
          method,
          headers: this.authHeaders(),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await response.text();
        const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        if (!response.ok) {
          const message = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
          const code = typeof payload.code === 'string' ? payload.code : undefined;
          // 4xx 是业务错误，重试没有意义
          if (response.status >= 400 && response.status < 500) {
            throw new PlatformError(message, response.status, code);
          }
          throw new PlatformError(message, response.status, code);
        }
        return payload as T;
      } catch (error) {
        lastError = error;
        if (error instanceof PlatformError && error.status < 500) throw error;
        if (options.signal?.aborted) throw error;
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('请求平台失败');
  }
}

/** 判断任务包是否完整（防御性检查，避免平台协议变更导致网关崩溃）。 */
export function isRunAssignment(value: unknown): value is RunAssignment {
  if (!value || typeof value !== 'object') return false;
  const run = value as Partial<RunAssignment>;
  return typeof run.runId === 'string' && typeof run.leaseId === 'string' && typeof run.prompt === 'string';
}
