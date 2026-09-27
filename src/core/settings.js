// Настройки из окна: что можно менять, проверка значений и запись в config.json.
// Меняется живой объект config (модули читают его при каждом вызове), в config.json пишутся только изменённые ключи.
const fs = require('node:fs');

const text = (max) => (v) => {
  const s = String(v ?? '').trim();
  return s && s.length <= max ? s : undefined;
};
const number = (min, max, step) => (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return step ? Number((Math.round(n / step) * step).toFixed(2)) : n;
};
const oneOf = (...list) => (v) => (list.includes(v) ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);

// live: применяется сразу; иначе — после перезапуска. Горячая клавиша проверяется отдельно (регистрацией).
const FIELDS = {
  name: { check: text(20), live: false },
  city: { check: text(60), live: true },
  backend: { check: oneOf('llamacpp', 'ollama'), live: false }, // движок: при запуске докачает недостающее
  model: { check: text(80), live: true }, // у llama.cpp другая модель — это перезапуск сервера (см. save)
  hotkey: { check: text(60), live: true },
  'speech.ttsSpeed': { check: number(0.6, 1.6, 0.05), live: true },
  'speech.ttsSpeaker': { check: number(0, 9, 1), live: true },
  'speech.ttsSteps': { check: oneOf(8, 12, 16), live: true },
  'speech.stress': { check: bool, live: true },
  'speech.followUpSeconds': { check: number(3, 20, 1), live: true },
  'speech.listenOnStart': { check: bool, live: true }, // действует при следующем запуске, перезапуск не нужен
  'speech.echoCancellation': { check: bool, live: false },
  'speech.vadThreshold': { check: number(0.15, 0.6, 0.05), live: false },
  'speech.speaker.require': { check: oneOf('off', 'followup', 'always'), live: true },
  'updates.notify': { check: bool, live: true },
};

const get = (obj, keys) => keys.reduce((o, k) => o?.[k], obj);
function set(obj, keys, value) {
  const last = keys.at(-1);
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === 'object' ? o[k] : (o[k] = {});
  o[last] = value;
}

function createSettings({ config, file, skills, setHotkey }) {
  const values = () => {
    const out = {};
    for (const key of Object.keys(FIELDS)) out[key] = get(config, key.split('.'));
    return out;
  };
  const skillList = () =>
    skills.map((s) => ({ id: s.id, title: s.title || s.id, enabled: config.skills?.[s.id]?.enabled !== false }));

  // patch: { 'speech.ttsSpeed': 1.1, 'skills.music': false } → { ok, restart, error? }
  function save(patch) {
    const changes = [];
    let restart = false;
    for (const [key, raw] of Object.entries(patch || {})) {
      if (key.startsWith('skills.')) {
        const id = key.slice(7);
        if (!skills.some((s) => s.id === id) || typeof raw !== 'boolean') return { ok: false, error: `Неизвестный навык: ${id}` };
        changes.push([['skills', id, 'enabled'], raw]);
        restart = true; // список навыков собирается при запуске
        continue;
      }
      const field = FIELDS[key];
      const value = field?.check(raw);
      if (value === undefined) return { ok: false, error: `Недопустимое значение: ${key}` };
      const keys = key.split('.');
      const old = get(config, keys);
      if (old === value) continue;
      if (key === 'hotkey' && !setHotkey(value)) return { ok: false, error: `Сочетание ${value} занято другой программой` };
      // Узнавание голоса загружается при запуске: включить его из «выключено» можно только перезапуском
      if (key === 'speech.speaker.require' && (old === 'off' || value === 'off')) restart = true;
      if (!field.live) restart = true;
      // llama.cpp загружает модель при запуске, а новую, возможно, ещё надо скачать
      if (key === 'model' && config.backend !== 'ollama') restart = true;
      changes.push([keys, value]);
      // Новое имя — новое слово отклика (в окне так и обещано: «на него же откликается голосом»)
      if (key === 'name') changes.push([['speech', 'wakeWords'], [value.toLowerCase()]]);
    }
    if (!changes.length) return { ok: true, restart: false };

    const user = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [keys, value] of changes) {
      set(config, keys, value);
      set(user, keys, value);
    }
    fs.writeFileSync(file, `${JSON.stringify(user, null, 2)}\n`);
    return { ok: true, restart };
  }

  return { values, skills: skillList, save };
}

module.exports = { createSettings };
