// Новости из RSS: главное, технологии, наука, спорт, экономика. Ленты можно заменить в config.json → news.
// Заголовки читаются как есть (без пересказа моделью): быстро и без выдумок.
const DEFAULT_FEEDS = {
  главное: [{ url: 'https://tass.ru/rss/v2.xml' }],
  технологии: [{ url: 'https://habr.com/ru/rss/news/?fl=ru' }, { url: 'https://www.ixbt.com/export/news.rss' }],
  наука: [{ url: 'https://nplus1.ru/rss' }, { url: 'https://naked-science.ru/feed' }],
  спорт: [{ url: 'https://lenta.ru/rss/news', category: 'Спорт' }],
  экономика: [{ url: 'https://lenta.ru/rss/news', category: 'Экономика' }],
};
const TOPICS = [
  [/техн|it|айти|гаджет|компьют|программ/, 'технологии'],
  [/наук|космос|учен/, 'наука'],
  [/спорт|футбол|хоккей/, 'спорт'],
  [/эконом|бизнес|финанс|рын/, 'экономика'],
];
const HOW_MANY = 4;

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&laquo;|&raquo;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();

async function fetchFeed({ url, category }) {
  const res = await fetch(url, { signal: AbortSignal.timeout(7000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${new URL(url).hostname}: HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)]
    .map((m) => ({
      title: decode(m[0].match(/<title>([\s\S]*?)<\/title>/)?.[1] || ''),
      category: decode(m[0].match(/<category>([\s\S]*?)<\/category>/)?.[1] || ''),
    }))
    .filter((i) => i.title && (!category || i.category === category));
}

async function news(arg, ctx) {
  const feeds = { ...DEFAULT_FEEDS, ...(ctx.config.news || {}) };
  const t = String(arg).toLowerCase();
  const topic = feeds[t] ? t : TOPICS.find(([re]) => re.test(t))?.[1] || 'главное';
  const lists = await Promise.all((feeds[topic] || feeds.главное).map((f) => fetchFeed(f).catch(() => [])));
  // По очереди из каждой ленты, без повторов
  const titles = [];
  for (let i = 0; titles.length < HOW_MANY && lists.some((l) => l[i]); i++) {
    for (const l of lists) if (l[i] && !titles.includes(l[i].title) && titles.length < HOW_MANY) titles.push(l[i].title);
  }
  if (!titles.length) return { ok: false, message: 'Не удалось получить новости, сэр.' };
  const clip = (s) => (s.length > 160 ? `${s.slice(0, 157)}…` : s).replace(/[.!?…]?$/, '.');
  return { ok: true, speak: `${topic === 'главное' ? 'Главные новости' : `Новости, ${topic}`}: ${titles.map(clip).join(' ')}` };
}

module.exports = {
  id: 'news',
  title: 'лента свежих заголовков по теме (главное, технологии, наука, спорт, экономика) — не ответ на конкретный вопрос',
  keywords: ['новост', 'что нового', 'что случилось', 'что происходит в мире', 'заголовк'],
  rules: ['news — лента свежих заголовков по теме. Конкретный вопрос («кто выиграл», «сколько стоит», «что случилось с …») — web_search.'],
  tools: [
    {
      name: 'news',
      speaks: true, // ответ всегда даёт сам инструмент
      use: 'свежие новости по теме',
      arg: 'тема',
      argEnum: ['главное', 'технологии', 'наука', 'спорт', 'экономика'],
      examples: [['что нового в мире технологий', { addressed: true, say: 'Сейчас.', actions: [{ tool: 'news', arg: 'технологии' }] }]],
      run: news,
    },
  ],
  fetchFeed,
};
