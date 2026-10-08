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
const SCALE = 2; // чёткие картинки на экранах с высокой плотностью
const FULL = { width: 400, height: 620 };
const ORB = { width: 380, height: 120 };
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

// Общее начало каждой сцены: чистое окно, микрофон включён, человек записан
const BASE = `
  clearLog(); caption.textContent = ''; hidePanel(); document.querySelector('#confirm').hidden = true;
  wizard = null;
  micBtn.hidden = false; micBtn.classList.add('on'); micBtn.querySelector('use').setAttribute('href', '#i-mic');
  peopleBtn.hidden = false; peopleBtn.classList.add('on');
  mode = 'full'; document.body.className = 'mode-full';
  core.dataset.state = 'idle';
`;
const talk = (pairs) =>
  pairs.map(([user, bot]) => `addMsg('user', ${JSON.stringify(user)}); addMsg('bot', ${JSON.stringify(bot)});`).join('\n');

const SCENES = [
  {
    file: '01-start.png',
    size: FULL,
    script: `${BASE} setStatus('Скажите «Орион…» или нажмите Ctrl+Alt+J', true);`,
  },
  {
    file: '02-conversation.png',
    size: FULL,
    script: `${BASE}
      ${talk([
        [
          'Какая погода?',
          'Сейчас в Москве плюс одиннадцать градусов, в основном ясно. Днём до плюс шестнадцати, ветер три метра в секунду.',
        ],
        ['Напомни через десять минут выключить чайник', 'Напомню через десять минут, мисс.'],
      ])}
      setStatus(''); caption.textContent = 'Напомню через десять минут, мисс.'; core.dataset.state = 'speaking';`,
  },
  {
    file: '03-confirm.png',
    size: FULL,
    script: `${BASE}
      ${talk([['Включи что-нибудь спокойное', 'Включаю спокойную музыку, мисс.']])}
      addMsg('user', 'Выключи компьютер через минуту');
      setStatus(''); caption.textContent = '';
      document.querySelector('#confirm-text').textContent = 'Выключить компьютер через минуту?';
      document.querySelector('#confirm').hidden = false; core.dataset.state = 'listening';`,
  },
  {
    file: '04-voice.png',
    size: FULL,
    script: `${BASE}
      hints.hidden = true;
      wizard = { stage: 'phrases', step: 0, needed: 4, heard: [], phrases: [
        'Орион, какая сегодня погода и что у меня в планах?',
        'Орион, включи, пожалуйста, какую-нибудь спокойную музыку.',
        'Орион, напомни мне через десять минут проверить почту.',
        'Орион, расскажи что-нибудь интересное про космос.'] };
      promptPhrase(); core.dataset.state = 'listening'; setStatus('');`,
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
    script: `location.hash = 'components'; await new Promise((r) => setTimeout(r, 300)); document.querySelector('#content').scrollTop = 400;`,
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
    script: `location.hash = 'connections'; await new Promise((r) => setTimeout(r, 300)); document.querySelector('.mcp-tools') || [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Инструменты'))?.click();`,
    wait: 800,
  },
  {
    file: 'orb.png', // промежуточный кадр: плашка кладётся на рабочий стол (06-corner.png)
    size: ORB,
    script: `${BASE}
      mode = 'orb'; document.body.className = 'mode-orb'; setStatus('');
      caption.textContent = 'Напомню через десять минут, мисс.'; core.dataset.state = 'speaking';`,
  },
];

// Окно настроек — своё: сцена с page: 'settings'
async function shootSettings(scene) {
  const w = new BrowserWindow({
    width: scene.size.width * SCALE,
    height: scene.size.height * SCALE,
    show: false,
    backgroundColor: '#05090d',
    webPreferences: { preload: path.join(__dirname, 'screenshots-preload.js'), contextIsolation: true, sandbox: true, offscreen: true },
  });
  await w.loadFile(path.join(root, 'src', 'renderer', 'settings', 'index.html'));
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
    await win.loadFile(path.join(root, 'src', 'renderer', 'index.html'));
    win.webContents.setZoomFactor(SCALE);
    await new Promise((r) => setTimeout(r, 400)); // applySettings в окне
  }
  win.setContentSize(scene.size.width * SCALE, scene.size.height * SCALE);
  await win.webContents.executeJavaScript(`(async () => { ${scene.script} })()`);
  await new Promise((r) => setTimeout(r, scene.wait || 500));
  return (await win.webContents.capturePage()).toPNG();
}

// Плашка в правом нижнем углу условного рабочего стола — так она выглядит поверх других окон
async function desktop(orbPng) {
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
      style="position:absolute;right:16px;bottom:${48 + 16}px;width:${ORB.width}px;height:${ORB.height}px">
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
      if (scene.file === 'orb.png') fs.writeFileSync(path.join(out, '06-corner.png'), await desktop(png));
      else fs.writeFileSync(path.join(out, scene.file), png);
      console.log('готово:', scene.file === 'orb.png' ? '06-corner.png' : scene.file);
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
