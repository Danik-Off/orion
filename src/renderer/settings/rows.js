// Строки настроек: описание → элемент. Страница (pages/*.js) — список таких описаний, без разметки.
//
// Общие поля описания: key — ключ настройки (как в config.json), label, hint, keywords (для поиска),
// when(values) → показывать ли строку, wide — управление под подписью во всю ширину.
// Свой вид строки — custom(render): render(ctx) → элемент управления.

// --- описания ---
export const toggle = (key, label, o = {}) => ({ type: 'toggle', key, label, ...o });
// options: [[значение, подпись]] или (state) → такой список; number — значение числом
export const select = (key, label, options, o = {}) => ({ type: 'select', key, label, options, ...o });
export const range = (key, label, o) => ({ type: 'range', key, label, ...o });
export const text = (key, label, o = {}) => ({ type: 'text', key, label, ...o });
export const secret = (key, label, o = {}) => ({ type: 'secret', key, label, ...o });
export const hotkey = (key, label, o = {}) => ({ type: 'hotkey', key, label, ...o });
// run(ctx) — что сделать по кнопке; button — подпись кнопки
export const action = (label, run, o = {}) => ({ type: 'action', label, run, ...o });
export const custom = (label, render, o = {}) => ({ type: 'custom', label, render, ...o });

// --- отрисовка ---
const el = (tag, cls, textContent) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (textContent !== undefined) e.textContent = textContent;
  return e;
};

// Подпись сочетания: CommandOrControl+Alt+J → Ctrl + Alt + J
const prettyHotkey = (accel) =>
  String(accel || '')
    .replace('CommandOrControl', 'Ctrl')
    .replace('Super', 'Win')
    .split('+')
    .join(' + ');
const KEY_NAMES = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '+': 'Plus' };

// Сочетание клавиш из события: Ctrl+Alt+J → CommandOrControl+Alt+J; null — ещё не сочетание
function accelerator(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
  const mods = [e.ctrlKey && 'CommandOrControl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  if (!mods.length && !/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) return '';
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

// Элемент управления строки; refresh(state) — обновить значение после загрузки или чужого сохранения
function control(row, ctx) {
  const { store } = ctx;
  const value = () => store.get(row.key);
  switch (row.type) {
    case 'toggle': {
      const wrap = el('label', 'toggle');
      const box = el('input');
      box.type = 'checkbox';
      box.setAttribute('aria-label', row.label);
      box.addEventListener('change', async () => {
        if (!(await store.save({ [row.key]: box.checked }))) box.checked = !box.checked;
      });
      wrap.append(box, el('span'));
      return { node: wrap, refresh: () => (box.checked = value() !== false) };
    }
    case 'select': {
      const sel = el('select', 'input');
      sel.setAttribute('aria-label', row.label);
      const fill = (state) => {
        const options = typeof row.options === 'function' ? row.options(state) : row.options;
        const current = String(value() ?? '');
        const list = options.some(([v]) => String(v) === current) || !current ? options : [[current, current], ...options];
        sel.replaceChildren(...list.map(([v, label]) => new Option(label, String(v))));
        sel.value = current;
      };
      sel.addEventListener('change', async () => {
        const v = row.number ? Number(sel.value) : sel.value;
        if (!(await store.save({ [row.key]: v }))) sel.value = String(value() ?? '');
      });
      return { node: sel, refresh: fill };
    }
    case 'range': {
      const wrap = el('div', 'row-control');
      const input = el('input');
      Object.assign(input, { type: 'range', min: row.min, max: row.max, step: row.step });
      input.setAttribute('aria-label', row.label);
      const out = el('span', 'row-value');
      const show = (v) => (out.textContent = row.format ? row.format(Number(v)) : String(v));
      input.addEventListener('input', () => show(input.value));
      input.addEventListener('change', async () => {
        if (!(await store.save({ [row.key]: Number(input.value) }))) input.value = value();
        show(input.value);
      });
      wrap.append(input, out);
      return {
        node: wrap,
        refresh: () => {
          input.value = value() ?? row.min;
          show(input.value);
        },
      };
    }
    case 'text': {
      const input = el('input', 'input');
      Object.assign(input, { placeholder: row.placeholder || '', maxLength: row.maxLength || 300, spellcheck: false });
      input.setAttribute('aria-label', row.label);
      input.addEventListener('change', async () => {
        const v = input.value.trim();
        if ((v === '' && !row.allowEmpty) || v === (value() ?? '')) return (input.value = value() ?? '');
        if (!(await store.save({ [row.key]: v }))) input.value = value() ?? '';
      });
      return { node: input, refresh: () => document.activeElement !== input && (input.value = value() ?? '') };
    }
    case 'secret': {
      const input = el('input', 'input');
      Object.assign(input, { type: 'password', autocomplete: 'off', spellcheck: false });
      input.setAttribute('aria-label', row.label);
      input.addEventListener('change', async () => {
        const v = input.value.trim();
        if (v && (await store.save({ [row.key]: v }))) input.value = '';
      });
      // Ключ окну не отдаётся — видно лишь, сохранён ли он; пустое поле ключ не меняет
      return { node: input, refresh: (state) => (input.placeholder = state.values[`${row.key}:set`] ? 'ключ сохранён' : 'не задан') };
    }
    case 'hotkey': {
      const input = el('input', 'input');
      input.readOnly = true;
      input.setAttribute('aria-label', row.label);
      input.addEventListener('focus', () => (input.value = 'Нажмите сочетание…'));
      input.addEventListener('blur', () => (input.value = prettyHotkey(value())));
      input.addEventListener('keydown', async (e) => {
        e.preventDefault();
        if (e.key === 'Escape') return input.blur();
        const accel = accelerator(e);
        if (accel === null) return;
        if (!accel) return (input.value = 'Нужен Ctrl, Alt или Shift…');
        input.blur();
        if (accel !== value()) await store.save({ [row.key]: accel });
        input.value = prettyHotkey(value());
      });
      return { node: input, refresh: () => document.activeElement !== input && (input.value = prettyHotkey(value())) };
    }
    case 'action': {
      const btn = el('button', `btn${row.primary ? ' primary' : ''}`, row.button || row.label);
      btn.type = 'button';
      btn.addEventListener('click', () => row.run(ctx));
      return { node: btn, refresh: () => {} };
    }
    case 'custom':
      return row.render(ctx);
    default:
      throw new Error(`Неизвестный вид строки: ${row.type}`);
  }
}

// Строка целиком: подпись и пояснение слева, управление справа. → { node, refresh(state) }
export function renderRow(row, ctx) {
  const node = el('div', `row${row.wide ? ' wide' : ''}`);
  if (row.key) node.dataset.key = row.key;
  const textBox = el('div', 'row-text');
  if (row.label) textBox.append(el('span', 'row-label', row.label));
  const hint = el('span', 'row-hint');
  textBox.append(hint);
  const c = control(row, ctx);
  const box = c.node.classList?.contains('row-control') ? c.node : el('div', 'row-control');
  if (box !== c.node) box.append(c.node);
  node.append(textBox, box);
  const refresh = (state) => {
    node.hidden = row.when ? !row.when(state.values, state) : false;
    const h = typeof row.hint === 'function' ? row.hint(state.values, state) : row.hint || '';
    hint.textContent = h;
    hint.hidden = !h;
    c.refresh(state);
  };
  return { node, refresh };
}

// Текст строки для поиска
export const searchText = (row) => [row.label, typeof row.hint === 'string' ? row.hint : '', row.keywords || ''].join(' ').toLowerCase();
