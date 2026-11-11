import { useState } from 'react';
import { api } from '../api.js';
import { Spinner } from '../components/Common.js';

/**
 * 登录页。
 * 私有化单租户部署，用管理员口令登录；不依赖飞书网页授权，内网也能用。
 */
export function LoginPage({ onSuccess }: { onSuccess: () => void }): React.JSX.Element {
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

  return (
    <div className="center-screen">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <div className="login-brand">
          <span className="brand-mark big">SA</span>
          <div>
            <h1>Staff Agent</h1>
            <p>管理后台</p>
          </div>
        </div>
        <label className="field">
          <span>管理员口令</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="ADMIN_PASSWORD"
            autoFocus
            autoComplete="current-password"
          />
        </label>
        {error && <div className="banner error">{error}</div>}
        <button className="primary" type="submit" disabled={loading || password.length === 0}>
          {loading ? <Spinner /> : '登录'}
        </button>
        <p className="hint">口令由部署时设置的环境变量 ADMIN_PASSWORD 决定。</p>
      </form>
    </div>
  );
}
