// Подключения MCP: сервер в памяти (официальный SDK, без процессов и сети) → навык Ориона
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { connectMcp, argOf, argsOf, parseCommand } = require('../src/core/mcp');
const { serverFromCatalog, catalogForWindow } = require('../src/core/mcp-catalog');
const { makeRegistry } = require('./helpers');

// Сервер «заметки»: чтение без последствий и запись, которую нужно подтверждать
async function notesServer() {
  const server = new McpServer({ name: 'notes', version: '1.0.0' });
  const notes = [];
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
  const [client, srv] = InMemoryTransport.createLinkedPair();
  await server.connect(srv);
  return { client, notes };
}

test('MCP: инструменты сервера — навык Ориона; запись — с разрешения, чтение — сразу; длинное — пересказ', async () => {
  const { client, notes } = await notesServer();
  const log = [];
  const mcp = await connectMcp({
    config: { mcp: { servers: { 'Мои заметки': {} } } },
    transportFor: () => client,
    log: (e) => log.push(e),
  });
  try {
    assert.equal(mcp.status['Мои заметки'].ok, true);
    const [skill] = mcp.skills;
    assert.equal(skill.id, 'mcp_server', 'имя без латиницы — запасной id');
    assert.deepEqual(
      skill.tools.map((t) => t.name),
      ['server__list_notes', 'server__add_note', 'server__report'],
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
    // запись без разрешения — не выполняется
    let r = await tool('add_note').run('купить хлеб', ctx);
    assert.equal(r.ok, false);
    assert.deepEqual(notes, []);
    assert.match(asked[0], /Добавить заметку/);
    // с разрешением — выполняется; единственный параметр — строкой как есть
    answer = true;
    r = await tool('add_note').run('купить хлеб', ctx);
    assert.equal(r.speak, 'Записал: купить хлеб');
    // чтение — без вопроса
    asked.length = 0;
    r = await tool('list_notes').run('', ctx);
    assert.equal(r.speak, 'купить хлеб');
    assert.equal(asked.length, 0, 'инструмент «только чтение» не спрашивает');
    // длинный ответ — пересказ отдельным вызовом модели без инструментов
    r = await tool('report').run('', { ...ctx, confirm: async () => assert.fail('чтение не спрашивает') }, { text: 'что в отчёте' });
    assert.match(r.speak, /^Кратко: 60 строк/);

    // реестр подхватывает сервер после запуска
    const { skills } = makeRegistry();
    assert.deepEqual(skills.add(mcp.skills), ['mcp_server']);
    assert.ok(skills.names().includes('server__add_note'));
    assert.match(skills.catalogPrompt(), /mcp_server/, 'большая модель видит его в каталоге');
    assert.deepEqual(skills.add(mcp.skills), [], 'повторно не добавляется');
  } finally {
    await mcp.close();
  }
});

test('MCP: сервер не отвечает — ошибка в состоянии, остальное работает', async () => {
  const mcp = await connectMcp({
    config: { mcp: { servers: { bad: { command: 'x' }, off: { command: 'y', enabled: false } } } },
    transportFor: () => {
      throw new Error('не запустился');
    },
    log: () => {},
  });
  assert.deepEqual(mcp.skills, []);
  assert.equal(mcp.status.bad.ok, false);
  assert.match(mcp.status.bad.error, /не запустился/);
  assert.equal(mcp.status.off, undefined, 'выключенный не подключается');
});

test('MCP: аргументы — JSON или единственное значение; команда своего сервера; каталог', () => {
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

  assert.deepEqual(parseCommand('npx -y "@scope/pkg" C:\\My Folder'), { command: 'npx', args: ['-y', '@scope/pkg', 'C:\\My', 'Folder'] });
  assert.deepEqual(parseCommand('npx -y pkg "C:\\My Folder"').args, ['-y', 'pkg', 'C:\\My Folder']);

  assert.throws(() => serverFromCatalog('brave-search', {}), /Заполните/);
  assert.deepEqual(serverFromCatalog('brave-search', { apiKey: 'k' }).env, { BRAVE_API_KEY: 'k' });
  assert.deepEqual(serverFromCatalog('filesystem', { folders: 'C:\\a; D:\\b' }).args.slice(-2), ['C:\\a', 'D:\\b']);
  assert.equal(serverFromCatalog('deepwiki').url, 'https://mcp.deepwiki.com/mcp');
  const forWindow = catalogForWindow();
  assert.ok(
    forWindow.every((c) => typeof c.title === 'string' && !('server' in c)),
    'в окно — без функций',
  );
});
