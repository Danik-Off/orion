// Курсы: валюты — официальный курс ЦБ РФ, криптовалюты — CoinGecko.
// С суммой в аргументе («25 USD») — перевод в рубли: «а в рублях это?» после цены в долларах.
const { plural, money } = require('../lib/ru');

const CRYPTO = { BTC: 'bitcoin', ETH: 'ethereum', TON: 'the-open-network', USDT: 'tether', SOL: 'solana', XRP: 'ripple', DOGE: 'dogecoin' };
const CRYPTO_NAMES = { BTC: 'Биткоин', ETH: 'Эфир', TON: 'Тон', USDT: 'Тезер', SOL: 'Солана', XRP: 'Рипл', DOGE: 'Доджкоин' };
// Как сказать сумму: «25 долларов», «2,5 евро»
const FORMS = {
  USD: ['доллар', 'доллара', 'долларов'],
  EUR: ['евро', 'евро', 'евро'],
  CNY: ['юань', 'юаня', 'юаней'],
  GBP: ['фунт', 'фунта', 'фунтов'],
  KZT: ['тенге', 'тенге', 'тенге'],
  BYN: ['белорусский рубль', 'белорусских рубля', 'белорусских рублей'],
  UAH: ['гривна', 'гривны', 'гривен'],
  TRY: ['лира', 'лиры', 'лир'],
  JPY: ['иена', 'иены', 'иен'],
  CHF: ['франк', 'франка', 'франков'],
  BTC: ['биткоин', 'биткоина', 'биткоинов'],
  ETH: ['эфир', 'эфира', 'эфиров'],
  TON: ['тон', 'тона', 'тонов'],
};
const RUB = ['рубль', 'рубля', 'рублей'];

// «25 USD» → { amount: 25, code: 'USD' }; «USD» → { amount: null, code: 'USD' }; «1 000,5 EUR» → 1000.5;
// «1000 RUB>USD» — перевести рубли в доллары: { amount: 1000, code: 'RUB', to: 'USD' }
function parseArg(arg) {
  const [left, right] = String(arg).split('>');
  const code = (left.match(/[a-z]{3,4}/i)?.[0] || 'USD').toUpperCase();
  const to = right?.match(/[a-z]{3,4}/i)?.[0]?.toUpperCase() || null;
  const num = left.match(/\d[\d\s]*(?:[.,]\d+)?/)?.[0];
  const amount = num ? Number(num.replace(/\s/g, '').replace(',', '.')) : null;
  return { code, amount: amount > 0 ? amount : null, ...(to && to !== code && { to }) };
}

// Дробное число — всегда родительный падеж единственного: «2,5 доллара»
const counted = (n, [one, few, many]) => `${money(n)} ${Number.isInteger(n) ? plural(n, one, few, many) : few}`;
const rubles = (n) => counted(n >= 100 ? Math.round(n) : Math.round(n * 100) / 100, RUB);
const sum = (amount, code) => (code === 'RUB' ? rubles(amount) : FORMS[code] ? counted(amount, FORMS[code]) : `${money(amount)} ${code}`);
// Сумма в чужой валюте: копейки не нужны у крупных сумм, у мелких — два знака (у крипты — больше)
const rounded = (n, code) => (CRYPTO[code] ? Number(n.toPrecision(4)) : n >= 100 ? Math.round(n) : Math.round(n * 100) / 100);

// Сервис ответил ошибкой — это не «нет связи» и не «нет такой валюты»: сказать как есть
class Unavailable extends Error {}
async function fetchOk(url, what) {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Unavailable(`${what} сейчас не отвечает, сэр. Попробуйте чуть позже.`);
  return res;
}

// Сколько рублей стоит единица валюты: { rub, name?, when? } или null — такой нет
async function rubPer(code, cache) {
  if (code === 'RUB') return { rub: 1 };
  if (CRYPTO[code]) {
    const id = CRYPTO[code];
    const res = await fetchOk(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd,rub`, 'Сервис курсов криптовалют');
    const r = (await res.json())[id];
    return r ? { rub: r.rub, usd: r.usd } : null;
  }
  cache.xml ??= await fetchOk('https://www.cbr.ru/scripts/XML_daily.asp', 'Сайт ЦБ').then(async (res) =>
    new TextDecoder('windows-1251').decode(await res.arrayBuffer()),
  );
  const block = cache.xml.match(new RegExp(`<CharCode>${code}</CharCode>[\\s\\S]*?</Valute>`))?.[0];
  if (!block) return null;
  const nominal = Number(block.match(/<Nominal>(\d+)/)[1]);
  const value = Number(block.match(/<Value>([\d,]+)/)[1].replace(',', '.'));
  const date = cache.xml.match(/Date="([^"]+)"/)?.[1];
  return {
    rub: value / nominal,
    nominal,
    value,
    name: block.match(/<Name>([^<]+)/)[1],
    when: !date || date === new Date().toLocaleDateString('ru-RU') ? 'на сегодня' : `на ${date}`,
  };
}

async function rate(arg) {
  try {
    return await rateNow(arg);
  } catch (err) {
    if (err instanceof Unavailable) return err.message;
    throw err; // сеть — общая обработка («нет связи с интернетом»)
  }
}

async function rateNow(arg) {
  const { code, amount, to } = parseArg(arg);
  const cache = {};

  // Перевод между валютами: «1000 рублей в долларах», «50 долларов в евро» — через рубль
  if (to) {
    const [from, into] = await Promise.all([rubPer(code, cache), rubPer(to, cache)]);
    if (!from) return `Не знаю курса ${code}, сэр.`;
    if (!into) return `Не знаю курса ${to}, сэр.`;
    const n = amount || 1;
    const result = rounded((n * from.rub) / into.rub, to);
    const source = CRYPTO[code] || CRYPTO[to] ? '' : ` по курсу ЦБ ${(code === 'RUB' ? into : from).when}`;
    return `${sum(n, code)} — это ${sum(result, to)}${source}.`;
  }

  if (code === 'RUB') return amount ? `Это и так ${rubles(amount)}, сэр.` : 'Рубль — это рубль, сэр.';
  const r = await rubPer(code, cache);
  if (!r) return CRYPTO[code] ? `Нет данных по ${code}, сэр.` : `ЦБ не публикует курс ${code}, сэр.`;
  if (CRYPTO[code]) {
    if (amount) return `${sum(amount, code)} — это ${rubles(amount * r.rub)}.`;
    const usd =
      r.usd < 10 ? `${money(r.usd, 2)} доллара` : `${money(r.usd, 0)} ${plural(Math.round(r.usd), 'доллар', 'доллара', 'долларов')}`;
    const rub = Math.round(r.rub);
    return `${CRYPTO_NAMES[code]} сейчас стоит ${usd}, это ${money(rub, 0)} ${plural(rub, 'рубль', 'рубля', 'рублей')}.`;
  }
  if (amount) return `${sum(amount, code)} — это ${rubles(amount * r.rub)} по курсу ЦБ ${r.when}.`;
  return `Курс ЦБ ${r.when}: ${r.nominal > 1 ? `${r.nominal} ` : ''}${r.name[0].toLowerCase() + r.name.slice(1)} — ${money(r.value)} рубля.`;
}

module.exports = {
  id: 'rates',
  needs: [],
  title: 'курсы валют (ЦБ) и криптовалют, перевод суммы в рубли и между валютами',
  keywords: ['курс', 'доллар', 'евро', 'юан', 'рубл', 'биткоин', 'bitcoin', 'эфир', 'крипт', 'валют', 'почем', 'тон '],
  rules: [
    'Перевести сумму в рубли — rate с числом и кодом ("25 USD"), а не calc. «А в рублях?» после цены в другой валюте — сумму и валюту бери из своего прошлого ответа.',
    'Рубли в другую валюту или одну валюту в другую — "СУММА ИЗ>В": «1000 рублей в долларах» → "1000 RUB>USD", «50 долларов в евро» → "50 USD>EUR".',
  ],
  tools: [
    {
      name: 'rate',
      speaks: true, // ответ всегда даёт сам инструмент
      use: 'курс валюты или криптовалюты; перевод суммы в рубли или в другую валюту',
      arg: 'код валюты: USD, EUR, CNY, BTC, ETH, TON…; сумма в рубли — "25 USD"; в другую валюту — "1000 RUB>USD", "50 USD>EUR"',
      examples: [
        ['почём доллар', { addressed: true, say: 'Уточняю курс.', actions: [{ tool: 'rate', arg: 'USD' }] }],
        ['сколько будет 40 евро в рублях', { addressed: true, say: '', actions: [{ tool: 'rate', arg: '40 EUR' }] }],
        ['сколько будет 1000 рублей в долларах', { addressed: true, say: '', actions: [{ tool: 'rate', arg: '1000 RUB>USD' }] }],
        [
          'а в рублях? (твой прошлый ответ: «Игра стоит 15 долларов»)',
          { addressed: true, say: '', actions: [{ tool: 'rate', arg: '15 USD' }] },
        ],
      ],
      run: async (arg) => ({ ok: true, speak: await rate(arg) }),
    },
  ],
  parseArg,
};
