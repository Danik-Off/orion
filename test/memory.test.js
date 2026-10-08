// Память людей и разговоров (core/memory.js, сессия в core/assistant)
require('./helpers'); // заглушка Electron — до подключения навыков
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssistant } = require('../src/core/assistant');
const { createMemory, similarity } = require('../src/core/memory');
const { tmp, makeRegistry, fakeLlm } = require('./helpers');
const weather = require('../src/skills/weather');

test('память раздельная по людям; гость ничего не записывает', async () => {
  const store = createMemory({ dir: tmp() });
  const dan = store.forPerson('p-dan');
  const ann = store.forPerson('p-ann');
  dan.setProfile('city=Казань');
  dan.remember('Любит джаз');
  ann.remember('Любит классику');
  assert.match(dan.allFactsText(), /джаз/);
  assert.doesNotMatch(dan.allFactsText(), /классик/);
  assert.equal(ann.profile().city, undefined);
  assert.equal(store.forPerson(null).remember('x').ok, false);

  // память и навыки: погода берёт город конкретного собеседника
  const { skills, store: s2 } = makeRegistry();
  const mem = s2.forPerson('p-1');
  mem.remember('Живёт в Казани');
  assert.equal(weather.homeCity({ memory: mem, config: { city: 'Москва' } }), 'Казани');
  mem.setProfile('city=Казань');
  assert.equal(weather.homeCity({ memory: mem, config: { city: 'Москва' } }), 'Казань');
  assert.equal((await skills.run('remember', 'Любит чай', { memory: mem })).ok, true);
  assert.match(mem.allFactsText(), /чай/);
});

test('база знаний: обновление по номеру, без дубликатов, срок жизни, нечёткое «забудь»', () => {
  const m = createMemory({ dir: tmp() }).forPerson('p');
  m.remember('Предпочитает шутливый стиль общения');
  m.remember('Работает программистом');
  m.remember('Работает программистом');
  assert.equal(m.count(), 2);
  m.remember('#2 Работает дизайнером');
  assert.match(m.allFactsText(), /#2 Работает дизайнером/);
  m.remember('Собеседование завтра|1');
  assert.match(m.allFactsText(), /Собеседование завтра \(до/);
  assert.equal(m.forget('стель общение').ok, true, 'опечатки из распознавания');
  assert.equal(m.forget('что-то несуществующее').ok, false);
  assert.ok(similarity('стиль общения', 'Предпочитает шутливый стиль общения') >= 0.5);
});

test('общая память: место и факты не о человеке, видна всем, отдельные номера', async () => {
  const { skills, store } = makeRegistry();
  const dan = store.forPerson('p-dan');
  const req = { memory: dan };
  assert.equal((await skills.run('remember_shared', 'city=Казань', req)).ok, true);
  assert.equal((await skills.run('remember_shared', 'Дома живёт кот Барсик', req)).ok, true);
  assert.equal((await skills.run('remember', 'Любит джаз', req)).ok, true);
  assert.equal(store.shared.profile().city, 'Казань');
  assert.match(store.shared.allFactsText(), /Барсик/);
  assert.doesNotMatch(dan.allFactsText(), /Барсик/);
  // погода: у собеседника без города — город из общей памяти
  assert.equal(weather.homeCity({ memory: store.forPerson('p-ann'), shared: store.shared, config: { city: 'Москва' } }), 'Казань');
  // забыть: «#о1» — общий, описание — сначала личное, потом общее
  assert.equal((await skills.run('forget', 'барсик', req)).ok, true);
  assert.doesNotMatch(store.shared.allFactsText(), /Барсик/);
  assert.match(dan.allFactsText(), /джаз/);
});

test('золотая рыбка: конец разговора — реплики забыты, окно получает сигнал стереть их', async () => {
  const { skills, store, ctx } = makeRegistry();
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
  await assistant.endSession('конец диалога');
  assert.deepEqual(ended, ['конец диалога']);
  await assistant.handle('как дела', { source: 'wake' });
  const last = calls.at(-1).messages;
  assert.equal(last.filter((m) => m.role !== 'system').length, 1, 'в новый разговор прошлые реплики не попадают');
  await assistant.reset();
  assert.equal(ended.at(-1), 'новый разговор');
});

test('другой голос закрывает разговор, только если обращается к Ориону', async () => {
  const { skills, store, ctx } = makeRegistry();
  const ended = [];
  const answers = [];
  const llm = {
    chat: async (messages) => (
      answers.push(messages),
      answers.length === 2
        ? '{"addressed":false,"topic":"chat","actions":[],"say":""}'
        : '{"addressed":true,"topic":"chat","actions":[],"say":"Да."}'
    ),
  };
  const assistant = createAssistant({
    config: ctx.config,
    llm,
    skills,
    memory: store,
    audit: () => {},
    notify: () => {},
    onSessionEnd: (r) => ended.push(r),
  });
  const dan = { id: 'p-dan', honorific: 'сэр' };
  const ann = { id: 'p-ann', honorific: 'мисс' };
  await assistant.handle('привет', { source: 'wake', person: dan });
  // Анна говорит рядом не Ориону — разговор с Даном продолжается
  assert.equal((await assistant.handle('пойдём уже ужинать', { source: 'followup', person: ann })).ignored, true);
  assert.deepEqual(ended, []);
  // Анна обратилась к Ориону — теперь разговор с Даном закрыт
  await assistant.handle('Орион, какая погода', { source: 'wake', person: ann });
  assert.deepEqual(ended, ['смена собеседника']);
  await assistant.reset();
});
