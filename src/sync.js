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
  function comparable(data) { const value = { ...(data || {}) }; delete value.pending; delete value.localBlobKey; return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))); }
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
    let queued = await ZX.Database.all('outbox');
    if (!queued.length) return;
    running = true;
    onStatus('syncing');
    try {
      queued = await Promise.all(queued.map(item => ZX.Files.beforeSync(item)));
      const payload = queued.map(item => ({ entity: item.entity, id: item.id, student_id: item.studentId, base_version: item.baseVersion, operation: item.operation, data: item.data, deleted_at: item.deletedAt }));
      const { data, error } = await client.rpc('apply_tutor_mutations', { p_mutations: payload });
      if (error) throw error;
      for (const item of data?.applied || []) await ZX.Database.markApplied(item.key, item.version, item.updated_at);
      for (const conflict of data?.conflicts || []) await ZX.Database.saveConflict({ ...conflict, local: queued.find(x => x.key === conflict.key) });
      onStatus('online');
    } catch (error) {
      for (const item of queued) await ZX.Database.put('outbox', { ...item, attempts: (item.attempts || 0) + 1, lastError: error.message, lastAttemptAt: new Date().toISOString() });
      onStatus('error', error);
      throw error;
    } finally { running = false; }
  }

  async function sync() {
    if (!userId || !online()) { onStatus('offline'); return; }
    try { await flush(); await pull(); await writeLegacySnapshot(); onStatus('online'); }
    catch (error) { onStatus('error', error); }
  }
  async function migrateLegacy() {
    if (!client || !userId) return;
    const { error } = await client.rpc('migrate_legacy_tutor_profile');
    if (error && !/does not exist/i.test(error.message)) throw error;
  }
  async function writeLegacySnapshot() {
    const state = await ZX.Database.state();
    await client.from('tutor_profiles').upsert({ user_id: userId, data: state, updated_at: new Date().toISOString() });
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
    await subscribe();
    return true;
  }
  async function stop() { if (channel && client) await client.removeChannel(channel); channel = null; userId = null; }
  async function resolve(key, choice) { await ZX.Database.resolveConflict(key, choice); await flush(); await pull(); }
  function schedule() { clearTimeout(schedule.timer); schedule.timer = setTimeout(sync, 900); }
  root.addEventListener('online', sync);
  root.addEventListener('offline', () => onStatus('offline'));
  ZX.Sync = { start, stop, sync, pull, flush, schedule, resolve, online };
})(window);
