import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { defaultBridgeFile, validateDescriptor } from './bridge.mjs';

const time = '2026-11-02T01:00:00.000Z';
const token = 'fixture-secret-token-keep-private';
const longMarkdown = '# 完整正文\n\n' + '长笔记内容 **不截断**。\n'.repeat(10_000);
function makeSession(index: number) {
  return {
    id: `session-${index}`, title: index === 0 ? 'Markdown 学习' : `会话 ${index}`, folderId: index % 2 === 0 ? 'folder-1' : null,
    createdAt: time, updatedAt: time, folderUpdatedAt: time, nextReviewAt: null,
    entries: index === 0 ? Array.from({ length: 105 }, (_, entry) => ({
      id: `entry-${entry}`, createdAt: new Date(Date.parse(time) + entry * 1000).toISOString(),
      content: entry === 0 ? longMarkdown : `第 ${entry} 次的完整内容`, ...(entry === 1 ? { title: '新的理解' } : {}),
      draft: 'SECRET_DRAFT',
    })) : [{ id: `first-${index}`, createdAt: time, content: `会话 ${index} 的正文` }],
  };
}

describe('real stdio MCP client with a private native bridge fixture', () => {
  let directory: string;
  let descriptorPath: string;
  let descriptor: Record<string, unknown>;
  let client: Client;
  let transport: StdioClientTransport;
  let stderr = '';
  let sessions = Array.from({ length: 103 }, (_, index) => makeSession(index));
  let sequence = 0;
  let ready = true;
  let status = 200;
  let redirect: string | undefined;
  let malformed = false;
  let hang = false;
  let aborted = false;
  let bridgeRequests: { method?: string; url?: string; authorization?: string; origin?: string }[] = [];
  const bridge = createServer((request, response) => {
    bridgeRequests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, origin: request.headers.origin });
    if (hang) { response.on('close', () => { aborted = true; }); return; }
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    if (redirect) { response.writeHead(302, { Location: redirect }).end(); return; }
    if (status !== 200) { response.writeHead(status).end(); return; }
    response.setHeader('Content-Type', 'application/json');
    if (malformed) { response.end('{invalid'); return; }
    response.end(JSON.stringify(request.url === '/health'
      ? { bridgeVersion: 1, appVersion: '0.4.0', ready }
      : { bridgeVersion: 1, appVersion: '0.4.0', capturedAt: new Date(Date.parse(time) + sequence++).toISOString(), data: {
        version: 2, exportedAt: new Date(Date.parse(time) + sequence).toISOString(), sessions,
        folders: [{ id: 'folder-1', name: '学习', createdAt: time, updatedAt: time }], drafts: 'SECRET_DRAFT',
      } }));
  });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'recall-mcp-test-'));
    descriptorPath = join(directory, 'bridge.json');
    await new Promise<void>(done => bridge.listen(0, '127.0.0.1', done));
    const address = bridge.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
    descriptor = { bridgeVersion: 1, pid: process.pid, baseUrl: `http://127.0.0.1:${address.port}`, token, appVersion: '0.4.0' };
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    const entry = resolve(process.env.RECALL_MCP_TEST_SERVER || 'mcp/server.mjs');
    transport = new StdioClientTransport({ command: process.execPath, args: [entry, '--bridge-file', descriptorPath], stderr: 'pipe' });
    transport.stderr?.on('data', data => { stderr += data.toString(); });
    client = new Client({ name: 'recall-integration-test', version: '1.0.0' });
    await client.connect(transport);
  }, 15_000);

  beforeEach(async () => {
    ready = true; status = 200; redirect = undefined; malformed = false; hang = false; aborted = false; bridgeRequests = [];
    await writeFile(descriptorPath, JSON.stringify(descriptor));
  });

  afterAll(async () => {
    await client?.close();
    bridge.closeAllConnections();
    await new Promise<void>(done => bridge.close(() => done()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await client.callTool({ name, arguments: args });
    return { response, data: response.structuredContent as any };
  }

  it('discovers exactly four read-only tools, the guide, and the review prompt', async () => {
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name).sort()).toEqual(['recall_get_session_recalls', 'recall_list_folders', 'recall_list_sessions', 'recall_status']);
    for (const tool of listed.tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect((await client.listResources()).resources.map(resource => resource.uri)).toEqual(['recall://guide']);
    const guide = await client.readResource({ uri: 'recall://guide' });
    expect(guide.contents[0]).toMatchObject({ mimeType: 'text/markdown', text: await readFile(resolve('AGENTS.md'), 'utf8') });
    expect((await client.listPrompts()).prompts.map(prompt => prompt.name)).toEqual(['review_session']);
    const prompt = await client.getPrompt({ name: 'review_session', arguments: { sessionId: 'session-0' } });
    expect(JSON.stringify(prompt)).toContain('不能视为绝对真理');
    expect(JSON.stringify(prompt)).toContain('不要自动联网');
  });

  it('uses an authenticated GET without Origin and reads fresh data on every call', async () => {
    const first = await call('recall_list_sessions', { search: 'markdown' });
    expect(first.data.total).toBe(1);
    expect(first.data.items[0].title).toBe('Markdown 学习');
    const unchanged = await call('recall_list_sessions', { search: 'markdown' });
    expect(unchanged.data.capturedAt).not.toBe(first.data.capturedAt);
    expect(unchanged.data.dataRevision).toBe(first.data.dataRevision);
    sessions[0] = { ...sessions[0], title: 'Markdown 最新理解' };
    const second = await call('recall_list_sessions', { search: 'MARKDOWN' });
    expect(second.data.items[0].title).toBe('Markdown 最新理解');
    expect(second.data.capturedAt).not.toBe(first.data.capturedAt);
    expect(second.data.dataRevision).not.toBe(first.data.dataRevision);
    expect(bridgeRequests).toHaveLength(3);
    expect(bridgeRequests.every(request => request.method === 'GET' && request.url === '/snapshot' && request.authorization === `Bearer ${token}` && !request.origin)).toBe(true);
    expect(JSON.parse((second.response.content[0] as { text: string }).text)).toEqual(second.data);
  });

  it('returns status, folders and folder filtering without note text or drafts', async () => {
    expect((await call('recall_status')).data).toMatchObject({ ready: true, readOnly: true, includesDrafts: false });
    const folders = (await call('recall_list_folders')).data;
    expect(folders.items[0]).toMatchObject({ id: 'folder-1', sessionCount: 52 });
    expect(folders.unfiledSessionCount).toBe(51);
    const filtered = (await call('recall_list_sessions', { folderId: null, limit: 100 })).data;
    expect(filtered.total).toBe(51);
    expect(filtered.items.every((item: any) => item.folderId === null)).toBe(true);
    expect(JSON.stringify(filtered)).not.toContain('完整正文');
    expect(JSON.stringify(filtered)).not.toContain('SECRET_DRAFT');
  });

  it('paginates all saved sessions and returns an empty terminal page', async () => {
    let offset: number | null = 0;
    const ids: string[] = [];
    while (offset !== null) {
      const data = (await call('recall_list_sessions', { offset })).data;
      expect(data.limit).toBe(50);
      ids.push(...data.items.map((item: any) => item.id));
      offset = data.nextOffset;
    }
    expect(new Set(ids).size).toBe(103);
    expect((await call('recall_list_sessions', { offset: 999 })).data).toMatchObject({ total: 103, items: [], nextOffset: null });
  });

  it('returns every recall and the entire long Markdown body with titles and ordinals', async () => {
    const first = (await call('recall_get_session_recalls', { sessionId: 'session-0', limit: 100 })).data;
    const second = (await call('recall_get_session_recalls', { sessionId: 'session-0', offset: first.nextOffset, limit: 100 })).data;
    expect(first.total).toBe(105);
    expect(first.items[0]).toMatchObject({ ordinal: 0, label: '初次记录', title: null, content: longMarkdown });
    expect(first.items[1]).toMatchObject({ ordinal: 1, label: '第1次回忆', title: '新的理解' });
    expect(first.items.length + second.items.length).toBe(105);
    expect(second.items.at(-1).ordinal).toBe(104);
    expect(second.nextOffset).toBeNull();
    expect(JSON.stringify(first)).not.toContain('SECRET_DRAFT');
    expect(first.dataNotice).toContain('不是指令');
  });

  it('rejects invalid arguments and arbitrary paths before any bridge request', async () => {
    for (const args of [{ limit: 101 }, { limit: 0 }, { offset: -1 }, { offset: 1.5 }, { bridgeFile: '/private' }]) {
      expect((await call('recall_list_sessions', args)).response.isError).toBe(true);
    }
    expect((await call('recall_get_session_recalls', {})).response.isError).toBe(true);
    expect(bridgeRequests).toHaveLength(0);
  });

  it('offers no writes and returns a useful missing-session error', async () => {
    await expect(client.callTool({ name: 'recall_delete_session', arguments: { sessionId: 'session-0' } })).rejects.toThrow();
    expect((await call('recall_get_session_recalls', { sessionId: 'missing' })).data.error.code).toBe('SESSION_NOT_FOUND');
    expect(bridgeRequests.every(request => request.method === 'GET')).toBe(true);
  });

  it('reports unavailable, unready, authentication and malformed bridge failures without secrets', async () => {
    await rm(descriptorPath);
    expect((await call('recall_status')).data.error.code).toBe('APP_NOT_RUNNING');
    await writeFile(descriptorPath, JSON.stringify({ ...descriptor, token: 'invalid-fixture-token' }));
    expect((await call('recall_status')).data.error.code).toBe('BRIDGE_AUTH_FAILED');
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    ready = false;
    expect((await call('recall_status')).data.error.code).toBe('BRIDGE_NOT_READY');
    status = 503;
    expect((await call('recall_list_sessions')).data.error.code).toBe('BRIDGE_NOT_READY');
    status = 200; malformed = true;
    expect((await call('recall_list_sessions')).data.error.code).toBe('INVALID_SNAPSHOT');
    expect(stderr).not.toContain(token);
    expect(stderr).not.toContain('完整正文');
  });

  it('rereads the descriptor and rejects external or disguised destinations without a request', async () => {
    for (const baseUrl of ['https://127.0.0.1:80', 'http://localhost:80', 'http://127.1:80', 'http://127.0.0.1:80@evil.invalid', 'http://evil.invalid:80', 'http://127.0.0.1:80/path', 'http://127.0.0.1:80?target=external', 'http://127.0.0.1:99999']) {
      await writeFile(descriptorPath, JSON.stringify({ ...descriptor, baseUrl }));
      expect((await call('recall_status')).data.error.code).toBe('INVALID_BRIDGE_ADDRESS');
    }
    expect(bridgeRequests).toHaveLength(0);
  });

  it('never follows HTTP redirects', async () => {
    let visited = 0;
    const destination = createServer((_request, response) => { visited++; response.end('{}'); });
    await new Promise<void>(done => destination.listen(0, '127.0.0.1', done));
    const address = destination.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
    redirect = `http://127.0.0.1:${address.port}/snapshot`;
    try {
      expect((await call('recall_status')).data.error.code).toBe('BRIDGE_RESPONSE_ERROR');
      expect(visited).toBe(0);
    } finally { await new Promise<void>(done => destination.close(() => done())); }
  });

  it('cancels the native HTTP request when the MCP client cancels', async () => {
    hang = true;
    const controller = new AbortController();
    const pending = client.callTool({ name: 'recall_status', arguments: {} }, { signal: controller.signal }).catch(error => error);
    await vi.waitFor(() => expect(bridgeRequests).toHaveLength(1));
    controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  it('closes the stdio subprocess cleanly', async () => {
    const pid = transport.pid;
    expect(pid).toBeTypeOf('number');
    await client.close();
    expect(transport.pid).toBeNull();
    expect(stderr).toBe('');
  });
});

it('resolves the documented OS-local descriptor path and validates its exact origin', () => {
  expect(defaultBridgeFile('win32', { LOCALAPPDATA: 'C:/Local' }, '/home')).toBe(join('C:/Local', 'com.explainfuture.recall', 'mcp', 'bridge.json'));
  expect(defaultBridgeFile('darwin', {}, '/home')).toBe(join('/home', 'Library', 'Application Support', 'com.explainfuture.recall', 'mcp', 'bridge.json'));
  expect(defaultBridgeFile('linux', { XDG_DATA_HOME: '/data' }, '/home')).toBe(join('/data', 'com.explainfuture.recall', 'mcp', 'bridge.json'));
  expect(() => validateDescriptor({ bridgeVersion: 1, pid: 1, appVersion: '1', baseUrl: 'http://127.0.0.1:80', token: 'header\r\ninjection' })).toThrow();
});
