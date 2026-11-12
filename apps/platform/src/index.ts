import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config.js';
import { openDatabase } from './db/client.js';
import { ensureSchema } from './db/migrations.js';
import { reapExpiredLeases } from './domain/runs.js';
import { purgeExpiredSteps } from './domain/steps.js';
import { purgeEnrollCodes } from './domain/enroll.js';
import { FeishuClient, NoopFeishuClient, type FeishuPort } from './feishu/client.js';
import { FeishuOAuth } from './feishu/oauth.js';
import { registerAdminRoutes } from './http/routes-admin.js';
import { registerAuthRoutes } from './http/routes-auth.js';
import { registerBindRoutes } from './http/routes-bind.js';
import { registerBridgeRoutes } from './http/routes-bridge.js';
import { registerSkillRoutes } from './http/routes-skills.js';
import { DispatchService } from './services/dispatch-service.js';
import { EnrollService } from './services/enroll-service.js';
import { Inbox } from './services/inbox.js';
import { RunNotifier } from './services/run-notifier.js';
import { createLogger, errorText } from './util/logger.js';

/**
 * 平台入口。
 * 启动顺序：配置 → 数据库 → 飞书 → HTTP。任何一步失败都打印明确原因后退出，
 * 不允许「半启动」状态对外服务。
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  const db = openDatabase(config.DATA_DIR);
  const applied = ensureSchema(db);
  if (applied.length > 0) {
    logger.info({ versions: applied }, '数据库迁移已应用');
  }

  const inbox = new Inbox(db);
  const feishu: FeishuPort = config.feishuReady
    ? new FeishuClient(config, logger)
    : new NoopFeishuClient(logger);
  const oauth = new FeishuOAuth(config, logger);
  const enroll = new EnrollService(db, config, feishu, logger);
  const dispatch = new DispatchService(db, config, feishu, inbox, logger);
  const notifier = new RunNotifier(db, feishu, logger);

  // 绑定码优先：纯 6 位数字走绑定流程，其余走任务派发
  feishu.onMessage((message) => {
    if (!message.senderOpenId) return;
    void (async () => {
      try {
        const handled = await enroll.handleCodeMessage(message);
        if (!handled) await dispatch.handleSafely(message);
      } catch (error) {
        logger.error({ err: errorText(error), messageId: message.messageId }, '飞书消息处理异常');
      }
    })();
  });

  const app = Fastify({
    logger: false,
    // 长轮询最长挂起 25 秒，给反向代理留出余量
    keepAliveTimeout: 72_000,
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: true,
  });
  await app.register(cookie, { secret: config.sessionSecret });

  // Skill 包上传走 raw body：浏览器端把文件夹 / Markdown 打包成 zip 后直接 POST。
  for (const contentType of [
    'application/zip',
    'application/x-zip-compressed',
    'application/octet-stream',
    'text/markdown',
    'text/plain',
  ]) {
    app.addContentTypeParser(
      contentType,
      { parseAs: 'buffer', bodyLimit: config.SKILL_MAX_BYTES + 4096 },
      (_request, body, done) => done(null, body),
    );
  }

  const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/', index: ['index.html'] });
  }

  app.get('/api/health', async () => ({
    ok: true,
    feishu: feishu.connectionState(),
    uptimeSec: Math.round(process.uptime()),
  }));

  registerBridgeRoutes(app, { db, config, inbox, enroll, notifier, logger });
  registerAdminRoutes(app, { db, config, feishu, logger });
  registerAuthRoutes(app, { db, config, oauth, logger });
  registerSkillRoutes(app, { db, config, logger });
  registerBindRoutes(app, { config, enroll, oauth, logger });

  // 前端单页应用回退；/api 下的 404 保持 JSON
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ ok: false, error: '接口不存在' });
    }
    if (existsSync(`${webRoot}/index.html`)) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply
      .code(404)
      .type('text/html; charset=utf-8')
      .send('<h1>管理后台未构建</h1><p>先运行 pnpm --filter @staff-agent/web build</p>');
  });

  // 租约回收：网关掉线时任务不会永久卡在 running
  const reapTimer = setInterval(() => {
    try {
      const result = reapExpiredLeases(db, { maxAttempts: config.RUN_MAX_ATTEMPTS });
      for (const run of result.requeued) {
        inbox.notify(run.agentId);
      }
      for (const run of result.failed) {
        notifier.notifyFinished(run.id).catch((error: unknown) => {
          logger.error({ err: errorText(error), runId: run.id }, '租约过期通知失败');
        });
      }
      if (result.requeued.length + result.failed.length > 0) {
        logger.info(
          { requeued: result.requeued.length, failed: result.failed.length },
          '过期租约已回收',
        );
      }
    } catch (error) {
      logger.error({ err: errorText(error) }, '租约回收失败');
    }
  }, 10_000);
  reapTimer.unref();

  // trace 明细保留策略：只删步骤明细，任务级记录保留
  const purgeTimer = setInterval(() => {
    try {
      const cutoff = new Date(Date.now() - config.TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const steps = purgeExpiredSteps(db, cutoff);
      const codes = purgeEnrollCodes(db);
      if (steps + codes > 0) logger.info({ steps, codes }, '过期数据已清理');
    } catch (error) {
      logger.error({ err: errorText(error) }, '过期数据清理失败');
    }
  }, 60 * 60 * 1000);
  purgeTimer.unref();

  // 重启后可能有排队任务没被唤醒，统一唤醒一次
  inbox.notifyAll();

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT, dataDir: config.DATA_DIR, feishu: config.feishuReady }, '平台已启动');

  if (config.feishuReady) {
    try {
      await feishu.getBotOpenId();
      await feishu.start();
    } catch (error) {
      logger.error({ err: errorText(error) }, '飞书长连接启动失败，平台继续以离线模式运行');
    }
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, '开始关闭');
    clearInterval(reapTimer);
    clearInterval(purgeTimer);
    feishu.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', msg: '未处理的 Promise 拒绝', err: errorText(reason) })}\n`);
});
process.on('uncaughtException', (error) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', msg: '未捕获异常', err: errorText(error) })}\n`);
  process.exit(1);
});

main().catch((error: unknown) => {
  const text = errorText(error);
  process.stderr.write(`${JSON.stringify({ level: 'error', msg: '平台启动失败', err: text })}\n`);
  // 端口被占用是最常见的本地开发故障（常见原因：docker compose 起的同名容器还在跑）
  if (text.includes('EADDRINUSE')) {
    const port = process.env.PORT ?? '8787';
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        msg: `端口 ${port} 已被占用：先停掉占用它的进程（docker compose stop platform / lsof -nP -iTCP:${port} -sTCP:LISTEN），或用 PORT=${Number(port) + 1} 换端口启动`,
      })}\n`,
    );
  }
  process.exit(1);
});
