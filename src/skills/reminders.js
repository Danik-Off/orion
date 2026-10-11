// Таймеры, напоминания и будильник — один навык: «через 10 минут» (таймер), «завтра в 9», «каждый день в 8»,
// «каждый час»; будильник — «разбуди меня в семь (под радио Маяк)», «по будням», звенит, пока не выключат.
// Сработавшее: голос, звуковой сигнал и уведомление Windows.
// Напоминания на время хранятся в reminders.json и переживают перезапуск; пропущенные, пока приложение
// было закрыто, звучат при старте. Таймеры «через N» тоже сохраняются (timers.json): после перезапуска или
// обновления они идут дальше, а истёкшие за это время — звучат как пропущенные.
const { createStore } = require('../lib/store');
const { durationFromText, plural } = require('../lib/ru');
const { parseClock, formatClock } = require('../lib/clock');
const { dayOf } = require('../lib/days');

// --- таймеры «через N» ---

// «10 минут», «час», «1 час 30 минут», «45 секунд» — для ответа голосом
function span(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const part = (n, one, few, many, single) => (n === 1 && single ? single : `${n} ${plural(n, one, few, many)}`);
  const out = [];
  if (h) out.push(part(h, 'час', 'часа', 'часов', 'час'));
  if (m) out.push(part(m, 'минуту', 'минуты', 'минут', h ? '' : 'минуту'));
  if (s && !h) out.push(part(s, 'секунду', 'секунды', 'секунд', m ? '' : 'секунду'));
  return out.join(' ');
}

// id ('t1', 't2'…) → { handle, at, text }: время и подпись нужны окну (полоска «Запланировано», карточка)
const timers = new Map();
let timerSeq = 0;
let onChange = () => {}; // окно узнаёт, что список запланированного изменился (init → ctx.onSchedule)
let timerStore = null; // timers.json: { items: [{ id, at, text }] } — переживают перезапуск

const isPlain = (text) => /^(время вышло|таймер)$/.test(text);
function saveTimers() {
  timerStore?.save({ items: [...timers].map(([id, t]) => ({ id, at: t.at, text: t.text })) });
}
// Завести (или восстановить после перезапуска) таймер до момента at
function startTimer(id, at, text, ctx) {
  const handle = setTimeout(
    () => {
      timers.delete(id);
      saveTimers();
      onChange();
      ctx.audit({ reminder: text });
      ctx.remind(isPlain(text) ? 'Время вышло.' : text);
    },
    Math.max(0, at - Date.now()),
  );
  handle.unref?.(); // приложение и так живёт в трее; без unref таймер держал бы процесс тестов
  timers.set(id, { handle, at, text });
}
// Таймеры по подписи: «отмени таймер для пасты» → тот, где «паста»; пусто или «все» — все
function timersMatching(what) {
  const w = String(what || '')
    .toLowerCase()
    .replace(/^(?:все|всё|all|таймер[ыа]?|для|на)\s*/g, '')
    .trim();
  if (!w) return [...timers.keys()];
  const stem = w.slice(0, Math.max(3, w.length - 2)); // «пасты» → «пас»: подпись могла быть в другом падеже
  return [...timers].filter(([, t]) => t.text.toLowerCase().includes(stem)).map(([id]) => id);
}

function setTimer(arg, ctx) {
  const cancelArg = String(arg).match(/^\s*(?:cancel|отмен\S*)\s*(.*)$/i);
  if (cancelArg) {
    if (!timers.size) return { ok: true, message: 'Активных таймеров нет, сэр.' };
    const ids = timersMatching(cancelArg[1]);
    if (!ids.length) return { ok: false, message: 'Не нашёл такого таймера, сэр.' };
    for (const id of ids) {
      clearTimeout(timers.get(id).handle);
      timers.delete(id);
    }
    saveTimers();
    onChange();
    const all = ids.length > 1 || !cancelArg[1].trim() || /^(все|всё|all)$/i.test(cancelArg[1].trim());
    return { ok: true, message: all ? 'Все таймеры отменены, сэр.' : 'Таймер отменён, сэр.' };
  }
  // "600|текст" или просто "600"
  const m = arg.match(/^\s*(\d+)\s*(?:\|\s*([\s\S]*))?$/);
  if (!m) return { ok: false, message: 'Не понял, на сколько поставить таймер, сэр.' };
  const seconds = Number(m[1]);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86_400) {
    return { ok: false, message: 'Таймер можно поставить от секунды до суток, сэр.' };
  }
  const text = (m[2] || '').trim().slice(0, 200) || 'время вышло';
  const id = `t${++timerSeq}`;
  const at = Date.now() + seconds * 1000;
  startTimer(id, at, text, ctx);
  saveTimers();
  onChange();
  // Без текста — просто таймер («засеки 10 минут»): ответ «Засёк …»; с текстом — что и когда напомню
  const plain = /^(время вышло|таймер)$/.test(text);
  return {
    ok: true,
    speak: plain ? `Засёк ${span(seconds)}.` : `Напомню через ${span(seconds)}: ${text}.`,
    card: { type: 'timer', id, kind: 'timer', at, label: plain ? 'Таймер' : text },
  };
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
// «по понедельникам», «по вторникам и четвергам»
const DAY_PLURAL = ['воскресеньям', 'понедельникам', 'вторникам', 'средам', 'четвергам', 'пятницам', 'субботам'];
const repeatOf = (r) =>
  r.weekdays
    ? 'по будням'
    : r.weekends
      ? 'по выходным'
      : r.weekly
        ? `по ${r.weekly.map((d) => DAY_PLURAL[d]).join(' и ')}`
        : r.daily
          ? 'каждый день'
          : '';
const when = (r) => (r.every ? `каждые ${r.every} мин` : `${repeatOf(r) || dayName(r.at)} в ${hhmm(new Date(r.at))}`);

// "2026-10-01 09:30|текст", "09:30|текст", "tomorrow 09:00", "after tomorrow 09:00", "daily 09:00|текст",
// "weekdays 07:00", "weekends 10:00", "weekly 1,3 08:00" (дни: 0 — воскресенье … 6 — суббота), "every 60|текст"
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
  const weekdays = /^(weekdays|по будням|будни)/.test(s); // будильник по будням
  const weekends = /^(weekends|по выходным)/.test(s);
  const weekly = s
    .match(/^weekly\s+([0-6](?:\s*,\s*[0-6])*)/)?.[1]
    .split(',')
    .map(Number)
    .filter((d, i, all) => all.indexOf(d) === i);
  const repeats = daily || weekdays || weekends || !!weekly;
  const m = s.match(/(?:(\d{4})-(\d{2})-(\d{2})\s+)?(\d{1,2})[:.](\d{2})/);
  if (!m) return { error: 'Не понял, на какое время поставить напоминание, сэр.' };
  const [, y, mo, d, h, mi] = m.map((x) => (x === undefined ? x : Number(x)));
  if (h > 23 || mi > 59) return { error: 'Такого времени не бывает, сэр.' };
  let shift = /^(tomorrow|завтра)/.test(s) ? 1 : /^(after tomorrow|послезавтра)/.test(s) ? 2 : 0;
  // «Разбуди меня завтра в семь», сказанное в половине первого ночи, — это сегодняшнее утро (как у «Алисы»)
  if (shift === 1 && now.getHours() < 4 && new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi) > now) shift = 0;
  const at = y ? new Date(y, mo - 1, d, h, mi) : new Date(now.getFullYear(), now.getMonth(), now.getDate() + shift, h, mi);
  if (Number.isNaN(at.getTime())) return { error: 'Не понял дату, сэр.' };
  if (at <= now) {
    if ((y || shift) && !repeats) return { error: 'Это время уже прошло, сэр.' };
    at.setDate(at.getDate() + 1); // «в 9:00», а сейчас 10 — значит, завтра
  }
  const rule = { daily, ...(weekdays && { weekdays }), ...(weekends && { weekends }), ...(weekly?.length && { weekly }) };
  while (!dayAllowed(rule, at)) at.setDate(at.getDate() + 1);
  return { text, ...rule, at: at.getTime() };
}

const isWeekend = (d) => [0, 6].includes(new Date(d).getDay());
// Подходит ли день повторяющемуся: по будням, по выходным, по выбранным дням недели
const dayAllowed = (r, d) =>
  r.weekdays ? !isWeekend(d) : r.weekends ? isWeekend(d) : r.weekly ? r.weekly.includes(new Date(d).getDay()) : true;
const repeating = (r) => r.daily || r.weekdays || r.weekends || r.weekly;

// Следующий раз повторяющегося. Дни прибавляются по календарю (setDate), а не по 24 часа: при переходе
// на летнее время будильник на 7:00 не уезжает на 6:00 или 8:00
function nextTime(r, now) {
  const at = new Date(r.at);
  while (at.getTime() <= now || !dayAllowed(r, at)) at.setDate(at.getDate() + 1);
  return at.getTime();
}

function add(arg) {
  const r = parse(arg);
  if (r.error) return { ok: false, message: r.error };
  const items = store.get().items;
  const id = items.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  items.push({ id, ...r });
  store.save();
  onChange();
  return { ok: true, speak: `Напомню ${when(r)}: ${r.text}.`, card: cardOf({ id, ...r }) };
}

// Карточка напоминания или будильника для окна
const cardOf = (r) => ({
  type: 'timer',
  id: `r${r.id}`,
  kind: r.alarm ? 'alarm' : 'reminder',
  at: r.at,
  label: r.alarm ? 'Будильник' : r.text,
  repeat: r.every ? `каждые ${r.every} мин` : repeatOf(r),
});

// Всё запланированное — для полоски «Запланировано» в окне: ближайшее сначала
function schedule(limit = 6) {
  const all = [...timers].map(([id, t]) => ({
    type: 'timer',
    id,
    kind: 'timer',
    at: t.at,
    label: /^(время вышло|таймер)$/.test(t.text) ? 'Таймер' : t.text,
  }));
  for (const r of store.get().items) all.push(cardOf(r));
  return all.sort((a, b) => a.at - b.at).slice(0, limit);
}

// Отменить одно по id из schedule(): 't3' — таймер, 'r5' — напоминание или будильник
function cancel(id) {
  const key = String(id);
  if (timers.has(key)) {
    clearTimeout(timers.get(key).handle);
    timers.delete(key);
    saveTimers();
    onChange();
    return true;
  }
  const n = Number(key.replace(/^r/, ''));
  const items = store.get().items;
  const keep = items.filter((r) => r.id !== n);
  if (keep.length === items.length) return false;
  store.save({ items: keep });
  onChange();
  return true;
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
    if (removed) onChange();
    return removed ? { ok: true, speak: `Отменил: ${removed}.` } : { ok: false, message: 'Не нашёл такого напоминания, сэр.' };
  }
  // Таймеры — сколько осталось: «сколько осталось на таймере» тоже приходит сюда
  const left = [...timers.values()]
    .sort((x, y) => x.at - y.at)
    .map((t) => `${isPlain(t.text) ? 'таймер' : t.text} — через ${span(Math.max(1, Math.round((t.at - Date.now()) / 1000)))}`);
  const own = items.filter((r) => !r.alarm);
  if (!own.length && !left.length) return { ok: true, speak: 'Напоминаний и таймеров нет, сэр.' };
  const sorted = [...own].sort((x, y) => x.at - y.at).slice(0, 6);
  const parts = [];
  if (left.length) parts.push(`${left.length === 1 ? 'Таймер' : 'Таймеры'}: ${left.join('; ')}`);
  if (sorted.length) parts.push(`Напоминания: ${sorted.map((r) => `${when(r)} — ${r.text}`).join('; ')}`);
  return { ok: true, speak: `${parts.join('. ')}.` };
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
    // Будильник звенит, пока не выключат; опоздал (компьютер был выключен) — уже не будит
    if (r.alarm) {
      if (!late) ctx.alarm?.({ id: r.id, label: `Будильник ${hhmm(new Date(r.at))}`, radio: r.radio || '' });
      // Компьютер спал или был выключен — будить поздно, но сказать, что будильник пропущен, нужно
      else ctx.remind(`Пропущен будильник на ${hhmm(new Date(r.at))} — компьютер спал или был выключен.`);
      ctx.audit({ alarm: hhmm(new Date(r.at)), late });
    } else if (!quiet && !(r.every && late)) ctx.remind(late ? `Пропущенное напоминание: ${r.text}` : r.text);
    if (!r.alarm) ctx.audit({ reminder: r.text, late });
    if (r.every) r.at = now + r.every * 60_000;
    else if (repeating(r)) r.at = nextTime(r, now);
    else data.items.splice(data.items.indexOf(r), 1);
  }
  if (changed) {
    store.save();
    onChange();
  }
}

// --- будильник ---

// arg: "07:30", "tomorrow 07:30", "daily 07:30", "weekdays 07:30", "in 20" (через 20 минут);
// "|радио маяк" — будить радио; "cancel" — отменить все будильники; "list" — какие стоят
function alarm(arg) {
  const [spec, ...rest] = String(arg || '').split('|');
  const s = spec.trim().toLowerCase();
  const items = store.get().items;
  const alarms = items.filter((r) => r.alarm);
  if (/^(cancel|отмен|удал|выключ)/.test(s)) {
    store.save({ items: items.filter((r) => !r.alarm) });
    if (alarms.length) onChange();
    return alarms.length
      ? { ok: true, speak: `Отменил ${alarms.length === 1 ? 'будильник' : 'все будильники'}, сэр.` }
      : { ok: true, speak: 'Будильников нет, сэр.' };
  }
  if (!s || /^(list|какие|список)/.test(s)) {
    if (!alarms.length) return { ok: true, speak: 'Будильников нет, сэр.' };
    return { ok: true, speak: `Будильник ${alarms.map((r) => when(r)).join('; ')}.` };
  }
  const radio = rest
    .join('|')
    .trim()
    .replace(/^радио\s*/i, '')
    .slice(0, 80);
  const minutes = s.match(/^in\s+(\d+)/)?.[1];
  const r = minutes ? { at: Date.now() + Number(minutes) * 60_000 } : parse(`${s}|будильник`);
  if (r.error) return { ok: false, message: r.error.replace('напоминание', 'будильник') };
  if (minutes && (minutes < 1 || minutes > 24 * 60))
    return { ok: false, message: 'Будильник можно поставить на время до суток вперёд, сэр.' };
  const id = items.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  const item = {
    id,
    alarm: true,
    text: 'будильник',
    at: r.at,
    ...(r.daily && { daily: true }),
    ...(r.weekdays && { weekdays: true }),
    ...(r.weekends && { weekends: true }),
    ...(r.weekly && { weekly: r.weekly }),
    ...(radio && { radio }),
  };
  items.push(item);
  store.save();
  onChange();
  return { ok: true, speak: `Будильник ${when(item)}${radio ? `, разбужу радио ${radio}` : ''}.`, card: cardOf(item) };
}

// День из самой фразы важнее дня, который посчитала модель: «в пятницу», «послезавтра», «по выходным» код
// считает точно, а модель путает даты. arg: "СПЕЦ ЧЧ:ММ|…" — день меняется, время и текст остаются
const DAY_SPEC =
  /^\s*(?:tomorrow|after tomorrow|\d{4}-\d{2}-\d{2}|daily|weekdays|weekends|weekly\s+[0-6](?:\s*,\s*[0-6])*)?\s*(\d{1,2}[:.]\d{2})/i;
function dayFromPhrase(arg, text) {
  const m = String(arg).match(DAY_SPEC);
  if (!m || !text) return arg;
  const [h, mi] = m[1].split(/[:.]/).map(Number);
  const said = dayOf(text, { h, m: mi });
  return said ? `${said.spec}${m[1]}${String(arg).slice(m[0].length)}` : arg;
}

// «Разбуди меня в семь», «будильник на шесть сорок пять по будням», «разбуди в семь под радио Маяк»,
// «отмени будильник», «какие будильники» — без модели. Время — словами или цифрами (lib/clock.js)
function quick(text) {
  const t = String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[?!.,;:«»"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Таймеры: «сколько осталось на таймере», «какие таймеры», «отмени таймер (для пасты)»
  const timerPlan = (arg) => ({ addressed: true, say: '', actions: [{ tool: arg === null ? 'reminders' : 'timer', arg: arg ?? '' }] });
  if (
    /^(?:сколько )?(?:времени )?осталось(?: времени)? (?:на|у|до) таймер|^(?:какие|покажи)(?: у меня)? таймеры?$|^что (?:с|на) таймер/.test(
      t,
    )
  )
    return timerPlan(null);
  const stopTimer = t.match(/^(?:отмени|сбрось|убери|сними|выключи|останови|удали)( все)? таймеры?(?: (?:для|на|про) (.+))?$/);
  if (stopTimer) return timerPlan(`cancel ${stopTimer[1] ? 'все' : stopTimer[2] || ''}`.trim());
  if (!/будильник|разбуди/.test(t)) return null;
  const plan = (arg) => ({ addressed: true, say: '', actions: [{ tool: 'alarm', arg }] });
  if (/^(отмени|удали|убери|сними|выключи)( все)? будильник/.test(t)) return plan('cancel');
  if (
    /какие (?:у меня )?(?:сейчас )?(?:стоят |есть |поставлены |заведены )?будильник|на (?:сколько|какое время) (?:стоит |поставлен )?будильник|есть ли (?:у меня )?будильник|(?:покажи|список) будильник/.test(
      t,
    )
  )
    return plan('list');
  // «под радио Маяк», «с радио», «под музыку» — будить звуком; «с музыкой» — это не название станции
  const radio = t.match(/(?:под|с) (?:радио )?(.+)$|радио (.+)$/);
  let station = radio ? (radio[1] || radio[2]).replace(/ (по будням|каждый день|в будни|по выходным).*$/, '').trim() : '';
  if (radio && !radio[2] && !/радио/.test(radio[0]) && /^(музык|песн|мелоди)/.test(station)) station = 'популярное';
  const head = radio ? t.slice(0, radio.index) : t;
  const seconds = /через/.test(head) ? durationFromText(head) : null;
  if (seconds) return plan(`in ${Math.round(seconds / 60)}${station ? `|радио ${station}` : ''}`);
  // День — отдельно от времени: «послезавтра в восемь», «в субботу на десять», «по выходным в девять»
  const day0 = dayOf(t);
  const clock = parseClock(day0 ? dayOf(head)?.rest || head : head);
  if (!clock) return null; // время не названо или сложное — разберёт модель
  const day = dayOf(t, clock);
  return plan(`${day?.spec || ''}${formatClock(clock)}${station ? `|радио ${station}` : ''}`);
}

module.exports = {
  id: 'reminders',
  needs: ['now'],
  title: 'таймер «через N минут», напоминания на время и дату, каждый день, каждые N минут; будильник (можно под радио); список и отмена',
  quick,
  keywords: [
    'таймер',
    'засеки',
    'напомн',
    'напомин',
    'будильник',
    'разбуди',
    'каждый день',
    'каждые',
    'каждый час',
    /в \d{1,2}[:.]?\d{0,2}/,
    'завтра в',
    'утром',
    'вечером',
    'напомни через',
    (text) => /через/.test(text) && durationFromText(text) !== null, // «через 10 минут» — с длительностью
  ],
  rules: [
    'Напоминание через N минут — timer; на конкретное время или дату, или повторяющееся — remind_at (дату считай от текущей).',
    'reminders "cancel …" — только если прямо просят отменить напоминание; «забудь про …» — это память (forget).',
    '«Разбуди меня», «будильник» — alarm (звенит, пока не выключат), а не remind_at.',
  ],
  tools: [
    {
      name: 'timer',

      llmArg: true,
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

      llmArg: true,
      use: 'напоминание на время или дату; повторяющееся',
      arg: '"ЧЧ:ММ|текст" (ближайшее), "tomorrow ЧЧ:ММ|текст", "after tomorrow ЧЧ:ММ|текст", "ГГГГ-ММ-ДД ЧЧ:ММ|текст", "daily ЧЧ:ММ|текст", "weekdays ЧЧ:ММ|текст", "weekends ЧЧ:ММ|текст", "weekly ДНИ ЧЧ:ММ|текст" (дни недели через запятую: 1 — понедельник … 0 — воскресенье), "every МИНУТЫ|текст"',
      examples: [
        [
          'напомни завтра в 9 позвонить маме',
          { addressed: true, say: '', actions: [{ tool: 'remind_at', arg: 'tomorrow 09:00|позвонить маме' }] },
        ],
        ['напоминай пить воду каждый час', { addressed: true, say: '', actions: [{ tool: 'remind_at', arg: 'every 60|выпить воды' }] }],
      ],
      normalize: dayFromPhrase,
      run: async (arg) => add(arg),
    },
    {
      name: 'alarm',
      llmArg: true,
      use: 'будильник: разбудить в нужное время, сигналом или радио; какие стоят; отменить',
      arg: '"ЧЧ:ММ" (ближайшее), "tomorrow ЧЧ:ММ", "after tomorrow ЧЧ:ММ", "ГГГГ-ММ-ДД ЧЧ:ММ", "daily ЧЧ:ММ", "weekdays ЧЧ:ММ" (по будням), "weekends ЧЧ:ММ", "weekly ДНИ ЧЧ:ММ", "in МИНУТЫ"; через "|радио СТАНЦИЯ" — будить радио; "list"; "cancel"',
      examples: [
        ['разбуди меня в семь', { addressed: true, say: '', actions: [{ tool: 'alarm', arg: '07:00' }] }],
        [
          'поставь будильник на шесть тридцать по будням под радио маяк',
          { addressed: true, say: '', actions: [{ tool: 'alarm', arg: 'weekdays 06:30 | радио маяк' }] },
        ],
      ],
      speaks: true,
      normalize: dayFromPhrase,
      run: async (arg) => alarm(arg),
    },
    {
      name: 'reminders',

      llmArg: true,
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
    onChange = () => ctx.onSchedule?.();
    // Таймеры с прошлого запуска: идут дальше; истёкшие, пока Ориона не было, — сказать (ненадолго позже)
    timers.forEach((t) => clearTimeout(t.handle));
    timers.clear();
    timerStore = ctx.dataDir ? createStore(ctx.dataDir, 'timers.json', { items: [] }) : null;
    const missed = [];
    for (const t of timerStore?.get().items || []) {
      if (!t?.id || !Number.isFinite(t.at)) continue;
      timerSeq = Math.max(timerSeq, Number(String(t.id).slice(1)) || 0);
      if (t.at > Date.now()) startTimer(t.id, t.at, String(t.text || 'время вышло'), ctx);
      else if (Date.now() - t.at < 12 * 3_600_000) missed.push(t);
    }
    saveTimers();
    if (missed.length)
      setTimeout(
        () =>
          ctx.remind(`Пока меня не было, сработал таймер: ${missed.map((t) => (isPlain(t.text) ? 'без подписи' : t.text)).join(', ')}.`),
        6000,
      ).unref?.();
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
  span,
  schedule,
  cancel,
  _reset: () => (store = createStore(null, '', { items: [] })),
  _tick: (ctx) => tick(ctx),
};
