// Мелочи, которые просят у голосовых помощников каждый день: монетка, кубик, случайное число, секундомер.
// Всё — без сети и без модели: быстрые фразы разбирает quick, модель зовёт инструменты по описанию.
const { plural, wordsToNumber, durationFromText } = require('../lib/ru');

const random = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const num = (s) => (s === undefined ? null : /^-?\d+$/.test(s) ? Number(s) : wordsToNumber(s));

// --- монетка и кубик ---
function coin() {
  return { ok: true, speak: Math.random() < 0.5 ? 'Орёл.' : 'Решка.' };
}

// arg: число кубиков (1–6), по умолчанию 1
function dice(arg) {
  const n = Math.max(1, Math.min(6, Number(arg) || 1));
  const rolls = Array.from({ length: n }, () => random(1, 6));
  if (n === 1) return { ok: true, speak: `Выпало ${rolls[0]}.` };
  const sum = rolls.reduce((a, b) => a + b, 0);
  return { ok: true, speak: `Выпало ${rolls.join(', ')} — в сумме ${sum}.` };
}

// arg: "ОТ ДО" или "ДО" (от единицы); по умолчанию — от 1 до 100
function randomNumber(arg) {
  const parts = String(arg || '')
    .match(/-?\d+/g)
    ?.map(Number);
  let [min, max] = parts?.length >= 2 ? parts : parts?.length === 1 ? [1, parts[0]] : [1, 100];
  if (min > max) [min, max] = [max, min];
  if (max - min > 1e9) return { ok: false, message: 'Слишком большой разброс, сэр.' };
  return { ok: true, speak: `${random(min, max)}.` };
}

// --- секундомер: один на всех, живёт до перезапуска ---
let started = null;
let stoppedAt = null;
function spanOf(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const out = [];
  if (h) out.push(`${h} ${plural(h, 'час', 'часа', 'часов')}`);
  if (m) out.push(`${m} ${plural(m, 'минута', 'минуты', 'минут')}`);
  if (sec || !out.length) out.push(`${sec} ${plural(sec, 'секунда', 'секунды', 'секунд')}`);
  return out.join(' ');
}
// arg: "start" | "stop" | "status" | "reset"
function stopwatch(arg) {
  const a = String(arg || 'status').toLowerCase();
  if (/^start/.test(a)) {
    started = Date.now();
    stoppedAt = null;
    return { ok: true, speak: 'Секундомер пошёл.' };
  }
  if (!started) return { ok: true, speak: 'Секундомер не запущен. Скажите «запусти секундомер».' };
  if (/^reset/.test(a)) {
    started = null;
    stoppedAt = null;
    return { ok: true, speak: 'Секундомер сброшен.' };
  }
  if (/^stop/.test(a)) {
    stoppedAt ??= Date.now();
    return { ok: true, speak: `Стоп: ${spanOf(stoppedAt - started)}.` };
  }
  return { ok: true, speak: `${stoppedAt ? 'Секундомер остановлен на' : 'Прошло'} ${spanOf((stoppedAt || Date.now()) - started)}.` };
}

// Быстрые фразы — без модели
function quick(text) {
  const t = String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[?!.,;:«»"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const plan = (tool, arg = '') => ({ addressed: true, say: '', actions: [{ tool, arg }] });
  if (/^(?:подбрось|подкинь|кинь|брось)(?: мне)? монет(?:к[уа]|у)$|^орел или решка$/.test(t)) return plan('coin');
  const roll = t.match(/^(?:брось|кинь|подбрось)(?: мне)? (?:(\S+) )?(?:кубик|кубика|кубиков|кости|кость)$/);
  if (roll) return plan('dice', String(num(roll[1]) ?? 1));
  const range = t.match(
    /^(?:загадай|назови|выбери|скажи|дай)(?: мне)? (?:случайное )?число(?: от (\S+(?: \S+)?) до (\S+(?: \S+)?)| до (\S+(?: \S+)?))?$|^случайное число(?: от (\S+(?: \S+)?) до (\S+(?: \S+)?))?$/,
  );
  if (range) {
    const [from, to] = range[1] ? [range[1], range[2]] : range[4] ? [range[4], range[5]] : [range[3] ? '1' : null, range[3]];
    const a = num(from);
    const b = num(to);
    return plan('random_number', a !== null && b !== null ? `${a} ${b}` : b !== null ? String(b) : '');
  }
  if (/^(?:запусти|включи|засеки|начни|старт)(?: мне)? секундомер$|^секундомер (?:старт|пошел|запусти)$/.test(t))
    return plan('stopwatch', 'start');
  if (/^(?:останови|выключи|стоп) секундомер$|^секундомер стоп$/.test(t)) return plan('stopwatch', 'stop');
  if (/^(?:сбрось|обнули) секундомер$/.test(t)) return plan('stopwatch', 'reset');
  if (/^(?:сколько (?:прошло|времени прошло)(?: на секундомере)?|что на секундомере|сколько на секундомере)$/.test(t) && started)
    return plan('stopwatch', 'status');
  return null;
}

module.exports = {
  id: 'games',
  needs: [],
  title: 'монетка, кубик, случайное число, секундомер',
  keywords: ['монет', 'орел или решка', 'кубик', 'кост', 'случайн', 'загадай число', 'секундомер'],
  router: false, // маленькая модель навыка не знает (дообучение v5/v6 2026-10-11 не превзошло v2): быстрый разбор или большая
  quick,
  // «Через сколько» — это таймер, а не секундомер
  rules: ['Засечь время до события («через 10 минут») — timer; сколько прошло с момента «старт» — stopwatch.'],
  tools: [
    {
      name: 'coin',
      use: 'подбросить монетку: орёл или решка',
      arg: 'пусто',
      run: async () => coin(),
    },
    {
      name: 'dice',
      use: 'бросить игральный кубик (или несколько)',
      arg: 'сколько кубиков, 1–6; пусто — один',
      run: async (arg) => dice(arg),
    },
    {
      name: 'random_number',
      use: 'случайное число в диапазоне',
      arg: '"ОТ ДО" или "ДО" (от 1); пусто — от 1 до 100',
      examples: [['загадай число от 1 до 10', { addressed: true, say: '', actions: [{ tool: 'random_number', arg: '1 10' }] }]],
      run: async (arg) => randomNumber(arg),
    },
    {
      name: 'stopwatch',
      use: 'секундомер: запустить, сколько прошло, остановить, сбросить',
      arg: '"start" | "status" | "stop" | "reset"',
      argEnum: ['start', 'status', 'stop', 'reset'],
      run: async (arg) => stopwatch(arg),
    },
  ],
  _test: { quick, dice, randomNumber, stopwatch, spanOf, durationFromText },
};
