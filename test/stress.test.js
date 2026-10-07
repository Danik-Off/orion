// Ударения перед озвучкой (lib/stress.js)
require('./helpers'); // заглушка Electron — до подключения навыков
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('ударения: как у исходной модели silero-stress, омографы по подсказкам, «ё»', () => {
  const { accentuate, forSynth } = require('../src/lib/stress');
  const VOWELS = /[аоуыэиеяёю]/gi;
  // Эталон — вывод исходной модели (без нейросети для омографов); односложные слова мы не размечаем
  const plain = (t) =>
    t.replace(/[А-Яа-яЁё+]+/g, (w) => ((w.replace(/\+/g, '').match(VOWELS) || []).length <= 1 || /ё/i.test(w) ? w.replace(/\+/g, '') : w));
  const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/stress-reference.json'), 'utf8'));
  for (const r of [ref[0], ref[2], ref[3]]) assert.equal(plain(accentuate(r.text)), plain(r.noHomo));

  assert.equal(accentuate('Замок на двери или старинный замок.'), 'Зам+ок на двер+и +или стар+инный з+амок.');
  assert.equal(accentuate('Всё готово. Это все, что вы просили.'), 'Всё гот+ово. +Это вс+ё, что вы прос+или.');
  assert.equal(accentuate('Мука для пирога'), 'Мук+а для пирог+а');
  assert.equal(accentuate('что-то'), 'что-то', 'частица «-то» и односложные слова — без меток');
  // Для синтезатора — знак ударения после гласной; текст без букв не трогается
  assert.equal(forSynth('Замок на двери'), 'Замо́к на двери́');
  assert.equal(forSynth('123, ok!'), '123, ok!');
});

test('ударения: свои слова, «стоит», твёрдое «э», готовые ударения из нормализатора', () => {
  const { accentuate, forSynth } = require('../src/lib/stress');
  assert.equal(accentuate('Это красивее.'), '+Это крас+ивее.', 'свой словарь важнее модели');
  assert.equal(accentuate('Сколько стоит билет? Дом стоит на холме.'), 'Ск+олько ст+оит бил+ет? Дом сто+ит на холм+е.');
  assert.equal(accentuate('ю-эс-б+и'), 'ю-эс-б+и', 'ударение из нормализатора сохраняется');
  assert.equal(forSynth('Интернет и тестовый режим, кафе.'), 'Интэрнэ́т и тэ́стовый режи́м, кафэ́.');
  assert.equal(forSynth('Тесто для пирога.'), 'Те́сто для пирога́.', '«тесто» — не «тест»: мягкое «е» остаётся');
});

test('ударения: омографы по грамматике — эталон и отложенный набор без ошибок', () => {
  const { accentuate } = require('../src/lib/stress');
  const plain = (w) => w.replace(/\+/g, '').toLowerCase().replace(/ё/g, 'е');
  for (const file of ['stress-gold.json', 'stress-holdout.json']) {
    const bad = [];
    for (const [text, expected] of JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8'))) {
      const words = accentuate(text).match(/[А-Яа-яЁё+]+/g) || [];
      let from = 0;
      for (const exp of expected) {
        const i = words.findIndex((w, k) => k >= from && plain(w) === plain(exp));
        const got = i < 0 ? '?' : words[i].toLowerCase();
        if (i >= 0) from = i + 1;
        if (got !== exp.toLowerCase()) bad.push(`${text}: ${got} (надо ${exp})`);
      }
    }
    assert.deepEqual(bad, [], file);
  }
  // признаки по отдельности
  assert.equal(accentuate('из города'), 'из г+орода');
  assert.equal(accentuate('эти города'), '+эти город+а');
  assert.equal(accentuate('два часа'), 'два час+а', 'у «часа» своё счётное ударение');
  assert.equal(accentuate('около часа'), '+около ч+аса');
  assert.equal(accentuate('две руки'), 'две р+уки', 'женский род после «две» — как во множественном');
  assert.equal(accentuate('Стены дома покрашены.'), 'Ст+ены д+ома покр+ашены.', 'глагол относится к «стенам»');
});

test('ударения в готовых фразах Ориона: все слова проверены (test/fixtures/stress-reviewed.json)', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, [path.join(__dirname, '../scripts/stress-phrases.js'), '--new'], { encoding: 'utf8' }).trim();
  // Новая фраза в коде — новое слово: проверьте его ударение (npm run stress-phrases -- --new), при ошибке поправьте
  // src/assets/stress/extra-words.json, затем npm run stress-phrases -- --accept
  assert.equal(out, 'все слова проверены');
});
