// Компоненты: что скачано и что можно докачать (большую модель — в том числе), и обновления частей Ориона —
// llama.cpp, быстрая модель, распознавание, голос, пакеты MCP: «Проверить всё», «Обновить», «Вернуть».
// Ход установки и обновлений приходит от ядра сам (onSetup, onUpdatesChanged).
import { el, button, row, section, actions } from '../ui.js';

export default {
  id: 'components',
  group: 'system',
  title: 'Компоненты',
  icon: 'components',
  description: 'Части ассистента на этом компьютере: докачать недостающее и обновить установленное.',
  keywords: 'скачать установить qwen модель голос слух загрузка обновить обновление версия llama.cpp распознавание',
  render,
};

const progressBar = (value) => {
  const bar = el('div', 'progress');
  const fill = el('span');
  fill.style.width = `${value}%`;
  bar.append(fill);
  return bar;
};

// → { node, refresh, dispose } — страница целиком; обновляется по событиям установки и обновлений из ядра
function render({ api }) {
  const page = el('div');
  const partsBox = el('div');
  const updatesBox = el('div');
  updatesBox.className = 'section-gap'; // между разделами — тот же отступ, что у соседних секций
  page.append(partsBox, updatesBox);

  // --- что установлено ---
  const rows = new Map(); // stage → { progress, status }
  let current = null; // этап, который сейчас качается

  async function drawParts() {
    const r = await api.components();
    if (!r) return;
    rows.clear();
    const items = r.stages.map((c) => {
      const line = row(c.title, c.installed ? '' : `Не установлено · ${c.size}`);
      const progress = progressBar(0);
      progress.hidden = true;
      line.box.append(progress);
      if (c.installed) line.box.append(el('span', 'status-ok', 'установлено'));
      else {
        const btn = button(r.installing ? 'Идёт установка…' : 'Скачать', async () => {
          btn.disabled = true;
          const res = await api.installComponent(c.stage);
          if (!res?.ok) {
            line.hint.hidden = false;
            line.hint.textContent = res?.error || 'Не удалось начать установку.';
            btn.disabled = false;
          } else btn.textContent = 'Скачиваю…';
        });
        btn.disabled = r.installing;
        line.box.append(btn);
      }
      rows.set(c.stage, { progress, status: line.hint });
      return line.node;
    });
    partsBox.replaceChildren(section('Установлено', null, items));
  }

  // --- обновления ---
  let updates = null;
  let version = '';
  const { busyButton, showError } = actions(
    () => drawUpdates(),
    (r) => r.parts && (updates = r),
  );

  function drawUpdates() {
    if (!updates) return;
    const head = row(
      updates.checking ? 'Проверяю…' : updates.updates ? `Есть обновления: ${updates.updates}` : 'Обновления',
      updates.checkedAt
        ? `Проверено ${new Date(updates.checkedAt).toLocaleString('ru-RU')}.`
        : 'Новая версия ставится рядом и включается, только если запустилась.',
    );
    head.box.append(busyButton('check', 'Проверить всё', 'Проверяю…', () => api.updatesCheck(), { primary: !updates.updates }));
    showError(head, 'check');

    const app = row(`Орион ${version}`, 'Сама программа: о новой версии спрошу голосом при запуске. Итог проверки — в окне разговора.');
    app.box.append(button('Проверить', () => api.updateCheck()));

    const items = updates.parts.map((p) => {
      const hint = [p.version, p.newer && p.latest && `доступна ${p.latest}`].filter(Boolean).join(' · ');
      const line = row(p.title, hint);
      if (p.newer) line.text.querySelector('.row-label').prepend(el('span', 'mcp-dot ok'));
      if (p.busy) line.box.append(progressBar(p.busy.progress), el('span', 'row-value', `${p.busy.progress}%`));
      else if (p.newer)
        line.box.append(busyButton(`apply:${p.id}`, 'Обновить', 'Обновляю…', () => api.updatesApply(p.id), { primary: true }));
      if (p.previous && !p.busy)
        line.box.append(busyButton(`back:${p.id}`, 'Вернуть прежнюю', 'Возвращаю…', () => api.updatesRollback(p.id)));
      if (p.error) {
        line.hint.textContent = p.error;
        line.hint.classList.add('warn');
      }
      showError(line, `apply:${p.id}`, `back:${p.id}`);
      return line.node;
    });
    updatesBox.replaceChildren(section('Обновления', null, [head.node, app.node, ...items]));
  }

  // Ход установки: { stage, title, progress, done, error, finished }
  const offSetup = api.onSetup((r) => {
    if (r.stage) current = r.stage;
    const line = rows.get(current);
    if (line && r.progress != null && !r.done) {
      line.progress.hidden = false;
      line.progress.firstChild.style.width = `${Math.round(r.progress * 100)}%`;
      line.status.hidden = false;
      line.status.textContent = r.title;
    }
    if (r.error && line) line.status.textContent = r.title;
    if (r.done || r.finished) drawParts();
  });
  const offUpdates = api.onUpdatesChanged?.((r) => {
    updates = r;
    drawUpdates();
  });

  drawParts();
  Promise.all([api.updatesList(), api.settingsGet()]).then(([u, s]) => {
    updates = u;
    version = s?.version || '';
    drawUpdates();
  });
  return {
    node: page,
    refresh: () => {},
    dispose: () => {
      offSetup?.();
      offUpdates?.();
    },
  };
}
