// Обновления частей Ориона: модели речи (версия — дата в имени), быстрая модель (релизы с SHA256SUMS),
// установка рядом, проверка запуском, возврат прежней. GitHub — подставной, файлы — с локального сервера.
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { tmp } = require('./helpers');
const { familyOf, dateOf, newestInFamily, newestRouter, shaFor } = require('../src/core/component-releases');
const { createUpdatesManager } = require('../src/app/updates');

const VOSK = 'sherpa-onnx-streaming-zipformer-small-ru-vosk-int8';

test('версии частей: модель речи новее — то же семейство и более поздняя дата; другая модель — не «новее»', () => {
  assert.equal(familyOf(`${VOSK}-2025-08-16.tar.bz2`), VOSK);
  assert.equal(dateOf(`${VOSK}-2025-08-16`), '2025-08-16');
  const assets = [
    `${VOSK}-2025-08-16.tar.bz2`,
    `${VOSK}-2026-02-01.tar.bz2`,
    `${VOSK}-2026-01-01.tar.bz2`,
    'sherpa-onnx-streaming-zipformer-small-ru-vosk-2027-01-01.tar.bz2', // без int8 — другая модель
    'sherpa-onnx-supertonic-tts-int8-2026-03-06.tar.bz2',
  ].map((name) => ({ name, browser_download_url: `https://x/${name}`, size: 1 }));
  assert.deepEqual(newestInFamily(assets, `${VOSK}-2025-08-16`), {
    name: `${VOSK}-2026-02-01`,
    url: `https://x/${VOSK}-2026-02-01.tar.bz2`,
    size: 1,
    date: '2026-02-01',
  });
  assert.equal(newestInFamily(assets, `${VOSK}-2026-02-01`), null, 'уже последняя');
  assert.equal(newestInFamily(assets, 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11'), null, 'supertonic и supertonic-3 — разные модели');
  assert.equal(newestInFamily(assets, 'silero_vad.onnx'), null, 'без даты — не сравнить');

  const rel = (tag, files = ['orion-router-q8_0.gguf', 'SHA256SUMS']) => ({
    tag_name: tag,
    assets: files.map((name) => ({ name, browser_download_url: `https://x/${tag}/${name}`, size: 2 })),
  });
  const releases = [
    rel('v0.4.0', ['latest.yml']),
    rel('models-router-v3', ['README.md']),
    rel('models-router-v2'),
    rel('models-router-v1'),
  ];
  assert.equal(newestRouter(releases, 'models-router-v1').tag, 'models-router-v2', 'v3 без модели и сумм — не считается');
  assert.equal(newestRouter(releases, 'models-router-v2'), null);
  assert.equal(shaFor('abc  NOTICE\ndef  orion-router-q8_0.gguf\n', 'orion-router-q8_0.gguf'), 'def');
});

// Стенд: локальный сервер файлов, подставной GitHub, менеджер на временной папке моделей
async function bench({ files = {}, releases = {}, reloadOk = () => true, routerStarts = () => true } = {}) {
  const server = http.createServer((req, res) => {
    const body = files[decodeURIComponent(req.url.slice(1))];
    if (!body) return ((res.statusCode = 404), res.end());
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = global.fetch;
  global.fetch = async (url, ...rest) => {
    const u = String(url);
    const key = Object.keys(releases).find((k) => u.includes(k));
    if (key) return { ok: true, json: async () => releases[key](base) };
    // Остальной GitHub — пустой: настоящие релизы не должны влиять на тест (после выхода models-router-v2
    // тест «видел» её и насчитывал лишнее обновление)
    if (u.includes('api.github.com')) return { ok: true, json: async () => (u.includes('/tags/') ? { assets: [] } : []) };
    return realFetch(url, ...rest);
  };
  const modelsDir = tmp();
  fs.mkdirSync(path.join(modelsDir, 'llm'));
  const config = {
    speech: { asrModel: `${VOSK}-2025-08-16`, asrSecondPass: '', ttsModel: '' },
    router: {},
    llamaCpp: { build: 'b1' },
    mcp: { servers: {} },
  };
  const set = (keys, v) => {
    const parent = keys.slice(0, -1).reduce((o, k) => (o[k] ??= {}), config);
    if (v === undefined) delete parent[keys.at(-1)];
    else parent[keys.at(-1)] = v;
  };
  const handlers = {};
  let routerStops = 0;
  const reloads = [];
  createUpdatesManager({
    config,
    modelsDir,
    services: {
      audit: () => {},
      routerServer: {
        stop: () => routerStops++,
        ensure: async () => {
          if (!routerStarts()) throw new Error('не запустилась');
        },
      },
    },
    settings: { setPath: set },
    ipc: { handle: (c, f) => (handlers[c] = f), broadcast: () => {} },
    voice: {
      reload: async () => (reloads.push(config.speech.asrModel), { stt: reloadOk(config.speech.asrModel), tts: true, secondPass: true }),
    },
    models: { check: async () => null, list: () => ({ engine: {} }) },
    mcp: { upgrade: async () => {} },
  });
  return {
    base,
    config,
    modelsDir,
    handlers,
    reloads,
    routerStops: () => routerStops,
    close: () => ((global.fetch = realFetch), server.close()),
  };
}

// Архив модели речи как у sherpa-onnx: папка с именем модели внутри .tar.bz2
function speechArchive(name) {
  const src = tmp();
  fs.mkdirSync(path.join(src, name));
  fs.writeFileSync(path.join(src, name, 'model.onnx'), 'x');
  const out = path.join(src, `${name}.tar.bz2`);
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-cjf', out, '-C', src, name]);
  return fs.readFileSync(out);
}

test('обновление распознавания: ставится рядом и подключается; не загрузилась — прежняя; «Вернуть»', async () => {
  const next = `${VOSK}-2026-02-01`;
  const b = await bench({
    files: { [`${next}.tar.bz2`]: speechArchive(next) },
    releases: {
      'tags/asr-models': (base) => ({ assets: [{ name: `${next}.tar.bz2`, browser_download_url: `${base}/${next}.tar.bz2`, size: 1 }] }),
    },
  });
  try {
    fs.mkdirSync(path.join(b.modelsDir, `${VOSK}-2025-08-16`));
    let r = await b.handlers['jarvis:updates-check']();
    const asr = r.parts.find((p) => p.id === 'asr');
    assert.equal(asr.newer, true);
    assert.equal(asr.latest, '2026-02-01');
    assert.equal(r.updates, 1);
    r = await b.handlers['jarvis:updates-apply']('asr');
    assert.equal(r.ok, true, r.error);
    assert.equal(b.config.speech.asrModel, next, 'включена новая');
    assert.ok(fs.existsSync(path.join(b.modelsDir, next, 'model.onnx')), 'распакована рядом');
    assert.ok(fs.existsSync(path.join(b.modelsDir, `${VOSK}-2025-08-16`)), 'прежняя — для отката');
    assert.equal(r.parts.find((p) => p.id === 'asr').previous, `${VOSK}-2025-08-16`);
    r = await b.handlers['jarvis:updates-rollback']('asr');
    assert.equal(r.ok, true, r.error);
    assert.equal(b.config.speech.asrModel, `${VOSK}-2025-08-16`, 'вернули');
  } finally {
    b.close();
  }

  // Новая модель не загрузилась — остаётся прежняя
  const broken = await bench({
    files: { [`${next}.tar.bz2`]: speechArchive(next) },
    releases: {
      'tags/asr-models': (base) => ({ assets: [{ name: `${next}.tar.bz2`, browser_download_url: `${base}/${next}.tar.bz2`, size: 1 }] }),
    },
    reloadOk: (name) => name !== next,
  });
  try {
    await broken.handlers['jarvis:updates-check']();
    const r = await broken.handlers['jarvis:updates-apply']('asr');
    assert.equal(r.ok, false);
    assert.match(r.error, /не загрузилась — оставил прежнюю/);
    assert.equal(broken.config.speech.asrModel, `${VOSK}-2025-08-16`);
    assert.deepEqual(broken.reloads, [next, `${VOSK}-2025-08-16`], 'попробовали новую и вернули прежнюю');
  } finally {
    broken.close();
  }
});

test('обновление быстрой модели: сверка с SHA256SUMS, пробный запуск, возврат прежней', async () => {
  const model = Buffer.from('новая модель');
  const sha = crypto.createHash('sha256').update(model).digest('hex');
  const releases = {
    'Danik-Off/orion/releases': (base) => [
      {
        tag_name: 'models-router-v2',
        assets: [
          { name: 'orion-router-q8_0.gguf', browser_download_url: `${base}/v2/model`, size: model.length },
          { name: 'SHA256SUMS', browser_download_url: `${base}/v2/sums`, size: 1 },
        ],
      },
    ],
  };
  // Повреждённая загрузка — сумма не сошлась: файл модели не тронут
  const bad = await bench({ files: { 'v2/model': Buffer.from('битая'), 'v2/sums': `${sha}  orion-router-q8_0.gguf\n` }, releases });
  try {
    fs.writeFileSync(path.join(bad.modelsDir, 'llm', 'orion-router-q8_0.gguf'), 'старая');
    await bad.handlers['jarvis:updates-check']();
    const r = await bad.handlers['jarvis:updates-apply']('router');
    assert.equal(r.ok, false);
    assert.match(r.error, /повреждена/);
    assert.equal(fs.readFileSync(path.join(bad.modelsDir, 'llm', 'orion-router-q8_0.gguf'), 'utf8'), 'старая');
  } finally {
    bad.close();
  }

  // Не запустилась — прежняя на месте
  let starts = false;
  const b = await bench({
    files: { 'v2/model': model, 'v2/sums': `${sha}  orion-router-q8_0.gguf\n` },
    releases,
    routerStarts: () => starts,
  });
  try {
    const file = path.join(b.modelsDir, 'llm', 'orion-router-q8_0.gguf');
    fs.writeFileSync(file, 'старая');
    let r = await b.handlers['jarvis:updates-check']();
    assert.equal(r.parts.find((p) => p.id === 'router').latest, 'v2');
    r = await b.handlers['jarvis:updates-apply']('router');
    assert.equal(r.ok, false);
    assert.match(r.error, /не запустилась.*оставил прежнюю/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'старая');
    assert.equal(b.config.router.release, undefined);

    starts = true;
    await b.handlers['jarvis:updates-check']();
    r = await b.handlers['jarvis:updates-apply']('router');
    assert.equal(r.ok, true, r.error);
    assert.equal(fs.readFileSync(file, 'utf8'), 'новая модель');
    assert.equal(b.config.router.release, 'models-router-v2');
    assert.equal(r.parts.find((p) => p.id === 'router').version, 'версия v2');
    r = await b.handlers['jarvis:updates-rollback']('router');
    assert.equal(r.ok, true, r.error);
    assert.equal(fs.readFileSync(file, 'utf8'), 'старая', 'вернули');
    assert.equal(r.parts.find((p) => p.id === 'router').version, 'версия v1');
  } finally {
    b.close();
  }
});
