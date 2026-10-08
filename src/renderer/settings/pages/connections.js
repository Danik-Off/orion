// Подключения MCP: магазин серверов (ставятся одной кнопкой и подключаются сразу), установленные — с состоянием,
// инструментами и кнопками, свой сервер и импорт готового JSON из описания сервера. Сторонний сервер — чужая
// программа: действия с последствиями я выполняю только с разрешения (если не включено «без вопросов»).
// Состояние приходит от ядра само (onMcpChanged): «подключается…» → «готов» без перезагрузки страницы.
export default {
  id: 'connections',
  group: 'brain',
  title: 'Подключения',
  icon: 'connections',
  description: 'Новые умения из MCP-серверов: ставятся одной кнопкой и сразу доступны голосом.',
  keywords: 'mcp сервер каталог магазин установить плагин расширение json импорт',
  render,
};

import { el, button, toggle, row, section, plural, actions, redrawSafely } from '../ui.js';

const toolsWord = (n) => `${n} ${plural(n, 'инструмент', 'инструмента', 'инструментов')}`;

// Состояние сервера одной строкой и класс точки
function statusOf(s) {
  if (!s.enabled) return { text: 'выключен', dot: 'off' };
  const st = s.status;
  if (!st) return { text: 'подключается…', dot: 'busy' };
  const n = st.tools.filter((t) => t.enabled).length;
  if (st.state === 'error') return { text: `ошибка: ${st.error}`, dot: 'error' };
  if (st.state === 'connecting') return { text: 'подключается…', dot: 'busy' };
  if (st.state === 'ready') return { text: `готов · ${toolsWord(n)}${st.ms ? ` · ${st.ms} мс` : ''}`, dot: 'ok' };
  return { text: `${toolsWord(n)} · запустится, когда понадобится`, dot: 'idle' };
}

function render({ api }) {
  const page = el('div');
  const head = el('div', 'mcp-head');
  const search = el('input', 'input mcp-search');
  Object.assign(search, { type: 'search', placeholder: 'Найти подключение: поиск, GitHub, заметки…', spellcheck: false });
  head.append(search);
  const body = el('div');
  page.append(head, body);

  let data = null;
  const values = new Map(); // введённое в поля каталога — переживает перерисовку
  const expanded = new Set(); // у каких серверов раскрыт список инструментов
  const { act, busyButton, showError } = actions(
    () => draw(),
    (r) => r.servers && (data = r),
  );

  const matches = (...texts) => {
    const q = search.value.trim().toLowerCase();
    return (
      !q ||
      texts.some((t) =>
        String(t || '')
          .toLowerCase()
          .includes(q),
      )
    );
  };

  function installed() {
    const items = data.servers.filter((s) => matches(s.title, s.name, s.target, ...(s.status?.tools || []).map((t) => t.title)));
    if (!items.length) return null;
    const rows = [];
    for (const s of items) {
      const st = statusOf(s);
      const r = row(s.title, st.text, [], true);
      r.text.querySelector('.row-label').prepend(el('span', `mcp-dot ${st.dot}`));
      r.text.append(el('span', 'row-hint mono', s.target));
      if (st.dot === 'error') r.hint.classList.add('warn');
      const tools = s.status?.tools || [];
      r.box.append(
        el('small', 'row-hint', 'вкл'),
        toggle(s.enabled, `Включить ${s.title}`, (on) => act(s.name, '…', () => api.mcpEnable(s.name, on))),
        el('small', 'row-hint', 'без вопросов'),
        toggle(s.trust, `Выполнять действия ${s.title} без вопроса`, (on) => act(s.name, '…', () => api.mcpTrust(s.name, on))),
      );
      if (tools.length) {
        const open = expanded.has(s.name);
        r.box.append(
          button(`${open ? 'Скрыть' : 'Инструменты'} (${tools.length})`, () => {
            if (open) expanded.delete(s.name);
            else expanded.add(s.name);
            draw();
          }),
        );
      }
      if (s.enabled) r.box.append(busyButton(`check:${s.name}`, 'Проверить', 'Проверяю…', () => api.mcpCheck(s.name)));
      if (s.package) r.box.append(busyButton(`update:${s.name}`, 'Обновить', 'Обновляю…', () => api.mcpUpdate(s.name)));
      r.box.append(busyButton(`remove:${s.name}`, 'Удалить', 'Удаляю…', () => api.mcpRemove(s.name)));
      showError(r, s.name, `check:${s.name}`, `update:${s.name}`, `remove:${s.name}`);
      rows.push(r.node);
      if (expanded.has(s.name)) rows.push(toolList(s, tools));
    }
    return section('Установлено', 'Серверы запускаются, только когда нужны, и засыпают без дела.', rows);
  }

  // Инструменты сервера: каждый можно скрыть — я не буду им пользоваться
  function toolList(s, tools) {
    const list = el('div', 'mcp-tools');
    for (const t of tools) {
      const line = el('label', 'mcp-tool');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = t.enabled;
      box.addEventListener('change', () => act(s.name, '…', () => api.mcpTool(s.name, t.name, box.checked)));
      const text = el('span', 'mcp-tool-text');
      text.append(el('span', 'row-label', t.title));
      if (t.readOnly) text.append(el('span', 'mcp-tag', 'только чтение'));
      if (t.description) text.append(el('span', 'row-hint', t.description));
      line.append(box, text);
      list.append(line);
    }
    return list;
  }

  function catalog() {
    const have = new Set(data.servers.map((s) => s.catalog || s.name));
    const byCategory = new Map();
    for (const c of data.catalog) {
      if (!matches(c.title, c.description, c.category, c.id)) continue;
      const needs =
        c.runtime === 'node' ? (data.node ? '' : ' Нужен Node.js.') : c.runtime === 'python' ? (data.uv ? '' : ' Нужен uv.') : '';
      const where = c.runtime === 'remote' ? ' Работает по интернету.' : '';
      const r = row(c.title, `${c.description}${where}${needs}`, [], (c.inputs || []).length > 0);
      if (have.has(c.id)) r.box.append(el('span', 'status-ok', 'установлено'));
      else {
        const fields = (c.inputs || []).map((f) => {
          const key = `${c.id}.${f.key}`;
          const i = el('input', 'input');
          Object.assign(i, { placeholder: f.placeholder || f.label, spellcheck: false, autocomplete: 'off', value: values.get(key) || '' });
          if (f.secret) i.type = 'password';
          i.setAttribute('aria-label', f.label);
          i.addEventListener('input', () => values.set(key, i.value));
          return { f, i };
        });
        r.box.append(
          ...fields.map((x) => x.i),
          busyButton(
            c.id,
            'Установить',
            c.runtime === 'node' ? 'Скачиваю…' : 'Подключаю…',
            () => api.mcpInstall(c.id, Object.fromEntries(fields.map(({ f, i }) => [f.key, i.value.trim()]))),
            { primary: true },
          ),
        );
        for (const { f } of fields.filter((x) => x.f.link)) {
          const link = el('button', 'link', f.secret ? 'где взять ключ' : 'подробнее');
          link.type = 'button';
          link.addEventListener('click', () => api.openLink(f.link));
          r.text.append(link);
        }
        showError(r, c.id);
      }
      if (!byCategory.has(c.category)) byCategory.set(c.category, []);
      byCategory.get(c.category).push(r.node);
    }
    return [...byCategory].map(([category, rows]) => section(`Каталог · ${category}`, null, rows));
  }

  function custom() {
    const name = el('input', 'input');
    Object.assign(name, { placeholder: 'Название, например «Мой сервер»', value: values.get('custom.name') || '' });
    name.addEventListener('input', () => values.set('custom.name', name.value));
    const target = el('input', 'input');
    Object.assign(target, {
      placeholder: 'npx -y пакет …  или  https://…/mcp',
      spellcheck: false,
      value: values.get('custom.target') || '',
    });
    target.addEventListener('input', () => values.set('custom.target', target.value));
    const one = row('Команда или адрес', 'Пакет npm поставлю к себе — будет запускаться быстро и без интернета.', [name, target], true);
    one.box.append(busyButton('custom', 'Добавить', 'Добавляю…', () => api.mcpAdd(name.value, target.value)));
    showError(one, 'custom');

    const json = el('textarea', 'input mcp-json');
    Object.assign(json, {
      placeholder: '{ "mcpServers": { "имя": { "command": "npx", "args": ["-y", "пакет"] } } }',
      spellcheck: false,
      rows: 4,
    });
    json.value = values.get('custom.json') || '';
    json.addEventListener('input', () => values.set('custom.json', json.value));
    const imp = row(
      'Готовые настройки (JSON)',
      'Блок из описания сервера — как для Claude Desktop, Cursor или VS Code. Можно несколько серверов сразу.',
      [json],
      true,
    );
    imp.box.append(
      busyButton('import', 'Импортировать', 'Импортирую…', async () => {
        const r = await api.mcpImport(json.value);
        if (r?.ok) values.delete('custom.json');
        return r;
      }),
    );
    showError(imp, 'import');
    return section('Свой сервер', null, [one.node, imp.node]);
  }

  function draw() {
    if (!data) return;
    const parts = [];
    if (!data.node) {
      const r = row('Нужен Node.js', 'Серверы с пометкой «Нужен Node.js» работают через него. Удалённые — и без него.', [
        button('Скачать Node.js', () => api.openLink('https://nodejs.org')),
      ]);
      parts.push(section('Перед установкой', null, [r.node]));
    }
    parts.push(installed(), ...catalog());
    if (!search.value.trim()) parts.push(custom());
    const shown = parts.filter(Boolean);
    if (!shown.length) shown.push(el('p', 'empty', 'Ничего не нашлось. Свой сервер можно добавить ниже — очистите поиск.'));
    body.replaceChildren(...shown);
  }

  search.addEventListener('input', draw);
  const off = api.onMcpChanged?.((r) => {
    data = r;
    redrawSafely(body, draw); // не посреди ввода в поле этой страницы
  });
  api.mcpList().then((r) => {
    data = r;
    draw();
  });
  return { node: page, refresh: () => {}, dispose: () => off?.() };
}
