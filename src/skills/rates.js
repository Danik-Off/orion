// Курсы: валюты — официальный курс ЦБ РФ, криптовалюты — CoinGecko.
const { plural, money } = require('../lib/ru');

const CRYPTO = { BTC: 'bitcoin', ETH: 'ethereum', TON: 'the-open-network', USDT: 'tether', SOL: 'solana', XRP: 'ripple', DOGE: 'dogecoin' };
const CRYPTO_NAMES = { BTC: 'Биткоин', ETH: 'Эфир', TON: 'Тон', USDT: 'Тезер', SOL: 'Солана', XRP: 'Рипл', DOGE: 'Доджкоин' };

async function rate(arg) {
  const code = (arg.match(/[a-z]{3,4}/i)?.[0] || 'USD').toUpperCase();

  if (CRYPTO[code]) {
    const id = CRYPTO[code];
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd,rub`, {
      signal: AbortSignal.timeout(6000),
    });
    const r = (await res.json())[id];
    if (!r) return `Нет данных по ${code}, сэр.`;
    const usd = r.usd < 10 ? `${money(r.usd, 2)} доллара` : `${money(r.usd, 0)} ${plural(Math.round(r.usd), 'доллар', 'доллара', 'долларов')}`;
    const rub = Math.round(r.rub);
    return `${CRYPTO_NAMES[code]} сейчас стоит ${usd}, это ${money(rub, 0)} ${plural(rub, 'рубль', 'рубля', 'рублей')}.`;
  }

  const res = await fetch('https://www.cbr.ru/scripts/XML_daily.asp', { signal: AbortSignal.timeout(6000) });
  const xml = new TextDecoder('windows-1251').decode(await res.arrayBuffer());
  const block = xml.match(new RegExp(`<CharCode>${code}</CharCode>[\\s\\S]*?</Valute>`))?.[0];
  if (!block) return `ЦБ не публикует курс ${code}, сэр.`;
  const nominal = Number(block.match(/<Nominal>(\d+)/)[1]);
  const value = Number(block.match(/<Value>([\d,]+)/)[1].replace(',', '.'));
  const name = block.match(/<Name>([^<]+)/)[1];
  const date = xml.match(/Date="([^"]+)"/)?.[1];
  const when = !date || date === new Date().toLocaleDateString('ru-RU') ? 'на сегодня' : `на ${date}`;
  return `Курс ЦБ ${when}: ${nominal > 1 ? `${nominal} ` : ''}${name[0].toLowerCase() + name.slice(1)} — ${money(value)} рубля.`;
}

module.exports = {
  id: 'rates',
  title: 'курсы валют (ЦБ) и криптовалют',
  keywords: ['курс', 'доллар', 'евро', 'юан', 'рубл', 'биткоин', 'bitcoin', 'эфир', 'крипт', 'валют', 'почем', 'тон '],
  tools: [
    {
      name: 'rate',
      speaks: true, // ответ всегда даёт сам инструмент
      use: 'курсы валют и криптовалют',
      arg: 'код валюты: USD, EUR, CNY, BTC, ETH, TON…',
      examples: [['почём доллар', { addressed: true, say: 'Уточняю курс.', actions: [{ tool: 'rate', arg: 'USD' }] }]],
      run: async (arg) => ({ ok: true, speak: await rate(arg) }),
    },
  ],
};
