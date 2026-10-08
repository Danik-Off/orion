// Секреты в config.json — зашифрованы средствами системы (Electron safeStorage: на Windows — DPAPI, расшифровать
// может только эта учётная запись на этом компьютере). В файле — «enc:v1:…», в памяти программы — обычные значения.
// Что секрет: ключ внешней модели, ключи облачных провайдеров, переменные окружения и заголовки серверов MCP
// (там токены GitHub, Notion, ключи поиска). Без шифрования в системе (Linux без хранилища ключей) — как раньше,
// открытым текстом: лучше так, чем не работать.
const PREFIX = 'enc:v1:';

// Путь в config → секрет ли это
const SECRET_PATHS = [
  ['remote', 'apiKey'],
  ['cloud', 'providers', '*', 'apiKey'],
  ['mcp', 'servers', '*', 'env', '*'],
  ['mcp', 'servers', '*', 'headers', '*'],
];
const isSecret = (keys) => SECRET_PATHS.some((p) => p.length === keys.length && p.every((k, i) => k === '*' || k === String(keys[i])));

// Пройти по всем строкам объекта: fn(значение, путь) → новое значение (копия; исходный объект не меняется)
function mapStrings(value, fn, keys = []) {
  if (typeof value === 'string') return fn(value, keys);
  if (Array.isArray(value)) return value.map((v, i) => mapStrings(v, fn, [...keys, i]));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn, [...keys, k])]));
  return value;
}

function createSecrets(safeStorage) {
  const available = () => {
    try {
      return !!safeStorage?.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  const encrypt = (s) => (available() && s && !s.startsWith(PREFIX) ? PREFIX + safeStorage.encryptString(s).toString('base64') : s);
  const decrypt = (s) => {
    if (!s.startsWith(PREFIX)) return s;
    try {
      return safeStorage.decryptString(Buffer.from(s.slice(PREFIX.length), 'base64'));
    } catch {
      return ''; // расшифровать нельзя (файл с другого компьютера) — ключ придётся ввести заново
    }
  };
  return {
    available,
    // Для записи в файл: секреты — зашифрованные
    seal: (obj) => mapStrings(obj, (s, keys) => (isSecret(keys) ? encrypt(s) : s)),
    // Из файла: секреты — расшифрованные
    open: (obj) => mapStrings(obj, (s, keys) => (isSecret(keys) ? decrypt(s) : s)),
    // Расшифровать секреты прямо в объекте настроек (в памяти программы — обычные значения)
    openInto(obj) {
      const walk = (node, keys) => {
        if (!node || typeof node !== 'object') return;
        for (const [k, v] of Object.entries(node)) {
          if (typeof v === 'string' && isSecret([...keys, k])) node[k] = decrypt(v);
          else walk(v, [...keys, k]);
        }
      };
      walk(obj, []);
      return obj;
    },
    // Есть ли в объекте секреты открытым текстом (старый файл) — тогда перезаписать зашифрованными
    hasPlain: (obj) => {
      let found = false;
      mapStrings(obj, (s, keys) => (isSecret(keys) && s && !s.startsWith(PREFIX) && (found = true), s));
      return found;
    },
  };
}

// Без шифрования (тесты, скрипты) — всё как есть
const plainSecrets = { available: () => false, seal: (o) => o, open: (o) => o, openInto: (o) => o, hasPlain: () => false };

module.exports = { createSecrets, plainSecrets, isSecret, PREFIX };
