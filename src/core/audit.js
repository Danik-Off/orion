// Журнал действий: принятые команды, вызванные навыки, ошибки. Одна строка JSON на событие.
// Не растёт бесконечно: больше maxBytes (10 МБ — примерно полгода) — переименовывается в <имя>.old.log
// (прежний старый удаляется), запись идёт в новый файл. Размер проверяется раз в CHECK_EVERY строк.
const fs = require('node:fs');

const CHECK_EVERY = 200;

function createAudit(file, { maxBytes = 10 * 1024 * 1024 } = {}) {
  let lines = 0;
  let rotating = false;
  const old = file.replace(/\.log$/, '') + '.old.log';

  function rotateIfBig() {
    rotating = true;
    fs.stat(file, (err, st) => {
      if (err || st.size < maxBytes) return (rotating = false);
      fs.rename(file, old, () => (rotating = false));
    });
  }

  return (entry) => {
    const line = JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n';
    const n = ++lines;
    // Проверка — когда эта строка уже на диске, иначе размер ещё не учтёт последние записи
    fs.appendFile(file, line, () => n % CHECK_EVERY === 0 && !rotating && rotateIfBig());
  };
}

module.exports = { createAudit };
