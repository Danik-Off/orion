// Поиск без ключей и аккаунтов: выдача DuckDuckGo + чтение самих страниц,
// чтобы локальная модель отвечала по содержимому, а не по обрывкам сниппетов.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.6' };

const PAGES_TO_READ = 3;
const PAGE_CHARS = 2500;
const MAX_HTML = 1_500_000;

const isHttpUrl = (s) => {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

// Страницы из выдачи не должны указывать на локальную сеть и сам компьютер.
function isPublicUrl(s) {
  if (!isHttpUrl(s)) return false;
  const host = new URL(s).hostname.replace(/^\[|\]$/g, '');
  return !(
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.localhost') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '::1' ||
    /^f[cd]|^fe80/i.test(host)
  );
}

const ENTITIES = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  deg: '°',
  minus: '−',
};
const decodeEntities = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

const cleanText = (html, max = 300) =>
  decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

async function fetchText(url, timeout) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  if (!res.ok) return '';
  if (!/text\/html|xhtml/i.test(res.headers.get('content-type') || 'text/html')) return '';
  return (await res.text()).slice(0, MAX_HTML);
}

function unwrapDdgUrl(raw) {
  let url = decodeEntities(raw || '');
  const redirect = url.match(/[?&]uddg=([^&]+)/);
  if (redirect) url = decodeURIComponent(redirect[1]);
  if (url.startsWith('//')) url = 'https:' + url;
  return url;
}

function parseDdgHtml(html) {
  const results = [];
  for (const block of html.split(/class="result\s/).slice(1)) {
    const link = block.match(/<a([^>]*class="result__a"[^>]*)>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const url = unwrapDdgUrl(link[1].match(/href="([^"]+)"/)?.[1]);
    if (!isPublicUrl(url) || /duckduckgo\.com\/y\.js/.test(url)) continue; // реклама
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/);
    results.push({ title: cleanText(link[2]), snippet: snippet ? cleanText(snippet[1]) : '', url });
  }
  return results;
}

function parseDdgLite(html) {
  const results = [];
  const links = [...html.matchAll(/<a[^>]*class=['"]result-link['"][^>]*>[\s\S]*?<\/a>/g)];
  const snippets = [...html.matchAll(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)];
  links.forEach((m, i) => {
    const url = unwrapDdgUrl(m[0].match(/href=['"]([^'"]+)['"]/)?.[1]);
    if (!isPublicUrl(url) || /duckduckgo\.com\/y\.js/.test(url)) return;
    results.push({ title: cleanText(m[0]), snippet: snippets[i] ? cleanText(snippets[i][1]) : '', url });
  });
  return results;
}

async function searchWeb(query) {
  const q = encodeURIComponent(query);
  const sources = [
    [`https://html.duckduckgo.com/html/?q=${q}&kl=ru-ru`, parseDdgHtml],
    [`https://lite.duckduckgo.com/lite/?q=${q}&kl=ru-ru`, parseDdgLite], // запасное зеркало
  ];
  for (const [url, parse] of sources) {
    try {
      const results = parse(await fetchText(url, 8000));
      if (results.length) return results.slice(0, 6);
    } catch {}
  }
  return [];
}

// Основной текст страницы: абзацы, пункты списков, строки таблиц — без меню, скриптов и подвалов.
function extractMainText(html, query) {
  const body = html
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const blocks = [...body.matchAll(/<(p|li|td|th|h[1-4]|dd|blockquote|pre)[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => cleanText(m[2], 600))
    .filter((t) => t.length > 25);

  // Сначала абзацы, где есть слова из запроса, потом остальные по порядку.
  const words = query
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter((w) => w.length > 3)
    .map((w) => w.slice(0, 5));
  const relevance = (t) => words.reduce((n, w) => n + (t.toLowerCase().includes(w) ? 1 : 0), 0) + (/\d/.test(t) ? 0.5 : 0);
  const ranked = blocks.map((t, i) => ({ t, i, r: relevance(t) })).sort((a, b) => b.r - a.r || a.i - b.i);

  let out = '';
  for (const { t } of ranked) {
    if (out.length + t.length > PAGE_CHARS) break;
    out += t + '\n';
  }
  return out.trim();
}

// Поиск + чтение первых страниц параллельно. Медленные и «тяжёлые» страницы пропускаются.
async function research(query) {
  const results = await searchWeb(query);
  const pages = await Promise.all(
    results.slice(0, PAGES_TO_READ).map(async (r) => {
      try {
        return { ...r, text: extractMainText(await fetchText(r.url, 4000), query) };
      } catch {
        return { ...r, text: '' };
      }
    }),
  );
  return { results, pages: pages.filter((p) => p.text) };
}

const getJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Orion-assistant/1.0' } });
  if (!res.ok) throw new Error(`${new URL(url).hostname}: HTTP ${res.status}`);
  return res.json();
};

// Краткая справка из Википедии: первые предложения статьи.
async function wiki(query, lang = 'ru') {
  const s = await getJson(
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json`,
  );
  const title = s.query?.search?.[0]?.title;
  if (!title) return null;
  const p = await getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  if (!p.extract) return null;
  return {
    title: p.title,
    url: p.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    text: p.extract.slice(0, 2500),
  };
}

module.exports = { research, wiki, isHttpUrl, isPublicUrl, extractMainText };
