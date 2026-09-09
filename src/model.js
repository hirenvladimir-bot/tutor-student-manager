(function (root) {
  'use strict';
  const ZX = root.Zhixing = root.Zhixing || {};
  const entityOrder = ['students', 'scores', 'preparations', 'course_progress', 'custom_fields', 'attachments'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const uuid = () => root.crypto?.randomUUID?.() || `zx-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const own = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj?.[k] ?? (k.endsWith('Score') ? null : '')]));
  const attachmentData = (file, ownerType, ownerId) => ({ ownerType, ownerId, name: file.name || '未命名文件', relativePath: file.relativePath || '', type: file.type || 'application/octet-stream', size: Number(file.size || 0), path: file.path || '', uploadPath: file.uploadPath || '', data: file.data || '', pending: Boolean(file.pending), localBlobKey: file.localBlobKey || '' });

  function ensureIds(state) {
    const next = clone(state || { students: [], activeId: null });
    next.students = Array.isArray(next.students) ? next.students : [];
    next.students.forEach(student => {
      student.id ||= uuid();
      student.scores = Array.isArray(student.scores) ? student.scores : [];
      student.preparations = Array.isArray(student.preparations) ? student.preparations : [];
      student.courseProgress = Array.isArray(student.courseProgress) ? student.courseProgress : [];
      student.custom = Array.isArray(student.custom) ? student.custom : [];
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
      put('students', student.id, null, own(student, ['name', 'school', 'targetSchool', 'currentScore', 'targetScore', 'nextLesson', 'focusContent']), student._version);
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
    const students = live.filter(r => r.entity === 'students').map(r => ({
      id: r.id, ...clone(r.data), _version: r.version, scores: [], preparations: [], courseProgress: [], custom: []
    }));
    const byId = new Map(students.map(s => [s.id, s]));
    live.forEach(r => {
      const student = byId.get(r.studentId);
      if (!student) return;
      const item = { id: r.id, ...clone(r.data), _version: r.version };
      if (r.entity === 'scores') student.scores.push(item);
      if (r.entity === 'preparations') student.preparations.push({ ...item, files: [] });
      if (r.entity === 'course_progress') student.courseProgress.push({ ...item, files: [] });
      if (r.entity === 'custom_fields') student.custom.push(item);
    });
    live.filter(r => r.entity === 'attachments').forEach(r => {
      const student = byId.get(r.studentId);
      const list = r.data.ownerType === 'preparations' ? student?.preparations : student?.courseProgress;
      const owner = list?.find(item => item.id === r.data.ownerId);
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

  ZX.Model = { entityOrder, clone, ensureIds, flatten, hydrate, diff };
})(window);
