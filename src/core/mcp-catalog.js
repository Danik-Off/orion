// Каталог MCP-серверов, которые ставятся одной кнопкой (Настройки → «Подключения»).
// Только проверенные: официальные серверы протокола и сервисов. Пакеты сверены с npm, удалённые серверы —
// подключением (список инструментов получен) 2026-10-08.
//
// Сервер: { id, title, description, category, keywords — русские слова, по которым фраза уходит этому серверу
//   (большой модели: маленькая инструменты MCP не знает), runtime, inputs — что спросить при установке, link — сайт }
//   runtime 'remote' — по HTTP: url, headers(inputs)
//   runtime 'node'   — пакет npm: package, bin, args(inputs), env(inputs). Ставится один раз в папку данных
//                      и запускается напрямую через node (без npx и обращения к npm при каждом запуске)
//   runtime 'python' — пакет PyPI через uvx: package, args(inputs), env(inputs)
// inputs: [{ key, label, placeholder?, secret?, required?, link? }]
// readOnly: true — сервер только ищет и читает (поиск, документация): его инструменты выполняются без вопроса,
//   даже если сам сервер не пометил их «только чтение»; серверы, которые что-то меняют, — с разрешения

const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
const folders = (s) =>
  String(s || '')
    .split(';')
    .map((f) => f.trim())
    .filter(Boolean);

const CATALOG = [
  // --- Интернет ---
  {
    id: 'exa',
    readOnly: true,
    title: 'Поиск Exa',
    description: 'Поиск в интернете и чтение найденных страниц — без ключа и регистрации.',
    category: 'Интернет',
    runtime: 'remote',
    url: 'https://mcp.exa.ai/mcp',
    keywords: ['exa', 'поищи в сети', 'найди в сети'],
    link: 'https://exa.ai',
  },
  {
    id: 'brave-search',
    readOnly: true,
    title: 'Поиск Brave',
    description: 'Поиск в интернете, новости, картинки и видео через Brave Search API.',
    category: 'Интернет',
    runtime: 'node',
    package: '@brave/brave-search-mcp-server',
    bin: 'brave-search-mcp-server',
    args: () => ['--transport', 'stdio'],
    env: ({ apiKey }) => ({ BRAVE_API_KEY: apiKey }),
    inputs: [
      {
        key: 'apiKey',
        label: 'Ключ Brave Search API',
        secret: true,
        required: true,
        link: 'https://api-dashboard.search.brave.com/app/keys',
      },
    ],
    keywords: ['brave', 'брейв'],
  },
  {
    id: 'tavily',
    readOnly: true,
    title: 'Поиск Tavily',
    description: 'Поиск с готовыми выжимками ответов, извлечение текста страниц.',
    category: 'Интернет',
    runtime: 'node',
    package: 'tavily-mcp',
    bin: 'tavily-mcp',
    env: ({ apiKey }) => ({ TAVILY_API_KEY: apiKey }),
    inputs: [{ key: 'apiKey', label: 'Ключ Tavily', secret: true, required: true, link: 'https://app.tavily.com' }],
    keywords: ['tavily', 'тавили'],
  },
  {
    id: 'firecrawl',
    readOnly: true,
    title: 'Firecrawl',
    description: 'Читает сайты целиком: страницы, обход разделов, извлечение данных.',
    category: 'Интернет',
    runtime: 'node',
    package: 'firecrawl-mcp',
    bin: 'firecrawl-mcp',
    env: ({ apiKey }) => ({ FIRECRAWL_API_KEY: apiKey }),
    inputs: [{ key: 'apiKey', label: 'Ключ Firecrawl', secret: true, required: true, link: 'https://www.firecrawl.dev/app/api-keys' }],
    keywords: ['firecrawl', 'сайт целиком', 'обойди сайт'],
  },
  {
    id: 'fetch',
    readOnly: true,
    title: 'Чтение страниц',
    description: 'Открывает страницу по адресу и пересказывает её. Официальный сервер протокола.',
    category: 'Интернет',
    runtime: 'python',
    package: 'mcp-server-fetch',
    keywords: ['страниц', 'по ссылке', 'по адресу'],
  },
  {
    id: 'playwright',
    title: 'Браузер (Playwright)',
    description: 'Открывает страницы, нажимает кнопки, заполняет формы — действует в браузере за вас.',
    category: 'Интернет',
    runtime: 'node',
    package: '@playwright/mcp',
    bin: 'playwright-mcp',
    keywords: ['в браузере', 'заполни форму', 'нажми на сайте', 'playwright'],
  },
  {
    id: 'youtube-transcript',
    readOnly: true,
    title: 'Субтитры YouTube',
    description: 'Текст ролика по ссылке — чтобы пересказать, о чём видео.',
    category: 'Интернет',
    runtime: 'node',
    package: '@kimtaeyoon83/mcp-server-youtube-transcript',
    bin: 'mcp-server-youtube-transcript',
    keywords: ['субтитр', 'о чем видео', 'о чем ролик', 'перескажи видео', 'перескажи ролик'],
  },

  // --- Знания ---
  {
    id: 'deepwiki',
    readOnly: true,
    title: 'DeepWiki',
    description: 'Ответы по устройству открытых репозиториев GitHub: как работает проект, где что лежит.',
    category: 'Знания',
    runtime: 'remote',
    url: 'https://mcp.deepwiki.com/mcp',
    keywords: ['deepwiki', 'репозитори', 'github'],
  },
  {
    id: 'context7',
    readOnly: true,
    title: 'Context7',
    description: 'Свежая документация и примеры кода популярных библиотек.',
    category: 'Знания',
    runtime: 'remote',
    url: 'https://mcp.context7.com/mcp',
    keywords: ['context7', 'документаци', 'библиотек'],
  },
  {
    id: 'mslearn',
    readOnly: true,
    title: 'Microsoft Learn',
    description: 'Официальная документация Microsoft: Windows, Office, Azure, .NET — поиск и примеры кода.',
    category: 'Знания',
    runtime: 'remote',
    url: 'https://learn.microsoft.com/api/mcp',
    keywords: ['microsoft', 'майкрософт', 'azure', 'windows', 'виндовс'],
  },
  {
    id: 'huggingface',
    readOnly: true,
    title: 'Hugging Face',
    description: 'Модели, наборы данных, статьи и приложения Hugging Face.',
    category: 'Знания',
    runtime: 'remote',
    url: 'https://huggingface.co/mcp',
    headers: ({ token }) => bearer(token),
    inputs: [{ key: 'token', label: 'Токен (необязательно)', secret: true, link: 'https://huggingface.co/settings/tokens' }],
    keywords: ['hugging', 'хаггинг', 'нейросет', 'датасет'],
  },
  {
    id: 'aws-docs',
    readOnly: true,
    title: 'Документация AWS',
    description: 'Документация и доступность сервисов Amazon Web Services.',
    category: 'Знания',
    runtime: 'remote',
    url: 'https://knowledge-mcp.global.api.aws',
    keywords: ['aws', 'amazon', 'амазон'],
  },
  {
    id: 'cloudflare-docs',
    readOnly: true,
    title: 'Документация Cloudflare',
    description: 'Поиск по документации Cloudflare.',
    category: 'Знания',
    runtime: 'remote',
    url: 'https://docs.mcp.cloudflare.com/mcp',
    keywords: ['cloudflare', 'клаудфлер'],
  },
  {
    id: 'memory',
    title: 'Граф знаний',
    description: 'Долгая память о людях, связях и фактах — дополняет мою память.',
    category: 'Знания',
    runtime: 'node',
    package: '@modelcontextprotocol/server-memory',
    bin: 'mcp-server-memory',
    keywords: ['граф знаний', 'связи между'],
  },
  {
    id: 'sequential-thinking',
    readOnly: true,
    title: 'Пошаговое рассуждение',
    description: 'Помогает большой модели разбирать сложные задачи по шагам.',
    category: 'Знания',
    runtime: 'node',
    package: '@modelcontextprotocol/server-sequential-thinking',
    bin: 'mcp-server-sequential-thinking',
    keywords: ['по шагам', 'пошагово', 'обдумай'],
  },

  // --- Сервисы ---
  {
    id: 'github',
    title: 'GitHub',
    description: 'Репозитории, задачи, запросы на слияние, код — ваш аккаунт GitHub.',
    category: 'Сервисы',
    runtime: 'remote',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: ({ token }) => bearer(token),
    inputs: [
      { key: 'token', label: 'Токен GitHub', secret: true, required: true, link: 'https://github.com/settings/personal-access-tokens' },
    ],
    keywords: ['github', 'гитхаб', 'пулл', 'pull request', 'issue', 'ишью'],
  },
  {
    id: 'notion',
    title: 'Notion',
    description: 'Страницы и базы Notion: найти, прочитать, дописать.',
    category: 'Сервисы',
    runtime: 'node',
    package: '@notionhq/notion-mcp-server',
    bin: 'notion-mcp-server',
    env: ({ token }) => ({ NOTION_TOKEN: token }),
    inputs: [
      { key: 'token', label: 'Токен интеграции Notion', secret: true, required: true, link: 'https://www.notion.so/profile/integrations' },
    ],
    keywords: ['notion', 'ноушн', 'ноушен'],
  },
  {
    id: 'obsidian',
    title: 'Obsidian',
    description: 'Заметки Obsidian: найти, прочитать, дописать. Нужен плагин Local REST API.',
    category: 'Сервисы',
    runtime: 'node',
    package: 'obsidian-mcp-server',
    bin: 'obsidian-mcp-server',
    env: ({ apiKey, url }) => ({ OBSIDIAN_API_KEY: apiKey, ...(url && { OBSIDIAN_BASE_URL: url }) }),
    inputs: [
      {
        key: 'apiKey',
        label: 'Ключ Local REST API',
        secret: true,
        required: true,
        link: 'https://github.com/coddingtonbear/obsidian-local-rest-api',
      },
      { key: 'url', label: 'Адрес (необязательно)', placeholder: 'http://127.0.0.1:27123' },
    ],
    keywords: ['obsidian', 'обсидиан'],
  },

  // --- Дом и компьютер ---
  {
    id: 'home-assistant',
    title: 'Home Assistant',
    description: 'Устройства и сценарии умного дома через встроенный MCP-сервер Home Assistant.',
    category: 'Дом и компьютер',
    runtime: 'remote',
    url: ({ url }) => `${String(url || '').replace(/\/+$/, '')}/api/mcp`,
    headers: ({ token }) => bearer(token),
    inputs: [
      { key: 'url', label: 'Адрес Home Assistant', placeholder: 'http://homeassistant.local:8123', required: true },
      {
        key: 'token',
        label: 'Долгосрочный токен',
        secret: true,
        required: true,
        link: 'https://www.home-assistant.io/integrations/mcp_server/',
      },
    ],
    keywords: ['home assistant', 'хоум ассистант', 'умный дом'],
  },
  {
    id: 'filesystem',
    title: 'Файлы',
    description: 'Чтение, поиск и правка файлов — только в папках, которые вы укажете.',
    category: 'Дом и компьютер',
    runtime: 'node',
    package: '@modelcontextprotocol/server-filesystem',
    bin: 'mcp-server-filesystem',
    args: ({ folders: f }) => folders(f),
    inputs: [{ key: 'folders', label: 'Папки (через ;)', placeholder: 'C:\\Users\\вы\\Documents', required: true }],
    keywords: ['в файле', 'в папке', 'файлы в'],
  },
];

// Для окна: без функций
const catalogForWindow = () =>
  CATALOG.map(({ id, title, description, category, runtime, link, inputs = [] }) => ({
    id,
    title,
    description,
    category,
    runtime,
    link,
    inputs: inputs.map(({ key, label, placeholder, secret, required, link: l }) => ({
      key,
      label,
      placeholder,
      secret,
      required,
      link: l,
    })),
  }));

const valueOf = (v, inputs) => (typeof v === 'function' ? v(inputs) : v);

// Запись сервера из каталога по введённым значениям; ошибка — не заполнено обязательное.
// Для 'node' — package/bin (ставит app/mcp.js); запасной запуск — через npx
function serverFromCatalog(id, inputs = {}) {
  const entry = CATALOG.find((e) => e.id === id);
  if (!entry) throw new Error('Нет такого сервера в каталоге');
  const values = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, String(v ?? '').trim()]));
  for (const field of entry.inputs || []) {
    if (field.required && !values[field.key]) throw new Error(`Заполните: ${field.label}`);
  }
  const base = { title: entry.title, catalog: id, keywords: entry.keywords || [], ...(entry.readOnly && { readOnly: true }) };
  const env = valueOf(entry.env, values);
  const args = valueOf(entry.args, values) || [];
  if (entry.runtime === 'remote') {
    const headers = valueOf(entry.headers, values);
    return { ...base, url: valueOf(entry.url, values), ...(headers && Object.keys(headers).length && { headers }) };
  }
  if (entry.runtime === 'python') return { ...base, command: 'uvx', args: [entry.package, ...args], ...(env && { env }) };
  return { ...base, package: entry.package, bin: entry.bin, command: 'npx', args: ['-y', entry.package, ...args], ...(env && { env }) };
}

module.exports = { CATALOG, catalogForWindow, serverFromCatalog };
