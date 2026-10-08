// Обновления частей Ориона, которые скачиваются отдельно от программы (Настройки → «Компоненты»):
//   llama.cpp, быстрая модель orion-router, распознавание речи (быстрое и точное), голос Supertonic, пакеты MCP.
// Сама программа обновляется своим путём (core/updater.js) — здесь только её версия и кнопка.
// Правило для всех: новая версия ставится РЯДОМ, проверяется запуском, и только тогда включается; не вышло —
// остаётся прежняя. Прежняя хранится для отката («Вернуть»), более старые удаляются.
// Не обновляются: узнавание голоса (новая модель — все перезаписывают голос) и детектор речи (версий не бывает).
// При запуске (если не выключено «Сообщать о новой версии») проверка идёт сама — на разделе «Компоненты» точка.
const fs = require('node:fs');
const path = require('node:path');
const { download, installItem, sha256Of: sha256 } = require('../core/setup');
const { newestInFamily, newestRouter, routerVersion, shaFor, familyOf, dateOf } = require('../core/component-releases');
const { MODELS } = require('../core/llama');
const { latestVersion } = require('./mcp-packages');

const SHERPA_API = 'https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags';
const ORION_API = 'https://api.github.com/repos/Danik-Off/orion/releases?per_page=30';
const CHECK_EVERY = 12 * 3600_000; // при запуске — не чаще (лимит GitHub без ключа — 60 запросов в час)
const ROUTER_FILE = MODELS['orion-router'].file;
const ROUTER_DEFAULT_TAG = MODELS['orion-router'].url.split('/').at(-2); // models-router-v1

async function github(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'orion-assistant' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub: ${res.status}`);
  return res.json();
}

function createUpdatesManager({ config, modelsDir, services, settings, ipc, voice, models, mcp }) {
  const state = new Map(); // id → { latest, newer, busy: { progress }, error, info }
  let checking = false;
  let checkedAt = 0;
  let emitTimer = null;

  const emit = (now = false) => {
    clearTimeout(emitTimer);
    const send = () => ipc.broadcast('jarvis:updates-changed', list());
    if (now) send();
    else emitTimer = setTimeout(send, 250);
  };
  const st = (id) => (state.has(id) ? state.get(id) : state.set(id, {}).get(id));

  // --- модели речи sherpa-onnx: распознавание (быстрое, точное), голос ---
  const speech = (id, title, key, release, loaded) => ({
    id,
    title,
    current: () => config.speech[key],
    version: () => (dateOf(config.speech[key]) ? `версия от ${dateOf(config.speech[key]).split('-').reverse().join('.')}` : ''),
    async check() {
      const name = config.speech[key];
      if (!name) return null;
      const r = await github(`${SHERPA_API}/${release}`);
      const n = newestInFamily(r.assets, name);
      return n && { latest: n.date, info: n };
    },
    async update(onProgress) {
      const n = st(id).info;
      const before = config.speech[key];
      if (!fs.existsSync(path.join(modelsDir, n.name))) {
        await installItem({ name: n.name, url: n.url, target: path.join(modelsDir, n.name), archive: true }, modelsDir, onProgress);
      }
      settings.setPath(['speech', key], n.name);
      // Подключить новую модель; не загрузилась — вернуть прежнюю
      let ok = false;
      try {
        ok = loaded(await voice.reload());
      } catch {}
      if (!ok) {
        settings.setPath(['speech', key], before);
        await voice.reload();
        throw new Error('Новая модель не загрузилась — оставил прежнюю');
      }
      prune(n.name);
    },
    previous: () => olderInFamily(config.speech[key])[0] || null,
    async rollback() {
      const prev = olderInFamily(config.speech[key])[0];
      if (!prev) throw new Error('Прежней версии нет');
      settings.setPath(['speech', key], prev);
      await voice.reload();
    },
  });
  // Скачанные версии той же модели — старше текущей, новые первыми
  function olderInFamily(name) {
    if (!name) return [];
    try {
      return fs
        .readdirSync(modelsDir)
        .filter((d) => familyOf(d) === familyOf(name) && dateOf(d) && dateOf(d) < dateOf(name))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }
  // Хранить текущую и одну прежнюю
  const prune = (name) =>
    olderInFamily(name)
      .slice(1)
      .forEach((d) => fs.rmSync(path.join(modelsDir, d), { recursive: true, force: true }));

  // --- быстрая модель orion-router ---
  const llmDir = path.join(modelsDir, 'llm');
  const routerTag = () => config.router?.release || ROUTER_DEFAULT_TAG;
  const prevRouter = path.join(llmDir, ROUTER_FILE.replace(/\.gguf$/, '.prev.gguf'));
  const router = {
    id: 'router',
    title: 'Быстрая модель (orion-router)',
    version: () => `версия v${routerVersion(routerTag())}`,
    async check() {
      const n = newestRouter(await github(ORION_API), routerTag(), ROUTER_FILE);
      return n && { latest: `v${routerVersion(n.tag)}`, info: n };
    },
    async update(onProgress) {
      const n = st('router').info;
      const sums = await (await fetch(n.sumsUrl, { signal: AbortSignal.timeout(20_000) })).text();
      const expected = shaFor(sums, ROUTER_FILE);
      if (!expected) throw new Error('В релизе нет контрольной суммы модели');
      const next = path.join(llmDir, ROUTER_FILE.replace(/\.gguf$/, '.next.gguf'));
      await download(n.url, next, onProgress);
      if ((await sha256(next)) !== expected) {
        fs.rmSync(next, { force: true });
        throw new Error('Скачанная модель повреждена — оставил прежнюю');
      }
      const current = path.join(llmDir, ROUTER_FILE);
      services.routerServer.stop();
      if (fs.existsSync(current)) fs.renameSync(current, prevRouter);
      fs.renameSync(next, current);
      try {
        await services.routerServer.ensure(); // пробный запуск
      } catch (err) {
        services.routerServer.stop();
        fs.renameSync(prevRouter, current);
        throw new Error(`Новая модель не запустилась (${String(err?.message || err).slice(0, 80)}) — оставил прежнюю`);
      }
      settings.setPath(['router', 'release'], n.tag);
    },
    previous: () => (fs.existsSync(prevRouter) ? 'прежняя' : null),
    async rollback() {
      if (!fs.existsSync(prevRouter)) throw new Error('Прежней версии нет');
      services.routerServer.stop();
      fs.renameSync(prevRouter, path.join(llmDir, ROUTER_FILE));
      settings.setPath(['router', 'release'], undefined);
    },
  };

  // --- llama.cpp: через «Модели на компьютере» (там же откат) ---
  const engine = {
    id: 'llama',
    title: 'Движок llama.cpp',
    version: () => `сборка ${config.llamaCpp.build}`,
    async check() {
      const latest = await models.check();
      return latest && Number(latest.tag.slice(1)) > Number(config.llamaCpp.build.slice(1)) ? { latest: latest.tag } : null;
    },
    update: () => models.update(),
    previous: () => models.list().engine.previous,
    rollback: () => models.rollback(),
  };

  // --- пакеты MCP: все серверы, поставленные из npm ---
  const npmServers = () => Object.entries(config.mcp?.servers || {}).filter(([, s]) => s.package);
  const packages = {
    id: 'mcp',
    title: 'Подключения MCP',
    version: () => {
      const n = npmServers().length;
      return n ? `серверов из npm: ${n}` : '';
    },
    async check() {
      const outdated = [];
      await Promise.all(
        npmServers().map(async ([name, s]) => {
          const latest = await latestVersion(s.package);
          if (latest && s.version && latest !== s.version) outdated.push({ name, from: s.version, to: latest });
        }),
      );
      return outdated.length ? { latest: outdated.map((o) => `${o.name} ${o.to}`).join(', '), info: outdated } : null;
    },
    async update(onProgress) {
      const todo = st('mcp').info || [];
      for (const [i, o] of todo.entries()) {
        await mcp.upgrade(o.name);
        onProgress((i + 1) / todo.length);
      }
    },
    previous: () => null,
  };

  const parts = [
    engine,
    router,
    speech('asr', 'Распознавание речи (быстрое)', 'asrModel', 'asr-models', (r) => r.stt),
    speech('asr2', 'Распознавание речи (точное)', 'asrSecondPass', 'asr-models', (r) => r.secondPass),
    speech('tts', 'Голос', 'ttsModel', 'tts-models', (r) => r.tts),
    packages,
  ];

  function list() {
    return {
      checking,
      checkedAt,
      updates: parts.filter((p) => st(p.id).newer).length,
      parts: parts
        .filter((p) => p.version())
        .map((p) => {
          const s = st(p.id);
          return {
            id: p.id,
            title: p.title,
            version: p.version(),
            latest: s.latest || null,
            newer: !!s.newer,
            busy: s.busy || null,
            error: s.error || null,
            previous: p.previous?.() || null,
          };
        }),
    };
  }

  async function checkOne(p) {
    const s = st(p.id);
    s.error = null;
    try {
      const r = await p.check();
      Object.assign(s, { latest: r?.latest || null, newer: !!r, info: r?.info || null });
    } catch (err) {
      s.error = `Не удалось проверить: ${String(err?.message || err).slice(0, 100)}`;
    }
  }

  async function checkAll() {
    if (checking) return list();
    checking = true;
    emit(true);
    await Promise.all(parts.filter((p) => p.version()).map(checkOne));
    checking = false;
    checkedAt = Date.now();
    emit(true);
    services.audit({ updates: 'проверка', found: parts.filter((p) => st(p.id).newer).map((p) => p.id) });
    return list();
  }

  async function update(id) {
    const p = parts.find((x) => x.id === id);
    if (!p) throw new Error('Нет такой части');
    const s = st(id);
    if (s.busy) return;
    if (!s.newer) await checkOne(p);
    if (!s.newer) throw new Error(s.error || 'Уже последняя версия');
    s.busy = { progress: 0 };
    s.error = null;
    emit(true);
    try {
      await p.update((x) => {
        s.busy.progress = Math.round(x * 100);
        emit();
      });
      Object.assign(s, { newer: false, latest: null, info: null });
      services.audit({ updates: 'обновлено', part: id });
    } catch (err) {
      s.error = String(err?.message || err).slice(0, 240);
      services.audit({ updates: 'ошибка', part: id, error: s.error });
      throw err;
    } finally {
      s.busy = null;
      emit(true);
    }
  }

  async function rollback(id) {
    const p = parts.find((x) => x.id === id);
    if (!p?.rollback) throw new Error('Вернуть нельзя');
    await p.rollback();
    services.audit({ updates: 'откат', part: id });
    emit(true);
  }

  // При запуске — тихая проверка, не чаще раза в CHECK_EVERY (время прошлой — в config.updates.checkedAt)
  function checkOnStart() {
    if (config.updates?.notify === false) return;
    const last = Number(config.updates?.componentsCheckedAt) || 0;
    if (Date.now() - last < CHECK_EVERY) return;
    checkAll()
      .then(() => settings.setPath(['updates', 'componentsCheckedAt'], Date.now()))
      .catch(() => {});
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
  ipc.handle('jarvis:updates-list', list);
  ipc.handle('jarvis:updates-check', wrap(checkAll));
  ipc.handle(
    'jarvis:updates-apply',
    wrap((id) => update(String(id))),
  );
  ipc.handle(
    'jarvis:updates-rollback',
    wrap((id) => rollback(String(id))),
  );

  return { list, checkAll, update, rollback, checkOnStart };
}

module.exports = { createUpdatesManager };
