// Модели на компьютере и llama.cpp: выбор новой сборки, скачать / отменить / использовать / удалить модель,
// ссылки Hugging Face, внутренние модели не видны. Сеть — локальный сервер, файлы — во временной папке.
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { tmp } = require('./helpers');
const { newestBuild, installedBuilds, assetName } = require('../src/core/llama-builds');
const { localModels, MODELS, isInternalModel } = require('../src/core/llama');
const { HF_LINK } = require('../src/app/models');

test('llama.cpp: самая новая ПОЛНАЯ сборка для этой машины; «последний релиз» без файлов — не сборка', () => {
  const asset = (tag, variant, state = 'uploaded') => ({
    name: assetName(tag, variant),
    state,
    browser_download_url: `https://x/${tag}`,
    size: 1,
  });
  const releases = [
    { tag_name: 'v0.6.0', assets: [] },
    { tag_name: 'b11501', assets: [asset('b11501', 'win-vulkan-x64', 'starter')] }, // ещё докачивается
    { tag_name: 'b11500', published_at: '2026-10-08', assets: [asset('b11500', 'win-vulkan-x64'), asset('b11500', 'macos-arm64')] },
    { tag_name: 'b11499', assets: [asset('b11499', 'win-vulkan-x64')] },
  ];
  assert.deepEqual(newestBuild(releases, 'win-vulkan-x64'), { tag: 'b11500', url: 'https://x/b11500', size: 1, date: '2026-10-08' });
  assert.equal(newestBuild(releases, 'ubuntu-vulkan-x64'), null, 'для этой машины сборок нет');
  assert.equal(assetName('b1', 'macos-arm64'), 'llama-b1-bin-macos-arm64.tar.gz');

  const dir = tmp();
  for (const d of ['b11205-win-vulkan-x64', 'b11500-win-vulkan-x64', 'b9-macos-arm64'])
    fs.mkdirSync(path.join(dir, 'llama.cpp', d), { recursive: true });
  assert.deepEqual(
    installedBuilds(dir, 'win-vulkan-x64').map((b) => b.tag),
    ['b11500', 'b11205'],
    'новые первыми, чужие сборки не считаются',
  );
});

test('модели: в списке «Модель» — только скачанные и текущая; внутренние не видны; каталог — с описаниями', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'llm'));
  for (const f of ['Qwen3.5-4B-Q4_K_M.gguf', 'my-model.gguf', 'orion-router-q8_0.gguf', 'orion-router-public-q8_0.gguf'])
    fs.writeFileSync(path.join(dir, 'llm', f), '');
  assert.deepEqual(localModels(dir, 'qwen3.5:9b'), ['qwen3.5:4b', 'qwen3.5:9b', 'my-model.gguf']);
  assert.ok(isInternalModel('orion-router') && isInternalModel('functiongemma:270m') && isInternalModel('orion-router-public-q8_0.gguf'));
  for (const [id, m] of Object.entries(MODELS).filter(([key]) => !isInternalModel(key))) {
    assert.ok(m.title && m.about && m.size && m.file.endsWith('.gguf') && (m.repo || m.url), `${id}: описание для каталога`);
  }
  assert.ok(MODELS['qwen3.5:4b'].tags.includes('по умолчанию'));
});

test('модели: ссылка Hugging Face — страница файла или прямая; другие адреса — нет', () => {
  const m = 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/blob/main/Qwen3.5-9B-Q4_K_M.gguf'.match(HF_LINK);
  assert.deepEqual(m.slice(1), ['unsloth/Qwen3.5-9B-GGUF', 'main', 'Qwen3.5-9B-Q4_K_M.gguf']);
  assert.ok(HF_LINK.test('https://huggingface.co/a/b/resolve/main/sub/x.gguf?download=true'));
  assert.ok(!HF_LINK.test('https://evil.example/a/b/resolve/main/x.gguf'));
  assert.ok(!HF_LINK.test('https://huggingface.co/a/b/resolve/main/x.exe'));
});

test('модели: скачать с ходом, использовать без перезапуска, удалить; используемую и внутреннюю — нельзя', async () => {
  const body = Buffer.alloc(200_000, 7);
  let slow = false;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Length', body.length);
    if (!slow) return res.end(body);
    res.write(body.subarray(0, 1000)); // «медленная» загрузка — чтобы успеть отменить
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Каталог на время теста: две модели с прямыми ссылками на локальный сервер
  const saved = { ...MODELS };
  MODELS['test:a'] = { title: 'A', about: 'тест', size: body.length, file: 'a.gguf', url: `${base}/a.gguf` };
  MODELS['test:b'] = { title: 'B', about: 'тест', size: body.length, file: 'b.gguf', url: `${base}/b.gguf` };
  const { createModelManager } = require('../src/app/models');
  const dir = tmp();
  const config = { model: 'test:a', backend: 'ollama', llamaCpp: { build: 'b1', variant: 'win-vulkan-x64' } };
  const handlers = {};
  const events = [];
  let stopped = 0;
  const saves = [];
  createModelManager({
    config,
    modelsDir: dir,
    services: { audit: () => {}, llama: { stop: () => stopped++ }, routerServer: null },
    settings: { save: (p) => (saves.push(p), Object.assign(config, p), { ok: true }), setPath: () => {} },
    ipc: { handle: (c, f) => (handlers[c] = f), broadcast: (c, d) => events.push(d) },
    dialog: null,
  });
  const until = async (fn) => {
    for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  };
  try {
    let r = await handlers['jarvis:models-download']('test:a');
    assert.equal(r.ok, true);
    await until(() => fs.existsSync(path.join(dir, 'llm', 'a.gguf')));
    await until(() => events.at(-1)?.models.find((m) => m.id === 'test:a')?.installed);
    const a = events.at(-1).models.find((m) => m.id === 'test:a');
    assert.equal(a.installed, true);
    assert.equal(a.active, true);
    assert.ok(
      events.some((e) => e.models.some((m) => m.downloading !== null)),
      'ход загрузки виден в окне',
    );

    r = await handlers['jarvis:models-remove']('test:a');
    assert.equal(r.ok, false, 'используемую не удалить');
    assert.match(r.error, /используется/);
    assert.equal((await handlers['jarvis:models-remove']('orion-router')).ok, false, 'внутреннюю — тоже');
    assert.equal((await handlers['jarvis:models-use']('test:b')).ok, false, 'не скачанную не выбрать');

    // Отмена загрузки: недокачанный файл не становится моделью
    slow = true;
    await handlers['jarvis:models-download']('test:b');
    await until(() => fs.existsSync(path.join(dir, 'llm', 'b.gguf.part')));
    await handlers['jarvis:models-cancel']('test:b');
    await until(() => !events.at(-1)?.models.find((m) => m.id === 'test:b')?.downloading);
    assert.equal(fs.existsSync(path.join(dir, 'llm', 'b.gguf')), false);
    slow = false;
    await handlers['jarvis:models-download']('test:b');
    await until(() => fs.existsSync(path.join(dir, 'llm', 'b.gguf')));

    r = await handlers['jarvis:models-use']('test:b');
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(saves.at(-1), { model: 'test:b', backend: 'llamacpp', escalate: true }, 'и переключает на свою модель');
    assert.equal(stopped, 1, 'сервер выгружен — следующий запрос поднимет новую модель');
    r = await handlers['jarvis:models-remove']('test:a');
    assert.equal(r.ok, true, r.error);
    assert.equal(fs.existsSync(path.join(dir, 'llm', 'a.gguf')), false);
    assert.equal(r.models.find((m) => m.id === 'test:a').installed, false);
    assert.ok(!r.models.some((m) => isInternalModel(m.id)), 'внутренних в списке нет');

    r = await handlers['jarvis:models-link']('https://example.com/x.gguf');
    assert.equal(r.ok, false);
    assert.match(r.error, /huggingface/);
  } finally {
    for (const k of Object.keys(MODELS)) if (!(k in saved)) delete MODELS[k];
    server.closeAllConnections();
    server.close();
  }
});

test('llama.cpp: обновление — новая сборка рядом, пробный запуск; не запустилась — остаётся прежняя; откат', async () => {
  const { execFileSync } = require('node:child_process');
  const { createModelManager } = require('../src/app/models');
  const variant = process.platform === 'win32' ? 'win-vulkan-x64' : 'ubuntu-vulkan-x64';
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  // Архив «новой сборки» — как у llama.cpp: программа в корне архива
  const src = tmp();
  fs.writeFileSync(path.join(src, exe), 'echo');
  const archives = {};
  for (const tag of ['b200', 'b300']) {
    const file = path.join(src, assetName(tag, variant));
    execFileSync(tar, ['-a', '-c', '-f', file, '-C', src, exe]);
    archives[tag] = fs.readFileSync(file);
  }
  const server = http.createServer((req, res) => res.end(archives[req.url.slice(1)]));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'llama.cpp', `b100-${variant}`), { recursive: true });
  const config = { model: 'qwen3.5:4b', backend: 'llamacpp', llamaCpp: { build: 'b100', variant } };
  let startOk = true;
  const probe = {
    stop: () => {},
    available: () => true,
    ensure: async () => (startOk ? undefined : Promise.reject(new Error('не тот процессор'))),
  };
  const handlers = {};
  createModelManager({
    config,
    modelsDir: dir,
    services: { audit: () => {}, llama: { stop: () => {}, available: () => false }, routerServer: probe },
    settings: { save: () => ({ ok: true }), setPath: (keys, v) => (config.llamaCpp[keys.at(-1)] = v) },
    ipc: { handle: (c, f) => (handlers[c] = f), broadcast: () => {} },
  });
  const latest = (tag) => [
    {
      tag_name: tag,
      published_at: '2026-10-08',
      assets: [{ name: assetName(tag, variant), state: 'uploaded', browser_download_url: `${base}/${tag}`, size: 1 }],
    },
  ];
  const realFetch = global.fetch;
  let releases = latest('b200');
  global.fetch = async (url, ...rest) =>
    String(url).includes('api.github.com') ? { ok: true, json: async () => releases } : realFetch(url, ...rest);
  try {
    let r = await handlers['jarvis:engine-check']();
    assert.equal(r.engine.newer, true);
    assert.equal(r.engine.latest.tag, 'b200');
    r = await handlers['jarvis:engine-update']();
    assert.equal(r.ok, true, r.error);
    assert.equal(config.llamaCpp.build, 'b200', 'переключились на новую');
    assert.ok(fs.existsSync(path.join(dir, 'llama.cpp', `b200-${variant}`, exe)), 'распакована рядом');
    assert.equal(r.engine.previous, 'b100', 'прежняя хранится для отката');

    // Следующая сборка не запускается — остаёмся на рабочей
    releases = latest('b300');
    await handlers['jarvis:engine-check']();
    startOk = false;
    r = await handlers['jarvis:engine-update']();
    assert.equal(r.ok, false);
    assert.match(r.error, /не запустилась.*оставил b200/);
    assert.equal(config.llamaCpp.build, 'b200');

    startOk = true;
    r = await handlers['jarvis:engine-rollback']();
    assert.equal(r.ok, true, r.error);
    assert.equal(config.llamaCpp.build, 'b100', 'откат одной кнопкой');
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});
