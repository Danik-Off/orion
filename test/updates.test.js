// Что нового: update/<версия>.md → голос; предложение рассказать после обновления; кратко в вопросе об обновлении
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const notes = require('../src/lib/release-notes');
const updates = require('../src/skills/updates');
const { tmp } = require('./helpers');

const version = require('../package.json').version;

test('что нового: у текущей версии из package.json есть описание — подняли версию, напишите update/<версия>.md', () => {
  const n = notes.read(version);
  assert.ok(n, `нет update/${version}.md`);
  assert.ok(n.items.length > 0, 'в описании нет пунктов «- …»');
  assert.match(n.date, /^\d{4}-\d{2}-\d{2}$/, 'в заголовке нет даты: # 0.4.0 — 2026-10-07');
});

test('что нового: разбор markdown, порядок версий, несколько версий подряд, ограничение пунктов', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '0.9.0.md'), '# 0.9.0 — 2026-01-01\n\n- Старое.\n');
  fs.writeFileSync(
    path.join(dir, '0.10.0.md'),
    '# 0.10.0 — 2026-02-01\n\nВводная **фраза**.\n\n- Первый [пункт](https://x)\n  с переносом\n- Второй `пункт`.\n',
  );
  fs.writeFileSync(path.join(dir, 'README.md'), '# не версия');
  assert.deepEqual(notes.versions(dir), ['0.10.0', '0.9.0'], '0.10 новее 0.9');
  const n = notes.read('0.10.0', dir);
  assert.equal(n.intro, 'Вводная фраза.');
  assert.deepEqual(n.items, ['Первый пункт с переносом', 'Второй пункт.']);
  assert.equal(notes.spoken(n), 'В версии 0.10.0: Вводная фраза. Первый пункт с переносом. Второй пункт.');
  assert.match(notes.spoken(n, { limit: 1 }), /Первый пункт с переносом\. И ещё 1/);
  assert.deepEqual(
    notes.between('0.8.0', '0.10.0', dir).map((x) => x.version),
    ['0.10.0', '0.9.0'],
  );
  assert.deepEqual(
    notes.between('0.9.0', '0.10.0', dir).map((x) => x.version),
    ['0.10.0'],
  );

  const { whatsNew } = updates._test;
  assert.match(whatsNew('', { dir, version: '0.10.0' }), /^В версии 0\.10\.0/);
  assert.match(whatsNew('что нового в 0.9', { dir }), /^В версии 0\.9\.0: Старое\./);
  assert.match(whatsNew('1.2.3', { dir }), /Описания версии 1\.2\.3 у меня нет/);
  assert.match(whatsNew('', { dir, version: '2.0.0' }), /описания изменений к ней нет/);
});

test('что нового: частые фразы — без модели', () => {
  const tool = (t) => updates.quick(t)?.actions[0];
  assert.deepEqual(tool('Что у тебя нового?'), { tool: 'whats_new', arg: '' });
  assert.deepEqual(tool('что изменилось'), { tool: 'whats_new', arg: '' });
  assert.equal(updates.quick('что нового'), null, 'голое «что нового» — может быть и про новости: решает модель');
  assert.deepEqual(tool('что изменилось в обновлении'), { tool: 'whats_new', arg: '' });
  assert.deepEqual(tool('что нового в версии 0.3.0'), { tool: 'whats_new', arg: '0.3.0' });
  assert.deepEqual(tool('какая у тебя версия'), { tool: 'my_version', arg: '' });
  assert.equal(updates.quick('что нового в мире'), null, 'новости — не сюда');
});

test('что нового: после обновления спрашивает и рассказывает; при первой установке и без обновления — молчит', async () => {
  const run = async (lastVersion, answer = true, dataDir) => {
    const saved = [];
    const said = [];
    const asked = [];
    const ctx = {
      config: { lastVersion },
      dataDir,
      saveSettings: (p) => saved.push(p),
      confirm: async (q) => (asked.push(q), answer),
      say: (t) => said.push(t),
    };
    await updates.offer(ctx);
    return { saved, said, asked };
  };
  let r = await run(undefined);
  assert.deepEqual(r.saved, [{ lastVersion: version }], 'первая установка: запомнить версию');
  assert.equal(r.asked.length, 0, 'и не спрашивать');
  r = await run(version);
  assert.equal(r.saved.length + r.asked.length, 0, 'та же версия — ничего');
  r = await run('0.0.1');
  assert.match(r.asked[0], new RegExp(`обновился до версии ${version.replace(/\./g, '\\.')}`));
  assert.match(r.said[0], new RegExp(`В версии ${version.replace(/\./g, '\\.')}:`));
  r = await run('0.0.1', false);
  assert.equal(r.said.length, 0, 'отказались — не рассказывать');

  // Обновились с версии, которая не запоминала lastVersion (0.3.0): журнал старше запуска — рассказать про текущую
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'actions.log'), `${JSON.stringify({ t: '2026-01-01T00:00:00Z', input: 'привет' })}\n`);
  r = await run(undefined, true, dir);
  assert.equal(r.asked.length, 1, 'журнал есть — это обновление, а не установка');
  assert.ok(r.said[0].startsWith(`В версии ${version}:`));
  assert.doesNotMatch(r.said[0], /В версии 0\.3\.0/, 'старые версии не пересказывает');
  fs.writeFileSync(path.join(dir, 'actions.log'), `${JSON.stringify({ t: new Date().toISOString() })}\n`);
  assert.equal(updates._test.usedBefore(dir), false, 'журнал начат в этом запуске — установка');
});

test('обновление: в вопросе «Хотите обновить?» — коротко, что нового (из описания релиза на GitHub)', () => {
  const { notesSummary } = notes;
  const html = '<h1>0.5.0</h1>\n<p>Я стал быстрее &amp; умнее.</p>\n<ul>\n<li>Первое.</li>\n<li>Второе.</li>\n</ul>';
  assert.equal(notesSummary(html), 'Я стал быстрее & умнее.');
  assert.equal(notesSummary('<ul><li>Первое.</li><li>Второе.</li><li>Третье.</li></ul>'), 'Первое. Второе.');
  assert.equal(notesSummary([{ version: '0.5.0', note: '<p>Из списка.</p>' }]), 'Из списка.');
  assert.equal(notesSummary(null), '');
  assert.ok(notesSummary(`<p>${'слово '.repeat(100)}</p>`).length <= 221);
});
