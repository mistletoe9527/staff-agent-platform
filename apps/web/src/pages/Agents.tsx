import { useEffect, useState } from 'react';
import type { AgentStatus, AgentView } from '@staff-agent/shared';
import { api, formatTime } from '../api.js';
import {
  AgentStatusBadge,
  Avatar,
  Card,
  EmptyState,
  ErrorBanner,
  OnlineDot,
  Spinner,
  handleAuthError,
} from '../components/Common.js';

/**
 * Agent 列表页。
 * 管理员在这里看「数字员工」：谁绑了、飞书是谁、哪台机器、在不在线，并做启用/禁用、改名、强制下线。
 * 子 Agent（工作区）是员工本机的事，不进这张表。
 */
export function AgentsPage({
  onUnauthorized,
  onOpenRuns,
}: {
  onUnauthorized: () => void;
  onOpenRuns: (agentId: string) => void;
}): React.JSX.Element {
  const [items, setItems] = useState<AgentView[] | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<AgentStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = (): void => {
    setError(null);
    api
      .agents({ q: query.trim() || undefined, status: status || undefined })
      .then((result) => setItems(result.items))
      .catch((loadError: unknown) => setError(handleAuthError(loadError, onUnauthorized)));
  };

  useEffect(() => {
    const timer = setTimeout(load, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, status]);

  const toggleStatus = async (agent: AgentView): Promise<void> => {
    setBusyId(agent.id);
    try {
      await api.updateAgent(agent.id, { status: agent.status === 'active' ? 'disabled' : 'active' });
      load();
    } catch (mutationError) {
      setError(handleAuthError(mutationError, onUnauthorized));
    } finally {
      setBusyId(null);
    }
  };

  const rename = async (agent: AgentView): Promise<void> => {
    const name = window.prompt('新的 Agent 名称', agent.name)?.trim();
    if (!name || name === agent.name) return;
    setBusyId(agent.id);
    try {
      await api.updateAgent(agent.id, { name });
      load();
    } catch (mutationError) {
      setError(handleAuthError(mutationError, onUnauthorized));
    } finally {
      setBusyId(null);
    }
  };

  const editDescription = async (agent: AgentView): Promise<void> => {
    const description = window.prompt(
      `「${agent.name}」的工作区描述（留空表示清除，客户端会按目录重新生成）`,
      agent.description ?? '',
    );
    if (description === null) return;
    setBusyId(agent.id);
    try {
      await api.updateAgent(agent.id, { description: description.trim() || null });
      load();
    } catch (mutationError) {
      setError(handleAuthError(mutationError, onUnauthorized));
    } finally {
      setBusyId(null);
    }
  };

  const kick = async (agent: AgentView): Promise<void> => {
    if (!window.confirm(`确定让「${agent.name}」的机器下线吗？下线后对方需要重新登录。`)) return;
    setBusyId(agent.id);
    try {
      await api.kick(agent.id);
      load();
    } catch (mutationError) {
      setError(handleAuthError(mutationError, onUnauthorized));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (agent: AgentView): Promise<void> => {
    const answer = window.prompt(
      `删除数字员工「${agent.name}」是不可逆的：\n` +
        '· 设备令牌立即失效，对方需要重新 sa login\n' +
        '· 会话上下文清空，重新绑定后开启新会话\n' +
        '· 历史任务与 trace 保留（显示为「已删除的 Agent」）\n\n' +
        `确认请输入该 Agent 的名字：`,
      '',
    );
    if (answer === null) return;
    if (answer.trim() !== agent.name.trim()) {
      setError('输入的名字不匹配，已取消删除');
      return;
    }
    setBusyId(agent.id);
    setError(null);
    try {
      await api.deleteAgent(agent.id, agent.name);
      load();
    } catch (mutationError) {
      setError(handleAuthError(mutationError, onUnauthorized));
    } finally {
      setBusyId(null);
    }
  };

  const syncProfile = async (agent: AgentView): Promise<void> => {
    setBusyId(agent.id);
    setError(null);
    try {
      await api.syncProfile(agent.id);
      load();
    } catch (mutationError) {
      setError(handleAuthError(mutationError, onUnauthorized));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Agent 列表</h1>
          <p className="sub">飞书身份、设备与运行时的对应关系</p>
        </div>
        <div className="filters">
          <input
            placeholder="搜索名称、描述或工作目录"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select value={status} onChange={(event) => setStatus(event.target.value as AgentStatus | '')}>
            <option value="">全部状态</option>
            <option value="active">启用</option>
            <option value="disabled">禁用</option>
          </select>
        </div>
      </header>

      <ErrorBanner message={error} />

      <Card>
        {items === null ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState text="还没有 Agent。让员工在本机运行 sa login 完成绑定。" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>数字员工</th>
                <th>飞书身份</th>
                <th>主工作区</th>
                <th>运行时</th>
                <th>机器</th>
                <th>最近心跳</th>
                <th className="num">近 7 天</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((agent) => (
                <tr key={agent.id}>
                  <td>
                    <div className="cell-main">
                      <OnlineDot online={agent.device?.online ?? false} />
                      <Avatar name={agent.feishuName ?? agent.name} url={agent.feishuAvatarUrl} />
                      <span>{agent.feishuName ?? agent.name}</span>
                      <AgentStatusBadge status={agent.status} />
                    </div>
                    <div className="cell-sub mono">
                      {agent.name} · {agent.id}
                    </div>
                  </td>
                  <td className="mono small">{agent.feishuOpenId}</td>
                  <td>
                    <div className="mono small">{agent.cwd ?? <span className="muted">未上报目录</span>}</div>
                    <div className="cell-sub">{agent.description ?? '未上报职责说明'}</div>
                  </td>
                  <td>
                    <span className="badge neutral">{agent.runtime}</span>
                    {agent.device?.runtimeVersion && (
                      <div className="cell-sub mono">{agent.device.runtimeVersion}</div>
                    )}
                  </td>
                  <td>
                    {agent.device ? (
                      <>
                        <div>{agent.device.machineName}</div>
                        <div className="cell-sub">
                          {agent.device.bridgeState === 'busy' ? '执行中' : agent.device.online ? '空闲' : '离线'}
                        </div>
                      </>
                    ) : (
                      <span className="muted">未绑定设备</span>
                    )}
                  </td>
                  <td className="small">{formatTime(agent.device?.lastSeenAt ?? null)}</td>
                  <td className="num">
                    {agent.runs7d}
                    <div className="cell-sub">成功 {agent.success7d}</div>
                  </td>
                  <td>
                    <div className="actions">
                      <button className="link" onClick={() => onOpenRuns(agent.id)}>
                        任务
                      </button>
                      <button className="link" disabled={busyId === agent.id} onClick={() => void rename(agent)}>
                        改名
                      </button>
                      <button
                        className="link"
                        disabled={busyId === agent.id}
                        onClick={() => void editDescription(agent)}
                      >
                        改描述
                      </button>
                      <button className="link" disabled={busyId === agent.id} onClick={() => void toggleStatus(agent)}>
                        {agent.status === 'active' ? '禁用' : '启用'}
                      </button>
                      <button
                        className="link"
                        disabled={busyId === agent.id}
                        onClick={() => void syncProfile(agent)}
                        title="重新从飞书通讯录拉姓名与头像"
                      >
                        同步身份
                      </button>
                      <button
                        className="link danger"
                        disabled={busyId === agent.id || !agent.device}
                        onClick={() => void kick(agent)}
                      >
                        强制下线
                      </button>
                      <button className="link danger" disabled={busyId === agent.id} onClick={() => void remove(agent)}>
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
