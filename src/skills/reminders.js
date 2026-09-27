// Таймеры и напоминания — один навык: «через 10 минут» (таймер), «завтра в 9», «каждый день в 8», «каждый час».
// Сработавшее: голос, звуковой сигнал и уведомление Windows.
// Напоминания на время хранятся в reminders.json и переживают перезапуск; пропущенные, пока приложение
// было закрыто, звучат при старте. Таймеры «через N» живут до перезапуска.
const { createStore } = require('../lib/store');
const { durationFromText } = require('../lib/ru');

// --- таймеры «через N» ---

const timers = new Set();

function setTimer(arg, ctx) {
  if (/^\s*(cancel|отмен)/i.test(arg)) {
    const n = timers.size;
    timers.forEach(clearTimeout);
    timers.clear();
    return { ok: true, message: n ? 'Все таймеры отменены, сэр.' : 'Активных таймеров нет, сэр.' };
  }
  // "600|текст" или просто "600"
  const m = arg.match(/^\s*(\d+)\s*(?:\|\s*([\s\S]*))?$/);
  if (!m) return { ok: false, message: 'Не понял, на сколько поставить таймер, сэр.' };
  const seconds = Number(m[1]);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86_400) {
    return { ok: false, message: 'Таймер можно поставить от секунды до суток, сэр.' };
  }
  const text = (m[2] || '').trim().slice(0, 200) || 'время вышло';
  const id = setTimeout(() => {
    timers.delete(id);
    ctx.audit({ reminder: text });
    ctx.remind(text);
  }, seconds * 1000);
  timers.add(id);
  return { ok: true };
}

// --- напоминания на время и дату ---

let store = createStore(null, '', { items: [] });
let ticker = null;
const CHECK_MS = 15_000;
const QUIET = { from: 23, to: 8 }; // «каждые N минут» ночью молчат

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayName = (d) => {
  const today = new Date();
  const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - today.setHours(0, 0, 0, 0)) / 86_400_000);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  if (diff === 2) return 'послезавтра';
  return new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
};
const when = (r) => (r.every ? `каждые ${r.every} мин` : `${r.daily ? 'каждый день' : dayName(r.at)} в ${hhmm(new Date(r.at))}`);

// "2026-10-01 09:30|текст", "09:30|текст", "daily 09:00|текст", "every 60|текст"
function parse(arg, now = new Date()) {
  const [spec, ...rest] = String(arg).split('|');
  const text = rest.join('|').trim().slice(0, 200) || 'напоминание';
  const s = spec.trim().toLowerCase();
  const every = s.match(/^(?:every|каждые?)\s+(\d+)/);
  if (every) {
    const min = Number(every[1]);
    if (min < 5 || min > 24 * 60) return { error: 'Повторять можно от 5 минут до суток, сэр.' };
    return { text, every: min, at: now.getTime() + min * 60_000 };
  }
  const daily = /^(daily|каждый день)/.test(s);
  const m = s.match(/(?:(\d{4})-(\d{2})-(\d{2})\s+)?(\d{1,2})[:.](\d{2})/);
  if (!m) return { error: 'Не понял, на какое время поставить напоминание, сэр.' };
  const [, y, mo, d, h, mi] = m.map((x) => (x === undefined ? x : Number(x)));
  if (h > 23 || mi > 59) return { error: 'Такого времени не бывает, сэр.' };
  const shift = /^(tomorrow|завтра)/.test(s) ? 1 : /^(after tomorrow|послезавтра)/.test(s) ? 2 : 0;
  const at = y ? new Date(y, mo - 1, d, h, mi) : new Date(now.getFullYear(), now.getMonth(), now.getDate() + shift, h, mi);
  if (Number.isNaN(at.getTime())) return { error: 'Не понял дату, сэр.' };
  if (at <= now) {
    if ((y || shift) && !daily) return { error: 'Это время уже прошло, сэр.' };
    at.setDate(at.getDate() + 1); // «в 9:00», а сейчас 10 — значит, завтра
  }
  return { text, daily, at: at.getTime() };
}

function add(arg) {
  const r = parse(arg);
  if (r.error) return { ok: false, message: r.error };
  const items = store.get().items;
  const id = items.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  items.push({ id, ...r });
  store.save();
  return { ok: true, speak: `Напомню ${when(r)}: ${r.text}.` };
}

// Ближайшие напоминания (для сводки на день)
const upcoming = (hours = 24) =>
  store
    .get()
    .items.filter((r) => !r.every && r.at - Date.now() < hours * 3_600_000)
    .sort((a, b) => a.at - b.at);

function list(arg) {
  const a = String(arg).trim().toLowerCase();
  const items = store.get().items;
  if (/^(cancel|отмен|удал)/.test(a)) {
    const what = a.replace(/^\S+\s*/, '');
    const all = !what || /^(все|всё|all)$/.test(what);
    const keep = items.filter((r) => !all && !r.text.toLowerCase().includes(what));
    const removed = items.length - keep.length;
    store.save({ items: keep });
    return removed ? { ok: true, speak: `Отменил: ${removed}.` } : { ok: false, message: 'Не нашёл такого напоминания, сэр.' };
  }
  if (!items.length) return { ok: true, speak: 'Напоминаний нет, сэр.' };
  const sorted = [...items].sort((x, y) => x.at - y.at).slice(0, 6);
  return { ok: true, speak: `Напоминания: ${sorted.map((r) => `${when(r)} — ${r.text}`).join('; ')}.` };
}

function tick(ctx) {
  const now = Date.now();
  const data = store.get();
  let changed = false;
  for (const r of [...data.items]) {
    if (r.at > now) continue;
    changed = true;
    const late = now - r.at > 10 * 60_000;
    const hour = new Date().getHours();
    const quiet = r.every && (hour >= QUIET.from || hour < QUIET.to);
    if (!quiet && !(r.every && late)) ctx.remind(late ? `Пропущенное напоминание: ${r.text}` : r.text);
    ctx.audit({ reminder: r.text, late });
    if (r.every) r.at = now + r.every * 60_000;
    else if (r.daily) while (r.at <= now) r.at += 86_400_000;
    else data.items.splice(data.items.indexOf(r), 1);
  }
  if (changed) store.save();
}

module.exports = {
  id: 'reminders',
  title: 'таймер «через N минут», напоминания на время и дату, каждый день, каждые N минут; список и «отмени напоминание»',
  keywords: [
    'таймер', 'засеки', 'напомн', 'напомин', 'будильник', 'разбуди', 'каждый день', 'каждые', 'каждый час',
    /в \d{1,2}[:.]?\d{0,2}/, 'завтра в', 'утром', 'вечером', 'напомни через',
    (text) => /через/.test(text) && durationFromText(text) !== null, // «через 10 минут» — с длительностью
  ],
  rules: [
    'Напоминание через N минут — timer; на конкретное время или дату, или повторяющееся — remind_at (дату считай от текущей).',
    'reminders "cancel …" — только если прямо просят отменить напоминание; «забудь про …» — это память (forget).',
  ],
  tools: [
    {
      name: 'timer',
      use: 'таймер или напоминание через какое-то время',
      arg: '"СЕКУНДЫ|текст напоминания" (минуты переводи в секунды) или "cancel" — отменить все',
      examples: [
        [
          'напомни через 10 минут выключить чайник',
          { addressed: true, say: 'Напомню через 10 минут, сэр.', actions: [{ tool: 'timer', arg: '600|выключить чайник' }] },
        ],
      ],
      // Секунды — из самой фразы, если длительность в ней названа («через 10 минут» → 600), текст — от модели
      normalize: (arg, text) => {
        const sec = durationFromText(text);
        return sec && /^\s*\d+\s*(\||$)/.test(arg) ? arg.replace(/^\s*\d+/, String(sec)) : arg;
      },
      run: async (arg, ctx) => setTimer(arg, ctx),
    },
    {
      name: 'remind_at',
      use: 'напоминание на время или дату; повторяющееся',
      arg: '"ЧЧ:ММ|текст" (ближайшее), "tomorrow ЧЧ:ММ|текст", "ГГГГ-ММ-ДД ЧЧ:ММ|текст", "daily ЧЧ:ММ|текст", "every МИНУТЫ|текст"',
      examples: [
        ['напомни завтра в 9 позвонить маме', { addressed: true, say: '', actions: [{ tool: 'remind_at', arg: 'tomorrow 09:00|позвонить маме' }] }],
        ['напоминай пить воду каждый час', { addressed: true, say: '', actions: [{ tool: 'remind_at', arg: 'every 60|выпить воды' }] }],
      ],
      run: async (arg) => add(arg),
    },
    {
      name: 'reminders',
      use: 'какие есть напоминания; отменить напоминание',
      arg: 'пусто — список; "cancel текст" — отменить похожее; "cancel все"',
      run: async (arg, ctx, request = {}) => {
        // «Забудь про стоматолога» без слова «напоминание» — сначала память (модель путала их).
        // Только при вызове от модели (depth 0): forget сам заглядывает сюда, круга не будет
        const text = String(request.text || '');
        if (!ctx.depth && /^(cancel|отмен|удал)/i.test(arg) && /забуд|забыть/i.test(text) && !/напомин/i.test(text)) {
          const r = await ctx.call('forget', arg.replace(/^\S+\s*/, ''));
          if (r?.ok) return r;
        }
        return list(arg);
      },
    },
  ],
  init(ctx) {
    store = createStore(ctx.dataDir, 'reminders.json', { items: [] });
    clearInterval(ticker);
    if (!ctx.dataDir) return; // в тестах не тикаем
    ticker = setInterval(() => tick(ctx), CHECK_MS);
    ticker.unref?.();
    setTimeout(() => tick(ctx), 5000).unref?.(); // пропущенные — вскоре после старта
  },
  parse,
  upcoming,
  when,
  pending: () => timers.size,
  _reset: () => (store = createStore(null, '', { items: [] })),
};
