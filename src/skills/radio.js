// Интернет-радио: «включи радио», «включи Европу Плюс», «радио с джазом», «радио в жанре металл», «включи другое
// радио», «какое радио ты можешь включить», «выключи радио». Станции — из открытого каталога (lib/radio.js), играют
// прямо в окне Ориона, без браузера: пока Орион слушает или говорит, радио приглушается. Рядом — мини-плеер.
// «Включи радио» без названия — последняя станция (запоминается в config.json).
const radioLib = require('../lib/radio'); // через объект: тест подменяет поиск
const media = require('../lib/media');

const norm = (text) =>
  String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-яa-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const NEXT = 'другое';
const LIST = 'list';
// Что включали в этот запуск: «другое радио» не вернёт только что игравшие станции
let lastQuery = null; // { query, byName, tags }
const played = [];

// «в жанре металл», «в стиле джаз», «жанра рок» → «металл», «джаз», «рок»
const cleanQuery = (q) =>
  String(q || '')
    .trim()
    .replace(/^(?:(?:в|во) )?(?:жанре|стиле|жанр[аеу]?|стил[ья])\s+/i, '')
    .replace(/\s+(?:музык\S*)$/i, '')
    .trim();

// «включи радио европа плюс», «поставь радио с джазом», «включи другое радио», «выключи радио» — без модели
function quick(text, ctx) {
  const t = norm(text);
  const plan = (tool, arg) => ({ addressed: true, say: '', actions: [{ tool, arg }] });
  if (/^(выключи|останови|убери|хватит) радио$|^радио (выключи|стоп)$/.test(t)) return plan('radio_stop', '');
  // Вопрос, а не просьба: перечислить, а не включать
  if (/^(?:какое|какие|какую) (?:радио|радиостанци\S*|станци\S*)(?: .*)? (?:можешь|умеешь|есть|знаешь|бывают)(?: .*)?$/.test(t))
    return plan('radio', LIST);
  if (/^какие (?:есть )?(?:радиостанции|станции)/.test(t)) return plan('radio', LIST);
  if (
    /^(?:включи|поставь|давай|переключи(?: на)?|смени(?: на)?)(?: мне)? (?:другое|другую|следующее|следующую|еще одно|иное) (?:радио|радиостанцию|станцию)$/.test(
      t,
    ) ||
    /^(?:переключи|смени|поменяй) (?:радио|радиостанцию|станцию)$/.test(t) ||
    /^(?:другое радио|другую станцию|следующая станция|следующее радио)$/.test(t)
  )
    return plan('radio', NEXT);
  // Предлог — отдельным словом: «радио с джазом» → «джазом», но «радио станция Лайт» — не «с» + «танция лайт»
  const m = t.match(
    /^(?:включи|поставь|запусти|давай|переключи(?: на)?|смени(?: на)?|поменяй(?: на)?)(?: мне)? радио(?: (?:(?:с|со|про|для|на) )?(?:станци[яюи] )?(.+))?$/,
  );
  if (m) return plan('radio', cleanQuery(m[1] || ''));
  // Радио уже играет: «переключи на металл», «давай на джаз» — и когда распознавание исказило середину фразы
  // («включи контираде уже на металл»): последнее слово — жанр, значит, про станцию
  const genre = ctx?.radio?.state?.()?.active && t.match(/^(?:включи|поставь|переключи|давай|смени)(?: .+)? на (\S+)$/);
  if (genre && radioLib.genreOf(genre[1])) return plan('radio', genre[1]);
  return null;
}

async function listAnswer() {
  return {
    ok: true,
    speak:
      'Могу включить почти любую станцию по названию — «Европа Плюс», «Маяк», «Русское радио», «Рекорд» — ' +
      `или по жанру: ${radioLib.GENRE_NAMES}. Скажите, например: «включи радио с джазом».`,
  };
}

// Что искать для «другого радио»: тот же жанр, что и сейчас; играла станция по названию — её жанр из каталога
function nextQuery() {
  if (!lastQuery) return '';
  if (!lastQuery.byName) return lastQuery.query;
  return radioLib.genreOfTags(lastQuery.tags);
}

async function play(arg, ctx) {
  const asked = cleanQuery(arg);
  if (asked.toLowerCase() === LIST) return listAnswer();
  const next = asked.toLowerCase() === NEXT;
  const query = next ? nextQuery() : asked || ctx.config.radio?.last || '';
  let found;
  try {
    found = await radioLib.findStations(query);
  } catch {
    return { ok: false, message: 'Каталог радио сейчас не отвечает, сэр.' };
  }
  const current = ctx.radio?.state?.()?.name;
  const fresh = (s) => s.name !== current && !played.includes(s.name);
  const station = next ? found.stations.find(fresh) || found.stations.find((s) => s.name !== current) : found.stations[0];
  if (!station) return { ok: false, message: next ? 'Другой такой станции не нашёл, сэр.' : `Не нашёл радио «${query}», сэр.` };
  radioLib.markPlayed(station);
  if (!next) lastQuery = { query, byName: found.byName, tags: station.tags };
  played.push(station.name);
  if (played.length > 12) played.shift();
  // То, что играет в браузере (YouTube), — на паузу, чтобы звук не смешался
  const sessions = await media.sessions().catch(() => []);
  for (const s of sessions.filter((x) => x.status === 'Playing')) await media.control('pause', s.app).catch(() => {});
  ctx.radio?.play(station);
  ctx.saveSettings?.({ 'radio.last': station.name.slice(0, 120) }); // «включи радио» в следующий раз — её же
  return { ok: true, speak: `Включаю ${station.name}.`, silentAfter: true };
}

module.exports = {
  id: 'radio',
  needs: [],
  router: false, // маленькая модель радио не знает (не было при обучении) — фразы о нём сразу большой
  title: 'интернет-радио: станция по названию или жанру, другая станция, выключить',
  keywords: ['радио', 'радиостанц', 'fm', 'эфир', /(?:другую|следующую) станци/],
  quick,
  rules: [
    'radio — радиостанция («Европа Плюс», «Маяк») или жанр («джаз», «металл», «для сна»). Конкретная песня или исполнитель — youtube.',
    `«Другое радио», «следующая станция» — radio с «${NEXT}». Вопрос, какие станции есть или что можешь включить, — radio с «${LIST}» (ничего не включает).`,
  ],
  tools: [
    {
      name: 'radio',
      use: 'включить интернет-радио: станцию по названию или по жанру; другую станцию; перечислить, что можно',
      arg: `название станции или жанр; «${NEXT}» — другая станция; «${LIST}» — рассказать, что можно включить; пусто — последняя станция`,
      speaks: true,
      examples: [
        ['включи радио маяк', { addressed: true, say: '', actions: [{ tool: 'radio', arg: 'маяк' }] }],
        ['поставь какое-нибудь джазовое радио', { addressed: true, say: '', actions: [{ tool: 'radio', arg: 'джаз' }] }],
        ['а другую станцию можно', { addressed: true, say: '', actions: [{ tool: 'radio', arg: NEXT }] }],
      ],
      run: play,
    },
    {
      name: 'radio_stop',
      use: 'выключить радио',
      arg: 'пусто',
      argEnum: [''],
      speaks: true,
      run: async (_arg, ctx) => (ctx.radio?.stop(), { ok: true, speak: 'Выключил радио.' }),
    },
  ],
  _test: { quick, cleanQuery, reset: () => ((lastQuery = null), played.splice(0)) },
};
