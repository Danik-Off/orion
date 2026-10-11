// Окно ассистента в четырёх режимах: полное, голограмма в углу (orb: не забирает фокус и клики мимо себя),
// свёрнутый шар (cube: маленький шар в углу вместо скрытого окна, если он включён) и скрытое.
// Полное — обычное окно: в панели задач, сворачивается, поверх остальных — только если его закрепили (pinned).
// Плашка всегда поверх: она маленькая и появляется на время ответа.
// taskbar() — кнопка в панели задач Windows и в свёрнутом виде: щелчок по ней открывает окно, на кнопке — точка
// цвета состояния (слушаю, думаю, жду «да/нет»), как у шара.
const { BrowserWindow, screen, nativeImage } = require('electron');

const FULL = { width: 400, height: 620 };
const FULL_MIN = { width: 360, height: 480 }; // меньше — шапка и строка ввода не помещаются
const ORB = { width: 440, height: 120 }; // голограмма (340 px) + луч и шар; высоту задаёт окно по голограмме
const CUBE = { width: 64, height: 64 };
const ORB_MAX_SHARE = 0.6; // плашка с длинным текстом растёт вверх, но не выше этой доли экрана
const EDGE = 4; // отступ окна от угла рабочей области — общий для шара и голограммы: шар не прыгает
const REVEAL_MS = 150; // окно не ответило «нарисовал» — всё равно показать

// orbOffset(workArea) — на сколько поднять плашку: в правом нижнем углу может стоять мини-плеер радио
// cube() — оставлять ли шар в углу, когда окно скрыто
// icon — значок окна (кнопка в панели задач) при запуске из исходников; у установленного — значок программы
function createWindowManager({
  title,
  preload,
  html,
  icon = undefined,
  pinned = false,
  orbOffset = () => 0,
  cube = () => false,
  taskbar = () => false,
}) {
  let win = null;
  let mode = 'hidden';
  let fullBounds = null; // куда пользователь передвинул полное окно
  let orbHeight = ORB.height; // высота плашки под текущий текст; низ плашки не двигается
  let revealTimer = null;

  function create() {
    win = new BrowserWindow({
      ...FULL,
      title,
      ...(icon && { icon }),
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
    // Щелчок по кнопке в панели задач, пока Орион свёрнут, — открыть окно. Фокус от щелчка по самому шару или
    // голограмме (мышь над окном) — не то: там свои кнопки
    win.on('focus', () => {
      if (mode !== 'cube' && mode !== 'orb') return;
      const p = screen.getCursorScreenPoint();
      const b = win.getBounds();
      const over = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
      if (!over) setMode('full');
    });
    win.on('resized', () => mode === 'full' && (fullBounds = win.getBounds()));
    win.on('closed', () => {
      win = null;
      mode = 'hidden';
    });
    return new Promise((resolve) => win.once('ready-to-show', resolve));
  }

  // Слой окна под режим: плашка — поверх всего и без кнопки в панели задач; полное — как обычное окно
  function applyLayer(next) {
    win.setAlwaysOnTop(next === 'orb' || next === 'cube' || pinned, 'floating');
    // Размер меняется только у полного окна; голограмма и шар подстраиваются сами
    win.setResizable(next === 'full');
    win.setMinimumSize(next === 'full' ? FULL_MIN.width : 1, next === 'full' ? FULL_MIN.height : 1);
    win.setSkipTaskbar(next !== 'full' && !taskbar());
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
    if (next === 'hidden' && cube()) next = 'cube'; // скрытое окно — шар в углу
    // Окно меняет размер под другой режим: до первого кадра нового вида оно прозрачно — иначе на миг видна
    // прошлая картинка (полное окно в рамке голограммы, шар не на своём месте)
    const resized = (next === 'cube' || next === 'orb') && next !== mode && !(next === 'orb' && mode === 'full' && !collapse);
    if (resized) hold(next);
    if (next === 'hidden') {
      win.hide();
      applyLayer('hidden');
    } else if (next === 'cube') {
      if (win.isMinimized()) win.restore();
      applyLayer('cube');
      placeCube();
      win.showInactive();
      win.flashFrame(false); // показ без фокуса Windows считает «просьбой внимания» — кнопка в панели задач не должна мигать
    } else if (next === 'orb') {
      const minimized = win.isMinimized();
      if (mode === 'full' && !collapse && !minimized) return; // полное окно уже на экране
      if (minimized) win.restore(); // свёрнутое окно отвечает плашкой в углу
      applyLayer('orb');
      if (mode !== 'orb' || minimized || !win.isVisible()) placeOrb();
      win.showInactive();
      win.flashFrame(false);
      win.moveTop(); // поверх остальных окон, даже если другое окно тоже «всегда сверху»
    } else if (next === 'full') {
      if (mode !== 'full') win.setBounds(fullPlace());
      applyLayer('full');
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    mode = next;
    send('jarvis:mode', mode);
  }

  // Спрятать окно до сигнала «нарисовал режим» (painted) или до REVEAL_MS
  function hold(next) {
    clearTimeout(revealTimer);
    win.setOpacity(0);
    revealTimer = setTimeout(() => painted(next), REVEAL_MS);
  }
  function painted(m) {
    if (!win || m !== mode) return;
    clearTimeout(revealTimer);
    win.setOpacity(1);
  }

  // Полное окно: где его оставили, если это место ещё видно (монитор могли отключить), иначе — по центру.
  // Высота — не больше рабочей области: на ноутбуке 1366 × 768 с масштабом 125% окно 620 px не помещается
  function fullPlace() {
    const visible =
      fullBounds &&
      screen.getAllDisplays().some(({ workArea: w }) => {
        const cx = fullBounds.x + fullBounds.width / 2;
        return cx >= w.x && cx <= w.x + w.width && fullBounds.y >= w.y - 8 && fullBounds.y < w.y + w.height - 40;
      });
    const a = visible ? screen.getDisplayMatching(fullBounds).workArea : area();
    const width = Math.min(visible ? fullBounds.width : FULL.width, a.width);
    const height = Math.min(visible ? fullBounds.height : FULL.height, a.height - 16);
    if (visible) return { x: fullBounds.x, y: Math.max(a.y, Math.min(fullBounds.y, a.y + a.height - height)), width, height };
    return { x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - height) / 2), width, height };
  }

  function placeCube() {
    const a = area();
    const lift = orbOffset(a);
    win.setBounds({ ...CUBE, x: a.x + a.width - CUBE.width - EDGE, y: a.y + a.height - CUBE.height - EDGE - lift });
  }

  function placeOrb() {
    const a = area();
    const h = Math.min(orbHeight, Math.round(a.height * ORB_MAX_SHARE));
    const lift = orbOffset(a);
    // Шар в окне — в 32 px от правого и нижнего края, как в окне 64 × 64: при раскрытии он не сдвигается
    win.setBounds({ width: ORB.width, height: h, x: a.x + a.width - ORB.width - EDGE, y: a.y + a.height - h - EDGE - lift });
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

  // Точка состояния на кнопке в панели задач: PNG из окна (data:image/png) или null — убрать
  function setOverlay(dataUrl, label) {
    if (!win || process.platform !== 'win32') return;
    const ok =
      taskbar() && typeof dataUrl === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl) && dataUrl.length < 20_000;
    try {
      win.setOverlayIcon(ok ? nativeImage.createFromDataURL(dataUrl) : null, ok ? String(label || '').slice(0, 60) : '');
    } catch {}
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
    painted,
    send,
    mode: () => mode,
    tucked: () => mode === 'hidden' || mode === 'cube', // окна разговора не видно (или виден только шар)
    pinned: () => pinned,
    setPinned,
    setOverlay,
    refreshLayer: () => win && applyLayer(mode), // настройку «в панели задач» поменяли
    minimize,
    isOurs: (e) => !!win && e.sender === win.webContents,
    webContents: () => win?.webContents,
  };
}

module.exports = { createWindowManager };
