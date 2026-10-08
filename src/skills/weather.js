// Погода из Open-Meteo: бесплатно, без ключа, готовая фраза без второго вызова модели.
const { plural, degrees } = require('../lib/ru');

// Сервис иногда отвечает медленно — одна повторная попытка
const getJson = async (url, attempt = 1) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${new URL(url).hostname}: HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 2) throw err;
    return getJson(url, attempt + 1);
  }
};

const WMO = {
  0: 'ясно',
  1: 'в основном ясно',
  2: 'переменная облачность',
  3: 'пасмурно',
  45: 'туман',
  48: 'изморозь и туман',
  51: 'лёгкая морось',
  53: 'морось',
  55: 'сильная морось',
  56: 'ледяная морось',
  57: 'ледяная морось',
  61: 'небольшой дождь',
  63: 'дождь',
  65: 'сильный дождь',
  66: 'ледяной дождь',
  67: 'ледяной дождь',
  71: 'небольшой снег',
  73: 'снег',
  75: 'сильный снег',
  77: 'снежная крупа',
  80: 'ливень',
  81: 'ливни',
  82: 'сильные ливни',
  85: 'снегопад',
  86: 'сильный снегопад',
  95: 'гроза',
  96: 'гроза с градом',
  99: 'сильная гроза с градом',
};

// Кэш: координаты городов не меняются, а один ответ Open-Meteo — это сразу текущая погода и прогноз на 16 дней,
// поэтому «погода» → «а завтра?» → «на выходные» идут без сети. Раз в 30 минут прогноз для городов, о которых
// спрашивали за последние сутки, тихо обновляется: самый частый вопрос отвечается без ожидания (было ~0,6 с).
const FORECAST_TTL = 30 * 60_000;
const places = new Map(); // город (как спросили) → место
const forecasts = new Map(); // "широта,долгота" → { at, data } или { pending }
const asked = new Map(); // "широта,долгота" → { place, at } — что обновлять в фоне

// «в Казани», «Казани» → пробуем как есть, потом без падежного окончания
async function geocode(city) {
  const key = city.toLowerCase().replace(/ё/g, 'е').trim();
  if (places.has(key)) return places.get(key);
  const place = await geocodeOnline(city);
  if (place) places.set(key, place);
  return place;
}

const FORECAST_URL = (place) =>
  `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
  '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m' +
  '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
  `&timezone=auto&forecast_days=${FORECAST_DAYS}&wind_speed_unit=ms`;

// Свежий прогноз из кэша или из сети; одновременные запросы одного места — одним обращением
async function forecastFor(place, { fresh = false } = {}) {
  const key = `${place.latitude},${place.longitude}`;
  asked.set(key, { place, at: Date.now() });
  const hit = forecasts.get(key);
  if (hit?.pending) return hit.pending;
  // Прогноз, полученный вчера, уже про другие дни: «сегодня» у него — вчера
  if (!fresh && hit && Date.now() - hit.at < FORECAST_TTL && new Date(hit.at).toDateString() === new Date().toDateString()) return hit.data;
  const pending = getJson(FORECAST_URL(place));
  forecasts.set(key, { pending });
  try {
    const data = await pending;
    forecasts.set(key, { at: Date.now(), data });
    return data;
  } catch (err) {
    if (hit?.data) forecasts.set(key, hit);
    else forecasts.delete(key);
    throw err;
  }
}

function refreshAsked() {
  for (const [key, { place, at }] of asked) {
    if (Date.now() - at > 86_400_000) asked.delete(key);
    else
      forecastFor(place, { fresh: true })
        .catch(() => {})
        .finally(() => asked.set(key, { place, at }));
  }
}

async function geocodeOnline(city) {
  const variants = [city, city.replace(/(ом|ем|е|у|ю|и|а|я)$/i, '')].filter((v, i, a) => v.length > 1 && a.indexOf(v) === i);
  for (const name of variants) {
    const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=ru`);
    if (geo.results?.[0]) return geo.results[0];
  }
  return null;
}

const FORECAST_DAYS = 16; // столько дней отдаёт Open-Meteo
const WEEKDAYS = ['воскресень', 'понедельник', 'вторник', 'сред', 'четверг', 'пятниц', 'суббот']; // основы: «в субботу», «суббота»
const ON_WEEKDAY = ['в воскресенье', 'в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// «когда» → список дней от сегодня: [0] сегодня, [1] завтра, [5, 6] выходные, [0..6] неделя; null — не понял
function parseWhen(whenRaw, today = new Date()) {
  const w = whenRaw.toLowerCase().replace(/ё/g, 'е').trim();
  if (!w || /сейчас|сегодня/.test(w)) return [0];
  if (/послезавтра/.test(w)) return [2];
  if (/завтра/.test(w)) return [1];
  if (/выходн/.test(w)) {
    const toSat = (6 - today.getDay() + 7) % 7;
    return today.getDay() === 0 ? [0] : [toSat, toSat + 1];
  }
  const inDays = w.match(/через\s+(\d+|[а-я]+)/);
  const COUNT = { день: 1, один: 1, два: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, неделю: 7 };
  if (inDays && (/\d/.test(inDays[1]) || COUNT[inDays[1]])) return [/\d/.test(inDays[1]) ? Number(inDays[1]) : COUNT[inDays[1]]];
  // дни недели проверяем раньше «недели»: в «понедельнике» тоже есть «недел»
  const weekday = WEEKDAYS.findIndex((stem) => w.includes(stem));
  if (weekday >= 0) return [(weekday - today.getDay() + 7) % 7];
  if (/недел|7 дней|семь дней/.test(w)) return [0, 1, 2, 3, 4, 5, 6];
  // Дата: «28», «28.09», «28 сентября»
  const date = w.match(/(\d{1,2})(?:[.\s]+(\d{1,2}|[а-я]+))?/);
  if (date) {
    const day = Number(date[1]);
    let month = today.getMonth();
    if (date[2]) month = /\d/.test(date[2]) ? Number(date[2]) - 1 : MONTHS_GEN.findIndex((m) => m.startsWith(date[2].slice(0, 3)));
    if (month < 0) month = today.getMonth();
    const target = new Date(today.getFullYear(), month, day);
    if (target < new Date(today.getFullYear(), today.getMonth(), today.getDate())) target.setFullYear(target.getFullYear() + 1);
    return [Math.round((target - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86_400_000)];
  }
  return null;
}

// «в субботу, 27 сентября»
function dayLabel(offset, today = new Date()) {
  if (offset === 0) return 'Сегодня';
  if (offset === 1) return 'Завтра';
  if (offset === 2) return 'Послезавтра';
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
  const on = ON_WEEKDAY[d.getDay()];
  return `${on[0].toUpperCase()}${on.slice(1)} ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`; // «в среду 30 сентября» → «тридцатого»
}

// «от плюс 7 до плюс 17 градусов»: единица — один раз, в конце
const signed = (t) => {
  const n = Math.round(t);
  return `${n > 0 ? 'плюс ' : n < 0 ? 'минус ' : ''}${Math.abs(n)}`;
};

async function forecast(arg, defaultCity) {
  const [cityRaw, whenRaw = ''] = arg.split('|').map((s) => s.trim());
  const city = cityRaw.replace(/^(в|во)\s+/i, '') || defaultCity;
  const days = parseWhen(whenRaw);
  if (!days) return `Не понял, на какой день нужен прогноз, сэр.`;
  if (days.some((x) => x >= FORECAST_DAYS)) return `Прогноз есть только на ${FORECAST_DAYS} дней вперёд, сэр.`;

  const place = await geocode(city);
  if (!place) return `Не нашёл город «${city}», сэр.`;

  const f = await forecastFor(place);
  const where = `в городе ${place.name}`;
  const rain = (p) => (p >= 30 ? ` Вероятность осадков ${p} ${plural(p, 'процент', 'процента', 'процентов')}.` : '');
  const d = f.daily;
  const oneDay = (i) =>
    `${WMO[d.weather_code[i]] || 'без осадков'}, от ${signed(d.temperature_2m_min[i])} до ${degrees(d.temperature_2m_max[i])}`;

  // Несколько дней (неделя, выходные) — коротко по каждому
  if (days.length > 1) {
    const lines = days.map((i) => `${dayLabel(i)} ${oneDay(i)}`);
    return `Прогноз ${where}. ${lines.join('. ')}.`;
  }
  const [i] = days;
  if (i > 0) return `${dayLabel(i)} ${where} ${oneDay(i)}.${rain(d.precipitation_probability_max[i])}`;

  const c = f.current;
  const feels = Math.abs(c.apparent_temperature - c.temperature_2m) >= 3 ? `, ощущается как ${degrees(c.apparent_temperature)}` : '';
  const wind = Math.round(c.wind_speed_10m);
  return (
    `Сейчас ${where} ${degrees(c.temperature_2m)}, ${WMO[c.weather_code] || 'без осадков'}${feels}. ` +
    `Днём до ${degrees(d.temperature_2m_max[0])}, ветер ${wind} ${plural(wind, 'метр', 'метра', 'метров')} в секунду.` +
    rain(d.precipitation_probability_max[0])
  );
}

// Город: собеседника (профиль, затем факты «Живёт в Казани») → дома из общей памяти → из настроек
function homeCity(ctx) {
  // собеседник, потом общая память (где находится ассистент), потом настройки
  for (const mem of [ctx.memory, ctx.shared].filter(Boolean)) {
    const city =
      mem.profile().city ||
      mem
        .allFactsText()
        .match(
          /(?:[Жж]ив[её]т|[Жж]иву|[Нн]аходится|[Нн]ахожусь|[Пп]ереехал[аи]?|[Ии]з города|[Сс]тоит)\s+(?:(?:в|во|из)\s+)?([А-ЯЁ][а-яё-]+)/,
        )?.[1];
    if (city) return city;
  }
  return ctx.config.city;
}

module.exports = {
  id: 'weather',
  needs: ['now', 'city'],
  title: 'погода сейчас и прогноз на завтра в любом городе',
  keywords: [
    'погод',
    'прогноз',
    'градус',
    'температур',
    'дожд',
    'снег',
    'холодн',
    'тепло',
    'жарк',
    'зонт',
    'ветер',
    'ветр',
    'мороз',
    'гроз',
    'на улице',
  ],
  homeCity,
  parseWhen,
  tools: [
    {
      name: 'weather',
      speaks: true, // ответ всегда даёт сам инструмент
      use: 'любые вопросы о погоде',
      arg: '"город|когда": когда — сегодня, завтра, послезавтра, день недели, «через 3 дня», дата «28 сентября», «выходные» или «неделя»; город можно не указывать — возьму город собеседника',
      examples: [
        ['какая погода', { addressed: true, say: 'Сейчас посмотрю.', actions: [{ tool: 'weather', arg: '' }] }],
        [
          'что завтра в Казани с погодой',
          { addressed: true, say: 'Сейчас посмотрю.', actions: [{ tool: 'weather', arg: 'Казань|завтра' }] },
        ],
        ['какая погода будет в субботу', { addressed: true, say: 'Сейчас посмотрю.', actions: [{ tool: 'weather', arg: '|суббота' }] }],
        ['прогноз на неделю', { addressed: true, say: 'Сейчас посмотрю.', actions: [{ tool: 'weather', arg: '|неделя' }] }],
        [
          'погода через 3 дня в Казани',
          { addressed: true, say: 'Сейчас посмотрю.', actions: [{ tool: 'weather', arg: 'Казань|через 3 дня' }] },
        ],
      ],
      // «Москва|сегодня» — «сегодня» лишнее: без дня прогноз и так на сейчас
      normalize: (arg) => arg.replace(/\|\s*(сегодня|сейчас|today|now)\s*$/i, ''),
      run: async (arg, ctx) => ({ ok: true, speak: await forecast(arg || '', homeCity(ctx)) }),
    },
  ],
  // Фоновое обновление — только в приложении (в тестах нет dataDir) и только для городов, о которых спрашивали
  init(ctx) {
    clearInterval(refresher);
    if (!ctx.dataDir) return;
    refresher = setInterval(refreshAsked, FORECAST_TTL - 60_000);
    refresher.unref?.();
    // Первый вопрос о погоде после запуска — тоже без ожидания: город из настроек или общей памяти
    const city = homeCity({ shared: ctx.shared, config: ctx.config });
    geocode(city)
      .then((p) => p && forecastFor(p))
      .catch(() => {});
  },
  forecast,
  geocode,
};
let refresher = null;
