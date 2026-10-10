const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createCrashGuard, MAX_RELOADS, RELOAD_WINDOW, HANG_MS } = require('../src/app/crash-guard');

function setup() {
  const app = new EventEmitter();
  const proc = new EventEmitter();
  const log = [];
  let t = 1_000_000;
  const timers = [];
  const guard = createCrashGuard({
    app,
    proc,
    audit: (e) => log.push(e),
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearTimeout: (id) => id && (timers[id - 1].fn = null),
    },
  });
  const wc = {
    reloads: 0,
    crashed: 0,
    reload() {
      this.reloads++;
    },
    forcefullyCrashRenderer() {
      this.crashed++;
    },
    isDestroyed: () => false,
  };
  return { app, proc, log, guard, wc, timers, tick: (ms) => (t += ms) };
}

test('ошибка главного процесса — в журнал, повторы сжимаются в счётчик', () => {
  const { proc, log, tick } = setup();
  for (let i = 0; i < 3; i++) proc.emit('uncaughtException', new Error('бах')); // одно место — один стек
  assert.strictEqual(log.length, 1);
  assert.match(log[0].error, /бах/);
  tick(1000);
  proc.emit('unhandledRejection', new Error('другое'));
  assert.deepStrictEqual(log[1], { crash: 'главный процесс', repeats: 2 });
  assert.match(log[2].error, /другое/);
});

test('упавшее окно перезагружается, но не по кругу', () => {
  const { app, log, wc, tick } = setup();
  for (let i = 0; i < MAX_RELOADS + 2; i++) app.emit('render-process-gone', {}, wc, { reason: 'crashed' });
  assert.strictEqual(wc.reloads, MAX_RELOADS);
  assert.match(log.at(-1).reload, /отказ/);
  tick(RELOAD_WINDOW + 1);
  app.emit('render-process-gone', {}, wc, { reason: 'oom' });
  assert.strictEqual(wc.reloads, MAX_RELOADS + 1, 'через минуту снова можно');
});

test('штатное закрытие окна — не сбой', () => {
  const { app, log, wc } = setup();
  app.emit('render-process-gone', {}, wc, { reason: 'clean-exit' });
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'clean-exit' });
  assert.strictEqual(wc.reloads, 0);
  assert.strictEqual(log.length, 0);
});

test('зависшее окно перезапускается, ожившее — нет', () => {
  const { app, wc, timers } = setup();
  const win = Object.assign(new EventEmitter(), { webContents: wc });
  app.emit('browser-window-created', {}, win);
  win.emit('unresponsive');
  win.emit('unresponsive'); // повтор не заводит второй таймер
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].ms, HANG_MS);
  win.emit('responsive');
  timers[0].fn?.();
  assert.strictEqual(wc.crashed, 0);
  win.emit('unresponsive');
  timers[1].fn();
  assert.strictEqual(wc.crashed, 1);
});

test('ошибка из окна — в журнал с местом', () => {
  const { guard, log } = setup();
  guard.rendererError({ message: 'x is undefined', source: 'app.js', line: 42 });
  assert.match(log[0].error, /x is undefined \| app\.js:42/);
  assert.strictEqual(log[0].crash, 'окно');
});

test('необработанная ошибка окна видна по его консоли («Uncaught …»), обычные сообщения — нет', () => {
  const { app, log } = setup();
  const wc = new EventEmitter();
  app.emit('web-contents-created', {}, wc);
  wc.emit(
    'console-message',
    {},
    { level: 'error', message: 'Uncaught TypeError: x is not a function', sourceId: 'file:///C:/app/src/renderer/app.js', lineNumber: 7 },
  );
  wc.emit('console-message', {}, { level: 'error', message: 'Failed to load resource' });
  wc.emit('console-message', {}, { level: 'info', message: 'Uncaught? нет, просто текст' });
  assert.equal(log.length, 1);
  assert.match(log[0].error, /x is not a function \| app\.js:7/);
});
