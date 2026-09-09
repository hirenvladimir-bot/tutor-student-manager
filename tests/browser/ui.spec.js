const { test, expect } = require('@playwright/test');
const path = require('node:path');

const pageUrl = process.env.ZHIXING_TEST_URL || `file:///${path.resolve('index.html').replace(/\\/g, '/')}`;

test.beforeEach(async ({ page }) => {
  await page.goto(pageUrl);
  await page.evaluate(async () => { localStorage.clear(); await new Promise(resolve => { const req = indexedDB.deleteDatabase('zhixing-tutor-v2'); req.onsuccess = req.onerror = req.onblocked = resolve; }); });
  await page.reload();
});

test('two browser contexts preserve offline edits, conflicts and deletions', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'cross-device behavior only needs one browser engine');
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const firstId = '11111111-1111-4111-8111-111111111111';
  const secondId = '22222222-2222-4222-8222-222222222222';
  const rows = new Map();
  let mutationCalls = 0;
  const now = () => new Date().toISOString();
  const record = row => ({
    key: `students:${row.id}`, entity: 'students', id: row.id, studentId: null,
    data: { name: row.name, school: row.school, targetSchool: row.target_school, currentScore: row.current_score, targetScore: row.target_score, nextLesson: row.next_lesson, focusContent: row.focus_content },
    version: row.version, deletedAt: row.deleted_at, updatedAt: row.updated_at
  });
  const cloudCall = async request => {
    if (request.kind === 'migrate') return { data: { status: 'already_migrated' }, error: null };
    if (request.kind === 'select') return { data: request.table === 'students' ? [...rows.values()].map(value => structuredClone(value)) : [], error: null };
    if (request.kind === 'snapshot') return { error: null };
    mutationCalls++;
    const applied = [], conflicts = [];
    for (const mutation of request.mutations) {
      const key = `students:${mutation.id}`, current = rows.get(key), base = Number(mutation.base_version || 0);
      if ((current?.version || 0) !== base) { conflicts.push({ key, entity: 'students', id: mutation.id, cloud: record(current) }); continue; }
      const data = mutation.data || {}, version = base + 1;
      rows.set(key, { id: mutation.id, user_id: userId, name: data.name || '', school: data.school || '', target_school: data.targetSchool || '', current_score: data.currentScore ?? null, target_score: data.targetScore ?? null, next_lesson: data.nextLesson || '', focus_content: data.focusContent || '', version, deleted_at: mutation.operation === 'delete' ? now() : null, updated_at: now() });
      applied.push({ key, version, updated_at: now() });
    }
    return { data: { applied, conflicts }, error: null };
  };
  const contexts = [await browser.newContext(), await browser.newContext()];
  try {
    for (const context of contexts) await context.exposeFunction('__zxCloudCall', cloudCall);
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all(pages.map(page => page.goto(pageUrl)));
    const install = async (page, initial) => page.evaluate(async ({ initial, userId }) => {
      await window.Zhixing.Sync.stop();
      await window.Zhixing.Database.wipe();
      const call = window.__zxCloudCall;
      const client = {
        auth: { getUser: async () => ({ data: { user: { id: userId } } }) },
        rpc: (name, args) => name === 'migrate_legacy_tutor_profile' ? call({ kind: 'migrate' }) : call({ kind: 'mutate', mutations: args.p_mutations }),
        from: table => ({ select: () => ({ eq: () => call({ kind: 'select', table }) }), upsert: () => call({ kind: 'snapshot' }) }),
        channel: () => { const channel = { on: () => channel, subscribe: callback => { callback('SUBSCRIBED'); return channel; } }; return channel; },
        removeChannel: async () => {}, storage: { from: () => ({ remove: async () => ({ error: null }) }) }
      };
      window.__zxClient = client;
      await window.Zhixing.Database.start(initial);
      window.Zhixing.Files.configure({ client, bucket: 'tutor-files', endpoint: 'unused' });
      await window.Zhixing.Sync.start({ client, onState: next => { window.__zxState = next; } });
    }, { initial, userId });
    const emptyStudent = id => ({ id, name: id === firstId ? '学生一' : '学生二', school: '', targetSchool: '', currentScore: null, targetScore: null, nextLesson: '', focusContent: '', scores: [], custom: [], preparations: [], courseProgress: [] });
    await install(pages[0], { activeId: firstId, students: [emptyStudent(firstId), emptyStudent(secondId)] });
    await install(pages[1], { activeId: null, students: [] });
    expect(await pages[1].evaluate(() => window.Zhixing.Database.state().then(state => state.students.length))).toBe(2);

    await pages[0].evaluate(async id => { const state = await window.Zhixing.Database.state(); state.students.find(item => item.id === id).school = '设备 A 学校'; await window.Zhixing.Database.persist(state); await window.Zhixing.Sync.flush(); }, firstId);
    await pages[1].evaluate(async id => { const state = await window.Zhixing.Database.state(); state.students.find(item => item.id === id).targetSchool = '设备 B 目标'; await window.Zhixing.Database.persist(state); await window.Zhixing.Sync.flush(); }, secondId);
    await Promise.all(pages.map(page => page.evaluate(() => window.Zhixing.Sync.pull())));
    for (const page of pages) expect(await page.evaluate(([a, b]) => window.Zhixing.Database.state().then(state => [state.students.find(item => item.id === a).school, state.students.find(item => item.id === b).targetSchool]), [firstId, secondId])).toEqual(['设备 A 学校', '设备 B 目标']);

    await pages[0].evaluate(async id => { const state = await window.Zhixing.Database.state(); state.students.find(item => item.id === id).name = '设备 A 版本'; await window.Zhixing.Database.persist(state); }, firstId);
    await pages[1].evaluate(async id => { const state = await window.Zhixing.Database.state(); state.students.find(item => item.id === id).name = '设备 B 版本'; await window.Zhixing.Database.persist(state); }, firstId);
    await pages[0].evaluate(() => window.Zhixing.Sync.flush());
    await pages[1].evaluate(() => window.Zhixing.Sync.flush());
    expect(await pages[1].evaluate(() => window.Zhixing.Database.all('conflicts').then(items => [items[0].local.data.name, items[0].cloud.data.name]))).toEqual(['设备 B 版本', '设备 A 版本']);
    const callsAtConflict = mutationCalls;
    await pages[1].evaluate(() => window.Zhixing.Sync.flush());
    expect(mutationCalls).toBe(callsAtConflict);
    await pages[1].evaluate(id => window.Zhixing.Sync.resolve(`students:${id}`, 'cloud'), firstId);

    await pages[1].evaluate(async id => { Object.defineProperty(navigator, 'onLine', { value: false, configurable: true }); const state = await window.Zhixing.Database.state(); state.students.find(item => item.id === id).targetSchool = '离线目标'; await window.Zhixing.Database.persist(state); await window.Zhixing.Sync.flush(); }, firstId);
    const callsWhileOffline = mutationCalls;
    expect(await pages[1].evaluate(() => window.Zhixing.Database.all('outbox').then(items => items.length))).toBe(1);
    expect(mutationCalls).toBe(callsWhileOffline);
    await pages[1].evaluate(async () => { Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }); await window.Zhixing.Sync.flush(); });
    await pages[0].evaluate(() => window.Zhixing.Sync.pull());
    expect(await pages[0].evaluate(id => window.Zhixing.Database.state().then(state => state.students.find(item => item.id === id).targetSchool), firstId)).toBe('离线目标');

    await pages[1].evaluate(async id => { const state = await window.Zhixing.Database.state(); state.students = state.students.filter(item => item.id !== id); await window.Zhixing.Database.persist(state); await window.Zhixing.Sync.flush(); }, secondId);
    await pages[0].evaluate(() => window.Zhixing.Sync.pull());
    expect(await pages[0].evaluate(() => window.Zhixing.Database.state().then(state => state.students.map(item => item.name)))).toEqual(['设备 A 版本']);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});

test('blank student form closes without native validation', async ({ page }) => {
  await page.getByRole('button', { name: '添加第一位学生' }).click();
  await expect(page.locator('#studentDialog')).toHaveAttribute('open', '');
  await page.locator('#closeStudentDialog').click();
  await expect(page.locator('#studentDialog')).not.toHaveAttribute('open', '');
});

test('an expired cached account is not presented as signed in', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('zhixing-tutor-cloud-v1', JSON.stringify({ auto: true, userEmail: 'stale@example.com', lastSync: new Date().toISOString() })));
  await page.reload();
  await expect(page.locator('#sidebarStorageText')).toHaveText('数据仅保存于此浏览器');
  await page.evaluate(() => openDataCenter());
  await expect(page.locator('#cloudCheckBtn')).toBeHidden();
  await expect(page.locator('#cloudSummary')).toHaveText('尚未登录同步账号');
});

test('cloud diagnostic button is wired and remains inside the data center', async ({ page }) => {
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await page.evaluate(async () => {
    cloud.userEmail = 'diagnostic@example.com';
    supabaseClient.auth.getSession = async () => ({ data: { session: { user: { id: 'diagnostic-user' } } }, error: null });
    supabaseClient.from = () => ({ select: () => ({ eq: () => ({ limit: async () => ({ error: null }) }) }) });
    supabaseClient.rpc = async () => ({ data: { applied: [], conflicts: [] }, error: null });
    window.Zhixing.Files.diagnose = async () => ({ path: 'diagnostic-user/self-test/file.txt', size: 16 });
    await renderSyncStatus();
    openDataCenter();
  });
  await expect(page.locator('#cloudCheckBtn')).toBeVisible();
  await page.locator('#cloudCheckBtn').click();
  await expect(page.locator('#dataMessage')).toContainText('云端自检通过');
  await expect(page.locator('#syncDetail')).toContainText('云端自检');
  const overflow = await page.locator('#dataDialog form').evaluate(element => element.scrollWidth > element.clientWidth);
  expect(overflow).toBeFalsy();
});

test('free-form scores save and progress records can be edited', async ({ page }) => {
  await page.getByRole('button', { name: '添加第一位学生' }).click();
  await page.locator('[name=name]').fill('测试学生');
  await page.locator('[name=currentScore]').fill('待测');
  await page.locator('[name=targetScore]').fill('120/150');
  await page.getByRole('button', { name: '保存档案' }).click();
  await expect(page.locator('#currentScore')).toHaveText('待测');
  await page.locator('#addCourseBtn').click();
  await page.locator('#courseItemForm [name=title]').fill('第一阶段');
  await page.getByRole('button', { name: '保存进度' }).click();
  await page.locator('.edit-course').click();
  await expect(page.locator('#courseDialog h2')).toHaveText('编辑进度');
});

test('custom information deletes immediately without a confirmation dialog', async ({ page }) => {
  await page.getByRole('button', { name: '添加第一位学生' }).click();
  await page.locator('#studentForm [name=name]').fill('自定义信息测试');
  await page.getByRole('button', { name: '保存档案' }).click();
  await page.locator('#addCustomBtn').click();
  await page.locator('#customForm [name=key]').fill('备注');
  await page.locator('#customForm [name=value]').fill('可直接删除');
  await page.locator('#customForm button[value=default]').click();
  await expect(page.locator('.custom-field')).toHaveCount(1);
  await page.locator('.remove-custom').click();
  await expect(page.locator('.custom-field')).toHaveCount(0);
  await expect(page.locator('#confirmDialog')).not.toHaveAttribute('open', '');
});

test('rapid local saves are serialized and retain the newest value', async ({ page }) => {
  await page.getByRole('button', { name: '添加第一位学生' }).click();
  await page.locator('#studentForm [name=name]').fill('快速保存测试');
  await page.getByRole('button', { name: '保存档案' }).click();
  const result = await page.evaluate(async () => {
    const studentId = active().id, tasks = [];
    for (let index = 0; index < 25; index++) { active().nextLesson = `最终值-${index}`; tasks.push(save()); }
    await Promise.all(tasks);
    const record = await window.Zhixing.Database.get('outbox', `students:${studentId}`);
    const stored = await window.Zhixing.Database.state();
    return { queued: record.data.nextLesson, stored: stored.students[0].nextLesson, local: JSON.parse(localStorage.getItem(storeKey)).students[0].nextLesson };
  });
  expect(result).toEqual({ queued: '最终值-24', stored: '最终值-24', local: '最终值-24' });
});

test('modified optional dialog uses in-app confirmation and has no overflow', async ({ page }) => {
  await page.getByRole('button', { name: '添加第一位学生' }).click();
  await page.locator('[name=name]').fill('未保存');
  await page.locator('#cancelStudentDialog').click();
  await expect(page.locator('#confirmDialog')).toHaveAttribute('open', '');
  await page.locator('#confirmDialog [value=confirm]').click();
  await expect(page.locator('#studentDialog')).not.toHaveAttribute('open', '');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBeFalsy();
});

test('all primary editors open and blank optional forms close freely', async ({ page }) => {
  await page.getByRole('button', { name: '添加第一位学生' }).click();
  await page.locator('[name=name]').fill('按钮检查');
  await page.getByRole('button', { name: '保存档案' }).click();
  for (const [open, dialog, close] of [['#addScoreBtn','#scoreDialog','#scoreDialog .outline-btn'],['#addCustomBtn','#customDialog','#cancelCustomDialog'],['#addPrepBtn','#prepDialog','#cancelPrepDialog'],['#addCourseBtn','#courseDialog','#cancelCourseDialog']]) {
    await page.locator(open).click();
    await expect(page.locator(dialog)).toHaveAttribute('open', '');
    await page.locator(close).click();
    await expect(page.locator(dialog)).not.toHaveAttribute('open', '');
  }
  await page.locator('#sidebarAuthButton').click();
  await expect(page.locator('#dataDialog')).toHaveAttribute('open', '');
});

test('offline attachment is queued without losing preparation text', async ({ page }) => {
  await page.getByRole('button', { name: '添加第一位学生' }).click();
  await page.locator('[name=name]').fill('离线测试');
  await page.getByRole('button', { name: '保存档案' }).click();
  await page.evaluate(() => Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false }));
  await page.locator('#addPrepBtn').click();
  await page.locator('#prepForm [name=title]').fill('离线备课');
  await page.locator('#prepForm [name=content]').fill('这段文字必须保留');
  await page.locator('#prepForm [name=files]').setInputFiles({ name: '讲义.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-test') });
  await page.getByRole('button', { name: '保存备课' }).click();
  await expect(page.locator('#prepList')).toContainText('这段文字必须保留');
  await expect(page.locator('#prepList')).toContainText('待上传');
  await page.locator('#sidebarAuthButton').click();
  await expect(page.locator('#uploadQueue')).toContainText('讲义.pdf');
  await page.locator('.cancel-upload').click();
  await expect(page.locator('#confirmDialog')).toHaveAttribute('open', '');
  await page.locator('#confirmAccept').click();
  await expect(page.locator('#uploadQueue')).toBeHidden();
  await expect(page.locator('#prepList')).not.toContainText('讲义.pdf');
  expect(await page.evaluate(() => Zhixing.Database.all('blobs').then(items => items.length))).toBe(0);
});

test('attachment cache failure keeps preparation text in the editor and avoids a native alert', async ({ page }) => {
  await page.getByRole('button', { name: '添加第一位学生' }).click();
  await page.locator('[name=name]').fill('缓存失败测试');
  await page.getByRole('button', { name: '保存档案' }).click();
  await page.getByRole('button', { name: '＋ 添加备课' }).click();
  await page.locator('#prepForm [name=title]').fill('不能丢失的标题');
  await page.locator('#prepForm [name=content]').fill('不能丢失的内容');
  await page.locator('#prepForm [name=files]').setInputFiles({ name: '过大.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-test') });
  await page.evaluate(() => { Zhixing.Files.prepare = async () => { throw new Error('浏览器存储空间不足'); }; });
  let nativeDialog = false;
  page.once('dialog', async dialog => { nativeDialog = true; await dialog.dismiss(); });
  await page.getByRole('button', { name: '保存备课' }).click();
  await expect(page.locator('#prepDialog')).toHaveAttribute('open', '');
  await expect(page.locator('#prepForm [name=title]')).toHaveValue('不能丢失的标题');
  await expect(page.locator('#prepForm [name=content]')).toHaveValue('不能丢失的内容');
  await expect(page.locator('#prepFilesHint')).toHaveClass(/error/);
  await expect(page.locator('#prepFilesHint')).toContainText('浏览器存储空间不足');
  expect(nativeDialog).toBe(false);
});

test('large failed upload batches do not flood the student view', async ({ page }) => {
  await page.getByRole('button', { name: '添加第一位学生' }).click();
  await page.locator('[name=name]').fill('大量附件测试');
  await page.getByRole('button', { name: '保存档案' }).click();
  await page.evaluate(() => {
    const files = [
      { id: 'uploaded-a', name: '已上传一.pdf', path: 'u/a.pdf', pending: false },
      { id: 'uploaded-b', name: '已上传二.pdf', path: 'u/b.pdf', pending: false },
      ...Array.from({ length: 100 }, (_, index) => ({ id: `pending-${index}`, name: `待上传-${index}.pdf`, pending: true, localBlobKey: `blob-${index}` }))
    ];
    active().preparations = [{ id: 'many-files', title: '异常批量上传', content: '', date: '9/9', files }];
    render();
  });
  await expect(page.locator('#prepList .attachment')).toHaveCount(22);
  await expect(page.locator('#prepList .pending-overflow')).toHaveText('另有 80 个待上传附件，请在数据中心处理');
  await expect(page.locator('#prepList')).toContainText('已上传一.pdf');
  expect(await page.locator('#prepList').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
});

test('Markdown backup round-trip preserves preparations, attachments and free-form scores', async ({ page }) => {
  const result = await page.evaluate(() => {
    const sample = { activeId: 'a', students: [{ id: 'a', name: '导出测试', currentScore: '待测', targetScore: 'A档', school: '', targetSchool: '', nextLesson: '', focusContent: '', scores: [], custom: [], courseProgress: [], preparations: [{ id: 'p', title: '备课', content: '内容', date: '9/9', files: [{ id: 'f', name: '资料.pdf', path: 'u/s/p/f.pdf', type: 'application/pdf', size: 8 }] }] }] };
    state = Zhixing.Model.ensureIds(sample);
    const restored = parseTextBackup(markdownBackup(false));
    return { current: restored.students[0].currentScore, target: restored.students[0].targetScore, prep: restored.students[0].preparations[0].title, file: restored.students[0].preparations[0].files[0].name };
  });
  expect(result).toEqual({ current: '待测', target: 'A档', prep: '备课', file: '资料.pdf' });
});

test('readable Markdown remains importable without the embedded machine backup', async ({ page }) => {
  const result = await page.evaluate(() => {
    state = Zhixing.Model.ensureIds({ activeId: 'a', students: [{
      id: 'a', name: '纯文本回导', school: '一中', targetSchool: '实验中学', currentScore: '待测', targetScore: 'A档',
      nextLesson: '函数', focusContent: '审题', scores: [{ id: 's', date: '2026-09-09', label: '月考', score: 86.5 }],
      custom: [{ id: 'c', key: '教材', value: '人教版' }],
      preparations: [{ id: 'p', date: '9/9', title: '备课一', content: '讲义安排', files: [{ id: 'f', name: '讲义.pdf', relativePath: '资料/讲义.pdf', path: 'u/a/p/guide.pdf', type: 'application/pdf', size: 123 }] }],
      courseProgress: [{ id: 'q', date: '9/8', title: '一次函数', content: '已掌握', files: [{ id: 'g', name: '作业.docx', path: 'u/a/q/homework.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 456 }] }]
    }] });
    const readable = markdownBackup(false).replace(/\n\n\[\[ZHIXING_V2:[A-Za-z0-9+/=]+\]\]\s*$/, '');
    const restored = parsePortableTextBackup(readable).students[0];
    const plainText = markdownBackup(true).replace(/\n\n\[\[ZHIXING_V2:[A-Za-z0-9+/=]+\]\]\s*$/, '');
    const plain = parsePortableTextBackup(plainText).students[0];
    return {
      current: restored.currentScore, target: restored.targetScore, score: restored.scores[0]?.score,
      prep: restored.preparations[0], course: restored.courseProgress[0], custom: restored.custom[0],
      nextLesson: restored.nextLesson, focusContent: restored.focusContent,
      plain: {
        current: plain.currentScore, target: plain.targetScore, score: plain.scores[0]?.score,
        prep: plain.preparations[0], course: plain.courseProgress[0], custom: plain.custom[0],
        nextLesson: plain.nextLesson, focusContent: plain.focusContent
      }
    };
  });
  expect(result.current).toBe('待测');
  expect(result.target).toBe('A档');
  expect(result.score).toBe(86.5);
  expect(result.prep).toMatchObject({ title: '备课一', content: '讲义安排' });
  expect(result.prep.files[0]).toMatchObject({ name: '讲义.pdf', relativePath: '资料/讲义.pdf', path: 'u/a/p/guide.pdf', type: 'application/pdf', size: 123 });
  expect(result.course).toMatchObject({ title: '一次函数', content: '已掌握' });
  expect(result.course.files[0]).toMatchObject({ name: '作业.docx', path: 'u/a/q/homework.docx', size: 456 });
  expect(result.custom).toEqual(expect.objectContaining({ key: '教材', value: '人教版' }));
  expect(result.nextLesson).toBe('函数');
  expect(result.focusContent).toBe('审题');
  expect(result.plain.current).toBe('待测');
  expect(result.plain.target).toBe('A档');
  expect(result.plain.score).toBe(86.5);
  expect(result.plain.prep).toMatchObject({ title: '备课一', content: '讲义安排' });
  expect(result.plain.prep.files[0]).toMatchObject({ name: '讲义.pdf', relativePath: '资料/讲义.pdf', path: 'u/a/p/guide.pdf', size: 123 });
  expect(result.plain.course).toMatchObject({ title: '一次函数', content: '已掌握' });
  expect(result.plain.course.files[0]).toMatchObject({ name: '作业.docx', path: 'u/a/q/homework.docx', size: 456 });
  expect(result.plain.custom).toEqual(expect.objectContaining({ key: '教材', value: '人教版' }));
  expect(result.plain.nextLesson).toBe('函数');
  expect(result.plain.focusContent).toBe('审题');
});

test('preparation and course attachment buttons both start a safe download', async ({ page }) => {
  await page.getByRole('button', { name: '添加第一位学生' }).click();
  await page.locator('[name=name]').fill('附件测试');
  await page.getByRole('button', { name: '保存档案' }).click();
  await expect(page.locator('#studentNameTitle')).toHaveText('附件测试');
  await page.evaluate(() => {
    const student = active();
    student.preparations = [{ id: crypto.randomUUID(), title: '备课附件', content: '', date: '9/9', files: [{ id: crypto.randomUUID(), name: '备课.txt', type: 'text/plain', data: 'data:text/plain;base64,QQ==' }] }];
    student.courseProgress = [{ id: crypto.randomUUID(), title: '进度附件', content: '', date: '9/9', files: [{ id: crypto.randomUUID(), name: '进度.txt', type: 'text/plain', data: 'data:text/plain;base64,Qg==' }] }];
    window.__downloads = [];
    HTMLAnchorElement.prototype.click = function () { window.__downloads.push({ href: this.href, name: this.download }); };
    render();
  });

  await page.locator('.prep-file:not(.course-file)').click();
  await page.locator('.course-file').click();
  await expect.poll(() => page.evaluate(() => window.__downloads)).toEqual([
    { href: 'data:text/plain;base64,QQ==', name: '备课.txt' },
    { href: 'data:text/plain;base64,Qg==', name: '进度.txt' }
  ]);

  await page.locator('.prep-attachment').click();
  await expect(page.locator('#confirmDialog')).not.toHaveAttribute('open', '');
  await expect(page.locator('#prepList')).not.toContainText('备课.txt');
  await page.locator('.course-attachment').click();
  await expect(page.locator('#confirmDialog')).not.toHaveAttribute('open', '');
  await expect(page.locator('#courseList')).not.toContainText('进度.txt');
});

test('logout clears all local records, pending files and cleanup work', async ({ page }) => {
  await page.getByRole('button', { name: '添加第一位学生' }).click();
  await page.locator('[name=name]').fill('退出测试');
  await page.getByRole('button', { name: '保存档案' }).click();
  await page.evaluate(async () => {
    await persistQueue;
    cloud.userEmail = 'test@example.com';
    localStorage.setItem(cloudKey, JSON.stringify(cloud));
    await Zhixing.Database.put('blobs', { key: 'blob:test', dataUrl: 'data:text/plain;base64,QQ==' });
    await Zhixing.Database.put('cleanup', { key: 'u/test.pdf', path: 'u/test.pdf', attempts: 1 });
    localStorage.setItem('tus::pending-upload::1', JSON.stringify({ uploadUrl: 'https://storage.invalid/upload' }));
    supabaseClient.auth.signOut = async () => ({ error: null });
    const persist = Zhixing.Database.persist;
    Zhixing.Database.persist = async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 200));
      return persist(...args);
    };
    active().nextLesson = '退出前尚未落盘的编辑';
    save();
    render();
  });
  await page.locator('#sidebarAuthButton').click();
  const logout = page.locator('#logoutFromDataBtn');
  await expect(logout).toBeVisible();
  await expect(logout).toHaveCSS('border-style', 'solid');
  await logout.click();
  await page.locator('#confirmAccept').click();
  await expect(page.getByRole('heading', { name: '开始建立学生档案' })).toBeVisible();
  await page.waitForTimeout(300);
  const local = await page.evaluate(async () => ({
    profile: localStorage.getItem(storeKey),
    tus: localStorage.getItem('tus::pending-upload::1'),
    email: JSON.parse(localStorage.getItem(cloudKey) || '{}').userEmail,
    counts: await Promise.all(['records','outbox','conflicts','blobs','cleanup','meta'].map(name => Zhixing.Database.all(name).then(items => items.length)))
  }));
  expect(local).toEqual({ profile: null, tus: null, email: '', counts: [0,0,0,0,0,0] });
});

test('responsive layout avoids body zoom and horizontal overflow at a 200% equivalent viewport', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await page.getByRole('button', { name: '添加第一位学生' }).click();
  await page.locator('[name=name]').fill('缩放测试');
  await page.getByRole('button', { name: '保存档案' }).click();
  const layout = await page.evaluate(() => ({
    zoom: getComputedStyle(document.body).zoom || '1',
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  }));
  expect(['1', 'normal']).toContain(layout.zoom);
  expect(layout.overflow).toBeFalsy();
  await page.locator('#sidebarAuthButton').click();
  await expect(page.locator('#dataDialog')).toHaveAttribute('open', '');
});

test('Escape and backdrop follow the same safe dialog close rules', async ({ page }) => {
  await page.getByRole('button', { name: '添加第一位学生' }).click();
  await page.locator('[name=name]').fill('弹窗测试');
  await page.getByRole('button', { name: '保存档案' }).click();

  await page.locator('#addPrepBtn').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#prepDialog')).not.toHaveAttribute('open', '');

  await page.locator('#addCourseBtn').click();
  await page.locator('#courseItemForm [name=title]').fill('尚未保存');
  await page.keyboard.press('Escape');
  await expect(page.locator('#confirmDialog')).toHaveAttribute('open', '');
  await page.locator('#confirmDialog [value=cancel]').click();
  await expect(page.locator('#courseDialog')).toHaveAttribute('open', '');
  await page.locator('#cancelCourseDialog').click();
  await page.locator('#confirmAccept').click();

  await page.locator('#addCustomBtn').click();
  await page.locator('#customDialog').evaluate(dialog => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await expect(page.locator('#customDialog')).not.toHaveAttribute('open', '');

  await page.locator('#sidebarAuthButton').click();
  await page.locator('#openCloudSettings').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#cloudDialog')).not.toHaveAttribute('open', '');
});

test('large failed upload queues stay bounded and can be retried in bulk', async ({ page }) => {
  await page.evaluate(async () => {
    for (let index = 0; index < 45; index++) {
      const id = `90000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      await Zhixing.Database.put('outbox', { key: `attachments:${id}`, entity: 'attachments', id, studentId: 'student', data: { name: `file-${index}.pdf`, localBlobKey: `blob:${index}` }, baseVersion: 0, operation: 'upsert', attempts: 6, lastError: 'temporary failure' });
    }
    document.querySelector('#dataDialog').showModal();
    await renderSyncStatus();
  });
  await expect(page.locator('.upload-item')).toHaveCount(40);
  await expect(page.locator('.queue-more')).toContainText('另有 5 项');
  const overflow = await page.locator('#dataDialog').evaluate(dialog => dialog.scrollWidth > dialog.clientWidth);
  expect(overflow).toBeFalsy();
  await page.locator('#retryFailedUploads').click();
  await expect(page.locator('#dataMessage')).toContainText('45 个失败附件');
  expect(await page.evaluate(() => Zhixing.Database.all('outbox').then(items => items.every(item => item.attempts === 0)))).toBeTruthy();
});
