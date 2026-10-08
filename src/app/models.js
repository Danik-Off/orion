// Модели на компьютере и движок llama.cpp (Настройки → «Модели на компьютере»):
//   - каталог проверенных моделей (core/llama.js → MODELS) и свои: ссылка на Hugging Face или файл .gguf с диска;
//   - скачать (с ходом и отменой), «Использовать» — сразу, без перезапуска (модель загрузится при следующем
//     запросе), удалить — кроме той, что сейчас используется; видно, поместится ли модель в видеокарту;
//   - llama.cpp: проверить новую сборку, обновить — новая ставится рядом и пробно запускается, не запустилась —
//     остаётся прежняя; прежняя хранится для отката одной кнопкой, более старые удаляются.
// Маленькие модели первой ступени (orion-router, FunctionGemma) — внутренние: здесь их нет.
const fs = require('node:fs');
const path = require('node:path');
const { MODELS, variant, isInternalModel, paths, listDevices, pickDevice } = require('../core/llama');
const { download, unpackLlama, formatBytes } = require('../core/setup');
const { checkLatest, installedBuilds, assetName, buildNumber } = require('../core/llama-builds');

const EMIT_EVERY = 250; // ход загрузки — в окно не чаще
const HF_LINK = /^https:\/\/huggingface\.co\/([\w.-]+\/[\w.-]+)\/(?:resolve|blob)\/([\w.-]+)\/(.+\.gguf)(?:\?.*)?$/i;
const SAFE_FILE = /^[\w.\-()[\] ]+\.gguf$/i;

// Сколько видеопамяти нужно модели: веса плюс окно контекста и запас
const vramNeed = (bytes) => bytes * 1.15 + 1.2e9;

function createModelManager({ config, modelsDir, services, settings, ipc, dialog }) {
  const llmDir = path.join(modelsDir, 'llm');
  const v = config.llamaCpp.variant || variant();
  const jobs = new Map(); // id → { controller, progress, error }
  let engine = { latest: null, checked: 0, checking: false, updating: null, error: null };
  let vram = null; // { title, total } — видеокарта, на которой работает llama.cpp
  let emitTimer = null;

  const fileOf = (id) => (MODELS[id] ? MODELS[id].file : id);
  const fileExists = (id) => fs.existsSync(path.join(llmDir, fileOf(id)));
  const sizeOnDisk = (id) => {
    try {
      return fs.statSync(path.join(llmDir, fileOf(id))).size;
    } catch {
      return 0;
    }
  };

  function emit(now = false) {
    clearTimeout(emitTimer);
    const send = () => ipc.broadcast('jarvis:models-changed', list());
    if (now) send();
    else emitTimer = setTimeout(send, EMIT_EVERY);
  }

  // Видеокарта — из списка устройств llama.cpp (один раз за запуск)
  async function detectVram() {
    if (vram !== null) return vram;
    const { exe } = paths(config, modelsDir);
    if (!fs.existsSync(exe)) return null;
    const devices = await listDevices(exe).catch(() => []);
    // Та же видеокарта, что выберет llama.cpp: дискретная (у встроенной «память» — часть общей, её много)
    const best = devices.find((d) => d.name === config.llamaCpp.device) || pickDevice(devices);
    vram = best ? { title: best.title, total: best.total * 1024 * 1024 } : { title: '', total: 0 };
    emit();
    return vram;
  }

  const fits = (bytes) => (!vram?.total || !bytes ? null : vramNeed(bytes) <= vram.total ? 'gpu' : 'partial');

  function entry(id, m = MODELS[id] || {}) {
    const installed = fileExists(id);
    const job = jobs.get(id);
    const bytes = installed ? sizeOnDisk(id) : m.size || 0;
    return {
      id,
      title: m.title || id.replace(/\.gguf$/i, ''),
      about: m.about || '',
      tags: m.tags || [],
      license: m.license || '',
      // Замер в Орионе: «понимает 96% команд · 0,4 с»
      score: m.accuracy ? `понимает ${Math.round(m.accuracy * 100)}% команд · ${(m.ms / 1000).toFixed(1).replace('.', ',')} с` : '',
      size: bytes ? formatBytes(bytes) : '',
      installed,
      active: config.model === id,
      custom: !MODELS[id],
      fits: fits(bytes),
      downloading: job ? Math.round(job.progress * 100) : null,
      error: job?.error || null,
    };
  }

  function list() {
    const catalog = Object.keys(MODELS).filter((id) => !isInternalModel(id));
    let files = [];
    try {
      files = fs.readdirSync(llmDir).filter((f) => f.endsWith('.gguf'));
    } catch {}
    const known = new Set(Object.values(MODELS).map((m) => m.file));
    const custom = files.filter((f) => !known.has(f) && !isInternalModel(f));
    const downloadingCustom = [...jobs.keys()].filter((id) => !MODELS[id] && !custom.includes(id));
    const builds = installedBuilds(modelsDir, v);
    return {
      backend: config.backend,
      active: config.model,
      models: [...catalog, ...custom, ...downloadingCustom].map((id) => entry(id)),
      vram: vram?.total ? { title: vram.title, size: formatBytes(vram.total) } : null,
      engine: {
        build: config.llamaCpp.build,
        variant: v,
        installed: builds.map((b) => b.tag),
        previous: builds.find((b) => buildNumber(b.tag) < buildNumber(config.llamaCpp.build))?.tag || null,
        latest: engine.latest,
        newer: !!engine.latest && buildNumber(engine.latest.tag) > buildNumber(config.llamaCpp.build),
        checking: engine.checking,
        updating: engine.updating,
        error: engine.error,
      },
    };
  }

  // Скачать файл модели в models/llm (докачивается после обрыва); sha256 — если известна
  async function fetchModel(id, url, file) {
    if (jobs.has(id)) return;
    const controller = new AbortController();
    const job = { controller, progress: 0, error: null };
    jobs.set(id, job);
    emit(true);
    try {
      await download(
        url,
        path.join(llmDir, file),
        (p) => {
          job.progress = p;
          emit();
        },
        controller.signal,
      );
      jobs.delete(id);
      services.audit({ models: 'скачана', id });
    } catch (err) {
      if (controller.signal.aborted) jobs.delete(id);
      else {
        job.error = `Не скачалась: ${String(err?.message || err).slice(0, 160)}`;
        services.audit({ models: 'ошибка загрузки', id, error: job.error });
      }
    }
    emit(true);
  }

  function downloadModel(id) {
    const m = MODELS[id];
    if (!m || m.internal) throw new Error('Нет такой модели в каталоге');
    if (fileExists(id)) return;
    fetchModel(id, m.url || `https://huggingface.co/${m.repo}/resolve/main/${m.file}`, m.file);
  }

  // Своя модель по ссылке с Hugging Face (страница файла или прямая ссылка на .gguf)
  function downloadLink(link) {
    const m = String(link || '')
      .trim()
      .match(HF_LINK);
    if (!m) throw new Error('Нужна ссылка на файл .gguf с huggingface.co (страница файла или «Download»)');
    const [, repo, rev, filePath] = m;
    const file = path.basename(decodeURIComponent(filePath));
    if (!SAFE_FILE.test(file) || isInternalModel(file)) throw new Error('Странное имя файла');
    if (fs.existsSync(path.join(llmDir, file))) throw new Error('Такая модель уже есть');
    fetchModel(file, `https://huggingface.co/${repo}/resolve/${rev}/${filePath}`, file);
  }

  // Файл .gguf с диска: жёсткая ссылка (мгновенно, места не занимает) или копия
  async function importFile() {
    const r = await dialog.showOpenDialog({
      title: 'Модель GGUF',
      filters: [{ name: 'Модель GGUF', extensions: ['gguf'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths?.[0]) return null;
    const src = r.filePaths[0];
    const file = path.basename(src);
    if (!SAFE_FILE.test(file)) throw new Error('Странное имя файла');
    const dst = path.join(llmDir, file);
    if (fs.existsSync(dst)) throw new Error('Такая модель уже есть');
    fs.mkdirSync(llmDir, { recursive: true });
    try {
      fs.linkSync(src, dst);
    } catch {
      await fs.promises.copyFile(src, dst);
    }
    services.audit({ models: 'добавлена', id: file });
    return file;
  }

  function cancel(id) {
    jobs.get(id)?.controller.abort();
    if (jobs.get(id)?.error) jobs.delete(id);
    emit(true);
  }

  async function remove(id) {
    if (isInternalModel(id)) throw new Error('Это внутренняя модель');
    if (config.model === id) throw new Error('Эта модель сейчас используется — сначала выберите другую');
    const file = fileOf(id);
    if (!SAFE_FILE.test(file)) throw new Error('Странное имя файла');
    jobs.get(id)?.controller.abort();
    jobs.delete(id);
    for (const f of [file, `${file}.part`]) await fs.promises.rm(path.join(llmDir, f), { force: true });
    services.audit({ models: 'удалена', id });
  }

  // Использовать модель: своя на этом компьютере — llama.cpp; сервер выгружается и при следующем запросе
  // поднимется уже с ней
  function use(id) {
    if (isInternalModel(id)) throw new Error('Это внутренняя модель');
    if (!fileExists(id)) throw new Error('Сначала скачайте модель');
    const r = settings.save({ model: id, backend: 'llamacpp', escalate: true });
    if (!r.ok) throw new Error(r.error);
    services.llama.stop();
    services.audit({ models: 'выбрана', id });
  }

  // --- llama.cpp ---

  async function check() {
    engine = { ...engine, checking: true, error: null };
    emit(true);
    try {
      engine.latest = await checkLatest(v);
      engine.checked = Date.now();
    } catch (err) {
      engine.error = `Не удалось проверить: ${String(err?.message || err).slice(0, 120)}`;
    }
    engine.checking = false;
    emit(true);
    return engine.latest;
  }

  // Переключиться на сборку tag: перезапустить серверы и убедиться, что поднимаются; нет — вернуть прежнюю
  async function switchTo(tag) {
    const before = config.llamaCpp.build;
    settings.setPath(['llamaCpp', 'build'], tag);
    services.llama.stop();
    services.routerServer?.stop();
    const probe = services.routerServer?.available() ? services.routerServer : services.llama.available() ? services.llama : null;
    if (!probe) return;
    try {
      await probe.ensure();
    } catch (err) {
      settings.setPath(['llamaCpp', 'build'], before);
      probe.stop();
      throw new Error(`Сборка ${tag} не запустилась (${String(err?.message || err).slice(0, 100)}) — оставил ${before}`);
    }
  }

  async function update() {
    if (engine.updating) return;
    const latest = engine.latest || (await check());
    if (!latest) throw new Error(engine.error || 'Новых сборок нет');
    if (buildNumber(latest.tag) <= buildNumber(config.llamaCpp.build)) throw new Error('Уже стоит последняя сборка');
    const dir = path.join(modelsDir, 'llama.cpp', `${latest.tag}-${v}`);
    const archive = path.join(modelsDir, 'llama.cpp', assetName(latest.tag, v));
    engine = { ...engine, updating: { tag: latest.tag, progress: 0 }, error: null };
    emit(true);
    try {
      if (!fs.existsSync(dir)) {
        await download(latest.url, archive, (p) => {
          engine.updating.progress = Math.round(p * 100);
          emit();
        });
        unpackLlama(archive, dir);
        fs.rmSync(archive, { force: true });
      }
      await switchTo(latest.tag);
      // Хранятся текущая и прежняя — для отката; более старые удаляются
      const keep = new Set([latest.tag, installedBuilds(modelsDir, v).find((b) => b.tag !== latest.tag)?.tag]);
      for (const b of installedBuilds(modelsDir, v)) if (!keep.has(b.tag)) fs.rmSync(b.dir, { recursive: true, force: true });
      vram = null;
      services.audit({ llamaCpp: 'обновлён', build: latest.tag });
    } catch (err) {
      engine.error = String(err?.message || err).slice(0, 240);
      services.audit({ llamaCpp: 'ошибка обновления', error: engine.error });
      throw err;
    } finally {
      engine.updating = null;
      emit(true);
    }
  }

  async function rollback() {
    const prev = installedBuilds(modelsDir, v).find((b) => buildNumber(b.tag) < buildNumber(config.llamaCpp.build));
    if (!prev) throw new Error('Прежней сборки нет');
    await switchTo(prev.tag);
    services.audit({ llamaCpp: 'откат', build: prev.tag });
    emit(true);
  }

  const wrap =
    (fn) =>
    async (...args) => {
      try {
        return { ok: true, result: await fn(...args), ...list() };
      } catch (err) {
        return { ok: false, error: String(err?.message || err), ...list() };
      }
    };
  const str = (x) => String(x ?? '');
  ipc.handle('jarvis:models-list', () => (detectVram(), list()));
  ipc.handle(
    'jarvis:models-download',
    wrap((id) => downloadModel(str(id))),
  );
  ipc.handle(
    'jarvis:models-link',
    wrap((link) => downloadLink(str(link))),
  );
  ipc.handle(
    'jarvis:models-import',
    wrap(() => importFile()),
  );
  ipc.handle(
    'jarvis:models-cancel',
    wrap((id) => cancel(str(id))),
  );
  ipc.handle(
    'jarvis:models-remove',
    wrap((id) => remove(str(id))),
  );
  ipc.handle(
    'jarvis:models-use',
    wrap((id) => use(str(id))),
  );
  ipc.handle(
    'jarvis:engine-check',
    wrap(() => check()),
  );
  ipc.handle(
    'jarvis:engine-update',
    wrap(() => update()),
  );
  ipc.handle(
    'jarvis:engine-rollback',
    wrap(() => rollback()),
  );

  return { list, downloadModel, downloadLink, importFile, cancel, remove, use, check, update, rollback };
}

module.exports = { createModelManager, vramNeed, HF_LINK };
