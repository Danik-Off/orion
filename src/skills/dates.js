// Время и даты: «который час» — мгновенно без модели; сколько дней до даты, день недели, ближайшие праздники.
const { plural } = require('../lib/ru');

// Праздники и памятные дни [месяц, день, название]; День программиста — 256-й день года
const HOLIDAYS = [
  [1, 1, 'Новый год'],
  [1, 7, 'Рождество Христово'],
  [1, 25, 'Татьянин день'],
  [2, 14, 'День святого Валентина'],
  [2, 23, 'День защитника Отечества'],
  [3, 8, 'Международный женский день'],
  [4, 1, 'День смеха'],
  [4, 12, 'День космонавтики'],
  [5, 1, 'Праздник Весны и Труда'],
  [5, 9, 'День Победы'],
  [6, 1, 'День защиты детей'],
  [6, 12, 'День России'],
  [7, 8, 'День семьи, любви и верности'],
  [8, 22, 'День Государственного флага'],
  [9, 1, 'День знаний'],
  [10, 5, 'День учителя'],
  [11, 4, 'День народного единства'],
  [12, 12, 'День Конституции'],
  [12, 31, 'Новогодний вечер'],
];
const programmersDay = (y) => new Date(y, 0, 256);

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86_400_000);
const daysWord = (n) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;
const longDate = (d) => d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const weekday = (d) => d.toLocaleDateString('ru-RU', { weekday: 'long' });

function holidaysOfYear(y) {
  return [
    ...HOLIDAYS.map(([m, d, name]) => ({ date: new Date(y, m - 1, d), name })),
    { date: programmersDay(y), name: 'День программиста' },
  ].sort((a, b) => a.date - b.date);
}

function holidays(from = new Date(), count = 3) {
  const today = startOfDay(from);
  return [...holidaysOfYear(today.getFullYear()), ...holidaysOfYear(today.getFullYear() + 1)]
    .filter((h) => h.date >= today)
    .slice(0, count);
}

// "2026-12-31" → дата; "12-31" / "31.12" → ближайшая такая
function parseDate(s, now = new Date()) {
  const iso = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return new Date(+iso[1], iso[2] - 1, +iso[3]);
  const md = s.match(/(\d{1,2})[.-](\d{1,2})/);
  if (!md) return null;
  const [day, month] = s.includes('.') ? [+md[1], +md[2]] : [+md[2], +md[1]];
  let d = new Date(now.getFullYear(), month - 1, day);
  if (startOfDay(d) < startOfDay(now)) d = new Date(now.getFullYear() + 1, month - 1, day);
  return d;
}

// arg: "until 2026-12-31" | "weekday 2026-10-05" | "holidays" | "today"
function dateInfo(arg, now = new Date()) {
  const a = String(arg).trim().toLowerCase();
  if (!a || /^(today|сегодня)/.test(a)) {
    const h = holidays(now, 1)[0];
    const todayHoliday = h && daysBetween(now, h.date) === 0 ? ` Сегодня ${h.name}.` : '';
    return `Сегодня ${weekday(now)}, ${longDate(now)} ${now.getFullYear()} года.${todayHoliday}`;
  }
  if (/^(holiday|праздн)/.test(a)) {
    const list = holidays(now, 3).map((h) => {
      const n = daysBetween(now, h.date);
      return `${h.name} — ${n === 0 ? 'сегодня' : n === 1 ? 'завтра' : `${longDate(h.date)}, через ${daysWord(n)}`}`;
    });
    return `Ближайшие праздники: ${list.join('; ')}.`;
  }
  const date = parseDate(a, now);
  if (!date || Number.isNaN(date.getTime())) return null;
  if (/^(weekday|день недели)/.test(a)) return `${longDate(date)} ${date.getFullYear()} года — ${weekday(date)}.`;
  const n = daysBetween(now, date);
  if (n === 0) return `Это сегодня.`;
  return n > 0 ? `До ${longDate(date)} осталось ${daysWord(n)}, это ${weekday(date)}.` : `С ${longDate(date)} прошло ${daysWord(-n)}.`;
}

function timeNow(now = new Date()) {
  const h = now.getHours();
  const m = now.getMinutes();
  return `Сейчас ${h}:${String(m).padStart(2, '0')}.`;
}

// «который час», «сколько времени», «какое сегодня число», «какой сегодня день» — мгновенно
function quick(text) {
  const t = text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-я ]+/g, '')
    .trim();
  if (/^(который час|сколько (сейчас )?времени|сколько время|скажи (который час|время))$/.test(t)) {
    return { addressed: true, say: timeNow(), actions: [] };
  }
  if (/^(какое|какой) (сегодня|сейчас) (число|день( недели)?|дата)$|^какое число$/.test(t)) {
    return { addressed: true, say: dateInfo('today'), actions: [] };
  }
  // «сколько дней до нового года», «сколько осталось до 8 марта» — праздник по названию или «8 марта»
  const until = text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .match(/^сколько (?:дней |времени )?(?:осталось )?до (.+?)[?.!]*$/);
  if (until) {
    const date = holidayDate(until[1]);
    if (date) return { addressed: true, say: '', actions: [{ tool: 'date_info', arg: `until ${date}` }] };
  }
  return null;
}

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
const pad = (n) => String(n).padStart(2, '0');
// «нового года» → "01-01", «8 марта» → "03-08", «дня победы» → "05-09"
function holidayDate(phrase) {
  const t = phrase.trim();
  if (/рождени/.test(t)) return null; // день рождения — не Рождество: пусть ответит модель по памяти
  if (/программист/.test(t)) {
    const d = programmersDay(new Date().getFullYear());
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const dm = t.match(/^(\d{1,2}) ([а-я]+)/);
  if (dm) {
    const m = MONTHS.findIndex((x) => dm[2].startsWith(x));
    if (m >= 0) return `${pad(m + 1)}-${pad(dm[1])}`;
  }
  const stems = t
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^(день|дня|дню|днем)$/.test(w))
    .map((w) => w.slice(0, 3));
  if (!stems.length) return null;
  const found = HOLIDAYS.find(([, , name]) => {
    const words = name.toLowerCase().replace(/ё/g, 'е').split(/\s+/);
    return stems.every((s) => words.some((w) => w.startsWith(s)));
  });
  return found ? `${pad(found[0])}-${pad(found[1])}` : null;
}

module.exports = {
  id: 'dates',
  needs: ['now'],
  title: 'сколько дней до даты, день недели для даты, ближайшие праздники',
  keywords: ['сколько дней', 'через сколько', 'день недели', 'праздник', 'какое число', 'какой день', 'дней до', 'осталось до'],
  quick,
  tools: [
    {
      name: 'date_info',

      llmArg: true,
      speaks: true, // ответ всегда даёт сам инструмент
      use: 'сколько дней до даты или с даты, какой день недели, ближайшие праздники',
      arg: '"until ГГГГ-ММ-ДД" | "weekday ГГГГ-ММ-ДД" | "holidays" | "today"',
      examples: [['сколько дней до нового года', { addressed: true, say: '', actions: [{ tool: 'date_info', arg: 'until 01-01' }] }]],
      // Голая дата «2026-10-05»: день недели или сколько осталось — видно по фразе
      normalize: (arg, text) =>
        /^\d{4}-\d{2}-\d{2}$/.test(arg.trim()) ? `${/день недели/i.test(text) ? 'weekday' : 'until'} ${arg.trim()}` : arg,
      run: async (arg) => {
        const speak = dateInfo(arg);
        return speak ? { ok: true, speak } : { ok: false, message: 'Не понял дату, сэр.' };
      },
    },
  ],
  dateInfo,
  holidays,
};
