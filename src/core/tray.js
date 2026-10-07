// Иконка в трее: «арк-реактор», нарисованный кодом, — без бинарных файлов в проекте.
const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('node:path');

function drawReactor(size = 32) {
  const buf = Buffer.alloc(size * size * 4); // BGRA
  const c = (size - 1) / 2;
  const clamp = (v) => Math.max(0, Math.min(1, v));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) * (32 / size);
      const ring = clamp(1.6 - Math.abs(d - 12.5)); // внешнее кольцо
      const core = clamp(6 - d); // яркое ядро
      const glow = clamp((9 - d) / 9) * 0.35;
      const a = Math.max(ring, core, glow);
      const white = clamp(core - 0.3);
      const i = (y * size + x) * 4;
      buf[i] = 255; // B
      buf[i + 1] = Math.round(209 + 46 * white); // G
      buf[i + 2] = Math.round(79 + 176 * white); // R
      buf[i + 3] = Math.round(255 * a);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// Автозапуск: в режиме разработки Windows запускает electron.exe с путём к проекту; --hidden — сразу в трей.
function loginItem() {
  return { path: process.execPath, args: [...(app.isPackaged ? [] : [path.resolve(__dirname, '..')]), '--hidden'] };
}

// Автозапуск Electron умеет только на Windows и macOS; на Linux пункт не показываем
const LOGIN_ITEM_LABEL = { win32: 'Запускать вместе с Windows', darwin: 'Открывать при входе в систему' }[process.platform];

function createTray({ name, onShow, onToggleMic, onSettings, onCheckUpdates, onQuit, hotkey }) {
  const tray = new Tray(drawReactor(process.platform === 'darwin' ? 22 : 32)); // строка меню macOS ниже панели задач
  tray.setToolTip(`${name} — ${hotkey}`);

  const rebuild = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate(
        [
          { label: `Показать (${hotkey})`, click: onShow },
          { label: 'Микрофон вкл/выкл', click: onToggleMic },
          onSettings && { label: 'Настройки…', click: onSettings },
          LOGIN_ITEM_LABEL && {
            label: LOGIN_ITEM_LABEL,
            type: 'checkbox',
            checked: app.getLoginItemSettings(loginItem()).openAtLogin,
            click: (item) => {
              app.setLoginItemSettings({ ...loginItem(), openAtLogin: item.checked });
              rebuild();
            },
          },
          { label: 'Проверить обновления', click: onCheckUpdates },
          { type: 'separator' },
          { label: 'Выход', click: onQuit },
        ].filter(Boolean),
      ),
    );

  rebuild();
  tray.on('click', onShow);
  return tray;
}

module.exports = { createTray };
