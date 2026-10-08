// Новости из RSS: свежие (за сутки) заголовки по теме, без повторов одного события из разных лент.
//   «главные новости», «что нового в спорте / игры / в мире», «новости про SpaceX» (любая тема — Google News),
//   «расскажи подробнее о второй» — пересказ самой статьи (отдельный вызов модели без инструментов).
// Заголовки читаются как есть (без пересказа моделью): быстро и без выдумок. Ленты можно заменить в config.json → news.
const { extractMainText, isPublicUrl } = require('../lib/websearch');

// Тема → ленты; category — взять из ленты только записи этой рубрики (одна или несколько)
const DEFAULT_FEEDS = {
  // РБК и Лента отдают текст статьи (в ленте или на странице) — есть что рассказать «подробнее»; ТАСС — быстрые
  // заголовки (его страницы закрыты от программ проверкой «вы не робот»)
  главное: [
    { url: 'https://rssexport.rbc.ru/rbcnews/news/30/full.rss' },
    { url: 'https://lenta.ru/rss/news' },
    { url: 'https://tass.ru/rss/v2.xml' },
  ],
  'в мире': [
    { url: 'https://tass.ru/rss/v2.xml', category: 'В мире' },
    { url: 'https://lenta.ru/rss/news', category: 'Мир' },
  ],
  политика: [{ url: 'https://tass.ru/rss/v2.xml', category: 'Политика' }],
  общество: [
    { url: 'https://tass.ru/rss/v2.xml', category: 'Общество' },
    { url: 'https://lenta.ru/rss/news', category: 'Моя страна' },
  ],
  происшествия: [{ url: 'https://tass.ru/rss/v2.xml', category: 'Происшествия' }],
  технологии: [
    { url: 'https://habr.com/ru/rss/news/?fl=ru' },
    { url: 'https://3dnews.ru/news/rss/' },
    { url: 'https://www.ixbt.com/export/news.rss' },
  ],
  наука: [
    { url: 'https://nplus1.ru/rss' },
    { url: 'https://naked-science.ru/feed' },
    { url: 'https://tass.ru/rss/v2.xml', category: 'Космос' },
  ],
  спорт: [{ url: 'https://www.championat.com/rss/news/' }, { url: 'https://lenta.ru/rss/news', category: 'Спорт' }],
  экономика: [
    { url: 'https://rssexport.rbc.ru/rbcnews/news/30/full.rss', category: ['Экономика', 'Финансы'] },
    { url: 'https://lenta.ru/rss/news', category: 'Экономика' },
  ],
  культура: [
    { url: 'https://lenta.ru/rss/news', category: 'Культура' },
    { url: 'https://tass.ru/rss/v2.xml', category: 'Культура' },
  ],
  игры: [{ url: 'https://stopgame.ru/rss/rss_news.xml' }, { url: 'https://www.igromania.ru/rss/news.xml' }],
  авто: [{ url: 'https://lenta.ru/rss/news', category: 'Авто' }],
};
const TOPICS = [
  [/в мире|мир(е|овы)|за рубеж|междунар/, 'в мире'],
  [/полит/, 'политика'],
  [/общест|в стране|в россии|росси/, 'общество'],
  [/происшеств|чп|авари|криминал/, 'происшествия'],
  [/техн|it|айти|гаджет|компьют|программ|ии\b|нейросет/, 'технологии'],
  [/наук|космос|учен/, 'наука'],
  [/спорт|футбол|хоккей|теннис|матч/, 'спорт'],
  [/эконом|бизнес|финанс|рын|бирж/, 'экономика'],
  [/культур|кино|фильм|сериал|музык|театр/, 'культура'],
  [/игр|гейм|steam|консол|playstation|xbox/, 'игры'],
  [/авто|машин|автомобил/, 'авто'],
];
const HOW_MANY = 5;
const FRESH_MS = 24 * 3600_000; // старше суток — не новости
const MORE_FOR_MS = 15 * 60_000; // «подробнее о второй» — пока список свежий в памяти

let last = null; // { at, topic, items } — последний прочитанный список, для «подробнее»
let detailed = null; // { item, at } — статья, которую только что пересказали: «да» — открыть её в браузере
const OPEN_YES_MS = 90_000; // «да» после «Открыть статью в браузере?» — пока вопрос свежий

const decode = (s) =>
  String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&laquo;|&raquo;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))) // &#171; → «
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const tag = (xml, name) => xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] || '';
// Полный текст статьи прямо в ленте (РБК, Яндекс-формат, WordPress) — читать страницу не нужно
const fullText = (item) => tag(item, 'rbc_news:full-text') || tag(item, 'yandex:full-text') || tag(item, 'content:encoded');
// Страница-заглушка вместо статьи: проверка «вы не робот», перенаправление
const BOT_WALL = /not a bot|captcha|подождите, выполняется|включите javascript|enable javascript|доступ ограничен/i;

// Ссылка Bing на статью: …/apiclick.aspx?…&url=<адрес статьи> → сам адрес
function directLink(link) {
  try {
    const u = new URL(link);
    return (/bing\.com$/.test(u.hostname) && u.searchParams.get('url')) || link;
  } catch {
    return link;
  }
}

// Лента → [{ title, link, description, full, date, category, source }]
async function fetchFeed({ url, category }, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(7000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${new URL(url).hostname}: HTTP ${res.status}`);
  const xml = await res.text();
  const wanted = category ? [].concat(category) : null;
  const source = new URL(url).hostname.replace(/^www\.|^rssexport\./, '');
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)]
    .map(([item]) => ({
      title: decode(tag(item, 'title')),
      link: directLink(decode(tag(item, 'link'))),
      description: decode(tag(item, 'description')).slice(0, 600),
      full: decode(fullText(item)).slice(0, 6000),
      date: Date.parse(decode(tag(item, 'pubDate'))) || 0,
      category: decode(tag(item, 'category')),
      source: decode(tag(item, 'source') || tag(item, 'News:Source')) || source,
    }))
    .filter((i) => i.title && (!wanted || wanted.includes(i.category)));
}

// Одно событие в разных лентах — один заголовок: больше половины значимых слов совпадает
const wordsOf = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .replace(/ё/g, 'е')
      .split(/[^a-zа-я0-9]+/)
      .filter((w) => w.length > 3)
      .map((w) => w.slice(0, 6)), // грубая основа: «выборов» и «выборы» — одно слово
  );
function sameEvent(a, b) {
  const A = wordsOf(a);
  const B = wordsOf(b);
  if (!A.size || !B.size) return false;
  const common = [...A].filter((w) => B.has(w)).length;
  return common / Math.min(A.size, B.size) > 0.5;
}

// Ленты → свежие заголовки по очереди из каждой, без повторов
function pick(lists, { now = Date.now(), howMany = HOW_MANY } = {}) {
  const fresh = lists.map((l) => l.filter((i) => !i.date || now - i.date < FRESH_MS));
  const source = fresh.some((l) => l.length) ? fresh : lists; // за сутки ничего — хоть последние
  const out = [];
  for (let i = 0; out.length < howMany && source.some((l) => l[i]); i++) {
    for (const l of source) {
      const item = l[i];
      if (item && out.length < howMany && !out.some((o) => sameEvent(o.title, item.title))) out.push(item);
    }
  }
  return out;
}

const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 3)}…` : s).replace(/[.!?…]?$/, '.');
const ORDINAL = ['Первое', 'Второе', 'Третье', 'Четвёртое', 'Пятое'];

function remember(topic, items) {
  last = { at: Date.now(), topic, items };
}

function speakList(heading, items) {
  return `${heading}. ${items.map((i, n) => `${ORDINAL[n] || `${n + 1}-е`}: ${clip(i.title)}`).join(' ')} Рассказать подробнее о какой-нибудь?`;
}

async function news(arg, ctx) {
  const feeds = { ...DEFAULT_FEEDS, ...(ctx.config.news || {}) };
  const t = String(arg).toLowerCase().trim();
  const topic = feeds[t] ? t : TOPICS.find(([re]) => re.test(t))?.[1] || 'главное';
  const lists = await Promise.all((feeds[topic] || feeds.главное).map((f) => fetchFeed(f).catch(() => [])));
  const items = pick(lists);
  if (!items.length) return { ok: false, message: 'Не удалось получить новости, сэр.' };
  remember(topic, items);
  return { ok: true, speak: speakList(topic === 'главное' ? 'Главные новости' : `Новости, ${topic}`, items) };
}

// Поиск новостей: Bing (прямые ссылки на статьи — есть что рассказать «подробнее»), не вышло — Google News
const SEARCH = [
  (q) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=ru-RU&cc=RU&mkt=ru-RU`,
  (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:7d`)}&hl=ru&gl=RU&ceid=RU:ru`,
];

async function searchNews(q, options) {
  for (const url of SEARCH) {
    const found = await fetchFeed({ url: url(q) }, options).catch(() => []);
    if (found.length) return found.map((i) => ({ ...i, title: i.title.replace(/\s+-\s+[^-]+$/, '') })); // «Заголовок - Источник»
  }
  return [];
}

// Новости про что угодно: компанию, человека, событие, город
async function newsAbout(arg) {
  const q = String(arg || '').trim();
  if (!q) return { ok: false, message: 'Про что найти новости, сэр?' };
  const items = pick([await searchNews(q)], { howMany: 4 });
  if (!items.length) return { ok: true, speak: `Свежих новостей про ${q} не нашёл, сэр.` };
  remember(q, items);
  return { ok: true, speak: speakList(`Новости про ${q}`, items) };
}

// «Подробнее о второй» / «о последней» / «про выборы»: какая из прочитанных
function which(arg, items) {
  const a = String(arg || '')
    .toLowerCase()
    .replace(/ё/g, 'е');
  const ord = [/перв|1/, /втор|2/, /трет|3/, /четв|4/, /пят|5/].findIndex((re) => re.test(a));
  if (ord >= 0) return items[ord];
  if (/послед/.test(a)) return items.at(-1);
  const scored = items.map((i) => ({ i, n: [...wordsOf(a)].filter((w) => wordsOf(i.title).has(w)).length })).sort((x, y) => y.n - x.n);
  return scored[0]?.n ? scored[0].i : items[0];
}

async function newsMore(arg, ctx, request = {}) {
  if (!last || Date.now() - last.at > MORE_FOR_MS) return { ok: false, message: 'Сначала спросите новости, сэр.' };
  const item = which(arg, last.items);
  // Текст статьи: полный — из ленты; нет — со страницы (только публичные адреса, не заглушка «вы не робот»);
  // не вышло — описание из ленты
  let text = item.full || item.description;
  if (!item.full && item.link && isPublicUrl(item.link) && !/news\.google\.com/.test(item.link)) {
    try {
      const res = await fetch(item.link, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      const page = res.ok ? extractMainText(await res.text(), item.title) : '';
      if (page.length >= 300 && !BOT_WALL.test(page.slice(0, 300))) text = page.slice(0, 6000);
    } catch {}
  }
  detailed = { item, at: Date.now() }; // «да» / «открой в браузере» — про эту статью
  const offer = item.link ? ' Открыть статью в браузере?' : '';
  if (!text) return { ok: true, speak: `${clip(item.title)} Подробностей в ленте нет, сэр.${offer}` };
  const summary = await ctx.llm
    ?.answer?.(request.text || `Перескажи коротко новость: ${item.title}`, `Заголовок: ${item.title}\n\n${text}`)
    .catch(() => '');
  return {
    ok: true,
    speak: `${(summary || clip(text, 400)).trim()}${offer}`,
    sources: item.link ? [{ title: item.title, url: item.link }] : undefined,
  };
}

// Открыть статью в браузере: только что пересказанную или названную из прочитанного списка («вторую»)
async function newsOpen(arg, ctx) {
  const a = String(arg || '').trim();
  const item =
    (a && last && Date.now() - last.at < MORE_FOR_MS && which(a, last.items)) ||
    (detailed && Date.now() - detailed.at < MORE_FOR_MS && detailed.item) ||
    (last && Date.now() - last.at < MORE_FOR_MS && last.items[0]);
  if (!item) return { ok: false, message: 'Сначала спросите новости, сэр.' };
  if (!item.link) return { ok: false, message: 'У этой новости нет ссылки, сэр.' };
  await ctx.openExternal(item.link);
  detailed = null;
  return { ok: true, speak: 'Открываю статью.' };
}

const norm = (text) =>
  String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-яa-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Тема целиком («спорта», «в мире», «игр») — своя лента; что-то уже («футбола», «Apple», «выборов в Японии») —
// поиск: спросивший про футбол не хочет слушать про теннис
function newsPlan(raw) {
  // «в мире технологий», «в сфере спорта» — это тема «технологии», «спорт», а не поиск по словам «мире технологий»
  const subject = raw.replace(/^(?:(?:в|во) )?(?:мире|сфере|области|теме) (?=\S)/, '');
  const topic = TOPICS.find(([re]) => re.test(subject))?.[1];
  const wholeTopic =
    topic &&
    (subject.split(' ').length === 1 || /^(в|во) мире$|^в стране$|^в россии$/.test(subject)) &&
    !/футбол|хоккей|теннис|матч|кино|фильм|сериал|музык|steam|playstation|xbox/.test(subject);
  return wholeTopic ? { tool: 'news', arg: topic } : { tool: 'news_about', arg: subject };
}

// Частые фразы — без модели
function quick(text) {
  const t = norm(text);
  if (/^(какие |главные |последние |свежие )?новости( сегодня| дня)?$|^что (нового|происходит) в мире$/.test(t))
    return { addressed: true, say: '', actions: [{ tool: 'news', arg: 'главное' }] };
  // «новости про SpaceX», «новости футбола», «что пишут о выборах», «что слышно про Apple», «что нового у Tesla»
  const about =
    t.match(/^(?:какие |последние |свежие )?новости (?:(?:про|о|об|по|из|в|во) )?(.+)$/) ||
    t.match(/^что (?:пишут|говорят|слышно|нового) (?:про|о|об|у|в|по) (.+)$/);
  // «что нового у тебя», «что нового в обновлении» — это про самого Ориона (навык updates), не новости;
  // «что пишут в документации React» — справка, а не новости
  if (about && !/^(тебя|вас|меня|нас)$|обновлен|верси|документац|инструкци|справк|readme|вики/.test(about[1])) {
    return { addressed: true, say: '', actions: [newsPlan(about[1].trim())] };
  }
  const fresh = last && Date.now() - last.at < MORE_FOR_MS;
  // «Открыть статью в браузере?» — «да», «давай», «открой»
  if (
    detailed &&
    Date.now() - detailed.at < OPEN_YES_MS &&
    /^(да|ага|давай|конечно|открой|открывай|хочу)( (ее|её|открой|статью|в браузере))*$/.test(t)
  )
    return { addressed: true, say: '', actions: [{ tool: 'news_open', arg: '' }] };
  // «открой эту новость в браузере», «открой вторую новость», «покажи статью»
  const open = t.match(
    /^(?:открой|покажи)(?: мне)? (?:(эту|ее|её|первую|вторую|третью|четвертую|пятую|последнюю) )?(?:новость|статью|новости)(?: в браузере)?$/,
  );
  if (open && (fresh || detailed))
    return { addressed: true, say: '', actions: [{ tool: 'news_open', arg: /эту|ее|её/.test(open[1] || '') ? '' : open[1] || '' }] };
  const more =
    t.match(/^(?:расскажи |а )?(?:подробнее|поподробнее|подробней)(?: (?:о|об|про|по))? ?(.*)$/) ||
    t.match(/^(?:да )?(?:давай )?(?:расскажи|а) (?:про|о|об) (первую|вторую|третью|четвертую|пятую|последнюю)(?: новост\S*)?$/);
  if (more && fresh) return { addressed: true, say: '', actions: [{ tool: 'news_more', arg: more[1] || 'первой' }] };
  return null;
}

module.exports = {
  id: 'news',
  needs: [],
  title: 'свежие новости: по теме (главное, в мире, спорт, технологии, игры…), про что угодно, подробнее о новости',
  keywords: ['новост', 'что нового', 'что случилось', 'что происходит в мире', 'заголовк', 'подробнее', 'статью'],
  quick,
  rules: [
    'news — лента свежих заголовков по теме. news_about — новости про конкретное (компанию, человека, событие).',
    'Конкретный вопрос («кто выиграл», «сколько стоит») — web_search. «Подробнее о второй» после новостей — news_more.',
    '«Открой эту новость в браузере», «да» после «Открыть статью в браузере?» — news_open.',
  ],
  tools: [
    {
      name: 'news',
      speaks: true, // ответ всегда даёт сам инструмент
      use: 'свежие новости по теме',
      arg: 'тема',
      argEnum: Object.keys(DEFAULT_FEEDS),
      examples: [['что нового в мире технологий', { addressed: true, say: '', actions: [{ tool: 'news', arg: 'технологии' }] }]],
      run: news,
    },
    {
      name: 'news_about',
      speaks: true,
      filler: 'Сейчас поищу.',
      use: 'свежие новости про конкретное: компанию, человека, событие, город',
      arg: 'про что искать новости',
      llmArg: true,
      examples: [['что слышно про spacex', { addressed: true, say: '', actions: [{ tool: 'news_about', arg: 'SpaceX' }] }]],
      run: newsAbout,
    },
    {
      name: 'news_more',
      speaks: true,
      filler: 'Сейчас прочитаю.',
      use: 'подробнее об одной из только что прочитанных новостей',
      arg: 'какая: «первая», «вторая», «последняя» или о чём она',
      examples: [['расскажи подробнее о второй', { addressed: true, say: '', actions: [{ tool: 'news_more', arg: 'вторая' }] }]],
      run: newsMore,
    },
    {
      name: 'news_open',
      speaks: true,
      use: 'открыть в браузере статью — только что пересказанную или одну из прочитанных',
      arg: 'пусто — только что пересказанную; или какую: «вторая», «последняя»',
      examples: [['открой эту новость в браузере', { addressed: true, say: '', actions: [{ tool: 'news_open', arg: '' }] }]],
      run: newsOpen,
    },
  ],
  fetchFeed,
  _test: {
    pick,
    sameEvent,
    which,
    quick,
    remember: (items) => remember('главное', items),
    forget: () => ((last = null), (detailed = null)),
    DEFAULT_FEEDS,
  },
};
