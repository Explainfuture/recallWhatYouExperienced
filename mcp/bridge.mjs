import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export class RecallError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function defaultBridgeFile(platform = process.platform, env = process.env, home = homedir()) {
  const base = platform === 'win32'
    ? (env.LOCALAPPDATA || join(home, 'AppData', 'Local'))
    : platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : (env.XDG_DATA_HOME || join(home, '.local', 'share'));
  return join(base, 'com.explainfuture.recall', 'mcp', 'bridge.json');
}

const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)));
const entrySchema = z.object({
  id: z.string().min(1), content: z.string(), createdAt: timestamp,
  title: z.string().optional(), titleUpdatedAt: timestamp.optional(),
});
const folderSchema = z.object({ id: z.string().min(1), name: z.string(), createdAt: timestamp, updatedAt: timestamp });
const sessionSchema = z.object({
  id: z.string().min(1), title: z.string(), titleUpdatedAt: timestamp.optional(),
  createdAt: timestamp, updatedAt: timestamp, entries: z.array(entrySchema),
  nextReviewAt: timestamp.nullable(), folderId: z.string().nullable(), folderUpdatedAt: timestamp,
});
const snapshotSchema = z.object({
  bridgeVersion: z.literal(1), appVersion: z.string().min(1), capturedAt: timestamp,
  data: z.object({ version: z.literal(2), exportedAt: timestamp, sessions: z.array(sessionSchema), folders: z.array(folderSchema) }),
});
const healthSchema = z.object({ bridgeVersion: z.literal(1), appVersion: z.string().min(1), ready: z.boolean() });

export function validateDescriptor(value) {
  const shape = z.object({ bridgeVersion: z.literal(1), pid: z.number().int().positive(), baseUrl: z.string(), token: z.string().regex(/^[A-Za-z0-9_=-]{16,512}$/), appVersion: z.string().min(1) });
  const result = shape.safeParse(value);
  if (!result.success) throw new RecallError('INVALID_BRIDGE_CONFIG', '本机连接配置无效，请重新打开回响应用。');
  const port = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/.exec(result.data.baseUrl)?.[1];
  if (!port || Number(port) > 65535) throw new RecallError('INVALID_BRIDGE_ADDRESS', '已拒绝非本机回环地址；请重新打开回响应用生成连接配置。');
  return { ...result.data, port: Number(port) };
}

async function readDescriptor(path) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch { throw new RecallError('APP_NOT_RUNNING', '无法连接回响。请保持回响桌面应用打开后重试。'); }
  if (raw.length > 16_384) throw new RecallError('INVALID_BRIDGE_CONFIG', '本机连接配置无效，请重新打开回响应用。');
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new RecallError('INVALID_BRIDGE_CONFIG', '本机连接配置无效，请重新打开回响应用。'); }
  return validateDescriptor(value);
}

function getJson(descriptor, path, signal) {
  return new Promise((resolve, reject) => {
    const timeout = AbortSignal.timeout(15_000);
    // A literal host and fixed paths avoid DNS, proxy environment variables,
    // URL normalization surprises, redirects, and notebook-provided URLs.
    const req = request({
      hostname: '127.0.0.1', port: descriptor.port, path, method: 'GET', agent: false,
      headers: { Authorization: `Bearer ${descriptor.token}`, Accept: 'application/json', 'Cache-Control': 'no-store' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }, response => {
      if (response.statusCode !== 200) {
        response.destroy();
        const status = response.statusCode;
        reject(status === 401 || status === 403
          ? new RecallError('BRIDGE_AUTH_FAILED', '本机连接凭证已失效，请重新打开回响应用后重试。')
          : status === 503
            ? new RecallError('BRIDGE_NOT_READY', '回响正在准备本地数据，请稍后重试并保持应用打开。')
            : new RecallError('BRIDGE_RESPONSE_ERROR', '回响本机连接返回了异常响应，请重新打开应用后重试。'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        // Fail explicitly rather than ever returning a truncated note.
        if (size > 256 * 1024 * 1024) {
          response.destroy();
          reject(new RecallError('SNAPSHOT_TOO_LARGE', '本地数据超过单次读取容量，未返回任何截断正文。'));
        } else chunks.push(chunk);
      });
      response.on('error', () => reject(new RecallError('BRIDGE_DISCONNECTED', '回响连接已中断，请保持桌面应用打开后重试。')));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new RecallError('INVALID_SNAPSHOT', '回响返回的数据无法读取，请更新或重新打开桌面应用。')); }
      });
    });
    req.on('error', () => reject(new RecallError(timeout.aborted ? 'BRIDGE_TIMEOUT' : 'APP_NOT_RUNNING',
      timeout.aborted ? '读取回响超时，请保持应用打开并稍后重试。' : '无法连接回响。请保持回响桌面应用打开后重试。')));
    req.end();
  });
}

export function createBridge(bridgeFile) {
  async function read(path, schema, signal) {
    const descriptor = await readDescriptor(bridgeFile);
    const value = await getJson(descriptor, path, signal);
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new RecallError('INVALID_SNAPSHOT', '回响数据格式不兼容，请更新桌面应用与 MCP 服务。');
    return parsed.data; // Zod strips unknown fields, including any draft fields.
  }
  return {
    snapshot: signal => read('/snapshot', snapshotSchema, signal),
    health: signal => read('/health', healthSchema, signal),
  };
}
