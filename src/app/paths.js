// Где что лежит: папка данных, config.json и папка моделей — в разработке и в установленной версии.
const fs = require('node:fs');
const path = require('node:path');

// Можно ли писать в папку (создаёт её при необходимости)
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

// Папка models (речь, llama.cpp и языковая модель — гигабайты) — рядом с программой: удалили программу —
// удалилось и всё скачанное. Установщик Windows при обновлении её не трогает (installer/installer.nsh).
// Где рядом с программой писать нельзя (macOS — внутри .app, пакеты Linux, Program Files) — в папке данных.
// В разработке — models/ рядом с проектом. speech.modelsDir в config.json — своя папка.
function resolveModelsDir({ config, packaged, root, dataDir, baseDir, execPath, platform = process.platform, canWrite = writable }) {
  if (config.speech.modelsDir) return path.resolve(baseDir, config.speech.modelsDir);
  if (!packaged) return path.join(root, 'models');
  if (platform === 'win32') {
    const nextToApp = path.join(path.dirname(execPath), 'models');
    if (canWrite(nextToApp)) return nextToApp;
  }
  return path.join(dataDir, 'models');
}

// Установленная версия: пакет только для чтения — настройки в папке данных пользователя (при первом запуске
// туда копируется config.json из пакета). В разработке — config.json рядом с проектом.
function configFileFor({ packaged, root, dataDir, ensureUserConfig }) {
  return packaged ? ensureUserConfig(path.join(root, 'config.json'), path.join(dataDir, 'config.json')) : path.join(root, 'config.json');
}

module.exports = { resolveModelsDir, configFileFor };
