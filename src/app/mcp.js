// Подключения MCP: серверы из config.mcp.servers подключаются при запуске; из каталога и свои — ставятся из
// настроек и подключаются сразу, без перезапуска (их инструменты появляются у ассистента мгновенно).
// Удалённый сервер исчезает из навыков после перезапуска — до него его инструменты просто не вызываются.
const { spawnSync } = require('node:child_process');
const { connectMcp, parseCommand, slug } = require('../core/mcp');
const { catalogForWindow, serverFromCatalog } = require('../core/mcp-catalog');

// Есть ли npx (Node.js) — серверам из npm он нужен
let npxChecked = null;
function hasNpx() {
  if (npxChecked === null) {
    try {
      npxChecked = spawnSync('npx', ['-v'], { shell: true, windowsHide: true, timeout: 15_000 }).status === 0;
    } catch {
      npxChecked = false;
    }
  }
  return npxChecked;
}

function createMcpManager({ config, services, settings, ipc }) {
  const { skills, audit } = services;
  const status = {}; // имя → { ok, tools } | { ok: false, error }
  const closers = [];
  let restartNeeded = false;

  // Подключить серверы и отдать их инструменты ассистенту
  async function connect(servers) {
    const r = await connectMcp({ config: { mcp: { servers } }, log: audit });
    Object.assign(status, r.status);
    closers.push(r.close);
    const added = skills.add(r.skills);
    if (added.length) services.assistant.warmup(); // в каталоге навыков — новые строки
    return r;
  }

  const start = () => connect(config.mcp?.servers || {});

  function save(name, server) {
    settings.setPath(['mcp', 'servers', name], server);
  }

  // Поставить из каталога: inputs — значения полей (ключ API, папки)
  async function install(id, inputs) {
    const server = serverFromCatalog(id, inputs);
    if (server.command === 'npx' && !hasNpx()) throw new Error('Нужен Node.js — скачайте с nodejs.org и перезапустите меня');
    save(id, server);
    audit({ mcp: id, installed: 'каталог' });
    await connect({ [id]: server });
    return status[id];
  }

  // Свой сервер: команда («npx -y пакет …») или адрес https://…
  async function addCustom(name, target) {
    const key = slug(name);
    const t = String(target || '').trim();
    if (!key || !t) throw new Error('Нужны имя и команда или адрес');
    const server = /^https?:\/\//i.test(t) ? { url: t } : parseCommand(t);
    if (!server.url && !server.command) throw new Error('Не понял команду');
    save(key, { ...server, title: String(name).slice(0, 80) });
    audit({ mcp: key, installed: 'свой' });
    await connect({ [key]: config.mcp.servers[key] });
    return status[key];
  }

  function remove(name) {
    settings.setPath(['mcp', 'servers', name], undefined);
    delete status[name];
    restartNeeded = true; // инструменты уйдут из каталога ассистента после перезапуска
    audit({ mcp: name, removed: true });
  }

  function setTrust(name, trust) {
    const server = config.mcp?.servers?.[name];
    if (!server) return;
    save(name, { ...server, trust: trust === true });
  }

  // Для окна: каталог и установленные — без секретов (env и заголовки не отдаются)
  function list() {
    const servers = Object.entries(config.mcp?.servers || {}).map(([name, s]) => ({
      name,
      title: s.title || name,
      kind: s.url ? 'remote' : 'local',
      target: s.url || [s.command, ...(s.args || [])].join(' '),
      catalog: s.catalog || null,
      trust: s.trust === true,
      enabled: s.enabled !== false,
      status: status[name] || null,
    }));
    return { catalog: catalogForWindow(), servers, node: hasNpx(), restart: restartNeeded };
  }

  const wrap =
    (fn) =>
    async (...args) => {
      try {
        return { ok: true, status: await fn(...args), ...list() };
      } catch (err) {
        return { ok: false, error: String(err?.message || err), ...list() };
      }
    };
  ipc.handle('jarvis:mcp-list', list);
  ipc.handle(
    'jarvis:mcp-install',
    wrap((id, inputs) => install(String(id), inputs && typeof inputs === 'object' ? inputs : {})),
  );
  ipc.handle(
    'jarvis:mcp-add',
    wrap((name, target) => addCustom(String(name || ''), String(target || ''))),
  );
  ipc.handle(
    'jarvis:mcp-remove',
    wrap((name) => remove(String(name))),
  );
  ipc.handle(
    'jarvis:mcp-trust',
    wrap((name, trust) => setTrust(String(name), trust)),
  );

  return { start, close: () => Promise.all(closers.map((c) => c())), list, install, addCustom, remove };
}

module.exports = { createMcpManager };
