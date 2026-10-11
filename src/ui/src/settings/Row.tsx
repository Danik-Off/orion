// Строка настроек: подпись и пояснение слева, управление справа. И кирпичи для разделов со своим видом:
// Section, Line, useActions — чтобы «Подключения» и «Модели на компьютере» выглядели как остальные.
import { useEffect, useState, type ReactNode } from 'react';
import type { Ctx, Row, Section as SectionDef } from './rows.ts';
import { hintOf, rowsOf } from './rows.ts';
import type { SettingsState } from './store.ts';
import { Button, Select, TextField, Toggle } from '../kit/controls.tsx';

// Подпись сочетания: CommandOrControl+Alt+J → Ctrl + Alt + J
const prettyHotkey = (accel: unknown) =>
  String(accel || '')
    .replace('CommandOrControl', 'Ctrl')
    .replace('Super', 'Win')
    .split('+')
    .join(' + ');
const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  '+': 'Plus',
};
// Сочетание из события: Ctrl+Alt+J → CommandOrControl+Alt+J; null — ещё не сочетание; '' — нужен Ctrl, Alt или Win.
// Shift в одиночку не годится: Shift+A — это заглавная «A», а глобальное сочетание отняло бы её у всех программ
function accelerator(e: React.KeyboardEvent): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
  const mods = [e.ctrlKey && 'CommandOrControl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  const strong = e.ctrlKey || e.altKey || e.metaKey;
  if (!strong && !/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) return '';
  const key =
    KEY_NAMES[e.key] ||
    (e.code.startsWith('Key')
      ? e.code.slice(3)
      : e.code.startsWith('Digit')
        ? e.code.slice(5)
        : e.key.length === 1
          ? e.key.toUpperCase()
          : e.key);
  return [...mods, key].join('+');
}

function Control({ row, ctx, s }: { row: Row; ctx: Ctx; s: SettingsState }) {
  const { store } = ctx;
  const value = 'key' in row ? s.values[row.key] : undefined;
  const [draft, setDraft] = useState<string>('');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(row.type === 'range' ? String(value ?? row.min) : String(value ?? ''));
  }, [value, editing, row]);

  switch (row.type) {
    case 'toggle':
      return (
        <Toggle
          checked={s.loaded ? value !== false : false}
          label={row.label}
          disabled={!s.loaded}
          onChange={(on) => void store.save({ [row.key]: on })}
        />
      );
    case 'select': {
      const options = typeof row.options === 'function' ? row.options(s) : row.options;
      const current = String(value ?? '');
      const list =
        options.some(([v]) => String(v) === current) || !current ? options : ([[current, current], ...options] as [string, string][]);
      return (
        <Select
          options={list}
          value={current}
          aria-label={row.label}
          onChange={(e) => void store.save({ [row.key]: row.number ? Number(e.target.value) : e.target.value })}
        />
      );
    }
    case 'range':
      return (
        <span className="range">
          <input
            type="range"
            min={row.min}
            max={row.max}
            step={row.step}
            value={draft}
            aria-label={row.label}
            onChange={(e) => {
              setEditing(true);
              setDraft(e.target.value);
            }}
            onPointerUp={() => {
              setEditing(false);
              void store.save({ [row.key]: Number(draft) });
            }}
            onKeyUp={() => {
              setEditing(false);
              void store.save({ [row.key]: Number(draft) });
            }}
          />
          <span className="range-value">{row.format ? row.format(Number(draft)) : draft}</span>
        </span>
      );
    case 'text':
      return (
        <TextField
          value={draft}
          placeholder={row.placeholder}
          maxLength={row.maxLength || 300}
          aria-label={row.label}
          onFocus={() => setEditing(true)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={async () => {
            setEditing(false);
            const v = draft.trim();
            if ((v === '' && !row.allowEmpty) || v === String(value ?? '')) return setDraft(String(value ?? ''));
            // Не сохранилось — набранное остаётся в поле, причина видна под строкой: можно поправить
            if (!(await store.save({ [row.key]: v }))) setDraft(v);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      );
    case 'secret':
      // Ключ окну не отдаётся — видно лишь, сохранён ли он; пустое поле ключ не меняет
      return (
        <TextField
          type="password"
          autoComplete="off"
          value={draft === String(value ?? '') ? '' : draft}
          placeholder={s.values[`${row.key}:set`] ? 'ключ сохранён' : 'не задан'}
          aria-label={row.label}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={async () => {
            const v = draft.trim();
            if (v && (await store.save({ [row.key]: v }))) setDraft('');
          }}
        />
      );
    case 'hotkey':
      return (
        <TextField
          readOnly
          value={editing ? draft : prettyHotkey(value)}
          aria-label={row.label}
          onFocus={() => {
            setEditing(true);
            setDraft('Нажмите сочетание…');
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={async (e) => {
            // Tab и Shift+Tab — уйти из поля, как из любого другого (иначе клавиатурой отсюда не выбраться)
            if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) return;
            e.preventDefault();
            if (e.key === 'Escape') return (e.target as HTMLInputElement).blur();
            const accel = accelerator(e);
            if (accel === null) return;
            if (!accel) return setDraft('Нужен Ctrl, Alt или Win…');
            (e.target as HTMLInputElement).blur();
            if (accel !== value) await store.save({ [row.key]: accel });
          }}
        />
      );
    case 'action':
      return (
        <Button variant={row.primary ? 'primary' : 'secondary'} onClick={() => row.run(ctx)}>
          {row.button || row.label}
        </Button>
      );
    case 'custom': {
      const C = row.render;
      return <C ctx={ctx} />;
    }
  }
}

export function RowView({ row, ctx, s, flash = false }: { row: Row; ctx: Ctx; s: SettingsState; flash?: boolean }) {
  if (row.when && !row.when(s.values, s)) return null;
  const hint = hintOf(row, s);
  const error = 'key' in row ? s.errors[row.key] : '';
  return (
    <div className={`row${row.wide ? ' wide' : ''}${flash ? ' flash' : ''}`} data-key={'key' in row ? row.key : undefined}>
      <div className="row-text">
        <span className="row-label">{row.label}</span>
        {error ? (
          <span className="row-hint warn" role="alert">
            {error}
          </span>
        ) : (
          hint && <span className="row-hint">{hint}</span>
        )}
      </div>
      <div className="row-control">
        <Control row={row} ctx={ctx} s={s} />
      </div>
    </div>
  );
}

export function SectionView({ section, ctx, s }: { section: SectionDef; ctx: Ctx; s: SettingsState }) {
  if (section.when && !section.when(s.values, s)) return null;
  return (
    <Section title={section.title} note={section.note}>
      {rowsOf(section, s).map((row, i) => (
        <RowView key={'key' in row ? row.key : `${row.label}-${i}`} row={row} ctx={ctx} s={s} />
      ))}
    </Section>
  );
}

// --- кирпичи для разделов со своим видом ---
export function Section({ title, note, children }: { title?: string; note?: string; children: ReactNode }) {
  return (
    <section className="section">
      {title && <h2>{title}</h2>}
      {note && <p className="note">{note}</p>}
      <div className="card-list">{children}</div>
    </section>
  );
}

export function Line({
  label,
  hint,
  warn = false,
  wide = false,
  mono,
  dot,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  warn?: boolean;
  wide?: boolean;
  mono?: string;
  dot?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`row${wide ? ' wide' : ''}`}>
      <div className="row-text">
        <span className="row-label">
          {dot && <span className={`dot dot-${dot}`} />}
          {label}
        </span>
        {hint && <span className={`row-hint${warn ? ' warn' : ''}`}>{hint}</span>}
        {mono && <span className="row-hint mono">{mono}</span>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}

// Раздел загружается или загрузка не удалась — вместо пустой страницы
export function LoadState({ failed, retry }: { failed: string; retry: () => void }) {
  return (
    <div className="page-state" role="status">
      {failed ? (
        <>
          <span>Не удалось загрузить: {failed}</span>
          <Button onClick={retry}>Повторить</Button>
        </>
      ) : (
        <span>Загружаю…</span>
      )}
    </div>
  );
}

// Действия с кнопками: пока идёт — подпись «…», ответ ядра — новые данные, ошибка — у строки, где нажали
export function useActions<T>(setData: (r: T) => void) {
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  async function act(key: string, label: string, fn: () => Promise<unknown>) {
    setBusy((b) => ({ ...b, [key]: label }));
    setErrors(({ [key]: _gone, ...rest }) => rest);
    const r = (await fn().catch((e: unknown) => ({ ok: false, error: String((e as Error)?.message || e) }))) as {
      ok?: boolean;
      error?: string;
    } | null;
    setBusy(({ [key]: _done, ...rest }) => rest);
    if (r && typeof r === 'object') setData(r as T);
    if (r && r.ok === false) setErrors((x) => ({ ...x, [key]: r.error || 'Не получилось.' }));
    return r;
  }
  // armed: кнопка с подтверждением (удалить гигабайты модели) — первое нажатие спрашивает «Точно удалить?»,
  // второе в течение 4 с — делает
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const button = (key: string, label: string, busyLabel: string, fn: () => Promise<unknown>, primary = false, confirm = '') => (
    <Button
      key={key}
      variant={armed === key ? 'danger' : primary ? 'primary' : 'secondary'}
      disabled={key in busy}
      onClick={() => {
        if (confirm && armed !== key) return setArmed(key);
        setArmed(null);
        void act(key, busyLabel, fn);
      }}
    >
      {busy[key] || (armed === key ? confirm : label)}
    </Button>
  );
  const error = (...keys: string[]) => keys.map((k) => errors[k]).find(Boolean) || '';
  return { act, button, error };
}
