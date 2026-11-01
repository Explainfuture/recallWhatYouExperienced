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
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 580px)').matches);
  const pendingRef = useRef(false);
  const afterClose = useRef<(() => void) | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = [{ id: null, name: '未分类' }, ...folders];
  useEffect(() => {
    const media = window.matchMedia('(max-width: 580px)');
    const update = () => setCompact(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  function changeOpen(next: boolean) {
    if (pendingRef.current && !next) return;
    setOpen(next);
    if (next) setError('');
    else setSubOpen(false);
  }
  async function move(id: string | null) {
    if (pendingRef.current || disabled) return;
    if (id === folderId) { setOpen(false); setSubOpen(false); return; }
    pendingRef.current = true; setPending(true); setError('');
    try { await onMove(id); setOpen(false); setSubOpen(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '移动未完成，请重试。'); }
    finally { pendingRef.current = false; setPending(false); }
  }

  return <DropdownMenu.Root open={open} onOpenChange={changeOpen} modal={false}>
    <DropdownMenu.Trigger asChild><button ref={trigger} type="button" className="interaction-more-trigger" aria-label={`会话 ${title} 的操作`} title="会话操作" disabled={disabled || pending} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
    </button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="interaction-content interaction-action-menu" align="end" sideOffset={6} collisionPadding={12}
      onCloseAutoFocus={(event) => { if (afterClose.current) { event.preventDefault(); const action = afterClose.current; afterClose.current = null; window.requestAnimationFrame(() => { trigger.current?.focus(); action(); }); } }}
      onEscapeKeyDown={(event) => { if (pendingRef.current) event.preventDefault(); }} onInteractOutside={(event) => { if (pendingRef.current) event.preventDefault(); }}>
      <DropdownMenu.Sub open={subOpen} onOpenChange={(next) => { if (!pendingRef.current) setSubOpen(next); }}>
        <DropdownMenu.SubTrigger className="interaction-menu-item" disabled={disabled && !pending}>移动到…<span className="interaction-chevron" aria-hidden="true">›</span></DropdownMenu.SubTrigger>
        <DropdownMenu.Portal><DropdownMenu.SubContent className="interaction-content interaction-folder-submenu" sideOffset={compact ? -170 : 5} alignOffset={-5} collisionPadding={12}
          onEscapeKeyDown={(event) => { if (pendingRef.current) event.preventDefault(); }}>
          <DropdownMenu.Label className="interaction-heading">移动到文件夹</DropdownMenu.Label>
          <div className="interaction-folder-options"><DropdownMenu.RadioGroup value={folderId ?? ''}>
            {options.map((folder) => <DropdownMenu.RadioItem key={folder.id ?? 'unfiled'} value={folder.id ?? ''} className="interaction-menu-item" textValue={folder.name} title={folder.name} disabled={pending || disabled}
              onSelect={(event) => { event.preventDefault(); void move(folder.id); }}>
              <span className="interaction-option-name">{folder.name}</span><span className="interaction-check"><DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator></span>
            </DropdownMenu.RadioItem>)}
          </DropdownMenu.RadioGroup></div>
          {pending && <p className="interaction-status" role="status">正在移动…</p>}
          {error && <p className="interaction-error" role="alert">{error}</p>}
          {onCreateFolder && <><DropdownMenu.Separator className="interaction-separator" /><DropdownMenu.Item className="interaction-menu-item" disabled={pending || disabled} onSelect={(event) => { event.preventDefault(); afterClose.current = onCreateFolder; setSubOpen(false); setOpen(false); }}><span aria-hidden="true">＋</span>新建文件夹</DropdownMenu.Item></>}
        </DropdownMenu.SubContent></DropdownMenu.Portal>
      </DropdownMenu.Sub>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
