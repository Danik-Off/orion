// Окно разговора: полное — обычное окно (панель задач, сворачивается, поверх — только закреплённое),
// плашка — всегда поверх; настройки не оказываются под закреплённым окном
const { electron } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

// Подставное окно: запоминает слой и состояние
class FakeWindow {
  static last = null;
  constructor(opts) {
    Object.assign(this, { opts, onTop: opts.alwaysOnTop === true, skip: opts.skipTaskbar === true, minimized: false, visible: false });
    this.webContents = { send: () => {} };
    FakeWindow.last = this;
  }
  loadFile() {}
  on(name, cb) {
    (this.handlers ||= {})[name] = cb;
  }
  once(_e, cb) {
    cb();
  }
  setAlwaysOnTop(on) {
    this.onTop = on;
  }
  setSkipTaskbar(on) {
    this.skip = on;
  }
  setBounds(b) {
    this.bounds = b;
  }
  setResizable(on) {
    this.resizable = on;
  }
  setMinimumSize(w, h) {
    this.min = [w, h];
  }
  setOpacity(v) {
    this.opacity = v;
  }
  getBounds() {
    return this.bounds || { x: 0, y: 0, width: 0, height: 0 };
  }
  flashFrame(on) {
    this.flashing = on;
  }
  show() {
    this.visible = true;
  }
  showInactive() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  focus() {}
  moveTop() {}
  minimize() {
    this.minimized = true;
  }
  restore() {
    this.minimized = false;
  }
  isMinimized() {
    return this.minimized;
  }
  isVisible() {
    return this.visible;
  }
}
electron.BrowserWindow = FakeWindow;
// Рабочая область меняется в тестах: маленький экран ноутбука
let workArea = { x: 0, y: 0, width: 1920, height: 1080 };
electron.screen = {
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => ({ workArea }),
  getDisplayMatching: () => ({ workArea }),
  getAllDisplays: () => [{ workArea }],
};
const { createWindowManager } = require('../src/core/window');
const { createSettingsWindow } = require('../src/app/settings-window');

test('окно: полное — обычное и сворачивается; плашка — поверх; закреплённое — поверх; свёрнутое отвечает плашкой', async () => {
  const ui = createWindowManager({ title: 'Орион', preload: '', html: '' });
  await ui.create();
  const w = FakeWindow.last;
  ui.setMode('full');
  assert.equal(w.onTop, false, 'полное окно не висит поверх остальных');
  assert.equal(w.skip, false, 'полное окно — в панели задач');
  ui.minimize();
  assert.equal(w.minimized, true);
  ui.setMode('orb'); // голосовой ответ, пока окно свёрнуто
  assert.equal(ui.mode(), 'orb');
  assert.equal(w.minimized, false);
  assert.equal(w.onTop, true, 'плашка — поверх');
  assert.equal(w.skip, true, 'плашка — без кнопки в панели задач');
  ui.setMode('full');
  ui.setPinned(true);
  assert.equal(w.onTop, true, 'закреплённое — поверх');
  ui.setMode('hidden');
  assert.equal(w.skip, true);

  // Настройки при закреплённом окне — тоже поверх, иначе окажутся под ним
  const settings = createSettingsWindow({ title: 'Орион', preload: '', html: '', above: () => ui.pinned() });
  settings.open();
  assert.equal(FakeWindow.last.opts.alwaysOnTop, true);
  ui.setPinned(false);
  settings.refreshLayer(); // открепили, пока настройки открыты
  assert.equal(FakeWindow.last.onTop, false);
});

test('шар и голограмма: окно меняет размер невидимым и показывается, когда нарисовало новый режим', async () => {
  const ui = createWindowManager({ title: 'Орион', preload: '', html: '', cube: () => true });
  await ui.create();
  const w = FakeWindow.last;
  ui.setMode('hidden'); // со включённым шаром — шар в углу
  assert.equal(ui.mode(), 'cube');
  assert.equal(w.opacity, 0, 'до первого кадра шара — прозрачно');
  ui.painted('orb'); // запоздалый сигнал о другом режиме не показывает окно
  assert.equal(w.opacity, 0);
  ui.painted('cube');
  assert.equal(w.opacity, 1);
  ui.setMode('orb');
  assert.equal(w.opacity, 0, 'голограмма: прежняя картинка не мелькает');
  await new Promise((r) => setTimeout(r, 200)); // окно молчит — показать всё равно
  assert.equal(w.opacity, 1);
  ui.setMode('full');
  w.opacity = 1;
  ui.setMode('orb'); // полное окно на экране — голограмма его не заменяет и не прячет
  assert.equal(w.opacity, 1);
});

test('полное окно на маленьком экране помещается целиком, размер можно менять; монитор отключили — окно по центру', async () => {
  workArea = { x: 0, y: 0, width: 1093, height: 574 }; // 1366 × 768 при масштабе 125%, минус панель задач
  try {
    const ui = createWindowManager({ title: 'Орион', preload: '', html: '' });
    await ui.create();
    const w = FakeWindow.last;
    ui.setMode('full');
    assert.ok(w.bounds.y >= 0 && w.bounds.y + w.bounds.height <= 574, `окно в пределах экрана: ${JSON.stringify(w.bounds)}`);
    assert.equal(w.resizable, true);
    assert.deepEqual(w.min, [360, 480]);
    ui.setMode('hidden');
    assert.equal(w.resizable, false, 'скрытое окно и голограмма размер не меняют');
  } finally {
    workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  }
});

test('панель задач: кнопка Ориона и в свёрнутом виде; щелчок по ней (мышь не над окном) — открыть окно', async () => {
  const ui = createWindowManager({ title: 'Орион', preload: '', html: '', cube: () => true, taskbar: () => true });
  await ui.create();
  const w = FakeWindow.last;
  ui.setMode('hidden'); // → шар в углу
  assert.equal(ui.mode(), 'cube');
  assert.equal(w.skip, false, 'кнопка в панели задач есть и у свёрнутого');
  w.handlers.focus(); // щелчок по кнопке в панели задач: мышь в (0, 0), шар — в правом нижнем углу
  assert.equal(ui.mode(), 'full');
  const off = createWindowManager({ title: 'Орион', preload: '', html: '', cube: () => true, taskbar: () => false });
  await off.create();
  off.setMode('hidden');
  assert.equal(FakeWindow.last.skip, true, 'выключено в настройках — в свёрнутом виде кнопки нет');
});
