// Русский текст для озвучки: склонения и числа словами там, где синтезатору нужна помощь.

// «1 градус», «3 градуса», «5 градусов»
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

function degrees(t) {
  const n = Math.round(t);
  return `${n > 0 ? 'плюс ' : n < 0 ? 'минус ' : ''}${Math.abs(n)} ${plural(n, 'градус', 'градуса', 'градусов')}`;
}

// 84115 → «84 115», 1.4839 → «1,48»
const money = (n, digits = 2) => n.toLocaleString('ru-RU', { maximumFractionDigits: digits }).replace(/\u00A0/g, ' ');

// Распознаватель речи пишет числа словами: «тридцать пять» → 35, «сто» → 100. Цифры тоже понимает.
const NUM_WORDS = {
  ноль: 0,
  один: 1,
  одна: 1,
  одну: 1,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
  десять: 10,
  одиннадцать: 11,
  двенадцать: 12,
  тринадцать: 13,
  четырнадцать: 14,
  пятнадцать: 15,
  шестнадцать: 16,
  семнадцать: 17,
  восемнадцать: 18,
  девятнадцать: 19,
  двадцать: 20,
  тридцать: 30,
  сорок: 40,
  пятьдесят: 50,
  шестьдесят: 60,
  семьдесят: 70,
  восемьдесят: 80,
  девяносто: 90,
  сто: 100,
  двести: 200,
  триста: 300,
  четыреста: 400,
  пятьсот: 500,
  шестьсот: 600,
  семьсот: 700,
  восемьсот: 800,
  девятьсот: 900,
  полчаса: 30,
  // Родительный падеж: «от двух тысяч», «из пяти»
  двух: 2,
  трех: 3,
  четырех: 4,
  пяти: 5,
  шести: 6,
  семи: 7,
  восьми: 8,
  девяти: 9,
  десяти: 10,
  двадцати: 20,
  тридцати: 30,
  сорока: 40,
  пятидесяти: 50,
  ста: 100,
  двухсот: 200,
  одного: 1,
  одной: 1,
  одиннадцати: 11,
  двенадцати: 12,
  тринадцати: 13,
  четырнадцати: 14,
  пятнадцати: 15,
  шестнадцати: 16,
  семнадцати: 17,
  восемнадцати: 18,
  девятнадцати: 19,
  шестидесяти: 60,
  семидесяти: 70,
  восьмидесяти: 80,
  девяноста: 90,
  трехсот: 300,
  четырехсот: 400,
  пятисот: 500,
  шестисот: 600,
  семисот: 700,
  восьмисот: 800,
  девятисот: 900,
};
// Множители: «две тысячи» — 2 × 1000, а не 2 + 1000
const SCALE = [
  [/^тысяч/, 1000],
  [/^миллион/, 1_000_000],
];
function wordsToNumber(text) {
  const digits = String(text).match(/\d+/);
  if (digits) return Number(digits[0]);
  let sum = null; // готовые тысячи, миллионы
  let part = null; // число до следующего множителя
  for (const w of String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^а-я]+/)) {
    const scale = SCALE.find(([re]) => re.test(w))?.[1];
    if (w in NUM_WORDS) part = (part || 0) + NUM_WORDS[w];
    else if (scale) {
      sum = (sum || 0) + (part ?? 1) * scale;
      part = null;
    } else if (sum !== null || part !== null) break; // число закончилось
  }
  return sum === null && part === null ? null : (sum || 0) + (part || 0);
}

// Длительность из фразы в секундах: «через 10 минут», «на полчаса», «через час», «полтора часа», «5 секунд».
// Модель путает минуты с секундами, а во фразе единицы сказаны прямо — ей и верим. null — длительности нет.
const UNITS = [
  [/^сек/, 1],
  [/^мин/, 60],
  [/^час/, 3600],
];
function durationFromText(text) {
  const t = String(text).toLowerCase().replace(/ё/g, 'е');
  // Дробные и приблизительные: «полтора часа», «полторы минуты», «полминуты», «пол часа», «две с половиной
  // минуты», «пару минут»
  const unitOf = (u) => (/^сек/.test(u) ? 1 : /^мин/.test(u) ? 60 : 3600);
  const half = t.match(/(?:^|\s)(\d+|[а-я]+) с половиной (секунд\S*|минут\S*|час\S*)/);
  if (half && wordsToNumber(half[1]) !== null) return Math.round((wordsToNumber(half[1]) + 0.5) * unitOf(half[2]));
  const oneAndHalf = t.match(/(?:^|\s)полтор[аы] (секунд\S*|минут\S*|час\S*)/);
  if (oneAndHalf) return Math.round(1.5 * unitOf(oneAndHalf[1]));
  const halfOf = t.match(/(?:^|\s)пол[ -]?(минуты|минутки|часа|часика)(?![а-я])/);
  if (halfOf) return 0.5 * unitOf(halfOf[1]);
  const pair = t.match(/(?:^|\s)(?:пару|пара|парочку) (секунд|минут|минуток|часов)(?![а-я])/);
  if (pair) return 2 * unitOf(pair[1]);
  // «через час двадцать», «два часа тридцать» — часы и минуты, хотя слово «минут» не сказано
  const hm = t.match(/(?:^|\s)(?:(\d+|[а-я]+) )?час(?:а|ов)? (\d+|[а-я]+(?: [а-я]+)?)(?=\s|$)/);
  if (hm && !/^\s*(?:минут|секунд|час)/.test(t.slice(hm.index + hm[0].length))) {
    const h = hm[1] ? wordsToNumber(hm[1]) : 1;
    const words = hm[2].split(' ');
    const m = wordsToNumber(hm[2]) ?? wordsToNumber(words[0]);
    if (h !== null && h > 0 && h <= 24 && m !== null && m > 0 && m < 60 && !/^(через|на|в)$/.test(hm[1] || '')) return h * 3600 + m * 60;
    if ((!hm[1] || /^(через|на|в)$/.test(hm[1])) && m !== null && m > 0 && m < 60) return 3600 + m * 60;
  }
  let total = null;
  let end = -1;
  // «2 часа 15 минут», «десять минут», «час» (без числа — один); складываем только идущие подряд
  const re = /(?:(\d+|[а-я]+(?: [а-я]+)?) )?(?<![а-я])(секунд[уыа]?|сек|минут[уыа]?|минутк[уи]|мин|час|часа|часов|часик)(?![а-я])/g;
  for (const m of t.matchAll(re)) {
    if (end >= 0 && m.index < end) continue; // это число уже взято после единицы («секунд десять»)
    if (end >= 0 && !/^\s*(и\s*)?$/.test(t.slice(end, m.index))) break; // дальше — уже другая длительность
    const unit = UNITS.find(([u]) => u.test(m[2]))[1];
    let n = m[1] ? wordsToNumber(m[1]) : null;
    let stop = m.index + m[0].length;
    // «на секунд десять», «минут через пять»: примерное число после единицы — только у формы «секунд/минут/часов»
    // («через час двадцать» — это час и двадцать минут, а не двадцать часов)
    if (n === null && /^(секунд|минут|часов)$/.test(m[2])) {
      const after = t.slice(stop).match(/^\s+(?:через\s+|на\s+)?(\d+|[а-я]+(?: [а-я]+)?)/);
      const later = after && wordsToNumber(after[1]);
      if (later !== null && later !== undefined) ((n = later), (stop += after[0].length));
    }
    if (n === null && m[1] && !/^(через|на|за|в)$/.test(m[1].split(' ').pop())) continue;
    total = (total || 0) + (n ?? 1) * unit;
    end = stop;
  }
  return total;
}

module.exports = { plural, degrees, money, wordsToNumber, durationFromText };
