import { useEffect, useRef, useState } from 'react';
import { readConnectionInfo, type McpConnectionInfo } from '../lib/mcpBridge';
import './mcpConnection.css';

export default function McpConnectionDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const configuration = useRef<HTMLTextAreaElement>(null);
  const request = useRef(0);
  const [info, setInfo] = useState<McpConnectionInfo | null>();
  const [loading, setLoading] = useState(true);
  const [format, setFormat] = useState<'toml' | 'json'>('toml');
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const ready = Boolean(info?.ready && !info.error && info.serverPath && info.descriptorPath);
  const args = info?.serverPath && info.descriptorPath ? [info.serverPath, '--bridge-file', info.descriptorPath] : [];
  const config = ready
    ? format === 'toml'
      ? `[mcp_servers.recall]\ncommand = "node"\nargs = [\n${args.map((value) => `  ${JSON.stringify(value)}`).join(',\n')}\n]`
      : JSON.stringify({ mcpServers: { recall: { command: 'node', args } } }, null, 2)
    : '';

  async function refresh() {
    const current = ++request.current;
    setLoading(true); setCopyState('idle');
    const next = await readConnectionInfo();
    if (request.current === current) { setInfo(next); setLoading(false); }
  }

  useEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    void refresh();
    return () => {
      request.current += 1;
      element.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  async function copy() {
    if (!config || loading || copyState === 'copying') return;
    const current = request.current;
    setCopyState('copying');
    try {
      await navigator.clipboard.writeText(config);
      if (request.current === current) setCopyState('copied');
    } catch {
      if (request.current !== current) return;
      setCopyState('failed');
      configuration.current?.focus(); configuration.current?.select();
    }
  }

  return <dialog ref={dialog} className="mcp-dialog" aria-labelledby="mcp-dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="mcp-dialog-heading"><h2 id="mcp-dialog-title">连接 Agent</h2><button autoFocus type="button" className="icon-button" onClick={onClose} aria-label="关闭连接窗口"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>
    {info === undefined ? <p className="mcp-empty" role="status">正在检查连接…</p>
      : info === null ? <p className="mcp-empty">请在桌面版连接 Agent</p>
        : <>
          <div className={`mcp-status ${ready ? 'is-ready' : ''}`} role="status"><span aria-hidden="true" />{ready ? '已就绪' : '暂未就绪'}</div>
          {ready ? <>
            <p className="mcp-hint">需要 Node.js 22+，并保持回响打开。</p>
            <div className="mcp-format" role="group" aria-label="配置格式"><button type="button" aria-pressed={format === 'toml'} disabled={copyState === 'copying'} onClick={() => { setFormat('toml'); setCopyState('idle'); }}>Codex TOML</button><button type="button" aria-pressed={format === 'json'} disabled={copyState === 'copying'} onClick={() => { setFormat('json'); setCopyState('idle'); }}>通用 JSON</button></div>
            <textarea ref={configuration} className="mcp-configuration" value={config} readOnly spellCheck={false} wrap="soft" rows={format === 'toml' ? 7 : 12} aria-label={format === 'toml' ? 'Codex TOML 配置' : '通用 JSON 配置'} />
            <p className={`mcp-copy-status ${copyState === 'failed' ? 'is-error' : ''}`} role="status">{copyState === 'copied' ? '已复制配置' : copyState === 'failed' ? '复制失败，配置已全选，可手动复制。' : '\u00a0'}</p>
          </> : <p className="mcp-hint">{info.error || '连接正在准备，请刷新状态。'}</p>}
          <div className="mcp-dialog-actions"><button type="button" className="mcp-refresh" onClick={() => void refresh()} disabled={loading}>{loading ? '刷新中…' : '刷新状态'}</button>{ready && <button type="button" className="primary-button" onClick={() => void copy()} disabled={loading || copyState === 'copying'}>{copyState === 'copying' ? '正在复制…' : '复制配置'}</button>}</div>
        </>}
  </dialog>;
}
