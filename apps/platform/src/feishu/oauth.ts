import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';

/** 缓存 app_access_token，有效期 2 小时，这里提前 5 分钟刷新。 */
interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * 飞书网页授权：扫码绑定 + 员工登录 Skill 广场。
 *
 * 绑定需要 PUBLIC_BASE_URL 与 FEISHU_OAUTH_REDIRECT_URI；
 * 员工登录只需要飞书应用凭证 + FEISHU_WEB_REDIRECT_URI（或由 PUBLIC_BASE_URL 派生）。
 * 内网私有化部署且手机不可达时，绑定流程自动退化为「页面展示绑定码」。
 */
export class FeishuOAuth {
  private cached: CachedToken | null = null;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  /** 是否可用。 */
  enabled(): boolean {
    return this.config.oauthReady;
  }

  /** 构造授权跳转地址。state 由调用方决定（绑定码或登录回跳地址的签名）。 */
  authorizeUrl(state: string, redirectUri?: string): string {
    const redirect = encodeURIComponent(redirectUri ?? (this.config.FEISHU_OAUTH_REDIRECT_URI as string));
    const appId = encodeURIComponent(this.config.FEISHU_APP_ID as string);
    const encodedState = encodeURIComponent(state);
    return `${this.config.FEISHU_OPEN_BASE}/open-apis/authen/v1/authorize?app_id=${appId}&redirect_uri=${redirect}&state=${encodedState}`;
  }

  /**
   * 用授权 code 换取 open_id 与姓名。
   * @returns 失败返回 null，调用方展示可读错误页
   */
  async exchange(code: string): Promise<{ openId: string; name: string | null } | null> {
    // 绑定回调与员工登录共用同一个换码逻辑：只要飞书应用凭证可用即可，
    // 不要求配置绑定专用的 FEISHU_OAUTH_REDIRECT_URI。
    if (!this.config.feishuReady) return null;
    try {
      const appToken = await this.getAppAccessToken();
      const tokenResponse = await fetch(`${this.config.FEISHU_OPEN_BASE}/open-apis/authen/v1/oidc/access_token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${appToken}`,
        },
        body: JSON.stringify({ grant_type: 'authorization_code', code }),
      });
      const tokenPayload = (await tokenResponse.json()) as {
        code?: number;
        msg?: string;
        data?: { access_token?: string };
      };
      const userToken = tokenPayload.data?.access_token;
      if (!userToken) {
        this.logger.warn({ code: tokenPayload.code, msg: tokenPayload.msg }, '飞书 OAuth 换 token 失败');
        return null;
      }
      const infoResponse = await fetch(`${this.config.FEISHU_OPEN_BASE}/open-apis/authen/v1/user_info`, {
        method: 'GET',
        headers: { authorization: `Bearer ${userToken}` },
      });
      const infoPayload = (await infoResponse.json()) as {
        code?: number;
        data?: { open_id?: string; name?: string };
      };
      const openId = infoPayload.data?.open_id;
      if (!openId) {
        this.logger.warn({ code: infoPayload.code }, '飞书 OAuth 获取用户信息失败');
        return null;
      }
      return { openId, name: infoPayload.data?.name ?? null };
    } catch (error) {
      this.logger.error({ err: String(error) }, '飞书 OAuth 请求异常');
      return null;
    }
  }

  /** 获取并缓存 app_access_token。 */
  private async getAppAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.token;
    const response = await fetch(`${this.config.FEISHU_OPEN_BASE}/open-apis/auth/v3/app_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        app_id: this.config.FEISHU_APP_ID,
        app_secret: this.config.FEISHU_APP_SECRET,
      }),
    });
    const payload = (await response.json()) as { app_access_token?: string; expire?: number };
    if (!payload.app_access_token) {
      throw new Error('获取 app_access_token 失败');
    }
    const ttlMs = (payload.expire ?? 7200) * 1000;
    this.cached = { token: payload.app_access_token, expiresAt: Date.now() + ttlMs - 300_000 };
    return payload.app_access_token;
  }
}
