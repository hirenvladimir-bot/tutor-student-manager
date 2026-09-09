const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { IDBFactory } = require('fake-indexeddb');

function load(tus) {
  const indexedDB = new IDBFactory();
  const window = { crypto: webcrypto, indexedDB, navigator: { onLine: true }, tus };
  window.window = window;
  const context = { window, crypto: webcrypto, indexedDB, structuredClone, console, navigator: window.navigator, Blob, fetch, setTimeout, clearTimeout };
  for (const file of ['src/model.js', 'src/database.js', 'src/files.js']) vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  return window.Zhixing;
}

function uploadClient() {
  return {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'user-a' } } } }),
      getUser: async () => ({ data: { user: { id: 'user-a' } } })
    }
  };
}

function mockFile(name, relativePath = '') {
  const bytes = new TextEncoder().encode(`content:${name}`);
  return { name, webkitRelativePath: relativePath, type: 'application/pdf', size: bytes.byteLength, lastModified: 1, arrayBuffer: async () => bytes.buffer };
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

test('TUS upload resumes a previous fingerprint and preserves a folder path', async () => {
  const uploads = [];
  class Upload {
    constructor(file, options) { this.file = file; this.options = options; this.resumed = null; uploads.push(this); }
    async findPreviousUploads() { return [{ uploadUrl: 'resume-me' }]; }
    resumeFromPreviousUpload(previous) { this.resumed = previous; }
    start() { this.options.onProgress(this.file.size, this.file.size); this.options.onSuccess(); }
  }
  const ZX = load({ Upload }), status = [];
  ZX.Files.configure({ client: uploadClient(), bucket: 'tutor-files', endpoint: 'https://storage.test/upload/resumable' });
  const [attachment] = await ZX.Files.prepare([mockFile('讲义.pdf', '第一章/讲义.pdf')], 'preparations', 'prep-a', 'student-a', message => status.push(message));

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].resumed.uploadUrl, 'resume-me');
  assert.equal(uploads[0].options.chunkSize, 6 * 1024 * 1024);
  assert.equal(uploads[0].options.metadata.bucketName, 'tutor-files');
  assert.match(uploads[0].options.metadata.objectName, /^user-a\/student-a\/preparations\/prep-a\/.+-file\.pdf$/);
  assert.equal(attachment.relativePath, '第一章/讲义.pdf');
  assert.equal(attachment.pending, false);
  assert.match(status.at(-1), /100%/);
});

test('a partial upload failure keeps successful paths and queues only failed files locally', async () => {
  class Upload {
    constructor(file, options) { this.file = file; this.options = options; }
    async findPreviousUploads() { return []; }
    start() { if (this.file.name === '失败.pdf') this.options.onError(new Error('network interrupted')); else { this.options.onProgress(this.file.size, this.file.size); this.options.onSuccess(); } }
  }
  const ZX = load({ Upload });
  ZX.Files.configure({ client: uploadClient(), bucket: 'tutor-files', endpoint: 'https://storage.test/upload/resumable' });
  const attachments = await ZX.Files.prepare([mockFile('成功.pdf'), mockFile('失败.pdf')], 'course-progress', 'course-a', 'student-a');

  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].pending, false);
  assert.match(attachments[0].path, /^user-a\/student-a\/course-progress\/course-a\//);
  assert.equal(attachments[1].pending, true);
  assert.equal(attachments[1].path, '');
  assert.ok(attachments[1].localBlobKey);
  const cached = await ZX.Database.all('blobs');
  assert.equal(cached.length, 1);
  assert.equal(cached[0].name, '失败.pdf');
});
