// Знакомство после установки: город (как у сервиса погоды), запись голоса, первые команды; один раз;
// не ответили — спросит при следующем запуске; обновление со старой версии — без знакомства
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmp } = require('./helpers');
const onboarding = require('../src/skills/onboarding');
const weather = require('../src/skills/weather');

test('знакомство: город из ответа — без «я живу в», «ну», «город»; отказ — пусто', () => {
  const { cityOf } = onboarding._test;
  assert.equal(cityOf('Я живу в Казани'), 'Казани');
  assert.equal(cityOf('ну мы в санкт-петербурге'), 'Санкт-Петербурге');
  assert.equal(cityOf('город Ростов-на-Дону'), 'Ростов-на-Дону');
  assert.equal(cityOf('Москва.'), 'Москва');
  assert.equal(cityOf('нет'), '');
  assert.equal(cityOf('я не знаю что сказать тебе сейчас'), '', 'длинное — не город');
});

function run(answers, { dataDir = tmp(), confirm = false } = {}) {
  const saved = {};
  const calls = { ask: 0, said: [], enroll: 0, shared: [] };
  const ctx = {
    config: { onboarded: false },
    dataDir,
    ask: async () => (calls.ask++, answers.shift()),
    confirm: async () => confirm,
    saveSettings: (p) => Object.assign(saved, p),
    say: (t) => calls.said.push(t),
    startEnrollment: () => calls.enroll++,
    shared: { setProfile: (p) => calls.shared.push(p) },
  };
  return onboarding.offer(ctx).then(() => ({ saved, calls }));
}

test('знакомство: город — как у сервиса погоды; голос — по согласию; иначе — первые команды', async () => {
  const real = weather.geocode;
  weather.geocode = async (c) => (/^Казан/.test(c) ? { name: 'Казань' } : null);
  try {
    let r = await run(['Я живу в Казани'], { confirm: true });
    assert.deepEqual(r.saved, { onboarded: true, city: 'Казань' }, '«Казани» → «Казань»');
    assert.deepEqual(r.calls.shared, ['city=Казань']);
    assert.equal(r.calls.enroll, 1, 'согласились — мастер записи голоса');
    assert.equal(r.calls.said.length, 0);

    r = await run(['в Нижнем Новгороде'], { confirm: false });
    assert.equal(r.saved.city, 'Нижнем Новгороде', 'не нашёлся — как сказано');
    assert.match(r.calls.said[0], /^Запомнил: Нижнем Новгороде\. Для начала попробуйте: «Орион, какая погода\?»/);

    r = await run([null]); // «Пропустить»
    assert.deepEqual(r.saved, { onboarded: true }, 'пропустили — больше не спрашивать, город не трогать');

    r = await run([undefined]); // не ответили — человек отошёл
    assert.deepEqual(r.saved, {}, 'спросит при следующем запуске');
  } finally {
    weather.geocode = real;
  }
});

test('знакомство: обновление со старой версии (журнал старше запуска) или голос уже записан — без вопросов', async () => {
  const old = tmp();
  fs.writeFileSync(path.join(old, 'actions.log'), `${JSON.stringify({ t: '2026-01-01T00:00:00Z', input: 'привет' })}\n`);
  let r = await run(['Казань'], { dataDir: old });
  assert.equal(r.calls.ask, 0);
  assert.deepEqual(r.saved, { onboarded: true });

  const voices = tmp();
  fs.writeFileSync(path.join(voices, 'people.json'), JSON.stringify([{ id: 'a', name: 'Аня' }]));
  r = await run(['Казань'], { dataDir: voices });
  assert.equal(r.calls.ask, 0);
});
