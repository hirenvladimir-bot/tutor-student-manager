(function (root) {
  'use strict';
  const ZX = root.Zhixing = root.Zhixing || {};
  const tables = ['students', 'scores', 'preparations', 'course_progress', 'custom_fields', 'attachments'];
  let client;
  let channel;
  let userId;
  let onState = () => {};
  let onStatus = () => {};
  let running = false;
  let retryCount = 0;
  const MAX_ATTEMPTS = 6;
  const BATCH_SIZE = 20;

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
  function online() { return navigator.onLine !== false; }
  async function currentUser() { return (await client.auth.getUser()).data.user; }

  async function pull() {
    if (!client || !userId || !online()) return;
    const pending = new Map((await ZX.Database.all('outbox')).map(x => [x.key, x]));
    for (const entity of tables) {
      const { data, error } = await client.from(entity).select('*').eq('user_id', userId);
      if (error) throw error;
      for (const row of data || []) {
        const remote = decode(entity, row);
        const localMutation = pending.get(remote.key);
        if (localMutation && remote.version > localMutation.baseVersion && comparable(localMutation.data) === comparable(remote.data) && localMutation.operation === (remote.deletedAt ? 'delete' : 'upsert')) {
          await ZX.Database.applyServerRecord(remote); await ZX.Database.remove('outbox', remote.key); pending.delete(remote.key);
        } else if (localMutation && remote.version > localMutation.baseVersion) {
          await ZX.Database.saveConflict({ key: remote.key, entity, id: remote.id, local: localMutation, cloud: remote });
        } else if (!localMutation) await ZX.Database.applyServerRecord(remote);
      }
    }
    onState(await ZX.Database.state());
  }

  async function flush() {
    if (!client || !userId || !online() || running) return;
    const conflictKeys = new Set((await ZX.Database.all('conflicts')).map(item => item.key));
    let queued = (await ZX.Database.all('outbox'))
      .filter(item => (item.attempts || 0) < MAX_ATTEMPTS && !conflictKeys.has(item.key))
      .sort((a, b) => Number(a.entity === 'attachments') - Number(b.entity === 'attachments'))
      .slice(0, BATCH_SIZE);
    if (!queued.length) return;
    running = true;
    onStatus('syncing');
    try {
      const ready = [], uploadErrors = [];
      for (const item of queued) {
        try { ready.push(await ZX.Files.beforeSync(item)); }
        catch (error) {
          if (error?.code !== 'UPLOAD_CANCELLED') {
            uploadErrors.push(error);
            const latest = await ZX.Database.get('outbox', item.key) || item;
            await ZX.Database.put('outbox', { ...latest, attempts: (latest.attempts || 0) + 1, lastError: error.message || String(error), lastAttemptAt: new Date().toISOString() });
          }
        }
      }
      if (ready.length) onState(await ZX.Database.state());
      if (ready.length) {
        const payload = ready.map(item => ({ entity: item.entity, id: item.id, student_id: item.studentId, base_version: item.baseVersion, operation: item.operation, data: item.data, deleted_at: item.deletedAt }));
        const { data, error } = await client.rpc('apply_tutor_mutations', { p_mutations: payload });
        if (error) {
          for (const item of ready) await ZX.Database.put('outbox', { ...item, attempts: (item.attempts || 0) + 1, lastError: error.message, lastAttemptAt: new Date().toISOString() });
          throw error;
        }
        for (const item of data?.applied || []) await ZX.Database.markApplied(item.key, item.version, item.updated_at);
        await ZX.Files.afterApplied(data?.applied || [], ready);
        for (const conflict of data?.conflicts || []) await ZX.Database.saveConflict({ ...conflict, local: ready.find(x => x.key === conflict.key) });
      }
      retryCount = 0; clearTimeout(sync.retryTimer);
      if (uploadErrors.length) onStatus('error', uploadErrors[0]); else onStatus('online');
    } catch (error) {
      onStatus('error', error);
      if (online()) { clearTimeout(sync.retryTimer); const delay = Math.min(60000, 5000 * (2 ** Math.min(retryCount++, 3))); sync.retryTimer = setTimeout(sync, delay); }
      throw error;
    } finally { running = false; }
  }

  async function sync() {
    if (!userId || !online()) { onStatus('offline'); return false; }
    try { await flush(); await pull(); await writeLegacySnapshot(); onStatus('online'); const conflictKeys=new Set((await ZX.Database.all('conflicts')).map(item=>item.key));const retryable=(await ZX.Database.all('outbox')).some(item=>(item.attempts||0)<MAX_ATTEMPTS&&!conflictKeys.has(item.key));if(retryable){clearTimeout(schedule.timer);schedule.timer=setTimeout(sync,1200);} return true; }
    catch (error) { onStatus('error', error); return false; }
  }
  async function migrateLegacy() {
    if (!client || !userId) return;
    const { error } = await client.rpc('migrate_legacy_tutor_profile');
    if (error && !/does not exist/i.test(error.message)) throw error;
  }
  async function writeLegacySnapshot() {
    const state = await ZX.Database.state();
    const { error } = await client.from('tutor_profiles').upsert({ user_id: userId, data: state, updated_at: new Date().toISOString() });
    if (error) throw new Error(`兼容快照写入失败：${error.message || error}`);
  }
  async function subscribe() {
    if (channel) await client.removeChannel(channel);
    channel = client.channel(`zhixing-v2-${userId}`);
    tables.forEach(table => channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `user_id=eq.${userId}` }, () => { clearTimeout(subscribe.timer); subscribe.timer = setTimeout(pull, 250); }));
    channel.subscribe(status => onStatus(status === 'SUBSCRIBED' ? 'online' : 'connecting'));
  }
  async function start(options) {
    client = options.client; onState = options.onState || onState; onStatus = options.onStatus || onStatus;
    const user = await currentUser();
    userId = user?.id || null;
    if (!userId) return false;
    await migrateLegacy();
    await ZX.Database.queueNewRecords();
    await pull();
    await flush();
    await ZX.Files.processCleanup();
    await subscribe();
    return true;
  }
  async function stop() { if (channel && client) await client.removeChannel(channel); clearTimeout(sync.retryTimer); retryCount = 0; channel = null; userId = null; }
  async function resolve(key, choice) {
    const conflict = await ZX.Database.get('conflicts', key);
    if (choice === 'cloud') await ZX.Files.discardConflict(conflict);
    await ZX.Database.resolveConflict(key, choice);
    await ZX.Files.processCleanup();
    await flush(); await pull();
  }
  function schedule() { clearTimeout(schedule.timer); schedule.timer = setTimeout(sync, 900); }
  root.addEventListener('online', () => { ZX.Files.processCleanup(); sync(); });
  root.addEventListener('offline', () => onStatus('offline'));
  ZX.Sync = { start, stop, sync, pull, flush, schedule, resolve, online };
})(window);
