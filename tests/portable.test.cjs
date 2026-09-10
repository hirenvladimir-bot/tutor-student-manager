const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const context = { window: {}, crypto: webcrypto, TextEncoder, TextDecoder, atob, btoa };
context.window.window = context.window;
context.window.crypto = webcrypto;
vm.runInNewContext(fs.readFileSync('src/portable.js', 'utf8'), context);
const Portable = context.window.Zhixing.Portable;

const fixture = { activeId: 'student', students: [{ id: 'student', name: '导入导出', school: '一中', targetSchool: '二中', currentScore: '待测', targetScore: 'A 档', nextLesson: '函数', focusContent: '审题', scores: [{ date: '2026-09-10', label: '月考', score: 86.5 }], custom: [{ key: '教材', value: '人教版' }], preparations: [{ date: '9/10', title: '备课', content: '讲义', files: [{ name: '资料.pdf', relativePath: '文件夹/资料.pdf', path: 'u/s/p/a.pdf', type: 'application/pdf', size: 12 }] }], courseProgress: [{ date: '9/9', title: '进度', content: '完成', files: [] }] }] };

test('portable module round-trips machine-readable Markdown without changing free-form scores', () => {
  const restored = Portable.parse(Portable.markdown(fixture));
  assert.equal(restored.students[0].currentScore, '待测');
  assert.equal(restored.students[0].targetScore, 'A 档');
  assert.equal(restored.students[0].preparations[0].files[0].relativePath, '文件夹/资料.pdf');
});

test('portable module parses readable text after the embedded backup is removed', () => {
  const readable = Portable.markdown(fixture, true).replace(/\n\n\[\[ZHIXING_V2:[A-Za-z0-9+/=]+\]\]\s*$/, '');
  const restored = Portable.parse(readable).students[0];
  assert.equal(restored.scores[0].score, 86.5);
  assert.equal(restored.courseProgress[0].title, '进度');
  assert.equal(restored.custom[0].value, '人教版');
});
