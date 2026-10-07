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
const oneOf =
  (...list) =>
  (v) =>
    list.includes(v) ? v : undefined;
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
// Можно и пусто (адрес внешней модели, когда она не нужна)
const textOrEmpty = (max) => (v) => {
  const s = String(v ?? '').trim();
  return s.length <= max ? s : undefined;
};
const url = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  try {
    return ['http:', 'https:'].includes(new URL(s).protocol) ? s : undefined;
  } catch {
    return undefined;
  }
};

// live: применяется сразу; иначе — после перезапуска. Горячая клавиша проверяется отдельно (регистрацией).
// secret: значение в окно не отдаётся (видно лишь, задано ли оно), пустое при сохранении — «не менять».
const FIELDS = {
  name: { check: text(20), live: false },
  city: { check: text(60), live: true },
  // Не уверена маленькая модель — передавать ли большой (иначе отвечает она одна)
  escalate: { check: bool, live: true },
  // Большая модель: Qwen на этом компьютере, Ollama, внешняя по API или без неё. Выбирается при каждом запросе
  backend: { check: oneOf('llamacpp', 'ollama', 'remote', 'none'), live: true },
  'remote.type': { check: oneOf('openai', 'anthropic'), live: true },
  'remote.baseUrl': { check: url, live: true },
  'remote.model': { check: textOrEmpty(120), live: true },
  'remote.apiKey': { check: textOrEmpty(400), live: true, secret: true },
  ollamaUrl: { check: url, live: true },
  // Комбинирование: локальная модель не справилась — спросить внешнюю (по разрешению)
  'cloud.enabled': { check: bool, live: true },
  'cloud.ask': { check: bool, live: true },
  brainOffer: { check: bool, live: true },
  lastVersion: { check: (v) => (/^\d+\.\d+\.\d+$/.test(String(v)) ? String(v) : undefined), live: true }, // навык updates: с какой версии обновились
  // Маленькая модель (быстрые команды) и разбор большой
  'router.enabled': { check: bool, live: true },
  'router.collect': { check: bool, live: true },
  'router.minConfidence': { check: number(0.5, 0.99, 0.01), live: true },
  planner: { check: oneOf('single', 'two-step'), live: true },
  llmIdleMinutes: { check: number(0, 120, 1), live: false },
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
    for (const [key, field] of Object.entries(FIELDS)) {
      const v = get(config, key.split('.'));
      if (field.secret)
        out[`${key}:set`] = !!v; // сам ключ окну не нужен
      else out[key] = v;
    }
    return out;
  };
  const skillList = () => skills.map((s) => ({ id: s.id, title: s.title || s.id, enabled: config.skills?.[s.id]?.enabled !== false }));

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
      if (field?.secret && String(raw ?? '').trim() === '') continue; // пусто — оставить прежний ключ
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
      // Включили передачу большой модели, а она не выбрана — по умолчанию своя, на этом компьютере
      if (key === 'escalate' && value && (config.backend === 'none' || !config.backend)) changes.push([['backend'], 'llamacpp']);
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

  // Запись по пути без проверки поля — для составных настроек, у которых свой разбор (серверы MCP).
  // value === undefined — удалить ключ
  function setPath(keys, value) {
    const user = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const target of [config, user]) {
      if (value === undefined) {
        const parent = get(target, keys.slice(0, -1));
        if (parent && typeof parent === 'object') delete parent[keys.at(-1)];
      } else set(target, keys, value);
    }
    fs.writeFileSync(file, `${JSON.stringify(user, null, 2)}\n`);
  }

  return { values, skills: skillList, save, setPath };
}

module.exports = { createSettings };
