// Защита от сбоев: ошибка в одном месте не роняет всё приложение и не теряется бесследно.
//   - необработанная ошибка главного процесса → в журнал, работа продолжается (без неё Electron
//     показывает окно ошибки, а голос, таймеры и радио могут остановиться);
//   - упало окно (рендерер) → в журнал и перезагрузить его; не чаще MAX_RELOADS раз за RELOAD_WINDOW,
//     чтобы окно, падающее при загрузке, не перезагружалось по кругу;
//   - окно зависло дольше HANG_MS → перезапустить его процесс (дальше — как при падении);
//   - необработанные ошибки окон — тоже в журнал: Chromium пишет их в консоль окна («Uncaught …»), а консоль каждого
//     окна видна отсюда (обработчик в preload их не видит: он в изолированном мире, а ошибки — в мире страницы).
// Одинаковые ошибки подряд пишутся одной строкой с числом повторов, чтобы цикл ошибок не раздул журнал.
const RELOAD_WINDOW = 60_000;
const MAX_RELOADS = 3;
const HANG_MS = 15_000;
const REPEAT_MS = 10_000;

const short = (err) =>
  String(err?.stack || err?.message || err || 'без сообщения')
    .split('\n')
    .slice(0, 4)
    .join(' | ')
    .slice(0, 600);

function createCrashGuard({ app, proc = process, audit, now = Date.now, timers = { setTimeout, clearTimeout } }) {
  let last = { key: '', at: 0, repeats: 0 };
  const reloads = new Map(); // webContents → времена перезагрузок
  const hangs = new Map(); // webContents → таймер зависания

  // Повтор той же ошибки в течение REPEAT_MS — только счётчик; первая другая ошибка выписывает его
  function report(where, err) {
    const error = short(err);
    const key = `${where}|${error}`;
    const t = now();
    if (key === last.key && t - last.at < REPEAT_MS) {
      last.repeats++;
      last.at = t;
      return;
    }
    if (last.repeats) audit({ crash: last.key.split('|')[0], repeats: last.repeats });
    last = { key, at: t, repeats: 0 };
    audit({ crash: where, error });
  }

  function reload(wc, reason) {
    if (!wc || wc.isDestroyed?.()) return false;
    const t = now();
    const recent = (reloads.get(wc) || []).filter((at) => t - at < RELOAD_WINDOW);
    if (recent.length >= MAX_RELOADS) {
      audit({ crash: 'окно', reason, reload: 'отказ: падает слишком часто' });
      return false;
    }
    reloads.set(wc, [...recent, t]);
    wc.reload();
    audit({ crash: 'окно', reason, reload: 'перезагружено' });
    return true;
  }

  proc.on('uncaughtException', (err) => report('главный процесс', err));
  proc.on('unhandledRejection', (err) => report('главный процесс: обещание', err));

  // reason: crashed | oom | killed | launch-failed | integrity-failure | clean-exit | abnormal-exit
  app.on('render-process-gone', (_e, wc, details) => {
    const reason = details?.reason || 'неизвестно';
    if (reason === 'clean-exit') return; // окно закрыли штатно
    timers.clearTimeout(hangs.get(wc));
    hangs.delete(wc);
    reload(wc, reason);
  });

  // GPU, сеть, звук и другие служебные процессы Chromium: Electron перезапускает их сам, запоминаем для разбора
  app.on('child-process-gone', (_e, details) => {
    if (details?.reason === 'clean-exit') return;
    audit({ crash: 'служебный процесс', type: details?.type, reason: details?.reason, code: details?.exitCode });
  });

  // Зависание окна: Electron сообщает unresponsive/responsive у каждого окна
  app.on('browser-window-created', (_e, win) => watch(win));
  function watch(win) {
    const wc = win.webContents;
    win.on('unresponsive', () => {
      if (hangs.has(wc)) return;
      audit({ crash: 'окно', reason: 'не отвечает' });
      hangs.set(
        wc,
        timers.setTimeout(() => {
          hangs.delete(wc);
          if (!wc.isDestroyed?.()) wc.forcefullyCrashRenderer(); // дальше — render-process-gone → перезагрузка
        }, HANG_MS),
      );
    });
    win.on('responsive', () => {
      timers.clearTimeout(hangs.get(wc));
      hangs.delete(wc);
    });
  }

  // Ошибка из окна: { message, source, line, stack } — путь к файлу сокращаем до имени
  function rendererError(e) {
    if (!e || typeof e !== 'object') return report('окно', e);
    const source = String(e.source || '')
      .split(/[\\/]/)
      .pop();
    report('окно', [e.message, source && `${source}:${e.line}`, e.stack].filter(Boolean).join(' | '));
  }

  // Консоль окон: необработанные исключения и отклонённые обещания («Uncaught (in promise) …»).
  // Electron 35+ передаёт подробности объектом { level: 'error', message, lineNumber, sourceId }
  app.on('web-contents-created', (_e, wc) =>
    wc.on('console-message', (event, details) => {
      const d = details && typeof details === 'object' ? details : event;
      if ((d?.level === 'error' || d?.level === 3) && /^Uncaught/.test(String(d.message || '')))
        rendererError({ message: d.message, source: d.sourceId, line: d.lineNumber });
    }),
  );

  return { rendererError, report };
}

module.exports = { createCrashGuard, RELOAD_WINDOW, MAX_RELOADS, HANG_MS };
