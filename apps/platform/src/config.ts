import { z } from 'zod';

/**
 * 可选变量的统一处理：`.env` 里写成 `KEY=` 时会得到空字符串，
 * 直接交给 `.url()` / `.min(1)` 会校验失败，这里统一按“未配置”处理。
 */
const emptyAsUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

/**
 * 平台配置：全部来自环境变量，代码里不出现任何飞书凭证。
 * 校验失败直接退出进程，避免半配置状态跑起来。
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  /** 监听端口 */
  PORT: z.coerce.number().int().positive().default(8787),
  /** 监听地址，容器内固定 0.0.0.0 */
  HOST: z.string().default('0.0.0.0'),
  /** 数据目录，SQLite 文件与日志都放这里 */
  DATA_DIR: z.string().default('./data'),
  /**
   * 对外可访问地址，例如 https://agent.example.com。
   * 配置后绑定流程额外提供二维码；不配置则只有 6 位绑定码。
   */
  PUBLIC_BASE_URL: emptyAsUndefined(z.string().url()),

  /** 飞书应用凭证 */
  FEISHU_APP_ID: emptyAsUndefined(z.string().min(1)),
  FEISHU_APP_SECRET: emptyAsUndefined(z.string().min(1)),
  /** 是否启用飞书长连接；本地联调可关掉 */
  FEISHU_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** 飞书开放平台域名，国内默认 open.feishu.cn，Lark 国际用 open.larksuite.com */
  FEISHU_OPEN_BASE: z.string().url().default('https://open.feishu.cn'),
  /**
   * 飞书网页授权回调地址，例如 https://agent.example.com/bind/callback。
   * 配置后扫码可以一步完成绑定；不配置则二维码只展示绑定码。
   */
  FEISHU_OAUTH_REDIRECT_URI: emptyAsUndefined(z.string().url()),

  /** 管理后台登录口令 */
  ADMIN_PASSWORD: z.string().min(8),
  /** 管理后台 Cookie 签名密钥，留空则用 ADMIN_PASSWORD 派生 */
  ADMIN_SESSION_SECRET: emptyAsUndefined(z.string().min(16)),

  /** 单次任务最长执行时间（秒），超时由网关侧中断 */
  AGENT_TIMEOUT_SEC: z.coerce.number().int().positive().default(1800),
  /** 长轮询挂起时长（毫秒） */
  POLL_HOLD_MS: z.coerce.number().int().positive().default(25_000),
  /** 任务租约时长（毫秒），过期未上报视为掉线并重新排队 */
  RUN_LEASE_MS: z.coerce.number().int().positive().default(120_000),
  /** 任务最大重投次数 */
  RUN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  /** 在线判定窗口（秒）：最后心跳在此窗口内视为在线 */
  ONLINE_WINDOW_SEC: z.coerce.number().int().positive().default(60),

  /** trace 保留天数，过期只保留聚合统计 */
  TRACE_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  /** 单条 trace 摘要最大字符数 */
  TRACE_MAX_SUMMARY_CHARS: z.coerce.number().int().positive().default(2000),

  /** 绑定码有效期（秒） */
  ENROLL_TTL_SEC: z.coerce.number().int().positive().default(300),
  /** 日志级别，只允许 info / warn / error */
  LOG_LEVEL: z.enum(['info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof EnvSchema> & {
  /** 解析后的管理后台 Cookie 密钥 */
  sessionSecret: string;
  /** 是否具备飞书能力 */
  feishuReady: boolean;
  /** 是否启用扫码绑定（需要公网可达地址 + 网页授权回调） */
  oauthReady: boolean;
};

/**
 * 读取并校验环境变量。
 * @throws 配置缺失或非法时抛出，调用方负责打印后退出
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`配置校验失败: ${detail}`);
  }
  const value = parsed.data;
  const feishuReady = value.FEISHU_ENABLED && Boolean(value.FEISHU_APP_ID) && Boolean(value.FEISHU_APP_SECRET);
  if (value.FEISHU_ENABLED && !feishuReady) {
    throw new Error('FEISHU_ENABLED=true 时必须同时配置 FEISHU_APP_ID 与 FEISHU_APP_SECRET');
  }
  return {
    ...value,
    sessionSecret: value.ADMIN_SESSION_SECRET ?? `staff-agent:${value.ADMIN_PASSWORD}`,
    feishuReady,
    oauthReady: feishuReady && Boolean(value.PUBLIC_BASE_URL) && Boolean(value.FEISHU_OAUTH_REDIRECT_URI),
  };
}
