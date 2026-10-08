// Пользовались ли Орионом до этого запуска: первая запись журнала старше запуска (или журнал уже перевалил
// за предел и есть старый). Отличает обновление от первой установки там, где своих отметок нет:
// «что нового» после обновления с версий без lastVersion, знакомство — только для новых пользователей.
const fs = require('node:fs');
const path = require('node:path');

const STARTED = Date.now();

function usedBefore(dataDir, { started = STARTED } = {}) {
  if (!dataDir) return false;
  if (fs.existsSync(path.join(dataDir, 'actions.old.log'))) return true;
  try {
    const fd = fs.openSync(path.join(dataDir, 'actions.log'), 'r');
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const t = Date.parse(JSON.parse(buf.toString('utf8', 0, n).split('\n')[0]).t);
    return t < started - 60_000;
  } catch {
    return false;
  }
}

module.exports = { usedBefore };
