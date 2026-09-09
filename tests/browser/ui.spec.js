const { test, expect } = require('@playwright/test');
const path = require('node:path');

const pageUrl = `file:///${path.resolve('index.html').replace(/\\/g, '/')}`;

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
