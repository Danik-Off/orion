// Логика окна, вынесенная в чистые функции (src/renderer/commands.js): проверяется без браузера
const test = require('node:test');
const assert = require('node:assert/strict');
const { isStopForOrion, isContinuation, CONTINUE_WITHIN_MS } = require('../src/renderer/commands');

test('«Орион, стоп»: прерывает ответ, раздумье и ожидание продолжения — и перестаёт слушать', () => {
  // говорит или думает — только по имени (посреди ответа слышно лишь имя: иначе его же голос остановил бы его)
  assert.equal(isStopForOrion({ command: 'стоп', speaking: true }), true);
  assert.equal(isStopForOrion({ command: 'хватит', busy: true }), true);
  assert.equal(isStopForOrion({ command: 'спасибо', speaking: true }), true, 'вежливо закончить ответ');
  assert.equal(isStopForOrion({ command: null, final: 'стоп', speaking: true }), false, 'без имени во время ответа — не команда');
  assert.equal(isStopForOrion({ command: '', speaking: true }), false, 'одно имя — перебил, чтобы сказать команду');

  // ждёт продолжения разговора — и с именем, и без
  assert.equal(isStopForOrion({ command: null, final: 'стоп', listening: true, dialogOpen: true }), true);
  assert.equal(isStopForOrion({ command: 'отбой', dialogOpen: true }), true);
  assert.equal(isStopForOrion({ command: null, final: 'Не слушай!', listening: true }), true, 'знаки и регистр не мешают');
  assert.equal(
    isStopForOrion({ command: null, final: 'спасибо', listening: true, dialogOpen: true }),
    false,
    'на «спасибо» в разговоре он ответит',
  );

  // ничего не делает — «Орион, стоп» остаётся обычной командой (например, пауза музыки)
  assert.equal(isStopForOrion({ command: 'стоп' }), false);
  assert.equal(isStopForOrion({ command: 'стоп музыку', dialogOpen: true }), false, 'это команда навыку, а не Ориону');
});

test('пока модель думает: договаривание — только сразу и коротко; разговор в комнате к запросу не клеится', () => {
  const at = 1_000_000;
  assert.equal(isContinuation({ askedAt: at, startedAt: at + 600, text: 'на семь утра' }), true);
  assert.equal(isContinuation({ askedAt: at, startedAt: at + CONTINUE_WITHIN_MS + 1, text: 'на семь' }), false, 'начал поздно');
  const chatter = 'ну ты последний раз брал куда ты девайся ты там рядом стоит специально да он там постоянно';
  assert.equal(isContinuation({ askedAt: at, startedAt: at + 400, text: chatter }), false, 'длинная речь — не дополнение');
  assert.equal(isContinuation({ askedAt: undefined, startedAt: at, text: 'да' }), false);
  assert.equal(isContinuation({ askedAt: at, startedAt: at + 100 }), true, 'ещё ничего не распознано — пока считаем дополнением');
});

const { confirmAnswer, isInterjection, speakerOf, isStrangerVoice } = require('../src/renderer/commands');

test('«да» или «нет» на подтверждение — в начале или в конце фразы, со знаками и заглавными', () => {
  assert.equal(confirmAnswer('да'), true);
  assert.equal(confirmAnswer('Да, выключай.'), true);
  assert.equal(confirmAnswer('выключи компьютер через час да'), true, 'повторил просьбу и подтвердил');
  assert.equal(confirmAnswer('нет'), false);
  assert.equal(confirmAnswer('не надо'), false);
  assert.equal(confirmAnswer('стоп'), false);
  assert.equal(confirmAnswer('какая погода'), null, 'не ответ');
  assert.equal(confirmAnswer('данные'), null, '«да» — только отдельным словом');
  assert.equal(confirmAnswer(''), null);
});

test('междометия — не команда', () => {
  for (const t of ['э', 'эээ', 'Ну', 'хмм', 'угу', 'э-э']) assert.equal(isInterjection(t), true, t);
  for (const t of ['нет', 'ну включи', 'а завтра']) assert.equal(isInterjection(t), false, t);
});

test('голос: кто говорит и чужой ли он', () => {
  const anna = { match: true, person: { id: 'anna' } };
  const guest = { match: false };
  const unsure = { ambiguous: true, candidates: ['anna', 'oleg'] };
  assert.equal(speakerOf(anna), 'anna');
  assert.equal(speakerOf(guest), null);
  assert.equal(speakerOf(undefined), undefined);
  assert.equal(speakerOf(unsure, 'anna'), 'anna', 'похож на двоих — значит, текущий собеседник');
  assert.equal(speakerOf(unsure, 'ivan'), undefined);

  const voices = { people: [{ id: 'anna' }], require: 'followup' };
  // продолжение без имени — только от того, кто начал разговор
  assert.equal(isStrangerVoice({ voice: guest, source: 'followup', talkingTo: 'anna', voices }), true);
  assert.equal(isStrangerVoice({ voice: anna, source: 'followup', talkingTo: 'anna', voices }), false);
  assert.equal(isStrangerVoice({ voice: anna, source: 'followup', talkingTo: null, voices }), true, 'говорили с гостем');
  assert.equal(isStrangerVoice({ voice: guest, source: 'wake', talkingTo: 'anna', voices }), false, 'с именем — любой');
  assert.equal(isStrangerVoice({ voice: unsure, source: 'followup', talkingTo: 'anna', voices }), false, 'сомнение — не чужой');
  assert.equal(isStrangerVoice({ voice: guest, source: 'wake', voices: { ...voices, require: 'always' } }), true);
  assert.equal(isStrangerVoice({ voice: guest, source: 'followup', talkingTo: 'anna', voices: { people: [], require: 'always' } }), false);
});

const { mediaCommand } = require('../src/renderer/commands');

test('пока играет радио: короткие команды без имени, разговор в комнате — нет', () => {
  assert.equal(mediaCommand('стоп'), 'stop');
  assert.equal(mediaCommand('Хватит!'), 'stop');
  assert.equal(mediaCommand('выключи радио'), 'stop');
  assert.equal(mediaCommand('пауза'), 'pause');
  assert.equal(mediaCommand('продолжи'), 'resume');
  assert.equal(mediaCommand('дальше'), 'next');
  assert.equal(mediaCommand('погромче, пожалуйста'), 'louder');
  assert.equal(mediaCommand('ну потише'), 'quieter');
  for (const t of ['давай потише ребёнок спит', 'стоп а где ключи', 'тише едешь дальше будешь', 'выключи свет', ''])
    assert.equal(mediaCommand(t), null, t);
});

const { nightLevel } = require('../src/renderer/commands');

test('ночной режим: тише только в заданные часы, через полночь тоже', () => {
  const night = { enabled: true, from: 23, to: 7, volume: 0.4 };
  assert.equal(nightLevel(night, 23), 0.4);
  assert.equal(nightLevel(night, 3), 0.4);
  assert.equal(nightLevel(night, 7), 1);
  assert.equal(nightLevel(night, 15), 1);
  assert.equal(nightLevel({ ...night, from: 13, to: 15 }, 14), 0.4, 'тихий час днём');
  assert.equal(nightLevel({ ...night, enabled: false }, 3), 1);
  assert.equal(nightLevel(null, 3), 1);
});

const { lingerMs, tailText } = require('../src/renderer/capsule');

test('капсула: висит дольше для длинного ответа, распознаваемое — с конца', () => {
  assert.equal(lingerMs(''), 4000);
  assert.equal(lingerMs('x'.repeat(100)), 10_000);
  assert.equal(lingerMs('x'.repeat(5000)), 15_000, 'не дольше 15 с');
  assert.equal(tailText('включи радио'), 'включи радио');
  const long = 'включи радио маяк и сделай чуть погромче, пожалуйста, а то ничего не слышно на кухне';
  const t = tailText(long);
  assert.ok(t.startsWith('…') && long.endsWith(t.slice(1)), t);
  assert.ok(t.length <= 71);
  assert.ok(!/^…\S*[а-я]\s/.test(t) || t[1] !== ' ', 'не с середины слова');
});
