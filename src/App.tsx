import { useEffect, useRef, useState, type FormEvent, type ChangeEvent } from 'react';
import { appendRecall, createSession, deleteSession, exportBackup, importBackup, isDue, listSessions, type Session } from './lib/storage';

type IconName = 'plus' | 'arrow' | 'search' | 'download' | 'upload' | 'check' | 'clock' | 'trash' | 'close';
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    upload: <path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5" />,
    check: <path d="m5 12 4 4L19 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const draftKey = (id: string) => `recall:draft:v1:${id}`;
type Draft = { title: string; content: string };
function readDraft(id: string): Draft {
  try {
    const value = JSON.parse(localStorage.getItem(draftKey(id)) || 'null');
    if (value && typeof value.title === 'string' && typeof value.content === 'string') return value;
  } catch { /* A broken draft never prevents opening saved records. */ }
  return { title: '', content: '' };
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : typeof error === 'string' ? error : '操作没有完成，请重试。'; }
function reviewLabel(session: Session, now: Date) {
  if (!session.nextReviewAt) return '随时可以回忆';
  if (isDue(session, now)) return '今天回忆';
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  if (new Date(session.nextReviewAt).toDateString() === tomorrow.toDateString()) return '明天回忆';
  return `${dateFormat.format(new Date(session.nextReviewAt))}回忆`;
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'due'>('all');
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => readDraft('new'));
  const [draftWarning, setDraftWarning] = useState(false);
  const [confirmation, setConfirmation] = useState<{ kind: 'delete' } | { kind: 'navigate'; id: string | null } | null>(null);
  const [now, setNow] = useState(() => new Date());
  const fileInput = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const selected = sessions.find((session) => session.id === selectedId);
  const dueCount = sessions.filter((session) => isDue(session, now)).length;
  const totalRecalls = sessions.reduce((sum, session) => sum + session.entries.length - 1, 0);
  const visible = sessions.filter((session) => (filter === 'all' || isDue(session, now)) && session.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const draftId = selectedId ?? 'new';

  useEffect(() => {
    let cancelled = false;
    listSessions().then((items) => {
      if (cancelled) return;
      setSessions(items);
      if (!readDraft('new').content && !readDraft('new').title && items.length) {
        setSelectedId(items[0].id);
        const savedDraft = readDraft(items[0].id);
        setDraft(savedDraft);
        setComposing(Boolean(savedDraft.content));
      }
    }).catch((reason) => { if (!cancelled) { setError(errorMessage(reason)); setLoadError(true); } }).finally(() => { if (!cancelled) setLoading(false); });
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  function updateDraft(next: Draft) {
    setDraft(next);
    try { localStorage.setItem(draftKey(draftId), JSON.stringify(next)); setDraftWarning(false); }
    catch { setDraftWarning(true); }
  }

  function openSession(id: string | null, discardUnsaved = false) {
    if (busyRef.current) return;
    const nextDraft = readDraft(id ?? 'new');
    if (!discardUnsaved && draftWarning && (draft.title || draft.content)) { setConfirmation({ kind: 'navigate', id }); return; }
    setSelectedId(id); setDraft(nextDraft); setComposing(Boolean(id && nextDraft.content));
    setError(''); setDraftWarning(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || loading || loadError || !draft.content.trim() || (!selected && !draft.title.trim())) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const saved = selected ? await appendRecall(selected.id, draft.content) : await createSession(draft.title, draft.content);
      setSessions((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      try { localStorage.removeItem(draftKey(draftId)); } catch { /* The committed record remains safe. */ }
      setSelectedId(saved.id); setDraft({ title: '', content: '' }); setComposing(false); setDraftWarning(false); setNow(new Date());
      setFilter('all'); setQuery(''); setNotice(selected ? '这一次回忆，已保存在本机。' : '初次记录已保存，明天再来回忆。');
    } catch (reason) { setError(errorMessage(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function removeSession() {
    if (!selected || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      await deleteSession(selected.id);
      setSessions((items) => items.filter((item) => item.id !== selected.id));
      try { localStorage.removeItem(draftKey(selected.id)); } catch { /* Saved records are already deleted. */ }
      setSelectedId(null); setDraft(readDraft('new')); setComposing(false); setNotice('事件已删除。');
    } catch (reason) { setError(errorMessage(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function downloadBackup() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const content = await exportBackup();
      if ('__TAURI_INTERNALS__' in window) {
        const { invoke } = await import('@tauri-apps/api/core');
        const saved = await invoke<boolean>('save_backup', { content });
        if (saved) setNotice('备份已导出。');
      } else {
        const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url;
        anchor.download = `recall-backup-${new Date().toISOString().slice(0, 10)}.json`;
        anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice('备份文件已生成。');
      }
    } catch (reason) { setError(errorMessage(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function restoreBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const count = await importBackup(await file.text());
      setSessions(await listSessions()); setNotice(`已合并 ${count} 个事件，本机已有的记录会保留。`);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  }

  return <div className="app-shell">
    <aside className="sidebar" aria-label="事件导航">
      <div className="brand"><img src="/favicon.svg" alt="" width="38" height="38" /><div><strong>回响</strong><span>RECALL</span></div><span className="version">本地笔记</span></div>
      <button className="new-button" onClick={() => openSession(null)} disabled={busy || loading || loadError}><Icon name="plus" />记录一件事<span>新的开始</span></button>
      <div className="library-heading"><h2>我的经历</h2><span>{sessions.length.toString().padStart(2, '0')}</span></div>
      <div className="filters" aria-label="筛选事件">
        <button aria-pressed={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部事件<span>{sessions.length}</span></button>
        <button aria-pressed={filter === 'due'} className={filter === 'due' ? 'active' : ''} onClick={() => setFilter('due')}>待回忆<span>{dueCount}</span></button>
      </div>
      <label className="search"><Icon name="search" size={16} /><input aria-label="搜索事件" placeholder="搜索事件" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="session-list">
        {loading ? <p className="list-empty">正在打开你的记录…</p> : visible.length ? visible.map((session) => <button disabled={busy} key={session.id} className={`session-item ${selectedId === session.id ? 'selected' : ''}`} onClick={() => openSession(session.id)} aria-current={selectedId === session.id ? 'true' : undefined}>
          <span className="session-title">{session.title}</span>
          <span className="session-preview">{session.entries[session.entries.length - 1].content}</span>
          <span className="session-meta"><span>{dateFormat.format(new Date(session.createdAt))}</span><span className={isDue(session, now) ? 'due-text' : ''}>{isDue(session, now) ? <><i />待回忆</> : `${session.entries.length - 1} 次回忆`}</span></span>
        </button>) : <div className="list-empty">{query ? '没有找到这个事件。' : filter === 'due' ? '今天没有待回忆的事件。\n也可以随时打开一件事，再想一想。' : '还没有记录。\n从今天经历的一件小事开始。'}</div>}
      </div>
      <div className="sidebar-footer">
        <div className="local-state"><span className="status-dot" />只保存在这台设备</div>
        <div className="backup-actions"><button onClick={downloadBackup} disabled={busy || loading || loadError}><Icon name="download" size={14} />导出备份</button><span>·</span><button onClick={() => fileInput.current?.click()} disabled={busy || loading || loadError}><Icon name="upload" size={14} />导入备份</button></div>
        <input ref={fileInput} hidden type="file" accept=".json,application/json" onChange={restoreBackup} />
      </div>
    </aside>

    <main className="main-panel">
      <header className="topbar"><span>经历 <span className="breadcrumb-separator">/</span> {selected ? '再次想起' : '初次记录'}</span><span className="today">{dateFormat.format(now)}<span className="weekday">{new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(now)}</span></span></header>
      <div className="main-scroll"><div className="writing-area">
        {error && <div className="error-message" role="alert"><span>{error}</span>{loadError ? <button onClick={() => window.location.reload()}>重新打开</button> : <button aria-label="关闭错误提示" onClick={() => setError('')}><Icon name="close" size={16} /></button>}</div>}
        {notice && <div className="toast" role="status"><Icon name="check" size={16} />{notice}</div>}
        {selected ? <>
          <div className="eyebrow">一件经历，多一次理解</div>
          <div className="event-heading"><h1>{selected.title}</h1><button className="icon-button delete-button" aria-label="删除事件" title="删除事件" onClick={() => setConfirmation({ kind: 'delete' })} disabled={busy}><Icon name="trash" size={17} /></button></div>
          <p className="event-subtitle">始于 {dateFormat.format(new Date(selected.createdAt))}<span>·</span>{selected.entries.length - 1} 次回忆<span>·</span><span className={isDue(selected, now) ? 'due-text' : ''}>{reviewLabel(selected, now)}</span></p>
          <div className="journey" aria-label="回忆过程"><div className="journey-step complete"><span><Icon name="check" size={13} /></span><div>初次记录<small>把经历留下来</small></div></div><div className="journey-line" /><div className={`journey-step ${selected.entries.length > 1 ? 'complete' : 'current'}`}><span>{selected.entries.length > 1 ? <Icon name="check" size={13} /> : '2'}</span><div>隔天想起<small>试着重新说一遍</small></div></div><div className="journey-line" /><div className={`journey-step ${selected.entries.length > 1 ? 'current' : ''}`}><span>↻</span><div>每周回溯<small>看见新的理解</small></div></div></div>
          {!composing && <button className="recall-prompt" onClick={() => { setComposing(true); window.setTimeout(() => editor.current?.focus(), 0); }} disabled={busy}><span className="recall-prompt-icon"><Icon name="plus" size={22} /></span><span><strong>下一次回忆</strong><small>此刻再想起这件事，你还记得什么？</small></span><Icon name="arrow" size={21} /></button>}
          {composing && <form className="editor-card recall-editor" onSubmit={save}>
            <div className="editor-heading"><span className="entry-tag">第 {selected.entries.length} 次回忆</span><button type="button" className="text-button" onClick={() => setComposing(false)} disabled={busy}>收起草稿</button></div>
            <label className="sr-only" htmlFor="recall-content">这次回忆</label>
            <textarea ref={editor} id="recall-content" placeholder={'先不看过去的记录，试着用自己的话写下来。\n你还记得什么？现在有什么不同的理解？'} value={draft.content} onChange={(event) => updateDraft({ ...draft, content: event.target.value })} disabled={busy} required />
            <div className="editor-footer"><span>{draftWarning ? '草稿暂存失败，请先保存' : `${draft.content.length} 字 · 草稿暂存于本机`}</span><button type="submit" className="primary-button" disabled={busy || !draft.content.trim()}>{busy ? '保存中…' : '保存这次回忆'}<Icon name="arrow" size={16} /></button></div>
          </form>}
          <section className="history" aria-label="历次记录"><div className="section-title"><h2>留下的思考</h2><span>{selected.entries.length} 次记录</span></div>
            {composing ? <details className="past-records"><summary>回忆之后，再展开过去的记录</summary><Timeline session={selected} /></details> : <Timeline session={selected} />}
          </section>
        </> : <>
          <div className="eyebrow">让经历，慢慢变成自己的东西</div>
          <h1 className="welcome-title">今天，留下什么？</h1>
          <p className="welcome-description">一件刚经历的事，一个突然想通的道理。<br />先写下来，明天再试着想起。</p>
          <form className="editor-card initial-editor" onSubmit={save}>
            <div className="editor-heading"><span className="entry-tag"><span className="tiny-dot" />初次记录</span><span className="editor-hint">不必完整，写下此刻的理解</span></div>
            <label className="sr-only" htmlFor="event-title">事件名称</label>
            <input id="event-title" className="title-input" placeholder="给这件事起个名字" maxLength={120} value={draft.title} onChange={(event) => updateDraft({ ...draft, title: event.target.value })} disabled={busy || loading || loadError} required />
            <label className="sr-only" htmlFor="initial-content">初次感受</label>
            <textarea id="initial-content" placeholder={'发生了什么？你有什么感受或理解？\n\n就像讲给自己听一样，写在这里。'} value={draft.content} onChange={(event) => updateDraft({ ...draft, content: event.target.value })} disabled={busy || loading || loadError} required />
            <div className="editor-footer"><span>{draftWarning ? '草稿暂存失败，请先保存' : draft.content || draft.title ? `${draft.content.length} 字 · 草稿暂存于本机` : '只有你自己看得到'}</span><button type="submit" className="primary-button" disabled={busy || loading || loadError || !draft.title.trim() || !draft.content.trim()}>{busy ? '保存中…' : '保存初次记录'}<Icon name="arrow" size={16} /></button></div>
          </form>
          <div className="method-note"><Icon name="clock" size={18} /><div><strong>写下，是回忆的起点。</strong><p>明天回想一次，之后每隔一周再回溯。<br className="mobile-break" /> 每一次，都保留当时的思考。</p></div></div>
        </>}
        <footer className="page-footer"><span>经历过，再想起。</span><span>{sessions.length} 件经历<span className="footer-dot">·</span>{totalRecalls} 次回忆</span></footer>
      </div></div>
    </main>
    {confirmation && <ConfirmDialog
      title={confirmation.kind === 'delete' ? '删除这个事件？' : '离开当前草稿？'}
      message={confirmation.kind === 'delete' ? `「${selected?.title}」及其全部 ${selected?.entries.length} 次记录将被删除，此操作无法撤销。` : '草稿未能暂存，离开会丢失当前输入。你可以取消并先保存。'}
      confirmLabel={confirmation.kind === 'delete' ? '确认删除' : '仍然离开'}
      onCancel={() => setConfirmation(null)}
      onConfirm={() => { setConfirmation(null); if (confirmation.kind === 'delete') void removeSession(); else openSession(confirmation.id, true); }}
    />}
  </div>;
}

function ConfirmDialog({ title, message, confirmLabel, onCancel, onConfirm }: { title: string; message: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-message" onCancel={onCancel}>
    <h2 id="confirm-title">{title}</h2><p id="confirm-message">{message}</p>
    <div><button autoFocus className="cancel-button" onClick={onCancel}>取消</button><button className="danger-button" onClick={onConfirm}>{confirmLabel}</button></div>
  </dialog>;
}

function Timeline({ session }: { session: Session }) {
  return <div className="timeline">{session.entries.map((entry, index) => <article className="timeline-entry" key={entry.id}>
    <div className="timeline-marker">{index === 0 ? <span /> : index}</div>
    <div className="timeline-entry-heading"><h3>{index === 0 ? '初次记录' : `第 ${index} 次回忆`}</h3><time dateTime={entry.createdAt}>{timeFormat.format(new Date(entry.createdAt))}</time></div>
    <p>{entry.content}</p>
  </article>)}</div>;
}
