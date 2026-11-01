export interface Entry {
  id: string;
  content: string;
  createdAt: string;
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  entries: Entry[];
  nextReviewAt: string | null;
}

interface Backup {
  version: 1;
  exportedAt: string;
  sessions: Session[];
}

const DATABASE_NAME = 'recall-experiences';
const STORE_NAME = 'sessions';

/** Local calendar days, rather than elapsed 24-hour periods, also work across DST. */
export function nextReviewDate(from: Date | string, days: number): string {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

export function isDue(session: Session, now = new Date()): boolean {
  return session.nextReviewAt !== null && new Date(session.nextReviewAt).getTime() <= now.getTime();
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境无法使用本地数据库，请在桌面应用或现代浏览器中打开。'));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, 1);
    let rejected = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onerror = () => reject(new Error('无法打开本地数据库，请检查存储空间并重试。'));
    request.onblocked = () => {
      rejected = true;
      reject(new Error('本地数据库正在被其他窗口使用，请关闭其他窗口后重试。'));
    };
    request.onsuccess = () => {
      if (rejected) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

/** Resolve only after commit: a successful request alone does not mean data is durable. */
async function transact<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore, result: (value: T) => void, fail: (error: Error) => void) => void,
): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE_NAME, mode);
    } catch {
      database.close();
      reject(new Error('无法访问本地数据库，请重新打开应用后重试。'));
      return;
    }
    let value: T;
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure = error;
      transaction.abort();
    };
    transaction.oncomplete = () => {
      database.close();
      resolve(value);
    };
    transaction.onabort = () => {
      database.close();
      reject(failure ?? new Error('本地保存失败，请检查可用存储空间后重试。你的输入尚未保存。'));
    };
    try {
      action(transaction.objectStore(STORE_NAME), (result) => { value = result; }, fail);
    } catch (error) {
      fail(error instanceof Error ? error : new Error('无法保存，请重试。'));
    }
  });
}

function nonempty(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`请填写${label}。`);
  return text;
}

export async function listSessions(): Promise<Session[]> {
  return transact('readonly', (store, result) => {
    const request = store.getAll();
    request.onsuccess = () => result((request.result as Session[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  });
}

export async function createSession(title: string, content: string): Promise<Session> {
  const now = new Date();
  const timestamp = now.toISOString();
  const session: Session = {
    id: crypto.randomUUID(),
    title: nonempty(title, '事件名称'),
    createdAt: timestamp,
    updatedAt: timestamp,
    entries: [{ id: crypto.randomUUID(), content: nonempty(content, '初次记录'), createdAt: timestamp }],
    nextReviewAt: nextReviewDate(now, 1),
  };
  return transact('readwrite', (store, result) => {
    store.add(session);
    result(session);
  });
}

export async function appendRecall(id: string, content: string): Promise<Session> {
  const text = nonempty(content, '这次回忆');
  return transact('readwrite', (store, result, fail) => {
    // Read and update in the same transaction so simultaneous windows cannot lose entries.
    const request = store.get(id);
    request.onsuccess = () => {
      const session = request.result as Session | undefined;
      if (!session) {
        fail(new Error('这个事件已被删除，请返回事件列表。'));
        return;
      }
      const now = new Date();
      // Keep entry order consistent even if the system clock has moved backwards.
      const timestamp = new Date(Math.max(now.getTime(), new Date(session.updatedAt).getTime())).toISOString();
      const updated: Session = {
        ...session,
        updatedAt: timestamp,
        entries: [...session.entries, { id: crypto.randomUUID(), content: text, createdAt: timestamp }],
        nextReviewAt: nextReviewDate(now, 7),
      };
      store.put(updated);
      result(updated);
    };
  });
}

export async function deleteSession(id: string): Promise<void> {
  return transact('readwrite', (store, result) => {
    store.delete(id);
    result(undefined);
  });
}

export async function exportBackup(): Promise<string> {
  const backup: Backup = { version: 1, exportedAt: new Date().toISOString(), sessions: await listSessions() };
  return JSON.stringify(backup, null, 2);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function parseBackup(json: string): Backup {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('这个文件不是有效的 JSON 备份，请选择从应用导出的备份文件。');
  }
  if (!isObject(data) || data.version !== 1) {
    throw new Error('不支持这个备份版本，请选择版本为 1 的备份文件。');
  }
  const invalid = () => new Error('备份内容不完整或格式不正确，未导入任何数据。');
  if (!isTimestamp(data.exportedAt) || !Array.isArray(data.sessions)) throw invalid();
  const sessionIds = new Set<string>();
  for (const session of data.sessions) {
    if (!isObject(session) || !isText(session.id) || !isText(session.title)
      || !isTimestamp(session.createdAt) || !isTimestamp(session.updatedAt)
      || (session.nextReviewAt !== null && !isTimestamp(session.nextReviewAt))
      || !Array.isArray(session.entries) || session.entries.length === 0
      || session.createdAt > session.updatedAt || sessionIds.has(session.id)) throw invalid();
    sessionIds.add(session.id);
    const entryIds = new Set<string>();
    let previousTime = session.createdAt;
    for (const entry of session.entries) {
      if (!isObject(entry) || !isText(entry.id) || !isText(entry.content)
        || !isTimestamp(entry.createdAt) || entry.createdAt < previousTime
        || entry.createdAt > session.updatedAt || entryIds.has(entry.id)) throw invalid();
      entryIds.add(entry.id);
      previousTime = entry.createdAt;
    }
    if (session.entries[0].createdAt !== session.createdAt) throw invalid();
  }
  // Reconstruct known fields so unrecognized properties never enter the database.
  return {
    version: 1,
    exportedAt: data.exportedAt,
    sessions: data.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      nextReviewAt: session.nextReviewAt,
      entries: session.entries.map((entry: Entry) => ({ id: entry.id, content: entry.content, createdAt: entry.createdAt })),
    })),
  };
}

function mergeSession(local: Session, incoming: Session): Session {
  if (local.createdAt !== incoming.createdAt || local.entries[0].id !== incoming.entries[0].id) {
    throw new Error('备份中的事件与本地事件存在编号冲突，未导入任何数据。');
  }
  const entries = new Map(local.entries.map((entry) => [entry.id, entry]));
  for (const entry of incoming.entries) {
    const existing = entries.get(entry.id);
    if (existing && (existing.content !== entry.content || existing.createdAt !== entry.createdAt)) {
      throw new Error('备份中的记录与本地记录存在冲突，未导入任何数据。');
    }
    if (!existing) entries.set(entry.id, entry);
  }
  // On equal timestamps the local schedule wins. Old backups never replace newer records.
  const newest = incoming.updatedAt > local.updatedAt ? incoming : local;
  return {
    ...local,
    updatedAt: newest.updatedAt,
    nextReviewAt: newest.nextReviewAt,
    entries: [...entries.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

/** Merge a complete, validated backup atomically. Returns the number of sessions read. */
export async function importBackup(json: string): Promise<number> {
  const backup = parseBackup(json);
  return transact('readwrite', (store, result, fail) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const existing = new Map((request.result as Session[]).map((session) => [session.id, session]));
      try {
        for (const incoming of backup.sessions) {
          const local = existing.get(incoming.id);
          store.put(local ? mergeSession(local, incoming) : incoming);
        }
        result(backup.sessions.length);
      } catch (error) {
        fail(error instanceof Error ? error : new Error('导入失败，未更改本地数据。'));
      }
    };
  });
}
