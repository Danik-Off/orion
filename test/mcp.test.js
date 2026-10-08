// Подключения MCP: настоящий сервер SDK в памяти (без процессов и сети) → навык Ориона.
// Ленивый запуск из кэша, сон без дела, переподключение, отмена, новые инструменты на ходу, каталог, импорт JSON.
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createMcpHub, argOf, argsOf, textOf, parseCommand, configKey } = require('../src/core/mcp');
const { serverFromCatalog, catalogForWindow, CATALOG } = require('../src/core/mcp-catalog');
const { npxPackage } = require('../src/app/mcp-packages');
const { createMcpManager } = require('../src/app/mcp');
const { makeRegistry, tmp } = require('./helpers');

// Сервер «заметки»: чтение без последствий, запись — с разрешения, длинный отчёт, медленный инструмент.
// Каждое подключение — новый сервер в памяти (как новый процесс); counter — сколько раз подключались
function notesServers() {
  const notes = [];
  const counter = { connects: 0, servers: [] };
  const transportFor = async () => {
    counter.connects++;
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    server.registerTool(
      'list_notes',
      { title: 'Список заметок', description: 'Показать все заметки', annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: 'text', text: notes.length ? notes.join('; ') : 'Заметок нет.' }] }),
    );
    server.registerTool(
      'add_note',
      { title: 'Добавить заметку', description: 'Записать заметку', inputSchema: { text: z.string().describe('текст заметки') } },
      async ({ text }) => (notes.push(text), { content: [{ type: 'text', text: `Записал: ${text}` }] }),
    );
    server.registerTool('report', { title: 'Отчёт', description: 'Длинный отчёт', annotations: { readOnlyHint: true } }, async () => ({
      content: [{ type: 'text', text: 'строка отчёта\n'.repeat(60) }],
    }));
    server.registerTool('slow', { title: 'Долгая задача', annotations: { readOnlyHint: true } }, async (extra) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 5000);
        extra.signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('прервано'))));
      });
      return { content: [{ type: 'text', text: 'готово' }] };
    });
    const [client, srv] = InMemoryTransport.createLinkedPair();
    await server.connect(srv);
    counter.servers.push(server);
    return client;
  };
  return { notes, counter, transportFor };
}

const memoryCache = () => {
  const data = {};
  return { data, get: (n) => data[n] || null, set: (n, e) => (data[n] = e) };
};

test('MCP: навык из сервера; запись — с разрешения, чтение — сразу; длинное — пересказ; реестр и маршрут', async () => {
  const { notes, transportFor } = notesServers();
  const skillsSeen = [];
  const hub = createMcpHub({
    servers: () => ({ 'Мои заметки': { title: 'Заметки', keywords: ['заметк'] } }),
    transportFor,
    onSkill: (n, s) => skillsSeen.push(s),
  });
  try {
    const skill = await hub.add('Мои заметки');
    assert.equal(hub.status('Мои заметки').state, 'ready');
    assert.equal(skill.id, 'mcp_server', 'имя без латиницы — запасной id');
    assert.deepEqual(
      skill.tools.map((t) => t.name),
      ['server__list_notes', 'server__add_note', 'server__report', 'server__slow'],
    );
    const tool = (n) => skill.tools.find((t) => t.name.endsWith(n));
    assert.equal(tool('add_note').llmArg, true, 'параметры пишет большая модель');
    assert.match(tool('add_note').arg, /текст заметки/);

    const asked = [];
    let answer = false;
    const ctx = {
      confirm: async (q) => (asked.push(q), answer),
      audit: () => {},
      llm: { answer: async (q, text) => `Кратко: ${text.split('\n').length} строк` },
    };
    let r = await tool('add_note').run('купить хлеб', ctx);
    assert.equal(r.ok, false);
    assert.deepEqual(notes, []);
    assert.match(asked[0], /Добавить заметку/);
    answer = true;
    r = await tool('add_note').run('купить хлеб', ctx);
    assert.equal(r.speak, 'Записал: купить хлеб');
    asked.length = 0;
    r = await tool('list_notes').run('', ctx);
    assert.equal(r.speak, 'купить хлеб');
    assert.equal(asked.length, 0, 'инструмент «только чтение» не спрашивает');
    r = await tool('report').run('', ctx, { text: 'что в отчёте' });
    assert.match(r.speak, /^Кратко: 60 строк/);

    // Реестр: добавить, повторно не добавляется, заменить, убрать
    const { skills } = makeRegistry();
    assert.deepEqual(skills.add([skill]), ['mcp_server']);
    assert.ok(skills.names().includes('server__add_note'));
    assert.match(skills.catalogPrompt(), /mcp_server/, 'большая модель видит его в каталоге');
    assert.deepEqual(skills.add([skill]), [], 'повторно не добавляется');
    // Фраза про сервер — мимо маленькой модели, к большой
    assert.equal(skills.external('добавь в заметки купить хлеб'), 'mcp_server');
    assert.equal(skills.external('какая погода завтра'), null);
    assert.equal(skills.replace({ ...skill, tools: skill.tools.slice(0, 1) }), true);
    assert.ok(!skills.names().includes('server__add_note'), 'замена — со своим списком инструментов');
    assert.equal(skills.remove('mcp_server'), true);
    assert.ok(!skills.names().includes('server__list_notes'), 'удалён — инструментов нет');
    assert.ok(!skills.catalogPrompt().includes('mcp_server'));
  } finally {
    await hub.close();
  }
});

test('MCP: из кэша — навык сразу, сервер не запускается; запуск — при вызове или заранее (prewarm)', async () => {
  const { transportFor, counter } = notesServers();
  const cache = memoryCache();
  const servers = { notes: { command: 'x' } };
  // Первый запуск: кэша нет — подключение в фоне, список инструментов — в кэш
  const first = createMcpHub({ servers: () => servers, transportFor, cache });
  await first.add('notes');
  await first.close();
  assert.equal(counter.connects, 1);
  assert.equal(cache.data.notes.key, configKey(servers.notes));
  assert.equal(cache.data.notes.tools.length, 4);

  // Второй запуск: из кэша, без подключения
  const hub = createMcpHub({ servers: () => servers, transportFor, cache });
  try {
    const skill = await hub.add('notes');
    assert.equal(counter.connects, 1, 'сервер не запущен');
    assert.equal(hub.status('notes').state, 'sleeping');
    assert.equal(skill.tools.length, 4);
    const r = await skill.tools[0].run('', { confirm: async () => true });
    assert.equal(r.speak, 'Заметок нет.');
    assert.equal(counter.connects, 2, 'поднят при первом вызове');
    assert.equal(hub.status('notes').state, 'ready');
    // Изменился запуск сервера (другая команда) — кэш недействителен
    servers.notes = { command: 'y' };
    const other = createMcpHub({ servers: () => servers, transportFor, cache });
    await other.add('notes');
    assert.equal(counter.connects, 3);
    await other.close();
  } finally {
    await hub.close();
  }

  const lazy = createMcpHub({ servers: () => servers, transportFor, cache });
  await lazy.add('notes');
  lazy.prewarm('notes');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(lazy.status('notes').state, 'ready', 'prewarm поднимает заранее');
  await lazy.close();
});

test('MCP: без дела засыпает и просыпается при вызове; «стоп» прерывает долгий вызов', async () => {
  const { transportFor, counter } = notesServers();
  const hub = createMcpHub({ servers: () => ({ notes: {} }), transportFor, idleMs: 30 });
  try {
    const skill = await hub.add('notes');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(hub.status('notes').state, 'sleeping', 'уснул');
    const list = skill.tools.find((t) => t.name.endsWith('list_notes'));
    assert.equal((await list.run('', {})).ok, true);
    assert.equal(counter.connects, 2, 'проснулся');

    const controller = new AbortController();
    const slow = skill.tools.find((t) => t.name.endsWith('slow'));
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    const r = await slow.run('', { audit: () => {} }, { signal: controller.signal });
    assert.equal(r.message, 'Остановил, сэр.');
    assert.ok(Date.now() - started < 2000, 'не ждём конца долгого вызова');
  } finally {
    await hub.close();
  }
});

test('MCP: связь оборвалась — чтение повторяется само, действие — нет (неизвестно, выполнилось ли)', async () => {
  const { transportFor, counter, notes } = notesServers();
  const hub = createMcpHub({ servers: () => ({ notes: { trust: true } }), transportFor });
  try {
    const skill = await hub.add('notes');
    const tool = (n) => skill.tools.find((t) => t.name.endsWith(n));
    // Сервер «упал»: закрываем его сторону
    await counter.servers.at(-1).close();
    await new Promise((r) => setTimeout(r, 10));
    let r = await tool('list_notes').run('', { audit: () => {} });
    assert.equal(r.ok, true, 'чтение — после переподключения');
    assert.equal(counter.connects, 2);

    // Обрыв посреди вызова действия: сервер закрывается, пока выполняет запись
    const realCall = hub.call;
    hub.call = async (...a) => {
      const c = counter.servers.at(-1);
      setTimeout(() => c.close(), 0);
      return realCall(...a);
    };
    r = await tool('add_note').run('x', { audit: () => {} });
    hub.call = realCall;
    assert.ok(r.ok === true || /оборвалась/.test(r.message), 'действие не повторяется вслепую');
    assert.ok(notes.length <= 1, 'запись не задвоилась');
  } finally {
    await hub.close();
  }
});

test('MCP: сервер прислал новые инструменты — навык обновляется; скрытые инструменты не видны', async () => {
  const { transportFor, counter } = notesServers();
  const seen = [];
  const servers = { notes: { disabledTools: ['report'] } };
  const hub = createMcpHub({ servers: () => servers, transportFor, onSkill: (n, s) => seen.push(s) });
  try {
    const skill = await hub.add('notes');
    assert.ok(!skill.tools.some((t) => t.name.endsWith('report')), 'скрытый инструмент не виден модели');
    assert.equal(hub.status('notes').tools.find((t) => t.name === 'report').enabled, false);
    counter.servers.at(-1).registerTool('new_tool', { title: 'Новый' }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(
      seen.at(-1).tools.some((t) => t.name.endsWith('new_tool')),
      'список обновился по уведомлению сервера',
    );
    servers.notes = {};
    hub.refresh('notes');
    assert.ok(
      seen.at(-1).tools.some((t) => t.name.endsWith('report')),
      'вернули инструмент — снова виден',
    );
  } finally {
    await hub.close();
  }
});

test('MCP: сервер не запускается — ошибка в состоянии, остальное работает', async () => {
  const hub = createMcpHub({
    servers: () => ({ bad: { command: 'x' }, off: { command: 'y', enabled: false } }),
    transportFor: () => {
      throw new Error('не запустился');
    },
  });
  await hub.start();
  assert.equal(hub.status('bad').state, 'error');
  assert.match(hub.status('bad').error, /не запустился/);
  assert.equal(hub.status('off'), null, 'выключенный не подключается');
});

test('MCP: аргументы, ответы, команда своего сервера, npx → свой пакет', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string', description: 'путь' }, depth: { type: 'number' } },
    required: ['path'],
  };
  assert.match(argOf(schema), /^JSON-объект: \{"path": string — путь \(обязательно\); "depth": number\}$/);
  assert.equal(argOf({}), 'пусто');
  assert.deepEqual(argsOf('{"path":"C:/x","depth":2}', schema), { path: 'C:/x', depth: 2 });
  assert.deepEqual(argsOf('C:/x', schema), { path: 'C:/x' }, 'одно обязательное — строкой');
  assert.throws(() => argsOf('x', { properties: { a: {}, b: {} } }), /JSON/);
  assert.equal(
    textOf({
      content: [
        { type: 'text', text: 'а' },
        { type: 'image', data: '', mimeType: 'image/png' },
        { type: 'resource_link', uri: 'https://x', name: 'док' },
      ],
    }),
    'а\n[картинка]\nдок: https://x',
  );
  assert.equal(textOf({ content: [], structuredContent: { t: 1 } }), '{"t":1}');

  assert.deepEqual(parseCommand('npx -y "@scope/pkg" C:\\My Folder'), { command: 'npx', args: ['-y', '@scope/pkg', 'C:\\My', 'Folder'] });
  assert.deepEqual(parseCommand('npx -y pkg "C:\\My Folder"').args, ['-y', 'pkg', 'C:\\My Folder']);
  assert.deepEqual(npxPackage({ command: 'npx', args: ['-y', '@scope/pkg@1.2', '--port', '1'] }), {
    package: '@scope/pkg@1.2',
    args: ['--port', '1'],
  });
  assert.equal(npxPackage({ command: 'npx', args: ['-y', 'pkg; rm -rf /'] }), null, 'странное имя — не ставим');
  assert.equal(npxPackage({ command: 'uvx', args: ['x'] }), null);
});

test('MCP: каталог — серверы с ключами, адресами и пакетами; в окно — без функций', () => {
  assert.ok(CATALOG.length >= 20, 'каталог расширен');
  assert.equal(new Set(CATALOG.map((c) => c.id)).size, CATALOG.length, 'id не повторяются');
  for (const c of CATALOG) {
    assert.ok(c.keywords?.length, `${c.id}: русские слова для маршрута`);
    assert.ok(['remote', 'node', 'python'].includes(c.runtime), c.id);
    if (c.runtime === 'node') assert.ok(c.package && c.bin, `${c.id}: пакет и программа`);
  }
  assert.throws(() => serverFromCatalog('brave-search', {}), /Заполните/);
  const brave = serverFromCatalog('brave-search', { apiKey: ' k ' });
  assert.deepEqual(brave.env, { BRAVE_API_KEY: 'k' });
  assert.equal(brave.package, '@brave/brave-search-mcp-server');
  assert.deepEqual(brave.args, ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'], 'запасной запуск — npx');
  assert.deepEqual(serverFromCatalog('filesystem', { folders: 'C:\\a; D:\\b' }).args.slice(-2), ['C:\\a', 'D:\\b']);
  assert.equal(serverFromCatalog('deepwiki').url, 'https://mcp.deepwiki.com/mcp');
  assert.deepEqual(serverFromCatalog('github', { token: 't' }).headers, { Authorization: 'Bearer t' });
  assert.equal(serverFromCatalog('huggingface').headers, undefined, 'необязательный токен — без заголовка');
  assert.equal(serverFromCatalog('home-assistant', { url: 'http://ha:8123/', token: 't' }).url, 'http://ha:8123/api/mcp');
  const fetchServer = serverFromCatalog('fetch');
  assert.deepEqual([fetchServer.command, fetchServer.args], ['uvx', ['mcp-server-fetch']]);
  assert.equal(fetchServer.readOnly, true, 'чтение страниц — без вопроса');
  assert.equal(serverFromCatalog('github', { token: 't' }).readOnly, undefined, 'GitHub меняет данные — с разрешения');
  assert.ok(catalogForWindow().every((c) => typeof c.title === 'string' && !('server' in c) && !('env' in c)));
});

test('MCP: менеджер — импорт JSON, выключить и включить, скрыть инструмент, удалить; секреты в окно не уходят', async () => {
  const { transportFor } = notesServers();
  const config = { mcp: { servers: {} } };
  const set = (obj, keys, v) => {
    const last = keys.at(-1);
    const parent = keys.slice(0, -1).reduce((o, k) => (o[k] ??= {}), obj);
    if (v === undefined) delete parent[last];
    else parent[last] = v;
  };
  const handlers = {};
  const { skills } = makeRegistry();
  const mcp = createMcpManager({
    config,
    dataDir: tmp(),
    services: { skills, audit: () => {}, assistant: { warmup: () => {} } },
    settings: { setPath: (keys, v) => set(config, keys, v) },
    ipc: { handle: (ch, fn) => (handlers[ch] = fn), broadcast: () => {} },
    hubOptions: { transportFor },
  });
  try {
    const json = JSON.stringify({
      mcpServers: {
        Notes: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer секрет' } },
        local: { command: 'uvx', args: ['some-server'], env: { KEY: 'секрет' } },
      },
    });
    const r = await handlers['jarvis:mcp-import'](json);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(Object.keys(config.mcp.servers), ['notes', 'local']);
    assert.equal(config.mcp.servers.notes.headers.Authorization, 'Bearer секрет', 'заголовки сохранены');
    assert.doesNotMatch(JSON.stringify(r), /секрет/, 'в окно — без ключей');
    assert.equal(r.servers.find((s) => s.name === 'notes').status.state, 'ready');
    assert.ok(skills.names().includes('notes__add_note'), 'инструменты — у ассистента сразу');

    await handlers['jarvis:mcp-enable']('notes', false);
    assert.equal(config.mcp.servers.notes.enabled, false);
    assert.ok(!skills.names().includes('notes__add_note'), 'выключили — инструментов нет, без перезапуска');
    await handlers['jarvis:mcp-enable']('notes', true);
    assert.ok(skills.names().includes('notes__add_note'));

    await handlers['jarvis:mcp-tool']('notes', 'add_note', false);
    assert.deepEqual(config.mcp.servers.notes.disabledTools, ['add_note']);
    assert.ok(!skills.names().includes('notes__add_note'), 'скрытый инструмент — у ассистента нет');

    await handlers['jarvis:mcp-remove']('notes');
    assert.equal(config.mcp.servers.notes, undefined);
    assert.ok(!skills.names().some((n) => n.startsWith('notes__')), 'удалён — без перезапуска');

    const bad = await handlers['jarvis:mcp-import']('не json');
    assert.equal(bad.ok, false);
    assert.match(bad.error, /не JSON/);
  } finally {
    await mcp.close();
  }
});
