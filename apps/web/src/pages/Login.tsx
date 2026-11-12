import { useState } from 'react';
import { api } from '../api.js';
import { Spinner } from '../components/Common.js';

/**
 * 登录页。
 * - 员工：飞书网页授权登录，进入 Skill 广场
 * - 管理员：ADMIN_PASSWORD 口令登录，可访问全部后台
 * 未配置飞书网页授权时只展示口令登录（内网私有化也能用）。
 */
export function LoginPage({
  feishuLoginReady,
  onSuccess,
}: {
  feishuLoginReady: boolean;
  onSuccess: () => void;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.login(password);
      onSuccess();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const loginWithFeishu = (): void => {
    window.location.href = `/api/auth/feishu/start?return=${encodeURIComponent('/#/skills')}`;
  };

  return (
    <div className="center-screen">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark big">SA</span>
          <div>
            <h1>Staff Agent</h1>
            <p>Skill 广场 · 管理后台</p>
          </div>
        </div>

        {feishuLoginReady && (
          <>
            <button className="primary feishu-login" type="button" onClick={loginWithFeishu}>
              使用飞书登录
            </button>
            <p className="hint center">员工使用飞书账号登录后可上传、下载 Skill。</p>
            <div className="login-divider">
              <span>或使用管理员口令</span>
            </div>
          </>
        )}

        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <label className="field">
            <span>管理员口令</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="ADMIN_PASSWORD"
              autoFocus={!feishuLoginReady}
              autoComplete="current-password"
            />
          </label>
          {error && <div className="banner error">{error}</div>}
          <button className="primary" type="submit" disabled={loading || password.length === 0}>
            {loading ? <Spinner /> : '登录管理后台'}
          </button>
        </form>
        {!feishuLoginReady && (
          <p className="hint">
            未启用飞书网页登录：配置 PUBLIC_BASE_URL（或 FEISHU_WEB_REDIRECT_URI）后，员工可自助登录 Skill 广场。
          </p>
        )}
        <p className="hint">管理员口令由部署时设置的环境变量 ADMIN_PASSWORD 决定。</p>
      </div>
    </div>
  );
}
