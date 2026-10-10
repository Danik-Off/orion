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
}

export function createStore(api: Jarvis) {
  let state: SettingsState = { values: {}, skills: [], models: [], version: '', restart: false, error: '' };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<SettingsState>) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };

  async function load() {
    const r = await api.settingsGet();
    if (!r) return;
    const values: Record<string, unknown> = { ...(r.values || {}) };
    // Навыки — тоже значения: skills.<id> → включён ли (страница «Навыки» — обычные переключатели)
    for (const s of r.skills || []) values[`skills.${s.id}`] = s.enabled;
    set({ values, skills: r.skills || [], models: r.models || [], version: r.version || '' });
  }

  // → true — сохранено; false — ядро отказало (текст ошибки — в state.error)
  async function save(patch: Record<string, unknown>): Promise<boolean> {
    set({ error: '' });
    const r = await api.settingsSave(patch);
    if (!r?.ok) {
      set({ error: r?.error || 'Не удалось сохранить.' });
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
