import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { AgentsPage } from './pages/Agents.js';
import { OverviewPage } from './pages/Overview.js';
import { RunDetailPage } from './pages/RunDetail.js';
import { RunsPage } from './pages/Runs.js';
import { LoginPage } from './pages/Login.js';
import { Spinner } from './components/Common.js';

/** 路由种类。用 hash 路由，避免为三个页面引入 router 依赖。 */
export type Route =
  | { name: 'overview' }
  | { name: 'agents' }
  | { name: 'runs'; agentId?: string }
  | { name: 'run'; id: string };

/** 解析当前 hash。 */
function parseRoute(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '');
  if (clean.startsWith('agents')) return { name: 'agents' };
  if (clean.startsWith('runs/')) {
    const id = clean.slice('runs/'.length);
    if (id) return { name: 'run', id };
  }
  if (clean.startsWith('runs')) return { name: 'runs' };
  return { name: 'overview' };
}

/** 订阅 hash 变化。 */
function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((next: Route) => {
    const hash =
      next.name === 'run' ? `#/runs/${next.id}` : next.name === 'runs' ? '#/runs' : `#/${next.name}`;
    window.location.hash = hash;
  }, []);
  return [route, navigate];
}

/**
 * 管理后台根组件。
 * 鉴权状态为 null 时先探测会话，避免登录页闪烁。
 */
export function App(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [route, navigate] = useRoute();

  const checkSession = useCallback(async (): Promise<void> => {
    try {
      const session = await api.session();
      setAuthed(session.authenticated);
    } catch {
      setAuthed(false);
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  // 任何页面拿到 401 都退回登录页
  useEffect(() => {
    const onError = (): void => setAuthed(false);
    window.addEventListener('staff-agent:unauthorized', onError);
    return () => window.removeEventListener('staff-agent:unauthorized', onError);
  }, []);

  if (authed === null) {
    return (
      <div className="center-screen">
        <Spinner />
      </div>
    );
  }

  if (!authed) {
    return <LoginPage onSuccess={() => void checkSession()} />;
  }

  const logout = async (): Promise<void> => {
    try {
      await api.logout();
    } finally {
      setAuthed(false);
      window.location.hash = '';
    }
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">SA</span>
          <div>
            <div className="brand-title">Staff Agent</div>
            <div className="brand-sub">管理后台</div>
          </div>
        </div>
        <nav className="nav">
          <button
            className={`nav-item ${route.name === 'overview' ? 'active' : ''}`}
            onClick={() => navigate({ name: 'overview' })}
          >
            概览
          </button>
          <button
            className={`nav-item ${route.name === 'agents' ? 'active' : ''}`}
            onClick={() => navigate({ name: 'agents' })}
          >
            Agent 列表
          </button>
          <button
            className={`nav-item ${route.name === 'runs' || route.name === 'run' ? 'active' : ''}`}
            onClick={() => navigate({ name: 'runs' })}
          >
            任务与 Trace
          </button>
        </nav>
        <div className="sidebar-footer">
          <button className="nav-item ghost" onClick={() => void logout()}>
            退出登录
          </button>
        </div>
      </aside>
      <main className="content">
        {route.name === 'overview' && <OverviewPage onUnauthorized={() => setAuthed(false)} />}
        {route.name === 'agents' && (
          <AgentsPage
            onUnauthorized={() => setAuthed(false)}
            onOpenRuns={(agentId) => navigate({ name: 'runs', agentId })}
          />
        )}
        {route.name === 'runs' && (
          <RunsPage
            initialAgentId={route.agentId}
            onUnauthorized={() => setAuthed(false)}
            onOpenRun={(id) => navigate({ name: 'run', id })}
          />
        )}
        {route.name === 'run' && <RunDetailPage runId={route.id} onUnauthorized={() => setAuthed(false)} />}
      </main>
    </div>
  );
}
