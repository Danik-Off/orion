// Обновления с GitHub Releases (electron-updater). Сами ничего не качаем и не ставим без согласия:
// нашлась новая версия → вопрос голосом и кнопками «Хотите обновить?» → скачать → перезапуститься.
// Где обновление поставить нельзя (macOS без подписи Apple, .deb) — открываем страницу релиза.
const { autoUpdater } = require('electron-updater');
const { notesSummary } = require('../lib/release-notes');

// app, confirm(text) → Promise<bool>, report({ title, progress, done?, error? }) — полоска в окне,
// beforeInstall() — сохранить разговор до выхода, openExternal(url), audit
function createUpdater({ app, confirm, report, beforeInstall, openExternal, audit, releasesUrl }) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  let busy = false;

  const openReleases = () => releasesUrl && openExternal(releasesUrl);

  async function install(version) {
    report({ title: `Скачиваю обновление ${version}`, progress: 0 });
    const onProgress = (p) => report({ title: `Скачиваю обновление ${version}`, progress: (p.percent || 0) / 100 });
    autoUpdater.on('download-progress', onProgress);
    try {
      await autoUpdater.downloadUpdate();
      report({ title: 'Обновление скачано — перезапускаюсь', progress: 1, done: true });
      audit({ update: 'установка', version });
      await beforeInstall();
      autoUpdater.quitAndInstall(true, true); // тихо и с перезапуском
    } catch (err) {
      audit({ update: 'ошибка загрузки', error: String(err?.message || err) });
      report({ title: 'Обновить само не получилось — открыл страницу загрузки', error: true });
      openReleases();
    } finally {
      autoUpdater.off('download-progress', onProgress);
    }
  }

  // manual: пользователь сам попросил проверить — сообщаем и «обновлений нет»
  async function check({ manual = false } = {}) {
    if (!app.isPackaged) {
      if (manual) report({ title: 'Обновления проверяются только в установленной версии', error: true });
      return { status: 'dev' };
    }
    if (busy) return { status: 'busy' };
    busy = true;
    try {
      const result = await autoUpdater.checkForUpdates();
      const version = result?.updateInfo?.version;
      if (!result?.isUpdateAvailable || !version) {
        if (manual) report({ title: `У вас последняя версия — ${app.getVersion()}`, progress: 1, done: true });
        return { status: 'latest' };
      }
      audit({ update: 'найдено', version, current: app.getVersion() });
      const about = notesSummary(result.updateInfo.releaseNotes);
      const yes = await confirm(`Найдено обновление до версии ${version}.${about ? ` ${about}` : ''} Хотите обновить?`);
      audit({ update: yes ? 'согласие' : 'отказ', version });
      if (yes) await install(version);
      return { status: yes ? 'installing' : 'declined', version };
    } catch (err) {
      audit({ update: 'ошибка проверки', error: String(err?.message || err) });
      if (manual) report({ title: 'Не удалось проверить обновления — нет связи с GitHub', error: true });
      return { status: 'error' };
    } finally {
      busy = false;
    }
  }

  return { check };
}

module.exports = { createUpdater };
