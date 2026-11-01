import { useRef, useState } from 'react';
import type { Session } from '../lib/storage';
import EditableTitle from './EditableTitle';
import MarkdownContent from './MarkdownContent';

const timeFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const ordinal = (index: number) => index === 0 ? '初次记录' : `第 ${index} 次回忆`;

export default function RecallHistory({ session, disabled, onRename }: { session: Session; disabled: boolean; onRename: (id: string, title: string) => Promise<void> }) {
  const [entryId, setEntryId] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);
  const index = session.entries.findIndex((entry) => entry.id === entryId);
  const entry = session.entries[index];
  function open(id: string) {
    setEntryId(id);
    requestAnimationFrame(() => section.current?.querySelector<HTMLButtonElement>('.recall-back')?.focus({ preventScroll: true }));
  }
  function back() {
    setEntryId(null);
    requestAnimationFrame(() => Array.from(section.current?.querySelectorAll<HTMLButtonElement>('[data-entry-id]') ?? []).find((button) => button.dataset.entryId === entryId)?.focus({ preventScroll: true }));
  }

  return <section ref={section} className="history" aria-label="历次记录">
    {entry ? <div className="recall-detail" key={entry.id}>
      <button type="button" className="recall-back" onClick={back} disabled={disabled} aria-label="返回全部记录"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg><span>返回记录</span></button>
      <div className="recall-detail-heading">
        {entry.title && <span className="recall-detail-ordinal">{ordinal(index)}</span>}
        <EditableTitle as="h2" value={entry.title || ordinal(index)} label="回忆标题" onSave={(title) => onRename(entry.id, title)} disabled={disabled} />
        <time dateTime={entry.createdAt}>{timeFormat.format(new Date(entry.createdAt))}</time>
      </div>
      <MarkdownContent content={entry.content} />
    </div> : <>
      <div className="section-title"><h2>回忆记录</h2><span>{session.entries.length}</span></div>
      <div className="recall-list">{session.entries.map((item, position) => <button type="button" className="recall-list-item" key={item.id} data-entry-id={item.id} onClick={() => open(item.id)} disabled={disabled}>
        <span className="recall-list-number" aria-hidden="true">{position === 0 ? '·' : String(position).padStart(2, '0')}</span>
        <span className="recall-list-label"><strong>{ordinal(position)}</strong>{item.title && <span>{item.title}</span>}</span>
        <time dateTime={item.createdAt}>{timeFormat.format(new Date(item.createdAt))}</time>
        <svg className="recall-list-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
      </button>)}</div>
    </>}
  </section>;
}
