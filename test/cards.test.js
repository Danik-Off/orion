// Карточки, «Запланировано», подсказки и звуки для сна: что окно показывает и что за этим стоит в ядре
const { makeRegistry } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { countdown, whenLabel, timeText, degreesText } = require('../src/ui/src/lib/format.ts');
const { hintsFor, HINTS } = require('../src/ui/src/lib/commands.ts');
const { createAssistant } = require('../src/core/assistant');
const { soundOf, stationOf, isSoundUrl } = require('../src/lib/sounds');
const { fromText } = require('../src/lib/text-args');

test('отсчёт и время срабатывания', () => {
  assert.equal(countdown(42_000), '0:42');
  assert.equal(countdown(245_000), '4:05');
  assert.equal(countdown(3_750_000), '1:02:30');
  assert.equal(countdown(-5), '0:00');
  assert.equal(countdown(3 * 86_400_000), '3 дн');
  const now = new Date(2026, 9, 10, 22, 0).getTime(); // суббота
  assert.equal(whenLabel(new Date(2026, 9, 10, 23, 30).getTime(), now), 'в 23:30');
  assert.equal(whenLabel(new Date(2026, 9, 11, 7, 0).getTime(), now), 'завтра в 07:00');
  assert.equal(whenLabel(new Date(2026, 9, 13, 9, 5).getTime(), now), 'вт в 09:05');
  assert.equal(whenLabel(new Date(2026, 10, 1, 9, 0).getTime(), now), '01.11 в 09:00');
  // до часа — отсчёт, дальше — время
  assert.equal(timeText(now + 600_000, now), '10:00');
  assert.equal(timeText(new Date(2026, 9, 11, 7, 0).getTime(), now), 'завтра в 07:00');
  assert.equal(degreesText(5), '+5°');
  assert.equal(degreesText(-3), '-3°');
  assert.equal(degreesText(0), '0°');
});

test('подсказки по времени суток — и каждая выполняется без большой модели', async () => {
  assert.equal(hintsFor(8), HINTS.morning);
  assert.equal(hintsFor(14), HINTS.day);
  assert.equal(hintsFor(20), HINTS.evening);
  assert.equal(hintsFor(2), HINTS.night);
  assert.equal(hintsFor(23), HINTS.night);

  const { skills, store, ctx } = makeRegistry();
  const ran = [];
  skills.run = async (tool, arg) => (ran.push(`${tool}(${arg})`), { ok: true });
  const llm = { chat: async () => '', answer: async () => '', available: () => false };
  const assistant = createAssistant({ config: ctx.config, llm, skills, memory: store, audit: () => {}, notify: () => {} });
  const expected = {
    'Включи звуки дождя': 'sleep_sound(rain)',
    'Напомни через час размяться': 'timer(3600|размяться)',
    'Какая погода?': 'weather(|сегодня)',
    'Разбуди меня в семь': 'alarm(07:00)',
  };
  for (const t of new Set(Object.values(HINTS).flat())) {
    ran.length = 0;
    await assistant.handle(t, { source: 'text' });
    await assistant.reset();
    assert.equal(ran.length, 1, `«${t}» — одно действие без модели, а не «нужна большая модель»`);
    if (expected[t]) assert.equal(ran[0], expected[t], t);
  }
});

test('«через час размяться»: текст напоминания не теряется, предлог в него не попадает', () => {
  assert.equal(fromText('timer', 'напомни через час размяться'), '3600|размяться');
  assert.equal(fromText('timer', 'напомни через полчаса проверить почту'), '1800|проверить почту');
  assert.equal(fromText('timer', 'напомни через семь'), '420|таймер');
  assert.equal(fromText('timer', 'напомни через 10 минут выключить чайник'), '600|выключить чайник');
  assert.equal(fromText('remind_at', 'напоминай пить воду каждый час'), 'every 60|пить воду');
});

test('запланированное: таймеры и напоминания — списком с отменой по одному, с карточкой при постановке', async () => {
  const { skills, ctx } = makeRegistry();
  const reminders = require('../src/skills/reminders');
  let changes = 0;
  ctx.onSchedule = () => changes++;
  await skills.init(); // как при запуске приложения: навык подключает уведомления окна (без dataDir — без тиканья)
  const t = await skills.run('timer', '600|чайник');
  assert.equal(t.card.type, 'timer');
  assert.equal(t.card.label, 'чайник');
  assert.equal(t.speak, 'Напомню через 10 минут: чайник.', 'говорит, что поставил, а не «Готово»');
  for (const [arg, said] of [
    ['90|таймер', 'Засёк минуту 30 секунд.'],
    ['3600', 'Засёк час.'],
  ]) {
    const x = await skills.run('timer', arg);
    assert.equal(x.speak, said);
    reminders.cancel(x.card.id);
  }
  assert.ok(Math.abs(t.card.at - (Date.now() + 600_000)) < 2000);
  const r = await skills.run('remind_at', 'tomorrow 09:00|позвонить маме');
  assert.equal(r.card.kind, 'reminder');
  const a = await skills.run('alarm', 'weekdays 07:00');
  assert.equal(a.card.kind, 'alarm');
  assert.equal(a.card.repeat, 'по будням');

  const list = reminders.schedule();
  assert.deepEqual(new Set(list.map((c) => c.id)), new Set([t.card.id, r.card.id, a.card.id]));
  assert.equal(list[0].id, t.card.id, 'ближайшее — первым');
  assert.ok(changes >= 3, 'окно узнаёт о каждом изменении');

  assert.equal(reminders.cancel(t.card.id), true);
  assert.equal(reminders.cancel(r.card.id), true);
  assert.equal(reminders.cancel('r999'), false);
  assert.deepEqual(
    reminders.schedule().map((c) => c.id),
    [a.card.id],
  );
  reminders.cancel(a.card.id);
  reminders._reset();
});

test('карточки навыков доходят до окна в ответе ассистента', async () => {
  const { skills, store, ctx } = makeRegistry();
  skills.run = async () => ({ ok: true, speak: 'Напомню.', card: { type: 'timer', id: 't9', kind: 'timer', at: 1, label: 'x' } });
  const llm = { chat: async () => '', answer: async () => '', available: () => false };
  const assistant = createAssistant({ config: ctx.config, llm, skills, memory: store, audit: () => {}, notify: () => {} });
  const r = await assistant.handle('напомни через 10 минут выключить чайник', { source: 'text' });
  assert.deepEqual(r.cards, [{ type: 'timer', id: 't9', kind: 'timer', at: 1, label: 'x' }]);
});

test('погода: значок карточки по коду погоды', () => {
  const { iconOf } = require('../src/skills/weather');
  assert.equal(iconOf(0), 'clear');
  assert.equal(iconOf(2), 'partly');
  assert.equal(iconOf(3), 'cloud');
  assert.equal(iconOf(45), 'fog');
  assert.equal(iconOf(63), 'rain');
  assert.equal(iconOf(81), 'rain');
  assert.equal(iconOf(73), 'snow');
  assert.equal(iconOf(95), 'storm');
});

test('звуки для сна: что включить, а что — погода или громкость', () => {
  const { skills } = makeRegistry();
  const plan = (t) =>
    skills
      .quickPlan(t)
      ?.actions.map((x) => `${x.tool}(${x.arg})`)
      .join(' ') ?? null;
  assert.equal(plan('включи звуки дождя'), 'sleep_sound(rain)');
  assert.equal(plan('включи шум моря на полчаса'), 'sleep_sound(sea|30)');
  assert.equal(plan('белый шум'), 'sleep_sound(white)');
  assert.equal(plan('поставь звуки природы'), 'sleep_sound(rain)');
  assert.equal(plan('включи тихий шум на час'), 'sleep_sound(brown|60)');
  assert.equal(plan('выключи шум'), 'radio_stop()');
  assert.notEqual(plan('будет ли дождь завтра'), 'sleep_sound(rain)', 'вопрос о погоде');
  // «включи звук» — вернуть звук, а не переключить клавишей mute (раньше при включённом звуке выключала)
  assert.equal(plan('включи звук'), 'volume(unmute)');
  assert.equal(plan('выключи звук'), 'volume(mute)');

  assert.equal(soundOf('море').id, 'sea');
  assert.equal(soundOf('sea|30').id, 'sea');
  assert.equal(soundOf('какая погода'), null);
  assert.equal(isSoundUrl(stationOf(soundOf('дождь')).url), true);
  assert.equal(isSoundUrl('https://x/sound:rain'), false);
});

test('звук для сна на время: включает и заводит таймер сна', async () => {
  const { skills, ctx } = makeRegistry();
  const played = [];
  ctx.radio = { play: (s) => played.push(s), stop: () => {} };
  const r = await skills.run('sleep_sound', 'sea|30');
  assert.equal(r.ok, true);
  assert.equal(played[0].url, 'sound:sea');
  assert.match(r.speak, /шум моря.*30 мин/);
});
