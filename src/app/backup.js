// Резервная копия одним файлом: настройки, память, голоса людей, заметки, напоминания, сценарии и то, как
// распознаватель слышит имя. При переезде на новый компьютер всё это иначе терялось.
// Не входят: модели (их скачивают заново), журнал, пакеты серверов MCP.
// Ключи API в настройках зашифрованы системой: на этом же компьютере после восстановления они работают, на другом —
// расшифровать их нельзя, и их вводят заново. Ключи открытым текстом (система без хранилища ключей) в копию не попадают.
// Формат — JSON: { format: 'orion-backup', version: 1, app, created, files: { 'путь': 'содержимое' } }.
const fs = require('node:fs');
const path = require('node:path');
const { isSecret, PREFIX } = require('../core/secrets');

const FORMAT = 'orion-backup';
const VERSION = 1;
const FILES = ['people.json', 'notes.json', 'reminders.json', 'scenarios.json', 'wake-variants.json', 'voiceprint.json'];
const DIRS = ['memory'];
const MAX_FILE = 20 * 1024 * 1024; // голоса и память — килобайты; больше — не наше
const CONFIG = 'config.json';

// Только свои пути: файлы из списка или внутри memory/, без «..» и абсолютных путей
const allowed = (rel) =>
  typeof rel === 'string' &&
  !path.isAbsolute(rel) &&
  !rel.split(/[\\/]/).includes('..') &&
  (rel === CONFIG || FILES.includes(rel) || DIRS.some((d) => rel.startsWith(`${d}/`)));

function walk(dir, base = '') {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

// Ключи открытым текстом — убрать; зашифрованные системой (enc:v1:…) — оставить
function withoutPlainSecrets(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return text;
  }
  const strip = (v, keys = []) => {
    if (typeof v === 'string') return isSecret(keys) && !v.startsWith(PREFIX) ? '' : v;
    if (Array.isArray(v)) return v.map((x, i) => strip(x, [...keys, i]));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x, [...keys, k])]));
    return v;
  };
  return JSON.stringify(strip(config), null, 2);
}

// Собрать копию: dataDir — папка данных, configFile — файл настроек (в разработке он не в dataDir)
function createBackup({ dataDir, configFile, appVersion = '', now = new Date() }) {
  const files = {};
  const read = (rel, file) => {
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size <= MAX_FILE) files[rel] = fs.readFileSync(file, 'utf8');
    } catch {}
  };
  if (configFile) read(CONFIG, configFile);
  if (files[CONFIG] !== undefined) files[CONFIG] = withoutPlainSecrets(files[CONFIG]);
  for (const f of FILES) read(f, path.join(dataDir, f));
  for (const d of DIRS) for (const rel of walk(path.join(dataDir, d), d)) read(rel, path.join(dataDir, ...rel.split('/')));
  return { format: FORMAT, version: VERSION, app: appVersion, created: now.toISOString(), files };
}

// Проверить копию до восстановления → { ok, files, error }
function checkBackup(data) {
  if (!data || data.format !== FORMAT || typeof data.files !== 'object' || !data.files)
    return { ok: false, error: 'Это не резервная копия Ориона.' };
  if (data.version > VERSION) return { ok: false, error: 'Копия сделана более новой версией Ориона — сначала обновите его.' };
  const files = Object.entries(data.files).filter(([rel, text]) => allowed(rel) && typeof text === 'string' && text.length <= MAX_FILE);
  if (!files.length) return { ok: false, error: 'В копии нет данных.' };
  return { ok: true, files: files.map(([rel]) => rel) };
}

// Восстановить: файлы копии заменяют свои; то, чего в копии нет, остаётся. Перед записью — запасная копия
// текущих файлов рядом (<имя>.before-restore), чтобы ошибку можно было откатить вручную.
function restoreBackup(data, { dataDir, configFile }) {
  const check = checkBackup(data);
  if (!check.ok) return check;
  for (const rel of check.files) {
    const file = rel === CONFIG ? configFile : path.join(dataDir, ...rel.split('/'));
    if (!file) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.before-restore`);
    } catch {}
    fs.writeFileSync(file, data.files[rel]);
  }
  return { ok: true, files: check.files };
}

const backupName = (now = new Date()) => `orion-backup-${now.toISOString().slice(0, 10)}.json`;

// Кнопки «Сохранить копию» и «Восстановить из копии» в настройках («О программе»)
function registerBackupIpc({ ipc, app, dialog, dataDir, configFile, audit = () => {}, appVersion = '' }) {
  ipc.handle('jarvis:backup-export', async () => {
    const r = await dialog.showSaveDialog({
      title: 'Сохранить резервную копию Ориона',
      defaultPath: path.join(app.getPath('documents'), backupName()),
      filters: [{ name: 'Резервная копия Ориона', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
    const data = createBackup({ dataDir, configFile, appVersion });
    fs.writeFileSync(r.filePath, JSON.stringify(data));
    audit({ backup: 'сохранена', files: Object.keys(data.files).length });
    return { ok: true, file: r.filePath, files: Object.keys(data.files).length };
  });
  ipc.handle('jarvis:backup-import', async () => {
    const r = await dialog.showOpenDialog({
      title: 'Восстановить Ориона из резервной копии',
      properties: ['openFile'],
      filters: [{ name: 'Резервная копия Ориона', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths?.[0]) return { ok: false, cancelled: true };
    let data;
    try {
      data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    } catch {
      return { ok: false, error: 'Файл не читается как резервная копия.' };
    }
    const check = checkBackup(data);
    if (!check.ok) return check;
    const answer = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Восстановить и перезапустить', 'Отмена'],
      defaultId: 1,
      cancelId: 1,
      title: 'Восстановление',
      message: `Заменить настройки, память и голоса данными из копии от ${String(data.created || '').slice(0, 10) || 'неизвестной даты'}?`,
      detail: 'Текущие файлы сохранятся рядом с пометкой .before-restore. После восстановления Орион перезапустится.',
    });
    if (answer.response !== 0) return { ok: false, cancelled: true };
    const done = restoreBackup(data, { dataDir, configFile });
    audit({ backup: 'восстановлена', files: done.files?.length, ok: done.ok });
    if (!done.ok) return done;
    // Перезапуск без обычного выхода: при выходе память и навыки сохранили бы свои старые данные поверх копии
    app.relaunch();
    app.exit(0);
    return done;
  });
}

module.exports = { createBackup, checkBackup, restoreBackup, backupName, registerBackupIpc, FORMAT };
