// Компоненты: что скачано и что можно докачать (большую модель — в том числе); ход загрузки — прямо здесь
export default {
  id: 'components',
  group: 'system',
  title: 'Компоненты',
  icon: 'components',
  description: 'Части ассистента на этом компьютере. Недостающее можно докачать в любой момент.',
  keywords: 'скачать установить qwen модель голос слух загрузка',
  render,
};

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// → { node, refresh, dispose } — страница целиком; обновляется по событиям установки из ядра
function render({ api }) {
  const card = el('div', 'card');
  const rows = new Map(); // stage → { progress, status }
  let current = null; // этап, который сейчас качается

  async function draw() {
    const r = await api.components();
    if (!r) return;
    rows.clear();
    card.replaceChildren(
      ...r.stages.map((c) => {
        const row = el('div', 'row');
        const text = el('div', 'row-text');
        text.append(el('span', 'row-label', c.title));
        const status = el('span', 'row-hint', c.installed ? '' : `Не установлено · ${c.size}`);
        status.hidden = c.installed;
        text.append(status);
        const control = el('div', 'row-control');
        const progress = el('div', 'progress');
        progress.append(el('span'));
        progress.hidden = true;
        control.append(progress);
        if (c.installed) control.append(el('span', 'status-ok', 'установлено'));
        else {
          const btn = el('button', 'btn', r.installing ? 'Идёт установка…' : `Скачать`);
          btn.type = 'button';
          btn.disabled = r.installing;
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            const res = await api.installComponent(c.stage);
            if (!res?.ok) {
              status.textContent = res?.error || 'Не удалось начать установку.';
              btn.disabled = false;
            } else btn.textContent = 'Скачиваю…';
          });
          control.append(btn);
        }
        row.append(text, control);
        rows.set(c.stage, { progress, status });
        return row;
      }),
    );
  }

  // Ход установки: { stage, title, progress, done, error, finished }
  const off = api.onSetup((r) => {
    if (r.stage) current = r.stage;
    const row = rows.get(current);
    if (row && r.progress != null && !r.done) {
      row.progress.hidden = false;
      row.progress.firstChild.style.width = `${Math.round(r.progress * 100)}%`;
      row.status.hidden = false;
      row.status.textContent = r.title;
    }
    if (r.error && row) row.status.textContent = r.title;
    if (r.done || r.finished) draw();
  });

  draw();
  return { node: card, refresh: () => {}, dispose: () => off?.() };
}
