// Время из речи для будильника: распознаватель пишет числа словами, и «семь тридцать» — это 7:30, а не 37
// (общий перевод слов в число складывает их). Понимает: «7:30», «в 7», «семь тридцать», «шесть сорок пять»,
// «в половине восьмого» (7:30), «в восемь вечера» (20:00), «в двенадцать дня», «в час ночи»,
// «в шесть часов тридцать минут», «без пятнадцати семь» (6:45), «без четверти восемь», «четверть восьмого» (7:15),
// «двадцать минут восьмого» (7:20), «в полдень», «в полночь».
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

// «пятнадцати», «десяти», «двадцати пяти» → «пятнадцать», «десять», «двадцать пять» (после «без»)
const GENITIVE = {
  одной: 'один',
  двух: 'два',
  трех: 'три',
  четырех: 'четыре',
  пяти: 'пять',
  шести: 'шесть',
  семи: 'семь',
  восьми: 'восемь',
  девяти: 'девять',
  десяти: 'десять',
  одиннадцати: 'одиннадцать',
  двенадцати: 'двенадцать',
  тринадцати: 'тринадцать',
  четырнадцати: 'четырнадцать',
  пятнадцати: 'пятнадцать',
  шестнадцати: 'шестнадцать',
  семнадцати: 'семнадцать',
  восемнадцати: 'восемнадцать',
  девятнадцати: 'девятнадцать',
  двадцати: 'двадцать',
  тридцати: 'тридцать',
  сорока: 'сорок',
  пятидесяти: 'пятьдесят',
};
const genitiveToNominative = (w) => GENITIVE[w] || w;

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
    .replace(/(\d{1,2})[:.](\d{2})/g, '$1 $2') // «7:30» → «7 30»
    .replace(
      /(^|\s)(?:в |на )?пол-?(первого|второго|третьего|четвертого|пятого|шестого|седьмого|восьмого|девятого|десятого|одиннадцатого|двенадцатого)/g,
      '$1в половине $2',
    ); // «полседьмого»
  const words = t.split(/[^а-я0-9]+/).filter(Boolean);
  // Целые слова: «по будням» не «дня»
  const evening = words.includes('вечера') || words.includes('дня');
  const night = words.includes('ночи');
  if (words.includes('через')) return null; // «через десять минут» — не время на часах
  const late = (h) => (evening && h < 12 ? h + 12 : h);

  if (words.includes('полдень')) return { h: 12, m: 0 };
  if (words.includes('полночь')) return { h: 0, m: 0 };

  // «без пятнадцати семь», «без четверти восемь», «без десяти минут девять» → час раньше, минуты до часа
  const without = words.indexOf('без');
  if (without >= 0) {
    let i = without + 1;
    let before = null;
    if (words[i] === 'четверти') [before, i] = [15, i + 1];
    else {
      const n = numberAt(words, i) || numberAt(words.map(genitiveToNominative), i);
      if (n) [before, i] = [n[0], i + n[1]];
    }
    if (['минут', 'минуты', 'минуту', 'минуты'].includes(words[i])) i += 1;
    const hour = numberAt(words, i);
    if (before && before < 60 && hour && hour[0] >= 1 && hour[0] <= 24) return { h: late((hour[0] + 23) % 24), m: 60 - before };
  }

  // «четверть восьмого» → 7:15; «двадцать минут восьмого» → 7:20 (идёт восьмой час)
  const quarter = words.indexOf('четверть');
  if (quarter >= 0 && words[quarter + 1] in ORDINAL) return { h: late(ORDINAL[words[quarter + 1]] - 1), m: 15 };
  const past = words.findIndex((w, i) => /^минут/.test(w) && words[i + 1] in ORDINAL);
  if (past > 0) {
    const n = numberAt(words, past - 2) && numberAt(words, past - 2)[1] === 2 ? numberAt(words, past - 2) : numberAt(words, past - 1);
    if (n && n[0] < 60) return { h: late(ORDINAL[words[past + 1]] - 1), m: n[0] };
  }

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
  // «в шесть часов тридцать минут»: после часа — слово «часов», минуты — за ним, и «минут» им не мешает
  let at = start + hour[1];
  const hours = /^час(?:а|ов)?$/.test(words[at] || '');
  if (hours) at += 1;
  const minute = numberAt(words, at);
  const minutesWord = ['минут', 'минуты', 'минуту'].includes(words[at + (minute?.[1] || 0)]);
  let m = minute && minute[0] <= 59 && (hours || !minutesWord) ? minute[0] : 0;
  if (words[at] === 'ноль' && minute) {
    // «семь ноль пять» → 7:05
    const after = numberAt(words, at + 1);
    m = after && after[0] < 10 ? after[0] : 0;
  }
  if (evening && h < 12) h += 12;
  if (night && h === 12) h = 0;
  return { h, m };
}

const formatClock = ({ h, m }) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

module.exports = { parseClock, formatClock };
