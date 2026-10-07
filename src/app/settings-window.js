// Окно настроек — отдельное, как у компактных помощников в трее (Raycast, Alfred): основное окно остаётся
// разговором, а настроек много — им нужно место, боковая панель разделов и поиск (src/renderer/settings).
const { BrowserWindow } = require('electron');

const SIZE = { width: 860, height: 620, minWidth: 680, minHeight: 480 };
const BG = '#05090d'; // как --bg в shared/theme.css — без белой вспышки при открытии

// above() — основное окно закреплено поверх остальных: тогда и настройки поверх, иначе окажутся под ним
function createSettingsWindow({ title, preload, html, above = () => false }) {
  let win = null;

  // page — раздел (models, voice…): открыть сразу на нём или перейти, если окно уже открыто
  function open(page = '') {
    if (win) {
      if (page) win.webContents.send('jarvis:settings-page', page);
      if (win.isMinimized()) win.restore();
      win.setAlwaysOnTop(above(), 'floating');
      win.show();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      ...SIZE,
      title: `${title} — настройки`,
      alwaysOnTop: above(),
      show: false,
      backgroundColor: BG,
      autoHideMenuBar: true,
      // Своя шапка в стиле окна; кнопки окна рисует система (на Windows — поверх шапки, в её цветах)
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: BG, symbolColor: '#a6ecff', height: 40 },
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
    });
    win.loadFile(html, { hash: page });
    win.once('ready-to-show', () => win?.show());
    win.on('closed', () => (win = null));
  }

  return {
    open,
    send: (channel, ...args) => win?.webContents.send(channel, ...args),
    refreshLayer: () => win?.setAlwaysOnTop(above(), 'floating'), // основное окно закрепили или открепили
    isOurs: (e) => !!win && e.sender === win.webContents,
  };
}

module.exports = { createSettingsWindow };
