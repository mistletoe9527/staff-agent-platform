import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';

/** 飞书文本消息单条最大字符数，超出拆条发送。 */
const MAX_TEXT_CHARS = 4_000;

/** 从飞书事件里抽取出的最小消息视图。 */
export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  threadId: string | null;
  messageType: string;
  text: string;
  senderOpenId: string;
  /** 被 @ 的人的 open_id 列表（不含机器人自己） */
  mentionedOpenIds: string[];
  /** 是否 @ 了机器人 */
  mentionedBot: boolean;
}

/** 飞书通讯录里的身份信息。 */
export interface FeishuProfile {
  /** 姓名（可能为空串） */
  name: string | null;
  /** 头像 URL，优先 240px */
  avatarUrl: string | null;
}

/** 飞书接口报错的归一化结果：带上原始 code/msg 与可执行的排查建议。 */
export interface FeishuApiError {
  /** 飞书业务错误码（拿不到时为 null） */
  code: number | null;
  /** 飞书原始错误信息 */
  msg: string;
  /** 面向管理员的中文排查建议（含申请权限链接） */
  hint: string;
}

/** 查身份的结果：失败时 profile 为 null，error 说明原因，后台可直接展示。 */
export interface ProfileLookup {
  profile: FeishuProfile | null;
  error: FeishuApiError | null;
}

/**
 * 通讯录接口用 tenant_access_token（应用身份）调用，需要的是 `contact:contact.base:readonly`。
 * 注意与 `contact:user.base:readonly` 区分：后者是「用户身份」权限，配了也拿不到应用身份调用。
 */
const CONTACT_APP_SCOPE = 'contact:contact.base:readonly';

/** 把飞书错误码翻译成管理员能直接照做的处理建议。 */
function describeFeishuError(
  code: number | null,
  msg: string,
  config: Pick<Config, 'FEISHU_APP_ID' | 'FEISHU_OPEN_BASE'>,
): FeishuApiError {
  const applyUrl = `${config.FEISHU_OPEN_BASE}/app/${config.FEISHU_APP_ID ?? ''}/auth?q=${CONTACT_APP_SCOPE}&op_from=openapi&token_type=tenant`;
  if (code === 99991672 || (code === null && /scope|权限/i.test(msg))) {
    return {
      code,
      msg,
      hint: `应用缺少通讯录权限：开放平台「权限管理」添加 ${CONTACT_APP_SCOPE}（应用身份；不是 contact:user.base:readonly），然后创建版本发布并由企业管理员审核通过。申请链接：${applyUrl}`,
    };
  }
  if (code === 41050 || code === 41054) {
    return {
      code,
      msg,
      hint: `权限已具备，但该员工不在应用的通讯录权限范围（数据权限）内：开放平台「权限管理 → 数据权限」把可见范围设为全员或包含该员工，再发布版本。`,
    };
  }
  if (code === 99991663 || code === 99991661) {
    return {
      code,
      msg,
      hint: 'tenant_access_token 无效：检查 FEISHU_APP_ID / FEISHU_APP_SECRET 与 FEISHU_OPEN_BASE（国内 open.feishu.cn / 国际 open.larksuite.com）是否匹配，改完重启服务。',
    };
  }
  return {
    code,
    msg,
    hint: `查询通讯录失败（飞书返回 ${code ?? '未知错误'}）：检查 ${CONTACT_APP_SCOPE} 是否已开通并发布版本、通讯录可见范围是否包含该员工。`,
  };
}

/** 飞书能力端口：平台其余部分只依赖这个接口，便于关闭飞书时降级。 */
export interface FeishuPort {
  onMessage(handler: (message: IncomingMessage) => void): void;
  start(): Promise<void>;
  stop(): void;
  connectionState(): string;
  getBotOpenId(): Promise<string | null>;
  sendText(chatId: string, text: string): Promise<void>;
  replyText(messageId: string, text: string): Promise<void>;
  /** 查飞书用户的姓名与头像；缺权限时 profile 为 null 且带上 error，由调用方降级 */
  getProfile(openId: string): Promise<ProfileLookup>;
}

/**
 * 飞书客户端封装。
 * 只暴露平台需要的四个能力：收消息、发消息、回消息、查人名。
 * 所有凭证来自环境变量，代码不落任何 app_secret。
 */
export class FeishuClient implements FeishuPort {
  private readonly client: Lark.Client;
  private ws: Lark.WSClient | null = null;
  private botOpenId: string | null = null;
  private messageHandler: ((message: IncomingMessage) => void) | null = null;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.client = new Lark.Client({
      appId: config.FEISHU_APP_ID as string,
      appSecret: config.FEISHU_APP_SECRET as string,
      loggerLevel: Lark.LoggerLevel.info,
    });
  }

  /** 注册消息处理函数（同步返回，实际处理由调用方自行异步化）。 */
  onMessage(handler: (message: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  /** 建立飞书长连接。不依赖公网回调地址，容器在内网即可。 */
  async start(): Promise<void> {
    const dispatcher = new Lark.EventDispatcher({
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
      encryptKey: process.env.FEISHU_ENCRYPT_KEY,
    }).register({
      'im.message.receive_v1': async (data) => {
        try {
          const message = this.normalize(data as unknown as Record<string, unknown>);
          if (!message) {
            // 明确记录丢弃原因：字段缺失通常意味着事件结构变化
            this.logger.warn({ raw: JSON.stringify(data).slice(0, 500) }, '飞书消息字段缺失，已丢弃');
            return;
          }
          // 收到的每一条消息都留痕：没有这行日志 = 事件根本没到平台（飞书后台配置问题）
          this.logger.info(
            {
              messageId: message.messageId,
              chatType: message.chatType,
              messageType: message.messageType,
              textLength: message.text.length,
              textPreview: message.text.slice(0, 40),
              mentionedBot: message.mentionedBot,
              senderOpenId: message.senderOpenId,
            },
            '收到飞书消息',
          );
          this.messageHandler?.(message);
        } catch (error) {
          this.logger.error({ err: String(error) }, '飞书消息解析失败');
        }
      },
    });
    this.ws = new Lark.WSClient({
      appId: this.config.FEISHU_APP_ID as string,
      appSecret: this.config.FEISHU_APP_SECRET as string,
      loggerLevel: Lark.LoggerLevel.info,
    });
    await this.ws.start({ eventDispatcher: dispatcher });
    this.logger.info({}, '飞书长连接已建立');
  }

  /** 关闭长连接。 */
  stop(): void {
    this.ws?.close({ force: true });
    this.ws = null;
  }

  /** 当前长连接状态，供健康检查使用。 */
  connectionState(): string {
    return this.ws?.getConnectionStatus().state ?? 'stopped';
  }

  /** 获取机器人自身 open_id，用于判断消息是否 @ 了机器人。 */
  async getBotOpenId(): Promise<string | null> {
    if (this.botOpenId) return this.botOpenId;
    const response = (await this.client.request({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    })) as { bot?: { open_id?: string } };
    this.botOpenId = response.bot?.open_id ?? null;
    return this.botOpenId;
  }

  /** 发送文本消息到会话。 */
  async sendText(chatId: string, text: string): Promise<void> {
    for (const chunk of splitText(text)) {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: chunk }),
        },
      });
    }
  }

  /** 回复指定消息（在飞书里显示为对该消息的引用回复）。 */
  async replyText(messageId: string, text: string): Promise<void> {
    const chunks = splitText(text);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] as string;
      if (index === 0) {
        await this.client.im.v1.message.reply({
          path: { message_id: messageId },
          data: { msg_type: 'text', content: JSON.stringify({ text: chunk }) },
        });
      } else {
        await this.client.im.v1.message.reply({
          path: { message_id: messageId },
          data: { msg_type: 'text', content: JSON.stringify({ text: chunk }) },
        });
      }
    }
  }

  /**
   * 查询飞书用户姓名与头像。需要 contact:contact.base:readonly（应用身份）；
   * 失败时 profile 为 null，同时把飞书的 code/msg 与处理建议一并返回，
   * 由调用方降级为 open_id 后缀 + 首字母占位头像。
   */
  async getProfile(openId: string): Promise<ProfileLookup> {
    try {
      const response = (await this.client.contact.v3.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      })) as {
        data?: {
          user?: {
            name?: string;
            avatar?: { avatar_240?: string; avatar_72?: string; avatar_origin?: string } | null;
          };
        };
      };
      const user = response.data?.user;
      const name = user?.name?.trim() || null;
      const avatarUrl = user?.avatar?.avatar_240 ?? user?.avatar?.avatar_72 ?? user?.avatar?.avatar_origin ?? null;
      if (!name && !avatarUrl) return { profile: null, error: null };
      return { profile: { name, avatarUrl }, error: null };
    } catch (error) {
      // SDK 抛的是 axios 错误：业务码在 response.data.code/msg 里
      const data = (error as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
      const code = typeof data?.code === 'number' ? data.code : null;
      const msg = data?.msg ?? (error instanceof Error ? error.message : String(error));
      const apiError = describeFeishuError(code, msg, this.config);
      // 把真实原因打进日志：只留一句「降级」会让权限问题永远查不出来
      this.logger.warn(
        { openId, feishuCode: apiError.code, feishuMsg: msg.slice(0, 300), hint: apiError.hint },
        '查询飞书用户身份失败，降级为默认名/无头像',
      );
      return { profile: null, error: apiError };
    }
  }

  /** 把飞书事件归一化成平台内部结构。 */
  private normalize(data: Record<string, unknown>): IncomingMessage | null {
    const message = data.message as Record<string, unknown> | undefined;
    const sender = data.sender as Record<string, unknown> | undefined;
    if (!message) return null;
    const senderId = (sender?.sender_id ?? {}) as Record<string, string>;
    const messageId = String(message.message_id ?? '');
    const chatId = String(message.chat_id ?? '');
    if (!messageId || !chatId) return null;

    const mentions = (message.mentions ?? []) as Array<{ id?: Record<string, string>; name?: string }>;
    const botOpenId = this.botOpenId;
    const mentionedOpenIds: string[] = [];
    let mentionedBot = false;
    for (const mention of mentions) {
      const openId = mention.id?.open_id;
      if (!openId) continue;
      if (botOpenId && openId === botOpenId) {
        mentionedBot = true;
      } else {
        mentionedOpenIds.push(openId);
      }
    }

    const messageType = String(message.message_type ?? '');
    let text = '';
    if (messageType === 'text') {
      text = extractText(String(message.content ?? ''));
    }

    return {
      messageId,
      chatId,
      chatType: String(message.chat_type ?? ''),
      threadId: message.thread_id ? String(message.thread_id) : null,
      messageType,
      text,
      senderOpenId: senderId.open_id ?? '',
      mentionedOpenIds,
      mentionedBot,
    };
  }
}

/** 解析飞书文本消息 content。 */
function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return (parsed.text ?? '').trim();
  } catch {
    return '';
  }
}

/** 按最大长度切分文本，保留完整换行边界。 */
function splitText(text: string): string[] {
  if (text.length <= MAX_TEXT_CHARS) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_TEXT_CHARS) {
    const slice = rest.slice(0, MAX_TEXT_CHARS);
    const breakAt = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('。'));
    const cut = breakAt > MAX_TEXT_CHARS * 0.6 ? breakAt + 1 : MAX_TEXT_CHARS;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * 关闭飞书时的空实现。
 * 平台仍可启动、管理后台仍可用，只是不接收飞书消息。
 */
export class NoopFeishuClient implements FeishuPort {
  constructor(private readonly logger: Logger) {}

  onMessage(): void {}

  async start(): Promise<void> {
    this.logger.warn({}, '飞书已关闭（FEISHU_ENABLED=false），不会接收消息');
  }

  stop(): void {}

  connectionState(): string {
    return 'disabled';
  }

  async getBotOpenId(): Promise<string | null> {
    return null;
  }

  async sendText(): Promise<void> {}

  async replyText(): Promise<void> {}

  async getProfile(): Promise<ProfileLookup> {
    return { profile: null, error: null };
  }
}
