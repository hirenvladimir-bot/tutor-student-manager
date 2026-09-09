const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { indexedDB } = require('fake-indexeddb');

function load() {
  const window = { crypto: webcrypto, indexedDB };
  window.window = window;
  const context = { window, crypto: webcrypto, indexedDB, structuredClone, console };
  vm.runInNewContext(fs.readFileSync('src/model.js', 'utf8'), context);
  vm.runInNewContext(fs.readFileSync('src/database.js', 'utf8'), context);
  return window.Zhixing;
}
const ZX = load();

test('IndexedDB migration persists records and queues only changed entities', async () => {
  await ZX.Database.wipe();
  const initial = { students: [{ id: '11111111-1111-4111-8111-111111111111', name: '学生', currentScore: '待测', targetScore: 'A档', scores: [], custom: [], preparations: [], courseProgress: [] }], activeId: '11111111-1111-4111-8111-111111111111' };
  const state = await ZX.Database.start(initial);
  state.students[0].school = '一中';
  await ZX.Database.persist(state);
  const outbox = await ZX.Database.all('outbox');
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].entity, 'students');
  assert.equal(outbox[0].data.school, '一中');
});

test('cloud conflict choice can replace the local record without data loss', async () => {
  await ZX.Database.wipe();
  const initial = { students: [{ id: '22222222-2222-4222-8222-222222222222', name: '本机版', scores: [], custom: [], preparations: [], courseProgress: [] }], activeId: '22222222-2222-4222-8222-222222222222' };
  await ZX.Database.start(initial);
  const key = 'students:22222222-2222-4222-8222-222222222222';
  const local = { ...(await ZX.Database.get('records', key)), baseVersion: 0, operation: 'upsert' };
  const cloud = { ...local, data: { ...local.data, name: '云端版' }, version: 2 };
  await ZX.Database.saveConflict({ key, entity: 'students', id: local.id, local, cloud });
  await ZX.Database.resolveConflict(key, 'cloud');
  assert.equal((await ZX.Database.state()).students[0].name, '云端版');
  assert.equal((await ZX.Database.all('conflicts')).length, 0);
});

test('failed attachment uploads can be retried or discarded in bulk without deleting their parent record', async () => {
  await ZX.Database.wipe();
  const studentId = '33333333-3333-4333-8333-333333333333';
  const prepId = '44444444-4444-4444-8444-444444444444';
  const attachmentId = '55555555-5555-4555-8555-555555555555';
  await ZX.Database.start({ students: [{ id: studentId, name: '学生', scores: [], custom: [], preparations: [{ id: prepId, title: '备课', files: [{ id: attachmentId, name: '失败.pdf', pending: true, localBlobKey: 'blob:failed' }] }], courseProgress: [] }], activeId: studentId });
  const key = `attachments:${attachmentId}`;
  const record = await ZX.Database.get('records', key);
  await ZX.Database.put('outbox', { ...record, operation: 'upsert', baseVersion: 0, attempts: 6 });
  await ZX.Database.put('blobs', { key: 'blob:failed', buffer: new Uint8Array([1, 2, 3]).buffer });

  assert.equal(await ZX.Database.retryFailedUploads(), 1);
  assert.equal((await ZX.Database.get('outbox', key)).attempts, 0);
  await ZX.Database.put('outbox', { ...(await ZX.Database.get('outbox', key)), attempts: 6 });
  assert.equal(await ZX.Database.discardFailedUploads(), 1);
  assert.equal(await ZX.Database.get('outbox', key), undefined);
  assert.equal((await ZX.Database.state()).students[0].preparations[0].title, '备课');
  assert.equal((await ZX.Database.state()).students[0].preparations[0].files.length, 0);
});
