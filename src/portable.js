(function (root) {
  'use strict';
  const ZX = root.Zhixing = root.Zhixing || {};
  const textValue = (line, label) => {
    const match = line.match(new RegExp(`^(?:[-*]\\s*)?${label}[：:]\\s*(.*)$`));
    return match ? match[1].trim() : '';
  };
  const fileSummary = (files, bullet) => (files || []).map(file =>
    `${bullet}附件：${file.relativePath || file.name}${file.path ? `｜路径：${file.path}` : ''}｜类型：${file.type || 'application/octet-stream'}｜大小：${Number(file.size || 0)}`
  ).join('\n');

  function studentText(student, plain = false) {
    const bullet = plain ? '' : '- ';
    const records = (items, fallback) => (items || []).map(item =>
      `${bullet}${item.date}：${item.title || item.text}${item.content ? `（${item.content}）` : ''}\n${fileSummary(item.files, bullet)}`
    ).join('\n') || `${bullet}${fallback}`;
    const scores = (student.scores || []).map(item => plain
      ? `${item.date}｜${item.label}｜${item.score}`
      : `| ${item.date} | ${item.label} | ${item.score} |`
    ).join('\n') || `${bullet}暂无`;
    const custom = (student.custom || []).map(item => `${bullet}${item.key}：${item.value}`).join('\n') || `${bullet}暂无`;
    return `${plain ? '学生：' : '## '}${student.name}\n${bullet}就读学校：${student.school || ''}\n${bullet}目标学校：${student.targetSchool || ''}\n${bullet}目前分数：${student.currentScore ?? ''}\n${bullet}目标分数：${student.targetScore ?? ''}\n\n${plain ? '考试成绩：' : '### 考试成绩'}\n${plain ? '日期｜考试｜分数\n' : ''}${scores}\n\n${plain ? '备课记录：' : '### 备课记录'}\n${records(student.preparations, '暂无')}\n\n${plain ? '课程进度：' : '### 课程进度'}\n${records(student.courseProgress, '暂无')}\n\n${plain ? '教学备忘：' : '### 教学备忘'}\n${bullet}下节课要讲的内容：${student.nextLesson || ''}\n${bullet}着重要听的内容：${student.focusContent || ''}\n\n${plain ? '其他信息：' : '### 其他信息'}\n${custom}`;
  }

  function encode(state) {
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 2, ...state }));
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  function markdown(state, plain = false) {
    const header = plain
      ? `知行家教学生档案\n导出日期：${new Date().toLocaleString('zh-CN')}`
      : `# 知行家教学生档案\n\n> 导出日期：${new Date().toLocaleString('zh-CN')}`;
    return `${header}\n\n${(state.students || []).map(student => studentText(student, plain)).join('\n\n---\n\n')}\n\n[[ZHIXING_V2:${encode(state)}]]\n`;
  }

  function parse(text) {
    const encoded = text.match(/\[\[ZHIXING_V2:([A-Za-z0-9+/=]+)\]\]/)?.[1];
    if (encoded) {
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    const blocks = text.split(/(?:^|\n)(?:##\s+|学生[：:])/).slice(1);
    const students = blocks.map(block => {
      const lines = block.split('\n').map(value => value.trim()).filter(Boolean);
      const student = { id: root.crypto.randomUUID(), name: (lines.shift() || '未命名学生').replace(/^#+\s*/, '').trim(), school: '', targetSchool: '', currentScore: null, targetScore: null, scores: [], custom: [], courseProgress: [], preparations: [], nextLesson: '', focusContent: '' };
      let section = 'profile', lastRecord = null;
      const addRecord = (list, clean) => {
        const match = clean.match(/^(.+?)[：:]\s*(.*)$/), date = match?.[1] || '', raw = match?.[2] || clean;
        const detail = raw.match(/^(.*)（([^（）]*)）$/);
        const item = { date, title: (detail?.[1] || raw).trim(), content: (detail?.[2] || '').trim(), files: [] };
        list.push(item); lastRecord = item;
      };
      for (const line of lines) {
        if (/^###\s*考试成绩|^考试成绩[：:]?$/.test(line)) { section = 'scores'; lastRecord = null; continue; }
        if (/^###\s*备课记录|^备课记录[：:]?$/.test(line)) { section = 'preparations'; lastRecord = null; continue; }
        if (/^###\s*课程进度|^课程进度[：:]?$/.test(line)) { section = 'course'; lastRecord = null; continue; }
        if (/^###\s*教学备忘|^教学备忘[：:]?$/.test(line)) { section = 'notes'; lastRecord = null; continue; }
        if (/^###\s*其他信息|^其他信息[：:]?$/.test(line)) { section = 'custom'; lastRecord = null; continue; }
        const clean = line.replace(/^[-*]\s*/, '');
        if (clean === '---' || clean === '暂无') continue;
        if (clean.startsWith('附件：') || clean.startsWith('附件:')) {
          if (!lastRecord) continue;
          const parts = textValue(clean, '附件').split('｜').map(value => value.trim()).filter(Boolean), display = parts.shift() || '未命名文件';
          const metadata = { path: '', type: 'application/octet-stream', size: 0 };
          for (const part of parts) {
            if (/^路径[：:]/.test(part)) metadata.path = part.replace(/^路径[：:]\s*/, '');
            else if (/^类型[：:]/.test(part)) metadata.type = part.replace(/^类型[：:]\s*/, '') || metadata.type;
            else if (/^大小[：:]/.test(part)) metadata.size = Number(part.replace(/^大小[：:]\s*/, '')) || 0;
            else if (!metadata.path) metadata.path = part;
          }
          lastRecord.files.push({ name: display.split(/[\\/]/).pop() || display, relativePath: display, ...metadata });
          continue;
        }
        if (section === 'scores' && clean.includes('｜')) {
          const [date, label, score] = clean.split('｜').map(value => value.trim());
          if (date && label && !Number.isNaN(Number(score))) student.scores.push({ date, label, score: +score });
          continue;
        }
        if (section === 'scores' && /^\|/.test(clean)) {
          const cells = clean.split('|').map(value => value.trim()).filter(Boolean);
          if (cells.length >= 3 && !Number.isNaN(Number(cells[2]))) student.scores.push({ date: cells[0], label: cells[1], score: +cells[2] });
          continue;
        }
        if (section === 'preparations') { addRecord(student.preparations, clean); continue; }
        if (section === 'course') { addRecord(student.courseProgress, clean); continue; }
        const pairs = [['就读学校', 'school'], ['目标学校', 'targetSchool'], ['目前分数', 'currentScore'], ['目标分数', 'targetScore'], ['下节课要讲的内容', 'nextLesson'], ['着重要听的内容', 'focusContent']];
        let matched = false;
        for (const [label, key] of pairs) {
          const value = textValue(clean, label);
          if (value !== '' || clean.startsWith(`${label}：`) || clean.startsWith(`${label}:`)) {
            student[key] = key.includes('Score') ? (value || null) : value; matched = true; break;
          }
        }
        if (section === 'custom' && !matched) {
          const match = clean.match(/^(.+?)[：:]\s*(.+)$/);
          if (match) student.custom.push({ key: match[1], value: match[2] });
        }
      }
      return student;
    }).filter(student => student.name && student.name !== '未命名学生');
    if (!students.length) throw new Error('未识别到学生档案；请使用本应用导出的 Markdown 或文字文件');
    return { students, activeId: students[0].id };
  }

  function json(state) {
    return JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), ...state }, null, 2);
  }

  ZX.Portable = { markdown, parse, json };
})(window);
