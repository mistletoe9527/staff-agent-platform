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

/** 飞书能力端口：平台其余部分只依赖这个接口，便于关闭飞书时降级。 */
export interface FeishuPort {
  onMessage(handler: (message: IncomingMessage) => void): void;
  start(): Promise<void>;
  stop(): void;
  connectionState(): string;
  getBotOpenId(): Promise<string | null>;
  sendText(chatId: string, text: string): Promise<void>;
  replyText(messageId: string, text: string): Promise<void>;
  getUserName(openId: string): Promise<string | null>;
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
          if (!message) return;
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
   * 查询飞书用户姓名。需要 contact:user.base:readonly 权限；
   * 没有权限时返回 null，由调用方降级为 open_id 后缀。
   */
  async getUserName(openId: string): Promise<string | null> {
    try {
      const response = (await this.client.contact.v3.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      })) as { data?: { user?: { name?: string } } };
      return response.data?.user?.name ?? null;
    } catch (error) {
      this.logger.warn({ err: String(error), openId }, '查询飞书用户姓名失败，降级为默认名');
      return null;
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

  async getUserName(): Promise<string | null> {
    return null;
  }
}
