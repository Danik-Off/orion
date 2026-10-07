// Каталог MCP-серверов, которые можно поставить одной кнопкой (Настройки → «Подключения»).
// Только проверенные: официальные серверы протокола и известные сервисы (имена пакетов сверены с npm 2026-10-07).
//
// Сервер: { id, title, description, category, runtime: 'node' (нужен Node.js — запуск через npx) | 'remote' (по HTTP),
//   inputs: [{ key, label, placeholder?, secret?, required?, link? }] — что спросить при установке,
//   server(inputs) → запись для config.mcp.servers }
const CATALOG = [
  {
    id: 'deepwiki',
    title: 'DeepWiki',
    description: 'Ответы по устройству открытых репозиториев GitHub: как работает проект, где что лежит.',
    category: 'Знания',
    runtime: 'remote',
    server: () => ({ url: 'https://mcp.deepwiki.com/mcp', title: 'DeepWiki: вопросы о репозиториях GitHub' }),
  },
  {
    id: 'context7',
    title: 'Context7',
    description: 'Свежая документация и примеры кода популярных библиотек.',
    category: 'Знания',
    runtime: 'remote',
    server: () => ({ url: 'https://mcp.context7.com/mcp', title: 'Context7: документация библиотек' }),
  },
  {
    id: 'brave-search',
    title: 'Поиск Brave',
    description: 'Поиск в интернете, новости, картинки и видео через Brave Search API.',
    category: 'Интернет',
    runtime: 'node',
    inputs: [
      {
        key: 'apiKey',
        label: 'Ключ Brave Search API',
        secret: true,
        required: true,
        link: 'https://api-dashboard.search.brave.com/app/keys',
      },
    ],
    server: ({ apiKey }) => ({
      command: 'npx',
      args: ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'],
      env: { BRAVE_API_KEY: apiKey },
      title: 'Поиск Brave: интернет, новости, картинки',
    }),
  },
  {
    id: 'playwright',
    title: 'Браузер (Playwright)',
    description: 'Открывает страницы, нажимает кнопки, заполняет формы — действует в браузере за вас.',
    category: 'Интернет',
    runtime: 'node',
    server: () => ({ command: 'npx', args: ['-y', '@playwright/mcp@latest'], title: 'Браузер: открыть страницу, нажать, заполнить' }),
  },
  {
    id: 'filesystem',
    title: 'Файлы',
    description: 'Чтение, поиск и правка файлов — только в папках, которые вы укажете.',
    category: 'Компьютер',
    runtime: 'node',
    inputs: [{ key: 'folders', label: 'Папки (через ;)', placeholder: 'C:\\Users\\вы\\Documents', required: true }],
    server: ({ folders }) => ({
      command: 'npx',
      args: [
        '-y',
        '@modelcontextprotocol/server-filesystem',
        ...String(folders)
          .split(';')
          .map((f) => f.trim())
          .filter(Boolean),
      ],
      title: 'Файлы в выбранных папках',
    }),
  },
  {
    id: 'memory',
    title: 'Граф знаний',
    description: 'Долгая память о людях, связях и фактах — дополняет мою память.',
    category: 'Знания',
    runtime: 'node',
    server: () => ({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], title: 'Граф знаний: люди, связи, факты' }),
  },
  {
    id: 'sequential-thinking',
    title: 'Пошаговое рассуждение',
    description: 'Помогает большой модели разбирать сложные задачи по шагам.',
    category: 'Знания',
    runtime: 'node',
    server: () => ({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], title: 'Пошаговое рассуждение' }),
  },
];

// Для окна: без функций
const catalogForWindow = () =>
  CATALOG.map(({ id, title, description, category, runtime, inputs = [] }) => ({
    id,
    title,
    description,
    category,
    runtime,
    inputs: inputs.map(({ key, label, placeholder, secret, required, link }) => ({ key, label, placeholder, secret, required, link })),
  }));

// Запись сервера из каталога по введённым значениям; ошибка — не заполнено обязательное
function serverFromCatalog(id, inputs = {}) {
  const entry = CATALOG.find((e) => e.id === id);
  if (!entry) throw new Error('Нет такого сервера в каталоге');
  for (const field of entry.inputs || []) {
    if (field.required && !String(inputs[field.key] ?? '').trim()) throw new Error(`Заполните: ${field.label}`);
  }
  return { ...entry.server(inputs), catalog: id };
}

module.exports = { CATALOG, catalogForWindow, serverFromCatalog };
