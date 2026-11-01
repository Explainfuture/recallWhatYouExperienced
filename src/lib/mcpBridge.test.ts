import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), exportBackup: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('./storage', () => ({ exportBackup: mocks.exportBackup }));

type ReadHandler = (event: { payload: unknown }) => void;
let handler: ReadHandler;
let stop: (() => Promise<void>) | undefined;
let unlisten: ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  stop = undefined;
  unlisten = vi.fn();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.exportBackup.mockResolvedValue('{"version":2,"sessions":[],"folders":[]}');
  mocks.listen.mockImplementation(async (_event, callback: ReadHandler) => { handler = callback; return unlisten; });
});

afterEach(async () => {
  await stop?.();
  vi.unstubAllGlobals();
});

describe('MCP snapshot bridge', () => {
  it('does nothing in browser preview, including connection-info reads', async () => {
    vi.stubGlobal('window', {});
    const { startMcpBridge, readConnectionInfo } = await import('./mcpBridge');
    stop = startMcpBridge();
    expect(await readConnectionInfo()).toBeNull();
    await stop();
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.exportBackup).not.toHaveBeenCalled();
  });

  it('starts once, signals readiness only after listening, and stops in the required order', async () => {
    const listening = deferred<() => void>();
    const order: string[] = [];
    unlisten.mockImplementation(() => { order.push('unlisten'); });
    mocks.listen.mockReturnValue(listening.promise);
    mocks.invoke.mockImplementation(async (command, args) => { if (command === 'mcp_bridge_ready') order.push(`ready:${args.ready}`); });
    const { startMcpBridge } = await import('./mcpBridge');
    stop = startMcpBridge();
    expect(startMcpBridge()).toBe(stop);
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(1));
    expect(mocks.invoke).not.toHaveBeenCalled();
    listening.resolve(unlisten);
    await vi.waitFor(() => expect(order).toEqual(['ready:true']));
    await stop();
    await stop();
    expect(order).toEqual(['ready:true', 'ready:false', 'unlisten']);
  });

  it('reads the latest committed snapshot separately for every request', async () => {
    const { startMcpBridge } = await import('./mcpBridge');
    stop = startMcpBridge();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('mcp_bridge_ready', { ready: true }));
    mocks.exportBackup.mockResolvedValueOnce('first committed snapshot').mockResolvedValueOnce('new committed snapshot');
    handler({ payload: { requestId: 'one' } });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('mcp_snapshot_response', { requestId: 'one', content: 'first committed snapshot' }));
    handler({ payload: { requestId: 'two' } });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('mcp_snapshot_response', { requestId: 'two', content: 'new committed snapshot' }));
    expect(mocks.exportBackup).toHaveBeenCalledTimes(2);
  });

  it('returns a fixed error without exposing storage exception content', async () => {
    const { startMcpBridge } = await import('./mcpBridge');
    stop = startMcpBridge();
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalled());
    mocks.exportBackup.mockRejectedValue(new Error('private user content and secret token'));
    handler({ payload: { requestId: 'failed' } });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('mcp_snapshot_response', { requestId: 'failed', error: '无法读取本地记录，请稍后重试。' }));
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain('secret');
  });

  it('ignores malformed request payloads and does not read storage for them', async () => {
    const { startMcpBridge } = await import('./mcpBridge');
    stop = startMcpBridge();
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalled());
    for (const payload of [null, {}, { requestId: 3 }, { requestId: '' }, { requestId: 'a'.repeat(129) }]) handler({ payload });
    expect(mocks.exportBackup).not.toHaveBeenCalled();
  });

  it('cancels pending setup without leaking listeners or announcing stale readiness after restart', async () => {
    const listening = deferred<() => void>();
    const secondUnlisten = vi.fn();
    mocks.listen.mockReturnValueOnce(listening.promise).mockResolvedValueOnce(secondUnlisten);
    const { startMcpBridge } = await import('./mcpBridge');
    const firstStop = startMcpBridge();
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(1));
    const cleanup = firstStop();
    stop = startMcpBridge();
    expect(mocks.listen).toHaveBeenCalledTimes(1);
    listening.resolve(unlisten);
    await cleanup;
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([command, args]) => command === 'mcp_bridge_ready' && args.ready)).toHaveLength(1));
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'mcp_bridge_ready').map(([, args]) => args.ready)).toEqual([false, true]);
    await stop();
    expect(secondUnlisten).toHaveBeenCalledTimes(1);
  });

  it('drops an in-flight response after cleanup and ignores further events', async () => {
    const snapshot = deferred<string>();
    mocks.exportBackup.mockReturnValue(snapshot.promise);
    const { startMcpBridge } = await import('./mcpBridge');
    stop = startMcpBridge();
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalled());
    handler({ payload: { requestId: 'in-flight' } });
    await stop();
    snapshot.resolve('private snapshot');
    await snapshot.promise;
    handler({ payload: { requestId: 'after-stop' } });
    expect(mocks.exportBackup).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'mcp_snapshot_response')).toBe(false);
  });

  it('cleans up failed initialization and can start again without blocking the UI', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('native readiness failed'));
    const { startMcpBridge, readConnectionInfo } = await import('./mcpBridge');
    const firstStop = startMcpBridge();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
    await firstStop();
    mocks.invoke.mockResolvedValue({ bridgeVersion: 1, appVersion: '0.3.1', ready: false });
    expect((await readConnectionInfo())?.error).toContain('启动失败');
    stop = startMcpBridge();
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(2));
  });

  it('still removes listeners when native shutdown or unlisten rejects', async () => {
    const { startMcpBridge } = await import('./mcpBridge');
    stop = startMcpBridge();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('mcp_bridge_ready', { ready: true }));
    mocks.invoke.mockRejectedValue(new Error('native closed'));
    unlisten.mockRejectedValue(new Error('already removed'));
    await expect(stop()).resolves.toBeUndefined();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('projects connection metadata without tokens and normalizes optional nulls', async () => {
    mocks.invoke.mockResolvedValue({
      bridgeVersion: 1, appVersion: '0.3.1', ready: true, baseUrl: 'http://127.0.0.1:12345',
      descriptorPath: 'local descriptor', serverPath: 'local server.mjs', error: null, token: 'must not reach the UI',
    });
    const { readConnectionInfo } = await import('./mcpBridge');
    const info = await readConnectionInfo();
    expect(info).toEqual({ bridgeVersion: 1, appVersion: '0.3.1', ready: true, baseUrl: 'http://127.0.0.1:12345', descriptorPath: 'local descriptor', serverPath: 'local server.mjs', error: undefined });
    expect(info).not.toHaveProperty('token');
    mocks.invoke.mockResolvedValue({ bridgeVersion: 1, appVersion: '0.3.1', ready: false, baseUrl: null, descriptorPath: null, serverPath: null });
    expect(await readConnectionInfo()).toMatchObject({ baseUrl: undefined, descriptorPath: undefined, serverPath: undefined });
    mocks.invoke.mockRejectedValue(new Error('unsafe native details'));
    expect(await readConnectionInfo()).toMatchObject({ ready: false, error: '无法读取 MCP 连接状态，请稍后重试。' });
  });
});
