const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { indexedDB } = require('fake-indexeddb');

function load() {
  const window = { crypto: webcrypto, indexedDB, navigator: { onLine: true } };
  window.window = window;
  const context = { window, crypto: webcrypto, indexedDB, structuredClone, console, navigator: window.navigator, Blob, fetch, setTimeout, clearTimeout };
  for (const file of ['src/model.js', 'src/database.js', 'src/files.js']) vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  return window.Zhixing;
}

test('cloud attachment is removed only after its tombstone is accepted', async () => {
  const ZX = load();
  await ZX.Database.wipe();
  const studentId = '11111111-1111-4111-8111-111111111111';
  const attachmentId = '22222222-2222-4222-8222-222222222222';
  const state = await ZX.Database.start({
    activeId: studentId,
    students: [{
      id: studentId, name: '学生', scores: [], custom: [], courseProgress: [],
      preparations: [{ id: '33333333-3333-4333-8333-333333333333', title: '备课', files: [{ id: attachmentId, name: '讲义.pdf', path: 'u/s/p/guide.pdf', _version: 4 }] }]
    }]
  });
  state.students[0].preparations[0].files = [];
  await ZX.Database.persist(state);
  const mutation = await ZX.Database.get('outbox', `attachments:${attachmentId}`);
  let removeCalls = 0;
  let failOnce = true;
  ZX.Files.configure({
    bucket: 'tutor-files', endpoint: 'unused',
    client: { storage: { from: () => ({ remove: async () => { removeCalls++; if (failOnce) { failOnce = false; return { error: new Error('temporary') }; } return { error: null }; } }) } }
  });

  await ZX.Files.beforeSync(mutation);
  assert.equal(removeCalls, 0, 'Storage must remain intact before the database accepts deletion');

  await ZX.Files.afterApplied([{ key: mutation.key }], [mutation]);
  assert.equal(removeCalls, 1);
  let cleanup = await ZX.Database.all('cleanup');
  assert.equal(cleanup.length, 1);
  assert.equal(cleanup[0].attempts, 1);

  await ZX.Files.processCleanup();
  cleanup = await ZX.Database.all('cleanup');
  assert.equal(removeCalls, 2);
  assert.equal(cleanup.length, 0);
});
