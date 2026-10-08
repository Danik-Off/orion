// Подключения MCP: магазин (каталог), свои серверы, импорт готового JSON, включение, обновление, удаление —
// всё на ходу, без перезапуска. Серверы ведёт core/mcp.js (createMcpHub): запускаются по требованию и засыпают
// без дела; инструменты известны заранее из кэша (mcp-cache.json в папке данных).
// Пакеты npm ставятся в папку данных (mcp/<имя>) и запускаются через node напрямую — см. mcp-packages.js.
const fs = require('node:fs');
const path = require('node:path');
const { createMcpHub, parseCommand, slug } = require('../core/mcp');
const { catalogForWindow, serverFromCatalog } = require('../core/mcp-catalog');
const { installPackage, npxPackage, hasCommand } = require('./mcp-packages');

const CHANGE_DELAY = 150; // состояния серверов меняются пачкой — окно перерисовываем один раз

// hubOptions — для тестов (свой transportFor: сервер в памяти вместо процесса)
function createMcpManager({ config, dataDir, services, settings, ipc, hubOptions = {} }) {
  const { skills, audit } = services;
  const servers = () => config.mcp?.servers || {};
  const packagesDir = (name) => path.join(dataDir, 'mcp', slug(name));

  // Кэш инструментов: с ним навыки появляются при запуске сразу, а серверы не запускаются зря
  const cacheFile = path.join(dataDir, 'mcp-cache.json');
  let cacheData = {};
  try {
    cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {}
  const cache = {
    get: (name) => cacheData[name] || null,
    set: (name, entry) => {
      cacheData[name] = entry;
      fs.writeFile(cacheFile, JSON.stringify(cacheData), () => {});
    },
  };

  let warm = null;
  let changed = null;
  const hub = createMcpHub({
    servers,
    cache,
    idleMs: (Number(config.mcp?.idleMinutes) || 10) * 60_000,
    log: audit,
    ...hubOptions,
    // Навык сервера появился, изменился или исчез — в реестр; промпт большой модели — пересобрать (один раз на пачку)
    onSkill: (name, skill) => {
      if (skill) skills.replace(skill);
      else skills.remove(`mcp_${slug(name)}`);
      clearTimeout(warm);
      warm = setTimeout(() => services.assistant.warmup(), CHANGE_DELAY);
    },
    onStatus: () => {
      clearTimeout(changed);
      changed = setTimeout(() => ipc.broadcast('jarvis:mcp-changed', list()), CHANGE_DELAY);
    },
  });

  const save = (name, server) => settings.setPath(['mcp', 'servers', name], server);
  const update = (name, patch) => save(name, { ...servers()[name], ...patch });

  // Запуск сервера из npm — своей копией пакета; не вышло поставить — остаётся npx (как было)
  async function localize(name, server, { pkg, bin, args = [] } = {}) {
    const fromNpx = npxPackage(server);
    const p = pkg || fromNpx?.package;
    if (!p) return server;
    const run = await installPackage({ dir: packagesDir(name), pkg: p, bin: bin || server.bin });
    return { ...server, command: run.command, args: [...run.args, ...(fromNpx?.args ?? args)], package: p, version: run.version };
  }

  async function connectNew(name, server) {
    save(name, server);
    await hub.remove(name);
    await hub.add(name);
    return hub.status(name);
  }

  // Поставить из каталога: inputs — значения полей (ключ API, папки, адрес)
  async function install(id, inputs) {
    let server = serverFromCatalog(id, inputs);
    if (server.command === 'uvx' && !hasCommand('uvx')) throw new Error('Нужен uv — поставьте с docs.astral.sh/uv и перезапустите меня');
    if (server.package) server = await localize(id, server);
    audit({ mcp: id, installed: 'каталог', version: server.version });
    return connectNew(id, server);
  }

  // Свой сервер: команда («npx -y пакет …», «uvx пакет») или адрес https://…
  async function addCustom(name, target) {
    const key = slug(name);
    const t = String(target || '').trim();
    if (!key || !t) throw new Error('Нужны имя и команда или адрес');
    let server = /^https?:\/\//i.test(t) ? { url: t } : parseCommand(t);
    if (!server.url && !server.command) throw new Error('Не понял команду');
    server = { ...server, title: String(name).slice(0, 80) };
    if (npxPackage(server)) server = await localize(key, server).catch(() => server);
    audit({ mcp: key, installed: 'свой' });
    return connectNew(key, server);
  }

  // Импорт готовых настроек из описания сервера: { "mcpServers": { имя: {…} } } (Claude Desktop, Cursor),
  // { "servers": {…} } (VS Code) или один сервер { command | url, … } с именем name
  async function importJson(text, name = '') {
    let data;
    try {
      data = JSON.parse(String(text));
    } catch {
      throw new Error('Это не JSON — скопируйте блок настроек целиком, с фигурными скобками');
    }
    const found = data.mcpServers || data.servers || (data.command || data.url ? { [name || 'server']: data } : data);
    const entries = Object.entries(found || {}).filter(([, s]) => s && typeof s === 'object' && (s.command || s.url));
    if (!entries.length) throw new Error('В JSON нет ни одного сервера (нужны command или url)');
    const added = [];
    for (const [n, s] of entries) {
      const key = slug(n);
      let server = {
        title: String(s.title || n).slice(0, 80),
        ...(s.url
          ? { url: s.url, ...(s.headers && { headers: s.headers }), ...(s.type === 'sse' && { sse: true }) }
          : { command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], ...(s.env && { env: s.env }) }),
      };
      if (npxPackage(server)) server = await localize(key, server).catch(() => server);
      save(key, server);
      added.push(key);
    }
    audit({ mcp: added.join(','), installed: 'импорт' });
    await Promise.all(added.map(async (k) => (await hub.remove(k), hub.add(k))));
    return added.map((k) => ({ name: k, ...hub.status(k) }));
  }

  // Обновить пакет до последней версии
  async function upgrade(name) {
    const server = servers()[name];
    if (!server?.package) throw new Error('Этот сервер не из npm — обновлять нечего');
    const extra = (server.args || []).slice(1);
    const next = await localize(name, { ...server, command: 'node' }, { pkg: server.package, bin: server.bin, args: extra });
    audit({ mcp: name, update: `${server.version || '?'} → ${next.version}` });
    return connectNew(name, next);
  }

  async function remove(name) {
    await hub.remove(name);
    settings.setPath(['mcp', 'servers', name], undefined);
    delete cacheData[name];
    cache.set(name, undefined);
    fs.rm(packagesDir(name), { recursive: true, force: true }, () => {});
    audit({ mcp: name, removed: true });
  }

  async function setEnabled(name, on) {
    if (!servers()[name]) return;
    update(name, { enabled: on === true ? undefined : false });
    if (on === true) await hub.add(name);
    else await hub.remove(name);
  }

  function setTrust(name, trust) {
    if (!servers()[name]) return;
    update(name, { trust: trust === true || undefined });
    hub.refresh(name);
  }

  // Скрыть или вернуть отдельный инструмент сервера
  function setTool(name, tool, on) {
    const server = servers()[name];
    if (!server) return;
    const hidden = new Set(server.disabledTools || []);
    if (on === true) hidden.delete(String(tool));
    else hidden.add(String(tool));
    update(name, { disabledTools: hidden.size ? [...hidden] : undefined });
    hub.refresh(name);
  }

  // Для окна: каталог и установленные — без секретов (env и заголовки не отдаются)
  function list() {
    const items = Object.entries(servers()).map(([name, s]) => ({
      name,
      title: s.title || name,
      kind: s.url ? 'remote' : 'local',
      target: s.url || (s.package ? `${s.package}${s.version ? ` ${s.version}` : ''}` : [s.command, ...(s.args || [])].join(' ')),
      catalog: s.catalog || null,
      package: !!s.package,
      trust: s.trust === true,
      enabled: s.enabled !== false,
      status: hub.status(name),
    }));
    return { catalog: catalogForWindow(), servers: items, node: hasCommand('npm'), uv: hasCommand('uvx') };
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
  const str = (v) => String(v ?? '');
  ipc.handle('jarvis:mcp-list', list);
  ipc.handle(
    'jarvis:mcp-install',
    wrap((id, inputs) => install(str(id), inputs && typeof inputs === 'object' ? inputs : {})),
  );
  ipc.handle(
    'jarvis:mcp-add',
    wrap((name, target) => addCustom(str(name), str(target))),
  );
  ipc.handle(
    'jarvis:mcp-import',
    wrap((text, name) => importJson(str(text).slice(0, 100_000), str(name))),
  );
  ipc.handle(
    'jarvis:mcp-remove',
    wrap((name) => remove(str(name))),
  );
  ipc.handle(
    'jarvis:mcp-enable',
    wrap((name, on) => setEnabled(str(name), on)),
  );
  ipc.handle(
    'jarvis:mcp-trust',
    wrap((name, trust) => setTrust(str(name), trust)),
  );
  ipc.handle(
    'jarvis:mcp-tool',
    wrap((name, tool, on) => setTool(str(name), str(tool), on)),
  );
  ipc.handle(
    'jarvis:mcp-check',
    wrap((name) => hub.reload(str(name))),
  );
  ipc.handle(
    'jarvis:mcp-update',
    wrap((name) => upgrade(str(name))),
  );

  return {
    start: () => hub.start(),
    close: () => hub.close(),
    list,
    install,
    addCustom,
    importJson,
    upgrade,
    remove,
    setEnabled,
    setTrust,
    setTool,
    hub,
  };
}

module.exports = { createMcpManager };
