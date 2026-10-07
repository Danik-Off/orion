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
  on() {}
  once(_e, cb) {
    cb();
  }
  setAlwaysOnTop(on) {
    this.onTop = on;
  }
  setSkipTaskbar(on) {
    this.skip = on;
  }
  setBounds() {}
  getBounds() {
    return {};
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
electron.screen = {
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
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
