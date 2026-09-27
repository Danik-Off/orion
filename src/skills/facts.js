// Факты из Википедии вместо выдуманных: «расскажи что-нибудь интересное», «что было в этот день»,
// «расскажи про эту песню / группу» (что сейчас играет → Википедия или поиск).
// Модель только пересказывает найденное (llm.answer — без инструментов, найденный текст — данные, не команды).
const media = require('../lib/media');
const { wiki, research } = require('../lib/websearch');
const { speakable } = require('./music');

const HEADERS = { 'User-Agent': 'Orion/0.1 (voice assistant)' };
const getJson = async (url) => {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(7000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname}: HTTP ${res.status}`);
  return res.json();
};
const strip = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#160;|&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s*\(на илл\.\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Первое предложение статьи без скобок с датами и произношением: «Pulp — британская группа, основанная в 1978 году.»
const firstSentence = (text) =>
  (String(text)
    .replace(/\s*\([^()]*\)/g, '')
    .match(/^.{20,300}?[.!?](?=\s+[А-ЯЁA-Z«]|$)/s)?.[0] || '').trim();

const told = new Set(); // уже рассказанное — чтобы не повторяться (как с «тремя сердцами осьминога»)
const pickNew = (list, key) => {
  const fresh = list.filter((x) => !told.has(key(x)));
  const pick = (fresh.length ? fresh : list)[Math.floor(Math.random() * (fresh.length || list.length))];
  if (pick) told.add(key(pick));
  return pick;
};

// «Знаете ли вы» с главной страницы русской Википедии: анонс + статья, на которую он ссылается
async function didYouKnow() {
  const r = await getJson(
    `https://ru.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent('Шаблон:Знаете ли вы')}&prop=text&format=json&formatversion=2`,
  );
  const items = [...String(r.parse?.text || '').matchAll(/<li>([\s\S]*?)<\/li>/g)]
    .map((m) => ({ text: strip(m[1]), title: m[1].match(/<b>\s*<a [^>]*title="([^"]+)"/)?.[1] || m[1].match(/<a [^>]*title="([^"]+)"/)?.[1] }))
    // служебные пункты шаблона («не вносите правок…») — не факты
    .filter((i) => i.title && i.text.length > 25 && !/шаблон|правк|консенсус|обсуждени|просмотр/i.test(i.text));
  return pickNew(items, (i) => i.text);
}

async function onThisDay(now = new Date()) {
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const r = await getJson(`https://api.wikimedia.org/feed/v1/wikipedia/ru/onthisday/events/${mm}/${dd}`);
  return pickNew(r.events || [], (e) => e.text);
}

// arg: '' — интересный факт; 'сегодня' — событие этого дня в истории; иначе тема («космос», «осьминоги»)
async function fact(arg, ctx, request = {}) {
  const a = String(arg).trim().toLowerCase();
  // «Расскажи про эту группу / о чём эта песня» — это про то, что играет, а не случайный факт
  const aboutNow = String(request.text || '').toLowerCase().match(/(?:эт[аоуий]\S*|играющ\S*)\s+(песн|трек|групп|исполнител|артист)/);
  if (aboutNow || /^(песня|трек|группа|исполнитель)$/.test(a)) {
    return aboutPlaying(/песн|трек/.test(aboutNow?.[1] || a) ? 'песня' : 'исполнитель', ctx);
  }
  if (/^(сегодня|в этот день|today)/.test(a)) {
    const e = await onThisDay();
    if (!e) return { ok: false, message: 'Не нашёл событий этого дня, сэр.' };
    return { ok: true, speak: `В этот день в ${e.year} году ${e.text.replace(/\s*\([^)]*\)/g, '').replace(/\.$/, '')}.` };
  }
  if (a && !/^(любой|что-нибудь|интересн|random)/.test(a)) {
    const w = await wiki(a).catch(() => null);
    if (!w) return { ok: false, message: `В Википедии не нашёл ничего про «${arg}», сэр.` };
    const speak = await ctx.llm.answer(`Расскажи один самый интересный факт про «${w.title}» в 2–3 предложениях`, w.text);
    return { ok: true, speak: speak.trim(), sources: [{ title: w.title, url: w.url, snippet: '' }] };
  }
  const item = await didYouKnow().catch(() => null);
  if (!item) {
    const e = await onThisDay().catch(() => null); // запасной источник
    return e ? { ok: true, speak: `В этот день в ${e.year} году ${e.text.replace(/\.$/, '')}.` } : { ok: false, message: 'Википедия сейчас не отвечает, сэр.' };
  }
  // Анонс — дословно (пересказ моделью искажал смысл), пояснение — первое предложение статьи
  const w = await wiki(item.title).catch(() => null);
  const intro = w ? firstSentence(w.text) : '';
  return {
    ok: true,
    speak: `Знаете ли вы: ${item.text}${intro ? ` ${intro}` : ''}`,
    sources: w ? [{ title: w.title, url: w.url, snippet: '' }] : undefined,
  };
}

// «Расскажи про эту песню / группу»: что играет → статья в Википедии, иначе поиск
async function aboutPlaying(arg, ctx) {
  const list = await media.sessions().catch(() => []);
  const now = list.find((s) => s.status === 'Playing') || list[0];
  if (!now?.title) return { ok: false, message: 'Сейчас ничего не играет, сэр.' };
  // Ролики обычно называются «ИСПОЛНИТЕЛЬ - ПЕСНЯ (Official Video)»; поле artist есть не всегда
  const [, left, right] = now.title.match(/^(.+?)\s+[-–—]\s+(.+)$/) || [];
  const artist = (now.artist || left || '').replace(/\s+(feat\.?|ft\.?|x|&)\s.*$/i, '').trim();
  const song = speakable(right || now.title);
  const aboutSong = /песн|трек|song/i.test(arg) || !artist;
  const subject = aboutSong ? `${song}${artist ? ` ${artist}` : ''}` : artist;
  const question = aboutSong
    ? `Что известно о песне «${song}»${artist ? ` (${artist})` : ''}? Кто исполняет, когда вышла, о чём. Называй только то, что есть в найденном; чего нет — пропусти.`
    : `Кто такие «${artist}»? Откуда, в каком жанре, чем известны. Называй только то, что есть в найденном.`;

  const w = await wiki(subject).catch(() => null);
  const key = (aboutSong ? song : artist).toLowerCase();
  const relevant = w && (w.title.toLowerCase().includes(key) || w.text.toLowerCase().includes(key));
  let context = relevant ? `Статья «${w.title}»:\n${w.text}` : null;
  let sources = relevant ? [{ title: w.title, url: w.url, snippet: '' }] : undefined;
  if (!context) {
    const { results, pages } = await research(aboutSong ? `${subject} песня` : `${artist} группа`).catch(() => ({ results: [], pages: [] }));
    context = pages.length ? pages.map((p, i) => `[${i + 1}] ${p.title}\n${p.text}`).join('\n\n') : null;
    sources = results.length ? results : undefined;
  }
  if (!context) return { ok: false, message: `Не нашёл сведений про «${subject}», сэр.` };
  return { ok: true, speak: (await ctx.llm.answer(question, context)).trim(), sources };
}

module.exports = {
  id: 'facts',
  title: 'интересные факты из Википедии, что было в этот день в истории, рассказ про песню или группу, которая сейчас играет',
  keywords: ['интересн', 'факт', 'знаете ли', 'в этот день', 'википеди', 'эту песню', 'эта песня', 'этой песне', 'эту группу', 'этой группе', 'этого исполнителя', 'кто поет', 'кто исполняет', 'что за песня', 'что за группа'],
  rules: [
    '«Расскажи что-нибудь интересное», «какой-нибудь факт» — fact: факты не выдумывай, бери из Википедии.',
    '«Расскажи про эту песню / группу / исполнителя» (то, что сейчас играет) — about_playing, а не ответ по памяти.',
  ],
  tools: [
    {
      name: 'fact',
      speaks: true, // ответ всегда даёт сам инструмент
      use: 'интересный факт из Википедии; «в этот день» в истории; интересное на тему',
      arg: 'пусто — случайный факт; "сегодня" — событие этого дня; или тема ("космос")',
      filler: 'Сейчас найду.', // Википедия отвечает около секунды
      examples: [
        ['расскажи что-нибудь интересное', { addressed: true, say: '', actions: [{ tool: 'fact', arg: '' }] }],
        ['что интересного было в этот день', { addressed: true, say: '', actions: [{ tool: 'fact', arg: 'сегодня' }] }],
      ],
      run: fact,
    },
    {
      name: 'about_playing',
      speaks: true, // ответ всегда даёт сам инструмент
      use: 'рассказать про песню или исполнителя, которые сейчас играют',
      arg: '"исполнитель" или "песня"',
      argEnum: ['исполнитель', 'песня'],
      filler: 'Сейчас узнаю.',
      examples: [['что это за группа играет', { addressed: true, say: 'Сейчас узнаю.', actions: [{ tool: 'about_playing', arg: 'исполнитель' }] }]],
      run: aboutPlaying,
    },
  ],
  firstSentence,
};
