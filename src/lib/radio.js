// Каталог интернет-радио radio-browser.info: открытый, без ключа, десятки тысяч станций, русские — по-русски
// («Европа Плюс», «Маяк», «Радио Дача»). Ищем по названию или по жанру; берём потоки, которые окно играет
// само (MP3, AAC, OGG — не HLS), самые популярные первыми. Серверов каталога несколько — если один не отвечает,
// спрашиваем следующий.
const SERVERS = ['de1', 'de2', 'fi1', 'nl1', 'at1'].map((s) => `https://${s}.api.radio-browser.info`);
const HEADERS = { 'User-Agent': 'orion-assistant' };
const PLAYABLE = /^(mp3|aac|aac\+|ogg|opus|flac)$/i;

// Жанры по-русски → теги каталога
const GENRES = [
  [/джаз|jazz/, 'jazz'],
  [/метал|metal/, 'metal'],
  [/рок|rock/, 'rock'],
  [/блюз|blues/, 'blues'],
  [/регги|reggae/, 'reggae'],
  [/кантри|country/, 'country'],
  [/техно|techno/, 'techno'],
  [/транс|trance/, 'trance'],
  [/лоу.?фай|lo.?fi/, 'lofi'],
  [/инди|indie/, 'indie'],
  [/ретро|олдис|oldies|старые хиты/, 'oldies'],
  [/класси/, 'classical'],
  [/лаунж|lounge|чил|chill|расслаб|спокойн|релакс/, 'chillout'],
  [/сна|сон|засып|медитац|природ|эмбиент|ambient/, 'ambient'],
  [/поп|pop|хит/, 'pop'],
  [/электрон|танц|dance|house|хаус|edm/, 'dance'],
  [/хип.?хоп|рэп|rap|hip.?hop/, 'hip-hop'],
  [/80|восьмидесят/, '80s'],
  [/90|девяност/, '90s'],
  [/шансон/, 'chanson'],
  [/детск/, 'children'],
  [/новост|разговор|talk/, 'news'],
  [/русск|русская|наш/, 'russian'],
];
const genreOf = (text) => GENRES.find(([re]) => re.test(String(text).toLowerCase()))?.[1] || null;

async function api(path, { fetchImpl = fetch } = {}) {
  let last;
  for (const base of SERVERS) {
    try {
      const res = await fetchImpl(`${base}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(6000) });
      if (res.ok) return await res.json();
      last = new Error(`каталог радио: ${res.status}`);
    } catch (err) {
      last = err;
    }
  }
  throw last || new Error('каталог радио недоступен');
}

// Станция пригодна: поток, который окно сыграет само, и живая (не помечена неработающей)
const playable = (s) => s && s.url_resolved && PLAYABLE.test(String(s.codec || '').trim()) && s.hls !== 1 && s.lastcheckok !== 0;

// Похожесть названия на запрос: «маяк» → «Радио Маяк» лучше, чем «Маяк Новосибирск»
function rank(stations, query) {
  const q = String(query || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .trim();
  const score = (s) => {
    const name = s.name
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/^(радио|radio)\s*/, '')
      .trim();
    const base = q.replace(/^(радио|radio)\s*/, '');
    let p = 0;
    if (base && name === base) p += 3;
    else if (base && name.startsWith(base)) p += 2;
    if (s.countrycode === 'RU') p += 1;
    if (/\d{2,3}[.,]\d/.test(s.name)) p -= 0.5; // «Европа Плюс Полоцк 104.1» — местная, а не основная
    // Популярность весомее: основной канал слушают больше, чем его ответвления («Record» → не «record rock»)
    return p + Math.log10((s.clickcount || 0) + 1) / 2;
  };
  return [...stations].sort((a, b) => score(b) - score(a));
}

// Станции по запросу, лучшие первыми: query — название («Европа Плюс») или жанр («джаз»); пусто — популярные русские.
// byName — нашлись по названию (иначе — по жанру)
async function findStations(query, options = {}) {
  const q = String(query || '').trim();
  const params = new URLSearchParams({ order: 'clickcount', reverse: 'true', limit: '30', hidebroken: 'true' });
  // Сначала — станция с таким названием («Русское радио» — станция, а не жанр «русская музыка»)
  let list = [];
  let byName = true;
  if (q)
    list = (
      await api(
        `/json/stations/search?${new URLSearchParams({ ...Object.fromEntries(params), name: q.replace(/^радио\s+/i, '') })}`,
        options,
      )
    ).filter(playable);
  // Каталог ищет по части слова («рок» → «Роксана») — засчитываем, только если все слова запроса есть целиком
  const wordsOf = (x) =>
    String(x)
      .toLowerCase()
      .replace(/ё/g, 'е')
      .split(/[^a-zа-я0-9]+/)
      .filter(Boolean);
  const want = wordsOf(q.replace(/^радио\s+/i, ''));
  list = list.filter((st) => {
    const have = new Set(wordsOf(st.name));
    return want.every((w) => have.has(w));
  });
  // Нет такой — жанр («джаз», «для сна»); пусто — популярное русское
  const genre = genreOf(q);
  if (!list.length && (genre || !q)) {
    byName = false;
    const tag = new URLSearchParams({ ...Object.fromEntries(params), tag: genre || 'pop', tagExact: 'true' });
    if (!genre || genre === 'russian' || !q) tag.set('countrycode', 'RU');
    list = (await api(`/json/stations/search?${tag}`, options)).filter(playable);
  }
  const stations = rank(list, byName ? q : '').map((st) => ({
    id: st.stationuuid,
    name: st.name.trim(),
    url: st.url_resolved,
    country: st.countrycode,
    codec: st.codec,
    tags: String(st.tags || ''),
  }));
  return { stations, byName };
}

// Каталог просит отмечать прослушивания — так он знает, какие станции живые и популярные
const markPlayed = (station, options = {}) => station?.id && api(`/json/url/${station.id}`, options).catch(() => {});

// Лучшая станция по запросу или null
async function findStation(query, options = {}) {
  const best = (await findStations(query, options)).stations[0] || null;
  markPlayed(best, options);
  return best;
}

// Жанр станции по её тегам в каталоге («pop,dance,russian» → pop) — для «включи другое радио» после станции по названию
const genreOfTags = (tags) =>
  String(tags || '')
    .toLowerCase()
    .split(',')
    .map((t) => t.trim())
    .find((t) => GENRES.some(([, tag]) => tag === t)) || '';

// Жанры, которые можно назвать голосом, — для ответа «какое радио ты можешь включить»
const GENRE_NAMES = 'джаз, рок, металл, классика, поп, электроника, хип-хоп, шансон, музыка для сна, хиты восьмидесятых и девяностых';

// Что сейчас звучит на станции: многие передают «исполнитель — песня» прямо в потоке (метаданные ICY):
// просим их заголовком Icy-MetaData и читаем первый блок. Нет или пусто — ''
async function streamTitle(url, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { ...HEADERS, 'Icy-MetaData': '1' }, signal: controller.signal });
    const metaint = Number(res.headers.get('icy-metaint'));
    if (!res.ok || !metaint) return '';
    const reader = res.body.getReader();
    let buf = Buffer.alloc(0);
    while (buf.length <= metaint || buf.length < metaint + 1 + buf[metaint] * 16) {
      const { value, done } = await reader.read();
      if (done) return '';
      buf = Buffer.concat([buf, Buffer.from(value)]);
      if (buf.length > metaint + 1 + 255 * 16) break;
    }
    const meta = buf.subarray(metaint + 1, metaint + 1 + buf[metaint] * 16).toString('utf8');
    return (meta.match(/StreamTitle='([^']*)'/)?.[1] || '').trim();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
    controller.abort(); // поток бесконечный — закрыть
  }
}

module.exports = { findStation, findStations, markPlayed, streamTitle, genreOf, genreOfTags, rank, playable, GENRES, GENRE_NAMES, SERVERS };
