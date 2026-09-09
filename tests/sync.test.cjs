const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { IDBFactory } = require('fake-indexeddb');

function loadDevice(timers = {}) {
  const indexedDB = new IDBFactory();
  const window = { crypto: webcrypto, indexedDB, navigator: { onLine: true }, addEventListener() {} };
  window.window = window;
  const context = { window, crypto: webcrypto, indexedDB, navigator: window.navigator, structuredClone, console, Blob, fetch, setTimeout: timers.setTimeout || setTimeout, clearTimeout: timers.clearTimeout || clearTimeout };
  for (const file of ['src/model.js', 'src/database.js', 'src/files.js', 'src/sync.js']) vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  return window.Zhixing;
}

function mockCloud(userId) {
  const rows = new Map();
  const now = () => new Date().toISOString();
  const record = (entity, row) => ({
    key: `${entity}:${row.id}`, entity, id: row.id, studentId: row.student_id || null,
    data: entity === 'students' ? { name: row.name, school: row.school, targetSchool: row.target_school, currentScore: row.current_score, targetScore: row.target_score, nextLesson: row.next_lesson, focusContent: row.focus_content } : {},
    version: row.version, deletedAt: row.deleted_at, updatedAt: row.updated_at
  });
  function studentRow(mutation, version) {
    const d = mutation.data;
    return { id: mutation.id, user_id: userId, name: d.name || '', school: d.school || '', target_school: d.targetSchool || '', current_score: d.currentScore ?? null, target_score: d.targetScore ?? null, next_lesson: d.nextLesson || '', focus_content: d.focusContent || '', version, deleted_at: mutation.operation === 'delete' ? now() : null, updated_at: now() };
  }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: userId } } }) },
    rpc: async (name, args) => {
      if (name === 'migrate_legacy_tutor_profile') return { data: { status: 'already_migrated' }, error: null };
      if (name !== 'apply_tutor_mutations') return { data: null, error: new Error(`unknown RPC ${name}`) };
      const applied = [], conflicts = [];
      for (const mutation of args.p_mutations) {
        const key = `${mutation.entity}:${mutation.id}`, current = rows.get(key), base = Number(mutation.base_version || 0);
        if ((current?.version ?? 0) !== base) { conflicts.push({ key, entity: mutation.entity, id: mutation.id, cloud: record(mutation.entity, current) }); continue; }
        const version = base + 1;
        rows.set(key, studentRow({ ...mutation, data: mutation.data || {} }, version));
        applied.push({ key, version, updated_at: now() });
      }
      return { data: { applied, conflicts }, error: null };
    },
    from: table => ({
      select: () => ({ eq: async () => ({ data: [...rows.entries()].filter(([key]) => key.startsWith(`${table}:`)).map(([, value]) => structuredClone(value)), error: null }) }),
      upsert: async () => ({ error: null })
    }),
    channel: () => { const channel = { on: () => channel, subscribe: callback => { callback('SUBSCRIBED'); return channel; } }; return channel; },
    removeChannel: async () => {}
  };
  return { client, rows };
}

async function startDevice(ZX, client, state) {
  await ZX.Database.start(state);
  ZX.Files.configure({ client, bucket: 'tutor-files', endpoint: 'unused' });
  let current = state;
  await ZX.Sync.start({ client, onState: next => { current = next; } });
  return { get state() { return current; } };
}

test('two devices merge different records and preserve both versions of a same-record conflict', async () => {
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const firstId = '11111111-1111-4111-8111-111111111111', secondId = '22222222-2222-4222-8222-222222222222';
  const initial = { activeId: firstId, students: [
    { id: firstId, name: '学生一', school: '', targetSchool: '', currentScore: null, targetScore: null, nextLesson: '', focusContent: '', scores: [], custom: [], preparations: [], courseProgress: [] },
    { id: secondId, name: '学生二', school: '', targetSchool: '', currentScore: null, targetScore: null, nextLesson: '', focusContent: '', scores: [], custom: [], preparations: [], courseProgress: [] }
  ] };
  const cloud = mockCloud(userId), A = loadDevice(), B = loadDevice();
  const deviceA = await startDevice(A, cloud.client, initial);
  const deviceB = await startDevice(B, cloud.client, { students: [], activeId: null });
  assert.equal(deviceB.state.students.length, 2);

  let stateA = await A.Database.state(), stateB = await B.Database.state();
  stateA.students.find(item => item.id === firstId).school = '设备 A 学校';
  stateB.students.find(item => item.id === secondId).targetSchool = '设备 B 目标';
  await A.Database.persist(stateA); await B.Database.persist(stateB);
  await A.Sync.flush(); await B.Sync.flush(); await A.Sync.pull(); await B.Sync.pull();
  stateA = await A.Database.state(); stateB = await B.Database.state();
  for (const state of [stateA, stateB]) {
    assert.equal(state.students.find(item => item.id === firstId).school, '设备 A 学校');
    assert.equal(state.students.find(item => item.id === secondId).targetSchool, '设备 B 目标');
  }

  stateA.students.find(item => item.id === firstId).name = '设备 A 版本';
  stateB.students.find(item => item.id === firstId).name = '设备 B 版本';
  await A.Database.persist(stateA); await B.Database.persist(stateB);
  await A.Sync.flush(); await B.Sync.flush();
  const conflicts = await B.Database.all('conflicts');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].local.data.name, '设备 B 版本');
  assert.equal(conflicts[0].cloud.data.name, '设备 A 版本');
  assert.equal((await B.Database.state()).students.find(item => item.id === firstId).name, '设备 B 版本');
});

test('failed online synchronization schedules an automatic retry', async () => {
  const scheduled = [];
  const ZX = loadDevice({ setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, clearTimeout() {} });
  const cloud = mockCloud('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  await startDevice(ZX, cloud.client, { students: [], activeId: null });
  const state = await ZX.Database.state();
  state.students.push({ id: '44444444-4444-4444-8444-444444444444', name: '等待重试', scores: [], custom: [], preparations: [], courseProgress: [] });
  state.activeId = state.students[0].id;
  await ZX.Database.persist(state);
  const originalRpc = cloud.client.rpc;
  cloud.client.rpc = async (name, args) => name === 'apply_tutor_mutations' ? { data: null, error: new Error('temporary network failure') } : originalRpc(name, args);

  await assert.rejects(ZX.Sync.flush(), /temporary network failure/);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 5000);
  assert.equal((await ZX.Database.all('outbox'))[0].attempts, 1);
});

test('one failed attachment does not block other records or increment their retry count', async () => {
  const ZX = loadDevice();
  const cloud = mockCloud('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  await startDevice(ZX, cloud.client, { students: [], activeId: null });
  const studentId = '66666666-6666-4666-8666-666666666666';
  await ZX.Database.put('outbox', { key: `students:${studentId}`, entity: 'students', id: studentId, studentId: null, data: { name: '可正常同步' }, version: 0, baseVersion: 0, operation: 'upsert', attempts: 0 });
  const attachmentId = '77777777-7777-4777-8777-777777777777';
  await ZX.Database.put('outbox', { key: `attachments:${attachmentId}`, entity: 'attachments', id: attachmentId, studentId, data: { name: '失败.pdf', localBlobKey: 'blob:failed' }, version: 0, baseVersion: 0, operation: 'upsert', attempts: 0 });
  const originalBeforeSync = ZX.Files.beforeSync;
  ZX.Files.beforeSync = async item => { if (item.entity === 'attachments') throw new Error('TUS denied'); return item; };

  await ZX.Sync.flush();
  ZX.Files.beforeSync = originalBeforeSync;
  assert.ok(cloud.rows.has(`students:${studentId}`));
  assert.equal(await ZX.Database.get('outbox', `students:${studentId}`), undefined);
  assert.equal((await ZX.Database.get('outbox', `attachments:${attachmentId}`)).attempts, 1);
});

test('sync processes a bounded batch instead of flooding the network', async () => {
  const ZX = loadDevice();
  const cloud = mockCloud('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  await startDevice(ZX, cloud.client, { students: [], activeId: null });
  for (let index = 0; index < 25; index++) {
    const id = `80000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    await ZX.Database.put('outbox', { key: `students:${id}`, entity: 'students', id, studentId: null, data: { name: `学生${index}` }, version: 0, baseVersion: 0, operation: 'upsert', attempts: 0 });
  }
  await ZX.Sync.flush();
  assert.equal(cloud.rows.size, 20);
  assert.equal((await ZX.Database.all('outbox')).length, 5);
});

test('production TUS endpoint uses the direct Supabase Storage hostname', () => {
  const source = fs.readFileSync('app.js', 'utf8');
  assert.match(source, /nnnxsjqbklnykshqgntt\.storage\.supabase\.co\/storage\/v1\/upload\/resumable/);
});
