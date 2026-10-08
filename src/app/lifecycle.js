// Жизнь приложения: разрешения окна, запуск, трей, обновления, сохранение разговора при выходе.
const { createTray } = require('../core/tray');
const { createUpdater } = require('../core/updater');
const { isHttpUrl } = require('../lib/websearch');
const pkg = require('../../package.json');

const SAVE_ON_QUIT_MS = 8000; // итог разговора в память — не дольше, выход важнее

// https://github.com/<owner>/<repo>/releases/latest — куда вести, если обновиться само не может
const releasesUrl = () =>
  `${String(pkg.repository?.url || pkg.repository || '')
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')}/releases/latest`;

function startLifecycle({ electron, config, services, voice, setup, mcp, updates, ui, settingsWindow, ipc, registerHotkey }) {
  const { app, session, shell, systemPreferences, globalShortcut } = electron;
  const { assistant, skills, audit, confirm } = services;

  // Перед выходом — сохранить итог текущего разговора в память. Установщик обновления вызывает это заранее,
  // чтобы потом выйти сразу: пока приложение не закрылось, новая версия не встанет.
  let quitting = false;
  async function saveBeforeQuit() {
    quitting = true;
    await Promise.race([assistant.endSession('выход'), new Promise((r) => setTimeout(r, SAVE_ON_QUIT_MS))]).catch(() => {});
  }

  const updater = createUpdater({
    app,
    confirm,
    audit,
    report: (r) => ui.send('jarvis:update', r),
    beforeInstall: saveBeforeQuit,
    openExternal: (url) => isHttpUrl(url) && shell.openExternal(url),
    releasesUrl: releasesUrl(),
  });
  ipc.handle('jarvis:update-check', () => updater.check({ manual: true }));

  // Разговор и окно
  ipc.on('jarvis:confirm-reply', ({ id, ok } = {}) => services.answerConfirm(id, ok));
  ipc.on('jarvis:question-reply', ({ id, text } = {}) => services.answerQuestion(id, text));
  ipc.handle('jarvis:open-link', (url) => isHttpUrl(url) && services.ctx.openExternal(url));
  ipc.on('jarvis:reset', () => (voice.forgetPartner(), assistant.reset()));
  ipc.on('jarvis:dialog-end', () => (voice.forgetPartner(), assistant.endSession('конец диалога')));
  ipc.on('jarvis:presence', (next) => {
    if (next === 'collapse') return ui.setMode('orb', { collapse: true }); // закрыли окно посреди диалога
    if (['full', 'orb', 'hidden'].includes(next)) ui.setMode(next);
  });
  ipc.on('jarvis:orb-height', (h) => ui.setOrbHeight(h));
  ipc.on('jarvis:radio-state', (state) => services.radio.report(state));
  // Будильник отложили («ещё 5 минут» или кнопкой) — позвонить снова
  ipc.on('jarvis:alarm-snooze', ({ payload, minutes } = {}) => payload && services.alarmSnooze(payload, minutes));

  // Окно никогда не уходит на чужие страницы и не открывает новые окна.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (e) => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  app.whenReady().then(async () => {
    // Разрешён только микрофон и только нашему окну. Камера, геолокация и прочее — запрещены.
    const micOnly = (wc, perm, types = []) =>
      perm === 'media' && wc === ui.webContents() && types.length > 0 && types.every((t) => t === 'audio');
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb, d) => cb(micOnly(wc, perm, d?.mediaTypes)));
    session.defaultSession.setPermissionCheckHandler((wc, perm, _o, d) => micOnly(wc, perm, d?.mediaType ? [d.mediaType] : []));

    // macOS спрашивает доступ к микрофону сам, но только по запросу приложения
    if (process.platform === 'darwin') systemPreferences.askForMediaAccess('microphone').catch(() => {});

    await skills.init();
    assistant.warmup(); // после init: в промпте уже полные описания навыков
    mcp?.start(); // навыки серверов MCP — сразу из кэша; сами серверы запустятся, когда понадобятся
    await ui.create();
    // При автозапуске вместе с системой — сразу в трей, иначе показать окно.
    ui.setMode(process.argv.includes('--hidden') ? 'hidden' : 'full');
    // Когда всё установлено — предложение большой модели, предложения навыков («нашёл Claude Code — передавать
    // ему задачи?»), затем
    // проверка обновлений (если не отключена в настройках). Вопросы — по очереди: в окне виден только один.
    setup.run().then(async (ready) => {
      if (!ready) return;
      await new Promise((r) => setTimeout(r, 3000));
      await setup.offerBrain(); // «я могу стать умнее» — если большой модели ещё нет
      await skills.offer();
      if (config.updates?.notify !== false) setTimeout(() => updater.check(), 2000);
      setTimeout(() => updates?.checkOnStart(), 10_000); // части Ориона — тихо, итог точкой на «Компонентах»
    });

    createTray({
      name: config.name,
      hotkey: config.hotkey,
      onShow: () => ui.setMode('full'),
      onToggleMic: () => ui.send('jarvis:toggle-mic'),
      onSettings: () => settingsWindow.open(),
      onCheckUpdates: () => {
        ui.setMode('full');
        updater.check({ manual: true });
      },
      onQuit: () => app.quit(),
    });

    if (!registerHotkey(config.hotkey)) audit({ warning: `Горячая клавиша ${config.hotkey} занята другой программой` });
  });

  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    saveBeforeQuit().finally(() => app.quit());
  });
  app.on('second-instance', () => ui.setMode('full'));
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    services.stopModels();
    mcp?.close(); // локальные серверы MCP — дочерние процессы: закрыть вместе с приложением
  });
  app.on('window-all-closed', () => {}); // приложение остаётся в трее; выход — через меню трея
}

module.exports = { startLifecycle };
