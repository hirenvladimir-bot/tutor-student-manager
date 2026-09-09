(function (root) {
  'use strict';
  const ZX = root.Zhixing = root.Zhixing || {};
  const DB_NAME = 'zhixing-tutor-v2';
  const DB_VERSION = 1;
  const STORES = ['records', 'outbox', 'conflicts', 'blobs', 'meta'];
  let db;
  let baseline = new Map();

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

  async function persist(state, enqueue = true) {
    const normalized = ZX.Model.flatten(state);
    const changes = ZX.Model.diff(baseline, normalized);
    for (const change of changes) {
      const stored = { ...change };
      delete stored.baseVersion; delete stored.operation;
      await put('records', stored);
      if (enqueue) {
        const existing = await get('outbox', change.key);
        await put('outbox', { ...change, key: change.key, baseVersion: existing?.baseVersion ?? change.baseVersion, attempts: existing?.attempts || 0, queuedAt: existing?.queuedAt || new Date().toISOString() });
      }
      baseline.set(change.key, stored);
    }
    await put('meta', { key: 'state', activeId: state.activeId, updatedAt: new Date().toISOString() });
    return changes;
  }

  async function applyServerRecord(record) {
    const stored = { ...record, key: `${record.entity}:${record.id}` };
    await put('records', stored);
    baseline.set(stored.key, stored);
  }
  async function markApplied(key, version, updatedAt) {
    const record = baseline.get(key);
    if (record) await applyServerRecord({ ...record, version, updatedAt });
    await remove('outbox', key);
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
  async function stats() { return { pending: (await all('outbox')).length, conflicts: (await all('conflicts')).length, failed: (await all('outbox')).filter(x => x.attempts >= 3).length }; }
  async function queueNewRecords() { for (const record of baseline.values()) if (!record.deletedAt && record.version === 0 && !(await get('outbox', record.key))) await put('outbox', { ...record, baseVersion: 0, operation: 'upsert', attempts: 0, queuedAt: new Date().toISOString() }); }
  async function discardLocalRecord(key) { const record = baseline.get(key) || await get('outbox', key); if (record?.data?.localBlobKey) await remove('blobs', record.data.localBlobKey); await remove('outbox', key); await remove('records', key); await remove('conflicts', key); baseline.delete(key); }
  async function wipe() { for (const store of STORES) await clear(store); baseline = new Map(); }

  ZX.Database = { DB_NAME, start, persist, all, get, put, remove, clear, state, stats, queueNewRecords, discardLocalRecord, applyServerRecord, markApplied, saveConflict, resolveConflict, wipe };
})(window);
