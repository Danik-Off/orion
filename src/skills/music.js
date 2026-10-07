// Музыка и видео на YouTube: находит ролик, открывает и убеждается, что он действительно играет.
// Управление любым плеером — медиа-клавишами; «что играет» — через медиа-API Windows.
const { pressMediaKey, MEDIA_KEYS } = require('../lib/windows');
const { searchVideos, pickForListening, watchUrl } = require('../lib/youtube');
const media = require('../lib/media');

let lastMedia = null; // для «ещё»: повторить последнее действие плеера

// Короткие команды плеера разбираются без модели: мгновенно и без ошибок.
const QUICK = [
  [/^(пауза|стоп|останови|продолжи|продолжай|играй|плей)( музыку| воспроизведение| видео)?( дальше)?$/, 'play_pause', 'Есть.'],
  [/^(дальше|следующ(ий|ая|ую)( трек| песн[яю])?|переключи|скип)$/, 'next', 'Следующий трек.'],
  [/^(назад|предыдущ(ий|ая|ую)( трек| песн[яю])?)$/, 'prev', 'Предыдущий трек.'],
  [/^(сделай )?(по)?громче$/, 'volume_up', 'Громче.'],
  [/^(сделай )?(по)?тише$/, 'volume_down', 'Тише.'],
  [/^(выключи звук|без звука|заглуши|включи звук)$/, 'mute', 'Готово.'],
];
const AGAIN = /^(ещё|еще|ещё раз|еще раз|больше|сильнее|и ещё|и еще)$/;

function quick(text) {
  const t = text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-яa-z ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  let key = null;
  let say = 'Есть.';
  for (const [re, k, phrase] of QUICK) {
    if (re.test(t)) {
      key = k;
      say = phrase;
      break;
    }
  }
  // «ещё» / «больше» — повторить громкость или переключение, если это было недавно
  if (!key && AGAIN.test(t) && lastMedia && Date.now() - lastMedia.at < 60_000) key = lastMedia.key;
  if (!key) return null;
  // silent: не говорить поверх музыки
  return { addressed: true, say, actions: [{ tool: 'media', arg: key }], silent: true };
}

const words = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .split(/[^a-zа-яё0-9]+/)
      .filter((w) => w.length > 2),
  );
const sameTitle = (a, b) => {
  const A = words(a);
  return [...words(b)].filter((w) => A.has(w)).length >= Math.min(2, A.size);
};

// «Numb (Official Music Video) [4K UPGRADE] – Linkin Park» → «Numb – Linkin Park»
function speakable(title) {
  const clean = title
    .replace(/\s*[([][^)\]]*[)\]]/g, '')
    .replace(/\b(official|video|audio|lyrics|4k|hd|клип|премьера)\b/gi, '')
    .replace(/[|#].*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean || title.slice(0, 60);
}

// Открыть видео и дождаться, что оно играет; если браузер оставил его на паузе — нажать «играть»
async function playOnYoutube(query, ctx) {
  const mix = /музык|микс|плейлист|подборк|радио|lofi|chill/i.test(query) && !/клип|песн[яю]|трек/i.test(query);
  const video = pickForListening(await searchVideos(query), { mix });
  if (!video) return { ok: false, message: `Не нашёл на YouTube «${query}».` };

  // Сначала останавливаем то, что уже играет, чтобы звуки не смешались
  const before = await media.sessions().catch(() => []);
  for (const s of before.filter((x) => x.status === 'Playing')) await media.control('pause', s.app).catch(() => {});

  await ctx.openExternal(watchUrl(video.id));

  ensurePlaying(video, ctx); // в фоне — ответ не ждёт проверки
  return { ok: true, speak: `Включаю «${speakable(video.title)}».`, silentAfter: true };
}

// Всё остальное мы поставили на паузу — значит, заигравший браузер и есть наше видео
// (перед роликом YouTube может показать рекламу со своим названием). Если браузер оставил видео
// на паузе (политика автозапуска) — нажимаем «играть» через медиа-API.
async function ensurePlaying(video, ctx) {
  let playing = false;
  for (let i = 0; i < 6 && !playing; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    const now = (await media.sessions().catch(() => [])).filter((s) => media.isBrowser(s.app));
    playing = now.some((s) => s.status === 'Playing');
    const ours = now.find((s) => sameTitle(video.title, s.title));
    if (!playing && ours && i >= 2) await media.control('play', ours.app).catch(() => {});
  }
  ctx.audit({ youtube: video.title, id: video.id, playing });
}

module.exports = {
  id: 'music',
  needs: [],
  title: 'музыка и видео на YouTube, пауза, следующий трек, громче или тише, что играет',
  keywords: [
    'музык',
    'песн',
    'трек',
    'включи',
    'поставь',
    'ютуб',
    'youtube',
    'видео',
    'клип',
    'плеер',
    'играет',
    'пауз',
    'громч',
    'погромч',
    'тиш',
    'потиш',
    'следующ',
    'предыдущ',
    'альбом',
    'плейлист',
    'послушать',
  ],
  speakable,
  quick,
  rules: [
    '«Включи/поставь» + исполнитель, песня, жанр или видео — это youtube, а не open_app и не open_url.',
    'Если пользователь просит «мою музыку» или «что-нибудь» — подбери запрос по его вкусам из памяти.',
    'Пауза, дальше, громче, тише без числа — media (volume_up / volume_down); громкость числом — volume.',
  ],
  tools: [
    {
      name: 'youtube',
      use: 'включить музыку, песню, клип или видео на YouTube (сразу начинает играть)',
      arg: 'что искать на YouTube: исполнитель и название, жанр или тема видео',
      examples: [
        ['включи Кино группа крови', { addressed: true, say: 'Ставлю.', actions: [{ tool: 'youtube', arg: 'Кино Группа крови' }] }],
        [
          'включи какую-нибудь спокойную музыку',
          { addressed: true, say: 'Сейчас.', actions: [{ tool: 'youtube', arg: 'спокойная музыка микс' }] },
        ],
        ['поставь видео про чёрные дыры', { addressed: true, say: 'Ищу.', actions: [{ tool: 'youtube', arg: 'чёрные дыры научпоп' }] }],
      ],
      run: async (query, ctx) => playOnYoutube(query || 'популярная музыка микс', ctx),
    },
    {
      name: 'media',
      use: 'управление плеером',
      arg: Object.keys(MEDIA_KEYS).join(' | '),
      argEnum: Object.keys(MEDIA_KEYS),
      run: async (key) => {
        if (!MEDIA_KEYS[key]) return { ok: false, message: 'Не знаю такой команды плеера.' };
        await pressMediaKey(key);
        lastMedia = { key, at: Date.now() };
        return { ok: true };
      },
    },
    {
      name: 'now_playing',
      use: 'что сейчас играет',
      arg: 'пусто',
      examples: [['что сейчас играет', { addressed: true, say: 'Сейчас посмотрю.', actions: [{ tool: 'now_playing', arg: '' }] }]],
      run: async () => {
        const list = await media.sessions();
        const playing = list.find((s) => s.status === 'Playing') || list[0];
        if (!playing?.title) return { ok: true, speak: 'Сейчас ничего не играет.' };
        const who = playing.artist ? `${playing.artist} — ` : '';
        return { ok: true, speak: `${playing.status === 'Playing' ? 'Играет' : 'На паузе'}: ${who}${playing.title}.` };
      },
    },
  ],
};
