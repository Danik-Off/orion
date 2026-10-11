// Значения настроек: загрузка из ядра, сохранение, подписка. Каждое поле сохраняется сразу;
// ядро проверяет значение и говорит, нужен ли перезапуск.
import type { Jarvis } from '../bridge.ts';

export interface SkillInfo {
  id: string;
  title: string;
  enabled: boolean;
}
export interface SettingsState {
  values: Record<string, unknown>;
  skills: SkillInfo[];
  models: string[];
  version: string;
  restart: boolean;
  error: string;
  loaded: boolean; // до загрузки переключатели не рисуются «включёнными» по умолчанию
  loadError: string;
  errors: Record<string, string>; // ошибка сохранения — у той строки, где меняли
}

export function createStore(api: Jarvis) {
  let state: SettingsState = {
    values: {},
    skills: [],
    models: [],
    version: '',
    restart: false,
    error: '',
    loaded: false,
    loadError: '',
    errors: {},
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<SettingsState>) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };

  async function load() {
    let r;
    try {
      r = await api.settingsGet();
    } catch (err) {
      set({ loadError: String((err as Error)?.message || err) });
      return;
    }
    if (!r) return set({ loadError: 'ядро не ответило' });
    const values: Record<string, unknown> = { ...(r.values || {}) };
    // Навыки — тоже значения: skills.<id> → включён ли (страница «Навыки» — обычные переключатели)
    for (const s of r.skills || []) values[`skills.${s.id}`] = s.enabled;
    set({ values, skills: r.skills || [], models: r.models || [], version: r.version || '', loaded: true, loadError: '' });
  }

  // → true — сохранено; false — ядро отказало (текст ошибки — в state.error)
  async function save(patch: Record<string, unknown>): Promise<boolean> {
    const keys = Object.keys(patch);
    const errors = { ...state.errors };
    for (const k of keys) delete errors[k];
    set({ error: '', errors });
    let r;
    try {
      r = await api.settingsSave(patch);
    } catch (err) {
      r = { ok: false, error: String((err as Error)?.message || err) };
    }
    if (!r?.ok) {
      const message = r?.error || 'Не удалось сохранить.';
      // Одна настройка — ошибка у её строки; несколько сразу — общая, наверху
      if (keys.length === 1) set({ errors: { ...state.errors, [keys[0]]: message } });
      else set({ error: message });
      return false;
    }
    const values = { ...state.values };
    for (const [key, value] of Object.entries(patch)) {
      if (key.endsWith('apiKey'))
        values[`${key}:set`] = true; // сам ключ окну не нужен
      else values[key] = value;
    }
    set({ values, restart: state.restart || !!r.restart });
    // У другого движка — свой список моделей; навыки и модели перечитываются целиком
    if ('backend' in patch || Object.keys(patch).some((k) => k.startsWith('skills.'))) await load();
    return true;
  }

  return {
    getState: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    load,
    save,
    markRestart: () => set({ restart: true }),
    get: (key: string) => state.values[key],
  };
}

export type Store = ReturnType<typeof createStore>;
