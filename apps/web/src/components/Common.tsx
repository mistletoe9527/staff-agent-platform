import type { AgentStatus, RunStatus } from '@staff-agent/shared';
import { UnauthorizedError } from '../api.js';

/** 加载中指示器。 */
export function Spinner(): React.JSX.Element {
  return <div className="spinner" role="status" aria-label="加载中" />;
}

/** 空状态。 */
export function EmptyState({ text }: { text: string }): React.JSX.Element {
  return <div className="empty">{text}</div>;
}

/** 错误提示条。 */
export function ErrorBanner({ message }: { message: string | null }): React.JSX.Element | null {
  if (!message) return null;
  return <div className="banner error">{message}</div>;
}

/** 卡片容器。 */
export function Card({
  title,
  extra,
  children,
  className = '',
}: {
  title?: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <section className={`card ${className}`}>
      {(title || extra) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {extra}
        </header>
      )}
      {children}
    </section>
  );
}

/** 任务状态徽标。 */
export function RunStatusBadge({ status }: { status: RunStatus }): React.JSX.Element {
  const label: Record<RunStatus, string> = {
    queued: '排队中',
    running: '执行中',
    succeeded: '成功',
    failed: '失败',
    canceled: '已取消',
    timeout: '超时',
  };
  return <span className={`badge run-${status}`}>{label[status]}</span>;
}

/** Agent 状态徽标。 */
export function AgentStatusBadge({ status }: { status: AgentStatus }): React.JSX.Element {
  return <span className={`badge ${status === 'active' ? 'agent-active' : 'agent-disabled'}`}>{status === 'active' ? '启用' : '禁用'}</span>;
}

/** 在线状态点。 */
export function OnlineDot({ online }: { online: boolean }): React.JSX.Element {
  return <span className={`dot ${online ? 'online' : 'offline'}`} title={online ? '在线' : '离线'} />;
}

/**
 * 统一处理页面请求错误：401 触发退登，其余显示原因。
 * @returns 可直接渲染的错误文案
 */
export function handleAuthError(error: unknown, onUnauthorized: () => void): string {
  if (error instanceof UnauthorizedError) {
    onUnauthorized();
    return '会话已过期，请重新登录';
  }
  return error instanceof Error ? error.message : String(error);
}
