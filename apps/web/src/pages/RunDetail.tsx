import { useEffect, useState } from 'react';
import type { RunDetail } from '@staff-agent/shared';
import { api, formatDuration, formatTime } from '../api.js';
import { Card, ErrorBanner, RunStatusBadge, Spinner, handleAuthError } from '../components/Common.js';

/** 步骤类型的中文名与配色类。 */
const STEP_META: Record<string, { label: string; className: string }> = {
  llm: { label: '模型', className: 'step-llm' },
  tool: { label: '工具', className: 'step-tool' },
  message: { label: '回复', className: 'step-message' },
  thinking: { label: '思考', className: 'step-thinking' },
  error: { label: '错误', className: 'step-error' },
};

/**
 * 任务详情页：一次任务的完整 trace。
 * 这是"平台能看到所有个人 Agent 的 trace"这句话最终落地的地方。
 */
export function RunDetailPage({
  runId,
  onUnauthorized,
}: {
  runId: string;
  onUnauthorized: () => void;
}): React.JSX.Element {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRun(null);
    api
      .run(runId)
      .then(setRun)
      .catch((loadError: unknown) => setError(handleAuthError(loadError, onUnauthorized)));
  }, [runId, onUnauthorized]);

  if (error) return <ErrorBanner message={error} />;
  if (!run) return <Spinner />;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="crumbs">
            <a href="#/runs">任务与 Trace</a>
            <span>/</span>
            <span className="mono">{run.id}</span>
          </div>
          <h1>
            {run.agentName} <RunStatusBadge status={run.status} />
          </h1>
          <p className="sub">
            {formatTime(run.createdAt)} · 耗时 {formatDuration(run.durationMs)} · 输入 {run.inputTokens} / 输出{' '}
            {run.outputTokens} tokens
          </p>
          <p className="sub mono">工作区：{run.cwd ?? '未指定（用主工作目录）'}</p>
        </div>
      </header>

      {run.error && <div className="banner error">{run.error}</div>}

      <Card title="指令">
        <pre className="code-block">{run.prompt}</pre>
      </Card>

      <Card title="结果">
        <pre className="code-block">{run.result?.trim() || '（没有输出）'}</pre>
      </Card>

      <Card title={`执行步骤（${run.steps.length}）`}>
        {run.steps.length === 0 ? (
          <div className="empty">这次任务没有上报步骤</div>
        ) : (
          <ol className="timeline">
            {run.steps.map((step) => {
              const meta = STEP_META[step.type] ?? { label: step.type, className: '' };
              return (
                <li key={step.seq} className={`timeline-item ${meta.className}`}>
                  <div className="timeline-marker">{step.seq}</div>
                  <div className="timeline-body">
                    <div className="timeline-head">
                      <span className="badge neutral">{meta.label}</span>
                      <span className="mono">{step.name}</span>
                      {step.isError && <span className="badge run-failed">错误</span>}
                      <span className="spacer" />
                      {step.durationMs !== null && (
                        <span className="small muted">{formatDuration(step.durationMs)}</span>
                      )}
                      {(step.inputTokens || step.outputTokens) && (
                        <span className="small muted">
                          {step.inputTokens ?? 0}/{step.outputTokens ?? 0} tok
                        </span>
                      )}
                    </div>
                    {step.inputSummary && (
                      <details className="trace-detail">
                        <summary>入参</summary>
                        <pre className="code-block small">{step.inputSummary}</pre>
                      </details>
                    )}
                    {step.outputSummary && (
                      <details className="trace-detail">
                        <summary>输出</summary>
                        <pre className="code-block small">{step.outputSummary}</pre>
                      </details>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </div>
  );
}
