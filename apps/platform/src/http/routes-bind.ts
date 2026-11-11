import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { EnrollService } from '../services/enroll-service.js';
import type { FeishuOAuth } from '../feishu/oauth.js';
import { errorText, type Logger } from '../util/logger.js';

/** 绑定页面依赖。 */
export interface BindRouteDeps {
  config: Config;
  enroll: EnrollService;
  oauth: FeishuOAuth;
  logger: Logger;
}

/** HTML 转义，绑定结果里的 Agent 名可能来自飞书通讯录。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 统一的移动端页面骨架。 */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0b0e14; color: #e6e9ef; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; padding: 24px; }
  .card { width: 100%; max-width: 420px; background: #141922; border: 1px solid #232a36; border-radius: 16px; padding: 28px 24px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { color: #9aa4b2; font-size: 14px; line-height: 1.7; margin: 8px 0; }
  .code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 40px; letter-spacing: 10px;
          text-align: center; padding: 18px 0; margin: 16px 0; background: #0b0e14; border-radius: 12px; border: 1px dashed #2f3a4b; }
  .ok { color: #3ddc97; } .err { color: #ff6b6b; }
  .hint { font-size: 13px; color: #7b8698; }
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

/** 渲染错误页。 */
function errorPage(message: string): string {
  return page('绑定失败', `<h1 class="err">绑定失败</h1><p>${escapeHtml(message)}</p>`);
}

/**
 * 扫码绑定路由。
 *
 * 配置了飞书网页授权时：二维码 → 授权 → 回调直接完成绑定（一步）。
 * 未配置时：页面只展示绑定码，员工把码发到飞书完成绑定（无需公网）。
 */
export function registerBindRoutes(app: FastifyInstance, deps: BindRouteDeps): void {
  const { config, enroll, oauth, logger } = deps;

  // 飞书网页授权回调，必须注册在 /bind/:code 之前
  app.get('/bind/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };
    if (query.error) {
      return reply.type('text/html; charset=utf-8').send(errorPage('你取消了授权，可以重新扫码。'));
    }
    if (!query.code || !query.state) {
      return reply.type('text/html; charset=utf-8').send(errorPage('回调参数缺失。'));
    }
    try {
      const identity = await oauth.exchange(query.code);
      if (!identity) {
        return reply.type('text/html; charset=utf-8').send(errorPage('飞书授权失败，请重新扫码。'));
      }
      const outcome = await enroll.bindByCode(query.state, identity.openId);
      if (!outcome.ok) {
        return reply.type('text/html; charset=utf-8').send(errorPage(outcome.message));
      }
      return reply
        .type('text/html; charset=utf-8')
        .send(
          page(
            '绑定成功',
            `<h1 class="ok">✅ 绑定成功</h1><p>Agent：${escapeHtml(outcome.agentName ?? '')}</p><p class="hint">回到电脑上，终端会自动完成登录。之后在飞书里 @机器人 发任务即可。</p>`,
          ),
        );
    } catch (error) {
      logger.error({ err: errorText(error) }, '扫码绑定异常');
      return reply.type('text/html; charset=utf-8').send(errorPage('绑定异常，请稍后重试。'));
    }
  });

  // 二维码落地页
  app.get('/bind/:code', async (request, reply) => {
    const params = request.params as { code: string };
    const code = params.code.trim();
    if (!/^\d{6}$/.test(code)) {
      return reply.type('text/html; charset=utf-8').send(errorPage('绑定码格式不正确。'));
    }
    if (oauth.enabled()) {
      // 一步到位：直接跳飞书授权，授权回来即绑定完成
      return reply.redirect(oauth.authorizeUrl(code), 302);
    }
    return reply.type('text/html; charset=utf-8').send(
      page(
        '绑定 Agent',
        `<h1>绑定你的 Agent</h1>
         <div class="code">${escapeHtml(code)}</div>
         <p>打开飞书，找到公司 Agent 机器人，把这个 6 位码发给它，即可完成绑定。</p>
         <p class="hint">绑定码 5 分钟内有效，一次性使用。${config.PUBLIC_BASE_URL ? '' : '（当前未配置公网地址，所以这里不提供一步扫码）'}</p>`,
      ),
    );
  });
}
