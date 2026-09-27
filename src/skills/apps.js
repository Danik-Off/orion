// Программы: открыть (любая из меню «Пуск»), закрыть (как крестиком), свернуть все окна.
const path = require('node:path');
const { createAppCatalog, score } = require('../lib/app-catalog');
const { launch, listWindowedApps, closeProcessWindows, minimizeAll, defaultBrowserProcess } = require('../lib/windows');

let catalog = null;

async function openTarget(target, ctx) {
  if (target.startsWith('shell:AppsFolder\\')) return launch('explorer.exe', [target]); // приложения из Store и «Пуск»
  if (path.isAbsolute(target)) {
    const err = await ctx.openPath(target); // .exe, .lnk, папки
    if (err) throw new Error(err);
    return;
  }
  return launch(target);
}

async function closeApp(query, ctx) {
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
  platforms: ['win32'], // PowerShell и программы Windows
  title: 'открыть или закрыть любую программу, свернуть все окна',
  keywords: ['откр', 'запус', 'закр', 'сверн', 'программ', 'прилож', 'окн', 'рабочий стол', 'телеграм', 'дискорд', 'стим', 'браузер', 'хром'],
  init: (ctx) => {
    catalog = createAppCatalog({ aliases: ctx.config.apps, discover: ctx.config.discoverApps !== false });
  },
  rules: ['«Закрой X» — только close_app, ничего не открывай перед этим. «Открой X» — open_app.'],
  tools: [
    {
      name: 'open_app',
      use: 'открыть или запустить программу (любая установленная: Telegram, Steam, Word, Discord…)',
      arg: 'название программы, как его назвал пользователь',
      examples: [['открой телеграм', { addressed: true, say: 'Открываю Telegram, сэр.', actions: [{ tool: 'open_app', arg: 'телеграм' }] }]],
      run: async (name, ctx) => {
        const found = name && (await catalog.find(name));
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
