// Окно ассистента в четырёх режимах: полное, голограмма в углу (orb: не забирает фокус и клики мимо себя),
// свёрнутый куб (cube: маленький куб в углу вместо скрытого окна, если он включён) и скрытое.
// Полное — обычное окно: в панели задач, сворачивается, поверх остальных — только если его закрепили (pinned).
// Плашка всегда поверх: она маленькая и появляется на время ответа.
const { BrowserWindow, screen } = require('electron');

const FULL = { width: 400, height: 620 };
const ORB = { width: 440, height: 120 }; // голограмма (340 px) + луч и куб; высоту задаёт окно по голограмме
const CUBE = { width: 64, height: 64 };
const ORB_MAX_SHARE = 0.6; // плашка с длинным текстом растёт вверх, но не выше этой доли экрана

// orbOffset(workArea) — на сколько поднять плашку: в правом нижнем углу может стоять мини-плеер радио
// cube() — оставлять ли куб в углу, когда окно скрыто
function createWindowManager({ title, preload, html, pinned = false, orbOffset = () => 0, cube = () => false }) {
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
      alwaysOnTop: pinned,
      skipTaskbar: true, // скрытое и плашка живут в трее; полное окно — в панели задач (applyLayer)
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

  // Слой окна под режим: плашка — поверх всего и без кнопки в панели задач; полное — как обычное окно
  function applyLayer(next) {
    win.setAlwaysOnTop(next === 'orb' || next === 'cube' || pinned, 'floating');
    win.setSkipTaskbar(next !== 'full');
    if (next !== 'orb') setPassthrough(false); // сквозные клики — только у капсулы
  }

  // Капсула: прозрачная часть окна пропускает клики в программу под ним (окно при этом видит движение мыши —
  // так рендерер узнаёт, что мышь снова над капсулой, и выключает пропуск)
  let through = false;
  function setPassthrough(on) {
    const next = on === true && mode === 'orb';
    if (!win || next === through) return;
    through = next;
    win.setIgnoreMouseEvents(next, { forward: true });
  }

  const area = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;

  // collapse: полное окно закрыли посреди диалога — свернуть его в плашку.
  // Без этого флага плашка не заменяет полное окно (оно уже на экране).
  function setMode(next, { collapse = false } = {}) {
    if (!win) return;
    if (next === 'hidden' && cube()) next = 'cube'; // скрытое окно — куб в углу
    if (next === 'hidden') {
      win.hide();
      applyLayer('hidden');
    } else if (next === 'cube') {
      if (win.isMinimized()) win.restore();
      applyLayer('cube');
      placeCube();
      win.showInactive();
    } else if (next === 'orb') {
      const minimized = win.isMinimized();
      if (mode === 'full' && !collapse && !minimized) return; // полное окно уже на экране
      if (minimized) win.restore(); // свёрнутое окно отвечает плашкой в углу
      applyLayer('orb');
      if (mode !== 'orb' || minimized || !win.isVisible()) placeOrb();
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
      applyLayer('full');
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    mode = next;
    send('jarvis:mode', mode);
  }

  function placeCube() {
    const a = area();
    const lift = orbOffset(a);
    win.setBounds({ ...CUBE, x: a.x + a.width - CUBE.width - 6, y: a.y + a.height - CUBE.height - 6 - lift });
  }

  function placeOrb() {
    const a = area();
    const h = Math.min(orbHeight, Math.round(a.height * ORB_MAX_SHARE));
    const lift = orbOffset(a);
    // Капсула сама отступает от краёв окна на 12 px — окно почти вплотную к углу рабочей области
    win.setBounds({ width: ORB.width, height: h, x: a.x + a.width - ORB.width - 4, y: a.y + a.height - h - 4 - lift });
  }

  // Рендерер сообщает, сколько места нужно тексту в плашке
  function setOrbHeight(h) {
    const next = Math.max(ORB.height, Math.round(Number(h) || 0));
    if (!win || next === orbHeight) return;
    orbHeight = next;
    if (mode === 'orb') placeOrb();
  }

  // Закрепить полное окно поверх остальных
  function setPinned(on) {
    pinned = on === true;
    if (win && mode === 'full') applyLayer('full');
  }

  function minimize() {
    if (win && mode === 'full') win.minimize();
  }

  function send(channel, ...args) {
    win?.webContents.send(channel, ...args);
  }

  return {
    create,
    setMode,
    setOrbHeight,
    setPassthrough,
    send,
    mode: () => mode,
    tucked: () => mode === 'hidden' || mode === 'cube', // окна разговора не видно (или виден только куб)
    pinned: () => pinned,
    setPinned,
    minimize,
    isOurs: (e) => !!win && e.sender === win.webContents,
    webContents: () => win?.webContents,
  };
}

module.exports = { createWindowManager };
