// Курсы: валюты — официальный курс ЦБ РФ, криптовалюты — CoinGecko.
// С суммой в аргументе («25 USD») — перевод в рубли: «а в рублях это?» после цены в долларах.
const { plural, money } = require('../lib/ru');

const CRYPTO = { BTC: 'bitcoin', ETH: 'ethereum', TON: 'the-open-network', USDT: 'tether', SOL: 'solana', XRP: 'ripple', DOGE: 'dogecoin' };
const CRYPTO_NAMES = { BTC: 'Биткоин', ETH: 'Эфир', TON: 'Тон', USDT: 'Тезер', SOL: 'Солана', XRP: 'Рипл', DOGE: 'Доджкоин' };
// Как сказать сумму: «25 долларов», «2,5 евро»
const FORMS = {
  USD: ['доллар', 'доллара', 'долларов'], EUR: ['евро', 'евро', 'евро'], CNY: ['юань', 'юаня', 'юаней'], GBP: ['фунт', 'фунта', 'фунтов'],
  KZT: ['тенге', 'тенге', 'тенге'], BYN: ['белорусский рубль', 'белорусских рубля', 'белорусских рублей'], UAH: ['гривна', 'гривны', 'гривен'],
  TRY: ['лира', 'лиры', 'лир'], JPY: ['иена', 'иены', 'иен'], CHF: ['франк', 'франка', 'франков'],
  BTC: ['биткоин', 'биткоина', 'биткоинов'], ETH: ['эфир', 'эфира', 'эфиров'], TON: ['тон', 'тона', 'тонов'],
};
const RUB = ['рубль', 'рубля', 'рублей'];

// «25 USD» → { amount: 25, code: 'USD' }; «USD» → { amount: null, code: 'USD' }; «1 000,5 EUR» → 1000.5
function parseArg(arg) {
  const code = (String(arg).match(/[a-z]{3,4}/i)?.[0] || 'USD').toUpperCase();
  const num = String(arg).match(/\d[\d\s]*(?:[.,]\d+)?/)?.[0];
  const amount = num ? Number(num.replace(/\s/g, '').replace(',', '.')) : null;
  return { code, amount: amount > 0 ? amount : null };
}

// Дробное число — всегда родительный падеж единственного: «2,5 доллара»
const counted = (n, [one, few, many]) => `${money(n)} ${Number.isInteger(n) ? plural(n, one, few, many) : few}`;
const rubles = (n) => counted(n >= 100 ? Math.round(n) : Math.round(n * 100) / 100, RUB);
const sum = (amount, code) => (FORMS[code] ? counted(amount, FORMS[code]) : `${money(amount)} ${code}`);

async function rate(arg) {
  const { code, amount } = parseArg(arg);

  if (CRYPTO[code]) {
    const id = CRYPTO[code];
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd,rub`, {
      signal: AbortSignal.timeout(6000),
    });
    const r = (await res.json())[id];
    if (!r) return `Нет данных по ${code}, сэр.`;
    if (amount) return `${sum(amount, code)} — это ${rubles(amount * r.rub)}.`;
    const usd = r.usd < 10 ? `${money(r.usd, 2)} доллара` : `${money(r.usd, 0)} ${plural(Math.round(r.usd), 'доллар', 'доллара', 'долларов')}`;
    const rub = Math.round(r.rub);
    return `${CRYPTO_NAMES[code]} сейчас стоит ${usd}, это ${money(rub, 0)} ${plural(rub, 'рубль', 'рубля', 'рублей')}.`;
  }

  if (code === 'RUB') return amount ? `Это и так ${rubles(amount)}, сэр.` : 'Рубль — это рубль, сэр.';
  const res = await fetch('https://www.cbr.ru/scripts/XML_daily.asp', { signal: AbortSignal.timeout(6000) });
  const xml = new TextDecoder('windows-1251').decode(await res.arrayBuffer());
  const block = xml.match(new RegExp(`<CharCode>${code}</CharCode>[\\s\\S]*?</Valute>`))?.[0];
  if (!block) return `ЦБ не публикует курс ${code}, сэр.`;
  const nominal = Number(block.match(/<Nominal>(\d+)/)[1]);
  const value = Number(block.match(/<Value>([\d,]+)/)[1].replace(',', '.'));
  const name = block.match(/<Name>([^<]+)/)[1];
  const date = xml.match(/Date="([^"]+)"/)?.[1];
  const when = !date || date === new Date().toLocaleDateString('ru-RU') ? 'на сегодня' : `на ${date}`;
  if (amount) return `${sum(amount, code)} — это ${rubles((amount * value) / nominal)} по курсу ЦБ ${when}.`;
  return `Курс ЦБ ${when}: ${nominal > 1 ? `${nominal} ` : ''}${name[0].toLowerCase() + name.slice(1)} — ${money(value)} рубля.`;
}

module.exports = {
  id: 'rates',
  title: 'курсы валют (ЦБ) и криптовалют, перевод суммы в рубли',
  keywords: ['курс', 'доллар', 'евро', 'юан', 'рубл', 'биткоин', 'bitcoin', 'эфир', 'крипт', 'валют', 'почем', 'тон '],
  rules: [
    'Перевести сумму в рубли — rate с числом и кодом ("25 USD"), а не calc. «А в рублях?» после цены в другой валюте — сумму и валюту бери из своего прошлого ответа.',
  ],
  tools: [
    {
      name: 'rate',
      speaks: true, // ответ всегда даёт сам инструмент
      use: 'курс валюты или криптовалюты; перевод суммы в рубли',
      arg: 'код валюты: USD, EUR, CNY, BTC, ETH, TON…; для перевода суммы — число и код: "25 USD"',
      examples: [
        ['почём доллар', { addressed: true, say: 'Уточняю курс.', actions: [{ tool: 'rate', arg: 'USD' }] }],
        ['сколько будет 40 евро в рублях', { addressed: true, say: '', actions: [{ tool: 'rate', arg: '40 EUR' }] }],
        ['а в рублях? (твой прошлый ответ: «Игра стоит 15 долларов»)', { addressed: true, say: '', actions: [{ tool: 'rate', arg: '15 USD' }] }],
      ],
      run: async (arg) => ({ ok: true, speak: await rate(arg) }),
    },
  ],
  parseArg,
};
