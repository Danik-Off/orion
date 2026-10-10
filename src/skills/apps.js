// Программы: открыть (любая из меню «Пуск»), закрыть (как крестиком), свернуть все окна.
const path = require('node:path');
const { createAppCatalog, score } = require('../lib/app-catalog');
const windows = require('../lib/windows'); // closeForegroundWindow — через объект: тесты подменяют системные вызовы
const { launch, listWindowedApps, closeProcessWindows, minimizeAll, defaultBrowserProcess } = windows;

let catalog = null;

// Встроенные названия Windows: «параметры» — это параметры Windows, а не «Языковые параметры Office»
const BUILTIN = {
  параметры: 'ms-settings:',
  'параметры windows': 'ms-settings:',
  'настройки windows': 'ms-settings:',
  'настройки компьютера': 'ms-settings:',
  корзина: 'shell:RecycleBinFolder',
  'панель управления': 'control.exe',
};
// Процесс браузера по умолчанию → его название в меню «Пуск»
const BROWSER_APPS = {
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  firefox: 'Firefox',
  browser: 'Yandex',
  opera: 'Opera',
  brave: 'Brave',
  vivaldi: 'Vivaldi',
};

async function findApp(name) {
  const q = String(name || '')
    .toLowerCase()
    .trim();
  if (BUILTIN[q]) return { name: q, target: BUILTIN[q] };
  if (/^(браузер|browser|интернет)$/.test(q)) {
    const proc = await defaultBrowserProcess();
    return (proc && (await catalog?.find(BROWSER_APPS[proc] || proc))) || null;
  }
  return (await catalog?.find(name)) || null; // список программ не собрался (ошибка при запуске) — «не нашёл»
}

async function openTarget(target, ctx) {
  if (target.startsWith('shell:') || target.startsWith('ms-settings:')) return launch('explorer.exe', [target]); // «Пуск», Store, параметры
  if (path.isAbsolute(target)) {
    const err = await ctx.openPath(target); // .exe, .lnk, папки
    if (err) throw new Error(err);
    return;
  }
  return launch(target);
}

async function closeApp(query, ctx) {
  // «Закрой это окно», «закрой его», «закрой окно» — то, что сейчас впереди
  if (
    /^(?:это|этот|эту|его|ее|текущее|активное|открытое|верхнее)?\s*(?:окно|программу|приложение|вкладку)?$/i.test(String(query).trim()) &&
    String(query).trim()
  ) {
    const closed = await windows.closeForegroundWindow();
    if (!closed) return { ok: false, message: 'Не вижу, какое окно закрыть, сэр. Нажмите на него и повторите.' };
    ctx.audit({ closed, window: 'активное' });
    return { ok: true };
  }
  let processName = null;
  let label = query;
  if (/^(браузер|browser)/i.test(query)) {
    processName = await defaultBrowserProcess();
    label = 'браузер';
  } else {
    // Ищем среди открытых окон по названию программы, имени процесса и заголовку окна
    let best = null;
    for (const app of await listWindowedApps()) {
      const s = Math.max(score(query, app.description || app.name), score(query, app.name), score(query, app.title) * 0.8);
      if (s > 0 && (!best || s > best.s)) best = { s, app };
    }
    processName = best?.app.name;
    label = best?.app.description || query;
  }
  if (!processName) return { ok: false, message: `Не вижу открытой программы «${query}», сэр.` };
  const closed = await closeProcessWindows(processName);
  if (!closed) return { ok: false, message: `«${label}» сейчас не открыт, сэр.` };
  ctx.audit({ closed: processName, windows: closed });
  return { ok: true };
}

module.exports = {
  id: 'apps',
  needs: [],
  platforms: ['win32'], // PowerShell и программы Windows
  title: 'открыть или закрыть любую программу, свернуть все окна',
  keywords: [
    'откр',
    'запус',
    'закр',
    'выруб',
    'заверш',
    'сверн',
    'программ',
    'прилож',
    'окн',
    'рабочий стол',
    'телеграм',
    'дискорд',
    'стим',
    'браузер',
    'хром',
  ],
  init: (ctx) => {
    catalog = createAppCatalog({ aliases: ctx.config.apps, discover: ctx.config.discoverApps !== false });
  },
  rules: ['«Закрой X» — только close_app, ничего не открывай перед этим. «Открой X» — open_app.'],
  tools: [
    {
      name: 'open_app',
      use: 'открыть или запустить программу (любая установленная: Telegram, Steam, Word, Discord…)',
      arg: 'название программы, как его назвал пользователь',
      examples: [
        ['открой телеграм', { addressed: true, say: 'Открываю Telegram, сэр.', actions: [{ tool: 'open_app', arg: 'телеграм' }] }],
      ],
      run: async (name, ctx) => {
        let found = name && (await findApp(name));
        // Распознавание исказило название («ворт», «зум») — переспросить похожее, а не сразу «не нашёл»
        if (!found && name) {
          const guess = await catalog?.suggest?.(name);
          if (guess && (await ctx.confirm?.(`Вы имели в виду «${guess.name}»?`)) === true) found = guess;
          else if (guess) return { ok: false, message: 'Хорошо, не открываю, сэр.' };
        }
        if (!found) return { ok: false, message: `Не нашёл программу «${name}» в меню «Пуск», сэр.` };
        await openTarget(found.target, ctx);
        return { ok: true };
      },
    },
    {
      name: 'close_app',
      use: 'закрыть программу; «браузер» — браузер по умолчанию',
      arg: 'название программы или «браузер»',
      examples: [
        ['закрой хром', { addressed: true, say: 'Закрываю Chrome.', actions: [{ tool: 'close_app', arg: 'chrome' }] }],
        ['закрой браузер', { addressed: true, say: 'Закрываю браузер.', actions: [{ tool: 'close_app', arg: 'браузер' }] }],
      ],
      run: closeApp,
    },
    {
      name: 'minimize_all',
      use: 'свернуть все окна, показать рабочий стол',
      arg: 'пусто',
      argEnum: [''],
      run: async () => {
        await minimizeAll();
        return { ok: true };
      },
    },
  ],
  catalog: () => catalog,
};
