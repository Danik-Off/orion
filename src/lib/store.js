// Маленькое JSON-хранилище навыка в папке данных приложения. Без dataDir (тесты) — только в памяти.
const fs = require('node:fs');
const path = require('node:path');

function createStore(dataDir, name, fallback) {
  const file = dataDir ? path.join(dataDir, name) : null;
  let data;
  try {
    data = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : structuredClone(fallback);
  } catch {
    data = structuredClone(fallback);
  }
  return {
    get: () => data,
    save(next = data) {
      data = next;
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 1)); // атомарно: сначала во временный файл
      fs.renameSync(file + '.tmp', file);
    },
  };
}

module.exports = { createStore };
