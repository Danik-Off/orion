// Время из речи для будильника: распознаватель пишет числа словами, и «семь тридцать» — это 7:30, а не 37
// (общий перевод слов в число складывает их). Понимает: «7:30», «в 7», «семь тридцать», «шесть сорок пять»,
// «в половине восьмого» (7:30), «в восемь вечера» (20:00), «в двенадцать дня», «в час ночи».
// → { h, m } или null.
const UNITS = {
  ноль: 0,
  один: 1,
  одну: 1,
  час: 1,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
};
const TEENS = {
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
};
const TENS = { двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50 };
// «половине восьмого» — порядковое в родительном: какой час идёт
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
};

// Число из слов, начиная с i: «двадцать три» → 23 (2 слова), «сорок» → 40; → [число, сколько слов] или null
function numberAt(words, i) {
  const w = words[i];
  if (w === undefined) return null;
  if (/^\d+$/.test(w)) return [Number(w), 1];
  if (w in TEENS) return [TEENS[w], 1];
  if (w in TENS) {
    const next = words[i + 1];
    if (next in UNITS && UNITS[next] > 0 && next !== 'час') return [TENS[w] + UNITS[next], 2];
    return [TENS[w], 1];
  }
  if (w in UNITS) return [UNITS[w], 1];
  return null;
}

function parseClock(text) {
  const t = String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/(\d{1,2})[:.](\d{2})/g, '$1 $2'); // «7:30» → «7 30»
  const words = t.split(/[^а-я0-9]+/).filter(Boolean);
  // Целые слова: «по будням» не «дня»
  const evening = words.includes('вечера') || words.includes('дня');
  const night = words.includes('ночи');
  if (words.includes('через')) return null; // «через десять минут» — не время на часах

  // «в половине восьмого» → 7:30
  const half = words.indexOf('половине');
  if (half >= 0 && words[half + 1] in ORDINAL) {
    let h = ORDINAL[words[half + 1]] - 1;
    if (evening && h < 12) h += 12;
    return { h, m: 30 };
  }

  // Час — первое число после «в», «на», «к» (или первое число вообще), минуты — следующее
  let start = words.findIndex((w, i) => ['в', 'на', 'к'].includes(w) && numberAt(words, i + 1));
  start = start >= 0 ? start + 1 : words.findIndex((w, i) => numberAt(words, i));
  if (start < 0) return null;
  const hour = numberAt(words, start);
  if (!hour || hour[0] > 23) return null;
  let h = hour[0];
  const minute = numberAt(words, start + hour[1]);
  let m = minute && minute[0] <= 59 && !['минут', 'минуты', 'минуту'].includes(words[start + hour[1] + minute[1]]) ? minute[0] : 0;
  if (words[start + hour[1]] === 'ноль' && minute) {
    // «семь ноль пять» → 7:05
    const after = numberAt(words, start + hour[1] + 1);
    m = after && after[0] < 10 ? after[0] : 0;
  }
  if (evening && h < 12) h += 12;
  if (night && h === 12) h = 0;
  return { h, m };
}

const formatClock = ({ h, m }) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

module.exports = { parseClock, formatClock };
