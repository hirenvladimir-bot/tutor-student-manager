(function (root) {
  'use strict';
  const ZX = root.Zhixing = root.Zhixing || {};
  let client, bucket, endpoint, onStatus = () => {};
  const uuid = () => crypto.randomUUID();
  const safeName = name => `file.${(name.match(/\.([a-z0-9]{1,12})$/i)?.[1] || 'bin').toLowerCase()}`;
  function configure(options) { client = options.client; bucket = options.bucket; endpoint = options.endpoint; onStatus = options.onStatus || onStatus; }
  async function cacheFile(key, file) {
    try { await ZX.Database.put('blobs', { key, blob: file }); }
    catch {
      try { const buffer = await file.arrayBuffer(); await ZX.Database.put('blobs', { key, buffer, type: file.type, name: file.name, lastModified: file.lastModified }); }
      catch { const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); await ZX.Database.put('blobs', { key, dataUrl, type: file.type, name: file.name, lastModified: file.lastModified }); }
    }
  }
  async function upload(file, path, token, progress = () => {}) {
    if (!root.tus?.Upload) throw new Error('上传组件未加载');
    return new Promise((resolve, reject) => {
      const task = new root.tus.Upload(file, { endpoint, retryDelays: [0, 3000, 5000, 10000, 20000], headers: { authorization: `Bearer ${token}`, 'x-upsert': 'true' }, uploadDataDuringCreation: true, removeFingerprintOnSuccess: true, fingerprint: () => `${bucket}/${path}/${file.name}/${file.size}/${file.lastModified}`, metadata: { bucketName: bucket, objectName: path, contentType: file.type || 'application/octet-stream', cacheControl: '3600' }, chunkSize: 6 * 1024 * 1024, onError: reject, onProgress: (done, total) => progress(Math.round(done / total * 100)), onSuccess: resolve });
      task.findPreviousUploads().then(found => { if (found.length) task.resumeFromPreviousUpload(found[0]); task.start(); }).catch(reject);
    });
  }
  async function queueCleanup(path) {
    if (!path) return;
    const existing = await ZX.Database.get('cleanup', path);
    await ZX.Database.put('cleanup', existing || { key: path, path, attempts: 0, queuedAt: new Date().toISOString() });
  }
  async function processCleanup() {
    if (!client || root.navigator?.onLine === false) return;
    const queued = await ZX.Database.all('cleanup');
    for (const item of queued) {
      try {
        const { error } = await client.storage.from(bucket).remove([item.path]);
        if (error && !/not found/i.test(error.message || '')) throw error;
        await ZX.Database.remove('cleanup', item.key);
      } catch (error) {
        await ZX.Database.put('cleanup', { ...item, attempts: (item.attempts || 0) + 1, lastError: error.message || String(error), lastAttemptAt: new Date().toISOString() });
      }
    }
  }
  async function prepare(files, section, recordId, studentId, status = () => {}) {
    const list = [...files];
    let session = null, user = null;
    try { session = (await client?.auth.getSession()).data?.session || null; if (session) user = (await client.auth.getUser()).data?.user || session.user || null; } catch { session = null; user = null; }
    const result = [];
    for (let index = 0; index < list.length; index++) {
      const file = list[index], id = uuid(), relativePath = file.webkitRelativePath || '', localBlobKey = `blob:${id}`;
      const item = { id, name: file.name, relativePath, type: file.type || 'application/octet-stream', size: file.size, path: '', pending: true, localBlobKey };
      if (session && user && navigator.onLine) {
        const path = `${user.id}/${studentId}/${section}/${recordId}/${uuid()}-${safeName(file.name)}`;
        status(`正在上传 ${index + 1}/${list.length}：${file.name}（0%）`);
        try { await upload(file, path, session.access_token, percent => status(`正在上传 ${index + 1}/${list.length}：${file.name}（${percent}%）`)); item.path = path; item.pending = false; delete item.localBlobKey; }
        catch (error) { await cacheFile(localBlobKey, file); status(`${file.name} 已进入待上传队列`); }
      } else {
        try { await cacheFile(localBlobKey, file); status(`${file.name} 已保存到本机，联网后自动上传`); }
        catch (error) { throw new Error(`无法暂存 ${file.name}：${error.message || error.name || '浏览器存储不可用'}`); }
      }
      result.push(item);
    }
    return result;
  }
  async function beforeSync(mutation) {
    if (mutation.entity !== 'attachments') return mutation;
    if (mutation.operation === 'delete') {
      if (mutation.data.localBlobKey) await ZX.Database.remove('blobs', mutation.data.localBlobKey);
      return mutation;
    }
    if (!mutation.data.path && mutation.data.localBlobKey) {
      const cached = await ZX.Database.get('blobs', mutation.data.localBlobKey);
      if (!cached?.blob && !cached?.buffer && !cached?.dataUrl) throw new Error(`找不到待上传文件：${mutation.data.name}`);
      const session = (await client.auth.getSession()).data.session;
      const user = (await client.auth.getUser()).data.user;
      if (!session || !user) throw new Error('需要登录后才能继续上传文件');
      const section = mutation.data.ownerType === 'preparations' ? 'preparations' : 'course-progress';
      const path = `${user.id}/${mutation.studentId}/${section}/${mutation.data.ownerId}/${uuid()}-${safeName(mutation.data.name)}`;
      const source = cached.blob || (cached.buffer ? new Blob([cached.buffer], { type: cached.type || mutation.data.type }) : await (await fetch(cached.dataUrl)).blob());
      onStatus(`正在继续上传 ${mutation.data.name}（0%）`);
      await upload(source, path, session.access_token, percent => onStatus(`正在继续上传 ${mutation.data.name}（${percent}%）`));
      mutation = { ...mutation, data: { ...mutation.data, path, pending: false } };
      delete mutation.data.localBlobKey;
      await ZX.Database.remove('blobs', cached.key);
      await ZX.Database.applyServerRecord({ ...mutation, version: mutation.baseVersion, deletedAt: null });
      await ZX.Database.put('outbox', mutation);
      onStatus(`${mutation.data.name} 已上传，正在同步附件记录`);
    }
    return mutation;
  }
  async function afterApplied(applied, queued) {
    const keys = new Set((applied || []).map(item => item.key));
    for (const mutation of queued || []) {
      if (keys.has(mutation.key) && mutation.entity === 'attachments' && mutation.operation === 'delete') await queueCleanup(mutation.data.path);
    }
    await processCleanup();
  }
  async function discardConflict(conflict) {
    const local = conflict?.local;
    if (local?.entity !== 'attachments') return;
    if (local.data?.localBlobKey) await ZX.Database.remove('blobs', local.data.localBlobKey);
    if (local.data?.path && local.data.path !== conflict.cloud?.data?.path) await queueCleanup(local.data.path);
  }
  ZX.Files = { configure, prepare, beforeSync, afterApplied, queueCleanup, processCleanup, discardConflict };
})(window);
