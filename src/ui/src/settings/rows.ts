// Описания строк настроек. Страница (pages/*) — список таких описаний, без разметки; рисует их Row.tsx.
// key — ключ настройки (как в config.json), label, hint, keywords (для поиска), when(values) — показывать ли,
// wide — управление под подписью во всю ширину. Свой вид строки — custom(Component).
import type { ComponentType } from 'react';
import type { Jarvis } from '../bridge.ts';
import type { SettingsState, Store } from './store.ts';

export type Values = Record<string, unknown>;
export interface Ctx {
  api: Jarvis;
  store: Store;
}
type Hint = string | ((v: Values, s: SettingsState) => string);
interface Base {
  label: string;
  hint?: Hint;
  keywords?: string;
  when?: (v: Values, s: SettingsState) => boolean;
  wide?: boolean;
}
export type Row =
  | (Base & { type: 'toggle'; key: string })
  | (Base & {
      type: 'select';
      key: string;
      options: [string | number, string][] | ((s: SettingsState) => [string | number, string][]);
      number?: boolean;
    })
  | (Base & { type: 'range'; key: string; min: number; max: number; step: number; format?: (v: number) => string })
  | (Base & { type: 'text'; key: string; placeholder?: string; maxLength?: number; allowEmpty?: boolean })
  | (Base & { type: 'secret'; key: string })
  | (Base & { type: 'hotkey'; key: string })
  | (Base & { type: 'action'; run: (ctx: Ctx) => void; button?: string; primary?: boolean })
  | (Base & { type: 'custom'; render: ComponentType<{ ctx: Ctx }> });

type Opts = Omit<Base, 'label'>;
export const toggle = (key: string, label: string, o: Opts = {}): Row => ({ type: 'toggle', key, label, ...o });
export const select = (
  key: string,
  label: string,
  options: [string | number, string][] | ((s: SettingsState) => [string | number, string][]),
  o: Opts & { number?: boolean } = {},
): Row => ({ type: 'select', key, label, options, ...o });
export const range = (
  key: string,
  label: string,
  o: Opts & { min: number; max: number; step: number; format?: (v: number) => string },
): Row => ({
  type: 'range',
  key,
  label,
  ...o,
});
export const text = (
  key: string,
  label: string,
  o: Opts & { placeholder?: string; maxLength?: number; allowEmpty?: boolean } = {},
): Row => ({
  type: 'text',
  key,
  label,
  ...o,
});
export const secret = (key: string, label: string, o: Opts = {}): Row => ({ type: 'secret', key, label, ...o });
export const hotkey = (key: string, label: string, o: Opts = {}): Row => ({ type: 'hotkey', key, label, ...o });
export const action = (label: string, run: (ctx: Ctx) => void, o: Opts & { button?: string; primary?: boolean } = {}): Row => ({
  type: 'action',
  label,
  run,
  ...o,
});
export const custom = (label: string, render: ComponentType<{ ctx: Ctx }>, o: Opts = {}): Row => ({ type: 'custom', label, render, ...o });

export interface Section {
  title?: string;
  note?: string;
  when?: (v: Values, s: SettingsState) => boolean;
  rows: Row[] | ((s: SettingsState) => Row[]);
}
export interface Page {
  id: string;
  group: 'assistant' | 'brain' | 'system';
  title: string;
  icon: string;
  description?: string;
  keywords?: string;
  sections?: Section[];
  Render?: ComponentType<{ ctx: Ctx }>; // раздел со своим видом (Компоненты, Модели на компьютере, Подключения)
}

export const rowsOf = (section: Section, s: SettingsState): Row[] => (typeof section.rows === 'function' ? section.rows(s) : section.rows);
export const hintOf = (row: Row, s: SettingsState): string => (typeof row.hint === 'function' ? row.hint(s.values, s) : row.hint || '');
export const searchText = (row: Row): string =>
  [row.label, typeof row.hint === 'string' ? row.hint : '', row.keywords || ''].join(' ').toLowerCase();
