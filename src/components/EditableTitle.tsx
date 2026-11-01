import { useEffect, useRef, useState } from 'react';

interface EditableTitleProps {
  value: string;
  label: string;
  as?: 'h1' | 'h2' | 'h3';
  disabled?: boolean;
  onSave: (title: string) => Promise<void>;
}

export default function EditableTitle({ value, label, as: Heading = 'h1', disabled = false, onSave }: EditableTitleProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const cancelled = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
  function start() {
    if (disabled) return;
    cancelled.current = false; setText(value); setError(''); setEditing(true);
  }
  function finish(restoreFocus: boolean) {
    setEditing(false);
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus());
  }
  async function save(restoreFocus = false) {
    if (pending.current || cancelled.current) return;
    const title = text.trim();
    if (!title) { setError('标题不能为空'); input.current?.focus(); return; }
    if (title === value) { finish(restoreFocus); return; }
    pending.current = true; setSaving(true); setError('');
    try { await onSave(title); finish(restoreFocus); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '标题未能保存，请重试。'); requestAnimationFrame(() => input.current?.focus()); }
    finally { pending.current = false; setSaving(false); }
  }

  return <div className={`editable-title editable-title-${Heading}`}>
    {editing ? <><input ref={input} className="inline-title-input" aria-label={label} aria-invalid={Boolean(error)} value={text} maxLength={120} disabled={saving}
      onChange={(event) => setText(event.target.value)} onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter') { event.preventDefault(); void save(true); }
        if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; finish(true); }
      }} />{error && <p className="inline-title-error" role="alert">{error}</p>}</>
      : <Heading><button ref={trigger} type="button" className="title-edit-trigger" title="双击修改标题" disabled={disabled} onDoubleClick={start}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); start(); } }}>{value}</button></Heading>}
  </div>;
}
