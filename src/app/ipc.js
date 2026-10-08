// IPC окна ↔ ядро. Обработчики принимают сообщения только от своих окон (разговор и настройки).
const { ipcMain } = require('electron');

// windows — объекты с isOurs(event) и send(channel, ...args)
function createIpc(...windows) {
  const ours = (e) => windows.some((w) => w.isOurs(e));
  const on = (channel, fn) => ipcMain.on(channel, (e, ...a) => ours(e) && fn(...a));
  const handle = (channel, fn) => ipcMain.handle(channel, (e, ...a) => (ours(e) ? fn(...a) : null));
  // Во все окна: ход установки виден и в разговоре, и в настройках
  const broadcast = (channel, ...args) => windows.forEach((w) => w.send(channel, ...args));
  // Окно, созданное позже остальных (мини-плеер радио: ему нужны ядро и настройки)
  const add = (w) => windows.push(w);
  return { on, handle, broadcast, add };
}

module.exports = { createIpc };
