// День из речи для будильника и напоминаний: «завтра», «послезавтра», «в субботу», «в следующий вторник»,
// «пятого октября», «двадцать пятого декабря», «25-го»; повторы — «каждый день», «по будням», «по выходным»,
// «по понедельникам», «каждую среду и пятницу».
// dayOf(text, clock?, now?) → { spec, rest } или null (день не назван):
//   spec — начало аргумента навыка напоминаний: 'tomorrow ', 'after tomorrow ', '2026-10-17 ', 'daily ',
//          'weekdays ', 'weekends ', 'weekly 1,3 ' (дни недели: 0 — воскресенье … 6 — суббота);
//   rest — фраза без слов о дне (чтобы «5 октября» не стало временем «5:00»).
// clock { h, m } — время, если уже известно: «в субботу в 9», а сегодня суббота 10:00 — значит, следующая.
const { wordsToNumber } = require('./ru');

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
// Основы дней недели → номер дня (Date.getDay): «понедельник», «во вторник», «в среду», «по пятницам»
const WEEKDAYS = [
  [/^воскресень/, 0],
  [/^понедельник/, 1],
  [/^вторник/, 2],
  [/^сред/, 3],
  [/^четверг/, 4],
  [/^пятниц/, 5],
  [/^суббот/, 6],
];
const ORDINAL = {
  первого: 1,
  второго: 2,
  третьего: 3,
  четвертого: 4,
  пятого: 5,
  шестого: 6,
  седьмого: 7,
  восьмого: 8,
  девятого: 9,
  десятого: 10,
  одиннадцатого: 11,
  двенадцатого: 12,
  тринадцатого: 13,
  четырнадцатого: 14,
  пятнадцатого: 15,
  шестнадцатого: 16,
  семнадцатого: 17,
  восемнадцатого: 18,
  девятнадцатого: 19,
  двадцатого: 20,
  тридцатого: 30,
};
const TENS = { двадцать: 20, тридцать: 30 };

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `;
const weekdayOf = (w) => WEEKDAYS.find(([re]) => re.test(w))?.[1];

// «пятого», «двадцать пятого», «5», «5-го» → число; [день, сколько слов]
function dayNumber(words, i) {
  const w = words[i] || '';
  const digits = w.match(/^(\d{1,2})(?:-?го)?$/);
  if (digits) return [Number(digits[1]), 1];
  if (w in TENS && words[i + 1] in ORDINAL && ORDINAL[words[i + 1]] < 10) return [TENS[w] + ORDINAL[words[i + 1]], 2];
  if (w in ORDINAL) return [ORDINAL[w], 1];
  return null;
}

function dayOf(text, clock = null, now = new Date()) {
  const t = String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[?!.,;:«»"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = t.split(' ');
  const cut = (re) => t.replace(re, ' ').replace(/\s+/g, ' ').trim();
  const at = (date) => {
    const d = new Date(date);
    if (clock) d.setHours(clock.h, clock.m, 0, 0);
    return d;
  };

  // Повторы
  if (/каждый день|ежедневно|каждое утро|каждый вечер/.test(t))
    return { spec: 'daily ', rest: cut(/каждый день|ежедневно|каждое утро|каждый вечер/) };
  if (/по будням|в будни|по рабочим(?: дням)?|в рабочие дни/.test(t))
    return { spec: 'weekdays ', rest: cut(/по будням|в будни|по рабочим(?: дням)?|в рабочие дни/) };
  if (/по выходным|в выходные|по субботам и воскресеньям/.test(t))
    return { spec: 'weekends ', rest: cut(/по выходным|в выходные|по субботам и воскресеньям/) };
  const repeatDays = [];
  for (const m of t.matchAll(/(?:по|кажд(?:ый|ую|ое))\s+([а-я]+)(?:\s+и\s+([а-я]+))?/g))
    for (const w of [m[1], m[2]]) {
      const d = w && weekdayOf(w.replace(/ам$/, ''));
      if (d !== undefined && !repeatDays.includes(d)) repeatDays.push(d);
    }
  if (repeatDays.length)
    return {
      spec: `weekly ${repeatDays.sort().join(',')} `,
      rest: cut(/(?:по|кажд(?:ый|ую|ое))\s+[а-я]+(?:\s+и\s+[а-я]+)?/g),
    };

  // Один день
  if (/(^|\s)послезавтра(\s|$)/.test(t)) return { spec: 'after tomorrow ', rest: cut(/послезавтра/) };
  if (/(^|\s)завтра(\s|$)/.test(t)) return { spec: 'tomorrow ', rest: cut(/завтра/) };
  if (/(^|\s)сегодня(\s|$)/.test(t)) return { spec: '', rest: cut(/сегодня/) };

  // «в субботу», «в следующий вторник», «в эту пятницу»
  const wd = t.match(/(?:^|\s)(?:в|во|на)\s+(?:(следующ[а-я]*|эт[а-я]*|ближайш[а-я]*)\s+)?([а-я]+)/g);
  for (const m of wd || []) {
    const parts = m.trim().split(' ');
    const day = weekdayOf(parts[parts.length - 1]);
    if (day === undefined) continue;
    const next = /следующ/.test(m);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let ahead = (day - now.getDay() + 7) % 7;
    if (next && ahead === 0) ahead = 7;
    d.setDate(d.getDate() + ahead);
    if (ahead === 0 && clock && at(d) <= now) d.setDate(d.getDate() + 7); // сегодня этот день, но время прошло
    return { spec: iso(d), rest: cut(new RegExp(m.trim())) };
  }

  // «пятого октября», «25 декабря», «двадцать пятого декабря 2027 года»
  const mi = words.findIndex((w) => MONTHS.includes(w));
  if (mi > 0) {
    const n = dayNumber(words, mi - 2)?.[1] === 2 ? dayNumber(words, mi - 2) : dayNumber(words, mi - 1);
    if (n && n[0] >= 1 && n[0] <= 31) {
      const yearWord = words[mi + 1]?.match(/^(\d{4})$/)?.[1];
      let d = new Date(yearWord ? Number(yearWord) : now.getFullYear(), MONTHS.indexOf(words[mi]), n[0]);
      if (d.getDate() !== n[0]) return null; // 31 июня
      if (!yearWord && at(d) < new Date(now.getFullYear(), now.getMonth(), now.getDate()))
        d = new Date(d.getFullYear() + 1, d.getMonth(), n[0]);
      const span = words.slice(mi - n[1], mi + 1 + (yearWord ? 1 : 0)).join(' ');
      return { spec: iso(d), rest: cut(new RegExp(`(?:^|\\s)${span}(?:\\s+года?)?`)) };
    }
  }
  // «двадцать пятого» / «25-го» без месяца — этого месяца, а если прошло — следующего
  const lone = words.findIndex((w, i) => /^\d{1,2}-?го$/.test(w) || (w in ORDINAL && words[i - 1] !== 'половине'));
  if (lone >= 0 && /(^|\s)(?:на|к)?\s*\S*$/.test(t)) {
    const n = dayNumber(words, lone - 1)?.[1] === 2 ? dayNumber(words, lone - 1) : dayNumber(words, lone);
    if (n && n[0] <= 31 && !/половин|четверт|минут/.test(t)) {
      let d = new Date(now.getFullYear(), now.getMonth(), n[0]);
      if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d = new Date(now.getFullYear(), now.getMonth() + 1, n[0]);
      if (d.getDate() === n[0]) return { spec: iso(d), rest: cut(new RegExp(words.slice(lone - (n[1] - 1), lone + 1).join(' '))) };
    }
  }
  return null;
}

// «через неделю», «через два дня» — тоже день; число — wordsToNumber
function daysAhead(text) {
  const m = String(text).match(/через (\d+|[а-я]+)? ?(день|дня|дней|неделю|недели)/);
  if (!m) return null;
  const n = m[1] ? (/^\d+$/.test(m[1]) ? Number(m[1]) : wordsToNumber(m[1])) : 1;
  return n ? n * (/недел/.test(m[2]) ? 7 : 1) : null;
}

module.exports = { dayOf, daysAhead, weekdayOf };
