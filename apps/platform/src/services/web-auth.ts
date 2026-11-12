import { createHmac } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AuthViewer } from '@staff-agent/shared';
import type { Config } from '../config.js';
import { safeEqual } from '../util/hash.js';

/** 管理后台会话 Cookie。 */
export const ADMIN_COOKIE = 'sa_admin';
/** 员工（飞书）会话 Cookie。 */
export const USER_COOKIE = 'sa_user';

/** 管理员会话有效期：12 小时。 */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** 员工会话有效期：30 天，避免每次进广场都重新授权。 */
export const USER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 飞书 OAuth state 有效期：10 分钟。 */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function hmac(config: Config, value: string): string {
  return createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

/**
 * 管理员会话令牌：`过期时间.HMAC`。
 * 无状态，平台重启不掉线；沿用旧格式，已登录的管理员不受影响。
 */
export function signAdminSession(config: Config): string {
  const exp = String(Date.now() + ADMIN_SESSION_TTL_MS);
  return `${exp}.${hmac(config, exp)}`;
}

/** 校验管理员会话令牌。 */
export function verifyAdminSession(token: string | undefined, config: Config): boolean {
  if (!token) return false;
  const index = token.indexOf('.');
  if (index <= 0) return false;
  const exp = token.slice(0, index);
  const signature = token.slice(index + 1);
  if (!/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now()) return false;
  return safeEqual(signature, hmac(config, exp));
}

/** 员工会话令牌：base64url(JSON) + HMAC。 */
export function signEmployeeSession(config: Config, user: { openId: string; name: string | null }): string {
  const payload = Buffer.from(
    JSON.stringify({ openId: user.openId, name: user.name ?? user.openId, exp: Date.now() + USER_SESSION_TTL_MS }),
  ).toString('base64url');
  return `${payload}.${hmac(config, `user.${payload}`)}`;
}

/** 解析并校验员工会话令牌。 */
export function readEmployeeSession(
  token: string | undefined,
  config: Config,
): { openId: string; name: string } | null {
  if (!token) return null;
  const index = token.lastIndexOf('.');
  if (index <= 0) return null;
  const payload = token.slice(0, index);
  const signature = token.slice(index + 1);
  if (!safeEqual(signature, hmac(config, `user.${payload}`))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      openId?: unknown;
      name?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.openId !== 'string' || !parsed.openId) return null;
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
    return { openId: parsed.openId, name: typeof parsed.name === 'string' ? parsed.name : parsed.openId };
  } catch {
    return null;
  }
}

/**
 * 读取当前登录者。
 * 管理员 Cookie 优先：管理员在浏览器里同时拥有员工 Cookie 时，仍按管理员处理。
 */
export function readViewer(request: FastifyRequest, config: Config): AuthViewer | null {
  if (verifyAdminSession(request.cookies[ADMIN_COOKIE], config)) {
    return { kind: 'admin', openId: null, name: '管理员', isAdmin: true };
  }
  const employee = readEmployeeSession(request.cookies[USER_COOKIE], config);
  if (!employee) return null;
  return { kind: 'employee', openId: employee.openId, name: employee.name, isAdmin: false };
}

/** 会话 key：用于下载审计与去重，不直接暴露 open_id 给前端。 */
export function viewerKey(viewer: AuthViewer): string {
  return viewer.kind === 'admin' ? 'admin' : `feishu:${viewer.openId ?? 'unknown'}`;
}

/** 只允许站内相对路径，避免 OAuth 回调被当成开放重定向。 */
export function safeReturnTo(value: string | undefined): string {
  if (!value) return '/#/skills';
  if (!value.startsWith('/') || value.startsWith('//')) return '/#/skills';
  if (value.length > 512 || /[\r\n]/.test(value)) return '/#/skills';
  return value;
}

/** 飞书 OAuth state：签名后的回跳地址 + 过期时间。 */
export function signOAuthState(config: Config, returnTo: string): string {
  const payload = Buffer.from(
    JSON.stringify({ returnTo: safeReturnTo(returnTo), exp: Date.now() + OAUTH_STATE_TTL_MS }),
  ).toString('base64url');
  return `${payload}.${hmac(config, `oauth.${payload}`)}`;
}

/** 校验 OAuth state，返回安全的回跳地址。 */
export function verifyOAuthState(state: string | undefined, config: Config): string | null {
  if (!state) return null;
  const index = state.lastIndexOf('.');
  if (index <= 0) return null;
  const payload = state.slice(0, index);
  const signature = state.slice(index + 1);
  if (!safeEqual(signature, hmac(config, `oauth.${payload}`))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      returnTo?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
    return safeReturnTo(typeof parsed.returnTo === 'string' ? parsed.returnTo : undefined);
  } catch {
    return null;
  }
}
