// Разговор: план, обращение, потоковая речь (core/assistant)
require('./helpers'); // заглушка Electron — до подключения навыков
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlan, planSchema, looksLikeContinuation, applyHonorific, createAssistant } = require('../src/core/assistant');
const { makeRegistry, fakeLlm } = require('./helpers');

test('без обращения: продолжения и команды принимаются без модели', () => {
  for (const t of ['а завтра?', 'и дискорд тоже', 'спасибо', 'давай ещё один', 'включи какую-нибудь музыку на ютубе', 'какая погода']) {
    assert.ok(looksLikeContinuation(t), t);
  }
  for (const t of ['и тут он забивает гол на последней минуте матча', 'мам где носки', 'короче я купил машину']) {
    assert.ok(!looksLikeContinuation(t), t);
  }
});

test('обращение по голосу: сэр, мисс, гость', () => {
  assert.equal(applyHonorific('Готово, сэр.', 'сэр'), 'Готово, сэр.');
  assert.equal(applyHonorific('Готово, сэр. Сэр, ещё что-то?', 'мисс'), 'Готово, мисс. Мисс, ещё что-то?');
  assert.equal(applyHonorific('Открываю Telegram, сэр.', ''), 'Открываю Telegram.');
  // гостю — без обращения и без висящей запятой в начале
  assert.equal(applyHonorific('Сэр, вот анекдот: жили-были.', ''), 'Вот анекдот: жили-были.');
  assert.equal(applyHonorific('Готово. Сэр, ещё что-то?', ''), 'Готово. Ещё что-то?');
});

test('ступени разбора: первая, вернувшая план, побеждает; свою ступень можно вставить', async () => {
  const { skills, store, ctx } = makeRegistry({ planner: 'single' });
  const { llm, calls } = fakeLlm(['{"topic":"chat","actions":[],"say":"Ответ модели."}']);
  const seen = [];
  const log = [];
  const echo = {
    name: 'echo',
    plan: ({ text }) => (seen.push(text), text === 'эхо' ? { addressed: true, topic: 'chat', actions: [], say: 'Эхо, сэр.' } : null),
  };
  const assistant = createAssistant({
    config: ctx.config,
    llm,
    skills,
    memory: store,
    audit: (e) => log.push(e),
    notify: () => {},
    stages: (standard) => [standard[0], echo, ...standard.slice(1)], // после быстрого разбора, до модели
  });
  let r = await assistant.handle('эхо', { source: 'text' });
  assert.equal(r.say, 'Эхо.');
  assert.equal(calls.length, 0, 'модель не спрашивали');
  assert.equal(log.find((e) => e.plan)?.plan.stage, 'echo', 'в журнале видно, какая ступень ответила');
  r = await assistant.handle('как дела', { source: 'text' });
  await assistant.reset();
  assert.deepEqual(seen, ['эхо', 'как дела']);
  assert.equal(calls.length, 1);
  assert.equal(r.say, 'Ответ модели.');
});

test('план модели: неизвестные инструменты и лишние действия отбрасываются', () => {
  const names = ['open_app', 'media'];
  const p = parsePlan(
    '{"addressed":true,"say":"ок","actions":[{"tool":"open_app","arg":"x"},{"tool":"rm_rf","arg":"/"},{"tool":"media","arg":"next"},{"tool":"media","arg":"prev"},{"tool":"media","arg":"mute"}]}',
    names,
  );
  assert.deepEqual(
    p.actions.map((a) => a.tool),
    ['open_app', 'media', 'media'],
  );
  assert.equal(parsePlan('{"addressed":false,"say":"","actions":[]}', names).addressed, false);
  // arg вне перечня — действие отбрасывается
  const onlyNext = (tool, arg) => tool !== 'media' || arg === 'next';
  assert.deepEqual(
    parsePlan('{"topic":"music","actions":[{"tool":"media","arg":"louder"},{"tool":"media","arg":"next"}],"say":""}', names, onlyNext)
      .actions,
    [{ tool: 'media', arg: 'next' }],
  );
  // порядок полей = порядок мысли: (addressed) → topic → actions → say
  assert.deepEqual(Object.keys(planSchema({ topics: ['chat'], action: {} }).properties), ['topic', 'actions', 'say']);
  assert.deepEqual(Object.keys(planSchema({ topics: ['chat'], action: {}, addressed: true }).properties), [
    'addressed',
    'topic',
    'actions',
    'say',
  ]);
});

test('продолжение диалога: подтверждённый голос не отсекается, обращение к другому — проверяется', () => {
  const { talksToOther } = require('../src/core/assistant');
  assert.equal(talksToOther('мам, а где ключи'), true);
  assert.equal(talksToOther('меня как зовут поищу себя'), false);
  assert.equal(talksToOther('артём очисти диалог'), false);
});

test('база знаний: модель назвала навык в topic — он подгружается и запрос повторяется', async () => {
  const { skills, store, ctx } = makeRegistry({ planner: 'single' });
  const { llm, calls } = fakeLlm([
    '{"topic":"calc","actions":[],"say":""}',
    '{"topic":"calc","actions":[{"tool":"calc","arg":"2+2"}],"say":""}',
  ]);
  const assistant = createAssistant({ config: ctx.config, llm, skills, memory: store, audit: () => {}, notify: () => {} });
  const r = await assistant.handle('реши-ка задачку про яблоки', { source: 'text' });
  await assistant.reset();
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].tools.includes('calc') && calls[1].tools.includes('calc'));
  assert.match(calls[1].system, /- calc — /);
  assert.match(r.say, /4/, 'в окне ответ как есть — цифрами; словами его делает только синтез');
  assert.equal(calls[0].options.temperature, 0.1, 'план — почти без случайности');
});

test('план: подсказка при расхождении с роутером, температура для шуток, история с цифрами и действиями', async () => {
  const { skills, store, ctx } = makeRegistry({ planner: 'single' });
  const mk = (answers) => {
    const f = fakeLlm(answers);
    return {
      ...f,
      assistant: createAssistant({ config: ctx.config, llm: f.llm, skills, memory: store, audit: () => {}, notify: () => {} }),
    };
  };

  // слова называют навык dates, а модель ничего не сделала — второй запрос с подсказкой
  let t = mk([
    '{"topic":"chat","actions":[],"say":"Много."}',
    '{"topic":"dates","actions":[{"tool":"date_info","arg":"until 12-31"}],"say":""}',
  ]);
  let r = await t.assistant.handle('сколько дней до отпуска в декабре', { source: 'text' });
  await t.assistant.reset();
  assert.equal(t.calls.length, 2);
  assert.match(t.calls[1].messages.at(-1).content, /подсказка: .*dates/);
  assert.deepEqual(r.actions, [{ tool: 'date_info', arg: 'until 12-31' }]);

  // просто разговор — без повторов
  t = mk(['{"topic":"chat","actions":[],"say":"Сочувствую."}']);
  await t.assistant.handle('я так устал сегодня', { source: 'text' });
  await t.assistant.reset();
  assert.equal(t.calls.length, 1);

  // анекдот — с обычной температурой
  t = mk(['{"topic":"chat","actions":[],"say":"Шутка."}']);
  await t.assistant.handle('расскажи анекдот', { source: 'text' });
  await t.assistant.reset();
  assert.equal(t.calls[0].options.temperature, undefined);

  // в историю — JSON плана с цифрами (не озвученный текст) и действиями
  t = mk(['{"topic":"calc","actions":[{"tool":"calc","arg":"20+1"}],"say":""}', '{"topic":"chat","actions":[],"say":"ок"}']);
  r = await t.assistant.handle('сколько будет 20 плюс 1', { source: 'text' });
  assert.match(r.say, /21/, 'в окне — цифрами');
  assert.match(require('../src/lib/speech-text').normalizeForSpeech(r.say), /двадцать один/, 'озвучка — словами');
  await t.assistant.handle('спасибо', { source: 'text' });
  await t.assistant.reset();
  const history = JSON.parse(t.calls[1].messages.find((m) => m.role === 'assistant').content);
  assert.deepEqual(history.actions, [{ tool: 'calc', arg: '20+1' }]);
  assert.equal(history.topic, 'calc');
  assert.match(history.say, /21/);

  // addressed — только для фраз без имени
  t = mk(['{"addressed":false,"topic":"chat","actions":[],"say":""}']);
  r = await t.assistant.handle('ну я ему и говорю', { source: 'followup' });
  assert.equal(r.ignored, true);
  assert.ok('addressed' in t.calls[0].format.properties);
});

test('потоковая речь: разговорный ответ звучит по предложениям, пока модель пишет; действия — нет', async () => {
  const { createSayStreamer } = require('../src/core/assistant');
  const feed = (json) => {
    const out = [];
    const s = createSayStreamer((t) => out.push(t));
    for (let i = 1; i <= json.length; i++) s.onText(json.slice(0, i));
    s.finish();
    return out;
  };
  assert.deepEqual(feed(JSON.stringify({ topic: 'chat', actions: [], say: 'Раз, сэр. Приходит "Вовочка" в школу! И всё.' })), [
    'Раз, сэр.',
    'Приходит "Вовочка" в школу!',
    'И всё.',
  ]);
  assert.deepEqual(
    feed(JSON.stringify({ topic: 'weather', actions: [{ tool: 'weather', arg: '' }], say: 'Сейчас. Посмотрю.' })),
    [],
    'с действиями — не говорим заранее',
  );
  assert.deepEqual(feed(JSON.stringify({ addressed: false, topic: 'chat', actions: [], say: '' })), []);

  // через ассистента: модель отдаёт ответ кусками
  const { skills, store, ctx } = makeRegistry({ planner: 'single' });
  const streamingLlm = (json) => ({
    chat: async (messages, format, options, onText) => {
      if (onText) for (let i = 1; i <= json.length; i += 7) onText(json.slice(0, i));
      return json;
    },
  });
  const mk = (json) =>
    createAssistant({ config: ctx.config, llm: streamingLlm(json), skills, memory: store, audit: () => {}, notify: () => {} });
  const parts = [];
  let a = mk(JSON.stringify({ topic: 'chat', actions: [], say: 'У меня 2 новости. Обе хорошие.' }));
  let r = await a.handle('расскажи анекдот', { source: 'wake', onSay: (t) => parts.push(t) });
  await a.reset();
  assert.equal(r.streamed, true);
  assert.deepEqual(parts, ['У меня 2 новости.', 'Обе хорошие.'], 'по предложениям, как написано (словами — только в синтезе)');
  // фраза называет навык — план могут переспросить с подсказкой: заранее не говорим
  parts.length = 0;
  a = mk(JSON.stringify({ topic: 'chat', actions: [], say: 'Не знаю.' }));
  r = await a.handle('сколько дней до отпуска', { source: 'wake', onSay: (t) => parts.push(t) });
  await a.reset();
  assert.deepEqual(parts, []);
  assert.ok(!r.streamed);
});

test('«очисти диалог» — без модели; «забудь» находит и напоминание; промахи из журнала', async () => {
  const { skills, store, ctx } = makeRegistry({ planner: 'single' });
  const ended = [];
  const { llm, calls } = fakeLlm(['{"topic":"chat","actions":[],"say":"Привет."}']);
  const assistant = createAssistant({
    config: ctx.config,
    llm,
    skills,
    memory: store,
    audit: () => {},
    notify: () => {},
    onSessionEnd: (r) => ended.push(r),
  });
  await assistant.handle('привет', { source: 'wake' });
  const r = await assistant.handle('артём очистый диалог', { source: 'wake' });
  assert.match(r.say, /чистого листа/);
  assert.equal(calls.length, 1, 'модель не спрашивали');
  assert.deepEqual(ended, ['новый разговор']);
  await assistant.reset();

  // напоминание про стоматолога есть, факта в памяти нет: «забудь» отменяет напоминание
  await skills.init();
  const dan = store.forPerson('p-dan');
  const req = { text: 'забудь про стоматолога', memory: dan };
  assert.equal((await skills.run('remind_at', 'tomorrow 10:00|визит к стоматологу', req)).ok, true);
  assert.match((await skills.run('forget', 'стоматолог', req)).speak, /напоминание/);
  assert.match((await skills.run('reminders', '', req)).speak, /нет/);
  // модель выбрала отмену напоминания, а это факт в памяти — забывается факт
  dan.remember('Завтра визит к стоматологу|2');
  assert.equal((await skills.run('reminders', 'cancel стоматолог', req)).ok, true);
  assert.doesNotMatch(dan.allFactsText(), /стоматолог/);

  const pc = require('../src/skills/pc');
  const music = require('../src/skills/music');
  assert.equal(pc.quick('можешь сказать состояние пока').actions[0].tool, 'pc_status', '«пока» — это «ПК»');
  assert.equal(pc.quick('как дела'), null);
  assert.equal(pc.quick('пока'), null);
  assert.deepEqual(music.quick('играй дальше').actions, [{ tool: 'media', arg: 'play_pause' }]);
});

test('скорость отклика: обрезка тишины синтеза, оборванная реплика, заготовка, ответ поиска по предложениям', async () => {
  // Тишина по краям синтезированной речи срезается, тихое начало слова — нет
  const { trimSilence } = require('../src/core/speech');
  const sr = 1000;
  const audio = new Float32Array(2000);
  for (let i = 500; i < 1200; i++) audio[i] = i < 520 ? 0.002 : 0.5; // тихое начало, потом громко
  const trimmed = trimSilence(audio, sr);
  assert.equal(trimmed.length, 700 + 40 + 100, 'по краям остаётся 40 мс и 100 мс');
  assert.equal(trimmed[40], Math.fround(0.002), 'тихое начало слова на месте');
  assert.equal(trimSilence(new Float32Array(100), sr).length, 100, 'сплошная тишина — как есть');

  // Все инструменты отвечают сами — реплику модели не дописываем
  const { skills, store, ctx } = makeRegistry({ planner: 'single' });
  const { STOP } = require('../src/core/llm');
  let stopped = false;
  const json = JSON.stringify({ topic: 'weather', actions: [{ tool: 'weather', arg: 'Казань' }], say: 'Сейчас посмотрю погоду, сэр.' });
  const cutLlm = {
    chat: async (messages, format, options, onText) => {
      for (let i = 1; i <= json.length; i++) if (onText(json.slice(0, i)) === STOP) return ((stopped = true), json.slice(0, i));
      return json;
    },
  };
  const ran = [];
  const quiet = { ...skills, run: async (tool, arg) => (ran.push([tool, arg]), { ok: true, speak: 'В Казани плюс 5.' }) };
  let fillers = [];
  let waited = 0;
  let a = createAssistant({ config: ctx.config, llm: cutLlm, skills: quiet, memory: store, audit: () => {}, notify: () => {} });
  let r = await a.handle('погода в казани', { source: 'wake', onFiller: (t) => fillers.push(t), beforeActions: async () => waited++ });
  await a.reset();
  assert.ok(stopped, 'генерация оборвана после списка действий');
  assert.deepEqual(ran, [['weather', 'Казань']]);
  assert.equal(waited, 1, 'действия ждали конца речи');
  assert.deepEqual(fillers, [], 'погода быстрая — без заготовки');

  // Инструмент без собственного ответа — реплика модели нужна, генерация идёт до конца
  const openJson = JSON.stringify({ topic: 'apps', actions: [{ tool: 'open_app', arg: 'блокнот' }], say: 'Открываю блокнот.' });
  stopped = false;
  const fullLlm = {
    chat: async (m, f, o, onText) => ((stopped = [...openJson].some((_, i) => onText(openJson.slice(0, i + 1)) === STOP)), openJson),
  };
  a = createAssistant({
    config: ctx.config,
    llm: fullLlm,
    skills: { ...skills, run: async () => ({ ok: true }) },
    memory: store,
    audit: () => {},
    notify: () => {},
  });
  r = await a.handle('открой блокнот', { source: 'wake' });
  await a.reset();
  assert.equal(stopped, false);
  assert.match(r.say, /Открываю блокнот/);

  // Пока человек договаривает, запрос заменили — действия по обрывку не выполняются
  ran.length = 0;
  const controller = new AbortController();
  a = createAssistant({ config: ctx.config, llm: cutLlm, skills: quiet, memory: store, audit: () => {}, notify: () => {} });
  r = await a.handle('погода в', { source: 'wake', signal: controller.signal, beforeActions: async () => controller.abort() });
  await a.reset();
  assert.equal(r.cancelled, true);
  assert.deepEqual(ran, []);

  // Поиск: сразу «Сейчас поищу», ответ звучит по предложениям, пока модель его пишет
  const searchJson = JSON.stringify({ topic: 'search', actions: [{ tool: 'web_search', arg: 'Илон Маск' }], say: '' });
  const answer = 'Илон Маск — предприниматель. Он основал SpaceX в 2002 году.';
  const searching = {
    ...skills,
    run: async (tool, arg, request) => {
      for (let i = 1; i <= answer.length; i += 5) request.onText?.(answer.slice(0, i));
      return { ok: true, speak: answer };
    },
  };
  fillers = [];
  const parts = [];
  a = createAssistant({
    config: ctx.config,
    llm: { chat: async () => searchJson },
    skills: searching,
    memory: store,
    audit: () => {},
    notify: () => {},
  });
  r = await a.handle('кто такой илон маск', {
    source: 'wake',
    person: { id: 'p1', honorific: 'сэр' },
    onSay: (t) => parts.push(t),
    onFiller: (t) => fillers.push(t),
  });
  await a.reset();
  assert.deepEqual(fillers, ['Сейчас поищу.']);
  assert.equal(r.streamed, true);
  assert.equal(parts.length, 2);
  assert.equal(parts[1], 'Он основал SpaceX в 2002 году.', 'по предложениям, как написано (словами — только в синтезе)');
});

test('«закрой X» не запускает X, даже если модель ошиблась (случаи из журнала)', () => {
  const { guardCloseIntent: g } = require('../src/core/assistant');
  const plan = (say, ...actions) => ({ addressed: true, topic: 'steam', say, actions: actions.map(([tool, arg]) => ({ tool, arg })) });
  // «закрой дедлок» → модель запустила игру
  let p = g(plan('Запускаю Deadlock, сэр.', ['steam_launch', 'Deadlock']), 'закрой дедлок');
  assert.deepEqual(p.actions, [{ tool: 'close_app', arg: 'Deadlock' }]);
  assert.equal(p.say, 'Закрываю Deadlock, сэр.');
  // «знагрион закрой дедлок» → модель закрыла сам Steam и сказала «Запускаю Steam»
  p = g(plan('Запускаю Steam, сэр.', ['close_app', 'steam']), 'знагрион закрой дедлок');
  assert.deepEqual(p.actions, [{ tool: 'close_app', arg: 'дедлок' }]);
  assert.equal(p.say, 'Закрываю дедлок, сэр.');
  // верные планы не трогаем
  const ok = plan('Закрываю Chrome.', ['close_app', 'chrome']);
  assert.equal(g(ok, 'закрой хром'), ok);
  const steam = plan('', ['close_app', 'steam']);
  assert.equal(g(steam, 'закрой стим'), steam);
  const launch = plan('', ['steam_launch', 'Deadlock']);
  assert.equal(g(launch, 'запусти дедлок'), launch);
  const music = plan('', ['media', 'pause']);
  assert.equal(g(music, 'выключи музыку'), music);
  // «закрой и открой заново» — оба глагола: решает модель
  const both = plan('', ['steam_launch', 'Deadlock']);
  assert.equal(g(both, 'закрой и открой дедлок заново'), both);
});
