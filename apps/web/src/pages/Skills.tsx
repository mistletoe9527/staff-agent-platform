import { useEffect, useRef, useState } from 'react';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import {
  parseSkillFrontmatter,
  type AuthViewer,
  type SkillDetail,
  type SkillListResponse,
  type SkillStatus,
  type SkillSummary,
  type SkillVersionView,
} from '@staff-agent/shared';
import {
  api,
  formatBytes,
  formatNumber,
  formatTime,
  type SkillUploadMeta,
} from '../api.js';
import { Avatar, EmptyState, ErrorBanner, Spinner, handleAuthError } from '../components/Common.js';

/** 从 zip 文件列表里定位 SKILL.md 所在根目录（支持包一层文件夹）。 */
function findSkillRoot(paths: string[]): string | null {
  if (paths.includes('SKILL.md')) return '';
  const tops = new Set(paths.map((path) => path.split('/')[0]));
  if (tops.size === 1) {
    const top = Array.from(tops)[0] as string;
    if (paths.includes(`${top}/SKILL.md`)) return `${top}/`;
  }
  return null;
}

/** 把 tags 输入拆成数组。 */
function splitTags(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of value.split(/[,，]/)) {
    const tag = part.trim().slice(0, 24);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    result.push(tag);
    if (result.length >= 12) break;
  }
  return result;
}

/** Skill 状态徽标。 */
function SkillStatusBadge({ status }: { status: SkillStatus }): React.JSX.Element {
  return (
    <span className={`badge ${status === 'active' ? 'skill-active' : 'skill-hidden'}`}>
      {status === 'active' ? '已上架' : '已隐藏'}
    </span>
  );
}

/** 单个 Skill 卡片。 */
function SkillCard({
  skill,
  onOpen,
  onDownload,
}: {
  skill: SkillSummary;
  onOpen: () => void;
  onDownload: () => void;
}): React.JSX.Element {
  return (
    <article className="skill-card" onClick={onOpen}>
      <div className="skill-card-head">
        <div className="skill-card-title">
          <h3>{skill.name}</h3>
          {skill.canManage && <span className="badge neutral">我的</span>}
          {skill.status === 'hidden' && <SkillStatusBadge status="hidden" />}
        </div>
        <span className="badge neutral">v{skill.latestVersion ?? '-'}</span>
      </div>
      <p className="skill-summary">{skill.summary || '暂无简介'}</p>
      <div className="skill-tags">
        <span className="tag">{skill.category}</span>
        {skill.tags.slice(0, 3).map((tag) => (
          <span className="tag" key={tag}>
            {tag}
          </span>
        ))}
      </div>
      <div className="skill-card-foot">
        <div className="cell-main">
          <Avatar name={skill.ownerName} url={null} />
          <span className="small muted">{skill.ownerName}</span>
        </div>
        <div className="skill-stats">
          <span>{formatNumber(skill.downloads)} 次下载</span>
          <span>{formatBytes(skill.fileSizeBytes)}</span>
        </div>
      </div>
      <div className="skill-card-actions">
        <button className="link" type="button" onClick={(event) => { event.stopPropagation(); onOpen(); }}>
          查看详情
        </button>
        <button
          className="link"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDownload();
          }}
        >
          下载最新版
        </button>
        <span className="small muted skill-updated">{formatTime(skill.updatedAt)}</span>
      </div>
    </article>
  );
}

/** 详情弹窗。 */
function SkillDetailModal({
  skill,
  isAdmin,
  onClose,
  onChanged,
  onUploadVersion,
  onEdit,
  onDeleted,
  onUnauthorized,
}: {
  skill: SkillDetail;
  isAdmin: boolean;
  onClose: () => void;
  onChanged: (skill: SkillDetail) => void;
  onUploadVersion: (skill: SkillDetail) => void;
  onEdit: (skill: SkillDetail) => void;
  onDeleted: () => void;
  onUnauthorized: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async (version?: SkillVersionView): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.downloadSkill(skill.id, version?.version);
      onChanged(await api.skill(skill.id));
    } catch (downloadError) {
      setError(handleAuthError(downloadError, onUnauthorized));
    } finally {
      setBusy(false);
    }
  };

  const toggleHidden = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.updateSkill(skill.id, { status: skill.status === 'active' ? 'hidden' : 'active' });
      onChanged(next);
    } catch (mutationError) {
      setError(handleAuthError(mutationError, onUnauthorized));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    const answer = window.prompt(
      `删除「${skill.name}」会同时删除所有历史版本，且不可恢复。\n\n确认请输入 Skill 名称：`,
      '',
    );
    if (answer === null) return;
    if (answer.trim() !== skill.name.trim()) {
      setError('输入的名称不匹配，已取消删除');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteSkill(skill.id, skill.name);
      onDeleted();
    } catch (mutationError) {
      setError(handleAuthError(mutationError, onUnauthorized));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <div className="crumbs">
              <span>{skill.category}</span>
              <span>·</span>
              <span>{skill.ownerName}</span>
            </div>
            <h2 className="detail-title">{skill.name}</h2>
            <div className="skill-tags">
              <SkillStatusBadge status={skill.status} />
              <span className="badge neutral">v{skill.latestVersion ?? '-'}</span>
              {skill.tags.map((tag) => (
                <span className="tag" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <ErrorBanner message={error} />

        <p className="detail-summary">{skill.summary}</p>
        {skill.description && skill.description !== skill.summary && (
          <p className="detail-description">{skill.description}</p>
        )}
        <div className="detail-metrics">
          <span>{formatNumber(skill.downloads)} 次下载</span>
          <span>{skill.versionCount} 个版本</span>
          <span>{formatBytes(skill.fileSizeBytes)}</span>
          <span>更新于 {formatTime(skill.updatedAt)}</span>
        </div>

        <div className="detail-actions">
          <button className="primary compact" type="button" disabled={busy} onClick={() => void download()}>
            下载最新版
          </button>
          {skill.canManage && (
            <>
              <button className="secondary compact" type="button" disabled={busy} onClick={() => onUploadVersion(skill)}>
                上传新版本
              </button>
              <button className="secondary compact" type="button" disabled={busy} onClick={() => onEdit(skill)}>
                编辑信息
              </button>
              <button className="link danger" type="button" disabled={busy} onClick={() => void remove()}>
                删除
              </button>
            </>
          )}
          {isAdmin && (
            <button className="secondary compact" type="button" disabled={busy} onClick={() => void toggleHidden()}>
              {skill.status === 'active' ? '下架隐藏' : '重新上架'}
            </button>
          )}
        </div>

        <section className="detail-section">
          <h3>SKILL.md</h3>
          {skill.readme ? (
            <pre className="code-block small">{skill.readme}</pre>
          ) : (
            <EmptyState text="这个版本没有可预览的 SKILL.md" />
          )}
        </section>

        <section className="detail-section">
          <h3>版本历史</h3>
          <table className="table compact">
            <thead>
              <tr>
                <th>版本</th>
                <th>说明</th>
                <th className="num">大小</th>
                <th className="num">下载</th>
                <th>上传时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {skill.versions.map((version) => (
                <tr key={version.id}>
                  <td>
                    <span className="mono">v{version.version}</span>
                    {version.isLatest && <span className="badge skill-active latest-badge">最新</span>}
                  </td>
                  <td className="small">{version.changelog || '-'}</td>
                  <td className="num small">{formatBytes(version.sizeBytes)}</td>
                  <td className="num small">{formatNumber(version.downloads)}</td>
                  <td className="small">{formatTime(version.createdAt)}</td>
                  <td>
                    <button className="link" type="button" disabled={busy} onClick={() => void download(version)}>
                      下载
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {skill.versions[0]?.files.length ? (
          <section className="detail-section">
            <details className="trace-detail">
              <summary>包内文件（{skill.versions[0].files.length}）</summary>
              <ul className="file-list">
                {skill.versions[0].files.map((file) => (
                  <li key={file.path}>
                    <span className="mono">{file.path}</span>
                    <span className="muted small">{formatBytes(file.size)}</span>
                  </li>
                ))}
              </ul>
            </details>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** 上传 / 新版本弹窗。 */
function UploadModal({
  target,
  onClose,
  onUploaded,
  onUnauthorized,
}: {
  target: SkillDetail | null;
  onClose: () => void;
  onUploaded: (skill: SkillDetail) => void;
  onUnauthorized: () => void;
}): React.JSX.Element {
  const [file, setFile] = useState<{ blob: Blob; filename: string; size: number; count: number } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    summary: '',
    description: '',
    category: '通用',
    tags: '',
    version: '',
    changelog: '',
  });
  const zipInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 选择「上传新版本」时预填当前版本信息，方便直接递增
    if (target) {
      setForm({
        name: target.name,
        summary: target.summary,
        description: target.description,
        category: target.category,
        tags: target.tags.join(', '),
        version: '',
        changelog: '',
      });
    }
  }, [target]);

  const applyFiles = async (files: File[]): Promise<void> => {
    setFileError(null);
    setError(null);
    const usable = files.filter((item) => item.size > 0);
    if (usable.length === 0) {
      setFileError('没有选择文件');
      return;
    }
    try {
      const first = usable[0] as File;
      let zipBytes: Uint8Array;
      let filename: string;
      if (usable.length === 1 && /\.md$/i.test(first.name)) {
        const text = new Uint8Array(await first.arrayBuffer());
        zipBytes = zipSync({ 'SKILL.md': text });
        filename = `${first.name.replace(/\.md$/i, '')}.zip`;
      } else if (usable.length === 1 && /\.zip$/i.test(first.name)) {
        zipBytes = new Uint8Array(await first.arrayBuffer());
        filename = first.name;
      } else {
        // 文件夹上传：保留相对路径，服务端会剥掉唯一顶层目录
        const entries: Record<string, Uint8Array> = {};
        for (const item of usable) {
          const relative = (item as File & { webkitRelativePath?: string }).webkitRelativePath || item.name;
          if (relative.includes('__MACOSX/') || relative.endsWith('.DS_Store')) continue;
          entries[relative] = new Uint8Array(await item.arrayBuffer());
        }
        if (Object.keys(entries).length === 0) throw new Error('文件夹里没有可用文件');
        zipBytes = zipSync(entries);
        const top = Object.keys(entries)[0]?.split('/')[0] || 'skill';
        filename = `${top}.zip`;
      }

      // 客户端预检：尽早给出「缺少 SKILL.md」等明确错误
      const unzipped = unzipSync(zipBytes);
      const paths = Object.keys(unzipped).filter(
        (path) =>
          !path.endsWith('/') &&
          !path.startsWith('__MACOSX/') &&
          !path.endsWith('.DS_Store') &&
          !path.endsWith('Thumbs.db'),
      );
      const root = findSkillRoot(paths);
      if (root === null) throw new Error('zip 根目录或唯一顶层目录下必须有 SKILL.md');
      const skillMd = unzipped[`${root}SKILL.md`];
      if (!skillMd) throw new Error('缺少 SKILL.md');
      const readme = strFromU8(skillMd);
      if (!readme.trim()) throw new Error('SKILL.md 不能为空');
      const frontmatter = parseSkillFrontmatter(readme);
      setForm((current) => ({
        ...current,
        name: current.name || frontmatter.name || '',
        summary: current.summary || frontmatter.description || '',
        version: current.version || (target ? '' : frontmatter.version) || '',
      }));
      const blobBytes = new Uint8Array(zipBytes.byteLength);
      blobBytes.set(zipBytes);
      setFile({
        blob: new Blob([blobBytes.buffer as ArrayBuffer], { type: 'application/zip' }),
        filename,
        size: zipBytes.byteLength,
        count: paths.length,
      });
    } catch (inspectError) {
      setFile(null);
      setFileError(inspectError instanceof Error ? inspectError.message : '读取 Skill 包失败');
    }
  };

  const submit = async (): Promise<void> => {
    if (!file) {
      setFileError('请先选择 zip 包、SKILL.md 或 Skill 文件夹');
      return;
    }
    setBusy(true);
    setError(null);
    const meta: SkillUploadMeta = {
      name: form.name.trim() || undefined,
      summary: form.summary.trim() || undefined,
      description: form.description.trim() || undefined,
      category: form.category.trim() || undefined,
      tags: splitTags(form.tags),
      version: form.version.trim() || undefined,
      changelog: form.changelog.trim() || undefined,
      filename: file.filename,
    };
    try {
      const saved = target
        ? await api.uploadSkillVersion(target.id, meta, file.blob)
        : await api.createSkill(meta, file.blob);
      onUploaded(saved);
    } catch (uploadError) {
      setError(handleAuthError(uploadError, onUnauthorized));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{target ? `上传新版本 · ${target.name}` : '上传 Skill'}</h2>
            <p className="sub">支持 zip 包、单个 SKILL.md，或直接选择 Skill 文件夹</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <ErrorBanner message={error} />
        {fileError && <div className="banner error">{fileError}</div>}

        <div className="drop-zone">
          <div className="drop-zone-title">{file ? '已选择 Skill 包' : '选择要上传的内容'}</div>
          {file ? (
            <div className="file-picked">
              <span className="mono">{file.filename}</span>
              <span className="muted small">
                {formatBytes(file.size)} · {file.count} 个文件
              </span>
              <button className="link" type="button" onClick={() => setFile(null)}>
                重新选择
              </button>
            </div>
          ) : (
            <div className="upload-buttons">
              <button className="secondary compact" type="button" onClick={() => zipInputRef.current?.click()}>
                选择 zip / SKILL.md
              </button>
              <button className="secondary compact" type="button" onClick={() => folderInputRef.current?.click()}>
                选择 Skill 文件夹
              </button>
            </div>
          )}
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip,.md,application/zip,text/markdown"
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              void applyFiles(files);
            }}
          />
          <input
            ref={(element) => {
              folderInputRef.current = element;
              if (element) {
                element.setAttribute('webkitdirectory', '');
                element.setAttribute('directory', '');
              }
            }}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              void applyFiles(files);
            }}
          />
        </div>

        <div className="form-grid">
          <label className="field">
            <span>名称（留空则取 SKILL.md）</span>
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="例如：周报生成器"
            />
          </label>
          <label className="field">
            <span>分类</span>
            <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
              {['通用', '研发', '文档', '数据', '设计', '运维', '效率', '其他'].map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
          <label className="field form-span-2">
            <span>一句话简介</span>
            <input
              value={form.summary}
              onChange={(event) => setForm({ ...form, summary: event.target.value })}
              placeholder="同事在广场上看到的一句话说明"
              maxLength={200}
            />
          </label>
          <label className="field">
            <span>版本号（留空自动递增）</span>
            <input
              value={form.version}
              onChange={(event) => setForm({ ...form, version: event.target.value })}
              placeholder="1.0.0"
            />
          </label>
          <label className="field">
            <span>标签（逗号分隔）</span>
            <input
              value={form.tags}
              onChange={(event) => setForm({ ...form, tags: event.target.value })}
              placeholder="飞书, 周报, 自动化"
            />
          </label>
          <label className="field form-span-2">
            <span>更新说明</span>
            <input
              value={form.changelog}
              onChange={(event) => setForm({ ...form, changelog: event.target.value })}
              placeholder="这个版本改了什么"
              maxLength={1000}
            />
          </label>
          <label className="field form-span-2">
            <span>详细说明（可选）</span>
            <textarea
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="默认使用 SKILL.md 里的 description"
              rows={3}
            />
          </label>
        </div>

        <div className="modal-actions">
          <button className="secondary" type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" type="button" onClick={() => void submit()} disabled={busy || !file}>
            {busy ? '上传中…' : target ? '上传新版本' : '发布到广场'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 编辑元数据弹窗。 */
function EditSkillModal({
  skill,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  skill: SkillDetail;
  onClose: () => void;
  onSaved: (skill: SkillDetail) => void;
  onUnauthorized: () => void;
}): React.JSX.Element {
  const [form, setForm] = useState({
    name: skill.name,
    summary: skill.summary,
    description: skill.description,
    category: skill.category,
    tags: skill.tags.join(', '),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.updateSkill(skill.id, {
        name: form.name.trim(),
        summary: form.summary.trim(),
        description: form.description,
        category: form.category.trim() || '通用',
        tags: splitTags(form.tags),
      });
      onSaved(saved);
    } catch (mutationError) {
      setError(handleAuthError(mutationError, onUnauthorized));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>编辑 Skill 信息</h2>
            <p className="sub">只改元数据，不会创建新版本</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <ErrorBanner message={error} />
        <div className="form-grid">
          <label className="field form-span-2">
            <span>名称</span>
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </label>
          <label className="field">
            <span>分类</span>
            <input value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} />
          </label>
          <label className="field">
            <span>标签（逗号分隔）</span>
            <input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} />
          </label>
          <label className="field form-span-2">
            <span>一句话简介</span>
            <input value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} />
          </label>
          <label className="field form-span-2">
            <span>详细说明</span>
            <textarea
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              rows={4}
            />
          </label>
        </div>
        <div className="modal-actions">
          <button className="secondary" type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" type="button" onClick={() => void submit()} disabled={busy || !form.name.trim()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Skill 广场主页面。 */
export function SkillsPage({
  user,
  onUnauthorized,
}: {
  user: AuthViewer;
  onUnauthorized: () => void;
}): React.JSX.Element {
  const [data, setData] = useState<SkillListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<'latest' | 'popular' | 'name'>('latest');
  const [page, setPage] = useState(1);
  const [mine, setMine] = useState(false);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<{ skill: SkillDetail | null } | null>(null);
  const [editing, setEditing] = useState<SkillDetail | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = (): void => setReloadKey((value) => value + 1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setError(null);
      api
        .skills({
          q: query.trim() || undefined,
          category: category || undefined,
          sort,
          page,
          limit: 24,
          mine,
          includeHidden: user.isAdmin && includeHidden,
        })
        .then(setData)
        .catch((loadError: unknown) => setError(handleAuthError(loadError, onUnauthorized)));
    }, 200);
    return () => clearTimeout(timer);
    // onUnauthorized 只做退登，不参与请求条件
  }, [query, category, sort, page, mine, includeHidden, reloadKey, user.isAdmin]);

  useEffect(() => {
    setPage(1);
  }, [query, category, sort, mine, includeHidden]);

  const openDetail = async (id: string): Promise<void> => {
    setDetailLoading(true);
    setError(null);
    try {
      setDetail(await api.skill(id));
    } catch (loadError) {
      setError(handleAuthError(loadError, onUnauthorized));
    } finally {
      setDetailLoading(false);
    }
  };

  const download = async (skill: SkillSummary): Promise<void> => {
    setBusyId(skill.id);
    setError(null);
    try {
      await api.downloadSkill(skill.id);
      refresh();
    } catch (downloadError) {
      setError(handleAuthError(downloadError, onUnauthorized));
    } finally {
      setBusyId(null);
    }
  };

  const handleDetailChanged = (updated: SkillDetail): void => {
    setDetail(updated);
    refresh();
  };

  const handleUploaded = (saved: SkillDetail): void => {
    setUploadTarget(null);
    setDetail(saved);
    refresh();
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Skill 广场</h1>
          <p className="sub">同事们分享的 Agent 技能包，上传一次，团队复用</p>
        </div>
        <div className="filters">
          <button className="primary compact" type="button" onClick={() => setUploadTarget({ skill: null })}>
            + 上传 Skill
          </button>
        </div>
      </header>

      <ErrorBanner message={error} />

      <div className="skill-toolbar">
        <input
          placeholder="搜索 Skill 名称、简介、标签或作者"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="">全部分类</option>
          {(data?.categories ?? []).map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
          <option value="latest">最近更新</option>
          <option value="popular">下载最多</option>
          <option value="name">按名称</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} />
          只看我上传的
        </label>
        {user.isAdmin && (
          <label className="check">
            <input
              type="checkbox"
              checked={includeHidden}
              onChange={(event) => setIncludeHidden(event.target.checked)}
            />
            包含已隐藏
          </label>
        )}
      </div>

      {data && (
        <div className="skill-overview">
          <span>{formatNumber(data.total)} 个 Skill</span>
          <span>{data.categories.length} 个分类</span>
          <span>{user.isAdmin ? '管理员视图' : `当前身份：${user.name}`}</span>
        </div>
      )}

      {data === null ? (
        <Spinner />
      ) : data.items.length === 0 ? (
        <EmptyState text={query || category || mine ? '没有匹配的 Skill，换个关键词试试' : '还没有人上传 Skill，成为第一个分享者吧'} />
      ) : (
        <div className="skill-grid">
          {data.items.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              onOpen={() => void openDetail(skill.id)}
              onDownload={() => void download(skill)}
            />
          ))}
        </div>
      )}

      {data && data.total > data.limit && (
        <div className="pager">
          <button className="link" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            上一页
          </button>
          <span className="small muted">
            {page} / {totalPages}
          </span>
          <button className="link" type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
            下一页
          </button>
        </div>
      )}

      {detailLoading && (
        <div className="modal-backdrop">
          <Spinner />
        </div>
      )}

      {detail && (
        <SkillDetailModal
          skill={detail}
          isAdmin={user.isAdmin}
          onClose={() => setDetail(null)}
          onChanged={handleDetailChanged}
          onUploadVersion={(skill) => setUploadTarget({ skill })}
          onEdit={(skill) => setEditing(skill)}
          onDeleted={() => {
            setDetail(null);
            refresh();
          }}
          onUnauthorized={onUnauthorized}
        />
      )}

      {uploadTarget && (
        <UploadModal
          target={uploadTarget.skill}
          onClose={() => setUploadTarget(null)}
          onUploaded={handleUploaded}
          onUnauthorized={onUnauthorized}
        />
      )}

      {editing && (
        <EditSkillModal
          skill={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setDetail(saved);
            refresh();
          }}
          onUnauthorized={onUnauthorized}
        />
      )}

      {busyId && <div className="busy-hint">正在下载…</div>}
    </div>
  );
}
