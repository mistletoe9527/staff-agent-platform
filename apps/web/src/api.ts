import type { AgentView, RunDetail, RunView, StatsView, AgentStatus, RunStatus } from '@staff-agent/shared';

/** 登录态或会话过期。 */
export class UnauthorizedError extends Error {
  constructor() {
    super('未登录或会话已过期');
    this.name = 'UnauthorizedError';
  }
}

/** 统一请求封装：JSON + Cookie + 错误信息。 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  if (response.status === 401) throw new UnauthorizedError();
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`);
  }
  return payload as T;
}

/** 管理后台接口。 */
export const api = {
  session: () => request<{ authenticated: boolean }>('/api/admin/session'),
  login: (password: string) =>
    request<{ ok: true }>('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: true }>('/api/admin/logout', { method: 'POST' }),
  agents: (query: { q?: string; status?: AgentStatus }) => {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.status) params.set('status', query.status);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return request<{ items: AgentView[] }>(`/api/admin/agents${suffix}`);
  },
  updateAgent: (id: string, patch: { name?: string; status?: AgentStatus }) =>
    request<{ ok: true }>(`/api/admin/agents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  kick: (id: string) =>
    request<{ ok: true; revoked: number }>(`/api/admin/agents/${id}/kick`, { method: 'POST' }),
  runs: (query: { agentId?: string; status?: RunStatus; cursor?: string; days?: number; limit?: number }) => {
    const params = new URLSearchParams();
    if (query.agentId) params.set('agentId', query.agentId);
    if (query.status) params.set('status', query.status);
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.days) params.set('days', String(query.days));
    if (query.limit) params.set('limit', String(query.limit));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return request<{ items: RunView[]; nextCursor: string | null }>(`/api/admin/runs${suffix}`);
  },
  run: (id: string) => request<RunDetail>(`/api/admin/runs/${id}`),
  stats: (days: number) => request<StatsView>(`/api/admin/stats?days=${days}`),
};

/** 毫秒转「1m23s」。 */
export function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return '-';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${total % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** 格式化时间戳为本地可读时间。 */
export function formatTime(iso: string | null): string {
  if (!iso) return '-';
  const date = new Date(iso);
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 数字千分位。 */
export function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN');
}
