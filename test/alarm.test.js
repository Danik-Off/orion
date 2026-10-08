// Будильник: время словами, постановка и повтор по будням, срабатывание (опоздавший не будит), звонок в окне —
// «стоп» и «ещё пять минут» голосом без имени, нарастающий сигнал, радио вместо сигнала.
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClock, formatClock } = require('../src/lib/clock');
const reminders = require('../src/skills/reminders');

const clock = (t) => {
  const r = parseClock(t);
  return r ? formatClock(r) : null;
};
const tool = (name) => reminders.tools.find((x) => x.name === name);

test('будильник: время словами — «семь тридцать» это 7:30, а не 37', () => {
  assert.equal(clock('разбуди меня в семь'), '07:00');
  assert.equal(clock('в семь тридцать'), '07:30');
  assert.equal(clock('на шесть сорок пять'), '06:45');
  assert.equal(clock('в половине восьмого'), '07:30');
  assert.equal(clock('в восемь вечера'), '20:00');
  assert.equal(clock('в двадцать три пятнадцать'), '23:15');
  assert.equal(clock('в семь ноль пять'), '07:05');
  assert.equal(clock('в час ночи'), '01:00');
  assert.equal(clock('в девять утра по будням'), '09:00', '«по будням» — не «дня»');
  assert.equal(clock('будильник на 7:30'), '07:30');
  assert.equal(clock('через десять минут'), null, 'не время на часах');
  assert.equal(clock('разбуди меня'), null);
});

test('будильник: фразы без модели — время, повтор, радио, отмена, список', () => {
  const arg = (t) => reminders.quick(t)?.actions[0];
  assert.deepEqual(arg('Разбуди меня в семь'), { tool: 'alarm', arg: '07:00' });
  assert.deepEqual(arg('разбуди меня в семь тридцать под радио маяк'), { tool: 'alarm', arg: '07:30|радио маяк' });
  assert.deepEqual(arg('поставь будильник на шесть сорок пять по будням'), { tool: 'alarm', arg: 'weekdays 06:45' });
  assert.deepEqual(arg('разбуди меня завтра в восемь'), { tool: 'alarm', arg: 'tomorrow 08:00' });
  assert.deepEqual(arg('будильник через двадцать минут'), { tool: 'alarm', arg: 'in 20' });
  assert.deepEqual(arg('отмени будильник'), { tool: 'alarm', arg: 'cancel' });
  assert.deepEqual(arg('какие у меня будильники'), { tool: 'alarm', arg: 'list' });
  assert.equal(reminders.quick('поставь будильник'), null, 'без времени — переспросит модель');
  assert.equal(reminders.quick('напомни в семь позвонить'), null, 'напоминание — не будильник');
});

test('будильник: ставится, по будням пропускает выходные, звонит в срок, опоздавший молчит, отменяется', async () => {
  reminders._reset();
  const realNow = Date.now;
  try {
    let r = await tool('alarm').run('weekdays 07:00|радио маяк');
    assert.match(r.speak, /^Будильник по будням в 07:00, разбужу радио маяк\.$/);
    const item = reminders.upcoming(24 * 8).find((x) => x.alarm);
    assert.ok(![0, 6].includes(new Date(item.at).getDay()), 'ближайший — будний день');

    r = await tool('alarm').run('list');
    assert.match(r.speak, /по будням в 07:00/);

    // Срабатывание: в срок — звонит; повтор переносится на следующий будний день
    const rang = [];
    const ctx = { alarm: (p) => rang.push(p), remind: () => assert.fail('будильник — не напоминание'), audit: () => {} };
    const firstAt = item.at; // срабатывание меняет время того же объекта — запомнить
    Date.now = () => firstAt + 30_000;
    reminders._tick(ctx);
    assert.deepEqual(rang, [{ id: item.id, label: 'Будильник 07:00', radio: 'маяк' }]);
    const next = reminders.upcoming(24 * 8).find((x) => x.alarm);
    assert.ok(next.at > firstAt && ![0, 6].includes(new Date(next.at).getDay()), 'следующий — будний день');

    // Компьютер был выключен, будильник опоздал на час — уже не будит
    Date.now = () => next.at + 3600_000;
    reminders._tick(ctx);
    assert.equal(rang.length, 1);

    Date.now = realNow;
    r = await tool('alarm').run('cancel');
    assert.equal(r.speak, 'Отменил будильник, сэр.');
    assert.equal(reminders.upcoming(24 * 8).filter((x) => x.alarm).length, 0);
    assert.equal((await tool('alarm').run('in 0')).ok, false);
  } finally {
    Date.now = realNow;
    reminders._reset();
  }
});

// Окно: подставные элементы и проигрыватель
function fakeWindow() {
  const el = () => {
    const handlers = {};
    return { hidden: true, textContent: '', addEventListener: (e, fn) => (handlers[e] = fn), click: () => handlers.click?.() };
  };
  const beeps = [];
  global.playChime = (kind, volume) => beeps.push({ kind, volume });
  const radio = {
    played: null,
    volume: 1,
    stopped: 0,
    play(s) {
      this.played = s;
    },
    stop() {
      this.stopped++;
    },
    setVolume(v) {
      this.volume = v;
    },
  };
  return { panel: el(), label: el(), snoozeButton: el(), stopButton: el(), radio, beeps };
}

test('будильник в окне: звенит до «стоп»; «ещё пять минут» — отложить; радио вместо сигнала', () => {
  const { createAlarm, snoozeMinutes } = require('../src/renderer/alarm');
  const w = fakeWindow();
  const snoozed = [];
  const alarm = createAlarm({ ...w, onSnooze: (p, m) => snoozed.push([p, m]) });
  try {
    alarm.ring({ id: 1, label: 'Будильник 07:00' });
    assert.equal(w.panel.hidden, false);
    assert.equal(w.label.textContent, '⏰ Будильник 07:00');
    assert.equal(w.beeps[0].kind, 'alarm');
    assert.ok(w.beeps[0].volume < 0.5, 'сначала тихо');
    assert.equal(alarm.heard('какая погода'), false, 'другие фразы — не будильнику');
    assert.equal(alarm.heard('Стоп'), true);
    assert.equal(alarm.ringing(), false);
    assert.equal(w.panel.hidden, true);

    alarm.ring({ id: 2, label: 'Будильник 07:00', radio: 'маяк', station: { name: 'Маяк', url: 'https://x' } });
    assert.equal(w.radio.played.name, 'Маяк', 'будит радио');
    assert.ok(w.radio.volume < 0.5, 'радио — тоже сначала тихо');
    assert.equal(alarm.heard('ещё пять минут'), true);
    assert.deepEqual(snoozed, [[{ id: 2, label: 'Будильник 07:00', radio: 'маяк' }, 5]]);
    assert.ok(w.radio.stopped >= 1, 'отложили — радио смолкло');

    assert.equal(snoozeMinutes('дай поспать'), 10);
    assert.equal(snoozeMinutes('ещё 15 минут'), 15);
    assert.equal(snoozeMinutes('отложи на полчаса'), 30);
    alarm.ring({ id: 3, label: 'Будильник' });
    w.snoozeButton.click();
    assert.equal(snoozed.at(-1)[1], 10, 'кнопка — на 10 минут');
  } finally {
    alarm.stop();
    delete global.playChime;
  }
});
