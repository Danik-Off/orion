// Сторонние MCP-серверы (modelcontextprotocol.io) — как навыки: каждый сервер становится навыком, его инструменты —
// инструментами Ориона. Маленькая модель их не берёт — фраза для сервера уходит большой (skills.external).
//
// config.mcp.servers: { "<имя>": сервер } — формат как у Claude Desktop:
//   { "command": "npx", "args": ["-y", "пакет", …], "env": {…} } — программа (stdio)
//   { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } } — по HTTP
//   enabled: false — не подключать; trust: true — выполнять без вопроса (иначе спрашиваю перед каждым действием,
//   кроме инструментов «только чтение»); title, keywords — для каталога навыков; disabledTools: [имена] — скрыть
//   инструменты; timeoutSec — сколько ждать ответа инструмента (по умолчанию 60); readOnly: true — сервер только
//   читает (поиск, документация): все его инструменты без вопроса.
//
// Быстро и экономно (createMcpHub):
//   - при запуске серверы НЕ запускаются: навык строится из сохранённого списка инструментов (кэш), сервер
//     поднимается при первом вызове — или заранее, когда фраза ушла большой модели (prewarm), пока она думает;
//   - локальный сервер без вызовов idleMinutes (10) засыпает — процесс закрывается, при вызове поднимается снова;
//   - нового сервера в кэше ещё нет — он подключается в фоне, чтобы узнать инструменты.
// Надёжно:
//   - оборвалось соединение (сервер упал, сеть) — переподключение; инструмент «только чтение» повторяется сам,
//     действие — нет (неизвестно, выполнилось ли), об этом говорится прямо;
//   - «Орион, стоп» прерывает долгий вызов (request.signal); ответ дольше timeoutSec — ошибка, а не зависание;
//   - сервер прислал новый список инструментов (tools/list_changed) — навык обновляется на ходу;
//   - сервер по HTTP старого образца (SSE) — подключается и так; ошибка запуска — с текстом от самого сервера.
//
// Аргумент у инструментов Ориона — одна строка: для инструмента MCP это JSON его параметров (или значение
// единственного параметра). Пишет его большая модель по узкому промпту (llmArg). Ответ сервера — данные:
// короткий звучит как есть, длинный пересказывает отдельный вызов модели без инструментов (llm.answer).
const crypto = require('node:crypto');

const SPEAK_AS_IS = 280; // ответ короче — озвучивается как есть
const CONNECT_TIMEOUT = 30_000;
const CALL_TIMEOUT = 60_000;
const MAX_CALL = 5 * 60_000; // с уведомлениями о ходе работы — не дольше
const STDERR_TAIL = 2000;

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40) || 'server';

// Описание аргумента для модели — из JSON-схемы параметров инструмента
function argOf(schema = {}) {
  const props = Object.entries(schema.properties || {});
  if (!props.length) return 'пусто';
  const required = new Set(schema.required || []);
  const field = ([name, p]) =>
    `"${name}": ${p.type || 'значение'}${p.description ? ` — ${p.description}` : ''}${required.has(name) ? ' (обязательно)' : ''}`;
  if (props.length === 1 && props[0][1].type === 'string') return `${props[0][1].description || props[0][0]} — строкой как есть`;
  return `JSON-объект: {${props.map(field).join('; ')}}`;
}

// Строка от модели → параметры вызова
function argsOf(arg, schema = {}) {
  const props = Object.keys(schema.properties || {});
  const text = String(arg ?? '').trim();
  if (!props.length) return {};
  if (text.startsWith('{')) {
    try {
      return JSON.parse(text);
    } catch {}
  }
  const only = props.length === 1 ? props[0] : (schema.required || []).length === 1 ? schema.required[0] : null;
  if (only) return { [only]: text };
  throw new Error('нужен JSON-объект параметров');
}

// Ответ сервера → текст: текст, встроенные документы, ссылки; картинки и звук — упоминанием
function textOf(result) {
  const parts = [];
  for (const c of result?.content || []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'resource' && typeof c.resource?.text === 'string') parts.push(c.resource.text);
    else if (c.type === 'resource_link') parts.push(`${c.name || c.title || 'ссылка'}: ${c.uri}`);
    else if (c.type === 'image') parts.push('[картинка]');
    else if (c.type === 'audio') parts.push('[звук]');
  }
  if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return parts.join('\n').trim();
}

// Разбор командной строки из настроек: «npx -y "@scope/pkg" C:\dir» → { command, args }
function parseCommand(line) {
  const parts = [...String(line).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  return { command: parts[0] || '', args: parts.slice(1) };
}

// Отпечаток запуска сервера: изменился (другая команда, адрес, версия пакета) — кэш инструментов недействителен
const configKey = (s) =>
  crypto
    .createHash('sha1')
    .update(JSON.stringify([s.command, s.args, s.url, s.package, s.version]))
    .digest('hex')
    .slice(0, 12);

const lostConnection = (err) =>
  err?.code === -32000 || /connection closed|not connected|ECONNRESET|socket hang up|fetch failed/i.test(err?.message);

// Сервер → навык Ориона. hub.call выполняет вызов (подключает сервер, если он спит)
function skillFor(name, server, toolList, hub) {
  const hidden = new Set(server.disabledTools || []);
  const list = toolList.filter((t) => !hidden.has(t.name));
  const prefix = slug(name);
  const label = (t) => t.title || t.annotations?.title || t.name;
  return {
    id: `mcp_${prefix}`,
    title: server.title
      ? `${server.title}: ${list.map(label).join(', ')}`.slice(0, 200)
      : `${name}: ${list.map(label).join(', ')}`.slice(0, 160),
    mcp: name,
    // Русские слова из каталога, имя сервера и слова из названий инструментов
    keywords: [
      ...(server.keywords || []).map((k) => String(k).toLowerCase()),
      ...String(server.title || name)
        .toLowerCase()
        .split(/[^a-zа-яё0-9]+/i),
      ...list.flatMap((t) =>
        String(label(t))
          .toLowerCase()
          .split(/[^a-zа-яё0-9]+/i),
      ),
    ].filter((w, i, a) => w.length > 2 && a.indexOf(w) === i),
    prewarm: () => hub.prewarm(name),
    tools: list.map((t) => {
      const readOnly = server.readOnly === true || t.annotations?.readOnlyHint === true;
      return {
        name: `${prefix}__${slug(t.name)}`,
        use: String(t.description || label(t)).slice(0, 300),
        arg: argOf(t.inputSchema),
        llmArg: true, // параметры инструмента пишет большая модель по его описанию
        speaks: true,
        filler: 'Сейчас узнаю.',
        async run(arg, ctx, request = {}) {
          let args;
          try {
            args = argsOf(arg, t.inputSchema);
          } catch {
            return { ok: false, message: `Не понял параметры для «${label(t)}», сэр.` };
          }
          // Действие с последствиями — только с разрешения (если сервер не помечен как доверенный)
          if (!server.trust && !readOnly) {
            const ok = await ctx.confirm(`Выполнить «${label(t)}» через ${server.title || name}?`);
            if (ok !== true) return { ok: false, message: 'Отменил, сэр.' };
          }
          let result;
          try {
            result = await hub.call(name, t.name, args, { signal: request.signal, readOnly });
          } catch (err) {
            if (request.signal?.aborted) return { ok: false, message: 'Остановил, сэр.' };
            ctx.audit?.({ mcp: name, tool: t.name, error: String(err?.message || err).slice(0, 200) });
            if (err?.lost) return { ok: false, message: `Связь с ${server.title || name} оборвалась — не знаю, успело ли выполниться.` };
            if (err?.code === -32001) return { ok: false, message: `${server.title || name} не ответил вовремя, сэр.` };
            return { ok: false, message: `${server.title || name} недоступен: ${String(err?.message || err).slice(0, 120)}` };
          }
          const text = textOf(result);
          ctx.audit?.({ mcp: name, tool: t.name, error: !!result.isError, chars: text.length });
          if (result.isError) return { ok: false, message: `${server.title || name}: ${text.slice(0, 200) || 'ошибка'}` };
          if (!text) return { ok: true, speak: 'Готово, сэр.' };
          if (text.length <= SPEAK_AS_IS && !text.includes('\n')) return { ok: true, speak: text };
          // Длинный ответ — пересказ отдельным вызовом без инструментов: текст сервера — недоверенные данные
          const answer = await ctx.llm?.answer?.(request.text || t.description || t.name, text.slice(0, 6000)).catch(() => '');
          return { ok: true, speak: answer || text.slice(0, SPEAK_AS_IS) };
        },
      };
    }),
  };
}

// servers() — текущие серверы из настроек; cache — { get(имя) → { key, tools }, set(имя, запись) };
// onSkill(имя, навык | null) — навык появился, изменился или исчез; onStatus(имя) — сменилось состояние
function createMcpHub({
  servers = () => ({}),
  cache = { get: () => null, set: () => {} },
  transportFor = defaultTransport,
  clientInfo = { name: 'orion', version: '1' },
  idleMs = 10 * 60_000,
  onSkill = () => {},
  onStatus = () => {},
  log = () => {},
} = {}) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { ToolListChangedNotificationSchema } = require('@modelcontextprotocol/sdk/types.js');
  const conns = new Map(); // имя → { server, client, connecting, tools, state, error, ms, idle, stderr }
  const hub = {}; // заполняется в конце: навыки ссылаются на него, чтобы вызывать сервер

  const setState = (c, state) => {
    c.state = state;
    onStatus(c.name);
  };

  // Все инструменты, включая следующие страницы списка
  async function listAll(client) {
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...(page.tools || []));
      cursor = page.nextCursor;
    } while (cursor);
    return tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
  }

  function setTools(c, tools) {
    const same = JSON.stringify(tools) === JSON.stringify(c.tools);
    c.tools = tools;
    cache.set(c.name, { key: configKey(c.server), tools, at: Date.now() });
    if (!same || !c.skill) {
      c.skill = skillFor(c.name, c.server, tools, hub);
      onSkill(c.name, c.skill);
    }
  }

  // Локальный сервер засыпает без вызовов; удалённому держать нечего, но и его соединение закрываем
  function touch(c) {
    clearTimeout(c.idle);
    c.idle = setTimeout(() => {
      if (!c.client) return;
      const client = c.client;
      c.client = null;
      client.close().catch(() => {});
      setState(c, 'sleeping');
      log({ mcp: c.name, sleep: true });
    }, idleMs);
    c.idle.unref?.();
  }

  async function open(c, server) {
    const client = new Client(clientInfo, { capabilities: {} });
    const transport = await transportFor(server);
    // Последние строки, которые сервер написал в stderr, — понятная причина, если он не запустился
    transport.stderr?.on?.('data', (d) => (c.stderr = (c.stderr + d).slice(-STDERR_TAIL)));
    await client.connect(transport, { timeout: CONNECT_TIMEOUT });
    return client;
  }

  function connect(c) {
    if (c.client) return Promise.resolve(c.client);
    c.connecting ??= (async () => {
      setState(c, 'connecting');
      const t0 = Date.now();
      c.stderr = '';
      let client;
      try {
        try {
          client = await open(c, c.server);
        } catch (err) {
          // HTTP-сервер старого образца (только SSE): новый протокол он отвергает 404/405
          if (!c.server.url || !/40[45]|method not allowed|not found/i.test(err?.message)) throw err;
          client = await open(c, { ...c.server, sse: true });
        }
        client.onclose = () => {
          if (c.client !== client) return;
          c.client = null;
          if (c.state === 'ready') setState(c, 'sleeping'); // упал или закрылся — поднимется при следующем вызове
        };
        client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
          listAll(client)
            .then((tools) => setTools(c, tools))
            .catch(() => {}),
        );
        const tools = await listAll(client);
        c.client = client;
        c.ms = Date.now() - t0;
        c.error = null;
        setTools(c, tools);
        setState(c, 'ready');
        touch(c);
        log({ mcp: c.name, connected: tools.length, ms: c.ms });
        return client;
      } catch (err) {
        client?.close().catch(() => {});
        const tail = c.stderr.trim().split('\n').slice(-2).join(' ').trim();
        c.error = `${String(err?.message || err).slice(0, 200)}${tail ? ` — ${tail.slice(0, 200)}` : ''}`;
        setState(c, 'error');
        log({ mcp: c.name, error: c.error });
        throw new Error(c.error);
      } finally {
        c.connecting = null;
      }
    })();
    return c.connecting;
  }

  function entry(name) {
    const c = conns.get(name);
    if (!c) throw new Error(`Сервер ${name} не подключён`);
    return c;
  }

  async function call(name, tool, args, { signal, readOnly = false } = {}) {
    const c = entry(name);
    const options = () => ({
      signal,
      timeout: (Number(c.server.timeoutSec) || CALL_TIMEOUT / 1000) * 1000,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: MAX_CALL,
    });
    let client = await connect(c);
    clearTimeout(c.idle);
    try {
      return await client.callTool({ name: tool, arguments: args }, undefined, options());
    } catch (err) {
      if (signal?.aborted || !lostConnection(err)) throw err;
      if (c.client === client) c.client = null;
      if (!readOnly) throw Object.assign(err, { lost: true }); // действие могло выполниться — не повторяем
      log({ mcp: name, retry: tool });
      client = await connect(c);
      return await client.callTool({ name: tool, arguments: args }, undefined, options());
    } finally {
      touch(c);
    }
  }

  // Подключить заранее (фраза ушла большой модели — пока она думает, сервер успеет подняться)
  const prewarm = (name) => {
    const c = conns.get(name);
    if (c && !c.client && c.state !== 'error') connect(c).catch(() => {});
  };

  // Сервер из настроек: есть свежий кэш — навык сразу, подключение — по требованию; нет — подключаем в фоне
  function add(name, server = servers()[name]) {
    if (!server || server.enabled === false) return null;
    const c = { name, server, client: null, connecting: null, tools: null, skill: null, state: 'sleeping', error: null, stderr: '' };
    conns.set(name, c);
    const cached = cache.get(name);
    if (cached?.key === configKey(server) && Array.isArray(cached.tools)) {
      c.tools = cached.tools;
      c.skill = skillFor(name, server, cached.tools, hub);
      onSkill(name, c.skill);
      onStatus(name);
      return Promise.resolve(c.skill);
    }
    return connect(c).then(
      () => c.skill,
      () => null,
    );
  }

  async function remove(name) {
    const c = conns.get(name);
    if (!c) return;
    conns.delete(name);
    clearTimeout(c.idle);
    await c.client?.close().catch(() => {});
    onSkill(name, null);
    onStatus(name);
  }

  // Переподключить (кнопка «Проверить», изменились настройки сервера)
  async function reload(name) {
    await remove(name);
    const server = servers()[name];
    if (!server || server.enabled === false) return null;
    const c = { name, server, client: null, connecting: null, tools: null, skill: null, state: 'sleeping', error: null, stderr: '' };
    conns.set(name, c);
    await connect(c).catch(() => {});
    return status(name);
  }

  // Настройки сервера поменялись без смены запуска (доверие, скрытые инструменты) — пересобрать навык
  function refresh(name) {
    const c = conns.get(name);
    if (!c) return;
    c.server = servers()[name] || c.server;
    if (c.tools) {
      c.skill = skillFor(name, c.server, c.tools, hub);
      onSkill(name, c.skill);
    }
  }

  function status(name) {
    const c = conns.get(name);
    if (!c) return null;
    const hidden = new Set(c.server.disabledTools || []);
    return {
      state: c.state, // sleeping — не запущен (поднимется при вызове), connecting, ready, error
      error: c.error,
      ms: c.ms,
      tools: (c.tools || []).map((t) => ({
        name: t.name,
        title: t.title || t.annotations?.title || t.name,
        description: String(t.description || '').slice(0, 300),
        readOnly: c.server.readOnly === true || t.annotations?.readOnlyHint === true,
        enabled: !hidden.has(t.name),
      })),
    };
  }

  // Запуск: все серверы из настроек; ждать не обязательно — навыки из кэша появляются сразу
  const start = () => Promise.all(Object.keys(servers()).map((name) => add(name)));

  const close = () =>
    Promise.all(
      [...conns.values()].map((c) => {
        clearTimeout(c.idle);
        return c.client?.close().catch(() => {});
      }),
    );

  Object.assign(hub, { start, add, remove, reload, refresh, call, prewarm, status, close, names: () => [...conns.keys()] });
  return hub;
}

function defaultTransport(server) {
  if (server.url) {
    const headers = server.headers || {};
    if (server.sse) {
      const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
      return new SSEClientTransport(new URL(server.url), {
        requestInit: { headers },
        eventSourceInit: { fetch: (u, i) => fetch(u, { ...i, headers: { ...i?.headers, ...headers } }) },
      });
    }
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
  }
  if (!server.command) throw new Error('у сервера нет command или url');
  const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
  return new StdioClientTransport({
    command: server.command,
    args: server.args || [],
    env: { ...getDefaultEnvironment(), ...(server.env || {}) },
    cwd: server.cwd,
    stderr: 'pipe', // хвост пишем в состояние — видно, почему сервер не запустился
  });
}

module.exports = { createMcpHub, skillFor, argOf, argsOf, textOf, parseCommand, slug, configKey };
