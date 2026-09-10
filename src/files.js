(function (root) {
  'use strict';
  const ZX = root.Zhixing = root.Zhixing || {};
  let client, bucket, endpoint, onStatus = () => {};
  const activeUploads = new Map();
  const uuid = () => crypto.randomUUID();
  const safeName = name => `file.${(name.match(/\.([a-z0-9]{1,12})$/i)?.[1] || 'bin').toLowerCase()}`;
  const report = (message, detail) => onStatus(message, detail);
  function configure(options) { client = options.client; bucket = options.bucket; endpoint = options.endpoint; onStatus = options.onStatus || onStatus; }
  async function cacheFile(key, file) {
    try { await ZX.Database.put('blobs', { key, blob: file }); }
    catch {
      try { const buffer = await file.arrayBuffer(); await ZX.Database.put('blobs', { key, buffer, type: file.type, name: file.name, lastModified: file.lastModified }); }
      catch { const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); await ZX.Database.put('blobs', { key, dataUrl, type: file.type, name: file.name, lastModified: file.lastModified }); }
    }
  }
  async function upload(file, path, token, progress = () => {}, key = path) {
    if (!root.tus?.Upload) throw new Error('上传组件未加载');
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => { if (settled) return; settled = true; activeUploads.delete(key); callback(value); };
      const task = new root.tus.Upload(file, { endpoint, retryDelays: [0, 3000, 5000, 10000, 20000], headers: { authorization: `Bearer ${token}`, 'x-upsert': 'true' }, uploadDataDuringCreation: true, removeFingerprintOnSuccess: true, fingerprint: async () => `${bucket}/${path}/${file.name || 'blob'}/${file.size}/${file.lastModified || 0}`, metadata: { bucketName: bucket, objectName: path, contentType: file.type || 'application/octet-stream', cacheControl: '3600' }, chunkSize: 6 * 1024 * 1024, onError: error => finish(reject, error), onProgress: (done, total) => progress(Math.round(done / total * 100)), onSuccess: () => finish(resolve) });
      activeUploads.set(key, { task, cancel: async () => { const error = new Error('上传已取消'); error.code = 'UPLOAD_CANCELLED'; finish(reject, error); try { await task.abort(true); } catch {} } });
      task.findPreviousUploads().then(found => { if (found.length) task.resumeFromPreviousUpload(found[0]); task.start(); }).catch(error => finish(reject, error));
    });
  }
  async function cancel(key) { const active = activeUploads.get(key); if (!active) return false; await active.cancel(); return true; }
  async function clearLocal() {
    await Promise.all([...activeUploads.values()].map(active => active.cancel().catch(() => {})));
    if (root.localStorage) for (let index = root.localStorage.length - 1; index >= 0; index--) { const key = root.localStorage.key(index); if (key?.startsWith('tus::')) root.localStorage.removeItem(key); }
  }
  async function diagnose() {
    if (!client || !bucket || !endpoint) throw new Error('附件服务尚未配置');
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw sessionError;
    const session = sessionData?.session;
    const user = session?.user || (await client.auth.getUser()).data.user;
    if (!session?.access_token || !user) throw new Error('需要登录后才能运行云端自检');
    const marker = `zhixing storage diagnostic ${new Date().toISOString()}`;
    const source = new Blob([marker], { type: 'text/plain;charset=utf-8' });
    const path = `${user.id}/self-test/${uuid()}-file.txt`;
    let uploaded = false, primaryError = null;
    try {
      onStatus('云端自检：正在测试 TUS 上传（0%）');
      await upload(source, path, session.access_token, percent => onStatus(`云端自检：正在测试 TUS 上传（${percent}%）`), `diagnostic:${path}`);
      uploaded = true;
      const { data, error } = await client.storage.from(bucket).createSignedUrl(path, 60);
      if (error) throw error;
      if (!data?.signedUrl) throw new Error('未能生成附件签名下载链接');
      const response = await fetch(data.signedUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`签名下载返回 HTTP ${response.status}`);
      if ((await response.text()) !== marker) throw new Error('签名下载内容校验失败');
      return { path, size: source.size };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (uploaded) {
        const { error } = await client.storage.from(bucket).remove([path]);
        if (error) {
          await queueCleanup(path);
          if (!primaryError) throw new Error(`测试文件已进入待清理队列：${error.message || error}`);
        }
      }
    }
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
    const result = [], cachedKeys = [];
    for (let index = 0; index < list.length; index++) {
      const file = list[index], id = uuid(), relativePath = file.webkitRelativePath || '', localBlobKey = `blob:${id}`;
      const item = { id, name: file.name, relativePath, type: file.type || 'application/octet-stream', size: file.size, path: '', pending: true, localBlobKey };
      try { await cacheFile(localBlobKey, file); cachedKeys.push(localBlobKey); status(`已安全保存 ${index + 1}/${list.length}：${file.name}，后台将自动上传`); }
      catch (error) {
        await Promise.all(cachedKeys.map(key => ZX.Database.remove('blobs', key).catch(() => {})));
        throw new Error(`无法暂存 ${file.name}，本批已暂存文件已回滚：${error.message || error.name || '浏览器存储空间不足'}`);
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
      const detail = { key: mutation.key, id: mutation.id, name: mutation.data.name, state: 'queued', percent: 0 };
      try {
        const cached = await ZX.Database.get('blobs', mutation.data.localBlobKey);
        if (!cached?.blob && !cached?.buffer && !cached?.dataUrl) throw new Error(`找不到待上传文件：${mutation.data.name}`);
        const session = (await client.auth.getSession()).data.session;
        const user = (await client.auth.getUser()).data.user;
        if (!session || !user) {
          const error = new Error('需要登录后才能继续上传文件');
          error.code = 'AUTH_REQUIRED';
          throw error;
        }
        const section = mutation.data.ownerType === 'preparations' ? 'preparations' : 'course-progress';
        const path = mutation.data.uploadPath || `${user.id}/${mutation.studentId}/${section}/${mutation.data.ownerId}/${uuid()}-${safeName(mutation.data.name)}`;
        if (!mutation.data.uploadPath) {
          mutation = { ...mutation, data: { ...mutation.data, uploadPath: path } };
          await ZX.Database.applyServerRecord({ ...mutation, version: mutation.baseVersion, deletedAt: null });
          await ZX.Database.put('outbox', mutation);
        }
        const source = cached.blob || (cached.buffer ? new Blob([cached.buffer], { type: cached.type || mutation.data.type }) : await (await fetch(cached.dataUrl)).blob());
        report(`正在上传 ${mutation.data.name}（0%）`, { ...detail, state: 'uploading' });
        await upload(source, path, session.access_token, percent => report(`正在上传 ${mutation.data.name}（${percent}%）`, { ...detail, state: 'uploading', percent }), mutation.key);
        mutation = { ...mutation, data: { ...mutation.data, path, pending: false } };
        delete mutation.data.localBlobKey;
        delete mutation.data.uploadPath;
        await ZX.Database.remove('blobs', cached.key);
        await ZX.Database.applyServerRecord({ ...mutation, version: mutation.baseVersion, deletedAt: null });
        await ZX.Database.put('outbox', mutation);
        report(`${mutation.data.name} 已上传，正在同步附件记录`, { ...detail, state: 'syncing', percent: 100 });
      } catch (error) {
        const state = error.code === 'AUTH_REQUIRED' ? 'waiting-auth' : error.code === 'UPLOAD_CANCELLED' ? 'cancelled' : 'failed';
        report(error.message || `上传 ${mutation.data.name} 失败`, { ...detail, state, error: error.message || String(error) });
        throw error;
      }
    }
    return mutation;
  }
  async function afterApplied(applied, queued) {
    const keys = new Set((applied || []).map(item => item.key));
    for (const mutation of queued || []) {
      if (keys.has(mutation.key) && mutation.entity === 'attachments' && mutation.operation !== 'delete') report(`${mutation.data.name} 已完成云端同步`, { key: mutation.key, id: mutation.id, name: mutation.data.name, state: 'complete', percent: 100 });
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
  ZX.Files = { configure, prepare, beforeSync, afterApplied, queueCleanup, processCleanup, discardConflict, cancel, clearLocal, diagnose };
})(window);
