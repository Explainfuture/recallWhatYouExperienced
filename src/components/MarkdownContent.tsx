import { useCallback, useId, useMemo, useState, type MouseEvent } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './markdown.css';

function safeUrl(value: string): string {
  if (value.startsWith('#')) return value;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

export default function MarkdownContent({ content }: { content: string }) {
  const instanceId = useId();
  const prefix = `recall-${instanceId.replace(/[^a-zA-Z0-9_-]/g, '')}-`;
  const [linkError, setLinkError] = useState('');
  const openLink = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    const url = event.currentTarget.getAttribute('href');
    if (!url || url.startsWith('#') || !('__TAURI_INTERNALS__' in window)) return;
    event.preventDefault();
    setLinkError('');
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<void>('open_external_url', { url }))
      .catch(() => setLinkError('无法打开链接，请稍后重试。'));
  }, []);

  const components = useMemo<Components>(() => ({
    a({ href, children, id, title, className, 'aria-describedby': describedBy }) {
      if (!href) return <span>{children}</span>;
      const internal = href.startsWith('#');
      return <a href={href} id={id} title={title} className={className}
        aria-describedby={describedBy === 'footnote-label' ? `${prefix}footnote-label` : describedBy}
        target={internal ? undefined : '_blank'} rel={internal ? undefined : 'noopener noreferrer'} onClick={openLink}>{children}</a>;
    },
    h2({ id, children, className }) {
      return <h2 id={id === 'footnote-label' ? `${prefix}footnote-label` : id} className={className}>{children}</h2>;
    },
    img({ src, alt, title }) {
      if (typeof src !== 'string' || !/^https?:\/\//i.test(src)) return <span>{alt || title || '图片'}</span>;
      return <img src={src} alt={alt || ''} title={title} loading="lazy" decoding="async" referrerPolicy="no-referrer" />;
    },
    table({ children }) {
      return <div className="markdown-table-scroll"><table>{children}</table></div>;
    },
  }), [openLink, prefix]);

  return <div className="markdown-content">
    <ReactMarkdown remarkPlugins={[remarkGfm]} remarkRehypeOptions={{ clobberPrefix: prefix, footnoteLabel: '注释', footnoteBackLabel: '返回正文' }}
      components={components} urlTransform={safeUrl} skipHtml>{content}</ReactMarkdown>
    {linkError && <div className="markdown-link-error" role="alert"><span>{linkError}</span><button type="button" aria-label="关闭链接错误提示" onClick={() => setLinkError('')}>关闭</button></div>}
  </div>;
}
