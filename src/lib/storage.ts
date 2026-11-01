export interface Entry {
  id: string;
  content: string;
  createdAt: string;
  title?: string;
  titleUpdatedAt?: string;
}

export interface Session {
  id: string;
  title: string;
  /** Renaming is independent of recalling, so it never changes the review schedule. */
  titleUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
  entries: Entry[];
  nextReviewAt: string | null;
  folderId: string | null;
  /** Folder changes have their own clock so they cannot replace a recall schedule. */
  folderUpdatedAt: string;
}

export interface Folder {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface Backup {
  version: 2;
  exportedAt: string;
  sessions: Session[];
  folders: Folder[];
}

const DATABASE_NAME = 'recall-experiences';
const STORE_NAME = 'sessions';
const FOLDER_STORE_NAME = 'folders';

interface Stores {
  sessions: IDBObjectStore;
  folders: IDBObjectStore;
}

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
    const request = indexedDB.open(DATABASE_NAME, 2);
    let rejected = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
      if (!request.result.objectStoreNames.contains(FOLDER_STORE_NAME)) {
        request.result.createObjectStore(FOLDER_STORE_NAME, { keyPath: 'id' });
      }
      // Upgrade existing v1 rows in the versionchange transaction; never recreate their store.
      const cursor = request.transaction!.objectStore(STORE_NAME).openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        row.update({ ...row.value, folderId: row.value.folderId ?? null, folderUpdatedAt: row.value.folderUpdatedAt ?? row.value.createdAt });
        row.continue();
      };
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
  action: (stores: Stores, result: (value: T) => void, fail: (error: Error) => void) => void,
): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction([STORE_NAME, FOLDER_STORE_NAME], mode);
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
      action({ sessions: transaction.objectStore(STORE_NAME), folders: transaction.objectStore(FOLDER_STORE_NAME) }, (result) => { value = result; }, fail);
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
  return transact('readonly', ({ sessions: store }, result) => {
    const request = store.getAll();
    request.onsuccess = () => result((request.result as Session[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  });
}

export async function createSession(title: string, content: string, folderId: string | null = null): Promise<Session> {
  const now = new Date();
  const timestamp = now.toISOString();
  const session: Session = {
    id: crypto.randomUUID(),
    title: nonempty(title, '事件名称'),
    titleUpdatedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    entries: [{ id: crypto.randomUUID(), content: nonempty(content, '初次记录'), createdAt: timestamp }],
    nextReviewAt: nextReviewDate(now, 1),
    folderId,
    folderUpdatedAt: timestamp,
  };
  return transact('readwrite', (stores, result, fail) => {
    requireFolder(stores, folderId, fail, () => {
      stores.sessions.add(session);
      result(session);
    });
  });
}

export async function appendRecall(id: string, content: string): Promise<Session> {
  const text = nonempty(content, '这次回忆');
  return transact('readwrite', ({ sessions: store }, result, fail) => {
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

export async function renameSession(id: string, title: string): Promise<Session> {
  const normalized = nonempty(title, '会话名称');
  return transact('readwrite', ({ sessions }, result, fail) => {
    const request = sessions.get(id);
    request.onsuccess = () => {
      const session = request.result as Session | undefined;
      if (!session) {
        fail(new Error('这个事件已被删除，请返回事件列表。'));
        return;
      }
      const renamed: Session = {
        ...session,
        title: normalized,
        titleUpdatedAt: latestTimestamp(session.titleUpdatedAt ?? session.createdAt),
      };
      sessions.put(renamed);
      result(renamed);
    };
  });
}

export async function renameEntry(sessionId: string, entryId: string, title: string): Promise<Session> {
  const normalized = nonempty(title, '记录标题');
  return transact('readwrite', ({ sessions }, result, fail) => {
    const request = sessions.get(sessionId);
    request.onsuccess = () => {
      const session = request.result as Session | undefined;
      if (!session) {
        fail(new Error('这个事件已被删除，请返回事件列表。'));
        return;
      }
      const entry = session.entries.find((item) => item.id === entryId);
      if (!entry) {
        fail(new Error('这条记录已不存在，请重新打开会话后重试。'));
        return;
      }
      const renamed: Entry = {
        ...entry,
        title: normalized,
        titleUpdatedAt: latestTimestamp(entry.titleUpdatedAt ?? entry.createdAt),
      };
      const updated = { ...session, entries: session.entries.map((item) => item.id === entryId ? renamed : item) };
      sessions.put(updated);
      result(updated);
    };
  });
}

export async function deleteSession(id: string): Promise<void> {
  return transact('readwrite', ({ sessions: store }, result) => {
    store.delete(id);
    result(undefined);
  });
}

export async function exportBackup(): Promise<string> {
  // Both stores are read in one transaction so folder membership is a consistent snapshot.
  const backup = await transact<Backup>('readonly', (stores, result) => {
    readAll(stores, (sessions, folders) => result({ version: 2, exportedAt: new Date().toISOString(), sessions, folders }));
  });
  return JSON.stringify(backup, null, 2);
}

function readAll(stores: Stores, done: (sessions: Session[], folders: Folder[]) => void): void {
  const sessionsRequest = stores.sessions.getAll();
  const foldersRequest = stores.folders.getAll();
  let remaining = 2;
  const received = () => {
    remaining -= 1;
    if (remaining === 0) done(sessionsRequest.result as Session[], foldersRequest.result as Folder[]);
  };
  sessionsRequest.onsuccess = received;
  foldersRequest.onsuccess = received;
}

function requireFolder(stores: Stores, id: string | null, fail: (error: Error) => void, done: () => void): void {
  if (id === null) {
    done();
    return;
  }
  const request = stores.folders.get(id);
  request.onsuccess = () => {
    if (!request.result) {
      fail(new Error('这个文件夹已不存在，请重新选择文件夹。'));
      return;
    }
    done();
  };
}

function folderNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function ensureUniqueFolderNames(folders: Folder[]): void {
  const names = new Set<string>();
  for (const folder of folders) {
    const key = folderNameKey(folder.name);
    if (names.has(key)) throw new Error('已存在同名文件夹，请使用其他名称。');
    names.add(key);
  }
}

function latestTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), new Date(previous).getTime() + 1)).toISOString();
}

export async function listFolders(): Promise<Folder[]> {
  return transact('readonly', ({ folders }, result) => {
    const request = folders.getAll();
    request.onsuccess = () => result((request.result as Folder[]).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')));
  });
}

export async function createFolder(name: string): Promise<Folder> {
  const timestamp = new Date().toISOString();
  const folder: Folder = { id: crypto.randomUUID(), name: nonempty(name, '文件夹名称'), createdAt: timestamp, updatedAt: timestamp };
  return transact('readwrite', ({ folders }, result, fail) => {
    const request = folders.getAll();
    request.onsuccess = () => {
      try {
        ensureUniqueFolderNames([...(request.result as Folder[]), folder]);
        folders.add(folder);
        result(folder);
      } catch (error) {
        fail(error instanceof Error ? error : new Error('创建文件夹失败，请重试。'));
      }
    };
  });
}

export async function renameFolder(id: string, name: string): Promise<Folder> {
  const normalized = nonempty(name, '文件夹名称');
  return transact('readwrite', ({ folders }, result, fail) => {
    const request = folders.getAll();
    request.onsuccess = () => {
      const all = request.result as Folder[];
      const current = all.find((folder) => folder.id === id);
      if (!current) {
        fail(new Error('这个文件夹已不存在，请返回文件夹列表。'));
        return;
      }
      const renamed: Folder = { ...current, name: normalized, updatedAt: latestTimestamp(current.updatedAt) };
      try {
        ensureUniqueFolderNames(all.map((folder) => folder.id === id ? renamed : folder));
        folders.put(renamed);
        result(renamed);
      } catch (error) {
        fail(error instanceof Error ? error : new Error('重命名失败，请重试。'));
      }
    };
  });
}

export async function moveSession(id: string, folderId: string | null): Promise<Session> {
  return transact('readwrite', (stores, result, fail) => {
    requireFolder(stores, folderId, fail, () => {
      const request = stores.sessions.get(id);
      request.onsuccess = () => {
        const session = request.result as Session | undefined;
        if (!session) {
          fail(new Error('这个事件已被删除，请返回事件列表。'));
          return;
        }
        const moved = { ...session, folderId, folderUpdatedAt: latestTimestamp(session.folderUpdatedAt) };
        stores.sessions.put(moved);
        result(moved);
      };
    });
  });
}

export async function deleteFolder(id: string): Promise<void> {
  return transact('readwrite', (stores, result) => {
    const request = stores.sessions.getAll();
    request.onsuccess = () => {
      for (const session of request.result as Session[]) {
        if (session.folderId === id) {
          stores.sessions.put({ ...session, folderId: null, folderUpdatedAt: latestTimestamp(session.folderUpdatedAt) });
        }
      }
      stores.folders.delete(id);
      result(undefined);
    };
  });
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
  if (!isObject(data) || (data.version !== 1 && data.version !== 2)) {
    throw new Error('不支持这个备份版本，请选择版本为 1 或 2 的备份文件。');
  }
  const invalid = () => new Error('备份内容不完整或格式不正确，未导入任何数据。');
  if (!isTimestamp(data.exportedAt) || !Array.isArray(data.sessions)) throw invalid();
  const folders: Folder[] = [];
  const folderIds = new Set<string>();
  if (data.version === 2) {
    if (!Array.isArray(data.folders)) throw invalid();
    for (const folder of data.folders) {
      if (!isObject(folder) || !isText(folder.id) || !isText(folder.name)
        || !isTimestamp(folder.createdAt) || !isTimestamp(folder.updatedAt)
        || folder.createdAt > folder.updatedAt || folderIds.has(folder.id)) throw invalid();
      folderIds.add(folder.id);
      folders.push({ id: folder.id, name: folder.name.trim(), createdAt: folder.createdAt, updatedAt: folder.updatedAt });
    }
    ensureUniqueFolderNames(folders);
  }
  const sessionIds = new Set<string>();
  for (const session of data.sessions) {
    if (!isObject(session) || !isText(session.id) || !isText(session.title)
      || !isTimestamp(session.createdAt) || !isTimestamp(session.updatedAt)
      || (session.nextReviewAt !== null && !isTimestamp(session.nextReviewAt))
      || !Array.isArray(session.entries) || session.entries.length === 0
      || session.createdAt > session.updatedAt || sessionIds.has(session.id)) throw invalid();
    if (session.titleUpdatedAt !== undefined && (!isTimestamp(session.titleUpdatedAt) || session.titleUpdatedAt < session.createdAt)) throw invalid();
    if (data.version === 2 && ((session.folderId !== null && (!isText(session.folderId) || !folderIds.has(session.folderId)))
      || !isTimestamp(session.folderUpdatedAt) || session.folderUpdatedAt < session.createdAt)) throw invalid();
    sessionIds.add(session.id);
    const entryIds = new Set<string>();
    let previousTime = session.createdAt;
    for (const entry of session.entries) {
      if (!isObject(entry) || !isText(entry.id) || !isText(entry.content)
        || !isTimestamp(entry.createdAt) || entry.createdAt < previousTime
        || entry.createdAt > session.updatedAt || entryIds.has(entry.id)) throw invalid();
      if ((entry.title !== undefined && !isText(entry.title))
        || (entry.titleUpdatedAt !== undefined && (!isText(entry.title) || !isTimestamp(entry.titleUpdatedAt) || entry.titleUpdatedAt < entry.createdAt))) throw invalid();
      entryIds.add(entry.id);
      previousTime = entry.createdAt;
    }
    if (session.entries[0].createdAt !== session.createdAt) throw invalid();
  }
  // Reconstruct known fields so unrecognized properties never enter the database.
  return {
    version: 2,
    exportedAt: data.exportedAt,
    folders,
    sessions: data.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      ...(session.titleUpdatedAt !== undefined ? { titleUpdatedAt: session.titleUpdatedAt } : {}),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      nextReviewAt: session.nextReviewAt,
      folderId: data.version === 2 ? session.folderId : null,
      folderUpdatedAt: data.version === 2 ? session.folderUpdatedAt : session.createdAt,
      entries: session.entries.map((entry: Entry) => ({
        id: entry.id,
        content: entry.content,
        createdAt: entry.createdAt,
        ...(entry.title !== undefined ? { title: entry.title } : {}),
        ...(entry.titleUpdatedAt !== undefined ? { titleUpdatedAt: entry.titleUpdatedAt } : {}),
      })),
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
    else if (entry.title && (!existing.title || (entry.titleUpdatedAt ?? entry.createdAt) > (existing.titleUpdatedAt ?? existing.createdAt))) {
      entries.set(entry.id, {
        ...existing,
        title: entry.title,
        ...(entry.titleUpdatedAt !== undefined ? { titleUpdatedAt: entry.titleUpdatedAt } : {}),
      });
    }
  }
  // On equal timestamps the local schedule wins. Old backups never replace newer records.
  const newest = incoming.updatedAt > local.updatedAt ? incoming : local;
  const newestFolder = incoming.folderUpdatedAt > local.folderUpdatedAt ? incoming : local;
  const newestTitle = (incoming.titleUpdatedAt ?? incoming.createdAt) > (local.titleUpdatedAt ?? local.createdAt) ? incoming : local;
  return {
    ...local,
    title: newestTitle.title,
    ...(newestTitle.titleUpdatedAt !== undefined ? { titleUpdatedAt: newestTitle.titleUpdatedAt } : {}),
    updatedAt: newest.updatedAt,
    nextReviewAt: newest.nextReviewAt,
    folderId: newestFolder.folderId,
    folderUpdatedAt: newestFolder.folderUpdatedAt,
    entries: [...entries.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

/** Merge a complete, validated backup atomically. Returns the number of sessions read. */
export async function importBackup(json: string): Promise<number> {
  const backup = parseBackup(json);
  return transact('readwrite', (stores, result, fail) => {
    readAll(stores, (sessions, folders) => {
      const existing = new Map(sessions.map((session) => [session.id, session]));
      const mergedFolders = new Map(folders.map((folder) => [folder.id, folder]));
      try {
        for (const incoming of backup.folders) {
          const local = mergedFolders.get(incoming.id);
          if (local && local.createdAt !== incoming.createdAt) {
            throw new Error('备份中的文件夹与本地文件夹存在编号冲突，未导入任何数据。');
          }
          if (!local || incoming.updatedAt > local.updatedAt) mergedFolders.set(incoming.id, incoming);
        }
        ensureUniqueFolderNames([...mergedFolders.values()]);
        for (const folder of mergedFolders.values()) stores.folders.put(folder);
        for (const incoming of backup.sessions) {
          const local = existing.get(incoming.id);
          const merged = local ? mergeSession(local, incoming) : incoming;
          if (merged.folderId !== null && !mergedFolders.has(merged.folderId)) {
            throw new Error('备份中的事件指向了不存在的文件夹，未导入任何数据。');
          }
          stores.sessions.put(merged);
        }
        result(backup.sessions.length);
      } catch (error) {
        fail(error instanceof Error ? error : new Error('导入失败，未更改本地数据。'));
      }
    });
  });
}
