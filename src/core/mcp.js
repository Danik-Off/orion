// Сторонние MCP-серверы (modelcontextprotocol.io) — как навыки: каждый сервер становится навыком, его инструменты —
// инструментами Ориона. Подключаются при запуске; большая модель видит их в каталоге и вызывает, как свои.
//
// config.mcp.servers: { "<имя>": сервер } — формат как у Claude Desktop:
//   { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\me"], "env": {…} } — программа
//   { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } } — по HTTP
//   enabled: false — не подключать; trust: true — выполнять без вопроса (иначе спрашиваю перед каждым
//   действием, кроме инструментов, которые сервер объявил «только чтение»); title — строка для каталога навыков.
//
// Аргумент у инструментов Ориона — одна строка: для инструмента MCP это JSON его параметров (или значение
// единственного параметра). Пишет его большая модель по узкому промпту (llmArg). Ответ сервера — данные:
// короткий звучит как есть, длинный пересказывает отдельный вызов модели без инструментов (llm.answer).

const SPEAK_AS_IS = 280; // ответ короче — озвучивается как есть

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

const textOf = (result) =>
  (result?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();

// Сервер → навык Ориона. client — подключённый клиент MCP (callTool)
function skillFor(name, server, client, toolList) {
  const id = `mcp_${slug(name)}`;
  const title = server.title || `${name}: ${toolList.map((t) => t.title || t.name).join(', ')}`.slice(0, 160);
  return {
    id,
    title,
    mcp: true,
    keywords: [
      name.toLowerCase(),
      ...toolList.flatMap((t) =>
        String(t.title || t.name)
          .toLowerCase()
          .split(/[^a-zа-яё0-9]+/i),
      ),
    ].filter((w) => w.length > 2),
    tools: toolList.map((t) => ({
      name: `${slug(name)}__${slug(t.name)}`,
      use: String(t.description || t.title || t.name).slice(0, 300),
      arg: argOf(t.inputSchema),
      llmArg: true, // параметры инструмента пишет большая модель по его описанию
      speaks: true,
      filler: 'Сейчас узнаю.',
      async run(arg, ctx, request = {}) {
        let args;
        try {
          args = argsOf(arg, t.inputSchema);
        } catch (err) {
          return { ok: false, message: `Не понял параметры для «${t.title || t.name}», сэр.` };
        }
        // Действие с последствиями — только с разрешения (если сервер не помечен как доверенный)
        if (!server.trust && t.annotations?.readOnlyHint !== true) {
          const ok = await ctx.confirm(`Выполнить «${t.title || t.name}» через ${name}?`);
          if (ok !== true) return { ok: false, message: 'Отменил, сэр.' };
        }
        const result = await client.callTool({ name: t.name, arguments: args }, undefined, { timeout: 60_000 });
        const text = textOf(result);
        ctx.audit?.({ mcp: name, tool: t.name, error: !!result.isError, chars: text.length });
        if (result.isError) return { ok: false, message: `${name}: ${text.slice(0, 200) || 'ошибка'}` };
        if (!text) return { ok: true, speak: 'Готово, сэр.' };
        if (text.length <= SPEAK_AS_IS && !text.includes('\n')) return { ok: true, speak: text };
        // Длинный ответ — пересказ отдельным вызовом без инструментов: текст сервера — недоверенные данные
        const answer = await ctx.llm?.answer?.(request.text || t.description || t.name, text.slice(0, 6000)).catch(() => '');
        return { ok: true, speak: answer || text.slice(0, SPEAK_AS_IS) };
      },
    })),
  };
}

// Разбор командной строки из настроек: «npx -y "@scope/pkg" C:\dir» → { command, args }
function parseCommand(line) {
  const parts = [...String(line).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  return { command: parts[0] || '', args: parts.slice(1) };
}

// Подключить серверы. transportFor(server) — для тестов (по умолчанию — stdio или HTTP по полям сервера)
async function connectMcp({ config, log = () => {}, transportFor = defaultTransport, clientInfo = { name: 'orion', version: '1' } }) {
  const servers = Object.entries(config.mcp?.servers || {}).filter(([, s]) => s && s.enabled !== false);
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const clients = [];
  const skills = [];
  const status = {};
  await Promise.all(
    servers.map(async ([name, server]) => {
      try {
        const client = new Client(clientInfo);
        await client.connect(await transportFor(server), { timeout: 30_000 });
        clients.push(client);
        const { tools = [] } = await client.listTools();
        skills.push(skillFor(name, server, client, tools));
        status[name] = { ok: true, tools: tools.map((t) => t.title || t.name) };
        log({ mcp: name, connected: tools.length });
      } catch (err) {
        status[name] = { ok: false, error: String(err?.message || err).slice(0, 300) };
        log({ mcp: name, error: status[name].error });
      }
    }),
  );
  return { skills, status, close: () => Promise.all(clients.map((c) => c.close().catch(() => {}))) };
}

function defaultTransport(server) {
  if (server.url) {
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers || {} } });
  }
  if (!server.command) throw new Error('у сервера нет command или url');
  const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
  return new StdioClientTransport({
    command: server.command,
    args: server.args || [],
    env: { ...getDefaultEnvironment(), ...(server.env || {}) },
    cwd: server.cwd,
    stderr: 'ignore',
  });
}

module.exports = { connectMcp, skillFor, argOf, argsOf, parseCommand, slug };
