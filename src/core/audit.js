// Журнал действий: принятые команды, вызванные навыки, ошибки. Одна строка JSON на событие.
const fs = require('node:fs');

function createAudit(file) {
  return (entry) => {
    const line = JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFile(file, line, () => {});
  };
}

module.exports = { createAudit };
