// Окно ассистента в трёх режимах: полное, компактная плашка в углу (не забирает фокус) и скрытое.
const { BrowserWindow, screen } = require('electron');

const FULL = { width: 400, height: 620 };
const ORB = { width: 380, height: 96 };
const ORB_MAX_SHARE = 0.6; // плашка с длинным текстом растёт вверх, но не выше этой доли экрана

function createWindowManager({ title, preload, html }) {
  let win = null;
  let mode = 'hidden';
  let fullBounds = null; // куда пользователь передвинул полное окно
  let orbHeight = ORB.height; // высота плашки под текущий текст; низ плашки не двигается

  function create() {
    win = new BrowserWindow({
      ...FULL,
      title,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true, // живёт в трее
      show: false,
      transparent: true, // в компактном режиме видны только реактор и подложка под текстом
      backgroundColor: '#00000000',
      webPreferences: {
        preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: false, // слушать микрофон, даже когда окно скрыто
      },
    });
    win.loadFile(html);
    win.on('moved', () => mode === 'full' && (fullBounds = win.getBounds()));
    win.on('closed', () => {
      win = null;
      mode = 'hidden';
    });
    return new Promise((resolve) => win.once('ready-to-show', resolve));
  }

  const area = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;

  // collapse: полное окно закрыли посреди диалога — свернуть его в плашку.
  // Без этого флага плашка не заменяет полное окно (оно уже на экране).
  function setMode(next, { collapse = false } = {}) {
    if (!win) return;
    if (next === 'hidden') {
      win.hide();
    } else if (next === 'orb') {
      if (mode === 'full' && !collapse) return; // полное окно уже на экране
      if (mode !== 'orb' || !win.isVisible()) placeOrb();
      win.showInactive();
      win.moveTop(); // поверх остальных окон, даже если другое окно тоже «всегда сверху»
    } else if (next === 'full') {
      if (mode !== 'full') {
        const a = area();
        win.setBounds(
          fullBounds || {
            ...FULL,
            x: Math.round(a.x + (a.width - FULL.width) / 2),
            y: Math.round(a.y + (a.height - FULL.height) / 2),
          },
        );
      }
      win.show();
      win.focus();
    }
    mode = next;
    send('jarvis:mode', mode);
  }

  function placeOrb() {
    const a = area();
    const h = Math.min(orbHeight, Math.round(a.height * ORB_MAX_SHARE));
    win.setBounds({ width: ORB.width, height: h, x: a.x + a.width - ORB.width - 16, y: a.y + a.height - h - 16 });
  }

  // Рендерер сообщает, сколько места нужно тексту в плашке
  function setOrbHeight(h) {
    const next = Math.max(ORB.height, Math.round(Number(h) || 0));
    if (!win || next === orbHeight) return;
    orbHeight = next;
    if (mode === 'orb') placeOrb();
  }

  function send(channel, ...args) {
    win?.webContents.send(channel, ...args);
  }

  return {
    create,
    setMode,
    setOrbHeight,
    send,
    mode: () => mode,
    isOurs: (e) => !!win && e.sender === win.webContents,
    webContents: () => win?.webContents,
  };
}

module.exports = { createWindowManager };
