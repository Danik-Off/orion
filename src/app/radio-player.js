// Мини-плеер радио: маленькое окно поверх остальных, пока выбрана станция, — название, песня (если станция её
// передаёт), пауза, другая станция, громкость, выключить. Сам звук — в окне разговора (renderer/radio.js):
// там эхоподавление вычитает радио из микрофона; плеер — только пульт.
// По умолчанию — правый нижний угол основного экрана. Перетащить можно куда угодно: отпущенный, он прилипает к
// ближайшему углу того экрана, где оказался, и запоминает угол и экран (radio.player.corner / .display).
// Не забирает фокус: кнопки нажимаются, а набор текста в другом окне не прерывается.
// Через 3 секунды без команд к радио и без мыши над ним становится полупрозрачным; команда, кнопка или
// наведённая мышь — снова непрозрачный. Наведение — по положению курсора: над областью перетаскивания
// Windows не передаёт окну событий мыши.
const { app, BrowserWindow, screen } = require('electron');
const { streamTitle } = require('../lib/radio');

const SIZE = { width: 380, height: 64 };
const MARGIN = 16;
const SONG_EVERY_MS = 15_000; // как часто спрашивать у станции название песни
// Не трогали и не командовали радио — плеер полупрозрачный, чтобы не заслонял то, что под ним
const FADE_AFTER_MS = 3000;
const FADED = 0.45;
const HOVER_EVERY_MS = 250;

// Ближайший угол рабочей области к центру окна: 'br' | 'bl' | 'tr' | 'tl'
function cornerOf(bounds, area) {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  return (cy < area.y + area.height / 2 ? 't' : 'b') + (cx < area.x + area.width / 2 ? 'l' : 'r');
}

// Положение окна size в углу corner рабочей области
function placeIn(area, corner, size = SIZE, margin = MARGIN) {
  return {
    ...size,
    x: Math.round(corner.endsWith('l') ? area.x + margin : area.x + area.width - size.width - margin),
    y: Math.round(corner.startsWith('t') ? area.y + margin : area.y + area.height - size.height - margin),
  };
}

function createRadioPlayer({ preload, html, config, radio, saveSettings, audit = () => {} }) {
  let win = null;
  let ready = null;
  let song = '';
  let songUrl = '';
  let songTimer = null;
  let volumeTimer = null;
  let lastTouch = 0; // когда в последний раз командовали радио или держали над плеером мышь
  let hoverTimer = null;

  const opts = () => config.radio?.player || {};
  const display = () => screen.getAllDisplays().find((d) => d.id === Number(opts().display)) || screen.getPrimaryDisplay();
  const corner = () => opts().corner || 'br';
  const enabled = () => opts().show !== false;

  function create() {
    win = new BrowserWindow({
      ...placeIn(display().workArea, corner()),
      title: 'Радио',
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false, // не перехватывать ввод у окна, в котором человек работает
      show: false,
      backgroundColor: '#05090d',
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.loadFile(html);
    ready = new Promise((resolve) => win.once('ready-to-show', resolve));
    // Отпустили после перетаскивания — к ближайшему углу того экрана, где оказался
    win.on('moved', snap);
    win.on('closed', () => {
      win = null;
      ready = null;
    });
  }

  function snap() {
    if (!win) return;
    const b = win.getBounds();
    const d = screen.getDisplayMatching(b);
    const c = cornerOf(b, d.workArea);
    win.setBounds(placeIn(d.workArea, c));
    if (c !== corner() || d.id !== Number(opts().display)) {
      saveSettings({ 'radio.player.corner': c, 'radio.player.display': d.id });
      audit({ radioPlayer: c, display: d.id });
    }
  }

  // Экран отключили или поменяли разрешение — на место (на основной экран, если нужного больше нет)
  const replace = () => win && win.setBounds(placeIn(display().workArea, corner()));
  // screen доступен только после готовности приложения
  app.whenReady().then(() => {
    screen.on('display-removed', replace);
    screen.on('display-metrics-changed', replace);
  });

  // Командовали радио или нажали кнопку — плеер непрозрачный, отсчёт до полупрозрачности заново
  function wake() {
    lastTouch = Date.now();
    if (win && win.getOpacity() !== 1) win.setOpacity(1);
  }

  function watchHover() {
    if (hoverTimer) return;
    hoverTimer = setInterval(() => {
      if (!win?.isVisible()) return;
      const p = screen.getCursorScreenPoint();
      const b = win.getBounds();
      if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) lastTouch = Date.now();
      const opacity = Date.now() - lastTouch > FADE_AFTER_MS ? FADED : 1;
      if (win.getOpacity() !== opacity) win.setOpacity(opacity);
    }, HOVER_EVERY_MS);
    hoverTimer.unref?.();
  }

  const view = (s) => ({ ...s, song: s.url === songUrl ? song : '' });
  const send = (s = radio.state()) => win?.webContents.send('jarvis:radio-player', view(s));

  // Название песни из потока — пока станция выбрана и плеер на экране
  async function pollSong() {
    const s = radio.state();
    if (!s.active || !s.url || !win?.isVisible()) return;
    const title = await streamTitle(s.url).catch(() => '');
    if (radio.state().url !== s.url) return; // пока ждали, станцию сменили
    if (title !== song || songUrl !== s.url) {
      song = title;
      songUrl = s.url;
      send();
    }
  }

  async function update(s) {
    const show = s.active && enabled();
    if (!show) {
      clearInterval(songTimer);
      clearInterval(hoverTimer);
      songTimer = hoverTimer = null;
      win?.hide();
      return;
    }
    if (!win) create();
    await ready;
    if (!win) return;
    send(s);
    wake();
    watchHover();
    if (!win.isVisible()) {
      win.setBounds(placeIn(display().workArea, corner()));
      win.showInactive();
    }
    if (!songTimer) {
      pollSong();
      songTimer = setInterval(pollSong, SONG_EVERY_MS);
      songTimer.unref?.();
    } else if (s.url !== songUrl) pollSong();
  }

  radio.onChange(update);

  // Кнопки плеера
  function control({ action, value } = {}) {
    wake();
    if (action === 'pause') radio.pause();
    else if (action === 'resume') radio.resume();
    else if (action === 'stop') radio.stop();
    else if (action === 'next') radio.next();
    else if (action === 'volume') radio.setVolume(value);
    else if (action === 'volume-done') {
      // Колёсико шлёт это на каждый щелчок — в файл настроек раз, когда перестали крутить
      clearTimeout(volumeTimer);
      volumeTimer = setTimeout(() => saveSettings({ 'radio.volume': Math.round(radio.state().volume * 100) / 100 }), 800);
    }
  }

  // Плашка Ориона тоже живёт в правом нижнем углу: если плеер там же, плашка встаёт над ним
  function orbOffset(area) {
    if (!win?.isVisible() || corner() !== 'br') return 0;
    const b = win.getBounds();
    const inside = b.x >= area.x && b.x < area.x + area.width && b.y >= area.y && b.y < area.y + area.height;
    return inside ? SIZE.height + 8 : 0;
  }

  return {
    control,
    orbOffset,
    // Настройку «показывать плеер» поменяли
    refresh: () => update(radio.state()),
    send: (channel, ...args) => win?.webContents.send(channel, ...args),
    isOurs: (e) => !!win && e.sender === win.webContents,
  };
}

module.exports = { createRadioPlayer, cornerOf, placeIn, SIZE };
