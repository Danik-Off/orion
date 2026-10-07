// Что нового в версии — из папки update/ в корне проекта: по файлу на версию, update/<версия>.md.
// Тот же файл — описание релиза на GitHub (release.yml), его же Орион зачитывает голосом (навык updates).
//
// Формат (подробно — update/README.md):
//   # 0.4.0 — 2026-10-07          заголовок: версия и дата
//   Вводная строка — по желанию.
//   - Пункт: одна законченная фраза, как её сказать вслух.
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', 'update'); // в установленной версии — внутри app.asar
const VERSION_FILE = /^(\d+\.\d+\.\d+)\.md$/;

// «0.10.0» > «0.9.1»
function compare(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// Markdown → { version, date, intro, items } — разметка (**, `, ссылки) снимается: это текст для голоса
function parse(text, version = '') {
  const plain = (s) =>
    s
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const lines = String(text).split(/\r?\n/);
  const head = lines.find((l) => /^#\s/.test(l)) || '';
  const date = head.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
  const items = [];
  const intro = [];
  for (const line of lines) {
    if (/^#/.test(line) || !line.trim()) continue;
    const item = line.match(/^\s*[-*]\s+(.+)/);
    if (item) items.push(plain(item[1]));
    else if (items.length) items[items.length - 1] += ` ${plain(line)}`; // перенос строки внутри пункта
    else intro.push(plain(line));
  }
  return { version: version || head.match(/\d+\.\d+\.\d+/)?.[0] || '', date, intro: intro.join(' '), items };
}

// Версии, для которых есть описание, — от новой к старой
function versions(dir = DIR) {
  try {
    return fs
      .readdirSync(dir)
      .map((f) => f.match(VERSION_FILE)?.[1])
      .filter(Boolean)
      .sort((a, b) => compare(b, a));
  } catch {
    return [];
  }
}

function read(version, dir = DIR) {
  try {
    return parse(fs.readFileSync(path.join(dir, `${version}.md`), 'utf8'), version);
  } catch {
    return null;
  }
}

// Всё, что вышло после from (не включая) и до to (включая): обновились через несколько версий — рассказать про все
const between = (from, to, dir = DIR) =>
  versions(dir)
    .filter((v) => compare(v, to) <= 0 && (!from || compare(v, from) > 0))
    .map((v) => read(v, dir))
    .filter(Boolean);

// Для голоса: «В версии 0.4.0: …» — не больше limit пунктов на версию, остальное — «и ещё N»
function spoken(list, { limit = 10 } = {}) {
  const notes = Array.isArray(list) ? list : [list];
  return notes
    .filter((n) => n && (n.items.length || n.intro))
    .map((n) => {
      const items = n.items.slice(0, limit).map((s) => (/[.!?…]$/.test(s) ? s : `${s}.`));
      const rest = n.items.length - items.length;
      const tail = rest > 0 ? ` И ещё ${rest} — подробнее в описании версии.` : '';
      return [`В версии ${n.version}:`, n.intro, ...items].filter(Boolean).join(' ') + tail;
    })
    .join(' ');
}

module.exports = { DIR, compare, parse, versions, read, between, spoken };
