// Кирпичи для разделов настроек со своей отрисовкой (Подключения, Модели на компьютере): те же строки,
// карточки и кнопки, что у обычных разделов (rows.js), — чтобы всё выглядело одинаково.
export const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export const button = (label, onClick, { primary = false, title = '' } = {}) => {
  const b = el('button', `btn${primary ? ' primary' : ''}`, label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
};

export const toggle = (checked, label, onChange) => {
  const wrap = el('label', 'toggle');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.setAttribute('aria-label', label);
  box.title = label;
  box.addEventListener('change', () => onChange(box.checked));
  wrap.append(box, el('span'));
  return wrap;
};

// Строка: подпись и пояснение слева, управление справа → { node, text, hint, box }
export function row(label, hint, controls = [], wide = false) {
  const r = el('div', `row${wide ? ' wide' : ''}`);
  const text = el('div', 'row-text');
  text.append(el('span', 'row-label', label));
  const h = el('span', 'row-hint', hint || '');
  h.hidden = !hint;
  text.append(h);
  const box = el('div', 'row-control');
  box.append(...controls);
  r.append(text, box);
  return { node: r, text, hint: h, box };
}

export const section = (title, note, rows) => {
  const s = el('section', 'section');
  s.append(el('h2', '', title));
  if (note) s.append(el('p', 'note', note));
  const card = el('div', 'card');
  card.append(...rows);
  s.append(card);
  return s;
};

export const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

// Действия с кнопками: пока идёт — подпись «…», ответ ядра — новые данные, ошибка — в строке, где нажали.
// draw() — перерисовать страницу; setData(ответ) — принять новые данные
export function actions(draw, setData) {
  const busy = new Map(); // ключ → подпись («Скачиваю…»)
  const errors = new Map(); // ключ строки → текст ошибки
  async function act(key, label, fn) {
    busy.set(key, label);
    errors.delete(key);
    draw();
    const r = await fn().catch((e) => ({ ok: false, error: String(e?.message || e) }));
    busy.delete(key);
    if (r && typeof r === 'object') setData(r);
    if (r && r.ok === false) errors.set(key, r.error);
    draw();
    return r;
  }
  const busyButton = (key, label, busyLabel, fn, opts) => {
    const b = button(busy.get(key) || label, () => act(key, busyLabel, fn), opts);
    b.disabled = busy.has(key);
    return b;
  };
  // Ошибка последнего действия — в пояснение строки
  const showError = (r, ...keys) => {
    const key = keys.find((k) => errors.has(k));
    if (!key) return;
    r.hint.hidden = false;
    r.hint.textContent = errors.get(key);
    r.hint.classList.add('warn');
  };
  return { act, busyButton, showError };
}

// Перерисовать, когда ядро прислало новое состояние, — но не посреди ввода в поле этой страницы
export function redrawSafely(container, draw) {
  const active = document.activeElement;
  if (container.contains(active) && active.matches('input, textarea')) active.addEventListener('blur', draw, { once: true });
  else draw();
}
