// Звуки для сна и фона: «включи шум дождя», «звуки моря», «белый шум на полчаса», «включи звуки природы».
// Звук синтезирует окно (lib/sounds.js, renderer/noise.js) — работает без интернета. Играет через проигрыватель
// радио: «выключи радио», «стоп», пауза, громкость и мини-плеер — те же. «На полчаса» — сразу и таймер сна.
// У голосовых колонок это один из самых частых запросов в спальне (звуки для сна, будильник).
const { SOUNDS, soundOf, stationOf } = require('../lib/sounds');
const { durationFromText } = require('../lib/ru');

const norm = (text) =>
  String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-яa-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// «включи звуки дождя», «поставь шум моря на час», «белый шум», «хочу послушать дождь», «шум для сна»
const ASK = /^(?:включи|поставь|запусти|давай|хочу|можно|сыграй)?(?: мне)?(?: послушать)? ?(.+)$/;
function quick(text) {
  const t = norm(text);
  if (!/шум|звук|дожд|ливн|мор[еяю]|волн|прибо|океан|природ/.test(t)) return null;
  // «выключи шум», «хватит дождя» — как «выключи радио»: звук играет через тот же проигрыватель
  if (
    /^(?:выключи|выруби|отключи|останови|убери|хватит)(?: этот| мне)? (?:шум\S*|звук\S* (?:дождя|моря|природы|волн)|дожд\S*|мор[ея])$/.test(
      t,
    )
  )
    return { addressed: true, say: '', actions: [{ tool: 'radio_stop', arg: '' }] };
  // «включи звук», «звук на 50», «сделай звук тише» — громкость, а не звуки для сна
  if (/^(?:включи|верни|выключи|убери|сделай)? ?звук(?: .*(?:громче|тише|процент|\d))?$/.test(t)) return null;
  const m = t.match(ASK);
  const what = (m?.[1] || t).replace(/ (?:на|в течение) .+$/, '');
  const sound = soundOf(what);
  // Слова о погоде («будет ли дождь», «дождь завтра») — не звук: нужен глагол «включи/поставь…» или «звук/шум»
  if (!sound || (!/звук|шум/.test(t) && !/^(?:включи|поставь|запусти|давай|хочу|сыграй)/.test(t))) return null;
  const sec = durationFromText(t);
  const arg = sec ? `${sound.id}|${Math.max(1, Math.round(sec / 60))}` : sound.id;
  return { addressed: true, say: '', actions: [{ tool: 'sleep_sound', arg }] };
}

async function play(arg, ctx) {
  const [what, minutesRaw] = String(arg || '').split('|');
  const sound = soundOf(what) || soundOf('rain');
  if (!ctx.radio?.play) return { ok: false, message: 'Звуки сейчас не включить, сэр.' };
  ctx.radio.play(stationOf(sound));
  const minutes = Number(minutesRaw);
  if (minutes > 0 && ctx.call) await ctx.call('sleep_timer', String(Math.min(600, Math.round(minutes))));
  return {
    ok: true,
    speak:
      minutes > 0
        ? `Включаю: ${sound.name.toLowerCase()}. Выключу через ${Math.round(minutes)} мин.`
        : `Включаю: ${sound.name.toLowerCase()}.`,
    silentAfter: true, // не слушать продолжение: услышим сам шум
  };
}

module.exports = {
  id: 'sounds',
  needs: [],
  router: false, // маленькая модель навыка не знает: фразы о нём — быстрым разбором или большой моделью
  title: 'звуки для сна и фона без интернета: шум дождя, моря, белый шум, тихий шум; можно на время',
  keywords: ['шум', 'звуки', 'дождя', 'моря', 'волн', 'природ', 'для сна', 'уснуть', 'заснуть'],
  quick,
  rules: [
    '«Шум дождя», «звуки моря», «белый шум», «звуки природы», «что-нибудь чтобы уснуть» без музыки — sleep_sound. Радиостанция или жанр — radio.',
  ],
  tools: [
    {
      name: 'sleep_sound',
      use: 'включить звук для сна или фона: дождь, море, белый шум, тихий шум; можно на N минут',
      arg: `${SOUNDS.map((s) => s.id).join(' | ')} (дождь, море, белый шум, тихий шум); через "|МИНУТЫ" — выключить через столько минут`,
      speaks: true,
      examples: [
        ['включи шум дождя', { addressed: true, say: '', actions: [{ tool: 'sleep_sound', arg: 'rain' }] }],
        ['поставь звуки моря на полчаса', { addressed: true, say: '', actions: [{ tool: 'sleep_sound', arg: 'sea|30' }] }],
      ],
      run: play,
    },
  ],
  _test: { quick },
};
