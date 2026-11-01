import { useRef, useState, type KeyboardEvent } from 'react';
import MarkdownContent from './MarkdownContent';
import './markdown.css';

interface MarkdownEditorProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

export default function MarkdownEditor({ id, label, value, onChange, disabled = false, autoFocus = false }: MarkdownEditorProps) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const editTab = useRef<HTMLButtonElement>(null);
  const previewTab = useRef<HTMLButtonElement>(null);

  function selectMode(next: 'edit' | 'preview') {
    setMode(next);
    (next === 'edit' ? editTab : previewTab).current?.focus();
  }

  function tabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      selectMode(mode === 'edit' ? 'preview' : 'edit');
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      selectMode(event.key === 'Home' ? 'edit' : 'preview');
    }
  }

  function format(kind: 'bold' | 'list' | 'code') {
    const input = textarea.current;
    if (!input || disabled) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    let from = start;
    let to = end;
    let replacement: string;
    let selectionStart: number;
    let selectionEnd: number;
    if (kind === 'list') {
      from = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
      const selectedEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
      const lineEnd = value.indexOf('\n', selectedEnd);
      to = lineEnd === -1 ? value.length : lineEnd;
      replacement = (value.slice(from, to) || '列表项').split('\n').map((line) => `- ${line}`).join('\n');
      selectionStart = from + 2;
      selectionEnd = from + replacement.length;
    } else {
      const selection = value.slice(start, end);
      const text = selection || (kind === 'bold' ? '文字' : '代码');
      const multiline = kind === 'code' && text.includes('\n');
      const before = kind === 'bold' ? '**' : multiline ? `${start && value[start - 1] !== '\n' ? '\n' : ''}\`\`\`\n` : '`';
      const after = kind === 'bold' ? '**' : multiline ? `\n\`\`\`${value[end] && value[end] !== '\n' ? '\n' : ''}` : '`';
      replacement = `${before}${text}${after}`;
      selectionStart = start + before.length;
      selectionEnd = selectionStart + text.length;
    }
    onChange(value.slice(0, from) + replacement + value.slice(to));
    window.requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  return <div className="markdown-editor">
    <div className="markdown-editor-toolbar">
      <div className="markdown-editor-tabs" role="tablist" aria-label={`${label}模式`}>
        <button ref={editTab} id={`${id}-edit-tab`} type="button" role="tab" aria-selected={mode === 'edit'} aria-controls={`${id}-edit-panel`}
          tabIndex={mode === 'edit' ? 0 : -1} onKeyDown={tabKeyDown} onClick={() => setMode('edit')} disabled={disabled}>编辑</button>
        <button ref={previewTab} id={`${id}-preview-tab`} type="button" role="tab" aria-selected={mode === 'preview'} aria-controls={`${id}-preview-panel`}
          tabIndex={mode === 'preview' ? 0 : -1} onKeyDown={tabKeyDown} onClick={() => setMode('preview')} disabled={disabled}>预览</button>
      </div>
      {mode === 'edit' && <div className="markdown-format-actions" aria-label="Markdown 格式">
        <button type="button" onClick={() => format('bold')} disabled={disabled} title="插入粗体">粗体</button>
        <button type="button" onClick={() => format('list')} disabled={disabled} title="插入列表">列表</button>
        <button type="button" onClick={() => format('code')} disabled={disabled} title="插入代码">代码</button>
      </div>}
    </div>
    {mode === 'edit' ? <div id={`${id}-edit-panel`} role="tabpanel" aria-labelledby={`${id}-edit-tab`}>
      <label className="sr-only" htmlFor={id}>{label}</label>
      <textarea ref={textarea} id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}
        autoFocus={autoFocus} placeholder="写下你的思考…" spellCheck={false} />
    </div> : <div id={`${id}-preview-panel`} className="markdown-editor-preview" role="tabpanel" aria-labelledby={`${id}-preview-tab`} tabIndex={0}>
      {value.trim() ? <MarkdownContent content={value} /> : <p className="markdown-preview-empty">暂无内容</p>}
    </div>}
  </div>;
}
