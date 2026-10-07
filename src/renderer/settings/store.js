// Значения настроек окна: загрузка из ядра, сохранение, подписка на изменения.
// Каждое поле сохраняется сразу; ядро проверяет значение и говорит, нужен ли перезапуск.

export function createStore(api = window.jarvis) {
  const state = { values: {}, skills: [], models: [], version: '', restart: false, error: '' };
  const subscribers = new Set();
  const emit = () => subscribers.forEach((fn) => fn(state));

  async function load() {
    const r = await api.settingsGet();
    if (!r) return;
    Object.assign(state, { values: r.values || {}, skills: r.skills || [], models: r.models || [], version: r.version || '' });
    // Навыки — тоже значения: skills.<id> → включён ли (строки страницы «Навыки» — обычные переключатели)
    for (const s of state.skills) state.values[`skills.${s.id}`] = s.enabled;
    emit();
  }

  // → true — сохранено; false — ядро отказало (текст ошибки — в state.error)
  async function save(patch) {
    state.error = '';
    const r = await api.settingsSave(patch);
    if (!r?.ok) {
      state.error = r?.error || 'Не удалось сохранить.';
      emit();
      return false;
    }
    for (const [key, value] of Object.entries(patch)) {
      if (key.endsWith('apiKey'))
        state.values[`${key}:set`] = true; // сам ключ окну не нужен
      else state.values[key] = value;
    }
    if (r.restart) state.restart = true;
    // У другого движка — свой список моделей; навыки и модели перечитываются целиком
    if ('backend' in patch || Object.keys(patch).some((k) => k.startsWith('skills.'))) await load();
    else emit();
    return true;
  }

  const subscribe = (fn) => (subscribers.add(fn), () => subscribers.delete(fn));
  // Изменение вне полей настроек требует перезапуска (например, удалили MCP-сервер)
  const markRestart = () => ((state.restart = true), emit());
  return { state, load, save, subscribe, markRestart, get: (key) => state.values[key] };
}
