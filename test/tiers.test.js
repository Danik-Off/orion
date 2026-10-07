// Ступени разбора: маленькая модель вызова функций и облако (core/router.js, core/cloud.js)
require('./helpers'); // заглушка Electron — до подключения навыков
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAssistant } = require('../src/core/assistant');
const { tmp, makeRegistry, fakeLlm, loadTestConfig, system } = require('./helpers');

test('роутер: разбор вызова FunctionGemma и какие фразы ей можно давать', () => {
  const { parseCall, routable } = require('../src/core/router');
  assert.deepEqual(parseCall('<start_function_call>call:weather{arg:<escape>Казань<escape>}'), { name: 'weather', arg: 'Казань' });
  assert.deepEqual(parseCall('<start_function_call>call:volume{arg:<escape>-20<escape>}<end_function_call>'), {
    name: 'volume',
    arg: '-20',
  });
  assert.deepEqual(parseCall('call:volume{arg:30}'), { name: 'volume', arg: '30' });
  assert.equal(parseCall('Извините, я не могу помочь.'), null);
  for (const t of ['какая погода в казани', 'сделай на 20 процентов тише', 'включи музыку']) assert.ok(routable(t), t);
  for (const t of ['а завтра', 'закрой его', 'открой телеграм и включи музыку', 'включи это снова']) assert.ok(!routable(t), t);
});

// Подставной сервер маленькой модели: reply() → { content, logprobs? } — как отвечает llama-server
async function routerServer(reply) {
  const http = require('node:http');
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req
      .on('data', (d) => (body += d))
      .on('end', () => {
        requests.push(JSON.parse(body));
        const r = reply(requests.at(-1));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: r.content }, logprobs: r.logprobs && { content: r.logprobs } }] }));
      });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const server = { url: async () => `http://127.0.0.1:${srv.address().port}`, headers: {}, ensure: async () => {}, available: () => true };
  return { server, requests, close: () => (srv.closeAllConnections(), srv.close()) };
}
// Токены вызова с вероятностями: name — уверенность в имени инструмента, arg — в аргументе
const tokens = (call, { name = 0.99, arg = 0.99 } = {}) => {
  const at = call.indexOf('{') + 1;
  return [
    { token: call.slice(0, at), logprob: Math.log(name) },
    { token: call.slice(at), logprob: Math.log(arg) },
  ];
};

test('роутер: дообученной модели — только фраза; готовый вызов, «это навык X» или передача большой модели', async () => {
  const { createRouter, confidence } = require('../src/core/router');
  assert.deepEqual(confidence(undefined), { name: 1, arg: 1 }, 'без вероятностей — проверка только по смыслу');
  let reply = null;
  const r = await routerServer(() => reply);
  try {
    const { skills, store, ctx } = makeRegistry();
    skills.quickPlan = () => null; // проверяем ступени моделей, а не быстрый разбор
    const config = { ...ctx.config, planner: 'two-step', router: { ...ctx.config.router, enabled: true, model: 'orion-router-q8_0.gguf' } }; // дообученная: инструменты знает сама
    const dir = tmp();
    const router = createRouter({ config, server: r.server, skills, dataDir: dir });
    const { llm, calls } = fakeLlm([
      '{"topic":"reminders","actions":[{"tool":"timer","arg":"1800|выключить духовку"}],"say":"Напомню, сэр."}',
      '{"topic":"sound","actions":[{"tool":"volume","arg":"-20"}],"say":""}',
      '{"topic":"chat","actions":[],"say":"Всё хорошо, сэр."}',
    ]);
    const assistant = createAssistant({ config, llm, skills, memory: store, audit: () => {}, notify: () => {}, router });
    const ask = async (text) => {
      const res = await assistant.handle(text, { source: 'text' });
      await assistant.reset();
      return res;
    };

    // уверена в инструменте и простом аргументе — большая модель не нужна
    reply = { content: '<start_function_call>call:volume{arg:<escape>-20<escape>}', logprobs: tokens('call:volume{arg:-20}') };
    let res = await ask('сделай на 20 процентов тише');
    assert.deepEqual(res.actions, [{ tool: 'volume', arg: '-20' }]);
    assert.equal(calls.length, 0);
    if (!system.real)
      assert.ok(
        system.calls.some((c) => c.name === 'powershell'),
        'громкость — только записана: тесты не трогают компьютер',
      );
    assert.equal(r.requests[0].tools, undefined, 'дообученная модель знает инструменты сама — в запросе только фраза');
    assert.equal(r.requests[0].messages.at(-1).content, 'сделай на 20 процентов тише');

    // аргумент надо вычислить (llmArg) — инструмент от маленькой модели, аргумент от большой по узкому промпту
    reply = { content: 'call:timer{}', logprobs: tokens('call:timer{}') };
    res = await ask('напомни через полчаса выключить духовку');
    assert.deepEqual(res.actions, [{ tool: 'timer', arg: '1800|выключить духовку' }]);
    assert.equal(calls.length, 1, 'один короткий диалог');
    assert.match(calls[0].system, /инструментом навыка/);
    assert.match(calls[0].system, /- timer — /, 'описание нужного инструмента');
    assert.doesNotMatch(calls[0].system, /- weather|youtube/, 'чужих навыков в узком промпте нет');
    assert.match(calls[0].system, /Сейчас: /, 'навыку напоминаний нужно время (needs)');
    assert.deepEqual(calls[0].tools.sort(), skills.names(['reminders']).sort(), 'ответ ограничен инструментами навыка');

    // в инструменте уверена, в аргументе — нет: аргумент тоже пишет большая модель
    reply = { content: 'call:volume{arg:<escape>-2<escape>}', logprobs: tokens('call:volume{arg:-2}', { arg: 0.4 }) };
    res = await ask('убавь звук на двадцать');
    assert.deepEqual(res.actions, [{ tool: 'volume', arg: '-20' }]);
    assert.equal(calls.length, 2);

    // не уверена даже в инструменте или ответила текстом — полный разбор (диспетчер)
    reply = { content: 'call:weather{}', logprobs: tokens('call:weather{}', { name: 0.5 }) };
    res = await ask('как настроение');
    assert.equal(res.say, 'Всё хорошо.', 'гостю — без обращения');
    assert.ok(calls.at(-1).format.properties.actions.items.properties.task, 'полный разбор — диспетчер');

    const rows = fs
      .readFileSync(path.join(dir, 'router-data.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(rows.at(-1).text, 'как настроение', 'планы большой модели записываются для дообучения');
  } finally {
    r.close();
  }
});

test('двухшаговый разбор: диспетчер → узкий диалог на каждый шаг; шаг не заполнился — один промпт', async () => {
  const { skills, store, ctx } = makeRegistry({ planner: 'two-step' });
  skills.quickPlan = () => null;
  const { llm, calls } = fakeLlm([
    '{"topic":"apps","actions":[{"tool":"open_app","task":"открыть телеграм"},{"tool":"minimize_all","task":"свернуть всё"},{"tool":"youtube","task":"включить музыку"}],"say":"Открываю Telegram, сворачиваю окна и включаю музыку, сэр."}',
    '{"topic":"apps","actions":[{"tool":"open_app","arg":"телеграм"}],"say":""}',
    '{"topic":"music","actions":[{"tool":"youtube","arg":"музыка микс"}],"say":""}',
  ]);
  const assistant = createAssistant({ config: ctx.config, llm, skills, memory: store, audit: () => {}, notify: () => {} });
  const res = await assistant.handle('открой телеграм сверни всё и включи музыку', { source: 'text' });
  await assistant.reset();
  assert.deepEqual(res.actions, [
    { tool: 'open_app', arg: 'телеграм' },
    { tool: 'minimize_all', arg: '' },
    { tool: 'youtube', arg: 'музыка микс' },
  ]);
  assert.equal(calls.length, 3, 'диспетчер + два узких диалога; у «свернуть всё» аргумента нет — без диалога');
  assert.match(calls[0].system, /- youtube \(music\): /, 'диспетчер видит каталог всех инструментов');
  assert.doesNotMatch(calls[0].system, /arg: /, '…но не форматы аргументов');
  assert.match(calls[1].messages.at(-1).content, /Задача: открыть телеграм/);
  assert.deepEqual([...calls[2].tools].sort(), skills.names(['music']).sort());

  // узкий диалог ничего не дал — запасной один промпт с подробностями названного навыка
  const t = fakeLlm([
    '{"topic":"rates","actions":[{"tool":"rate","task":"курс доллара"}],"say":"Сейчас посмотрю."}',
    '{"topic":"rates","actions":[],"say":""}',
    '{"topic":"rates","actions":[{"tool":"rate","arg":"USD"}],"say":""}',
  ]);
  const a2 = createAssistant({ config: ctx.config, llm: t.llm, skills, memory: store, audit: () => {}, notify: () => {} });
  const r2 = await a2.handle('почём доллар', { source: 'text' });
  await a2.reset();
  assert.deepEqual(r2.actions, [{ tool: 'rate', arg: 'USD' }]);
  assert.match(t.calls[2].system, /Инструменты для этой фразы:[\s\S]*- rate — /, 'один промпт с подробностями навыка');
});

test('облако: выключено по умолчанию; спрашивает разрешение и не получает ничего без него', async () => {
  const { createCloud } = require('../src/core/cloud');
  const config = loadTestConfig();
  assert.equal(createCloud({ config, confirm: async () => true }).available(), false);
  const asked = [];
  const on = {
    ...config,
    cloud: { enabled: true, ask: true, use: 'x', providers: [{ id: 'x', type: 'openai', baseUrl: 'http://127.0.0.1:9', model: 'm' }] },
  };
  const cloud = createCloud({ config: on, confirm: async (t) => (asked.push(t), false) });
  assert.equal(cloud.available(), true);
  assert.equal(await cloud.ask('сколько весит луна'), null);
  assert.match(asked[0], /облако.*сколько весит луна/);
});

test('облако: локальная модель не знает — ответ из облака; отказ без облака остаётся прежним', async () => {
  const { isUnknown } = require('../src/core/assistant');
  assert.ok(isUnknown('Не знаю, сэр.') && isUnknown('У меня нет данных об этом.') && !isUnknown('Знаю, сэр.'));
  const { skills, store, ctx } = makeRegistry();
  const { llm } = fakeLlm(['{"topic":"chat","actions":[],"say":"Не знаю, сэр."}']);
  const questions = [];
  const cloud = { available: () => true, ask: async (q) => (questions.push(q), 'Луна весит 7,35·10²² кг.') };
  const assistant = createAssistant({ config: ctx.config, llm, skills, memory: store, audit: () => {}, notify: () => {}, cloud });
  const r = await assistant.handle('сколько весит луна', { source: 'text' });
  await assistant.reset();
  assert.deepEqual(questions, ['сколько весит луна'], 'в облако — только сама фраза');
  assert.match(r.say, /7,35/);
});

test('облако: OpenAI-совместимый провайдер получает только фразу; неизвестный тип — ошибка в журнале', async () => {
  const http = require('node:http');
  const { createCloud } = require('../src/core/cloud');
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req
      .on('data', (d) => (body += d))
      .on('end', () => {
        seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: ' Луна весит 7,35·10²² кг. ' } }] }));
      });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const config = loadTestConfig();
    const providers = [
      { id: 'local', type: 'openai', baseUrl: `http://127.0.0.1:${srv.address().port}/v1/`, apiKey: 'k', model: 'm' },
      { id: 'bad', type: 'unknown' },
    ];
    const log = [];
    const cloud = createCloud({
      config: { ...config, cloud: { enabled: true, ask: false, use: 'local', providers } },
      confirm: async () => true,
      audit: (e) => log.push(e),
    });
    assert.equal(await cloud.ask('сколько весит луна'), 'Луна весит 7,35·10²² кг.');
    assert.equal(seen[0].path, '/v1/chat/completions');
    assert.equal(seen[0].auth, 'Bearer k');
    assert.equal(seen[0].body.messages.at(-1).content, 'сколько весит луна');
    assert.equal(seen[0].body.messages.length, 2, 'только системная строка и сама фраза — без памяти и истории');

    const bad = createCloud({
      config: { ...config, cloud: { enabled: true, ask: false, use: 'bad', providers } },
      confirm: async () => true,
      audit: (e) => log.push(e),
    });
    assert.equal(await bad.ask('x'), null);
    assert.match(log.at(-1).error, /неизвестный тип провайдера/);
  } finally {
    srv.close();
  }
});

test('без большой модели: быстрые команды работают, на остальное — честный ответ; облако — подстраховка', async () => {
  const { NO_BRAIN } = require('../src/core/assistant/model-planner');
  const { skills, store, ctx } = makeRegistry();
  const { llm, calls } = fakeLlm(['{"topic":"chat","actions":[],"say":"не должно прозвучать"}']);
  llm.available = () => false;
  const log = [];
  const assistant = createAssistant({ config: ctx.config, llm, skills, memory: store, audit: (e) => log.push(e), notify: () => {} });
  let r = await assistant.handle('пауза', { source: 'text' }); // быстрый разбор — без моделей
  assert.ok(r.actions.length > 0);
  r = await assistant.handle('расскажи про чёрные дыры', { source: 'text' });
  await assistant.reset();
  assert.equal(r.say, NO_BRAIN.replace(', сэр', ''), 'гостю — без обращения');
  assert.equal(calls.length, 0, 'к отсутствующей модели не обращаемся');
  assert.ok(log.some((e) => e.brain === 'нет большой модели'));

  const cloud = { available: () => true, ask: async () => 'Чёрные дыры — области, откуда не выходит даже свет.' };
  const withCloud = createAssistant({ config: ctx.config, llm, skills, memory: store, audit: () => {}, notify: () => {}, cloud });
  r = await withCloud.handle('расскажи про чёрные дыры', { source: 'text' });
  await withCloud.reset();
  assert.match(r.say, /не выходит даже свет/, 'облако подстраховывает');
});
