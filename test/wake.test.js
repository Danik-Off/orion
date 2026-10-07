// Ключевое слово «Орион» (core/wake.js)
require('./helpers'); // заглушка Electron — до подключения навыков
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWakeMatcher } = require('../src/core/wake');

test('ключевое слово «Орион»: ≥95% в начале, ≥95% после «слушай», без ложных на обычной речи', () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/wake-asr.json'), 'utf8'));
  const wake = createWakeMatcher(['орион', 'orion']);
  const rate = (list) => list.filter((t) => wake.strip(t) !== null).length / list.length;
  assert.ok(rate(data.atStart) >= 0.95, `в начале: ${rate(data.atStart)}`);
  assert.ok(rate(data.afterLeadIn) >= 0.95, `после «слушай»: ${rate(data.afterLeadIn)}`);
  assert.equal(data.negative.filter((t) => wake.strip(t) !== null).length, 0);
});

test('ключевое слово посреди речи: ≥80% находится, длинная обычная речь не будит', () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/wake-asr.json'), 'utf8'));
  const wake = createWakeMatcher(['орион', 'orion']);
  const prefixes = ['так ну ладно', 'кот жирный', 'я сейчас приду', 'ну вот смотри', 'короче'];
  const mid = data.atStart.flatMap((t) => prefixes.map((p) => `${p} ${t}`));
  const found = mid.filter((t) => wake.strip(t) !== null).length / mid.length;
  assert.ok(found >= 0.8, `посреди речи: ${found}`);
  const glued = data.negative.flatMap((a, i) => data.negative.slice(i + 1, i + 4).map((b) => `${a} ${b}`));
  assert.deepEqual(
    glued.filter((t) => wake.strip(t) !== null),
    [],
  );
  assert.equal(wake.strip('так ну ладно орион какая погода'), 'какая погода');
  assert.equal(wake.strip('кот жирный орёл включи музыку'), 'включи музыку');
  assert.equal(wake.strip('над горами летал орёл какой красивый'), null);
  assert.equal(wake.strip('орион орион включи музыку'), 'включи музыку');
});

test('ключевое слово: команда после имени сохраняется, похожие слова не будят', () => {
  const wake = createWakeMatcher(['орион', 'orion']);
  assert.equal(wake.strip('орион открой телеграм'), 'открой телеграм');
  assert.equal(wake.strip('ореон какая погода'), 'какая погода');
  assert.equal(wake.strip('арион включи музыку'), 'включи музыку');
  assert.equal(wake.strip('орёл какая погода'), 'какая погода');
  assert.equal(wake.strip('ори он включи музыку'), 'включи музыку');
  assert.equal(wake.strip('слушай орион включи музыку'), 'включи музыку');
  assert.equal(wake.strip('знагрион закрой браузер'), 'закрой браузер', 'имя склеилось с шумом перед ним');
  assert.equal(wake.strip('скорпион закрой'), null);
  assert.equal(wake.strip('орион'), '');
  assert.equal(wake.strip('арип'), '', 'одно похожее слово — «слушаю»');
  for (const t of [
    'включи радио',
    'в нашем регионе дожди',
    'мы живём в районе',
    'он выиграл миллион',
    'алло',
    'ирина пришла',
    'я вчера говорил с орионом',
  ]) {
    assert.equal(wake.strip(t), null, t);
  }
});

test('имя: личные варианты произношения учатся, обычные слова — нет', () => {
  const wake = createWakeMatcher(['орион', 'orion']);
  assert.equal(wake.strip('радион и всё'), null);
  assert.deepEqual(wake.learn(['радион', 'алло', 'кот', 'включи']), ['радион']);
  assert.equal(wake.strip('радион и всё'), 'и все');
  assert.equal(wake.strip('алло кто это'), null);
  assert.equal(wake.nearMiss('кот жирный'), null, 'непохожее не пишется в журнал промахов');
  assert.equal(typeof wake.nearMiss('арбидон включи'), 'string', 'похожее на имя — пишется');
});

test('искажённое имя с вопросом и обращение при подтверждённом голосе', () => {
  const wake = createWakeMatcher(['орион', 'orion']);
  assert.equal(wake.strip('алён как меня зовут'), 'как меня зовут');
  assert.equal(wake.strip('ален скажи погоду'), 'скажи погоду');
  for (const t of ['алло как дела', 'ирина как дела', 'кот как дела']) assert.equal(wake.strip(t), null, t);
  const { looksAddressed } = require('../src/core/assistant');
  for (const t of ['в городе ты находишься', 'в каком городе ты находишься', 'можешь включить свет', 'где мои ключи'])
    assert.ok(looksAddressed(t), t);
  for (const t of ['мам где носки', 'ну я ему и говорю', 'последние новости это про наркотики да']) assert.ok(!looksAddressed(t), t);
});
