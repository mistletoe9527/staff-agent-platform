import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AgentStatus, RunStatus } from '@staff-agent/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { findAgentById, updateAgent } from '../domain/agents.js';
import { audit } from '../domain/audit.js';
import { revokeDevicesByAgent } from '../domain/devices.js';
import { findRunById, listRuns } from '../domain/runs.js';
import { listSteps } from '../domain/steps.js';
import { listAgentViews } from '../services/agent-views.js';
import { buildStats } from '../trace/stats.js';
import { safeEqual } from '../util/hash.js';
import { errorText, type Logger } from '../util/logger.js';

/** 管理后台会话 Cookie 名。 */
const SESSION_COOKIE = 'sa_admin';
/** 会话有效期（毫秒）。 */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** 管理员路由依赖。 */
export interface AdminRouteDeps {
  db: Db;
  config: Config;
  logger: Logger;
}

/** 登录请求。 */
const LoginSchema = z.object({ password: z.string().min(1).max(256) });

/** Agent 修改请求。 */
const AgentPatchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

/** 生成会话令牌：过期时间 + HMAC 签名。无状态，重启不掉线。 */
function signSession(config: Config): string {
  const exp = String(Date.now() + SESSION_TTL_MS);
  const signature = createHmac('sha256', config.sessionSecret).update(exp).digest('base64url');
  return `${exp}.${signature}`;
}

/** 校验会话令牌。 */
function verifySession(token: string | undefined, config: Config): boolean {
  if (!token) return false;
  const index = token.indexOf('.');
  if (index <= 0) return false;
  const exp = token.slice(0, index);
  const signature = token.slice(index + 1);
  if (!/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now()) return false;
  const expected = createHmac('sha256', config.sessionSecret).update(exp).digest('base64url');
  return safeEqual(signature, expected);
}

/** 管理后台路由。全部走 Cookie 会话，不做多级权限（私有化单租户场景）。 */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  const { db, config, logger } = deps;

  /** 统一鉴权。 */
  const requireAdmin = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (verifySession(request.cookies[SESSION_COOKIE], config)) return true;
    void reply.code(401).send({ ok: false, error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
    return false;
  };

  app.post('/api/admin/login', async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: '口令格式错误' });
    if (!safeEqual(parsed.data.password, config.ADMIN_PASSWORD)) {
      logger.warn({ ip: request.ip }, '管理后台登录失败');
      return reply.code(401).send({ ok: false, error: '口令错误' });
    }
    reply.setCookie(SESSION_COOKIE, signSession(config), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS / 1000,
      secure: config.NODE_ENV === 'production' && Boolean(config.PUBLIC_BASE_URL?.startsWith('https://')),
    });
    audit(db, { actor: `admin@${request.ip}`, action: 'admin.login' });
    return { ok: true };
  });

  app.post('/api/admin/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/admin/session', async (request) => {
    return { authenticated: verifySession(request.cookies[SESSION_COOKIE], config) };
  });

  // Agent 列表（设备与统计批量取回，无 N+1）
  app.get('/api/admin/agents', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const query = request.query as { q?: string; status?: AgentStatus };
    const items = listAgentViews(db, {
      q: query.q?.trim() || undefined,
      status: query.status === 'active' || query.status === 'disabled' ? query.status : undefined,
      onlineWindowSec: config.ONLINE_WINDOW_SEC,
    });
    return { items };
  });

  // 修改 Agent 名称 / 启用禁用
  app.patch('/api/admin/agents/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const params = request.params as { id: string };
    const parsed = AgentPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: '参数格式错误' });
    const agent = findAgentById(db, params.id);
    if (!agent) return reply.code(404).send({ ok: false, error: 'Agent 不存在' });
    updateAgent(db, params.id, parsed.data);
    audit(db, {
      actor: `admin@${request.ip}`,
      action: 'agent.update',
      target: params.id,
      detail: JSON.stringify(parsed.data),
    });
    return { ok: true };
  });

  // 强制下线（撤销设备令牌，换机 / 离职 / 异常处置）
  app.post('/api/admin/agents/:id/kick', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const params = request.params as { id: string };
    const agent = findAgentById(db, params.id);
    if (!agent) return reply.code(404).send({ ok: false, error: 'Agent 不存在' });
    const revoked = revokeDevicesByAgent(db, params.id);
    audit(db, { actor: `admin@${request.ip}`, action: 'agent.kick', target: params.id, detail: `revoked=${revoked}` });
    return { ok: true, revoked };
  });

  // 任务列表（按月窗口 + 游标分页）
  app.get('/api/admin/runs', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const query = request.query as {
      agentId?: string;
      status?: RunStatus;
      cursor?: string;
      limit?: string;
      days?: string;
    };
    const limit = Math.min(Math.max(Number(query.limit ?? 30), 1), 100);
    const days = Math.min(Math.max(Number(query.days ?? 7), 1), 90);
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const page = listRuns(db, {
      agentId: query.agentId,
      status: query.status,
      from,
      cursor: query.cursor,
      limit,
    });
    return {
      items: page.items.map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        agentName: row.agent_name,
        status: row.status,
        promptPreview: row.prompt.slice(0, 120),
        createdAt: row.created_at,
        endedAt: row.ended_at,
        durationMs: row.duration_ms,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        error: row.error,
      })),
      nextCursor: page.nextCursor,
    };
  });

  // 任务详情 + 全量步骤
  app.get('/api/admin/runs/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const params = request.params as { id: string };
    const run = findRunById(db, params.id);
    if (!run) return reply.code(404).send({ ok: false, error: '任务不存在' });
    const agent = findAgentById(db, run.agentId);
    const steps = listSteps(db, run.id);
    return {
      id: run.id,
      agentId: run.agentId,
      agentName: agent?.name ?? '未知 Agent',
      status: run.status,
      promptPreview: run.prompt.slice(0, 120),
      prompt: run.prompt,
      result: run.result,
      createdAt: run.createdAt,
      endedAt: run.endedAt,
      durationMs: run.durationMs,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      error: run.error,
      steps: steps.map((step) => ({
        seq: step.seq,
        type: step.type,
        name: step.name,
        inputSummary: step.inputSummary,
        outputSummary: step.outputSummary,
        durationMs: step.durationMs,
        inputTokens: step.inputTokens,
        outputTokens: step.outputTokens,
        isError: step.isError,
        createdAt: step.createdAt,
      })),
    };
  });

  // 聚合统计
  app.get('/api/admin/stats', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const query = request.query as { days?: string };
    const days = Math.min(Math.max(Number(query.days ?? 7), 1), 90);
    try {
      return buildStats(db, { days, onlineWindowSec: config.ONLINE_WINDOW_SEC });
    } catch (error) {
      logger.error({ err: errorText(error) }, '统计查询失败');
      return reply.code(500).send({ ok: false, error: '统计查询失败' });
    }
  });
}
