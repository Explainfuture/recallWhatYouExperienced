import { useEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { Folder } from '../lib/storage';
import './interactions.css';

interface SessionActionsProps {
  title: string;
  folders: Folder[];
  folderId: string | null;
  onMove: (id: string | null) => Promise<void>;
  onCreateFolder?: () => void;
  disabled?: boolean;
}

export default function SessionActions({ title, folders, folderId, onMove, onCreateFolder, disabled = false }: SessionActionsProps) {
  const [open, setOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [compact, setCompact] = useState(false);
  const [side, setSide] = useState<'right' | 'bottom'>('right');
  const pendingRef = useRef(false);
  const afterClose = useRef<(() => void) | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const moveTrigger = useRef<HTMLDivElement>(null);
  const folderOptions = useRef<HTMLDivElement>(null);
  const options = [{ id: null, name: '未分类' }, ...folders];
  useEffect(() => {
    if (!open) return;
    const close = () => { if (!pendingRef.current) { setOpen(false); setSubOpen(false); } };
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, [open]);

  function changeOpen(next: boolean) {
    if (pendingRef.current && !next) return;
    if (next) {
      // Reserve space for both panels before opening. If a right-hand submenu
      // cannot fit, use a folder page in the same panel instead of flipping left.
      const available = window.innerWidth - (trigger.current?.getBoundingClientRect().right ?? 0) - 12;
      const usePage = available < 190 + 6 + 250 + 12;
      setCompact(usePage);
      setSide(available >= (usePage ? 250 : 190) + 6 ? 'right' : 'bottom');
      setError('');
    }
    else setSubOpen(false);
    setOpen(next);
  }
  function openFolderPage() {
    setSubOpen(true);
    window.requestAnimationFrame(() => folderOptions.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus());
  }
  function back() {
    setSubOpen(false);
    window.requestAnimationFrame(() => moveTrigger.current?.focus());
  }
  async function move(id: string | null) {
    if (pendingRef.current || disabled) return;
    if (id === folderId) { setOpen(false); setSubOpen(false); return; }
    pendingRef.current = true; setPending(true); setError('');
    try { await onMove(id); setOpen(false); setSubOpen(false); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '移动未完成，请重试。');
      window.requestAnimationFrame(() => folderOptions.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[options.findIndex((folder) => folder.id === id)]?.focus());
    }
    finally { pendingRef.current = false; setPending(false); }
  }

  const folderChoices = <>
    <DropdownMenu.Label className="interaction-heading">移动到文件夹</DropdownMenu.Label>
    <div ref={folderOptions} className="interaction-folder-options"><DropdownMenu.RadioGroup value={folderId ?? ''}>
      {options.map((folder) => <DropdownMenu.RadioItem key={folder.id ?? 'unfiled'} value={folder.id ?? ''} className="interaction-menu-item" textValue={folder.name} title={folder.name} disabled={pending || disabled}
        onSelect={(event) => { event.preventDefault(); void move(folder.id); }}>
        <span className="interaction-option-name">{folder.name}</span><span className="interaction-check" aria-hidden="true"><DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator></span>
      </DropdownMenu.RadioItem>)}
    </DropdownMenu.RadioGroup></div>
    {pending && <p className="interaction-status" role="status">正在移动…</p>}
    {error && <p className="interaction-error" role="alert">{error}</p>}
    {onCreateFolder && <><DropdownMenu.Separator className="interaction-separator" /><DropdownMenu.Item className="interaction-menu-item" disabled={pending || disabled} onSelect={(event) => { event.preventDefault(); afterClose.current = onCreateFolder; setSubOpen(false); setOpen(false); }}><span aria-hidden="true">＋</span>新建文件夹</DropdownMenu.Item></>}
  </>;

  return <DropdownMenu.Root open={open} onOpenChange={changeOpen} modal={false} dir="ltr">
    <DropdownMenu.Trigger asChild><button ref={trigger} type="button" className="interaction-more-trigger" aria-label={`会话 ${title} 的操作`} title="会话操作" disabled={disabled || pending} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
    </button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className={`interaction-content interaction-action-menu${compact ? ' interaction-paged-menu' : ''}`} side={side} align={side === 'right' ? 'start' : 'end'} sideOffset={6} collisionPadding={12}
      onCloseAutoFocus={(event) => { if (afterClose.current) { event.preventDefault(); const action = afterClose.current; afterClose.current = null; window.requestAnimationFrame(() => { trigger.current?.focus(); action(); }); } }}
      onEscapeKeyDown={(event) => { if (pendingRef.current) event.preventDefault(); else if (compact && subOpen) { event.preventDefault(); back(); } }}
      onKeyDown={(event) => { if (compact && subOpen && event.key === 'ArrowLeft' && !pendingRef.current) { event.preventDefault(); back(); } }}
      onInteractOutside={(event) => { if (pendingRef.current) event.preventDefault(); }}>
      {compact ? subOpen ? <>
        <DropdownMenu.Item className="interaction-menu-item interaction-back" disabled={pending || disabled} onSelect={(event) => { event.preventDefault(); back(); }}><span aria-hidden="true">‹</span>返回</DropdownMenu.Item>
        <DropdownMenu.Separator className="interaction-separator" />
        {folderChoices}
      </> : <DropdownMenu.Item ref={moveTrigger} className="interaction-menu-item" disabled={disabled || pending} onSelect={(event) => { event.preventDefault(); openFolderPage(); }} onKeyDown={(event) => { if (event.key === 'ArrowRight') { event.preventDefault(); openFolderPage(); } }}>移动到…<span className="interaction-chevron" aria-hidden="true">›</span></DropdownMenu.Item> : <DropdownMenu.Sub open={subOpen} onOpenChange={(next) => { if (!pendingRef.current) setSubOpen(next); }}>
        <DropdownMenu.SubTrigger ref={moveTrigger} className="interaction-menu-item" disabled={disabled && !pending}>移动到…<span className="interaction-chevron" aria-hidden="true">›</span></DropdownMenu.SubTrigger>
        <DropdownMenu.Portal><DropdownMenu.SubContent className="interaction-content interaction-folder-submenu" sideOffset={12} alignOffset={-5} collisionPadding={12}
          onEscapeKeyDown={(event) => { if (pendingRef.current) event.preventDefault(); }}>
          {folderChoices}
        </DropdownMenu.SubContent></DropdownMenu.Portal>
      </DropdownMenu.Sub>}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
