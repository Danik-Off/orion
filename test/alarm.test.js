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
  // Как говорят обычно: «часов … минут», «без …», «четверть», «полдень»
  assert.equal(clock('разбуди меня в шесть часов тридцать минут'), '06:30');
  assert.equal(clock('на 7 часов 15 минут'), '07:15');
  assert.equal(clock('без пятнадцати семь'), '06:45');
  assert.equal(clock('без четверти восемь'), '07:45');
  assert.equal(clock('без десяти минут девять'), '08:50');
  assert.equal(clock('без двадцати пяти восемь вечера'), '19:35');
  assert.equal(clock('в четверть восьмого'), '07:15');
  assert.equal(clock('двадцать минут восьмого'), '07:20');
  assert.equal(clock('в полдень'), '12:00');
  assert.equal(clock('в полночь'), '00:00');
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

test('будильник: ставится, по будням пропускает выходные, звонит в срок, опоздавший не будит, но сказан, отменяется', async () => {
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
    const said = [];
    const ctx = { alarm: (p) => rang.push(p), remind: (t) => said.push(t), audit: () => {} };
    const firstAt = item.at; // срабатывание меняет время того же объекта — запомнить
    Date.now = () => firstAt + 30_000;
    reminders._tick(ctx);
    assert.deepEqual(rang, [{ id: item.id, label: 'Будильник 07:00', radio: 'маяк' }]);
    const next = reminders.upcoming(24 * 8).find((x) => x.alarm);
    assert.ok(next.at > firstAt && ![0, 6].includes(new Date(next.at).getDay()), 'следующий — будний день');

    assert.deepEqual(said, [], 'в срок — звонит, а не напоминает');

    // Компьютер был выключен, будильник опоздал на час — уже не будит, но говорит, что пропущен
    Date.now = () => next.at + 3600_000;
    reminders._tick(ctx);
    assert.equal(rang.length, 1);
    assert.match(said[0], /^Пропущен будильник на 07:00/);

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

// Проигрыватель и сигнал будильника — подставные
function fakeAlarmDeps() {
  const beeps = [];
  const changes = [];
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
  return { radio, chime: (volume) => beeps.push(volume), onChange: (ringing) => changes.push(ringing), beeps, changes };
}

test('будильник в окне: звенит до «стоп»; «ещё пять минут» — отложить; радио вместо сигнала', () => {
  const { createAlarm, snoozeMinutes } = require('../src/ui/src/lib/alarm.ts');
  const d = fakeAlarmDeps();
  const snoozed = [];
  const alarm = createAlarm({ radio: d.radio, chime: d.chime, onChange: d.onChange, onSnooze: (p, m) => snoozed.push([p, m]) });
  try {
    alarm.ring({ id: 1, label: 'Будильник 07:00' });
    assert.deepEqual(d.changes, [true], 'окно узнаёт, что звенит, — рисует кнопки');
    assert.equal(alarm.label(), 'Будильник 07:00');
    assert.ok(d.beeps[0] < 0.5, 'сначала тихо');
    assert.equal(alarm.heard('какая погода'), false, 'другие фразы — не будильнику');
    assert.equal(alarm.heard('Стоп'), true);
    assert.equal(alarm.ringing(), false);
    assert.deepEqual(d.changes, [true, false]);

    alarm.ring({ id: 2, label: 'Будильник 07:00', radio: 'маяк', station: { name: 'Маяк', url: 'https://x' } });
    assert.equal(d.radio.played.name, 'Маяк', 'будит радио');
    assert.ok(d.radio.volume < 0.5, 'радио — тоже сначала тихо');
    assert.equal(alarm.heard('ещё пять минут'), true);
    assert.deepEqual(snoozed, [[{ id: 2, label: 'Будильник 07:00', radio: 'маяк' }, 5]]);
    assert.ok(d.radio.stopped >= 1, 'отложили — радио смолкло');

    assert.equal(snoozeMinutes('дай поспать'), 10);
    assert.equal(snoozeMinutes('ещё 15 минут'), 15);
    assert.equal(snoozeMinutes('отложи на полчаса'), 30);
    alarm.ring({ id: 3, label: 'Будильник' });
    alarm.snooze();
    assert.equal(snoozed.at(-1)[1], 10, 'кнопка — на 10 минут');
  } finally {
    alarm.stop();
  }
});

test('день будильника и напоминания: послезавтра, день недели, дата, по выходным, по понедельникам; «завтра» ночью', () => {
  const arg = (t) => reminders.quick(t)?.actions[0].arg;
  assert.equal(arg('разбуди меня послезавтра в восемь'), 'after tomorrow 08:00', '«послезавтра» — не «завтра»');
  assert.match(arg('будильник на субботу на десять'), /^\d{4}-\d{2}-\d{2} 10:00$/);
  assert.equal(arg('разбуди по выходным в девять'), 'weekends 09:00');
  assert.equal(arg('будильник каждый понедельник в 8'), 'weekly 1 08:00');
  assert.equal(arg('разбуди в семь с музыкой'), '07:00|радио популярное', '«с музыкой» — не станция «музыкой»');

  const sun = new Date(2026, 9, 11, 14, 0); // воскресенье
  const { parse } = reminders;
  const sat = new Date(parse('weekends 09:00|x', sun).at);
  assert.equal(sat.getDay(), 6, 'по выходным: ближайшая — суббота (воскресенье 9:00 уже прошло)');
  const tue = new Date(parse('weekly 2,4 07:00|x', sun).at);
  assert.equal(tue.getDay(), 2);
  assert.equal(new Date(parse('after tomorrow 08:00|x', sun).at).getDate(), 13);
  // В половине первого ночи «завтра в семь» — это сегодняшнее утро
  const night = new Date(2026, 9, 12, 0, 30);
  assert.equal(new Date(parse('tomorrow 07:00|x', night).at).getDate(), 12);
  assert.equal(new Date(parse('tomorrow 07:00|x', new Date(2026, 9, 12, 9, 0)).at).getDate(), 13, 'днём «завтра» — завтра');

  const { fromText } = require('../src/lib/text-args');
  assert.match(fromText('remind_at', 'напомни 5 октября позвонить маме'), /^\d{4}-10-05 09:00\|позвонить маме$/, '«5 октября» — не 17:00');
  assert.match(fromText('remind_at', 'напомни в пятницу в 10 сдать отчёт'), /^\d{4}-\d{2}-\d{2} 10:00\|сдать отч[её]т$/);
  assert.equal(fromText('remind_at', 'напомни в двадцать два тридцать выпить таблетку'), '22:30|выпить таблетку');
  assert.match(fromText('remind_at', 'напомни двадцать пятого декабря поздравить сестру'), /-12-25 09:00\|/);
});
