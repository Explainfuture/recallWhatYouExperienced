import { useRef, useState, type KeyboardEvent } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { Folder } from '../lib/storage';
import './interactions.css';

interface FolderPickerProps {
  folders: Folder[];
  value: string | null;
  onChange: (id: string | null) => Promise<void>;
  disabled?: boolean;
  label?: string;
  onCreate?: () => void;
}

export default function FolderPicker({ folders, value, onChange, disabled = false, label = '移动到…', onCreate }: FolderPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const pendingRef = useRef(false);
  const afterClose = useRef<(() => void) | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const currentName = folders.find((folder) => folder.id === value)?.name ?? '未分类';
  const options = [{ id: null, name: '未分类' }, ...folders].filter((folder) => folder.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  function changeOpen(next: boolean) {
    if (pendingRef.current && !next) return;
    setOpen(next);
    if (next) { setQuery(''); setError(''); }
  }
  async function choose(id: string | null) {
    if (pendingRef.current || disabled) return;
    if (id === value) { setOpen(false); return; }
    pendingRef.current = true; setPending(true); setError('');
    try { await onChange(id); setOpen(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '移动未完成，请重试。'); }
    finally { pendingRef.current = false; setPending(false); }
  }
  function optionNavigation(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (event.target instanceof HTMLInputElement && event.key !== 'ArrowDown') return;
    const buttons = Array.from(content.current?.querySelectorAll<HTMLButtonElement>('.interaction-folder-option:not(:disabled)') ?? []);
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
    event.preventDefault(); buttons[index].focus();
  }

  return <Popover.Root open={open} onOpenChange={changeOpen}>
    <Popover.Trigger asChild><button ref={trigger} type="button" className="interaction-picker-trigger" disabled={disabled || pending} aria-label={`${label} 当前：${currentName}`} title={currentName}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 7V5h6l2 2h10v13H3V7Z" /></svg><span>{label}</span><svg aria-hidden="true" width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m5 8 5 5 5-5" /></svg>
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content ref={content} className="interaction-content interaction-folder-picker" sideOffset={7} collisionPadding={12} align="start" aria-label="选择文件夹" onKeyDown={optionNavigation}
      onOpenAutoFocus={(event) => { event.preventDefault(); (search.current ?? content.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? content.current?.querySelector<HTMLButtonElement>('.interaction-folder-option'))?.focus(); }}
      onCloseAutoFocus={(event) => { if (afterClose.current) { event.preventDefault(); const action = afterClose.current; afterClose.current = null; window.requestAnimationFrame(() => { trigger.current?.focus(); action(); }); } }}
      onEscapeKeyDown={(event) => { if (pendingRef.current) event.preventDefault(); }}
      onInteractOutside={(event) => { if (pendingRef.current) event.preventDefault(); }}>
      <div className="interaction-heading">移动到文件夹</div>
      {folders.length > 5 && <input ref={search} className="interaction-search" type="search" aria-label="搜索文件夹" placeholder="搜索文件夹" value={query} onChange={(event) => setQuery(event.target.value)} disabled={pending} />}
      <div className="interaction-folder-options" role="group" aria-label="文件夹">
        {options.map((folder) => <button key={folder.id ?? 'unfiled'} type="button" className="interaction-folder-option" aria-pressed={folder.id === value} disabled={pending || disabled} onClick={() => void choose(folder.id)} title={folder.name}>
          <span className="interaction-option-name">{folder.name}</span><span className="interaction-check" aria-hidden="true">{folder.id === value ? '✓' : ''}</span>
        </button>)}
        {!options.length && <p className="interaction-empty">没有找到文件夹</p>}
      </div>
      {pending && <p className="interaction-status" role="status">正在移动…</p>}
      {error && <p className="interaction-error" role="alert">{error}</p>}
      {onCreate && <><div className="interaction-separator" /><button type="button" className="interaction-create-button" disabled={pending || disabled} onClick={() => { afterClose.current = onCreate; setOpen(false); }}><span aria-hidden="true">＋</span>新建文件夹</button></>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
