import type { FastifyInstance } from 'fastify';
import type { MeResponse } from '@staff-agent/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { FeishuOAuth } from '../feishu/oauth.js';
import { audit } from '../domain/audit.js';
import {
  ADMIN_COOKIE,
  USER_COOKIE,
  USER_SESSION_TTL_MS,
  readViewer,
  safeReturnTo,
  signEmployeeSession,
  signOAuthState,
  verifyOAuthState,
} from '../services/web-auth.js';
import { errorText, type Logger } from '../util/logger.js';

/** 登录路由依赖。 */
export interface AuthRouteDeps {
  db: Db;
  config: Config;
  oauth: FeishuOAuth;
  logger: Logger;
}

/** 简单 HTML 转义。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 登录失败 / 无权限时的小页面。 */
function resultPage(title: string, message: string, returnTo: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0b0e14; color: #e6e9ef; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; padding: 24px; }
  .card { width: 100%; max-width: 420px; background: #141922; border: 1px solid #232a36; border-radius: 16px; padding: 28px 24px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { color: #9aa4b2; font-size: 14px; line-height: 1.7; margin: 8px 0; }
  a { color: #4c8dff; }
</style>
</head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(returnTo)}">返回 Skill 广场</a></p></div></body>
</html>`;
}

/**
 * 员工网页登录。
 *
 * 管理员口径令登录仍由 /api/admin/login 负责；
 * 这里只负责飞书 OAuth：员工点「飞书登录」→ 授权 → 回跳设置会话 Cookie。
 * 未配置飞书网页授权时，前端不会展示飞书登录入口。
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { db, config, oauth, logger } = deps;

  const cookieSecure =
    config.NODE_ENV === 'production' &&
    Boolean((config.PUBLIC_BASE_URL ?? config.webRedirectUri ?? '').startsWith('https://'));

  app.get('/api/auth/me', async (request): Promise<MeResponse> => {
    const viewer = readViewer(request, config);
    return {
      authenticated: Boolean(viewer),
      user: viewer,
      feishuLoginReady: config.webLoginReady,
    };
  });

  // 同时清掉管理员与员工会话：退出登录意图明确，避免残留另一种身份
  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie(ADMIN_COOKIE, { path: '/' });
    reply.clearCookie(USER_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/feishu/start', async (request, reply) => {
    if (!config.webLoginReady || !config.webRedirectUri) {
      return reply.code(503).send({
        ok: false,
        error: '未配置飞书网页授权：请设置 PUBLIC_BASE_URL 或 FEISHU_WEB_REDIRECT_URI',
        code: 'FEISHU_LOGIN_DISABLED',
      });
    }
    const query = request.query as { return?: string };
    const returnTo = safeReturnTo(query.return);
    const state = signOAuthState(config, returnTo);
    return reply.redirect(oauth.authorizeUrl(state, config.webRedirectUri), 302);
  });

  app.get('/api/auth/feishu/callback', async (request, reply) => {
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    const returnTo = verifyOAuthState(query.state, config);
    if (!returnTo) {
      return reply
        .type('text/html; charset=utf-8')
        .send(resultPage('登录失败', '登录状态已过期或被篡改，请重新登录。', '/#/skills'));
    }
    if (query.error) {
      return reply
        .type('text/html; charset=utf-8')
        .send(resultPage('登录已取消', query.error_description ?? '你取消了飞书授权，可以重新登录。', returnTo));
    }
    if (!query.code || !config.webRedirectUri) {
      return reply.type('text/html; charset=utf-8').send(resultPage('登录失败', '回调参数缺失，请重新登录。', returnTo));
    }
    try {
      const identity = await oauth.exchange(query.code);
      if (!identity) {
        return reply
          .type('text/html; charset=utf-8')
          .send(resultPage('登录失败', '飞书授权失败，请重新登录。', returnTo));
      }
      reply.setCookie(USER_COOKIE, signEmployeeSession(config, identity), {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: USER_SESSION_TTL_MS / 1000,
        secure: cookieSecure,
      });
      audit(db, {
        actor: `feishu:${identity.openId}`,
        action: 'auth.feishu_login',
        target: identity.openId,
        detail: identity.name,
      });
      logger.info({ openId: identity.openId, name: identity.name }, '员工通过飞书登录 Skill 广场');
      return reply.redirect(returnTo, 302);
    } catch (error) {
      logger.error({ err: errorText(error) }, '飞书网页登录异常');
      return reply
        .type('text/html; charset=utf-8')
        .send(resultPage('登录异常', '登录过程出现异常，请稍后重试。', returnTo));
    }
  });
}
