// Steam: запустить игру голосом, сколько наиграно и когда играл в последний раз, цена и скидка в магазине.
// Всё читается из файлов самого Steam (библиотека и статистика) — без ключей и входа в аккаунт;
// цены — из открытого API магазина. Путь к Steam берётся из реестра; можно указать в config.json → steam.path.
const fs = require('node:fs');
const path = require('node:path');
const { parseVdf, pick } = require('../lib/vdf');
const { powershell } = require('../lib/windows');
const { normalize, score, levenshtein } = require('../lib/app-catalog');
const { plural } = require('../lib/ru');

// Не игры: библиотеки, инструменты, серверы
const NOT_GAMES = /redistributable|steamvr|dedicated server|soundtrack|proton|steam linux runtime|sdk|godot|porthole|wallpaper engine|tool/i;
// Как игры называют вслух
const ALIASES = { кс: 'counter-strike', контра: 'counter-strike', контру: 'counter-strike', контр: 'counter', каэс: 'counter-strike', страйк: 'strike', дота: 'dota', доту: 'dota', пубг: 'pubg', пабг: 'pubg', гта: 'grand theft auto', раст: 'rust' };
const CURRENCY = { RUB: ['рубль', 'рубля', 'рублей'], USD: ['доллар', 'доллара', 'долларов'], EUR: ['евро', 'евро', 'евро'], KZT: ['тенге', 'тенге', 'тенге'], UAH: ['гривна', 'гривны', 'гривен'] };

let steamDir = null;
let names = new Map(); // appid → название (установленные + узнанные в магазине)

async function findSteam(config) {
  if (steamDir) return steamDir;
  const fromConfig = config.steam?.path;
  const fromRegistry = fromConfig
    ? null
    : (await powershell("(Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam' -ErrorAction SilentlyContinue).SteamPath").catch(() => '')).trim();
  const dir = fromConfig || fromRegistry;
  steamDir = dir && fs.existsSync(dir) ? path.normalize(dir) : null;
  return steamDir;
}

const readVdf = (file) => {
  try {
    return parseVdf(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// Установленные игры из всех библиотек: [{ id, name }]
function installedGames(dir) {
  const folders = Object.values(pick(readVdf(path.join(dir, 'steamapps', 'libraryfolders.vdf')), 'libraryfolders') || {})
    .map((f) => f?.path)
    .filter(Boolean);
  const games = [];
  for (const lib of folders.length ? folders : [dir]) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(lib, 'steamapps')).filter((f) => /^appmanifest_\d+\.acf$/.test(f));
    } catch {}
    for (const f of files) {
      const state = pick(readVdf(path.join(lib, 'steamapps', f)), 'AppState');
      const id = pick(state, 'appid');
      const name = pick(state, 'name');
      if (id && name && !NOT_GAMES.test(name)) games.push({ id, name });
    }
  }
  for (const g of games) names.set(g.id, g.name);
  return games;
}

// Статистика: наиграно (минуты) и последний запуск — у последнего вошедшего пользователя
function playStats(dir) {
  let best = null;
  try {
    for (const user of fs.readdirSync(path.join(dir, 'userdata'))) {
      const file = path.join(dir, 'userdata', user, 'config', 'localconfig.vdf');
      const time = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
      if (time && (!best || time > best.time)) best = { file, time };
    }
  } catch {}
  const apps = best && pick(readVdf(best.file), 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps');
  return Object.entries(apps || {})
    .map(([id, v]) => ({ id, minutes: Number(v?.Playtime || 0), last: Number(v?.LastPlayed || 0) * 1000 }))
    .filter((s) => s.minutes > 0 || s.last > 0);
}

// Игра по названию, как его сказали голосом: «дедлок», «тирдаун», «кс»
function findGame(query, games) {
  const q = String(query)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/\s+/)
    .map((w) => ALIASES[w] || w)
    .join(' ');
  let best = null;
  for (const g of games) {
    let s = score(q, g.name);
    if (!s) {
      // Запасной вариант — похожее звучание целиком: «тирдаун» ≈ «teardown»
      const a = normalize(q).replace(/ /g, '');
      const b = normalize(g.name).replace(/ /g, '');
      const d = levenshtein(a, b) / Math.max(a.length, b.length);
      if (d <= 0.35) s = 50 * (1 - d);
    }
    if (s > 0 && (!best || s > best.s)) best = { s, g };
  }
  return best?.g || null;
}

const hours = (minutes) => {
  if (minutes < 60) return `${minutes} ${plural(minutes, 'минута', 'минуты', 'минут')}`;
  const h = Math.round(minutes / 60);
  return `${h} ${plural(h, 'час', 'часа', 'часов')}`;
};
const ago = (ms) => {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  if (days < 30) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months} ${plural(months, 'месяц', 'месяца', 'месяцев')} назад` : 'больше года назад';
};

const store = (url) => fetch(url, { signal: AbortSignal.timeout(7000) }).then((r) => (r.ok ? r.json() : null));

// Название игры, которой нет на диске (наиграно, но удалена) — из магазина
async function nameOf(id) {
  if (names.has(id)) return names.get(id);
  const d = await store(`https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic&l=russian`).catch(() => null);
  const name = d && Object.values(d)[0]?.data?.name;
  if (name) names.set(id, name);
  return name || null;
}

// Игра в магазине по названию: { id, name } или null
async function searchStore(query) {
  const found = await store(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&cc=us&l=russian`).catch(() => null);
  const item = found?.items?.[0];
  if (!item) return null;
  const id = String(item.id);
  names.set(id, item.name);
  return { id, name: item.name };
}

async function launchGame(arg, ctx) {
  const dir = await findSteam(ctx.config);
  if (!dir) return { ok: false, message: 'Не нашёл Steam на этом компьютере, сэр.' };
  // «Запусти стим» — сам Steam, без игры
  if (!String(arg).trim() || /^(стим|steam)$/i.test(String(arg).trim())) {
    await ctx.openExternal('steam://open/main');
    return { ok: true, speak: 'Открываю Steam.' };
  }
  const game = findGame(arg, installedGames(dir));
  if (!game) return { ok: false, message: `Не нашёл «${arg}» среди установленных игр Steam, сэр.` };
  await ctx.openExternal(`steam://rungameid/${game.id}`);
  ctx.audit({ steam: 'запуск', game: game.name });
  return { ok: true, speak: `Запускаю ${game.name}.` };
}

// arg: '' — во что больше всего играли и во что недавно; 'games' — что установлено; название — про эту игру
async function stats(arg, ctx) {
  const dir = await findSteam(ctx.config);
  if (!dir) return { ok: false, message: 'Не нашёл Steam на этом компьютере, сэр.' };
  const games = installedGames(dir);
  const all = playStats(dir);
  const a = String(arg).trim();
  if (/^(games|игры|установлен)/i.test(a)) {
    return { ok: true, speak: `Установлено ${games.length} ${plural(games.length, 'игра', 'игры', 'игр')}: ${games.map((g) => g.name).join(', ')}.` };
  }
  if (a) {
    const known = [...games, ...[...names].map(([id, name]) => ({ id, name }))];
    // Удалённой игры на диске нет — её номер узнаём в магазине по названию
    const game = findGame(a, known) || (await searchStore(ALIASES[a.toLowerCase()] || a));
    const s = game && all.find((x) => x.id === game.id);
    if (!game) return { ok: false, message: `Не нашёл игру «${a}» в Steam, сэр.` };
    if (!s) return { ok: true, speak: `В ${game.name} вы ещё не играли.` };
    return { ok: true, speak: `В ${game.name} наиграно ${hours(s.minutes)}, последний раз — ${ago(s.last)}.` };
  }
  // Инструменты (Godot, Porthole…) тоже копят «наигранное» — в статистике игр их не считаем
  const gamesOnly = async (list, n) => {
    const out = [];
    for (const s of list) {
      const name = await nameOf(s.id);
      if (name && !NOT_GAMES.test(name)) out.push({ ...s, name });
      if (out.length >= n) break;
    }
    return out;
  };
  const top = await gamesOnly([...all].sort((x, y) => y.minutes - x.minutes).slice(0, 8), 3);
  const [recent] = await gamesOnly([...all].sort((x, y) => y.last - x.last).slice(0, 5), 1);
  if (!top.length) return { ok: true, speak: 'Статистики игр пока нет, сэр.' };
  const named = top.map((s) => `${s.name} — ${hours(s.minutes)}`);
  return { ok: true, speak: `Больше всего наиграно: ${named.join(', ')}.${recent ? ` Последний раз играли в ${recent.name} ${ago(recent.last)}.` : ''}` };
}

// Цена и скидка в магазине. В регионе ru магазин цен не отдаёт — тогда следующий регион из списка
async function price(arg, ctx) {
  const q = String(arg).trim();
  if (!q) return { ok: false, message: 'Какую игру посмотреть, сэр?' };
  const regions = [].concat(ctx.config.steam?.region || [], 'ru', 'us');
  const item = await searchStore(ALIASES[q.toLowerCase()] || q);
  if (!item) return { ok: false, message: `Не нашёл «${q}» в магазине Steam, сэр.` };
  for (const cc of [...new Set(regions)]) {
    const d = await store(`https://store.steampowered.com/api/appdetails?appids=${item.id}&cc=${cc}&filters=price_overview,basic`).catch(() => null);
    const data = d && Object.values(d)[0]?.success && Object.values(d)[0].data;
    if (!data) continue;
    if (data.is_free) return { ok: true, speak: `${item.name} — бесплатная игра.` };
    const p = data.price_overview;
    if (!p) continue;
    const value = Math.round(p.final / 100);
    const cur = CURRENCY[p.currency];
    const money = cur ? `${value} ${plural(value, ...cur)}` : p.final_formatted;
    const sale = p.discount_percent ? `, сейчас скидка ${p.discount_percent} ${plural(p.discount_percent, 'процент', 'процента', 'процентов')}` : ', скидки сейчас нет';
    return { ok: true, speak: `${item.name} стоит ${money}${sale}.` };
  }
  return { ok: false, message: `Цену «${item.name}» магазин сейчас не показывает, сэр.` };
}

module.exports = {
  id: 'steam',
  title: 'игры Steam: запустить игру, сколько наиграно и когда играл, цена и скидка в магазине',
  keywords: [
    'стим', 'steam', 'игр', 'поигра', 'наиграл', 'скидк', 'распродаж', 'запусти игру',
    // названия установленных игр — на лету: «запусти дедлок» должно найти навык
    (text) => {
      const list = [...names.values()];
      return list.length > 0 && text.split(/\s+/).some((w) => w.length > 2 && findGame(w, list.map((name, id) => ({ id, name }))));
    },
  ],
  rules: [
    'Запустить игру из Steam — steam_launch (не open_app); программу — open_app.',
    '«Закрой / выруби игру» — close_app с названием игры (не steam_launch и не «steam»): Steam игры не закрывает.',
    '«Сколько я наиграл», «во что я играл» — steam_stats; «сколько стоит игра», «есть ли скидка» — steam_price, а не поиск.',
  ],
  tools: [
    {
      name: 'steam_launch',
      use: 'запустить игру из Steam',
      arg: 'название игры, как его сказали',
      examples: [
        ['запусти дедлок', { addressed: true, say: '', actions: [{ tool: 'steam_launch', arg: 'дедлок' }] }],
        ['закрой дедлок', { addressed: true, say: 'Закрываю Deadlock.', actions: [{ tool: 'close_app', arg: 'дедлок' }] }],
      ],
      run: launchGame,
    },
    {
      name: 'steam_stats',
      use: 'сколько наиграно и когда играл: во что больше всего, в конкретную игру, что установлено',
      arg: 'пусто — общая статистика; название игры; "games" — список установленных',
      examples: [['сколько я наиграл в кс', { addressed: true, say: '', actions: [{ tool: 'steam_stats', arg: 'кс' }] }]],
      run: stats,
    },
    {
      name: 'steam_price',
      use: 'цена игры в магазине Steam и есть ли скидка',
      arg: 'название игры',
      filler: 'Сейчас посмотрю.',
      examples: [['есть ли скидка на киберпанк', { addressed: true, say: '', actions: [{ tool: 'steam_price', arg: 'Cyberpunk 2077' }] }]],
      run: price,
    },
  ],
  async init(ctx) {
    const dir = await findSteam(ctx.config).catch(() => null);
    if (!dir) return;
    const games = installedGames(dir);
    // Установленные игры — в описание инструмента: модель узнаёт их в искажённом распознавании
    if (games.length) this.tools[0].arg = `название игры; установлены: ${games.map((g) => g.name).join(', ')}`;
  },
  platforms: ['win32'],
  findGame,
  _reset: () => ((steamDir = null), (names = new Map())),
};
