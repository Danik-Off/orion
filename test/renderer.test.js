// Логика окна, вынесенная в чистые функции (src/renderer/commands.js): проверяется без браузера
const test = require('node:test');
const assert = require('node:assert/strict');
const { isStopForOrion } = require('../src/renderer/commands');

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
