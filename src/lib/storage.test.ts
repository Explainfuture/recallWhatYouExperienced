import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendRecall, createSession, deleteSession, exportBackup, importBackup, isDue, listSessions, nextReviewDate } from './storage';

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
    await expect(importBackup(JSON.stringify({ ...backup, version: 2 }))).rejects.toThrow('版本');
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
