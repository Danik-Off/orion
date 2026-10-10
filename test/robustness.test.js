// Устойчивость «на дурака»: странные фразы распознавания, мусорные аргументы модели, модель, которая ломается,
// и работа без большой модели. Ничего не должно падать, зависать или делать в системе то, о чём не просили.
// Системные вызовы — заглушки (helpers), сеть отключена: проверяем поведение, а не компьютер.
const { makeRegistry, system } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { PHRASES, ARGS } = require('./fuzz-inputs');
const { createAssistant } = require('../src/core/assistant');
const { fromText } = require('../src/lib/text-args');
const { extractAnswer } = require('../src/lib/extract-answer');
const { parseCall, routable } = require('../src/core/router');
const { isContinuation, isStopForOrion } = require('../src/renderer/commands');
const { parseClock } = require('../src/lib/clock');
const { durationFromText, wordsToNumber } = require('../src/lib/ru');

// Инструменты с необратимыми или внешними действиями — их на мусоре не гоняем даже с заглушками
const SKIP = new Set(['file_op', 'delegate', 'delegate_task', 'run_command', 'scenario_save', 'scenario_run', 'steam_launch']);
const timed = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`завис: ${what}`)), ms))]);

function offline() {
  const real = global.fetch;
  global.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  return () => (global.fetch = real);
}

function registry() {
  const r = makeRegistry();
  Object.assign(r.ctx, {
    saveSettings: () => ({ ok: true }),
    radio: { play() {}, stop() {}, pause() {}, state: () => ({}), place: () => true },
    say: () => {},
    alarm: () => {},
    ask: async () => null,
    trashItem: async () => {},
    showItemInFolder: () => {},
    clipboard: { readText: () => 'текст', writeText() {} },
    llm: { answer: async () => 'ответ', chat: async () => '{}', available: () => false },
  });
  return r;
}

test('быстрый разбор: странные фразы не роняют его, а план — только из настоящих инструментов', () => {
  const { skills } = registry();
  for (const t of PHRASES) {
    let plan;
    assert.doesNotThrow(() => (plan = skills.quickPlan(t)), `упал на ${JSON.stringify(t.slice(0, 40))}`);
    for (const a of plan?.actions || []) {
      assert.ok(skills.toolInfo(a.tool), `неизвестный инструмент ${a.tool}`);
      assert.equal(typeof a.arg, 'string');
      assert.ok(skills.argAllowed(a.tool, a.arg), `${a.tool}(${a.arg}) на ${JSON.stringify(t.slice(0, 40))}`);
    }
  }
});

test('разбор аргументов без модели: на любой фразе — строка, null или undefined, не исключение', () => {
  const { skills, ctx } = registry();
  for (const tool of skills.names())
    for (const t of PHRASES) {
      const a = fromText(tool, t, { config: ctx.config });
      assert.ok(a === null || a === undefined || typeof a === 'string', `${tool} на ${JSON.stringify(t.slice(0, 30))}`);
    }
});

test('инструменты на мусорных аргументах: отвечают, не зависают; мусор не меняет громкость и яркость', async () => {
  const back = offline();
  try {
    const { skills } = registry();
    for (const tool of skills.names()) {
      if (SKIP.has(tool)) continue;
      for (const arg of ARGS) {
        const r = await timed(skills.run(tool, arg, { text: arg }), 5000, `${tool}(${arg.slice(0, 20)})`);
        assert.equal(typeof r?.ok, 'boolean', `${tool}(${JSON.stringify(arg.slice(0, 20))}) → ${JSON.stringify(r)}`);
      }
    }
    for (const tool of ['volume', 'brightness'])
      for (const arg of ['javascript:alert(1)', 'voice 99', 'C:\\Windows', '25:99', 'x'.repeat(100)]) {
        system.calls.length = 0;
        const r = await skills.run(tool, arg, { text: arg });
        assert.equal(r.ok, false, `${tool}(${arg})`);
        assert.equal(system.calls.length, 0, `${tool}(${arg}) не трогает систему`);
      }
  } finally {
    back();
  }
});

test('нет интернета — так и сказано, а не «не получилось»', async () => {
  const back = offline();
  try {
    const { skills } = registry();
    const r = await skills.run('weather', 'Казань|сегодня', { text: 'погода в Казани' });
    assert.equal(r.ok, false);
    assert.match(r.message, /интернет/);
  } finally {
    back();
  }
});

// Модель, которая ведёт себя как угодно: мусор, не тот формат, исключения, пустота
const BROKEN = [
  '',
  'не json',
  '{',
  '[]',
  'null',
  '{"actions":"всё"}',
  '{"topic":"chat","actions":[{"tool":"rm_rf","arg":"/"}],"say":"удалил"}',
  '{"topic":"chat","actions":[{"tool":"power","arg":12345}],"say":7}',
  `{"topic":"chat","actions":${JSON.stringify(Array.from({ length: 50 }, () => ({ tool: 'media', arg: 'next' })))},"say":"ок"}`,
  `{"topic":"chat","actions":[],"say":${JSON.stringify('слово '.repeat(5000))}}`,
  '{"topic":"chat","actions":[{"tool":"volume","arg":"javascript:alert(1)"}],"say":""}',
];

test('большая модель отвечает мусором или падает — ход разговора всё равно заканчивается ответом', async () => {
  const back = offline();
  try {
    for (const raw of [...BROKEN, new Error('модель упала')]) {
      const { skills, store, ctx } = registry();
      const ran = [];
      const run = skills.run;
      skills.run = (tool, arg, req) => (ran.push({ tool, arg }), run(tool, arg, req));
      const llm = {
        chat: async () => {
          if (raw instanceof Error) throw raw;
          return raw;
        },
        answer: async () => 'ответ',
        available: () => true,
      };
      const assistant = createAssistant({ config: ctx.config, llm, skills, memory: store, audit: () => {}, notify: () => {} });
      const r = await timed(assistant.handle('сделай что-нибудь странное', { source: 'text' }), 10000, String(raw).slice(0, 30));
      await assistant.reset();
      assert.equal(typeof r.say, 'string', `ответ на ${String(raw).slice(0, 40)}`);
      assert.ok(r.say.length <= 3000, 'ответ разумной длины');
      assert.ok(!ran.some((a) => a.tool === 'rm_rf' || a.tool === 'power'), 'выдуманные и опасные действия не выполнены');
      assert.ok(ran.length <= 5, `не больше пяти действий за раз (было ${ran.length})`);
    }
  } finally {
    back();
  }
});

test('без большой модели: любая фраза — ответ или молчание, без исключений и опасных действий', async () => {
  const back = offline();
  try {
    const { skills, store, ctx } = registry();
    let current = '';
    const risky = [];
    const run = skills.run;
    skills.run = (tool, arg, req) => {
      if (tool === 'file_op' || (tool === 'power' && !/компьютер/.test(current))) risky.push(`${tool} ← ${current.slice(0, 40)}`);
      return run(tool, arg, req);
    };
    const llm = { chat: async () => '', answer: async () => '', available: () => false };
    const assistant = createAssistant({ config: ctx.config, llm, skills, memory: store, audit: () => {}, notify: () => {} });
    for (const t of PHRASES) {
      current = t;
      const r = await timed(assistant.handle(t, { source: 'text' }), 8000, t.slice(0, 30));
      await assistant.reset();
      assert.ok(r && typeof r === 'object', JSON.stringify(t.slice(0, 30)));
    }
    // Питание — только когда о компьютере сказано прямо (и навык ещё переспросит); файлы — никогда
    assert.deepEqual(risky, []);
  } finally {
    back();
  }
});

test('без большой модели: частые команды выполняются правилами, вопросы ищутся, болтовня — коротко', async () => {
  const back = offline();
  try {
    const { skills, store, ctx } = registry();
    const ran = [];
    skills.run = async (tool, arg) => (ran.push(`${tool}(${arg})`), { ok: true });
    const llm = { chat: async () => '', answer: async () => '', available: () => false };
    // Маленькая модель «назвала» инструмент — как router.route с alone: аргумент разберут правила
    const router = {
      route: async (text) => {
        if (/напомни/.test(text)) return { focus: { skill: 'reminders', tool: /через/.test(text) ? 'timer' : 'remind_at', arg: null } };
        if (/сколько будет/.test(text)) return { focus: { skill: 'calc', tool: 'calc', arg: null } };
        if (/выруби радио/.test(text)) return { focus: { skill: 'radio', tool: 'radio', arg: '' } };
        return null;
      },
      record: () => {},
    };
    const assistant = createAssistant({ config: ctx.config, llm, skills, memory: store, audit: () => {}, notify: () => {}, router });
    const say = async (t) => {
      ran.length = 0;
      const r = await assistant.handle(t, { source: 'text' });
      await assistant.reset();
      return { r, ran: [...ran] };
    };
    assert.deepEqual((await say('напомни через 10 минут выключить чайник')).ran, ['timer(600|выключить чайник)']);
    assert.deepEqual((await say('напомни завтра в 9 позвонить маме')).ran, ['remind_at(tomorrow 09:00|позвонить маме)']);
    assert.deepEqual((await say('сколько будет 17 умножить на 23')).ran, ['calc(17 * 23)']);
    // «Выруби радио»: маленькая модель спутала с включением — правило не даёт включить, выключает
    assert.deepEqual((await say('выруби радио')).ran, ['radio_stop()']);
    assert.deepEqual((await say('кто такой Юрий Гагарин')).ran, ['web_search(кто такой Юрий Гагарин)']);
    // Два дела — по частям; непонятная часть названа
    const two = await say('сделай скриншот и поставь громкость на 30');
    assert.deepEqual(two.ran.sort(), ['screenshot()', 'volume(30)'].sort());
    assert.match((await say('как дела')).r.say, /порядке/);
    // Непонятное без большой модели — честно «нужна большая модель», а не «не расслышал» на всё подряд
    assert.match((await say('закипёж')).r.say, /большой модел|большая языковая/i);
    assert.doesNotMatch((await say('открой настройки')).r.say, /расслышал/i);
    assert.deepEqual((await say('открой настройки')).ran, ['open_settings()']);
    assert.match((await say('кто ты вообще такой')).r.say, /помощник/);
    assert.deepEqual((await say('расскажи анекдот')).ran, ['fact()'], 'анекдот без модели — интересный факт');
    assert.match((await say('мне грустно сегодня')).r.say, /большой модел/);
    // Повтор — коротко
    assert.ok((await say('я вчера смотрел классный фильм')).r.say.length < 60, 'второй раз — короткое объяснение');
    // «Выключи свет в гостиной» — не про компьютер: питание правилами не трогается
    assert.ok(!(await say('выключи свет в гостиной через home assistant')).ran.some((a) => a.startsWith('power')));
  } finally {
    back();
  }
});

test('мелкие разборщики на мусоре: время, длительность, числа, вызов маленькой модели, ответ из текста', () => {
  for (const t of PHRASES) {
    assert.doesNotThrow(() => parseClock(t));
    assert.doesNotThrow(() => durationFromText(t));
    assert.doesNotThrow(() => wordsToNumber(t));
    assert.doesNotThrow(() => parseCall(t));
    assert.doesNotThrow(() => routable(t));
    assert.doesNotThrow(() => extractAnswer(t, t));
    assert.doesNotThrow(() => isStopForOrion({ command: t, final: t, listening: true }));
    assert.doesNotThrow(() => isContinuation({ askedAt: 0, startedAt: 100, text: t }));
  }
  assert.equal(parseCall('<start_function_call>call:'), null);
  assert.equal(parseClock('разбуди меня в 25:99'), null, 'нет такого времени');
  assert.equal(extractAnswer('вопрос', ''), '');
});

test('без большой модели: уточнения к прошлому ответу — «а на выходных», «а другую», «ещё один на 10», «а про спорт»', async () => {
  const { skills, store, ctx } = makeRegistry();
  const ran = [];
  skills.run = async (tool, arg) => (ran.push(`${tool}(${arg})`), { ok: true, speak: 'ок' });
  const llm = { chat: async () => '', answer: async () => '', available: () => false };
  const assistant = createAssistant({ config: ctx.config, llm, skills, memory: store, audit: () => {}, notify: () => {} });
  const dialog = async (lines) => {
    const out = [];
    for (const [i, t] of lines.entries()) {
      ran.length = 0;
      await assistant.handle(t, { source: i ? 'followup-voice' : 'text' });
      out.push(ran.join(' '));
    }
    await assistant.reset();
    return out.slice(1);
  };
  assert.deepEqual(await dialog(['какая погода', 'а на выходных', 'а в казани']), ['weather(|выходные)', 'weather(казани|сегодня)']);
  assert.deepEqual(await dialog(['включи радио маяк', 'а другую']), ['radio(другое)']);
  assert.deepEqual(await dialog(['поставь таймер на 5 минут', 'а ещё один на 10']), ['timer(600|таймер)']);
  assert.deepEqual(await dialog(['что нового в мире', 'а про спорт']), ['news(спорт)']);
  // Без прошлого ответа навыка «а другую» — не команда радио
  assert.deepEqual(await dialog(['привет', 'а другую']), ['']);
});
