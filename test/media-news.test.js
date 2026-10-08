// Радио, музыка и новости: выбор станции, команды без модели, микс YouTube, свежие новости без повторов,
// «подробнее о второй», фразы о новых навыках — мимо маленькой модели. Сеть подменена.
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { system, makeRegistry } = require('./helpers');
const { rank, playable, genreOf, findStation } = require('../src/lib/radio');
const radioSkill = require('../src/skills/radio');
const news = require('../src/skills/news');
const { watchUrl } = require('../src/lib/youtube');

const st = (name, extra = {}) => ({
  name,
  url_resolved: `https://x/${encodeURIComponent(name)}`,
  codec: 'MP3',
  countrycode: 'RU',
  clickcount: 100,
  stationuuid: name,
  ...extra,
});

test('радио: станция по названию — основная, а не местная; жанр; неиграющие потоки отброшены', () => {
  const ranked = rank(
    [st('Европа Плюс Полоцк 104.1', { clickcount: 50 }), st('Европа Плюс', { clickcount: 5000 }), st('Europa Plus', { clickcount: 9000 })],
    'европа плюс',
  );
  assert.equal(ranked[0].name, 'Европа Плюс');
  assert.equal(genreOf('с джазом'), 'jazz');
  assert.equal(genreOf('что-нибудь для сна'), 'ambient');
  assert.equal(genreOf('маяк'), null);
  assert.ok(playable(st('a')));
  assert.ok(!playable(st('b', { codec: 'HLS' })), 'HLS окно само не сыграет');
  assert.ok(!playable(st('c', { hls: 1 })));
  assert.ok(!playable(st('d', { lastcheckok: 0 })), 'помечена неработающей');
});

test('радио: «рок» — не «Роксана» (слово целиком), по названию нет — жанр; каталог упал — следующий сервер', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (calls.length === 1) return { ok: false, status: 502 }; // первый сервер каталога не отвечает
    if (url.includes('/url/')) return { ok: true, json: async () => ({}) };
    if (url.includes('name=')) return { ok: true, json: async () => [st('Роксана радиосы', { clickcount: 999 })] };
    if (url.includes('tag=rock')) return { ok: true, json: async () => [st('Рок-Атака'), st('Rock FM', { codec: 'HLS' })] };
    return { ok: true, json: async () => [] };
  };
  const s = await findStation('рок', { fetchImpl });
  assert.equal(s.name, 'Рок-Атака');
  assert.match(calls[1], /name=/, 'после сбоя — тот же запрос другому серверу');
  assert.ok(calls.some((u) => /tag=rock.*tagExact=true/.test(u)));
});

test('радио: «включи радио маяк», «радио с джазом», «выключи радио» — без модели; YouTube ставится на паузу', async () => {
  const q = (t) => radioSkill.quick(t)?.actions[0];
  assert.deepEqual(q('Включи радио Маяк'), { tool: 'radio', arg: 'маяк' });
  assert.deepEqual(q('поставь радио с джазом'), { tool: 'radio', arg: 'джазом' });
  assert.deepEqual(q('включи радио'), { tool: 'radio', arg: '' });
  assert.deepEqual(q('выключи радио'), { tool: 'radio_stop', arg: '' });
  assert.equal(radioSkill.quick('включи музыку'), null);

  const realFetch = global.fetch;
  global.fetch = async (url) =>
    String(url).includes('/url/')
      ? { ok: true, json: async () => ({}) }
      : { ok: true, json: async () => [st('Радио Маяк (Radio Mayak)', { clickcount: 5000 })] };
  const played = [];
  const saved = [];
  try {
    const media = require('../src/lib/media');
    const realSessions = media.sessions;
    media.sessions = async () => [{ app: 'chrome', status: 'Playing', title: 'видео' }];
    system.calls.length = 0;
    const r = await radioSkill.tools[0].run('маяк', {
      config: {},
      radio: { play: (s) => played.push(s) },
      saveSettings: (p) => saved.push(p),
    });
    media.sessions = realSessions;
    assert.equal(r.speak, 'Включаю Радио Маяк (Radio Mayak).');
    assert.equal(played[0].name, 'Радио Маяк (Radio Mayak)');
    assert.deepEqual(saved[0], { 'radio.last': 'Радио Маяк (Radio Mayak)' }, '«включи радио» в следующий раз — её же');
    assert.ok(
      system.calls.some((c) => c.name === 'media.control' && c.args[0] === 'pause'),
      'YouTube — на паузу',
    );
  } finally {
    global.fetch = realFetch;
  }
});

test('радио: «в жанре металл», «другое радио», «какое радио можешь» — без модели', () => {
  const q = (t) => radioSkill.quick(t)?.actions[0];
  assert.deepEqual(q('включи радио в жанре металл'), { tool: 'radio', arg: 'металл' });
  assert.deepEqual(q('поставь радио в стиле джаз'), { tool: 'radio', arg: 'джаз' });
  assert.deepEqual(q('переключи радио на рок'), { tool: 'radio', arg: 'рок' });
  assert.deepEqual(q('включи другое радио'), { tool: 'radio', arg: 'другое' });
  assert.deepEqual(q('следующая станция'), { tool: 'radio', arg: 'другое' });
  assert.deepEqual(q('какое радио ты включить можешь'), { tool: 'radio', arg: 'list' });
  assert.deepEqual(q('какие есть радиостанции'), { tool: 'radio', arg: 'list' });
  assert.equal(genreOf('металл'), 'metal');
  const on = { radio: { state: () => ({ active: true }) } };
  assert.deepEqual(radioSkill.quick('включи контираде уже на металл', on)?.actions[0], { tool: 'radio', arg: 'металл' });
  assert.equal(radioSkill.quick('включи контираде уже на металл'), null, 'радио не играет — это не про него');
  assert.equal(radioSkill.quick('переключи на вторую вкладку', on), null);
});

test('радио: «другое радио» — другая станция того же жанра, не та, что играет; «list» — ничего не включает', async () => {
  const radioLib = require('../src/lib/radio');
  const real = radioLib.findStations;
  const media = require('../src/lib/media');
  const asked = [];
  const station = (name, tags = 'pop,russian') => ({ id: '', name, url: `http://x/${name}`, tags });
  radioLib.findStations = async (q) => {
    asked.push(q);
    return q === 'Europa Plus'
      ? { byName: true, stations: [station('Europa Plus')] }
      : { byName: false, stations: [station('Europa Plus'), station('Русское радио'), station('Авторадио')] };
  };
  const played = [];
  let now = '';
  const ctx = {
    config: {},
    radio: { play: (s) => (played.push(s.name), (now = s.name)), state: () => ({ name: now }) },
    saveSettings: () => {},
  };
  try {
    radioSkill._test.reset();
    await radioSkill.tools[0].run('Europa Plus', ctx);
    await radioSkill.tools[0].run('другое', ctx);
    await radioSkill.tools[0].run('другое', ctx);
    assert.deepEqual(played, ['Europa Plus', 'Русское радио', 'Авторадио']);
    assert.equal(asked[1], 'pop', 'жанр играющей станции — из её тегов в каталоге');
    const list = await radioSkill.tools[0].run('list', ctx);
    assert.match(list.speak, /по жанру/);
    assert.equal(played.length, 3, 'вопрос — не включает');
  } finally {
    radioLib.findStations = real;
    radioSkill._test.reset();
    void media;
  }
});

test('мини-плеер радио: отпущенный — к ближайшему углу своего экрана', () => {
  const { cornerOf, placeIn, SIZE } = require('../src/app/radio-player');
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.equal(cornerOf({ x: 1500, y: 900, ...SIZE }, area), 'br');
  assert.equal(cornerOf({ x: 100, y: 50, ...SIZE }, area), 'tl');
  assert.equal(cornerOf({ x: 1700, y: 80, ...SIZE }, area), 'tr');
  assert.deepEqual(placeIn(area, 'br'), { ...SIZE, x: 1920 - SIZE.width - 16, y: 1040 - SIZE.height - 16 });
  const second = { x: 1920, y: 0, width: 2560, height: 1400 }; // второй экран справа
  assert.deepEqual(placeIn(second, 'tl'), { ...SIZE, x: 1936, y: 16 });
});

test('музыка: песня — в режиме микса YouTube (после неё похожие), длинный микс — как есть', () => {
  assert.equal(watchUrl('abc', { similar: true }), 'https://www.youtube.com/watch?v=abc&list=RDabc');
  assert.equal(watchUrl('abc'), 'https://www.youtube.com/watch?v=abc');
});

test('новости: свежее за сутки, одно событие из разных лент — один раз, по очереди из лент', () => {
  const { pick, sameEvent } = news._test;
  const now = Date.parse('2026-10-08T12:00:00Z');
  const h = (n) => now - n * 3600_000;
  const tass = [
    { title: 'Путин встретился с президентом Туркмении в Ашхабаде', date: h(1) },
    { title: 'Старая новость позавчерашняя', date: h(50) },
    { title: 'Курс рубля укрепился к доллару', date: h(2) },
  ];
  const rbc = [
    { title: 'Президент Путин встретился в Ашхабаде с президентом Туркмении', date: h(1) },
    { title: 'Сбербанк снизил ставки по вкладам', date: h(3) },
  ];
  assert.ok(sameEvent(tass[0].title, rbc[0].title));
  assert.ok(!sameEvent(tass[2].title, rbc[1].title));
  const items = pick([tass, rbc], { now });
  assert.deepEqual(
    items.map((i) => i.title),
    ['Путин встретился с президентом Туркмении в Ашхабаде', 'Курс рубля укрепился к доллару', 'Сбербанк снизил ставки по вкладам'],
  );
  assert.equal(pick([[{ title: 'Только старое', date: h(100) }]], { now }).length, 1, 'за сутки ничего — хоть последнее');
});

test('новости: «новости про SpaceX» и «подробнее о второй» — без модели; какая из прочитанных', () => {
  const { which, quick, remember } = news._test;
  const items = [{ title: 'Выборы в Японии' }, { title: 'Запуск ракеты SpaceX' }, { title: 'Матч Спартак — ЦСКА' }];
  assert.equal(which('вторая', items).title, 'Запуск ракеты SpaceX');
  assert.equal(which('о последней', items).title, 'Матч Спартак — ЦСКА');
  assert.equal(which('про ракету spacex', items).title, 'Запуск ракеты SpaceX');
  const a = (t) => quick(t)?.actions[0];
  assert.deepEqual(a('главные новости'), { tool: 'news', arg: 'главное' });
  assert.deepEqual(a('новости про SpaceX'), { tool: 'news_about', arg: 'spacex' });
  assert.deepEqual(a('новости спорта'), { tool: 'news', arg: 'спорт' }, 'тема целиком — своя лента');
  assert.deepEqual(a('новости футбола'), { tool: 'news_about', arg: 'футбола' }, 'что-то уже темы — точный поиск, без тенниса');
  assert.deepEqual(a('что пишут о выборах в Японии'), { tool: 'news_about', arg: 'выборах в японии' });
  assert.equal(quick('что нового у тебя'), null, '«что нового у тебя» — про самого Ориона');
  assert.equal(quick('подробнее о второй'), null, 'без прочитанного списка «подробнее» — не про новости');
  remember(items);
  assert.deepEqual(a('расскажи подробнее о второй'), { tool: 'news_more', arg: 'второй' });
});

test('маленькая модель: фраза про радио (его не было при её обучении) — сразу большой модели', () => {
  const { skills } = makeRegistry();
  assert.equal(skills.external('поставь какое-нибудь радио с роком'), 'radio');
  assert.equal(skills.external('включи кино группа крови'), null, 'музыку знает — берёт сама');
});

test('радио: название песни из потока (ICY) — «исполнитель — песня»; нет метаданных — пусто', async () => {
  const { streamTitle } = require('../src/lib/radio');
  const meta = "StreamTitle='Кино - Группа крови';";
  const block = Buffer.alloc(Math.ceil(meta.length / 16) * 16);
  block.write(meta);
  const audio = Buffer.alloc(100, 1);
  const body = Buffer.concat([audio, Buffer.from([block.length / 16]), block, audio]);
  const stream = (chunks) =>
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(new Uint8Array(ch));
        c.close();
      },
    });
  const fetchImpl = async (_url, init) => {
    assert.equal(init.headers['Icy-MetaData'], '1');
    return { ok: true, headers: new Map([['icy-metaint', '100']]), body: stream([body.subarray(0, 50), body.subarray(50)]) };
  };
  assert.equal(await streamTitle('https://x', { fetchImpl }), 'Кино - Группа крови');
  const none = async () => ({ ok: true, headers: new Map(), body: stream([audio]) });
  assert.equal(await streamTitle('https://x', { fetchImpl: none }), '');
});

test('поиск: «найди в интернете …» — сразу; без продолжения — переспрос, следующая фраза — запрос; разбор без побочных эффектов', async () => {
  const s = require('../src/skills/search');
  const a = (t) => s.quick(t)?.actions[0];
  assert.deepEqual(a('Найди в интернете, кто выиграл чемпионат мира'), { tool: 'web_search', arg: 'кто выиграл чемпионат мира' });
  assert.deepEqual(a('загугли курс биткоина'), { tool: 'web_search', arg: 'курс биткоина' });
  assert.equal(s.quick('найди рецепт борща'), null, 'без «в интернете» — может быть поиск файла, решает модель');
  // Разбор зовут и на недоговорённой фразе — он не должен ничего запоминать
  assert.deepEqual(a('найди в интернете'), { tool: 'web_search', arg: '' });
  assert.equal(s.quick('расписание электричек'), null, 'один разбор — не ожидание запроса');
  const r = await s.tools.find((t) => t.name === 'web_search').run('', {});
  assert.equal(r.speak, 'Что найти в интернете, сэр?');
  assert.deepEqual(a('расписание электричек'), { tool: 'web_search', arg: 'расписание электричек' }, 'после переспроса — следующая фраза');
});

test('новости: после пересказа — «Открыть статью в браузере?»; «да» или «открой эту новость» — открывает', async () => {
  const { remember, quick, forget } = news._test;
  forget();
  const a = (t) => quick(t)?.actions[0];
  assert.equal(quick('да'), null, 'без пересказа «да» — не новостям');
  remember([
    { title: 'Самолёт сгорел в аэропорту', link: 'https://example.com/1' },
    { title: 'Протесты во Франции', link: 'https://example.com/2' },
  ]);
  assert.deepEqual(a('да давай расскажи про первую новости'), { tool: 'news_more', arg: 'первую' });
  assert.deepEqual(a('открой вторую новость'), { tool: 'news_open', arg: 'вторую' });
  const opened = [];
  const ctx = { llm: { answer: async () => 'Пересказ статьи.' }, openExternal: async (u) => opened.push(u) };
  const tool = (n) => news.tools.find((t) => t.name === n);
  const r = await tool('news_more').run('первая', ctx, {});
  assert.match(r.speak, /Открыть статью в браузере\?$/);
  assert.deepEqual(a('да'), { tool: 'news_open', arg: '' }, '«да» после вопроса — открыть');
  assert.deepEqual(a('открой эту новость в браузере'), { tool: 'news_open', arg: '' });
  assert.equal((await tool('news_open').run('', ctx)).speak, 'Открываю статью.');
  assert.deepEqual(opened, ['https://example.com/1'], 'та, что пересказана');
  await tool('news_open').run('вторую', ctx);
  assert.equal(opened[1], 'https://example.com/2');
  forget();
});
