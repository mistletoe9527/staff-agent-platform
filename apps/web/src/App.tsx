import { useCallback, useEffect, useState } from 'react';
import type { MeResponse } from '@staff-agent/shared';
import { api } from './api.js';
import { AgentsPage } from './pages/Agents.js';
import { OverviewPage } from './pages/Overview.js';
import { RunDetailPage } from './pages/RunDetail.js';
import { RunsPage } from './pages/Runs.js';
import { SkillsPage } from './pages/Skills.js';
import { LoginPage } from './pages/Login.js';
import { Spinner } from './components/Common.js';

/** 路由种类。用 hash 路由，避免引入 router 依赖。 */
export type Route =
  | { name: 'overview' }
  | { name: 'agents' }
  | { name: 'runs'; agentId?: string }
  | { name: 'run'; id: string }
  | { name: 'skills' };

/** 解析当前 hash。 */
function parseRoute(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '');
  if (clean.startsWith('agents')) return { name: 'agents' };
  if (clean.startsWith('skills')) return { name: 'skills' };
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

/** 空登录态：保留飞书登录可用性，避免退登后按钮消失。 */
function signedOut(feishuLoginReady: boolean): MeResponse {
  return { authenticated: false, user: null, feishuLoginReady };
}

/**
 * 平台根组件。
 * 两种身份共用同一套页面：
 * - 管理员口令登录：概览 / Agent / 任务 / Skill 广场
 * - 员工飞书登录：只有 Skill 广场
 */
export function App(): React.JSX.Element {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [route, navigate] = useRoute();

  const checkSession = useCallback(async (): Promise<void> => {
    try {
      setMe(await api.me());
    } catch {
      setMe(signedOut(false));
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  // 任何页面拿到 401 都退回登录页，同时保留飞书登录入口状态
  const handleUnauthorized = useCallback(() => {
    setMe((current) => signedOut(current?.feishuLoginReady ?? false));
  }, []);

  useEffect(() => {
    const onError = (): void => handleUnauthorized();
    window.addEventListener('staff-agent:unauthorized', onError);
    return () => window.removeEventListener('staff-agent:unauthorized', onError);
  }, [handleUnauthorized]);

  const viewer = me?.authenticated ? me.user : null;

  // 员工只能进 Skill 广场，手改 hash 也拉回来
  useEffect(() => {
    if (viewer && !viewer.isAdmin && route.name !== 'skills') {
      window.location.hash = '#/skills';
    }
  }, [viewer, route.name]);

  if (me === null) {
    return (
      <div className="center-screen">
        <Spinner />
      </div>
    );
  }

  if (!viewer) {
    return <LoginPage feishuLoginReady={me.feishuLoginReady} onSuccess={() => void checkSession()} />;
  }

  const logout = async (): Promise<void> => {
    try {
      await api.logout();
    } finally {
      setMe(signedOut(me.feishuLoginReady));
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
            <div className="brand-sub">{viewer.isAdmin ? '管理后台' : '员工入口'}</div>
          </div>
        </div>
        <nav className="nav">
          {viewer.isAdmin && (
            <>
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
            </>
          )}
          <button
            className={`nav-item ${route.name === 'skills' ? 'active' : ''}`}
            onClick={() => navigate({ name: 'skills' })}
          >
            Skill 广场
          </button>
        </nav>
        <div className="sidebar-footer">
          <div className="viewer-chip">
            <span className="dot online" />
            <span className="small">{viewer.name}</span>
          </div>
          <button className="nav-item ghost" onClick={() => void logout()}>
            退出登录
          </button>
        </div>
      </aside>
      <main className="content">
        {viewer.isAdmin && route.name === 'overview' && <OverviewPage onUnauthorized={handleUnauthorized} />}
        {viewer.isAdmin && route.name === 'agents' && (
          <AgentsPage
            onUnauthorized={handleUnauthorized}
            onOpenRuns={(agentId) => navigate({ name: 'runs', agentId })}
          />
        )}
        {viewer.isAdmin && route.name === 'runs' && (
          <RunsPage
            initialAgentId={route.agentId}
            onUnauthorized={handleUnauthorized}
            onOpenRun={(id) => navigate({ name: 'run', id })}
          />
        )}
        {viewer.isAdmin && route.name === 'run' && (
          <RunDetailPage runId={route.id} onUnauthorized={handleUnauthorized} />
        )}
        {(route.name === 'skills' || !viewer.isAdmin) && (
          <SkillsPage user={viewer} onUnauthorized={handleUnauthorized} />
        )}
      </main>
    </div>
  );
}
