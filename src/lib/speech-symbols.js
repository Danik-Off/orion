// Символы, ссылки и редкие сокращения → слова. Первый шаг нормализации (lib/speech-text.js):
// после него числа и единицы согласуются обычными правилами («~5 минут» → «около 5 минут» → «около пяти минут»).

// Части адреса, которые говорят словом
const DOMAIN_WORDS = {
  ya: 'я',
  yandex: 'яндекс',
  google: 'гугл',
  youtube: 'ютуб',
  vk: 'вэ-к+а',
  mail: 'мейл',
  gmail: 'джим+ейл',
  github: 'гитхаб',
  wikipedia: 'википедия',
  telegram: 'телеграм',
  t: 'тэ',
  ozon: 'озон',
  avito: 'авито',
  gosuslugi: 'госуслуги',
  sber: 'сбер',
  tinkoff: 'тинькофф',
  rutube: 'рутуб',
  dzen: 'дзен',
  habr: 'хабр',
  ru: 'ру',
  com: 'ком',
  org: 'орг',
  net: 'нет',
  io: 'ай-+оу',
  dev: 'дев',
  info: 'инфо',
  su: 'эс-+ю',
  me: 'ми',
  app: 'эпп',
};
const TLD = /^(ru|com|org|net|io|dev|info|su|me|app|рф|uk|de|by|kz|ua|edu|gov|tv|ai)$/i;
const sayLabel = (label) => DOMAIN_WORDS[label.toLowerCase()] ?? (label.toLowerCase() === 'рф' ? 'эр-+эф' : label);

// «https://ya.ru/search?text=…» → «я точка ру»: путь и параметры вслух не нужны
function speakDomain(host) {
  return host
    .replace(/^www\./i, '')
    .split('.')
    .filter(Boolean)
    .map(sayLabel)
    .join(' точка ');
}

// ½ ⅓ ¼ ¾ ⅔ — как говорят: «половина», «треть», «четверть»
const VULGAR = {
  '½': 'половина',
  '⅓': 'треть',
  '¼': 'четверть',
  '¾': 'три четверти',
  '⅔': 'две трети',
  '⅕': 'одна пятая',
  '⅛': 'одна восьмая',
};

const MMHG = ['миллиметр', 'миллиметра', 'миллиметров'];
function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

function normalizeSymbols(input) {
  let t = String(input);

  // Почта: «orion@mail.ru» → «orion собака мейл точка ру»
  t = t.replace(/\b([\w.+-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi, (m, user, host) => `${user} собака ${speakDomain(host)}`);
  // Ссылки: с протоколом — всегда; без протокола — если в конце известная зона («ya.ru», «www.google.com»)
  t = t.replace(/\bhttps?:\/\/([^\s/?#]+)[^\s]*/gi, (m, host) => speakDomain(host));
  t = t.replace(/(?<![\w@.])((?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.([a-z]{2,4}))(\/[^\s]*)?(?![\w.])/giu, (m, host, tld) =>
    TLD.test(tld) ? speakDomain(host) : m,
  );
  // Кириллические домены: «госуслуги.рф» → «госуслуги точка эр-эф»
  t = t.replace(/(?<![\p{L}\d@.])([а-яё0-9-]+(?:\.[а-яё0-9-]+)*\.рф)(?![\p{L}\d])/giu, (m, host) => speakDomain(host));

  // Давление: «760 мм рт. ст.» → «760 миллиметров ртутного столба»
  t = t.replace(/(\d+)\s*мм\.?\s*рт\.?\s*ст\.?/g, (m, n) => `${n} ${plural(Number(n), MMHG)} ртутного столба`);

  // Приблизительно и точность: «~5 минут» → «около 5 минут», «≈ 20%» → «примерно 20%», «±2°» → «плюс-минус 2°»
  t = t.replace(/(^|[\s(])~\s*(?=\d)/g, '$1около ');
  t = t.replace(/≈\s*/g, 'примерно ');
  t = t.replace(/±\s*/g, 'плюс-минус ');

  // «&» между словами — «и»
  t = t.replace(/\s*&\s*/g, ' и ');

  // Юникодные дроби
  t = t.replace(/[½⅓¼¾⅔⅕⅛]/g, (c) => VULGAR[c]);

  return t;
}

module.exports = { normalizeSymbols };
