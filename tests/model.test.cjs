const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const context = { window: {}, crypto: webcrypto };
context.window.window = context.window;
context.window.crypto = webcrypto;
vm.runInNewContext(fs.readFileSync('src/model.js', 'utf8'), context);
const Model = context.window.Zhixing.Model;

function fixture() {
  return { activeId: '11111111-1111-4111-8111-111111111111', students: [{
    id: '11111111-1111-4111-8111-111111111111', name: '林小雨', school: '一中', targetSchool: '二中', currentScore: '待测', targetScore: '120/150', nextLesson: '函数', focusContent: '审题',
    scores: [{ id: '22222222-2222-4222-8222-222222222222', label: '月考', date: '2026-09-09', score: 86.5 }],
    custom: [{ id: '33333333-3333-4333-8333-333333333333', key: '教材', value: '人教版' }],
    preparations: [{ id: '44444444-4444-4444-8444-444444444444', title: '第一课', content: '讲义', date: '9/9', files: [{ id: '55555555-5555-4555-8555-555555555555', name: '讲义.pdf', type: 'application/pdf', size: 12, path: 'u/s/p/file.pdf' }] }],
    courseProgress: []
  }] };
}

test('keeps free-form profile scores while exam scores stay numeric', () => {
  const records = Model.flatten(fixture());
  assert.equal(records.get('students:11111111-1111-4111-8111-111111111111').data.currentScore, '待测');
  assert.equal(records.get('scores:22222222-2222-4222-8222-222222222222').data.score, 86.5);
});

test('flatten and hydrate retain every existing entity and attachment', () => {
  const original = fixture();
  const restored = Model.hydrate(Model.flatten(original), original.activeId);
  assert.equal(restored.students[0].preparations[0].files[0].name, '讲义.pdf');
  assert.equal(restored.students[0].custom[0].value, '人教版');
  assert.equal(restored.students[0].targetScore, '120/150');
});

test('legacy data-url attachments survive v2 normalization', () => {
  const original = fixture();
  original.students[0].preparations[0].files[0] = { id: '55555555-5555-4555-8555-555555555555', name: '旧讲义.txt', type: 'text/plain', data: 'data:text/plain;base64,5YaF5a65' };
  const restored = Model.hydrate(Model.flatten(original), original.activeId);
  assert.equal(restored.students[0].preparations[0].files[0].data, 'data:text/plain;base64,5YaF5a65');
});

test('pending attachment upload paths survive local model round-trips', () => {
  const original = fixture();
  Object.assign(original.students[0].preparations[0].files[0], { path: '', pending: true, localBlobKey: 'blob:pending', uploadPath: 'user/student/preparations/prep/file.pdf' });
  const restored = Model.hydrate(Model.flatten(original), original.activeId);
  assert.equal(restored.students[0].preparations[0].files[0].uploadPath, 'user/student/preparations/prep/file.pdf');
});

test('diff isolates record edits and creates tombstones for deletions', () => {
  const before = Model.flatten(fixture());
  const changed = fixture(); changed.students[0].scores[0].score = 90;
  const edits = Model.diff(before, Model.flatten(changed));
  assert.deepEqual(Array.from(edits, x => x.entity), ['scores']);
  changed.students[0].scores = [];
  const deletes = Model.diff(before, Model.flatten(changed));
  assert.equal(deletes.find(x => x.entity === 'scores').operation, 'delete');
});

test('hydrate associates large attachment sets without repeatedly scanning owner lists', () => {
  const studentId = '11111111-1111-4111-8111-111111111111';
  const records = new Map();
  records.set(`students:${studentId}`, { entity: 'students', id: studentId, studentId: null, data: { name: '性能测试' }, version: 1 });
  for (let index = 0; index < 3000; index++) {
    const ownerId = `prep-${index}`;
    records.set(`preparations:${ownerId}`, { entity: 'preparations', id: ownerId, studentId, data: { title: ownerId }, version: 1 });
    records.set(`attachments:file-${index}`, { entity: 'attachments', id: `file-${index}`, studentId, data: { ownerType: 'preparations', ownerId, name: `${index}.pdf` }, version: 1 });
  }
  const start = performance.now();
  const restored = Model.hydrate(records, studentId);
  assert.equal(restored.students[0].preparations[2999].files[0].name, '2999.pdf');
  assert.ok(performance.now() - start < 500, 'large attachment hydration should remain linear and fast');
});
