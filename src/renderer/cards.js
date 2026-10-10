// Карточки в ответах и полоска «Запланировано».
//   - навык отдаёт данные (result.card), окно рисует: погода — значок, температура и дни; таймер, напоминание,
//     будильник — живой отсчёт и кнопка «Отменить»;
//   - над строкой ввода — всё запланированное (таймеры, напоминания, будильники) с отсчётом и крестиком.
// Текст в карточках — только через textContent: данные приходят из сети и от модели.
// Форматирование времени — чистые функции (проверяются тестами в Node), остальное — DOM.
/* exported renderCards, showSchedule */

const pad2 = (n) => String(n).padStart(2, '0');

// Сколько осталось: «0:42», «4:05», «1:02:30»; больше суток — «2 дн»
function countdown(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 86_400) return `${Math.floor(s / 86_400)} дн`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

// Когда сработает: «в 07:30», «завтра в 07:30», «пт в 09:00», «12.10 в 09:00»
const SHORT_DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
function whenLabel(at, now = Date.now()) {
  const d = new Date(at);
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const day = (t) => new Date(t).setHours(0, 0, 0, 0);
  const diff = Math.round((day(at) - day(now)) / 86_400_000);
  if (diff <= 0) return `в ${clock}`;
  if (diff === 1) return `завтра в ${clock}`;
  if (diff < 7) return `${SHORT_DAYS[d.getDay()]} в ${clock}`;
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} в ${clock}`;
}

// Отсчёт виден до часа; дальше — время срабатывания (секунды до утра никому не нужны)
const SHOW_COUNTDOWN_MS = 3_600_000;
const timeText = (at, now = Date.now()) => (at - now <= SHOW_COUNTDOWN_MS ? countdown(at - now) : whenLabel(at, now));

const degreesText = (t) => `${t > 0 ? '+' : ''}${t}°`;

if (typeof module !== 'undefined') {
  module.exports = { countdown, whenLabel, timeText, degreesText, SHOW_COUNTDOWN_MS };
}

// --- DOM -------------------------------------------------------------------------------------------

const ICONS = {
  clear: 'i-w-clear',
  partly: 'i-w-partly',
  cloud: 'i-w-cloud',
  fog: 'i-w-fog',
  rain: 'i-w-rain',
  snow: 'i-w-snow',
  storm: 'i-w-storm',
};
const KIND_ICON = { timer: 'i-timer', reminder: 'i-bell', alarm: 'i-alarm' };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}

function icon(id, cls = 'ico') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function weatherCard(c) {
  const box = el('div', 'card weather');
  if (c.now) {
    const head = el('div', 'w-now');
    head.append(icon(ICONS[c.now.icon] || ICONS.cloud, 'w-ico'));
    head.append(el('div', 'w-temp', degreesText(c.now.temp)));
    const side = el('div', 'w-side');
    side.append(el('div', 'w-desc', c.now.desc));
    const extra = [
      c.city,
      c.now.feels != null ? `ощущается ${degreesText(c.now.feels)}` : '',
      c.now.wind != null ? `ветер ${c.now.wind} м/с` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    side.append(el('div', 'w-meta', extra));
    head.append(side);
    box.append(head);
  } else box.append(el('div', 'card-title', c.city));
  if (c.days?.length) {
    const row = el('div', 'w-days');
    for (const d of c.days.slice(0, 7)) {
      const cell = el('div', 'w-day');
      cell.title = d.desc || '';
      cell.append(el('div', 'w-day-label', d.label));
      cell.append(icon(ICONS[d.icon] || ICONS.cloud, 'w-day-ico'));
      cell.append(el('div', 'w-day-temp', `${degreesText(d.max)} ${degreesText(d.min)}`));
      if (d.rain >= 30) cell.append(el('div', 'w-day-rain', `${d.rain}%`));
      row.append(cell);
    }
    box.append(row);
  }
  return box;
}

function timerCard(c) {
  const box = el('div', `card timer kind-${c.kind}`);
  box.dataset.id = c.id;
  box.append(icon(KIND_ICON[c.kind] || 'i-timer', 't-ico'));
  const body = el('div', 't-body');
  body.append(el('div', 't-label', c.label));
  body.append(el('div', 't-when', [whenLabel(c.at), c.repeat].filter(Boolean).join(' · ')));
  box.append(body);
  const left = el('div', 't-left');
  left.dataset.at = c.at;
  left.textContent = timeText(c.at);
  box.append(left);
  const cancel = el('button', 'btn t-cancel', 'Отменить');
  cancel.addEventListener('click', (e) => {
    e.stopPropagation();
    window.jarvis.scheduleCancel(c.id);
    box.classList.add('cancelled');
  });
  box.append(cancel);
  return box;
}

// Карточки ответа → один блок под текстом реплики (null — нечего рисовать)
function renderCards(cards) {
  const list = (Array.isArray(cards) ? cards : []).filter((c) => c && typeof c === 'object');
  if (!list.length) return null;
  const box = el('div', 'cards');
  for (const c of list) {
    if (c.type === 'weather') box.append(weatherCard(c));
    else if (c.type === 'timer' && Number.isFinite(c.at)) box.append(timerCard(c));
  }
  tick();
  return box.children.length ? box : null;
}

// Полоска «Запланировано» над строкой ввода: ближайшее сначала, крестик отменяет
const scheduleBar = typeof document !== 'undefined' ? document.querySelector('#schedule') : null;
let scheduled = [];
function showSchedule(list) {
  scheduled = Array.isArray(list) ? list.filter((c) => Number.isFinite(c?.at)) : [];
  // Полоска появляется или исчезает над строкой ввода — лента, прижатая к низу, остаётся внизу
  const log = document.querySelector('#log');
  const atBottom = log && log.scrollHeight - log.scrollTop - log.clientHeight < 4;
  scheduleBar.replaceChildren();
  for (const c of scheduled) {
    const chip = el('div', `sched kind-${c.kind}`);
    chip.title = [c.label, whenLabel(c.at), c.repeat].filter(Boolean).join(' · ');
    chip.append(icon(KIND_ICON[c.kind] || 'i-timer', 's-ico'));
    const left = el('span', 's-left');
    left.dataset.at = c.at;
    left.dataset.short = '';
    chip.append(left);
    chip.append(el('span', 's-label', c.label));
    const x = el('button', 's-x');
    x.title = 'Отменить';
    x.append(icon('i-hide', 's-x-ico'));
    x.addEventListener('click', () => window.jarvis.scheduleCancel(c.id));
    chip.append(x);
    scheduleBar.append(chip);
  }
  scheduleBar.hidden = !scheduled.length;
  if (atBottom) log.scrollTop = log.scrollHeight;
  // Карточки в ленте: отменённое (его больше нет в списке, а время ещё не пришло) — приглушить
  const ids = new Set(scheduled.map((c) => c.id));
  for (const card of document.querySelectorAll('.card.timer')) {
    const at = Number(card.querySelector('.t-left')?.dataset.at);
    if (!ids.has(card.dataset.id) && at > Date.now() + 1000) card.classList.add('cancelled');
  }
  tick();
}

// Один таймер на все отсчёты; работает, только пока есть что считать
let ticker = null;
function tick() {
  const now = Date.now();
  let live = false;
  for (const e of document.querySelectorAll('[data-at]')) {
    const at = Number(e.dataset.at);
    const card = e.closest('.card.timer');
    if (card?.classList.contains('cancelled')) {
      e.textContent = 'отменено';
      continue;
    }
    if (at <= now) {
      e.textContent = 'сейчас';
      card?.classList.add('done');
      continue;
    }
    const text = timeText(at, now);
    e.textContent = 'short' in e.dataset ? text.replace(/ в /, ' ') : text; // в полоске короче: «завтра 07:00»
    live = true;
  }
  if (live && !ticker) ticker = setInterval(tick, 1000);
  if (!live && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

if (typeof window !== 'undefined' && window.jarvis) {
  window.jarvis.onSchedule(showSchedule);
  window.jarvis.schedule().then(showSchedule, () => {});
}
