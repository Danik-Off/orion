// Узнавание голоса (core/speaker.js)
require('./helpers'); // заглушка Electron — до подключения навыков
const test = require('node:test');
const assert = require('node:assert/strict');
const { cosine } = require('../src/core/speaker');

test('голосовой отпечаток: косинусная близость', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(Math.round(cosine([1, 0], [0, 1]) * 100), 0);
});

test('голос: калибровка порога под разброс фраз, среднее лучших образцов', () => {
  const { calibrate, personScore } = require('../src/core/speaker');
  const near = (k) => Float32Array.from([1, k, 0]);
  const tight = [near(0.05), near(0.1), near(0.15), near(0.2)];
  const loose = [near(0.1), near(0.9), Float32Array.from([1, 0, 1]), Float32Array.from([0.5, 0.5, 0.5])];
  assert.ok(calibrate(tight, 0.42) >= calibrate(loose, 0.42), 'разброс больше — порог ниже');
  assert.ok(
    calibrate(loose, 0.42) >= 0.3 && calibrate(tight, 0.42) <= 0.38,
    'в допустимых пределах: обычный порог — не выше 0,38 (замер speaker-eval)',
  );
  assert.ok(personScore(tight, near(0.1)) > 0.99);
});

test('голос: похожий записанный голос поднимает порог, но не выше сходства своих фраз', () => {
  const { calibrate, levelDb } = require('../src/core/speaker');
  const v = (a, b, c) => Float32Array.from([a, b, c]);
  const own = [v(1, 0.3, 0), v(1, 0.5, 0.1), v(1, 0.2, 0.3), v(1, 0.6, 0.2)];
  const alone = calibrate(own, 0.42);
  const withTwin = calibrate(own, 0.42, alone + 0.1);
  assert.ok(withTwin > alone, 'похожий голос — порог выше');
  assert.ok(withTwin <= 0.6);
  const quiet = new Float32Array(1600).fill(0.01);
  assert.ok(Math.abs(levelDb(quiet) + 40) < 0.5, 'громкость в дБ');
});

test('голос: порог, подобранный старым правилом, пересчитывается при загрузке — перезаписывать голос не нужно', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { createSpeakerId } = require('../src/core/speaker');
  const { tmp } = require('./helpers');
  const dir = tmp();
  const near = (k) => [1, k, 0];
  const old = { id: 'a', name: 'Анна', honorific: 'мисс', templates: [near(0.05), near(0.1), near(0.15), near(0.2)], threshold: 0.55 };
  fs.writeFileSync(path.join(dir, 'people.json'), JSON.stringify([old]));
  const logs = [];
  const s = createSpeakerId({ modelsDir: dir, dataDir: dir, config: { model: '', threshold: 0.38 }, log: (m) => logs.push(m) });
  assert.equal(s.get('a').threshold, 0.38);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'people.json'), 'utf8'))[0].cal, 2, 'пересчёт сохранён');
  assert.match(logs[0], /0\.55 → 0\.38/);
  createSpeakerId({ modelsDir: dir, dataDir: dir, config: { model: '', threshold: 0.38 }, log: (m) => logs.push(m) });
  assert.equal(logs.length, 1, 'второй раз не пересчитывает');
});
