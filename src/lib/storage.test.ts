import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendRecall, createFolder, createSession, deleteFolder, deleteSession, exportBackup, importBackup, isDue, listFolders, listSessions, moveSession, nextReviewDate, renameFolder } from './storage';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 2, 14, 30));
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('recall-experiences');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('local sessions', () => {
  it('persists the initial record and schedules tomorrow by local calendar date', async () => {
    const session = await createSession('  第一次演讲  ', '  我发现自己紧张时会说得很快。  ');
    expect(await listSessions()).toEqual([session]);
    expect(session.title).toBe('第一次演讲');
    expect(session.entries[0].content).toBe('我发现自己紧张时会说得很快。');
    expect(new Date(session.nextReviewAt!).getDate()).toBe(3);
    expect(new Date(session.nextReviewAt!).getHours()).toBe(0);
    expect(isDue(session, new Date(2026, 10, 2, 23, 59))).toBe(false);
    expect(isDue(session, new Date(2026, 10, 3, 0, 0))).toBe(true);
  });

  it('preserves the first record and all concurrent recollections', async () => {
    const initial = await createSession('演讲', '初次感受');
    vi.setSystemTime(new Date(2026, 10, 3, 9));
    await Promise.all([appendRecall(initial.id, '回忆一'), appendRecall(initial.id, '回忆二')]);
    const [saved] = await listSessions();
    expect(saved.entries.map((entry) => entry.content)).toEqual(['初次感受', '回忆一', '回忆二']);
    expect(saved.entries[0]).toEqual(initial.entries[0]);
    expect(saved.nextReviewAt).toBe(new Date(2026, 10, 10).toISOString());
  });

  it('rejects empty input and appending to a missing session without writing', async () => {
    await expect(createSession('   ', '内容')).rejects.toThrow('事件名称');
    await expect(createSession('事件', '\n')).rejects.toThrow('初次记录');
    await expect(appendRecall('missing', '回忆')).rejects.toThrow('已被删除');
    expect(await listSessions()).toEqual([]);
  });

  it('does not report success if the transaction aborts after its write request succeeds', async () => {
    const original = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = original.call(this, value, key);
      request.onsuccess = () => this.transaction.abort();
      return request;
    });
    await expect(createSession('事件', '内容')).rejects.toThrow('保存失败');
    expect(await listSessions()).toEqual([]);
  });

  it('deletes the entire event with its recollections', async () => {
    const session = await createSession('事件', '内容');
    await appendRecall(session.id, '后来');
    await deleteSession(session.id);
    expect(await listSessions()).toEqual([]);
  });

  it('handles month and year boundaries using calendar days', () => {
    expect(nextReviewDate(new Date(2026, 11, 31, 23), 1)).toBe(new Date(2027, 0, 1).toISOString());
    expect(nextReviewDate(new Date(2026, 1, 26, 23), 7)).toBe(new Date(2026, 2, 5).toISOString());
  });
});

describe('local backups', () => {
  it('exports and restores all entries without duplicate sessions', async () => {
    const session = await createSession('一次经历', '初次记录');
    await appendRecall(session.id, '第二次思考');
    const snapshot = await listSessions();
    const backup = await exportBackup();
    await deleteSession(session.id);
    expect(await importBackup(backup)).toBe(1);
    expect(await importBackup(backup)).toBe(1);
    expect(await listSessions()).toEqual(snapshot);
  });

  it('never rolls back newer local recollections when importing an older backup', async () => {
    const session = await createSession('经历', '最初');
    const oldBackup = await exportBackup();
    vi.setSystemTime(new Date(2026, 10, 5, 10));
    await appendRecall(session.id, '新的回忆');
    const newer = await listSessions();
    await importBackup(oldBackup);
    expect(await listSessions()).toEqual(newer);
  });

  it('merges divergent backup recollections without discarding local entries', async () => {
    const session = await createSession('经历', '最初');
    const backup = JSON.parse(await exportBackup());
    vi.setSystemTime(new Date(2026, 10, 3, 10));
    await appendRecall(session.id, '本地回忆');
    const later = new Date(2026, 10, 4, 10).toISOString();
    backup.sessions[0].entries.push({ id: 'another-entry', content: '另一个设备的回忆', createdAt: later });
    backup.sessions[0].updatedAt = later;
    backup.sessions[0].nextReviewAt = nextReviewDate(later, 7);
    await importBackup(JSON.stringify(backup));
    const [merged] = await listSessions();
    expect(merged.entries.map((entry) => entry.content)).toEqual(['最初', '本地回忆', '另一个设备的回忆']);
    expect(merged.nextReviewAt).toBe(nextReviewDate(later, 7));
  });

  it('rejects unsupported versions, malformed dates and duplicate entries before changing data', async () => {
    await createSession('经历', '最初');
    const original = await listSessions();
    const backup = JSON.parse(await exportBackup());
    await expect(importBackup('{')).rejects.toThrow('JSON');
    await expect(importBackup(JSON.stringify({ ...backup, version: 3 }))).rejects.toThrow('版本');
    backup.sessions[0].createdAt = 'not-a-date';
    await expect(importBackup(JSON.stringify(backup))).rejects.toThrow('格式');
    const duplicate = JSON.parse(await exportBackup());
    duplicate.sessions[0].entries.push(duplicate.sessions[0].entries[0]);
    await expect(importBackup(JSON.stringify(duplicate))).rejects.toThrow('格式');
    expect(await listSessions()).toEqual(original);
  });

  it('rolls back the entire import on a conflicting immutable record', async () => {
    const session = await createSession('已有事件', '不可覆盖');
    const backup = JSON.parse(await exportBackup());
    backup.sessions.unshift({ ...session, id: 'new-session', entries: [{ ...session.entries[0], id: 'new-entry' }] });
    backup.sessions[1].entries[0].content = '覆盖尝试';
    await expect(importBackup(JSON.stringify(backup))).rejects.toThrow('冲突');
    expect(await listSessions()).toEqual([session]);
  });
});

describe('folders and database migration', () => {
  it('upgrades a real version 1 database without changing its records or review schedule', async () => {
    const timestamp = new Date().toISOString();
    const legacy = {
      id: 'legacy-session', title: '旧版本记录', createdAt: timestamp, updatedAt: timestamp,
      entries: [{ id: 'legacy-entry', content: '升级后不能丢失的内容', createdAt: timestamp }],
      nextReviewAt: nextReviewDate(timestamp, 1),
    };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('recall-experiences', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'id' });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('sessions', 'readwrite');
        transaction.objectStore('sessions').add(legacy);
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
    });
    expect(await listSessions()).toEqual([{ ...legacy, folderId: null, folderUpdatedAt: timestamp }]);
    expect(await listFolders()).toEqual([]);
    const folder = await createFolder('升级后的文件夹');
    expect((await moveSession(legacy.id, folder.id)).entries).toEqual(legacy.entries);
  });

  it('creates and renames folders with trimmed names and rejects case-insensitive duplicates', async () => {
    const folder = await createFolder('  Work  ');
    expect(folder.name).toBe('Work');
    await expect(createFolder(' work ')).rejects.toThrow('同名');
    const other = await createFolder('生活');
    await expect(renameFolder(other.id, 'WORK')).rejects.toThrow('同名');
    await expect(createFolder('  ')).rejects.toThrow('文件夹名称');
    await expect(renameFolder('missing', '学习')).rejects.toThrow('不存在');
    const renamed = await renameFolder(folder.id, '  学习  ');
    expect(renamed.name).toBe('学习');
    expect(renamed.createdAt).toBe(folder.createdAt);
    expect(renamed.updatedAt > folder.updatedAt).toBe(true);
    expect((await listFolders()).map((item) => item.name).sort()).toEqual(['学习', '生活'].sort());
  });

  it('serializes concurrent duplicate folder creation', async () => {
    const results = await Promise.allSettled([createFolder('项目'), createFolder(' 项目 ')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await listFolders()).toHaveLength(1);
  });

  it('moves sessions without changing their history or recall dates and prevents orphan membership', async () => {
    const first = await createFolder('工作');
    const second = await createFolder('生活');
    const session = await createSession('经历', '初次记录', first.id);
    const recalled = await appendRecall(session.id, '新的回忆');
    const moved = await moveSession(session.id, second.id);
    expect(moved).toEqual({ ...recalled, folderId: second.id, folderUpdatedAt: moved.folderUpdatedAt });
    expect(moved.folderUpdatedAt > recalled.folderUpdatedAt).toBe(true);
    await expect(moveSession(session.id, 'missing')).rejects.toThrow('不存在');
    await expect(createSession('不能创建', '没有文件夹', 'missing')).rejects.toThrow('不存在');
    await expect(moveSession('missing-session', first.id)).rejects.toThrow('已被删除');
    expect(await listSessions()).toEqual([moved]);
    expect((await moveSession(session.id, null)).folderId).toBe(null);
  });

  it('deletes only the folder and moves every contained event to unfiled atomically', async () => {
    const removed = await createFolder('待删除');
    const retained = await createFolder('保留');
    const first = await createSession('一', '记录一', removed.id);
    const second = await createSession('二', '记录二', removed.id);
    const third = await createSession('三', '记录三', retained.id);
    const firstRecalled = await appendRecall(first.id, '回忆');
    await deleteFolder(removed.id);
    const sessions = await listSessions();
    expect(await listFolders()).toEqual([retained]);
    expect(sessions).toHaveLength(3);
    for (const previous of [firstRecalled, second]) {
      const current = sessions.find((session) => session.id === previous.id)!;
      expect(current).toEqual({ ...previous, folderId: null, folderUpdatedAt: current.folderUpdatedAt });
      expect(current.folderUpdatedAt > previous.folderUpdatedAt).toBe(true);
    }
    expect(sessions.find((session) => session.id === third.id)).toEqual(third);
  });

  it('rolls back moved sessions when deleting their folder fails to commit', async () => {
    const folder = await createFolder('保留');
    const session = await createSession('经历', '内容', folder.id);
    const original = IDBObjectStore.prototype.delete;
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
      const request = original.call(this, key);
      if (this.name === 'folders') request.onsuccess = () => this.transaction.abort();
      return request;
    });
    await expect(deleteFolder(folder.id)).rejects.toThrow('保存失败');
    expect(await listFolders()).toEqual([folder]);
    expect(await listSessions()).toEqual([session]);
  });
});

describe('folder backups', () => {
  it('roundtrips version 2 folders and their event membership', async () => {
    const folder = await createFolder('学习');
    const session = await createSession('经历', '内容', folder.id);
    const backup = await exportBackup();
    expect(JSON.parse(backup).version).toBe(2);
    await deleteSession(session.id);
    await deleteFolder(folder.id);
    await importBackup(backup);
    expect(await listFolders()).toEqual([folder]);
    expect(await listSessions()).toEqual([session]);
  });

  it('imports a version 1 backup as unfiled while preserving a newer local folder assignment', async () => {
    const session = await createSession('经历', '最初');
    const backup = JSON.parse(await exportBackup());
    backup.version = 1;
    delete backup.folders;
    delete backup.sessions[0].folderId;
    delete backup.sessions[0].folderUpdatedAt;
    await deleteSession(session.id);
    await importBackup(JSON.stringify(backup));
    expect((await listSessions())[0].folderId).toBe(null);
    const folder = await createFolder('学习');
    const moved = await moveSession(session.id, folder.id);
    const later = new Date(2026, 10, 10).toISOString();
    backup.sessions[0].entries.push({ id: 'later-legacy-recall', content: '旧版应用里的新回忆', createdAt: later });
    backup.sessions[0].updatedAt = later;
    backup.sessions[0].nextReviewAt = nextReviewDate(later, 7);
    await importBackup(JSON.stringify(backup));
    const [merged] = await listSessions();
    expect(merged.folderId).toBe(folder.id);
    expect(merged.folderUpdatedAt).toBe(moved.folderUpdatedAt);
    expect(merged.entries).toHaveLength(2);
    expect(merged.nextReviewAt).toBe(nextReviewDate(later, 7));
  });

  it('keeps newer local folder moves and renames when importing an older version 2 backup', async () => {
    const first = await createFolder('旧名称');
    const second = await createFolder('另一个文件夹');
    const session = await createSession('经历', '内容', first.id);
    const oldBackup = await exportBackup();
    const renamed = await renameFolder(first.id, '新名称');
    const moved = await moveSession(session.id, second.id);
    await importBackup(oldBackup);
    expect((await listFolders()).find((folder) => folder.id === first.id)).toEqual(renamed);
    expect(await listSessions()).toEqual([moved]);
  });

  it('merges a newer folder move independently from a newer local recollection schedule', async () => {
    const folder = await createFolder('学习');
    const session = await createSession('经历', '内容');
    const backup = JSON.parse(await exportBackup());
    backup.sessions[0].folderId = folder.id;
    backup.sessions[0].folderUpdatedAt = new Date(2026, 10, 4).toISOString();
    vi.setSystemTime(new Date(2026, 10, 5));
    const recalled = await appendRecall(session.id, '本地的新回忆');
    await importBackup(JSON.stringify(backup));
    const [merged] = await listSessions();
    expect(merged.folderId).toBe(folder.id);
    expect(merged.entries).toEqual(recalled.entries);
    expect(merged.nextReviewAt).toBe(recalled.nextReviewAt);
  });

  it('rejects orphan folder IDs and collisions with local folder names without modifying either store', async () => {
    const folder = await createFolder('Work');
    const session = await createSession('经历', '内容', folder.id);
    const orphan = JSON.parse(await exportBackup());
    orphan.sessions[0].folderId = 'missing';
    await expect(importBackup(JSON.stringify(orphan))).rejects.toThrow('格式');
    const duplicate = JSON.parse(await exportBackup());
    duplicate.folders[0].id = 'other-folder';
    duplicate.folders[0].name = ' work ';
    duplicate.sessions[0].folderId = 'other-folder';
    await expect(importBackup(JSON.stringify(duplicate))).rejects.toThrow('同名');
    expect(await listFolders()).toEqual([folder]);
    expect(await listSessions()).toEqual([session]);
  });

  it('rolls back imported folders when an immutable entry conflicts later in the same import', async () => {
    const session = await createSession('经历', '原内容');
    const backup = JSON.parse(await exportBackup());
    const timestamp = new Date().toISOString();
    backup.folders.push({ id: 'new-folder', name: '新文件夹', createdAt: timestamp, updatedAt: timestamp });
    backup.sessions[0].entries[0].content = '冲突内容';
    await expect(importBackup(JSON.stringify(backup))).rejects.toThrow('冲突');
    expect(await listFolders()).toEqual([]);
    expect(await listSessions()).toEqual([session]);
  });
});
