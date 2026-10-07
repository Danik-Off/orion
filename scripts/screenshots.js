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
    version: `orionAssistent:${require('../package.json').version}(1a2b3c4)`,
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
        name: 'deepwiki',
        title: 'DeepWiki: вопросы о репозиториях GitHub',
        kind: 'remote',
        target: 'https://mcp.deepwiki.com/mcp',
        catalog: 'deepwiki',
        trust: false,
        enabled: true,
        status: { ok: true, tools: ['read_wiki_structure', 'read_wiki_contents', 'ask_question'] },
      },
    ],
    node: true,
    restart: false,
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
    file: '07-connections.png',
    size: SETTINGS,
    page: 'settings', // раздел «Подключения»: магазин MCP-серверов
    script: `location.hash = 'connections';`,
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
