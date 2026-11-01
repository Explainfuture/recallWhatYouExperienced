import { exportBackup } from './storage';
import type { UnlistenFn } from '@tauri-apps/api/event';

export interface McpConnectionInfo {
  bridgeVersion: 1;
  appVersion: string;
  baseUrl?: string;
  descriptorPath?: string;
  serverPath?: string;
  ready: boolean;
  error?: string;
}

type Invoke = typeof import('@tauri-apps/api/core').invoke;
type StopBridge = () => Promise<void>;
interface BridgeRun {
  stopped: boolean;
  invoke?: Invoke;
  unlisten?: UnlistenFn;
  cleanup?: Promise<void>;
  stop: StopBridge;
}
interface BridgeLifecycle {
  active: BridgeRun | null;
  barrier: Promise<void>;
  error?: string;
}

// Preserve the stop/start ordering when this module itself is replaced by Vite HMR.
const lifecycle: BridgeLifecycle = import.meta.hot?.data.mcpBridgeLifecycle ?? { active: null, barrier: Promise.resolve() };
if (import.meta.hot) import.meta.hot.data.mcpBridgeLifecycle = lifecycle;
const noop: StopBridge = async () => {};
const inDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const snapshotError = '无法读取本地记录，请稍后重试。';

async function respond(run: BridgeRun, requestId: string): Promise<void> {
  let response: { requestId: string; content: string } | { requestId: string; error: string };
  try {
    // Always read a fresh, consistent committed snapshot. Drafts are never included.
    response = { requestId, content: await exportBackup() };
  } catch {
    response = { requestId, error: snapshotError };
  }
  if (run.stopped) return;
  try { await run.invoke?.('mcp_snapshot_response', response); }
  catch { /* The native request may already have timed out or the window may be closing. */ }
}

function cleanUp(run: BridgeRun): Promise<void> {
  if (!run.cleanup) {
    run.cleanup = (async () => {
      try { await run.invoke?.('mcp_bridge_ready', { ready: false }); }
      catch { /* Shutdown must still remove the event listener if IPC is unavailable. */ }
      finally {
        const unlisten = run.unlisten; run.unlisten = undefined;
        try { await unlisten?.(); } catch { /* Native teardown may have already removed it. */ }
      }
    })();
  }
  return run.cleanup;
}

/** App-level singleton; start outside React so StrictMode cannot duplicate the listener. */
export function startMcpBridge(): StopBridge {
  if (!inDesktop()) return noop;
  if (lifecycle.active) return lifecycle.active.stop;
  const previousCleanup = lifecycle.barrier;
  const run: BridgeRun = { stopped: false, stop: noop };
  let stopping: Promise<void> | undefined;
  const setup = (async () => {
    await previousCleanup;
    if (run.stopped) return;
    try {
      const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
      if (run.stopped) return;
      run.invoke = invoke;
      run.unlisten = await listen<{ requestId: string }>('recall:mcp-read', ({ payload }) => {
        if (run.stopped || !payload || typeof payload.requestId !== 'string' || !payload.requestId || payload.requestId.length > 128) return;
        void respond(run, payload.requestId);
      });
      if (!run.stopped) await invoke('mcp_bridge_ready', { ready: true });
    } catch {
      if (lifecycle.active === run) lifecycle.error = 'MCP 数据桥启动失败，请重新打开应用。';
      run.stopped = true;
      await cleanUp(run);
      if (lifecycle.active === run) lifecycle.active = null;
    }
  })();
  run.stop = () => {
    if (!stopping) {
      run.stopped = true;
      if (lifecycle.active === run) lifecycle.active = null;
      stopping = setup.then(() => cleanUp(run));
      lifecycle.barrier = stopping.catch(() => {});
    }
    return stopping;
  };
  lifecycle.error = undefined;
  lifecycle.active = run;
  return run.stop;
}

/** Connection metadata only. Projecting known fields prevents leaking an accidental token field. */
export async function readConnectionInfo(): Promise<McpConnectionInfo | null> {
  if (!inDesktop()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const raw = await invoke<Record<string, unknown>>('mcp_connection_info');
    if (!raw || raw.bridgeVersion !== 1 || typeof raw.appVersion !== 'string' || typeof raw.ready !== 'boolean') throw new Error();
    return {
      bridgeVersion: 1,
      appVersion: raw.appVersion,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
      descriptorPath: typeof raw.descriptorPath === 'string' ? raw.descriptorPath : undefined,
      serverPath: typeof raw.serverPath === 'string' ? raw.serverPath : undefined,
      ready: raw.ready,
      error: typeof raw.error === 'string' ? raw.error : lifecycle.error,
    };
  } catch {
    return { bridgeVersion: 1, appVersion: 'unknown', ready: false, error: '无法读取 MCP 连接状态，请稍后重试。' };
  }
}
