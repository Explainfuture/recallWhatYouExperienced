import { useEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import './interactions.css';

interface FolderActionsProps {
  name: string;
  onRename: () => void;
  onDelete: () => void;
  disabled?: boolean;
}

export default function FolderActions({ name, onRename, onDelete, disabled = false }: FolderActionsProps) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<'right' | 'bottom'>('right');
  const afterClose = useRef<(() => void) | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  function choose(action: () => void) { afterClose.current = action; setOpen(false); }
  function changeOpen(next: boolean) {
    if (next) {
      const right = trigger.current?.getBoundingClientRect().right ?? 0;
      setSide(window.innerWidth - right >= 208 ? 'right' : 'bottom');
    }
    setOpen(next);
  }
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, [open]);

  return <DropdownMenu.Root open={open} onOpenChange={changeOpen} modal={false}>
    <DropdownMenu.Trigger asChild><button ref={trigger} type="button" className="interaction-more-trigger" aria-label={`文件夹 ${name} 的操作`} title="文件夹操作" disabled={disabled} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
    </button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="interaction-content interaction-action-menu" side={side} align={side === 'right' ? 'start' : 'end'} sideOffset={6} collisionPadding={12}
      onCloseAutoFocus={(event) => { if (afterClose.current) { event.preventDefault(); const action = afterClose.current; afterClose.current = null; window.requestAnimationFrame(() => { trigger.current?.focus(); action(); }); } }}>
      <DropdownMenu.Item className="interaction-menu-item" disabled={disabled} onSelect={(event) => { event.preventDefault(); choose(onRename); }}>重命名</DropdownMenu.Item>
      <DropdownMenu.Separator className="interaction-separator" />
      <DropdownMenu.Item className="interaction-menu-item interaction-danger" disabled={disabled} onSelect={(event) => { event.preventDefault(); choose(onDelete); }}>删除文件夹</DropdownMenu.Item>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
