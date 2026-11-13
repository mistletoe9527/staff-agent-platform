import type {
  AgentStatus,
  AgentView,
  MeResponse,
  RunDetail,
  RunStatus,
  RunView,
  SkillDetail,
  SkillListResponse,
  SkillStatus,
  StatsView,
} from '@staff-agent/shared';

/** 登录态或会话过期。 */
export class UnauthorizedError extends Error {
  constructor() {
    super('未登录或会话已过期');
    this.name = 'UnauthorizedError';
  }
}

/** 统一解析响应：401 抛 UnauthorizedError，其余非 2xx 提取服务端错误。 */
async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 401) throw new UnauthorizedError();
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = { error: text };
    }
  }
  if (!response.ok) {
    const parts = [payload.error, payload.message]
      .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
      .filter((part, index, all) => index === 0 || part !== all[0]);
    throw new Error(parts.length > 0 ? parts.join(': ') : `HTTP ${response.status}`);
  }
  return payload as T;
}

/** 统一请求封装：JSON + Cookie + 错误信息。无 body 的请求不要声明 JSON，否则 Fastify 拒收空 body。 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const hasBody = init.body !== undefined && init.body !== null;
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  return parseResponse<T>(response);
}

/** 上传 raw zip：元数据放 query，包体直接作为 body。 */
async function upload<T>(path: string, file: Blob): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    body: file,
    headers: { 'content-type': 'application/zip' },
  });
  return parseResponse<T>(response);
}

/** Skill 上传元数据。 */
export interface SkillUploadMeta {
  name?: string;
  summary?: string;
  description?: string;
  category?: string;
  tags?: string[];
  version?: string;
  changelog?: string;
  filename?: string;
}

/** 把元数据拼成 query。 */
function uploadQuery(meta: SkillUploadMeta): string {
  const params = new URLSearchParams();
  for (const key of ['name', 'summary', 'description', 'category', 'version', 'changelog', 'filename'] as const) {
    const value = meta[key];
    if (value && value.trim()) params.set(key, value.trim());
  }
  if (meta.tags && meta.tags.length > 0) params.set('tags', meta.tags.join(','));
  const suffix = params.toString();
  return suffix ? `?${suffix}` : '';
}

/** 管理后台接口。 */
export const api = {
  me: () => request<MeResponse>('/api/auth/me'),
  login: (password: string) =>
    request<{ ok: true }>('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  agents: (query: { q?: string; status?: AgentStatus }) => {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.status) params.set('status', query.status);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return request<{ items: AgentView[] }>(`/api/admin/agents${suffix}`);
  },
  updateAgent: (id: string, patch: { name?: string; status?: AgentStatus; description?: string | null }) =>
    request<{ ok: true }>(`/api/admin/agents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  kick: (id: string) =>
    request<{ ok: true; revoked: number }>(`/api/admin/agents/${id}/kick`, { method: 'POST' }),
  deleteAgent: (id: string, name: string) =>
    request<{ ok: true; devices: number; conversations: number; enrollCodes: number }>(
      `/api/admin/agents/${id}?confirm=${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),
  syncProfile: (id: string) =>
    request<{ ok: true; name: string; feishuName: string | null; feishuAvatarUrl: string | null }>(
      `/api/admin/agents/${id}/sync-profile`,
      { method: 'POST' },
    ),
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

  // ---------- Skill 广场 ----------
  skills: (query: {
    q?: string;
    category?: string;
    sort?: 'latest' | 'popular' | 'name';
    page?: number;
    limit?: number;
    mine?: boolean;
    includeHidden?: boolean;
  }) => {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.category) params.set('category', query.category);
    if (query.sort) params.set('sort', query.sort);
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));
    if (query.mine) params.set('mine', '1');
    if (query.includeHidden) params.set('includeHidden', '1');
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return request<SkillListResponse>(`/api/skills${suffix}`);
  },
  skill: (id: string) => request<SkillDetail>(`/api/skills/${id}`),
  createSkill: (meta: SkillUploadMeta, file: Blob) => upload<SkillDetail>(`/api/skills${uploadQuery(meta)}`, file),
  uploadSkillVersion: (id: string, meta: SkillUploadMeta, file: Blob) =>
    upload<SkillDetail>(`/api/skills/${id}/versions${uploadQuery(meta)}`, file),
  updateSkill: (
    id: string,
    patch: {
      name?: string;
      summary?: string;
      description?: string;
      category?: string;
      tags?: string[];
      status?: SkillStatus;
    },
  ) => request<SkillDetail>(`/api/skills/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSkill: (id: string, name: string) =>
    request<{ ok: true }>(`/api/skills/${id}?confirm=${encodeURIComponent(name)}`, { method: 'DELETE' }),
  /** 下载 zip；失败时抛出服务端原因。 */
  downloadSkill: async (id: string, version?: string): Promise<void> => {
    const params = new URLSearchParams();
    if (version) params.set('version', version);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const response = await fetch(`/api/skills/${id}/download${suffix}`, { credentials: 'include' });
    if (response.status === 401) throw new UnauthorizedError();
    if (!response.ok) {
      const text = await response.text();
      let message = `HTTP ${response.status}`;
      try {
        const payload = JSON.parse(text) as { error?: string };
        if (payload.error) message = payload.error;
      } catch {
        if (text) message = text;
      }
      throw new Error(message);
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    const filename = match?.[1] ?? `skill-${version ?? 'latest'}.zip`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
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

/** 字节数转可读大小。 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
