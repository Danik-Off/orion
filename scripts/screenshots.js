// Скриншоты для README: настоящий интерфейс с придуманным разговором, без микрофона, модели и личных данных.
//   npm run screenshots   → docs/screenshots/*.png
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/core/config');
const { createSettings } = require('../src/core/settings');
const allSkills = require('../src/skills');
const { catalogForWindow } = require('../src/core/mcp-catalog');

const root = path.join(__dirname, '..');
const out = path.join(root, 'docs', 'screenshots');
// --orb-states <папка> — куда сложить кадры всех состояний голограммы
const orbOut = process.argv.includes('--orb-states')
  ? path.resolve(process.argv[process.argv.indexOf('--orb-states') + 1] || os.tmpdir())
  : out;
const SCALE = 2; // чёткие картинки на экранах с высокой плотностью
const FULL = { width: 400, height: 620 };
const ORB = { width: 440, height: 420 }; // окно голограммы; панель прижата к его низу
const SETTINGS = { width: 860, height: 620 };

app.commandLine.appendSwitch('force-device-scale-factor', '1'); // размер картинок не зависит от масштаба экрана
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'orion-shots-'))); // настоящие данные не трогаем

const config = loadConfig(path.join(root, 'config.json'));
config.name = 'Орион';
config.city = 'Москва';
const settings = createSettings({
  config,
  file: path.join(os.tmpdir(), 'orion-shots-config.json'),
  skills: allSkills,
  setHotkey: () => true,
});
const data = {
  settings: {
    name: 'Орион',
    model: config.model,
    version: `orionAssistent:${require('../package.json').version}(1a2b3c4)`,
    hotkey: 'CommandOrControl+Alt+J',
    stt: true,
    tts: true,
    listenOnStart: false, // микрофон в сценах только нарисован
    followUpSeconds: 7,
    echoCancellation: true,
    speaker: {
      available: true,
      people: [{ id: 'anna', name: 'Анна', honorific: 'мисс', threshold: 0.45, samples: 6 }],
      require: 'followup',
    },
    mode: 'full',
  },
  settingsGet: {
    values: settings.values(),
    skills: settings.skills(),
    models: [config.model],
    version: require('../package.json').version,
  },
  components: {
    stages: [
      { stage: 'voice', title: 'Голос', installed: true },
      { stage: 'hearing', title: 'Слух: распознавание речи и голосов', installed: true },
      { stage: 'router', title: 'Быстрые команды (маленькая модель)', installed: true },
      { stage: 'brain', title: 'Большая языковая модель', installed: false, size: '2,7 ГБ' },
    ],
    installing: false,
  },
  mcp: {
    catalog: catalogForWindow(),
    servers: [
      {
        name: 'exa',
        title: 'Поиск Exa',
        kind: 'remote',
        target: 'https://mcp.exa.ai/mcp',
        catalog: 'exa',
        package: false,
        trust: false,
        enabled: true,
        status: {
          state: 'ready',
          ms: 1141,
          tools: [
            {
              name: 'web_search_exa',
              title: 'Поиск в интернете',
              description: 'Ищет страницы и возвращает их текст',
              readOnly: true,
              enabled: true,
            },
            { name: 'web_fetch_exa', title: 'Чтение страницы', description: 'Текст страницы по адресу', readOnly: true, enabled: true },
          ],
        },
      },
      {
        name: 'memory',
        title: 'Граф знаний',
        kind: 'local',
        target: '@modelcontextprotocol/server-memory 2026.8.31',
        catalog: 'memory',
        package: true,
        trust: false,
        enabled: true,
        status: {
          state: 'sleeping',
          tools: [
            { name: 'create_entities', title: 'Create Entities', description: '', readOnly: false, enabled: true },
            { name: 'read_graph', title: 'Read Graph', description: '', readOnly: true, enabled: true },
            { name: 'search_nodes', title: 'Search Nodes', description: '', readOnly: true, enabled: true },
          ],
        },
      },
    ],
    node: true,
    uv: true,
  },
  updates: {
    checking: false,
    checkedAt: Date.parse('2026-10-08T12:00:00Z'),
    updates: 2,
    parts: [
      {
        id: 'llama',
        title: 'Движок llama.cpp',
        version: 'сборка b11205',
        latest: 'b11501',
        newer: true,
        busy: null,
        error: null,
        previous: null,
      },
      {
        id: 'router',
        title: 'Быстрая модель (orion-router)',
        version: 'версия v1',
        latest: null,
        newer: false,
        busy: null,
        error: null,
        previous: null,
      },
      {
        id: 'asr',
        title: 'Распознавание речи (быстрое)',
        version: 'версия от 16.08.2025',
        latest: null,
        newer: false,
        busy: null,
        error: null,
        previous: null,
      },
      {
        id: 'asr2',
        title: 'Распознавание речи (точное)',
        version: 'версия от 20.04.2025',
        latest: null,
        newer: false,
        busy: null,
        error: null,
        previous: null,
      },
      { id: 'tts', title: 'Голос', version: 'версия от 11.05.2026', latest: null, newer: false, busy: null, error: null, previous: null },
      {
        id: 'mcp',
        title: 'Подключения MCP',
        version: 'серверов из npm: 2',
        latest: 'memory 2026.9.30',
        newer: true,
        busy: { progress: 40 },
        error: null,
        previous: null,
      },
    ],
  },
  models: {
    backend: 'llamacpp',
    active: 'qwen3.5:4b',
    vram: { title: 'NVIDIA GeForce RTX 5070', size: '11,7 ГБ' },
    engine: {
      build: 'b11205',
      variant: 'win-vulkan-x64',
      installed: ['b11205'],
      previous: null,
      latest: { tag: 'b11500', date: '2026-10-08T12:37:22Z' },
      newer: true,
      checking: false,
      updating: null,
      error: null,
    },
    models: [
      {
        id: 'qwen3.5:4b',
        title: 'Qwen 3.5 4B',
        about: 'Лучший баланс скорости и ума · понимает 96% команд',
        tags: ['по умолчанию', 'рекомендую'],
        license: 'Apache 2.0',
        size: '2,7 ГБ',
        installed: true,
        active: true,
        custom: false,
        fits: 'gpu',
        downloading: null,
        error: null,
      },
      {
        id: 'qwen3.5:2b',
        title: 'Qwen 3.5 2B',
        about: 'Быстрая и нетребовательная · понимает 86% команд',
        tags: ['лёгкая'],
        license: 'Apache 2.0',
        size: '1,3 ГБ',
        installed: true,
        active: false,
        custom: false,
        fits: 'gpu',
        downloading: null,
        error: null,
      },
      {
        id: 'gemma4:e4b',
        title: 'Gemma 4 E4B',
        about: 'Модель Google: понимает почти как Qwen 4B, но медленнее',
        tags: [],
        license: 'Apache 2.0',
        size: '4,6 ГБ',
        installed: false,
        active: false,
        custom: false,
        fits: 'gpu',
        downloading: 42,
        error: null,
      },
      {
        id: 'yandexgpt5-lite:8b',
        title: 'YandexGPT 5 Lite',
        about: 'Модель Яндекса, обучена на русском · понимает 83% команд · 0,8 с',
        tags: ['русская'],
        license: 'YandexGPT-5-Lite',
        size: '4,9 ГБ',
        installed: false,
        active: false,
        custom: false,
        fits: 'gpu',
        downloading: null,
        error: null,
      },
      {
        id: 'gemma4:12b',
        title: 'Gemma 4 12B',
        about: 'Старшая Gemma 4 для мощной видеокарты',
        tags: [],
        license: 'Apache 2.0',
        size: '7,0 ГБ',
        installed: false,
        active: false,
        custom: false,
        fits: 'partial',
        downloading: null,
        error: null,
      },
    ],
  },
};
ipcMain.on('demo:data', (e) => (e.returnValue = data));

// Каждая сцена окна разговора начинается с чистого экрана: состояние контроллера (window.__orion) задаётся целиком
const BASE = `
  const o = window.__orion;
  const msg = (kind, text, cards, who) => ({ id: Math.random(), kind, text, cards, who });
  o.debugSet({ mode: 'full', core: 'idle', micOn: true, stt: true, peopleAvailable: true, hasPeople: true, voiceOn: true,
    messages: [], showHints: true, panel: null, confirm: null, alarm: null, holoCards: null, caption: '', status: '',
    statusHint: false, schedule: [], follow: null, holo: 'open', setup: null });
`;
// Карточки — как их отдают навыки погоды и напоминаний
const WEATHER_CARD = {
  type: 'weather',
  city: 'Москва',
  now: { temp: 11, feels: null, desc: 'в основном ясно', icon: 'clear', wind: 3 },
  days: [
    { label: 'Сегодня', min: 7, max: 16, icon: 'partly', rain: 10 },
    { label: 'Завтра', min: 8, max: 14, icon: 'rain', rain: 70 },
    { label: 'Вс 12', min: 5, max: 12, icon: 'cloud', rain: 20 },
    { label: 'Пн 13', min: 4, max: 13, icon: 'clear', rain: 0 },
  ],
};
const timerCard = (min, label) => ({ type: 'timer', id: 't1', kind: 'timer', at: Date.now() + min * 60_000 - 18_000, label });
const ALARM = { type: 'timer', id: 'r2', kind: 'alarm', at: Date.parse('2026-10-12T07:00:00'), label: 'Будильник', repeat: 'по будням' };
const J = JSON.stringify;

const SCENES = [
  {
    file: '01-start.png',
    size: FULL,
    script: `${BASE} o.debugSet({ status: 'Скажите «Орион…» или нажмите Ctrl + Alt + J', statusHint: true, schedule: [${J(ALARM)}] });`,
  },
  {
    file: '02-conversation.png',
    size: FULL,
    script: `${BASE}
      o.debugSet({ core: 'speaking', caption: 'Напомню через десять минут, мисс.', messages: [
        msg('user', 'Какая погода?'),
        msg('bot', 'Сейчас в Москве плюс одиннадцать, в основном ясно. Днём до плюс шестнадцати.', [${J(WEATHER_CARD)}]),
        msg('user', 'Напомни через десять минут выключить чайник'),
        msg('bot', 'Напомню через десять минут: выключить чайник.', [${J(timerCard(10, 'выключить чайник'))}]),
      ], schedule: [${J(timerCard(10, 'выключить чайник'))}, ${J(ALARM)}] });`,
  },
  {
    file: '03-confirm.png',
    size: FULL,
    script: `${BASE}
      o.debugSet({ core: 'ask', caption: 'Выключить компьютер через минуту?', confirm: { text: 'Выключить компьютер через минуту?' }, messages: [
        msg('user', 'Включи что-нибудь спокойное'), msg('bot', 'Включаю спокойную музыку, мисс.'), msg('user', 'Выключи компьютер через минуту'),
      ] });`,
  },
  {
    file: '04-voice.png',
    size: FULL,
    script: `${BASE}
      o.debugSet({ core: 'listening', showHints: false, panel: { modal: false, field: null, buttons: [{ label: 'Отмена', run() {} }],
        text: 'Фраза 1 из 4. Скажите обычным голосом:\\n«Орион, какая сегодня погода и что у меня в планах?»\\nГоворите так, как обычно обращаетесь ко мне, — с того места, где обычно сидите.' } });`,
  },
  {
    file: '05-settings.png',
    size: SETTINGS,
    page: 'settings', // отдельное окно настроек: раздел «Модели»
    script: `location.hash = 'models';`,
    wait: 800,
  },
  {
    file: '09-components.png',
    size: SETTINGS,
    page: 'settings', // раздел «Компоненты»: установленное и обновления
    script: `location.hash = 'components'; await new Promise((r) => setTimeout(r, 400)); document.querySelector('.content').scrollTop = 400;`,
    wait: 800,
  },
  {
    file: '08-library.png',
    size: SETTINGS,
    page: 'settings', // раздел «Модели на компьютере»
    script: `location.hash = 'library';`,
    wait: 800,
  },
  {
    file: '07-connections.png',
    size: SETTINGS,
    page: 'settings', // раздел «Подключения»: магазин MCP-серверов
    script: `location.hash = 'connections'; await new Promise((r) => setTimeout(r, 400)); [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Инструменты'))?.click();`,
    wait: 800,
  },
  // Голограмма в углу: кладётся на условный рабочий стол (desktop). Для README — ответ с карточкой;
  // остальные состояния — только с флагом --orb-states (проверка дизайна, в docs не попадают)
  orbScene(
    '06-corner.png',
    `o.debugSet({ core: 'speaking', caption: 'Сейчас в Москве плюс одиннадцать, в основном ясно.', holoCards: [${J(WEATHER_CARD)}] });`,
  ),
  ...(process.argv.includes('--orb-states')
    ? [
        orbScene('orb-1-listening.png', `o.debugSet({ core: 'listening' });`),
        orbScene(
          'orb-2-hearing.png',
          `o.debugSet({ core: 'hearing', caption: '…и сделай чуть погромче, пожалуйста, а то ничего не слышно на кухне' });`,
        ),
        orbScene('orb-3-thinking.png', `o.debugSet({ core: 'thinking', caption: 'какая погода на выходных' });`),
        orbScene(
          'orb-4-confirm.png',
          `o.debugSet({ core: 'ask', caption: 'Выключить компьютер через минуту? Скажите «да» или «нет».', confirm: { text: 'Выключить компьютер через минуту?' } });`,
        ),
        orbScene(
          'orb-5-timer.png',
          `o.debugSet({ core: 'idle', caption: 'Напомню через 10 минут: выключить чайник.', holoCards: [${J(timerCard(10, 'выключить чайник'))}] });`,
        ),
        orbScene('orb-6-follow.png', `o.debugSet({ core: 'listening', caption: 'Сейчас +11°, ясно.', follow: { key: 1, ms: 7000 } });`),
        orbScene(
          'orb-7-long.png',
          `o.debugSet({ core: 'speaking', caption: 'Гагарин — первый человек в космосе. Двенадцатого апреля тысяча девятьсот шестьдесят первого года он облетел Землю на корабле «Восток-1» за сто восемь минут и благополучно приземлился в Саратовской области. После полёта он стал всемирно известен.' });`,
        ),
        orbScene(
          'orb-8-error.png',
          `o.debugSet({ core: 'error', caption: 'Нет связи с интернетом. Таймеры, будильник и громкость работают и без сети.' });`,
        ),
        {
          file: 'orb-0-cube.png',
          desktop: true,
          size: { width: 64, height: 64 },
          script: `${BASE} o.debugSet({ mode: 'cube', core: 'idle' });`,
        },
        {
          file: 'orb-9-radio.png', // мини-плеер радио
          page: 'settings',
          html: path.join(root, 'src', 'ui', 'dist', 'radio-player.html'),
          desktop: true,
          size: { width: 380, height: 64 },
          script: `demo.emit('radioPlayer', { playing: true, name: 'Радио Маяк', song: 'Кино — Группа крови', volume: 0.7 });`,
        },
      ]
    : []),
];

// Сцена голограммы: окно в режиме orb; desktop — положить кадр на рабочий стол
function orbScene(file, script) {
  return {
    file,
    desktop: true,
    size: ORB,
    script: `${BASE}
      o.debugSet({ mode: 'orb', holo: 'open' });
      ${script}`,
  };
}

// Окно настроек — своё: сцена с page: 'settings'
async function shootSettings(scene) {
  const w = new BrowserWindow({
    width: scene.size.width * SCALE,
    height: scene.size.height * SCALE,
    show: false,
    transparent: !!scene.html, // мини-плеер — прозрачное окно с капсулой
    backgroundColor: scene.html ? '#00000000' : '#05090d',
    webPreferences: { preload: path.join(__dirname, 'screenshots-preload.js'), contextIsolation: true, sandbox: true, offscreen: true },
  });
  await w.loadFile(scene.html || path.join(root, 'src', 'ui', 'dist', 'settings.html'));
  w.webContents.setZoomFactor(SCALE);
  await new Promise((r) => setTimeout(r, 400));
  await w.webContents.executeJavaScript(`(async () => { ${scene.script} })()`);
  await new Promise((r) => setTimeout(r, scene.wait || 500));
  const png = (await w.webContents.capturePage()).toPNG();
  w.destroy();
  return png;
}

// Сцены окна разговора — в одном окне: каждая начинает с чистого состояния (BASE)
let win = null;
async function shoot(scene) {
  if (scene.page === 'settings') return shootSettings(scene);
  if (!win) {
    win = new BrowserWindow({
      width: scene.size.width * SCALE,
      height: scene.size.height * SCALE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'screenshots-preload.js'), contextIsolation: true, sandbox: true, offscreen: true },
    });
    await win.loadFile(path.join(root, 'src', 'ui', 'dist', 'index.html'));
    win.webContents.setZoomFactor(SCALE);
    await new Promise((r) => setTimeout(r, 400)); // applySettings в окне
  }
  win.setContentSize(scene.size.width * SCALE, scene.size.height * SCALE);
  await win.webContents.executeJavaScript(`(async () => { ${scene.script} })()`);
  await new Promise((r) => setTimeout(r, scene.wait || 500));
  return (await win.webContents.capturePage()).toPNG();
}

// Плашка в правом нижнем углу условного рабочего стола — так она выглядит поверх других окон
async function desktop(orbPng, size = ORB) {
  const W = 900;
  const H = 520;
  const html = `<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;font-family:Segoe UI,sans-serif;
    background:linear-gradient(135deg,#2b5876 0%,#4e4376 55%,#1f2a44 100%)">
    <div style="position:absolute;left:60px;top:50px;width:440px;height:300px;border-radius:10px;background:#f5f6f8;
      box-shadow:0 20px 50px rgba(0,0,0,.35);overflow:hidden">
      <div style="height:34px;background:#e3e6ea"></div>
      <div style="padding:26px 30px;color:#9aa3ad;font-size:15px;line-height:2">
        <div style="height:14px;width:70%;background:#dde1e6;border-radius:7px;margin-bottom:16px"></div>
        <div style="height:14px;width:90%;background:#e6e9ed;border-radius:7px;margin-bottom:16px"></div>
        <div style="height:14px;width:80%;background:#e6e9ed;border-radius:7px;margin-bottom:16px"></div>
        <div style="height:14px;width:55%;background:#e6e9ed;border-radius:7px"></div>
      </div>
    </div>
    <img src="data:image/png;base64,${orbPng.toString('base64')}"
      style="position:absolute;right:16px;bottom:${48 + 16}px;width:${size.width}px;height:${size.height}px">
    <div style="position:absolute;left:0;right:0;bottom:0;height:48px;background:rgba(20,24,32,.85)"></div>
  </body></html>`;
  const canvas = new BrowserWindow({ width: W * SCALE, height: H * SCALE, show: false, webPreferences: { offscreen: true } });
  await canvas.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  canvas.webContents.setZoomFactor(SCALE);
  await new Promise((r) => setTimeout(r, 300));
  const image = await canvas.webContents.capturePage();
  canvas.destroy();
  return image.toPNG();
}

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  try {
    for (const scene of SCENES) {
      const png = await shoot(scene);
      const dir = scene.file.startsWith('orb-') ? orbOut : out;
      fs.writeFileSync(path.join(dir, scene.file), scene.desktop ? await desktop(png, scene.size) : png);
      console.log('готово:', scene.file);
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
