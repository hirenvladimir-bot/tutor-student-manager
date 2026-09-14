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
    data: entity === 'students' ? { name: row.name, school: row.school, targetSchool: row.target_school, currentScore: row.current_score, targetScore: row.target_score, nextLesson: row.next_lesson, focusContent: row.focus_content }
      : entity === 'scores' ? { label: row.label || '', date: row.exam_date || '', score: Number(row.score) }
      : entity === 'custom_fields' ? { key: row.field_key || '', value: row.field_value || '' }
      : entity === 'attachments' ? { ownerType: row.owner_type, ownerId: row.owner_id, name: row.name, relativePath: row.relative_path || '', type: row.mime_type || 'application/octet-stream', size: Number(row.size || 0), path: row.storage_path || '', data: row.legacy_data || '', pending: false, localBlobKey: '' }
      : {},
    version: row.version, deletedAt: row.deleted_at, updatedAt: row.updated_at
  });
  function studentRow(mutation, version) {
    const d = mutation.data;
    if (mutation.entity === 'attachments') return { id: mutation.id, user_id: userId, student_id: mutation.student_id, owner_type: d.ownerType, owner_id: d.ownerId, name: d.name || '', relative_path: d.relativePath || '', mime_type: d.type || 'application/octet-stream', size: Number(d.size || 0), storage_path: d.path || '', legacy_data: d.data || '', version, deleted_at: mutation.operation === 'delete' ? now() : null, updated_at: now() };
    if (mutation.entity === 'scores') return { id: mutation.id, user_id: userId, student_id: mutation.student_id, label: d.label || '', exam_date: d.date || '', score: Number(d.score || 0), version, deleted_at: mutation.operation === 'delete' ? now() : null, updated_at: now() };
    if (mutation.entity === 'custom_fields') return { id: mutation.id, user_id: userId, student_id: mutation.student_id, field_key: d.key || '', field_value: d.value || '', version, deleted_at: mutation.operation === 'delete' ? now() : null, updated_at: now() };
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

test('startup waits for asynchronous state normalization and drains the records it queues', async () => {
  const ZX = loadDevice(), userId = 'dededede-dede-4ede-8ede-dededededede', cloud = mockCloud(userId);
  await ZX.Database.start({ students: [], activeId: null });
  ZX.Files.configure({ client: cloud.client, bucket: 'tutor-files', endpoint: 'unused' });
  for (let index = 0; index < 4; index++) {
    const id = `${index + 1}1111111-1111-4111-8111-111111111111`;
    cloud.rows.set(`students:${id}`, { id, user_id: userId, name: `待迁移学生${index + 1}`, school: '', target_school: '', current_score: null, target_score: null, next_lesson: '', focus_content: '', version: 1, deleted_at: null, updated_at: new Date().toISOString() });
  }

  await ZX.Sync.start({
    client: cloud.client,
    onState: async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      const state = await ZX.Database.state();
      let changed = false;
      for (const student of state.students) {
        if (!Array.isArray(student.nextLessonEntries)) { student.nextLessonEntries = []; changed = true; }
        if (!Array.isArray(student.focusContentEntries)) { student.focusContentEntries = []; changed = true; }
      }
      if (changed) await ZX.Database.persist(state, true);
    }
  });

  assert.equal((await ZX.Database.all('outbox')).length, 0, 'normalization records must be flushed before startup reports ready');
  assert.equal([...cloud.rows.values()].filter(row => row.name?.startsWith('待迁移学生')).every(row => row.version === 2), true);
});

test('conflicted records pause in the outbox until the user resolves them', async () => {
  const scheduled = [];
  const ZX = loadDevice({ setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, clearTimeout() {} });
  const userId = 'abababab-abab-4bab-8bab-abababababab';
  const studentId = '12121212-1212-4212-8212-121212121212';
  const cloud = mockCloud(userId);
  await startDevice(ZX, cloud.client, { activeId: studentId, students: [{ id: studentId, name: '初始名字', scores: [], custom: [], preparations: [], courseProgress: [] }] });

  const state = await ZX.Database.state();
  state.students[0].name = '本机冲突版';
  await ZX.Database.persist(state);
  const row = cloud.rows.get(`students:${studentId}`);
  cloud.rows.set(`students:${studentId}`, { ...row, name: '云端冲突版', version: row.version + 1, updated_at: new Date().toISOString() });

  let mutationCalls = 0;
  const originalRpc = cloud.client.rpc;
  cloud.client.rpc = async (name, args) => {
    if (name === 'apply_tutor_mutations') mutationCalls++;
    return originalRpc(name, args);
  };
  await ZX.Sync.flush();
  assert.equal((await ZX.Database.all('conflicts')).length, 1);
  assert.equal(mutationCalls, 1);

  await ZX.Sync.flush();
  assert.equal(mutationCalls, 1, 'a known conflict must not be resubmitted');
  const timersBeforeSync = scheduled.length;
  await ZX.Sync.sync();
  assert.equal(scheduled.length, timersBeforeSync, 'a conflict alone must not schedule a tight retry loop');
  assert.equal((await ZX.Database.get('outbox', `students:${studentId}`)).data.name, '本机冲突版');
});

test('an already-applied attachment retry converges without creating or retaining a conflict', async () => {
  const ZX = loadDevice(), userId = 'acacacac-acac-4cac-8cac-acacacacacac', cloud = mockCloud(userId);
  await startDevice(ZX, cloud.client, { students: [], activeId: null });
  const id = '34343434-3434-4434-8434-343434343434', studentId = '45454545-4545-4454-8454-454545454545', ownerId = '56565656-5656-4656-8656-565656565656';
  const data = { ownerType: 'preparations', ownerId, name: '已上传.pdf', relativePath: '', type: 'application/pdf', size: 123, path: `${userId}/${studentId}/file.pdf`, data: '', pending: false, localBlobKey: '', uploadPath: '' };
  const row = { id, user_id: userId, student_id: studentId, owner_type: data.ownerType, owner_id: ownerId, name: data.name, relative_path: '', mime_type: data.type, size: data.size, storage_path: data.path, legacy_data: '', version: 1, deleted_at: null, updated_at: new Date().toISOString() };
  cloud.rows.set(`attachments:${id}`, row);
  const local = { key: `attachments:${id}`, entity: 'attachments', id, studentId, data, version: 0, baseVersion: 0, operation: 'upsert', attempts: 0 };
  await ZX.Database.put('outbox', local);
  await ZX.Sync.flush();
  assert.equal(await ZX.Database.get('outbox', local.key), undefined);
  assert.equal(await ZX.Database.get('conflicts', local.key), undefined);
  assert.equal((await ZX.Database.get('records', local.key)).version, 1);
  await ZX.Database.saveConflict({ key: local.key, entity: 'attachments', id, local, cloud: { key: local.key, entity: 'attachments', id, studentId, data, version: 1, deletedAt: null, updatedAt: row.updated_at } });
  await ZX.Sync.pull();
  assert.equal(await ZX.Database.get('conflicts', local.key), undefined, 'a stale conflict without an outbox mutation must be removed');
});

test('legacy attachment metadata aliases converge and do not delete Storage objects', async () => {
  const ZX = loadDevice(), userId = 'cacacaca-caca-4aca-8aca-cacacacacaca', cloud = mockCloud(userId);
  await startDevice(ZX, cloud.client, { students: [], activeId: null });
  const id = '10101010-1010-4010-8010-101010101010', studentId = '20202020-2020-4020-8020-202020202020', ownerId = '30303030-3030-4030-8030-303030303030', key = `attachments:${id}`;
  const row = { id, user_id: userId, student_id: studentId, owner_type: 'course_progress', owner_id: ownerId, name: '旧讲义.pdf', relative_path: '', mime_type: 'application/pdf', size: 321, storage_path: `${userId}/${studentId}/旧讲义.pdf`, legacy_data: '', version: 2, deleted_at: null, updated_at: new Date().toISOString() };
  cloud.rows.set(key, row);
  const local = { key, entity: 'attachments', id, studentId, data: { ownerType: 'course-progress', ownerId, name: '旧讲义.pdf', relativePath: '旧讲义.pdf', type: '', size: '', path: '', data: '', pending: false, localBlobKey: '' }, version: 1, baseVersion: 1, operation: 'upsert', attempts: 0 };
  await ZX.Database.put('outbox', local);
  await ZX.Database.saveConflict({ key, entity: 'attachments', id, local, cloud: { key, entity: 'attachments', id, studentId, data: {}, version: 2 } });

  await ZX.Sync.pull();

  assert.equal(await ZX.Database.get('outbox', key), undefined);
  assert.equal(await ZX.Database.get('conflicts', key), undefined);
  assert.equal((await ZX.Database.get('records', key)).data.path, row.storage_path);
  assert.equal((await ZX.Database.all('cleanup')).length, 0, 'legacy convergence must never schedule an unverified Storage deletion');
});

test('a historical attachment plus custom-field and score tombstones converge once and stay at zero', async () => {
  const ZX = loadDevice(), userId = 'c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0', cloud = mockCloud(userId);
  await startDevice(ZX, cloud.client, { students: [], activeId: null });
  const studentId = 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1';
  const attachmentId = 'c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2';
  const ownerId = 'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3';
  const customIds = ['c4c4c4c4-c4c4-44c4-84c4-c4c4c4c4c4c4', 'c5c5c5c5-c5c5-45c5-85c5-c5c5c5c5c5c5'];
  const scoreId = 'c6c6c6c6-c6c6-46c6-86c6-c6c6c6c6c6c6';
  const updatedAt = new Date().toISOString();
  const attachmentKey = `attachments:${attachmentId}`;
  cloud.rows.set(attachmentKey, { id: attachmentId, user_id: userId, student_id: studentId, owner_type: 'preparations', owner_id: ownerId, name: '历史讲义.pdf', relative_path: '', mime_type: 'application/pdf', size: 512, storage_path: `${userId}/${studentId}/历史讲义.pdf`, legacy_data: '', version: 2, deleted_at: null, updated_at: updatedAt });
  const attachmentLocal = { key: attachmentKey, entity: 'attachments', id: attachmentId, studentId, data: { ownerType: 'prep', ownerId, name: '历史讲义.pdf', relativePath: '历史讲义.pdf', type: '', size: '', path: '', data: '', pending: false, localBlobKey: '' }, version: 1, baseVersion: 1, operation: 'upsert', attempts: 0 };
  await ZX.Database.put('outbox', attachmentLocal);
  await ZX.Database.saveConflict({ key: attachmentKey, entity: 'attachments', id: attachmentId, local: attachmentLocal, cloud: { key: attachmentKey, entity: 'attachments', id: attachmentId, studentId, data: {}, version: 2 } });

  for (const [index, id] of customIds.entries()) {
    const key = `custom_fields:${id}`, data = { key: `旧信息${index + 1}`, value: '已删除' };
    cloud.rows.set(key, { id, user_id: userId, student_id: studentId, field_key: data.key, field_value: data.value, version: 2, deleted_at: updatedAt, updated_at: updatedAt });
    const local = { key, entity: 'custom_fields', id, studentId, data, version: 1, baseVersion: 1, operation: 'delete', deletedAt: updatedAt, attempts: 0 };
    await ZX.Database.put('outbox', local);
    await ZX.Database.saveConflict({ key, entity: 'custom_fields', id, local, cloud: { key, entity: 'custom_fields', id, studentId, data, version: 2, deletedAt: updatedAt } });
  }
  const scoreKey = `scores:${scoreId}`, scoreData = { label: '旧考试', date: '2026-09-01', score: 76 };
  cloud.rows.set(scoreKey, { id: scoreId, user_id: userId, student_id: studentId, label: scoreData.label, exam_date: scoreData.date, score: scoreData.score, version: 2, deleted_at: updatedAt, updated_at: updatedAt });
  const scoreLocal = { key: scoreKey, entity: 'scores', id: scoreId, studentId, data: scoreData, version: 1, baseVersion: 1, operation: 'delete', deletedAt: updatedAt, attempts: 0 };
  await ZX.Database.put('outbox', scoreLocal);
  await ZX.Database.saveConflict({ key: scoreKey, entity: 'scores', id: scoreId, local: scoreLocal, cloud: { key: scoreKey, entity: 'scores', id: scoreId, studentId, data: scoreData, version: 2, deletedAt: updatedAt } });

  let mutationCalls = 0;
  const originalRpc = cloud.client.rpc;
  cloud.client.rpc = async (name, args) => { if (name === 'apply_tutor_mutations') mutationCalls++; return originalRpc(name, args); };

  for (let pass = 0; pass < 5; pass++) {
    assert.equal(await ZX.Sync.sync(), true, `sync pass ${pass + 1} should remain complete`);
    assert.equal((await ZX.Database.all('outbox')).length, 0, `outbox must stay empty after pass ${pass + 1}`);
    assert.equal((await ZX.Database.all('conflicts')).length, 0, `conflicts must stay empty after pass ${pass + 1}`);
  }
  assert.equal(mutationCalls, 0, 'historical equivalent records must not be resubmitted after convergence');
  assert.equal((await ZX.Database.all('cleanup')).length, 0, 'convergence must not schedule Storage deletion');
});

test('attachment conflicts with two different cloud paths remain for manual review', async () => {
  const ZX = loadDevice(), userId = 'cbcbcbcb-cbcb-4bcb-8bcb-cbcbcbcbcbcb', cloud = mockCloud(userId);
  await startDevice(ZX, cloud.client, { students: [], activeId: null });
  const id = '40404040-4040-4040-8040-404040404040', studentId = '50505050-5050-4050-8050-505050505050', ownerId = '60606060-6060-4060-8060-606060606060', key = `attachments:${id}`;
  cloud.rows.set(key, { id, user_id: userId, student_id: studentId, owner_type: 'preparations', owner_id: ownerId, name: '冲突.pdf', relative_path: '', mime_type: 'application/pdf', size: 10, storage_path: `${userId}/cloud.pdf`, legacy_data: '', version: 2, deleted_at: null, updated_at: new Date().toISOString() });
  const local = { key, entity: 'attachments', id, studentId, data: { ownerType: 'preparations', ownerId, name: '冲突.pdf', relativePath: '', type: 'application/pdf', size: 10, path: `${userId}/local.pdf`, data: '', pending: false, localBlobKey: '' }, version: 1, baseVersion: 1, operation: 'upsert', attempts: 0 };
  await ZX.Database.put('outbox', local);

  await ZX.Sync.pull();

  assert.ok(await ZX.Database.get('conflicts', key));
  assert.ok(await ZX.Database.get('outbox', key));
  assert.equal((await ZX.Database.all('cleanup')).length, 0);
});

test('pull re-reads the latest attachment mutation after an upload completes concurrently', async () => {
  const ZX = loadDevice(), userId = 'adadadad-adad-4dad-8dad-adadadadadad', cloud = mockCloud(userId);
  await startDevice(ZX, cloud.client, { students: [], activeId: null });
  const id = '67676767-6767-4767-8767-676767676767', studentId = '78787878-7878-4787-8787-787878787878', ownerId = '89898989-8989-4989-8989-898989898989', key = `attachments:${id}`;
  const pending = { key, entity: 'attachments', id, studentId, data: { ownerType: 'preparations', ownerId, name: '并发.pdf', relativePath: '', type: 'application/pdf', size: 9, path: '', data: '', pending: true, localBlobKey: 'blob:pending', uploadPath: 'reserved/path.pdf' }, version: 0, baseVersion: 0, operation: 'upsert', attempts: 0 };
  await ZX.Database.put('outbox', pending);
  let release, selected;
  const waiting = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { selected = resolve; }), originalFrom = cloud.client.from;
  cloud.client.from = table => table === 'attachments' ? { select: () => ({ eq: async () => { selected(); await waiting; return { data: [...cloud.rows.values()].filter(row => row.owner_type), error: null }; } }) } : originalFrom(table);
  const pulling = ZX.Sync.pull();
  await reached;
  const path = `${userId}/${studentId}/uploaded.pdf`, completedData = { ...pending.data, path, pending: false };
  delete completedData.localBlobKey; delete completedData.uploadPath;
  cloud.rows.set(key, { id, user_id: userId, student_id: studentId, owner_type: 'preparations', owner_id: ownerId, name: '并发.pdf', relative_path: '', mime_type: 'application/pdf', size: 9, storage_path: path, legacy_data: '', version: 1, deleted_at: null, updated_at: new Date().toISOString() });
  await ZX.Database.put('outbox', { ...pending, data: completedData });
  release();
  await pulling;
  assert.equal(await ZX.Database.get('outbox', key), undefined);
  assert.equal(await ZX.Database.get('conflicts', key), undefined);
  assert.equal((await ZX.Database.get('records', key)).data.path, path);
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
  assert.ok(cloud.rows.has(`students:${studentId}`), `cloud keys: ${[...cloud.rows.keys()].join(', ')}`);
  assert.equal(await ZX.Database.get('outbox', `students:${studentId}`), undefined);
  assert.equal((await ZX.Database.get('outbox', `attachments:${attachmentId}`)).attempts, 1);
});

test('a suspended TUS upload does not block ordinary records in the same batch', async () => {
  const ZX = loadDevice();
  const cloud = mockCloud('c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1');
  await startDevice(ZX, cloud.client, { students: [], activeId: null });
  const studentId = '71717171-7171-4171-8171-717171717171';
  const attachmentId = '72727272-7272-4272-8272-727272727272';
  await ZX.Database.put('outbox', { key: `students:${studentId}`, entity: 'students', id: studentId, studentId: null, data: { name: '不应等待上传' }, version: 0, baseVersion: 0, operation: 'upsert', attempts: 0 });
  await ZX.Database.put('outbox', { key: `attachments:${attachmentId}`, entity: 'attachments', id: attachmentId, studentId, data: { name: '悬挂.pdf', path: '', localBlobKey: 'blob:suspended' }, version: 0, baseVersion: 0, operation: 'upsert', attempts: 0 });
  const originalBeforeSync = ZX.Files.beforeSync;
  ZX.Files.beforeSync = item => item.entity === 'attachments' ? new Promise(() => {}) : originalBeforeSync(item);
  let ordinaryApplied;
  const applied = new Promise(resolve => { ordinaryApplied = resolve; });
  const originalRpc = cloud.client.rpc;
  let observedPayload, observedResult;
  cloud.client.rpc = async (name, args) => {
    const result = await originalRpc(name, args);
    if (name === 'apply_tutor_mutations' && args.p_mutations.some(item => item.entity === 'students')) { observedPayload = args.p_mutations; observedResult = result; ordinaryApplied(); }
    return result;
  };

  void ZX.Sync.flush();
  await applied;
  for (let index = 0; index < 20 && await ZX.Database.get('outbox', `students:${studentId}`); index++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(cloud.rows.has(`students:${studentId}`), `payload=${JSON.stringify(observedPayload)} result=${JSON.stringify(observedResult)} keys=${[...cloud.rows.keys()].join(', ')}`);
  assert.equal(await ZX.Database.get('outbox', `students:${studentId}`), undefined);
  assert.ok(await ZX.Database.get('outbox', `attachments:${attachmentId}`));
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

test('full sync drains every fresh bounded batch before reporting completion', async () => {
  const ZX = loadDevice();
  const cloud = mockCloud('d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1');
  await startDevice(ZX, cloud.client, { students: [], activeId: null });
  for (let index = 0; index < 45; index++) {
    const id = `81000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    await ZX.Database.put('outbox', { key: `students:${id}`, entity: 'students', id, studentId: null, data: { name: `排空学生${index}` }, version: 0, baseVersion: 0, operation: 'upsert', attempts: 0 });
  }

  assert.equal(await ZX.Sync.sync(), true);
  assert.equal(cloud.rows.size, 45);
  assert.equal((await ZX.Database.all('outbox')).length, 0);
});

test('an edit made while an RPC is in flight is rebased and synchronized instead of being dropped', async () => {
  const ZX = loadDevice();
  const userId = 'd2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2';
  const studentId = '82828282-8282-4282-8282-828282828282';
  const cloud = mockCloud(userId);
  await startDevice(ZX, cloud.client, { activeId: studentId, students: [{ id: studentId, name: '在途编辑', school: '', targetSchool: '', scores: [], custom: [], preparations: [], courseProgress: [] }] });
  let state = await ZX.Database.state();
  state.students[0].school = '第一项修改';
  await ZX.Database.persist(state);

  const originalRpc = cloud.client.rpc;
  let releaseRpc, rpcStarted;
  const waiting = new Promise(resolve => { releaseRpc = resolve; });
  const started = new Promise(resolve => { rpcStarted = resolve; });
  let mutationCalls = 0;
  cloud.client.rpc = async (name, args) => {
    if (name !== 'apply_tutor_mutations') return originalRpc(name, args);
    mutationCalls++;
    if (mutationCalls === 1) { rpcStarted(); await waiting; }
    return originalRpc(name, args);
  };

  const syncing = ZX.Sync.sync();
  await started;
  state = await ZX.Database.state();
  state.students[0].targetSchool = '第二项修改';
  await ZX.Database.persist(state);
  ZX.Sync.schedule();
  releaseRpc();
  assert.equal(await syncing, true);

  const row = cloud.rows.get(`students:${studentId}`);
  assert.equal(row.school, '第一项修改');
  assert.equal(row.target_school, '第二项修改');
  assert.equal(row.version, 3);
  assert.equal(mutationCalls, 2);
  assert.equal((await ZX.Database.all('outbox')).length, 0);
});

test('overlapping sync calls share one run and do not submit a mutation twice', async () => {
  const ZX = loadDevice();
  const cloud = mockCloud('d3d3d3d3-d3d3-43d3-83d3-d3d3d3d3d3d3');
  await startDevice(ZX, cloud.client, { students: [], activeId: null });
  const id = '83838383-8383-4383-8383-838383838383';
  await ZX.Database.put('outbox', { key: `students:${id}`, entity: 'students', id, studentId: null, data: { name: '单飞' }, version: 0, baseVersion: 0, operation: 'upsert', attempts: 0 });
  const originalRpc = cloud.client.rpc;
  let calls = 0;
  cloud.client.rpc = async (name, args) => { if (name === 'apply_tutor_mutations') calls++; return originalRpc(name, args); };

  const [first, second, third] = await Promise.all([ZX.Sync.sync(), ZX.Sync.sync(), ZX.Sync.sync()]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(third, true);
  assert.equal(calls, 1);
  assert.equal((await ZX.Database.all('outbox')).length, 0);
});

test('logout and account switch ignore an old in-flight RPC and do not reuse its promise', async () => {
  const ZX = loadDevice();
  const cloudA = mockCloud('a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1');
  const cloudB = mockCloud('b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1');
  await startDevice(ZX, cloudA.client, { students: [], activeId: null });
  const oldId = '91919191-9191-4191-8191-919191919191';
  await ZX.Database.put('outbox', { key: `students:${oldId}`, entity: 'students', id: oldId, studentId: null, data: { name: '旧账号响应' }, operation: 'upsert', baseVersion: 0, attempts: 0 });
  const originalRpc = cloudA.client.rpc;
  let release, announce;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { announce = resolve; });
  cloudA.client.rpc = async (name, args) => {
    if (name === 'apply_tutor_mutations') { announce(); await waiting; }
    return originalRpc(name, args);
  };

  const oldSync = ZX.Sync.sync();
  await started;
  await ZX.Sync.stop();
  await ZX.Database.wipe();
  const newStart = ZX.Sync.start({ client: cloudB.client, onState() {}, onStatus() {} });
  assert.equal(await newStart, true, 'new account startup must not await the old account promise');
  release();
  assert.equal(await oldSync, false);
  assert.equal(await ZX.Database.get('records', `students:${oldId}`), undefined);
  assert.equal((await ZX.Database.all('outbox')).length, 0);
  assert.equal(cloudB.rows.has(`students:${oldId}`), false);
});

test('logout prevents an old pull response from writing into a new local session', async () => {
  const ZX = loadDevice();
  const userA = 'a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2';
  const cloudA = mockCloud(userA), cloudB = mockCloud('b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2');
  await startDevice(ZX, cloudA.client, { students: [], activeId: null });
  const staleId = '92929292-9292-4292-8292-929292929292';
  cloudA.rows.set(`students:${staleId}`, { id: staleId, user_id: userA, name: '迟到的旧账号数据', school: '', target_school: '', current_score: null, target_score: null, next_lesson: '', focus_content: '', version: 1, deleted_at: null, updated_at: new Date().toISOString() });
  const originalFrom = cloudA.client.from;
  let release, announce;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { announce = resolve; });
  cloudA.client.from = table => table === 'students' ? { select: () => ({ eq: async () => { announce(); await waiting; return originalFrom(table).select().eq('user_id', userA); } }) } : originalFrom(table);

  const oldPull = ZX.Sync.pull();
  await started;
  await ZX.Sync.stop();
  await ZX.Database.wipe();
  assert.equal(await ZX.Sync.start({ client: cloudB.client, onState() {}, onStatus() {} }), true);
  release();
  assert.equal(await oldPull, false);
  assert.equal(await ZX.Database.get('records', `students:${staleId}`), undefined);
});

test('stop waits for an already-started local commit before logout can safely wipe storage', async () => {
  const ZX = loadDevice();
  const cloud = mockCloud('a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3');
  await startDevice(ZX, cloud.client, { students: [], activeId: null });
  const id = '93939393-9393-4393-8393-939393939393';
  await ZX.Database.put('outbox', { key: `students:${id}`, entity: 'students', id, studentId: null, data: { name: '事务收尾' }, operation: 'upsert', baseVersion: 0, attempts: 0 });
  const originalMarkApplied = ZX.Database.markApplied;
  let release, announce;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { announce = resolve; });
  ZX.Database.markApplied = async (...args) => { announce(); await waiting; return originalMarkApplied(...args); };

  const syncing = ZX.Sync.sync();
  await started;
  let stopped = false;
  const stopping = ZX.Sync.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false, 'stop must wait for the local transaction already admitted by the old session');
  release();
  await stopping;
  await ZX.Database.wipe();
  await syncing;
  assert.equal(await ZX.Database.get('records', `students:${id}`), undefined);
  assert.equal((await ZX.Database.all('outbox')).length, 0);
});

test('direct account switch refuses to submit an outbox owned by the previous user', async () => {
  const ZX = loadDevice();
  const cloudA = mockCloud('a4a4a4a4-a4a4-44a4-84a4-a4a4a4a4a4a4');
  const cloudB = mockCloud('b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4');
  await startDevice(ZX, cloudA.client, { students: [], activeId: null });
  const id = '94949494-9494-4494-8494-949494949494';
  const key = `students:${id}`;
  await ZX.Database.put('outbox', { key, entity: 'students', id, studentId: null, data: { name: '仅属于账号A' }, operation: 'upsert', baseVersion: 0, attempts: 0 });
  let bMutationCalls = 0;
  const originalRpc = cloudB.client.rpc;
  cloudB.client.rpc = async (name, args) => { if (name === 'apply_tutor_mutations') bMutationCalls++; return originalRpc(name, args); };

  assert.equal(await ZX.Sync.start({ client: cloudB.client, onState() {}, onStatus() {} }), false);
  assert.equal(bMutationCalls, 0);
  assert.equal(cloudB.rows.size, 0);
  assert.ok(await ZX.Database.get('outbox', key), 'old unsynced work is preserved for an explicit logout/reset decision');
});

test('legacy compatibility snapshot failures make the sync visibly fail', async () => {
  const ZX = loadDevice();
  const cloud = mockCloud('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  await startDevice(ZX, cloud.client, { students: [], activeId: null });
  const from = cloud.client.from;
  cloud.client.from = table => table === 'tutor_profiles'
    ? { upsert: async () => ({ error: new Error('snapshot denied') }) }
    : from(table);

  assert.equal(await ZX.Sync.sync(), false);
});

test('sync stays incomplete while an exhausted failed record is retained', async () => {
  const ZX = loadDevice();
  const cloud = mockCloud('ffffffff-ffff-4fff-8fff-ffffffffffff');
  await startDevice(ZX, cloud.client, { students: [], activeId: null });
  const id = '99999999-9999-4999-8999-999999999999';
  await ZX.Database.put('outbox', { key: `students:${id}`, entity: 'students', id, data: { name: '同步失败记录' }, operation: 'upsert', baseVersion: 0, attempts: 6, lastError: 'RPC rejected' });

  assert.equal(await ZX.Sync.sync(), false);
  assert.equal((await ZX.Database.stats()).failed, 1);
});

test('production TUS endpoint uses the direct Supabase Storage hostname', () => {
  const source = fs.readFileSync('app.js', 'utf8');
  assert.match(source, /nnnxsjqbklnykshqgntt\.storage\.supabase\.co\/storage\/v1\/upload\/resumable/);
});
