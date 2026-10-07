// Слой приложения (src/app): чистая логика без Electron — папки, ошибки, запись голоса, ожидание тишины
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveModelsDir } = require('../src/app/paths');
const { explainError, speakerLabel } = require('../src/app/ask');
const { phraseMatch, inputGainFor } = require('../src/app/voice');
const { createQuietGate } = require('../src/app/quiet-gate');

test('папка моделей: своя из настроек, рядом с проектом, рядом с программой, иначе — в папке данных', () => {
  const base = { root: '/proj', dataDir: '/data', baseDir: '/proj', execPath: '/apps/Orion/Orion.exe' };
  const cfg = (modelsDir = '') => ({ speech: { modelsDir } });
  assert.equal(resolveModelsDir({ ...base, config: cfg('my-models'), packaged: false }), path.resolve('/proj', 'my-models'));
  assert.equal(resolveModelsDir({ ...base, config: cfg(), packaged: false }), path.join('/proj', 'models'));
  const packaged = { ...base, config: cfg(), packaged: true, platform: 'win32' };
  assert.equal(resolveModelsDir({ ...packaged, canWrite: () => true }), path.join('/apps/Orion', 'models'), 'Windows: рядом с программой');
  assert.equal(resolveModelsDir({ ...packaged, canWrite: () => false }), path.join('/data', 'models'), 'Program Files — в папке данных');
  assert.equal(
    resolveModelsDir({ ...packaged, platform: 'darwin', canWrite: () => true }),
    path.join('/data', 'models'),
    'macOS: внутри .app писать нельзя',
  );
});

test('ошибки модели объясняются по-человечески', () => {
  const config = { backend: 'ollama', model: 'qwen3.5:4b' };
  assert.match(explainError(Object.assign(new Error('x'), { code: 'NO_MODEL' }), config), /ещё не скачана/);
  assert.match(explainError(new Error('llama.cpp не запустился: ...'), config), /не запустилась/);
  assert.match(explainError(new TypeError('fetch failed'), config), /связаться с Ollama/);
  assert.match(
    explainError(new TypeError('fetch failed'), { ...config, backend: 'llamacpp' }),
    /^Сбой/,
    'про Ollama — только если выбран он',
  );
  assert.match(explainError(new Error('model "x" not found'), config), /ollama pull qwen3\.5:4b/);
  assert.match(explainError(new Error('The operation was aborted due to timeout'), config), /долго отвечает/);
});

test('подпись реплики: имя по голосу, «Гость» для чужого, без проверки голоса — ничего', () => {
  assert.equal(speakerLabel('id1', { name: 'Анна' }), 'Анна');
  assert.equal(speakerLabel('id1', { name: '' }), 'Без имени');
  assert.equal(speakerLabel(null, null), 'Гость');
  assert.equal(speakerLabel(undefined, { name: 'Анна' }), null, 'набранный текст голос не проверял');
});

test('запись голоса: фраза с экрана сверяется по основам слов; усиление — под самый тихий голос', () => {
  const expected = 'Орион, какая сегодня погода в Москве';
  assert.equal(phraseMatch(expected, ['орион какая сегодня погода в москве']), 1);
  assert.ok(phraseMatch(expected, ['арион какой сегодня погоды в москву']) >= 0.6, 'окончания распознаватель путает');
  assert.ok(phraseMatch(expected, ['включи музыку погромче']) < 0.45, 'телевизор на фоне не пройдёт');
  assert.equal(inputGainFor([-30, -40], undefined), 14, 'до −26 дБ от самого тихого (−40)');
  assert.equal(inputGainFor([], undefined), 0);
  assert.equal(inputGainFor([-40], 5), 5, 'вручную заданное — главнее');
});

test('ожидание тишины: действия ждут конца фразы, отмену и не дольше предела', async () => {
  const gate = createQuietGate({ graceMs: 10, maxWaitMs: 200 });
  await gate.untilQuiet(); // тихо — сразу

  gate.setTalking(true);
  let done = false;
  const waiting = gate.untilQuiet().then(() => (done = true));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done, false, 'человек ещё говорит');
  gate.setTalking(false);
  await waiting;
  assert.equal(done, true);

  gate.setTalking(true);
  const controller = new AbortController();
  const t0 = Date.now();
  const cancelled = gate.untilQuiet(controller.signal);
  controller.abort();
  await cancelled;
  assert.ok(Date.now() - t0 < 100, 'отмена запроса — сразу');

  const t1 = Date.now();
  await gate.untilQuiet(); // говорят без конца (телевизор)
  assert.ok(Date.now() - t1 >= 190, 'не дольше предела, но и не раньше');
  gate.setTalking(false);
});

test('запрос: новый обрывает недоделанный старый; сбой модели — понятной фразой; голосовые команды ждут тишины', async () => {
  const { createAsk } = require('../src/app/ask');
  const handlers = {};
  const ipc = { on: (ch, fn) => (handlers[ch] = fn), handle: (ch, fn) => (handlers[ch] = fn) };
  const log = [];
  let aborted = 0;
  const waitedQuiet = [];
  const assistant = {
    handle: (text, { signal, source, beforeActions }) =>
      new Promise((resolve, reject) => {
        if (text === 'сломайся') return reject(Object.assign(new Error('x'), { code: 'NO_MODEL' }));
        if (beforeActions) waitedQuiet.push(source);
        if (text === 'быстро') return resolve({ say: 'Готово.', actions: [] });
        if (signal.aborted) return resolve({ cancelled: true });
        signal.addEventListener('abort', () => resolve({ cancelled: true })); // «долгий» запрос ждёт отмены
      }),
  };
  const services = { assistant, audit: (e) => log.push(e), llm: { abortAll: () => aborted++ } };
  const voice = { resolvePerson: async () => null, untilQuiet: async () => {}, setPartner: async () => {} };
  const { ask } = createAsk({ config: { backend: 'llamacpp' }, services, voice, ui: { send: () => {} }, ipc });
  assert.equal(typeof handlers['jarvis:ask'], 'function');

  const slow = ask('долгий вопрос', 'wake');
  const fast = await ask('быстро', 'hotkey');
  assert.deepEqual(await slow, { cancelled: true }, 'старый запрос оборван');
  assert.equal(aborted, 1, 'модель бросила генерацию');
  assert.equal(fast.say, 'Готово.');
  assert.equal(fast.speakerLabel, null);
  assert.deepEqual(waitedQuiet, ['hotkey'], 'голосовая команда ждала конца фразы');

  const broken = await ask('сломайся', 'text');
  assert.equal(broken.error, true);
  assert.match(broken.say, /ещё не скачана/);
  assert.deepEqual(await ask('   ', 'text'), { say: 'Пустой или слишком длинный запрос.', error: true });
  assert.ok(log.some((e) => e.ask === 'отменён'));
});

test('версия в окне: orionAssistent:версия(коммит) — из файла сборки, иначе из git, иначе dev', () => {
  const fs = require('node:fs');
  const { versionLabel } = require('../src/core/version');
  const dir = require('./helpers').tmp();
  const buildInfo = path.join(dir, 'build-info.json');
  const noGit = () => {
    throw new Error('git не найден');
  };
  fs.writeFileSync(buildInfo, JSON.stringify({ commit: '1a2b3c4d5e6f' }));
  assert.equal(versionLabel('0.2.0', { buildInfo, git: noGit }), 'orionAssistent:0.2.0(1a2b3c4)', 'установленная версия — из файла сборки');
  const missing = path.join(dir, 'нет.json');
  assert.equal(
    versionLabel('0.2.0', { buildInfo: missing, git: () => 'abcdef1\n' }),
    'orionAssistent:0.2.0(abcdef1)',
    'разработка — из git',
  );
  assert.equal(versionLabel('0.2.0', { buildInfo: missing, git: noGit }), 'orionAssistent:0.2.0(dev)');
  assert.match(versionLabel(), /^orionAssistent:\d+\.\d+\.\d+\((\w{7}|dev)\)$/, 'версия — из package.json');
});
