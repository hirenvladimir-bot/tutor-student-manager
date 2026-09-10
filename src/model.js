(function (root) {
  'use strict';
  const ZX = root.Zhixing = root.Zhixing || {};
  const entityOrder = ['students', 'scores', 'preparations', 'course_progress', 'custom_fields', 'attachments'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const uuid = () => root.crypto?.randomUUID?.() || `zx-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const notePrefix = '[[ZHIXING_NOTES_V1]]';
  const own = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj?.[k] ?? (k.endsWith('Score') ? null : '')]));
  const attachmentData = (file, ownerType, ownerId) => ({ ownerType, ownerId, name: file.name || '未命名文件', relativePath: file.relativePath || '', type: file.type || 'application/octet-stream', size: Number(file.size || 0), path: file.path || '', uploadPath: file.uploadPath || '', data: file.data || '', pending: Boolean(file.pending), localBlobKey: file.localBlobKey || '' });
  function decodeNoteEntries(value) {
    if (typeof value !== 'string' || !value.startsWith(notePrefix)) return null;
    try { const parsed = JSON.parse(value.slice(notePrefix.length)); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  }
  function encodeNoteEntries(entries, legacy = '') { return Array.isArray(entries) ? `${notePrefix}${JSON.stringify(entries)}` : (legacy || ''); }
  function normalizeNoteEntries(entries) { return (Array.isArray(entries) ? entries : []).map(item => ({ id: item.id || uuid(), text: String(item.text || '').trim(), createdAt: item.createdAt || new Date().toISOString() })).filter(item => item.text); }

  function ensureIds(state) {
    const next = clone(state || { students: [], activeId: null });
    next.students = Array.isArray(next.students) ? next.students : [];
    next.students.forEach(student => {
      student.id ||= uuid();
      student.scores = Array.isArray(student.scores) ? student.scores : [];
      student.preparations = Array.isArray(student.preparations) ? student.preparations : [];
      student.courseProgress = Array.isArray(student.courseProgress) ? student.courseProgress : [];
      student.custom = Array.isArray(student.custom) ? student.custom : [];
      if (Array.isArray(student.nextLessonEntries)) student.nextLessonEntries = normalizeNoteEntries(student.nextLessonEntries);
      if (Array.isArray(student.focusContentEntries)) student.focusContentEntries = normalizeNoteEntries(student.focusContentEntries);
      student.scores.forEach(item => item.id ||= uuid());
      student.preparations.forEach(item => item.id ||= uuid());
      student.courseProgress.forEach(item => item.id ||= uuid());
      student.custom.forEach(item => item.id ||= uuid());
      [...student.preparations, ...student.courseProgress].forEach(item => {
        item.files = Array.isArray(item.files) ? item.files : [];
        item.files.forEach(file => file.id ||= uuid());
      });
    });
    if (!next.students.some(s => s.id === next.activeId)) next.activeId = next.students[0]?.id || null;
    next.schemaVersion = 2;
    return next;
  }

  function flatten(state) {
    const records = new Map();
    const put = (entity, id, studentId, data, version = 0, deletedAt = null) => records.set(`${entity}:${id}`, {
      key: `${entity}:${id}`, entity, id, studentId: studentId || null, data: clone(data), version: Number(version || 0), deletedAt
    });
    ensureIds(state).students.forEach(student => {
      const profile = own(student, ['name', 'school', 'targetSchool', 'currentScore', 'targetScore']);
      profile.nextLesson = encodeNoteEntries(student.nextLessonEntries, student.nextLesson);
      profile.focusContent = encodeNoteEntries(student.focusContentEntries, student.focusContent);
      put('students', student.id, null, profile, student._version);
      student.scores.forEach(item => put('scores', item.id, student.id, own(item, ['label', 'date', 'score']), item._version));
      student.preparations.forEach(item => {
        put('preparations', item.id, student.id, own(item, ['title', 'content', 'date']), item._version);
        item.files.forEach(file => put('attachments', file.id, student.id, attachmentData(file, 'preparations', item.id), file._version));
      });
      student.courseProgress.forEach(item => {
        put('course_progress', item.id, student.id, own(item, ['title', 'content', 'date']), item._version);
        item.files.forEach(file => put('attachments', file.id, student.id, attachmentData(file, 'course_progress', item.id), file._version));
      });
      student.custom.forEach(item => put('custom_fields', item.id, student.id, own(item, ['key', 'value']), item._version));
    });
    return records;
  }

  function hydrate(records, activeId = null) {
    const live = [...records.values()].filter(r => !r.deletedAt);
    const students = live.filter(r => r.entity === 'students').map(r => {
      const data = clone(r.data), nextLessonEntries = decodeNoteEntries(data.nextLesson), focusContentEntries = decodeNoteEntries(data.focusContent);
      if (nextLessonEntries) { data.nextLessonEntries = normalizeNoteEntries(nextLessonEntries); data.nextLesson = ''; }
      if (focusContentEntries) { data.focusContentEntries = normalizeNoteEntries(focusContentEntries); data.focusContent = ''; }
      return { id: r.id, ...data, _version: r.version, scores: [], preparations: [], courseProgress: [], custom: [] };
    });
    const byId = new Map(students.map(s => [s.id, s]));
    const owners = new Map();
    live.forEach(r => {
      const student = byId.get(r.studentId);
      if (!student) return;
      const item = { id: r.id, ...clone(r.data), _version: r.version };
      if (r.entity === 'scores') student.scores.push(item);
      if (r.entity === 'preparations') {
        const owner = { ...item, files: [] };
        student.preparations.push(owner);
        owners.set(`preparations:${r.id}`, owner);
      }
      if (r.entity === 'course_progress') {
        const owner = { ...item, files: [] };
        student.courseProgress.push(owner);
        owners.set(`course_progress:${r.id}`, owner);
      }
      if (r.entity === 'custom_fields') student.custom.push(item);
    });
    live.filter(r => r.entity === 'attachments').forEach(r => {
      const owner = owners.get(`${r.data.ownerType}:${r.data.ownerId}`);
      if (owner) owner.files.push({ id: r.id, ...clone(r.data), _version: r.version });
    });
    return { students, activeId: byId.has(activeId) ? activeId : students[0]?.id || null, schemaVersion: 2 };
  }

  function diff(before, after) {
    const previous = before instanceof Map ? before : new Map();
    const current = after instanceof Map ? after : new Map();
    const changes = [];
    current.forEach((record, key) => {
      const old = previous.get(key);
      const changed = !old || JSON.stringify(old.data) !== JSON.stringify(record.data) || old.deletedAt !== record.deletedAt;
      if (changed) changes.push({ ...record, baseVersion: old?.version || 0, operation: record.deletedAt ? 'delete' : 'upsert' });
    });
    previous.forEach((old, key) => {
      if (!current.has(key)) changes.push({ ...old, data: clone(old.data), baseVersion: old.version || 0, operation: 'delete', deletedAt: new Date().toISOString() });
    });
    return changes;
  }

  ZX.Model = { entityOrder, clone, ensureIds, flatten, hydrate, diff, decodeNoteEntries, encodeNoteEntries, normalizeNoteEntries };
})(window);
