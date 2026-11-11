import { useEffect, useState } from 'react';
import type { StatsView } from '@staff-agent/shared';
import { api, formatDuration, formatNumber } from '../api.js';
import { Card, ErrorBanner, Spinner, handleAuthError } from '../components/Common.js';

/** 统计窗口可选天数。 */
const RANGES = [1, 7, 30, 90];

/**
 * 概览页：管理员进来看的第一屏。
 * 关心四件事：多少 Agent 在线、跑了多少任务、成功率、消耗了多少 token。
 */
export function OverviewPage({ onUnauthorized }: { onUnauthorized: () => void }): React.JSX.Element {
  const [days, setDays] = useState(7);
  const [stats, setStats] = useState<StatsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    api
      .stats(days)
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(handleAuthError(loadError, onUnauthorized));
      });
    return () => {
      cancelled = true;
    };
  }, [days, onUnauthorized]);

  if (error) return <ErrorBanner message={error} />;
  if (!stats) return <Spinner />;

  const maxDaily = Math.max(1, ...stats.daily.map((day) => day.runs));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>概览</h1>
          <p className="sub">全公司个人 Agent 的运行情况</p>
        </div>
        <div className="segmented">
          {RANGES.map((range) => (
            <button key={range} className={days === range ? 'active' : ''} onClick={() => setDays(range)}>
              近 {range} 天
            </button>
          ))}
        </div>
      </header>

      <div className="metrics">
        <Metric label="Agent 总数" value={formatNumber(stats.totals.agents)} hint={`在线 ${stats.totals.agentsOnline}`} />
        <Metric label="任务数" value={formatNumber(stats.totals.runs)} hint={`成功 ${formatNumber(stats.totals.succeeded)}`} />
        <Metric
          label="成功率"
          value={`${(stats.totals.successRate * 100).toFixed(1)}%`}
          hint={`失败 ${formatNumber(stats.totals.failed)}`}
          tone={stats.totals.successRate >= 0.9 ? 'ok' : stats.totals.successRate >= 0.7 ? 'warn' : 'bad'}
        />
        <Metric label="平均耗时" value={formatDuration(stats.totals.avgDurationMs)} hint="单任务" />
        <Metric
          label="Token"
          value={formatNumber(stats.totals.inputTokens + stats.totals.outputTokens)}
          hint={`入 ${formatNumber(stats.totals.inputTokens)} / 出 ${formatNumber(stats.totals.outputTokens)}`}
        />
      </div>

      <div className="grid-2">
        <Card title="每日任务量">
          {stats.daily.length === 0 ? (
            <div className="empty">这段时间还没有任务</div>
          ) : (
            <div className="bars">
              {stats.daily.map((day) => (
                <div className="bar-row" key={day.date}>
                  <span className="bar-label">{day.date.slice(5)}</span>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${(day.runs / maxDaily) * 100}%` }} />
                  </div>
                  <span className="bar-value">{day.runs}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="运行时分布">
          {stats.runtimeSplit.length === 0 ? (
            <div className="empty">还没有 Agent</div>
          ) : (
            <ul className="kv-list">
              {stats.runtimeSplit.map((row) => (
                <li key={row.runtime}>
                  <span className="mono">{row.runtime}</span>
                  <span>{row.agents} 个 Agent</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="任务最多的 Agent">
          {stats.topAgents.length === 0 ? (
            <div className="empty">暂无数据</div>
          ) : (
            <table className="table compact">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th className="num">任务</th>
                  <th className="num">成功率</th>
                </tr>
              </thead>
              <tbody>
                {stats.topAgents.map((agent) => (
                  <tr key={agent.agentId}>
                    <td>{agent.name}</td>
                    <td className="num">{agent.runs}</td>
                    <td className="num">{(agent.successRate * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="工具调用 Top">
          {stats.toolTop.length === 0 ? (
            <div className="empty">暂无工具调用</div>
          ) : (
            <table className="table compact">
              <thead>
                <tr>
                  <th>工具</th>
                  <th className="num">次数</th>
                  <th className="num">平均耗时</th>
                  <th className="num">错误率</th>
                </tr>
              </thead>
              <tbody>
                {stats.toolTop.map((tool) => (
                  <tr key={tool.name}>
                    <td className="mono">{tool.name}</td>
                    <td className="num">{tool.count}</td>
                    <td className="num">{formatDuration(tool.avgDurationMs)}</td>
                    <td className="num">{(tool.errorRate * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}

/** 单个指标卡。 */
function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'ok' | 'warn' | 'bad';
}): React.JSX.Element {
  return (
    <div className={`metric ${tone ? `tone-${tone}` : ''}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {hint && <div className="metric-hint">{hint}</div>}
    </div>
  );
}
