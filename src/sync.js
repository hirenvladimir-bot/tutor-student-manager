(function (root) {
  'use strict';
  const ZX = root.Zhixing = root.Zhixing || {};
  const tables = ['students', 'scores', 'preparations', 'course_progress', 'custom_fields', 'attachments'];
  let client;
  let channel;
  let userId;
  let onState = () => {};
  let onStatus = () => {};
  let flushPromise = null;
  let syncPromise = null;
  let resyncRequested = false;
  let sessionEpoch = 0;
  let pullPromise = null;
  let retryCount = 0;
  const MAX_ATTEMPTS = 6;
  const BATCH_SIZE = 20;
  const STOP_DRAIN_TIMEOUT = 500;
  const session = () => ({ epoch: sessionEpoch, client, userId });
  const isCurrent = value => Boolean(value && value.epoch === sessionEpoch && value.client === client && value.userId === userId && value.userId);

  const camel = {
    students: row => ({ name: row.name || '', school: row.school || '', targetSchool: row.target_school || '', currentScore: row.current_score, targetScore: row.target_score, nextLesson: row.next_lesson || '', focusContent: row.focus_content || '' }),
    scores: row => ({ label: row.label || '', date: row.exam_date || '', score: Number(row.score) }),
    preparations: row => ({ title: row.title || '', content: row.content || '', date: row.record_date || '' }),
    course_progress: row => ({ title: row.title || '', content: row.content || '', date: row.record_date || '' }),
    custom_fields: row => ({ key: row.field_key || '', value: row.field_value || '' }),
    attachments: row => ({ ownerType: row.owner_type, ownerId: row.owner_id, name: row.name, relativePath: row.relative_path || '', type: row.mime_type || 'application/octet-stream', size: Number(row.size || 0), path: row.storage_path || '', data: row.legacy_data || '', pending: false, localBlobKey: '' })
  };
  function decode(entity, row) {
    return { key: `${entity}:${row.id}`, entity, id: row.id, studentId: row.student_id || null, data: camel[entity](row), version: Number(row.version || 0), deletedAt: row.deleted_at || null, updatedAt: row.updated_at };
  }
  function comparable(data) { const value = { ...(data || {}) }; delete value.pending; delete value.localBlobKey; delete value.uploadPath; return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))); }
  function sameOperation(local, cloud) { return local?.operation === (cloud?.deletedAt ? 'delete' : 'upsert'); }
  function canonicalOwnerType(value) {
    const normalized = String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
    if (['course', 'courseprogress', 'progress'].includes(normalized)) return 'course_progress';
    if (['prep', 'preparation', 'preparations'].includes(normalized)) return 'preparations';
    return normalized;
  }
  function canonicalRelativePath(value, name) {
    const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
    return normalized === String(name || '').replace(/\\/g, '/') ? '' : normalized;
  }
  function sameWhenPresent(left, right, normalize = value => String(value)) {
    const hasLeft = left !== undefined && left !== null && left !== '';
    const hasRight = right !== undefined && right !== null && right !== '';
    return !hasLeft || !hasRight || normalize(left) === normalize(right);
  }
  function sameAttachmentIdentity(local, cloud) {
    if (local?.entity !== 'attachments' || local.operation !== 'upsert' || !cloud?.data?.path) return false;
    const left = local.data || {}, right = cloud.data || {};
    const localPath = left.path || left.uploadPath || '';
    return (!localPath || localPath === right.path)
      && sameWhenPresent(local.studentId, cloud.studentId)
      && sameWhenPresent(left.ownerId, right.ownerId)
      && sameWhenPresent(left.ownerType, right.ownerType, canonicalOwnerType)
      && String(left.name || '').normalize('NFC') === String(right.name || '').normalize('NFC')
      && sameWhenPresent(canonicalRelativePath(left.relativePath, left.name), canonicalRelativePath(right.relativePath, right.name))
      && sameWhenPresent(left.type, right.type, value => String(value).toLowerCase())
      && sameWhenPresent(left.size, right.size, value => Number(value || 0))
      && sameWhenPresent(left.data, right.data);
  }
  function isSafeLegacyAttachmentRetry(local, cloud) {
    if (!sameAttachmentIdentity(local, cloud) || local.data?.localBlobKey || cloud.deletedAt) return false;
    const localPath = local.data?.path || local.data?.uploadPath || '';
    return !localPath || localPath === cloud.data.path;
  }
  function isEquivalentMutation(local, cloud) { return Boolean(local && cloud && sameOperation(local, cloud) && (comparable(local.data) === comparable(cloud.data) || sameAttachmentIdentity(local, cloud))); }
  async function acceptEquivalent(local, cloud, preserveStorage = false, context = session()) {
    if (!isCurrent(context)) return false;
    if (local.entity === 'attachments') await ZX.Files.discardConflict({ local, cloud }, { preserveStorage }, { isActive: () => isCurrent(context) });
    if (!isCurrent(context)) return false;
    await ZX.Database.applyServerRecord(cloud);
    await ZX.Database.remove('outbox', local.key);
    await ZX.Database.remove('conflicts', local.key);
    return true;
  }
  function online() { return navigator.onLine !== false; }
  async function currentUser(targetClient = client) { return (await targetClient.auth.getUser()).data.user; }

  async function pullOnce(context) {
    if (!isCurrent(context) || !online()) return false;
    const knownConflicts = new Map((await ZX.Database.all('conflicts')).map(x => [x.key, x]));
    for (const entity of tables) {
      const { data, error } = await context.client.from(entity).select('*').eq('user_id', context.userId);
      if (!isCurrent(context)) return false;
      if (error) throw error;
      for (const row of data || []) {
        if (!isCurrent(context)) return false;
        const remote = decode(entity, row);
        const localMutation = await ZX.Database.get('outbox', remote.key);
        if (!isCurrent(context)) return false;
        if (localMutation && isSafeLegacyAttachmentRetry(localMutation, remote)) {
          await acceptEquivalent(localMutation, remote, true, context); knownConflicts.delete(remote.key);
        } else if (localMutation && remote.version > localMutation.baseVersion && isEquivalentMutation(localMutation, remote)) {
          await acceptEquivalent(localMutation, remote, false, context); knownConflicts.delete(remote.key);
        } else if (localMutation && remote.version > localMutation.baseVersion) {
          await ZX.Database.saveConflict({ key: remote.key, entity, id: remote.id, local: localMutation, cloud: remote });
        } else if (!localMutation) {
          const stale = knownConflicts.get(remote.key);
          if (stale?.local?.entity === 'attachments') await ZX.Files.discardConflict({ ...stale, cloud: remote }, { preserveStorage: true }, { isActive: () => isCurrent(context) });
          if (!isCurrent(context)) return false;
          if (stale) await ZX.Database.remove('conflicts', remote.key);
          await ZX.Database.applyServerRecord(remote);
        }
      }
    }
    if (!isCurrent(context)) return false;
    await onState(await ZX.Database.state());
    return isCurrent(context);
  }
  function pull(context = session()) {
    if (!isCurrent(context)) return Promise.resolve(false);
    if (pullPromise?.epoch === context.epoch) return pullPromise.promise;
    let promise;
    promise = pullOnce(context).finally(() => { if (pullPromise?.promise === promise) pullPromise = null; });
    pullPromise = { epoch: context.epoch, promise };
    return promise;
  }

  function sameSubmittedMutation(left, right) {
    return Boolean(left && right
      && left.entity === right.entity
      && left.id === right.id
      && (left.studentId || null) === (right.studentId || null)
      && left.operation === right.operation
      && (left.deletedAt || null) === (right.deletedAt || null)
      && comparable(left.data) === comparable(right.data));
  }

  async function submitReady(ready, context) {
    if (!ready.length || !isCurrent(context)) return [];
    await onState(await ZX.Database.state());
    if (!isCurrent(context)) return [];
    const payload = ready.map(item => ({ entity: item.entity, id: item.id, student_id: item.studentId, base_version: item.baseVersion, operation: item.operation, data: item.data, deleted_at: item.deletedAt }));
    const { data, error } = await context.client.rpc('apply_tutor_mutations', { p_mutations: payload });
    if (!isCurrent(context)) return [];
    if (error) {
      for (const item of ready) await ZX.Database.markFailed(item.key, item, error);
      throw error;
    }
    const accepted = [];
    for (const item of data?.applied || []) {
      if (!isCurrent(context)) return accepted;
      const sent = ready.find(record => record.key === item.key);
      const status = await ZX.Database.markApplied(item.key, item.version, item.updated_at, sent);
      if (status === 'applied') accepted.push(item);
    }
    await ZX.Files.afterApplied(accepted, ready, { client: context.client, isActive: () => isCurrent(context) });
    const equivalent = [];
    for (const conflict of data?.conflicts || []) {
      if (!isCurrent(context)) return accepted;
      const sent = ready.find(x => x.key === conflict.key);
      const latest = await ZX.Database.get('outbox', conflict.key);
      const local = latest && !sameSubmittedMutation(latest, sent) ? latest : sent;
      if (isSafeLegacyAttachmentRetry(local, conflict.cloud)) { await acceptEquivalent(local, conflict.cloud, true, context); equivalent.push(local); }
      else if (isEquivalentMutation(local, conflict.cloud)) { await acceptEquivalent(local, conflict.cloud, false, context); equivalent.push(local); }
      else await ZX.Database.saveConflict({ ...conflict, local });
    }
    if (equivalent.length && isCurrent(context)) await ZX.Files.afterApplied(equivalent.map(item => ({ key: item.key })), equivalent, { client: context.client, isActive: () => isCurrent(context) });
    return accepted;
  }

  async function flushOnce(context) {
    if (!isCurrent(context) || !online()) return false;
    const conflictKeys = new Set((await ZX.Database.all('conflicts')).map(item => item.key));
    let queued = (await ZX.Database.all('outbox'))
      .filter(item => (item.attempts || 0) < MAX_ATTEMPTS && !conflictKeys.has(item.key))
      .sort((a, b) => Number(a.entity === 'attachments') - Number(b.entity === 'attachments'))
      .slice(0, BATCH_SIZE);
    if (!isCurrent(context)) return false;
    if (!queued.length) return;
    onStatus('syncing');
    try {
      const uploadErrors = [];
      const needsUpload = item => item.entity === 'attachments' && item.operation !== 'delete' && item.data?.localBlobKey && !item.data?.path;
      const immediate = queued.filter(item => !needsUpload(item));
      const uploads = queued.filter(needsUpload);
      const prepare = async items => {
        const ready = [];
        for (const item of items) {
          try { ready.push(await ZX.Files.beforeSync(item, { client: context.client, isActive: () => isCurrent(context) })); }
          catch (error) {
            if (!isCurrent(context)) return ready;
            if (error?.code !== 'UPLOAD_CANCELLED') {
              uploadErrors.push(error);
              const latest = await ZX.Database.get('outbox', item.key) || item;
              await ZX.Database.put('outbox', { ...latest, attempts: (latest.attempts || 0) + 1, lastError: error.message || String(error), lastAttemptAt: new Date().toISOString() });
            }
          }
        }
        return ready;
      };

      // Persist normal records first. A slow or suspended TUS upload must never
      // block scores, notes, custom fields, or already-uploaded file metadata.
      await submitReady(await prepare(immediate), context);
      if (!isCurrent(context)) return false;
      await submitReady(await prepare(uploads), context);
      if (!isCurrent(context)) return false;
      retryCount = 0; clearTimeout(sync.retryTimer);
      const remaining = await ZX.Database.all('outbox');
      if (uploadErrors.length) onStatus('error', uploadErrors[0]); else onStatus(remaining.length ? 'pending' : 'online');
    } catch (error) {
      if (!isCurrent(context)) return false;
      onStatus('error', error);
      if (online()) { clearTimeout(sync.retryTimer); const delay = Math.min(60000, 5000 * (2 ** Math.min(retryCount++, 3))); sync.retryTimer = setTimeout(() => { if (isCurrent(context)) sync(); }, delay); }
      throw error;
    }
    return true;
  }
  function flush(context = session()) {
    if (!isCurrent(context) || !online()) return Promise.resolve(false);
    if (flushPromise?.epoch === context.epoch) return flushPromise.promise;
    let promise;
    promise = flushOnce(context).finally(() => { if (flushPromise?.promise === promise) flushPromise = null; });
    flushPromise = { epoch: context.epoch, promise };
    return promise;
  }

  async function runSync(context) {
    try {
      // Drain every fresh mutation produced by the current batch or by the
      // asynchronous UI normalization invoked from pull(). Failed items retain
      // their backoff; they are not hammered in a tight loop.
      for (let pass = 0; pass < 100 && isCurrent(context) && online(); pass++) {
        resyncRequested = false;
        await flush(context);
        await pull(context);
        await ZX.Files.processCleanup({ client: context.client, isActive: () => isCurrent(context) });
        if (!isCurrent(context)) return false;
        const conflictKeys = new Set((await ZX.Database.all('conflicts')).map(item => item.key));
        const fresh = (await ZX.Database.all('outbox')).some(item => (item.attempts || 0) === 0 && !conflictKeys.has(item.key));
        if (!fresh && !resyncRequested) break;
      }
      if (!isCurrent(context)) return false;
      await writeLegacySnapshot(context);
      if (!isCurrent(context)) return false;
      const stats = await ZX.Database.stats();
      const conflictKeys = new Set((await ZX.Database.all('conflicts')).map(item => item.key));
      const retryable = (await ZX.Database.all('outbox')).some(item => (item.attempts || 0) < MAX_ATTEMPTS && !conflictKeys.has(item.key));
      if (retryable) {
        clearTimeout(schedule.timer);
        schedule.timer = setTimeout(sync, 1200);
      }
      const complete = stats.pending === 0 && stats.cleanup === 0 && stats.conflicts === 0;
      onStatus(complete ? 'online' : 'pending');
      return complete;
    } catch (error) {
      if (!isCurrent(context)) return false;
      onStatus('error', error);
      return false;
    }
  }
  function sync() {
    if (!userId || !online()) { onStatus('offline'); return Promise.resolve(false); }
    resyncRequested = true;
    const context = session();
    if (syncPromise?.epoch === context.epoch) return syncPromise.promise;
    clearTimeout(schedule.timer);
    let promise;
    promise = runSync(context).finally(() => {
      if (syncPromise?.promise === promise) syncPromise = null;
      // A schedule request may land after runSync's last queue inspection.
      // Preserve that edge-trigger instead of silently losing it.
      if (resyncRequested && isCurrent(context) && online()) schedule();
    });
    syncPromise = { epoch: context.epoch, promise };
    return promise;
  }
  async function migrateLegacy(context) {
    if (!isCurrent(context)) return false;
    const { error } = await context.client.rpc('migrate_legacy_tutor_profile');
    if (!isCurrent(context)) return false;
    if (error && !/does not exist/i.test(error.message)) throw error;
    return true;
  }
  async function writeLegacySnapshot(context) {
    if (!isCurrent(context)) return false;
    const state = await ZX.Database.state();
    if (!isCurrent(context)) return false;
    const { error } = await context.client.from('tutor_profiles').upsert({ user_id: context.userId, data: state, updated_at: new Date().toISOString() });
    if (!isCurrent(context)) return false;
    if (error) throw new Error(`兼容快照写入失败：${error.message || error}`);
    return true;
  }
  async function subscribe(context) {
    if (!isCurrent(context)) return false;
    const previous = channel;
    if (previous) await context.client.removeChannel(previous);
    if (!isCurrent(context)) return false;
    const nextChannel = context.client.channel(`zhixing-v2-${context.userId}`);
    tables.forEach(table => nextChannel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `user_id=eq.${context.userId}` }, () => { if (!isCurrent(context)) return; clearTimeout(subscribe.timer); subscribe.timer = setTimeout(schedule, 250); }));
    nextChannel.subscribe(status => { if (isCurrent(context)) onStatus(status === 'SUBSCRIBED' ? 'online' : 'connecting'); });
    if (!isCurrent(context)) { await context.client.removeChannel(nextChannel); return false; }
    channel = nextChannel;
    return true;
  }
  async function start(options) {
    const previousChannel = channel, previousClient = client;
    const epoch = ++sessionEpoch;
    client = options.client; userId = null; channel = null;
    pullPromise = null; flushPromise = null; syncPromise = null; resyncRequested = false; retryCount = 0;
    onState = options.onState || onState; onStatus = options.onStatus || onStatus;
    const targetClient = client;
    if (previousChannel && previousClient) await previousClient.removeChannel(previousChannel);
    if (epoch !== sessionEpoch || client !== targetClient) return false;
    const user = await currentUser(targetClient);
    if (epoch !== sessionEpoch || client !== targetClient) return false;
    userId = user?.id || null;
    if (!userId) return false;
    const context = session();
    const owner = await ZX.Database.getSyncOwner();
    if (!isCurrent(context)) return false;
    if (owner && owner !== context.userId && options.allowAdoptLocal !== true) {
      const error = new Error('检测到本机数据属于另一个账号，请先退出并清除本机数据后再切换账号');
      error.code = 'ACCOUNT_SWITCH_REQUIRES_RESET';
      onStatus('error', error);
      userId = null;
      return false;
    }
    await ZX.Database.setSyncOwner(context.userId);
    if (!isCurrent(context)) return false;
    await migrateLegacy(context);
    if (!isCurrent(context)) return false;
    await ZX.Database.queueNewRecords();
    await sync();
    if (!isCurrent(context)) return false;
    await subscribe(context);
    return isCurrent(context);
  }
  async function stop() {
    const previousChannel = channel, previousClient = client;
    const flights = [pullPromise?.promise, flushPromise?.promise, syncPromise?.promise].filter(Boolean);
    sessionEpoch++; resyncRequested = false; channel = null; userId = null; client = null;
    pullPromise = null; flushPromise = null; syncPromise = null;
    clearTimeout(sync.retryTimer); clearTimeout(schedule.timer); clearTimeout(subscribe.timer); retryCount = 0;
    if (ZX.Files.cancelActive) flights.push(ZX.Files.cancelActive());
    if (previousChannel && previousClient) flights.push(previousClient.removeChannel(previousChannel));
    if (flights.length) {
      let timer;
      await Promise.race([
        Promise.allSettled(flights),
        new Promise(resolve => { timer = setTimeout(resolve, STOP_DRAIN_TIMEOUT); })
      ]);
      clearTimeout(timer);
    }
  }
  async function resolve(key, choice) {
    const context = session();
    if (!isCurrent(context)) return false;
    const conflict = await ZX.Database.get('conflicts', key);
    if (choice === 'cloud') await ZX.Files.discardConflict(conflict, {}, { isActive: () => isCurrent(context) });
    if (!isCurrent(context)) return false;
    await ZX.Database.resolveConflict(key, choice);
    await ZX.Files.processCleanup({ client: context.client, isActive: () => isCurrent(context) });
    await flush(context); await pull(context);
    return isCurrent(context);
  }
  function schedule() {
    resyncRequested = true;
    if (syncPromise) return;
    clearTimeout(schedule.timer);
    schedule.timer = setTimeout(sync, 350);
  }
  root.addEventListener('online', () => { const context = session(); if (isCurrent(context)) { ZX.Files.processCleanup({ client: context.client, isActive: () => isCurrent(context) }); sync(); } });
  root.addEventListener('offline', () => onStatus('offline'));
  ZX.Sync = { start, stop, sync, pull, flush, schedule, resolve, online };
})(window);
