// Точка входа: собирает ядро, голос и окно и связывает их через IPC. Логики ассистента здесь нет.
//   app/paths.js       — папка данных, config.json, папка моделей
//   app/services.js    — ядро: память, модели, навыки, ступени разбора, ассистент
//   app/voice.js       — микрофон, распознавание, имя, голоса людей, синтез
//   app/ask.js         — запрос из окна и его отмена
//   app/setup-flow.js  — первый запуск: скачать модели
//   app/settings.js    — настройки и горячая клавиша; app/settings-window.js — окно настроек
//   app/mcp.js         — подключения MCP: каталог, установка, свои серверы
//   app/models.js      — модели на компьютере (скачать, выбрать, удалить) и обновление llama.cpp
//   app/updates.js     — обновления отдельно скачанных частей: llama.cpp, быстрая модель, речь, голос, MCP
//   app/radio-player.js — мини-плеер радио в углу экрана
//   app/lifecycle.js   — запуск, трей, обновления, выход
const electron = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { loadConfig, ensureUserConfig } = require('./core/config');
const { createWindowManager } = require('./core/window');
const { resolveModelsDir, configFileFor } = require('./app/paths');
const { createIpc } = require('./app/ipc');
const { createSettingsWindow } = require('./app/settings-window');
const { createServices } = require('./app/services');
const { createVoice } = require('./app/voice');
const { createAsk } = require('./app/ask');
const { createSetupFlow } = require('./app/setup-flow');
const { createSettingsIpc, createHotkey } = require('./app/settings');
const { startLifecycle } = require('./app/lifecycle');
const { createMcpManager } = require('./app/mcp');
const { createModelManager } = require('./app/models');
const { createUpdatesManager } = require('./app/updates');
const { createRadioPlayer } = require('./app/radio-player');
const { createSecrets } = require('./core/secrets');
const pkg = require('../package.json');

const { app, globalShortcut } = electron;

// Папка данных одна и та же в разработке и в установленной версии на любой ОС (имя пакета, а не продукта).
// До requestSingleInstanceLock: блокировка второго экземпляра живёт в этой папке.
// ORION_DATA_DIR — своя папка (переносная установка, проверка сборки рядом с работающим Орионом).
app.setPath('userData', process.env.ORION_DATA_DIR || path.join(app.getPath('appData'), pkg.name));
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0); // дальше не идём: второй экземпляр не должен трогать настройки и модели
}

const root = path.join(__dirname, '..');
const dataDir = app.getPath('userData');
const packaged = app.isPackaged;
fs.mkdirSync(dataDir, { recursive: true });
const configFile = configFileFor({ packaged, root, dataDir, ensureUserConfig, isolated: !!process.env.ORION_DATA_DIR });
const config = loadConfig(configFile);
const modelsDir = resolveModelsDir({ config, packaged, root, dataDir, baseDir: packaged ? dataDir : root, execPath: process.execPath });

const ui = createWindowManager({
  title: config.name,
  preload: path.join(__dirname, 'preload.js'),
  html: path.join(__dirname, 'renderer', 'index.html'),
  pinned: config.pinned === true,
  orbOffset: (area) => radioPlayer?.orbOffset(area) || 0, // плашка — над мини-плеером, если он в том же углу
});
const settingsWindow = createSettingsWindow({
  title: config.name,
  preload: path.join(__dirname, 'preload.js'),
  html: path.join(__dirname, 'renderer', 'settings', 'index.html'),
  above: () => ui.pinned(),
});
const ipc = createIpc(ui, settingsWindow);

let settings = null; // создаются ниже; навыки сохраняют настройки уже после запуска
const services = createServices({ config, dataDir, modelsDir, ui, electron, saveSettings: (patch) => settings.saveAndShare(patch) });
const voice = createVoice({ app, config, modelsDir, dataDir, services, ui, ipc });
createAsk({ config, services, voice, ui, ipc });
// Ход установки — в оба окна: полоской в разговоре и в разделе «Компоненты» настроек
const setup = createSetupFlow({ config, modelsDir, services, voice, ui: { send: ipc.broadcast }, ipc });
const registerHotkey = createHotkey({ globalShortcut, config, ui });
// Ключи API и токены серверов MCP — в файле зашифрованы средствами системы (core/secrets.js). Расшифровка — когда
// приложение готово (на Linux хранилище ключей доступно только тогда) и до запуска серверов MCP, которым они нужны;
// ключи открытым текстом от прежних версий — заодно зашифровать
const secrets = createSecrets(electron.safeStorage);
settings = createSettingsIpc({
  app,
  config,
  configFile,
  modelsDir,
  services,
  voice,
  ui,
  settingsWindow,
  ipc,
  registerHotkey,
  secrets,
  onSaved: (patch) => 'radio.player.show' in patch && radioPlayer.refresh(),
});
app.whenReady().then(() => {
  secrets.openInto(config);
  if (settings.reseal()) services.audit({ settings: 'ключи зашифрованы' });
});
const radioPlayer = createRadioPlayer({
  preload: path.join(__dirname, 'preload.js'),
  html: path.join(__dirname, 'renderer', 'radio-player', 'index.html'),
  config,
  radio: services.radio,
  saveSettings: (patch) => settings.save(patch),
  audit: services.audit,
});
ipc.add(radioPlayer);
ipc.on('jarvis:radio-control', (msg) => radioPlayer.control(msg));
const mcp = createMcpManager({ config, dataDir, services, settings, ipc });
const models = createModelManager({ config, modelsDir, services, settings, ipc, dialog: electron.dialog });
const updates = createUpdatesManager({ config, modelsDir, services, settings, ipc, voice, models, mcp });
startLifecycle({ electron, config, services, voice, setup, mcp, updates, ui, settingsWindow, ipc, registerHotkey });
