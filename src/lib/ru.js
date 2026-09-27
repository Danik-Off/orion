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
const money = (n, digits = 2) => n.toLocaleString('ru-RU', { maximumFractionDigits: digits }).replace(/ /g, ' ');

// Распознаватель речи пишет числа словами: «тридцать пять» → 35, «сто» → 100. Цифры тоже понимает.
const NUM_WORDS = {
  ноль: 0, один: 1, одна: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9,
  десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16,
  семнадцать: 17, восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50,
  шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90, сто: 100, двести: 200, триста: 300, полчаса: 30,
};
function wordsToNumber(text) {
  const digits = String(text).match(/\d+/);
  if (digits) return Number(digits[0]);
  let sum = null;
  for (const w of String(text).toLowerCase().replace(/ё/g, 'е').split(/[^а-я]+/)) {
    if (w in NUM_WORDS) sum = (sum || 0) + NUM_WORDS[w];
    else if (sum !== null) break; // число закончилось
  }
  return sum;
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
  if (/полтора час/.test(t)) return 5400;
  if (/полчаса/.test(t)) return 1800;
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
      if (later !== null && later !== undefined) (n = later), (stop += after[0].length);
    }
    if (n === null && m[1] && !/^(через|на|за|в)$/.test(m[1].split(' ').pop())) continue;
    total = (total || 0) + (n ?? 1) * unit;
    end = stop;
  }
  return total;
}

module.exports = { plural, degrees, money, wordsToNumber, durationFromText };
