import { useEffect, useState } from 'react';
import type { RunStatus, RunView } from '@staff-agent/shared';
import { api, formatDuration, formatTime } from '../api.js';
import { Card, EmptyState, ErrorBanner, RunStatusBadge, Spinner, handleAuthError } from '../components/Common.js';

/** 可筛选的任务状态。 */
const STATUSES: Array<{ value: RunStatus | ''; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'running', label: '执行中' },
  { value: 'queued', label: '排队中' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'timeout', label: '超时' },
  { value: 'canceled', label: '已取消' },
];

/**
 * 任务列表页。
 * 支持按 Agent / 状态 / 时间窗口筛选，游标分页，点击进入 trace 详情。
 */
export function RunsPage({
  initialAgentId,
  onUnauthorized,
  onOpenRun,
}: {
  initialAgentId?: string;
  onUnauthorized: () => void;
  onOpenRun: (id: string) => void;
}): React.JSX.Element {
  const [items, setItems] = useState<RunView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus | ''>('');
  const [days, setDays] = useState(7);
  const [agentId, setAgentId] = useState(initialAgentId ?? '');
  const [error, setError] = useState<string | null>(null);

  const load = (nextPage: string | null): void => {
    setError(null);
    setItems(null);
    api
      .runs({
        agentId: agentId.trim() || undefined,
        status: status || undefined,
        days,
        cursor: nextPage ?? undefined,
        limit: 30,
      })
      .then((result) => {
        setItems(result.items);
        setNextCursor(result.nextCursor);
      })
      .catch((loadError: unknown) => setError(handleAuthError(loadError, onUnauthorized)));
  };

  useEffect(() => {
    setCursor(null);
    load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, days, initialAgentId]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>任务与 Trace</h1>
          <p className="sub">每一次飞书指令的执行结果与步骤明细</p>
        </div>
        <div className="filters">
          <input
            placeholder="按 Agent ID 过滤"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') load(null);
            }}
          />
          <select value={status} onChange={(event) => setStatus(event.target.value as RunStatus | '')}>
            {STATUSES.map((item) => (
              <option key={item.value || 'all'} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
            <option value={1}>近 1 天</option>
            <option value={7}>近 7 天</option>
            <option value={30}>近 30 天</option>
            <option value={90}>近 90 天</option>
          </select>
        </div>
      </header>

      <ErrorBanner message={error} />

      <Card>
        {items === null ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState text="没有符合条件的任务" />
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>Agent</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th className="num">耗时</th>
                  <th className="num">Token</th>
                </tr>
              </thead>
              <tbody>
                {items.map((run) => (
                  <tr key={run.id} className="clickable" onClick={() => onOpenRun(run.id)}>
                    <td>
                      <div className="truncate">{run.promptPreview}</div>
                      <div className="cell-sub mono">{run.id}</div>
                    </td>
                    <td>{run.agentName}</td>
                    <td>
                      <RunStatusBadge status={run.status} />
                      {run.error && <div className="cell-sub danger-text truncate">{run.error}</div>}
                    </td>
                    <td className="small">{formatTime(run.createdAt)}</td>
                    <td className="num">{formatDuration(run.durationMs)}</td>
                    <td className="num small">
                      {run.inputTokens + run.outputTokens > 0
                        ? `${run.inputTokens}/${run.outputTokens}`
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pager">
              <button className="link" disabled={!cursor} onClick={() => { setCursor(null); load(null); }}>
                回到第一页
              </button>
              <button
                className="link"
                disabled={!nextCursor}
                onClick={() => {
                  setCursor(nextCursor);
                  load(nextCursor);
                }}
              >
                下一页
              </button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
