// Подключения MCP: каталог серверов, которые ставятся одной кнопкой и подключаются сразу, свои серверы и
// установленные. Сторонний сервер — чужая программа: действия с последствиями я выполняю только с разрешения
// (если не включено «без вопросов»).
export default {
  id: 'connections',
  group: 'brain',
  title: 'Подключения',
  icon: 'connections',
  description: 'Новые умения из MCP-серверов: ставятся одной кнопкой и сразу доступны голосом.',
  keywords: 'mcp сервер каталог магазин установить плагин расширение',
  render,
};

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const button = (label, onClick, primary = false) => {
  const b = el('button', `btn${primary ? ' primary' : ''}`, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const input = (placeholder, secret = false) => {
  const i = el('input', 'input');
  Object.assign(i, { placeholder: placeholder || '', spellcheck: false, autocomplete: 'off' });
  if (secret) i.type = 'password';
  return i;
};
// Строка: подпись и пояснение слева, управление справа (как у остальных настроек)
function row(label, hint, controls = [], wide = false) {
  const r = el('div', `row${wide ? ' wide' : ''}`);
  const text = el('div', 'row-text');
  text.append(el('span', 'row-label', label));
  const h = el('span', 'row-hint', hint || '');
  h.hidden = !hint;
  text.append(h);
  const box = el('div', 'row-control');
  box.append(...controls);
  r.append(text, box);
  return { node: r, hint: h };
}
const section = (title, note, rows) => {
  const s = el('section', 'section');
  s.append(el('h2', '', title));
  if (note) s.append(el('p', 'note', note));
  const card = el('div', 'card');
  card.append(...rows);
  s.append(card);
  return s;
};

const statusText = (s) => {
  if (!s.status) return s.enabled ? 'подключается…' : 'выключен';
  if (!s.status.ok) return `ошибка: ${s.status.error}`;
  const tools = s.status.tools || [];
  return `подключён · ${tools.length ? tools.slice(0, 6).join(', ') + (tools.length > 6 ? '…' : '') : 'без инструментов'}`;
};

function render({ api, store }) {
  const page = el('div');
  let data = null;

  // Ответ ядра на действие: { ok, error?, ...список } — перерисовать; ошибка — в строке, где нажали
  const apply = (r, hint) => {
    if (!r) return;
    data = r;
    if (r.restart) store.markRestart();
    draw();
    if (!r.ok && hint) {
      hint.hidden = false;
      hint.textContent = r.error;
    }
  };

  function installed() {
    if (!data.servers.length) return null;
    return section(
      'Установлено',
      null,
      data.servers.map((s) => {
        const trust = el('label', 'toggle');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = s.trust;
        box.title = 'Без вопросов';
        box.setAttribute('aria-label', `Выполнять действия ${s.title} без вопроса`);
        box.addEventListener('change', async () => apply(await api.mcpTrust(s.name, box.checked)));
        trust.append(box, el('span'));
        const r = row(s.title, statusText(s), [el('small', 'row-hint', 'без вопросов'), trust]);
        r.node.querySelector('.row-control').append(button('Удалить', async () => apply(await api.mcpRemove(s.name), r.hint)));
        if (s.status && !s.status.ok) r.hint.classList.add('warn');
        return r.node;
      }),
    );
  }

  function catalog() {
    const have = new Set(data.servers.map((s) => s.catalog || s.name));
    const byCategory = new Map();
    for (const c of data.catalog) {
      const fields = (c.inputs || []).map((f) => ({ ...f, node: input(f.placeholder || f.label, f.secret) }));
      const needsNode = c.runtime === 'node';
      const hint = `${c.description} ${needsNode ? 'Нужен Node.js.' : 'Работает по интернету, ставить ничего не нужно.'}`;
      const controls = have.has(c.id)
        ? [el('span', 'status-ok', 'установлено')]
        : [
            ...fields.map((f) => f.node),
            button(
              'Установить',
              async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                btn.textContent = 'Ставлю…';
                const inputs = Object.fromEntries(fields.map((f) => [f.key, f.node.value.trim()]));
                apply(await api.mcpInstall(c.id, inputs), r.hint);
              },
              true,
            ),
          ];
      const r = row(c.title, hint, controls, fields.length > 0);
      for (const f of fields.filter((x) => x.link)) {
        const link = el('button', 'link', 'где взять ключ');
        link.type = 'button';
        link.addEventListener('click', () => api.openLink(f.link));
        r.node.querySelector('.row-text').append(link);
      }
      if (!byCategory.has(c.category)) byCategory.set(c.category, []);
      byCategory.get(c.category).push(r.node);
    }
    return [...byCategory].map(([category, rows]) => section(`Каталог · ${category}`, null, rows));
  }

  function custom() {
    const name = input('Название, например «Мой сервер»');
    const target = input('npx -y пакет …  или  https://…/mcp');
    const r = row('Свой сервер', 'Команда, которая запускает сервер, или его адрес.', [name, target], true);
    r.node.querySelector('.row-control').append(button('Добавить', async () => apply(await api.mcpAdd(name.value, target.value), r.hint)));
    return section('Свой сервер', null, [r.node]);
  }

  function draw() {
    const parts = [];
    if (!data.node) {
      const r = row('Нужен Node.js', 'Серверы из каталога, помеченные «Нужен Node.js», запускаются через него.', [
        button('Скачать Node.js', () => api.openLink('https://nodejs.org')),
      ]);
      parts.push(section('Перед установкой', null, [r.node]));
    }
    parts.push(installed(), ...catalog(), custom());
    page.replaceChildren(...parts.filter(Boolean));
  }

  api.mcpList().then((r) => {
    data = r;
    draw();
  });
  return { node: page, refresh: () => {} };
}
