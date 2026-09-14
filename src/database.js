(function (root) {
  'use strict';
  const ZX = root.Zhixing = root.Zhixing || {};
  const DB_NAME = 'zhixing-tutor-v2';
  const DB_VERSION = 2;
  const STORES = ['records', 'outbox', 'conflicts', 'blobs', 'cleanup', 'meta'];
  const MAX_ATTEMPTS = 6;
  let db;
  let baseline = new Map();
  let persistChain = Promise.resolve();

  const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  function open() {
    if (!root.indexedDB) return Promise.resolve(null);
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => STORES.forEach(name => { if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'key' }); });
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }
  async function all(store) { const database = await open(); return database ? request(database.transaction(store).objectStore(store).getAll()) : []; }
  async function get(store, key) { const database = await open(); return database ? request(database.transaction(store).objectStore(store).get(key)) : null; }
  async function put(store, value) { const database = await open(); if (!database) return; return request(database.transaction(store, 'readwrite').objectStore(store).put(value)); }
  async function remove(store, key) { const database = await open(); if (!database) return; return request(database.transaction(store, 'readwrite').objectStore(store).delete(key)); }
  async function clear(store) { const database = await open(); if (!database) return; return request(database.transaction(store, 'readwrite').objectStore(store).clear()); }

  async function start(legacyState) {
    await open();
    const saved = await all('records');
    const meta = await get('meta', 'state');
    if (saved.length) {
      baseline = new Map(saved.map(r => [r.key, r]));
      return ZX.Model.hydrate(baseline, meta?.activeId);
    }
    const migrated = ZX.Model.ensureIds(legacyState);
    baseline = ZX.Model.flatten(migrated);
    for (const record of baseline.values()) await put('records', record);
    await put('meta', { key: 'state', activeId: migrated.activeId, migratedAt: new Date().toISOString() });
    return migrated;
  }

  async function persistOnce(state, enqueue = true) {
    const normalized = ZX.Model.flatten(state);
    const changes = ZX.Model.diff(baseline, normalized);
    const database = await open();
    if (!database) return changes;
    const storedChanges = changes.map(change => { const stored = { ...change }; delete stored.baseVersion; delete stored.operation; return stored; });
    await new Promise((resolve, reject) => {
      const tx = database.transaction(['records', 'outbox', 'meta'], 'readwrite');
      const records = tx.objectStore('records'), outbox = tx.objectStore('outbox'), meta = tx.objectStore('meta');
      try {
        changes.forEach((change, index) => {
          records.put(storedChanges[index]);
          if (enqueue) {
            const req = outbox.get(change.key);
            req.onsuccess = () => {
              const existing = req.result;
              outbox.put({ ...change, key: change.key, baseVersion: existing?.baseVersion ?? change.baseVersion, attempts: existing?.attempts || 0, queuedAt: existing?.queuedAt || new Date().toISOString() });
            };
          }
        });
        meta.put({ key: 'state', activeId: state.activeId, updatedAt: new Date().toISOString() });
      } catch (error) {
        try { tx.abort(); } catch {}
        reject(error);
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('persist transaction aborted'));
    });
    storedChanges.forEach(stored => baseline.set(stored.key, stored));
    return changes;
  }
  function persist(state, enqueue = true) {
    const operation = persistChain.then(() => persistOnce(state, enqueue));
    persistChain = operation.catch(() => {});
    return operation;
  }

  async function applyServerRecord(record) {
    const stored = { ...record, key: `${record.entity}:${record.id}` };
    await put('records', stored);
    baseline.set(stored.key, stored);
  }
  function sameMutation(left, right) {
    if (!left || !right) return false;
    return left.entity === right.entity
      && left.id === right.id
      && (left.studentId || null) === (right.studentId || null)
      && left.operation === right.operation
      && (left.deletedAt || null) === (right.deletedAt || null)
      && JSON.stringify(Object.fromEntries(Object.entries(left.data || {}).sort(([a], [b]) => a.localeCompare(b))))
        === JSON.stringify(Object.fromEntries(Object.entries(right.data || {}).sort(([a], [b]) => a.localeCompare(b))));
  }
  async function markApplied(key, version, updatedAt, appliedRecord = null) {
    const database = await open();
    if (!database) return;
    const sent = appliedRecord || baseline.get(key);
    let stored = null, status = 'cancelled';
    await new Promise((resolve, reject) => {
      const tx = database.transaction(['records', 'outbox'], 'readwrite');
      const records = tx.objectStore('records');
      const outbox = tx.objectStore('outbox');
      const req = outbox.get(key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const latest = req.result;
        if (!latest) {
          status = 'cancelled';
          return;
        }
        if (sent && !sameMutation(latest, sent)) {
          // A newer local edit arrived while this request was in flight. Keep it,
          // but rebase it on the version that the server has just accepted.
          const rebased = { ...latest, baseVersion: version, version, attempts: 0, lastError: '', lastAttemptAt: '', queuedAt: latest.queuedAt || new Date().toISOString() };
          stored = { ...rebased };
          delete stored.baseVersion; delete stored.operation;
          records.put(stored);
          outbox.put(rebased);
          status = 'rebased';
        } else {
          stored = sent ? { ...sent, key, version, updatedAt } : { ...latest, key, version, updatedAt };
          if (stored) {
            delete stored.baseVersion; delete stored.operation;
            records.put(stored);
          }
          outbox.delete(key);
          status = 'applied';
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('markApplied transaction aborted'));
    });
    if (stored) baseline.set(key, stored);
    return status;
  }
  async function markFailed(key, sent, error) {
    const database = await open();
    if (!database) return;
    await new Promise((resolve, reject) => {
      const tx = database.transaction('outbox', 'readwrite');
      const outbox = tx.objectStore('outbox');
      const req = outbox.get(key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const latest = req.result;
        // The failure belongs to the submitted revision. Never overwrite or
        // penalize a newer local edit which arrived while the RPC was running.
        if (latest && sameMutation(latest, sent)) outbox.put({ ...latest, attempts: (latest.attempts || 0) + 1, lastError: error?.message || String(error), lastAttemptAt: new Date().toISOString() });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('markFailed transaction aborted'));
    });
  }
  async function saveConflict(conflict) { await put('conflicts', { ...conflict, key: conflict.key || `${conflict.entity}:${conflict.id}`, createdAt: new Date().toISOString() }); }
  async function resolveConflict(key, choice) {
    const conflict = await get('conflicts', key);
    if (!conflict) return;
    if (choice === 'cloud') {
      await applyServerRecord(conflict.cloud);
      await remove('outbox', key);
    } else {
      await put('outbox', { ...conflict.local, key, baseVersion: conflict.cloud.version, operation: conflict.local.deletedAt ? 'delete' : 'upsert', attempts: 0, queuedAt: new Date().toISOString() });
    }
    await remove('conflicts', key);
  }
  async function state() { const meta = await get('meta', 'state'); return ZX.Model.hydrate(baseline, meta?.activeId); }
  async function stats() {
    const outbox = await all('outbox'), cleanup = await all('cleanup');
    return { pending: outbox.length, cleanup: cleanup.length, conflicts: (await all('conflicts')).length, failed: outbox.filter(x => (x.attempts || 0) >= MAX_ATTEMPTS).length + cleanup.filter(x => (x.attempts || 0) >= MAX_ATTEMPTS).length };
  }
  async function getSyncOwner() { return (await get('meta', 'sync-owner'))?.userId || null; }
  async function setSyncOwner(userId) { await put('meta', { key: 'sync-owner', userId, updatedAt: new Date().toISOString() }); }
  async function queueNewRecords() { for (const record of baseline.values()) if (!record.deletedAt && record.version === 0 && !(await get('outbox', record.key))) await put('outbox', { ...record, baseVersion: 0, operation: 'upsert', attempts: 0, queuedAt: new Date().toISOString() }); }
  async function discardLocalRecord(key) { const record = baseline.get(key) || await get('outbox', key); if (record?.data?.localBlobKey) await remove('blobs', record.data.localBlobKey); await remove('outbox', key); await remove('records', key); await remove('conflicts', key); baseline.delete(key); }
  async function retryFailedUploads() {
    const failed = (await all('outbox')).filter(item => item.entity === 'attachments' && item.data?.localBlobKey && (item.attempts || 0) >= MAX_ATTEMPTS);
    for (const item of failed) await put('outbox', { ...item, attempts: 0, lastError: '', queuedAt: new Date().toISOString() });
    return failed.length;
  }
  async function retryFailedItems() {
    const failed = (await all('outbox')).filter(item => (item.attempts || 0) >= MAX_ATTEMPTS);
    for (const item of failed) await put('outbox', { ...item, attempts: 0, lastError: '', queuedAt: new Date().toISOString() });
    return failed.length;
  }
  async function discardFailedUploads() {
    const failed = (await all('outbox')).filter(item => item.entity === 'attachments' && item.data?.localBlobKey && (item.attempts || 0) >= MAX_ATTEMPTS);
    for (const item of failed) await discardLocalRecord(item.key);
    return failed.length;
  }
  async function wipe() { await persistChain; for (const store of STORES) await clear(store); baseline = new Map(); persistChain = Promise.resolve(); }

  ZX.Database = { DB_NAME, MAX_ATTEMPTS, start, persist, all, get, put, remove, clear, state, stats, getSyncOwner, setSyncOwner, queueNewRecords, discardLocalRecord, retryFailedUploads, retryFailedItems, discardFailedUploads, applyServerRecord, markApplied, markFailed, saveConflict, resolveConflict, wipe };
})(window);
