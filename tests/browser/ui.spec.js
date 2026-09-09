const { test, expect } = require('@playwright/test');
const path = require('node:path');

const pageUrl = process.env.ZHIXING_TEST_URL || `file:///${path.resolve('index.html').replace(/\\/g, '/')}`;

test.beforeEach(async ({ page }) => {
  await page.goto(pageUrl);
  await page.evaluate(async () => { localStorage.clear(); await new Promise(resolve => { const req = indexedDB.deleteDatabase('zhixing-tutor-v2'); req.onsuccess = req.onerror = req.onblocked = resolve; }); });
  await page.reload();
});

test('blank student form closes without native validation', async ({ page }) => {
  await page.getByRole('button', { name: '添加第一位学生' }).click();
  await expect(page.locator('#studentDialog')).toHaveAttribute('open', '');
  await page.locator('#closeStudentDialog').click();
  await expect(page.locator('#studentDialog')).not.toHaveAttribute('open', '');
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
    return {
      current: restored.currentScore, target: restored.targetScore, score: restored.scores[0]?.score,
      prep: restored.preparations[0], course: restored.courseProgress[0], custom: restored.custom[0],
      nextLesson: restored.nextLesson, focusContent: restored.focusContent
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
});

test('logout clears all local records, pending files and cleanup work', async ({ page }) => {
  await page.getByRole('button', { name: '添加第一位学生' }).click();
  await page.locator('[name=name]').fill('退出测试');
  await page.getByRole('button', { name: '保存档案' }).click();
  await page.evaluate(async () => {
    cloud.userEmail = 'test@example.com';
    localStorage.setItem(cloudKey, JSON.stringify(cloud));
    await Zhixing.Database.put('blobs', { key: 'blob:test', dataUrl: 'data:text/plain;base64,QQ==' });
    await Zhixing.Database.put('cleanup', { key: 'u/test.pdf', path: 'u/test.pdf', attempts: 1 });
    supabaseClient.auth.signOut = async () => ({ error: null });
    render();
  });
  await page.locator('#sidebarAuthButton').click();
  const logout = page.locator('#logoutFromDataBtn');
  await expect(logout).toBeVisible();
  await expect(logout).toHaveCSS('border-style', 'solid');
  await logout.click();
  await page.locator('#confirmAccept').click();
  await expect(page.getByRole('heading', { name: '开始建立学生档案' })).toBeVisible();
  const local = await page.evaluate(async () => ({
    profile: localStorage.getItem(storeKey),
    email: JSON.parse(localStorage.getItem(cloudKey) || '{}').userEmail,
    counts: await Promise.all(['records','outbox','conflicts','blobs','cleanup','meta'].map(name => Zhixing.Database.all(name).then(items => items.length)))
  }));
  expect(local).toEqual({ profile: null, email: '', counts: [0,0,0,0,0,0] });
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
