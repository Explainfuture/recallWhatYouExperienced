import { useEffect, useRef, useState, type FormEvent, type ChangeEvent } from 'react';
import { appendRecall, createSession, deleteSession, exportBackup, importBackup, isDue, listSessions, createFolder, listFolders, moveSession, renameFolder, deleteFolder, type Session, type Folder } from './lib/storage';
import MarkdownContent from './components/MarkdownContent';
import MarkdownEditor from './components/MarkdownEditor';
import FolderPicker from './components/FolderPicker';
import FolderActions from './components/FolderActions';
import SessionActions from './components/SessionActions';

type IconName = 'plus' | 'arrow' | 'search' | 'download' | 'upload' | 'check' | 'trash' | 'close' | 'folder' | 'edit' | 'all';
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    upload: <path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5" />,
    check: <path d="m5 12 4 4L19 6" />,
    trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    folder: <path d="M3 7V5h6l2 2h10v13H3V7Z" />,
    edit: <path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14v6Z" />,
    all: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const draftKey = (id: string) => `recall:draft:v1:${id}`;
type Draft = { title: string; content: string; folderId: string | null };
type View = 'session' | 'new' | 'folder';
type Confirmation = { kind: 'delete' } | { kind: 'navigate'; id: string | null; folderFilter?: string; view?: View } | { kind: 'folder'; folder: Folder };
function emptyDraft(): Draft { return { title: '', content: '', folderId: null }; }
function readDraft(id: string): Draft {
  try {
    const value = JSON.parse(localStorage.getItem(draftKey(id)) || 'null');
    if (value && typeof value.title === 'string' && typeof value.content === 'string') return { title: value.title, content: value.content, folderId: typeof value.folderId === 'string' ? value.folderId : null };
  } catch { /* Saved records remain accessible if a draft is unreadable. */ }
  return emptyDraft();
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : typeof error === 'string' ? error : '操作没有完成，请重试。'; }
function reviewLabel(session: Session, now: Date) {
  if (!session.nextReviewAt) return '';
  if (isDue(session, now)) return '待回忆';
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  return new Date(session.nextReviewAt).toDateString() === tomorrow.toDateString() ? '明天回忆' : `${dateFormat.format(new Date(session.nextReviewAt))}回忆`;
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>('new');
  const [folderFilter, setFolderFilter] = useState('all');
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
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [folderDialog, setFolderDialog] = useState<{ folder?: Folder; createdFolder?: Folder; moveSessionId?: string; assignDraft?: boolean } | null>(null);
  const [now, setNow] = useState(() => new Date());
  const fileInput = useRef<HTMLInputElement>(null);
  const selected = sessions.find((session) => session.id === selectedId);
  const inFolder = sessions.filter((session) => folderFilter === 'all' || (folderFilter === 'unfiled' ? !session.folderId : session.folderId === folderFilter));
  const dueCount = inFolder.filter((session) => isDue(session, now)).length;
  const visible = inFolder.filter((session) => (filter === 'all' || isDue(session, now)) && session.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const draftId = selectedId ?? 'new';
  const unavailable = busy || loading || loadError;
  const currentFolderName = folderFilter === 'all' ? '全部会话' : folderFilter === 'unfiled' ? '未分类' : folders.find((folder) => folder.id === folderFilter)?.name ?? '文件夹';

  useEffect(() => {
    let cancelled = false;
    Promise.all([listSessions(), listFolders()]).then(([items, categories]) => {
      if (cancelled) return;
      setSessions(items); setFolders(categories);
      const savedNew = readDraft('new');
      if (!savedNew.content && !savedNew.title && items.length) {
        setSelectedId(items[0].id); setView('session');
        const savedDraft = readDraft(items[0].id);
        setDraft(savedDraft); setComposing(Boolean(savedDraft.content));
      } else if (savedNew.folderId && !categories.some((folder) => folder.id === savedNew.folderId)) {
        setDraft({ ...savedNew, folderId: null });
      }
    }).catch((reason) => { if (!cancelled) { setError(errorMessage(reason)); setLoadError(true); } }).finally(() => { if (!cancelled) setLoading(false); });
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  function updateDraft(next: Draft) {
    setDraft(next);
    try { localStorage.setItem(draftKey(draftId), JSON.stringify(next)); setDraftWarning(false); }
    catch { setDraftWarning(true); }
  }
  function openSession(id: string | null, discardUnsaved = false, nextFolderFilter?: string, nextView?: View) {
    if (busyRef.current) return;
    if (!discardUnsaved && draftWarning && (draft.title || draft.content)) { setConfirmation({ kind: 'navigate', id, folderFilter: nextFolderFilter, view: nextView }); return; }
    const nextDraft = readDraft(id ?? 'new');
    if (nextDraft.folderId && !folders.some((folder) => folder.id === nextDraft.folderId)) nextDraft.folderId = null;
    const targetFolder = nextFolderFilter ?? folderFilter;
    if (!id && !nextDraft.title && !nextDraft.content) nextDraft.folderId = folders.some((folder) => folder.id === targetFolder) ? targetFolder : null;
    if (nextFolderFilter !== undefined) { setFolderFilter(nextFolderFilter); setFilter('all'); setQuery(''); }
    setSelectedId(id); setView(nextView ?? (id ? 'session' : 'new')); setDraft(nextDraft); setComposing(Boolean(id && nextDraft.content)); setError(''); setDraftWarning(false);
  }
  function chooseFolder(id: string) {
    const items = sessions.filter((session) => id === 'all' || (id === 'unfiled' ? !session.folderId : session.folderId === id));
    const next = items.find((session) => session.id === selectedId) ?? items[0];
    openSession(next?.id ?? null, false, id, next ? 'session' : 'folder');
  }
  async function runOperation(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await action(); } catch (reason) { setError(errorMessage(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (unavailable || !draft.content.trim() || (!selected && !draft.title.trim())) return;
    await runOperation(async () => {
      const saved = selected ? await appendRecall(selected.id, draft.content) : await createSession(draft.title, draft.content, draft.folderId);
      setSessions((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      try { localStorage.removeItem(draftKey(draftId)); } catch { /* The committed record remains safe. */ }
      setSelectedId(saved.id); setView('session'); setDraft(emptyDraft()); setComposing(false); setDraftWarning(false); setNow(new Date());
      setFilter('all'); setQuery('');
      if (folderFilter !== 'all') setFolderFilter(saved.folderId ?? 'unfiled');
      setNotice('已保存');
    });
  }
  async function removeSession() {
    if (!selected) return;
    await runOperation(async () => {
      await deleteSession(selected.id);
      setSessions((items) => items.filter((item) => item.id !== selected.id));
      try { localStorage.removeItem(draftKey(selected.id)); } catch { /* The record is already deleted. */ }
      const restored = readDraft('new');
      if (restored.folderId && !folders.some((folder) => folder.id === restored.folderId)) restored.folderId = null;
      setSelectedId(null); setView(restored.title || restored.content ? 'new' : 'folder'); setDraft(restored); setComposing(false); setNotice('会话已删除');
    });
  }
  async function changeFolder(sessionId: string, folderId: string | null) {
    if (busyRef.current) throw new Error('正在保存，请稍后重试。');
    busyRef.current = true; setBusy(true);
    try {
      const moved = await moveSession(sessionId, folderId);
      setSessions((items) => items.map((item) => item.id === moved.id ? moved : item));
      if (selectedId === sessionId && folderFilter !== 'all') { setFolderFilter(folderId ?? 'unfiled'); setFilter('all'); setQuery(''); }
      setNotice(`已移至「${folders.find((folder) => folder.id === folderId)?.name ?? '未分类'}」`);
    } finally { busyRef.current = false; setBusy(false); }
  }
  async function saveFolder(name: string) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const existingFolder = folderDialog?.folder ?? folderDialog?.createdFolder;
      const folder = existingFolder ? await renameFolder(existingFolder.id, name) : await createFolder(name);
      if (folderDialog?.moveSessionId) setFolderDialog((current) => current ? { ...current, createdFolder: folder } : current);
      setFolders(await listFolders());
      if (folderDialog?.folder) {
        setNotice('文件夹已重命名');
      } else if (folderDialog?.moveSessionId) {
        const moved = await moveSession(folderDialog.moveSessionId, folder.id);
        setSessions((items) => items.map((item) => item.id === moved.id ? moved : item));
        if (selectedId === moved.id) { setFolderFilter(folder.id); setFilter('all'); setQuery(''); }
        setNotice(`已移至「${folder.name}」`);
      } else if (folderDialog?.assignDraft) {
        updateDraft({ ...draft, folderId: folder.id });
        setFolderFilter(folder.id); setFilter('all'); setQuery(''); setNotice('文件夹已创建');
      } else {
        if (!draftWarning || (!draft.title && !draft.content)) {
          setFolderFilter(folder.id); setFilter('all'); setQuery(''); setSelectedId(null); setView('folder'); setComposing(false);
        }
        setNotice('文件夹已创建');
      }
      setFolderDialog(null);
    } finally { busyRef.current = false; setBusy(false); }
  }
  async function removeFolder(folder: Folder) {
    await runOperation(async () => {
      await deleteFolder(folder.id);
      const [items, categories] = await Promise.all([listSessions(), listFolders()]);
      setSessions(items); setFolders(categories);
      if (folderFilter === folder.id) setFolderFilter('unfiled');
      if (draft.folderId === folder.id) updateDraft({ ...draft, folderId: null });
      setNotice('文件夹已删除，会话已移至未分类');
    });
  }
  async function downloadBackup() {
    await runOperation(async () => {
      const content = await exportBackup();
      if ('__TAURI_INTERNALS__' in window) {
        const { invoke } = await import('@tauri-apps/api/core');
        if (await invoke<boolean>('save_backup', { content })) setNotice('备份已导出');
      } else {
        const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url;
        const today = new Date();
        anchor.download = `recall-backup-${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.json`;
        anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('备份已导出');
      }
    });
  }
  async function restoreBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    await runOperation(async () => {
      const count = await importBackup(await file.text());
      const [items, categories] = await Promise.all([listSessions(), listFolders()]);
      setSessions(items); setFolders(categories); setNotice(`已导入 ${count} 个会话`);
      const current = items.find((item) => item.id === selectedId);
      if (current && folderFilter !== 'all') { setFolderFilter(current.folderId ?? 'unfiled'); setFilter('all'); setQuery(''); }
    });
  }

  return <div className="app-shell">
    <aside className="sidebar" aria-label="会话导航">
      <div className="brand"><img src="/favicon.svg" alt="" width="34" height="34" /><strong>回响</strong></div>
      <button className="new-button" onClick={() => openSession(null)} disabled={unavailable}><Icon name="plus" />新建会话</button>
      <div className="folder-heading"><h2>文件夹</h2><button className="icon-button" onClick={() => setFolderDialog(view === 'new' ? { assignDraft: true } : {})} disabled={unavailable} aria-label="新建文件夹" title="新建文件夹"><Icon name="plus" size={17} /></button></div>
      <nav className="folder-list" aria-label="文件夹">
        <button className={`folder-item ${folderFilter === 'all' ? 'active' : ''}`} aria-current={folderFilter === 'all' ? 'true' : undefined} onClick={() => chooseFolder('all')} disabled={unavailable}><Icon name="all" size={16} /><span>全部会话</span><span className="folder-count">{sessions.length}</span></button>
        <button className={`folder-item ${folderFilter === 'unfiled' ? 'active' : ''}`} aria-current={folderFilter === 'unfiled' ? 'true' : undefined} onClick={() => chooseFolder('unfiled')} disabled={unavailable}><Icon name="folder" size={16} /><span>未分类</span><span className="folder-count">{sessions.filter((item) => !item.folderId).length}</span></button>
        {folders.map((folder) => <div key={folder.id} className={`folder-row ${folderFilter === folder.id ? 'active' : ''}`}>
          <button className="folder-item" aria-current={folderFilter === folder.id ? 'true' : undefined} onClick={() => chooseFolder(folder.id)} title={folder.name} disabled={unavailable}><Icon name="folder" size={16} /><span>{folder.name}</span><span className="folder-count">{sessions.filter((item) => item.folderId === folder.id).length}</span></button>
          <FolderActions name={folder.name} onRename={() => setFolderDialog({ folder })} onDelete={() => setConfirmation({ kind: 'folder', folder })} disabled={unavailable} />
        </div>)}
      </nav>
      <div className="session-tools"><div className="filters" aria-label="筛选会话"><button aria-pressed={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部<span>{inFolder.length}</span></button><button aria-pressed={filter === 'due'} className={filter === 'due' ? 'active' : ''} onClick={() => setFilter('due')}>待回忆<span>{dueCount}</span></button></div>
      <label className="search"><Icon name="search" size={16} /><input aria-label="搜索会话" placeholder="搜索会话" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
      <div className="session-list">
        {loading ? <p className="list-empty">正在加载…</p> : visible.length ? visible.map((session) => <div key={session.id} className={`session-row ${selectedId === session.id ? 'selected' : ''}`}><button disabled={busy} className="session-item" onClick={() => openSession(session.id)} aria-current={selectedId === session.id ? 'true' : undefined}>
          <span className="session-title">{session.title}</span><span className="session-meta"><span>{dateFormat.format(new Date(session.createdAt))}</span><span className={isDue(session, now) ? 'due-text' : ''}>{isDue(session, now) ? '待回忆' : `${session.entries.length - 1} 次回忆`}</span></span>
        </button><SessionActions title={session.title} folders={folders} folderId={session.folderId} onMove={(id) => changeFolder(session.id, id)} onCreateFolder={() => setFolderDialog({ moveSessionId: session.id })} disabled={unavailable} /></div>) : <div className="list-empty">{query ? '没有找到会话' : filter === 'due' ? '暂无待回忆' : '暂无会话'}</div>}
      </div>
      <div className="sidebar-footer"><div className="backup-actions"><button onClick={downloadBackup} disabled={unavailable}><Icon name="download" size={15} />导出备份</button><button onClick={() => fileInput.current?.click()} disabled={unavailable}><Icon name="upload" size={15} />导入备份</button></div><input ref={fileInput} hidden type="file" accept=".json,application/json" onChange={restoreBackup} /></div>
    </aside>
    <main className="main-panel" id="main-content"><div className="main-scroll"><div className="writing-area">
      {error && <div className="error-message" role="alert"><span>{error}</span>{loadError ? <button onClick={() => window.location.reload()}>重试</button> : <button aria-label="关闭错误提示" onClick={() => setError('')}><Icon name="close" size={16} /></button>}</div>}
      {notice && <div className="toast" role="status"><Icon name="check" size={16} />{notice}</div>}
      <div className="content-entry" key={view === 'folder' ? `folder-${folderFilter}` : `${view}-${selectedId ?? 'draft'}`}>
      {selected ? <>
        <div className="event-heading"><h1>{selected.title}</h1><button className="icon-button delete-button" aria-label="删除会话" title="删除会话" onClick={() => setConfirmation({ kind: 'delete' })} disabled={busy}><Icon name="trash" size={18} /></button></div>
        <p className="event-subtitle"><span className="folder-badge"><Icon name="folder" size={14} />{folders.find((folder) => folder.id === selected.folderId)?.name ?? '未分类'}</span><span>·</span><span>{selected.entries.length - 1} 次回忆</span><span>·</span><span className={isDue(selected, now) ? 'due-text' : ''}>{reviewLabel(selected, now)}</span></p>
        <div className="session-toolbar"><FolderPicker folders={folders} value={selected.folderId} onChange={(id) => changeFolder(selected.id, id)} onCreate={() => setFolderDialog({ moveSessionId: selected.id })} disabled={unavailable} />{!composing && <button className="primary-button" onClick={() => setComposing(true)} disabled={busy}><Icon name="plus" size={17} />下一次回忆</button>}</div>
        {composing && <form className="editor-card recall-editor" onSubmit={save}><div className="editor-heading"><span>第 {selected.entries.length} 次回忆</span><button type="button" className="text-button" onClick={() => setComposing(false)} disabled={busy}>收起</button></div><MarkdownEditor key={selected.id} id="recall-content" label="这次回忆" value={draft.content} onChange={(content) => updateDraft({ ...draft, content })} disabled={busy} autoFocus /><div className="editor-footer"><span className={draftWarning ? 'draft-warning' : ''}>{draftWarning ? '草稿暂存失败，请先保存' : `${draft.content.length} 字`}</span><button type="submit" className="primary-button" disabled={busy || !draft.content.trim()}>{busy ? '保存中…' : '保存这次回忆'}<Icon name="arrow" size={16} /></button></div></form>}
        <section className="history" aria-label="历次记录"><div className="section-title"><h2>记录</h2><span>{selected.entries.length}</span></div>{composing ? <details className="past-records"><summary>查看历史记录</summary><Timeline session={selected} /></details> : <Timeline session={selected} />}</section>
      </> : view === 'folder' ? <section className="folder-overview"><div className="new-session-heading"><h1>{currentFolderName}</h1><button className="primary-button" onClick={() => openSession(null)} disabled={unavailable}><Icon name="plus" size={17} />新建会话</button></div>{inFolder.length ? <div className="folder-overview-list">{inFolder.map((session) => <button key={session.id} onClick={() => openSession(session.id)}><span>{session.title}</span><Icon name="arrow" size={16} /></button>)}</div> : <div className="empty-folder"><Icon name="folder" size={34} /><p>还没有会话</p><button className="text-button" onClick={() => openSession(null)} disabled={unavailable}>新建会话</button></div>}</section> : <>
        <div className="new-session-heading"><h1>新会话</h1><FolderPicker folders={folders} value={draft.folderId} label={folders.find((folder) => folder.id === draft.folderId)?.name ?? '未分类'} onChange={async (id) => updateDraft({ ...draft, folderId: id })} onCreate={() => setFolderDialog({ assignDraft: true })} disabled={unavailable} /></div>
        <form className="editor-card initial-editor" onSubmit={save}><label className="sr-only" htmlFor="event-title">会话名称</label><input id="event-title" className="title-input" placeholder="会话名称" maxLength={120} value={draft.title} onChange={(event) => updateDraft({ ...draft, title: event.target.value })} disabled={unavailable} required /><MarkdownEditor id="initial-content" label="初次感受" value={draft.content} onChange={(content) => updateDraft({ ...draft, content })} disabled={unavailable} /><div className="editor-footer"><span className={draftWarning ? 'draft-warning' : ''}>{draftWarning ? '草稿暂存失败，请先保存' : `${draft.content.length} 字`}</span><button type="submit" className="primary-button" disabled={unavailable || !draft.title.trim() || !draft.content.trim()}>{busy ? '保存中…' : '保存初次记录'}<Icon name="arrow" size={16} /></button></div></form>
      </>}
      </div>
    </div></div></main>
    {confirmation && <ConfirmDialog title={confirmation.kind === 'delete' ? '删除会话？' : confirmation.kind === 'folder' ? '删除文件夹？' : '离开草稿？'} message={confirmation.kind === 'delete' ? `「${selected?.title}」及其全部记录将被删除，无法撤销。` : confirmation.kind === 'folder' ? `「${confirmation.folder.name}」中的会话将移至未分类，记录会保留。` : '草稿未能暂存，离开会丢失当前输入。'} confirmLabel={confirmation.kind === 'navigate' ? '仍然离开' : '确认删除'} onCancel={() => setConfirmation(null)} onConfirm={() => { setConfirmation(null); if (confirmation.kind === 'delete') void removeSession(); else if (confirmation.kind === 'folder') void removeFolder(confirmation.folder); else openSession(confirmation.id, true, confirmation.folderFilter, confirmation.view); }} />}
    {folderDialog && <FolderDialog folder={folderDialog.folder} actionLabel={folderDialog.moveSessionId ? '创建并移动' : undefined} busy={busy} onSave={saveFolder} onCancel={() => setFolderDialog(null)} />}
  </div>;
}
function ConfirmDialog({ title, message, confirmLabel, onCancel, onConfirm }: { title: string; message: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => { element.close(); if (opener.current?.isConnected) opener.current.focus(); }; }, []);
  return <dialog ref={dialog} className="app-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-message" onCancel={onCancel}><h2 id="confirm-title">{title}</h2><p id="confirm-message">{message}</p><div className="dialog-actions"><button autoFocus className="cancel-button" onClick={onCancel}>取消</button><button className="danger-button" onClick={onConfirm}>{confirmLabel}</button></div></dialog>;
}
function FolderDialog({ folder, actionLabel, busy, onSave, onCancel }: { folder?: Folder; actionLabel?: string; busy: boolean; onSave: (name: string) => Promise<void>; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [name, setName] = useState(folder?.name ?? '');
  const [error, setError] = useState('');
  useEffect(() => { const element = dialog.current!; element.showModal(); input.current?.select(); return () => { element.close(); if (opener.current?.isConnected) opener.current.focus(); }; }, []);
  async function submit(event: FormEvent) { event.preventDefault(); if (busy || !name.trim()) return; setError(''); try { await onSave(name); } catch (reason) { setError(errorMessage(reason)); } }
  return <dialog ref={dialog} className="app-dialog" aria-labelledby="folder-dialog-title" onCancel={(event) => { if (busy) event.preventDefault(); else onCancel(); }}><form onSubmit={submit}><h2 id="folder-dialog-title">{folder ? '重命名文件夹' : '新建文件夹'}</h2><label className="sr-only" htmlFor="folder-name">文件夹名称</label><input ref={input} autoFocus id="folder-name" name="folder-name" autoComplete="off" className="dialog-input" placeholder="文件夹名称…" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} disabled={busy} required />{error && <p className="dialog-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="cancel-button" onClick={onCancel} disabled={busy}>取消</button><button type="submit" className="primary-button" disabled={busy || !name.trim()}>{busy ? '保存中…' : folder ? '保存名称' : actionLabel ?? '创建'}</button></div></form></dialog>;
}
function Timeline({ session }: { session: Session }) {
  return <div className="timeline">{session.entries.map((entry, index) => <article className="timeline-entry" key={entry.id}><div className="timeline-marker">{index === 0 ? <span /> : index}</div><div className="timeline-entry-heading"><h3>{index === 0 ? '初次记录' : `第 ${index} 次回忆`}</h3><time dateTime={entry.createdAt}>{timeFormat.format(new Date(entry.createdAt))}</time></div><MarkdownContent content={entry.content} /></article>)}</div>;
}
