// Окно настроек: боковая панель разделов с поиском и страница выбранного раздела.
// Раздел открывается по адресу #id (окно разговора открывает, например, #models); поиск ищет по всем строкам.
import { createStore } from './store.js';
import { renderRow, searchText } from './rows.js';
import { GROUPS, PAGES } from './pages/index.js';

const api = window.jarvis;
const store = createStore(api);
const ctx = { api, store };
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const icon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};

// --- текущая страница: её строки обновляются при каждом изменении значений ---
let mounted = { refreshers: [], dispose: null, pageId: null };

const rowsOf = (section, state) => (typeof section.rows === 'function' ? section.rows(state) : section.rows);

// Секция: заголовок, пояснение и карточка строк
function renderSection(section, state, refreshers) {
  const box = el('section', 'section');
  if (section.title) box.append(el('h2', '', section.title));
  if (section.note) box.append(el('p', 'note', section.note));
  const card = el('div', 'card');
  for (const row of rowsOf(section, state)) {
    const r = renderRow(row, ctx);
    card.append(r.node);
    refreshers.push(r.refresh);
  }
  box.append(card);
  if (section.when) refreshers.push((s) => (box.hidden = !section.when(s.values, s)));
  return box;
}

function mount(nodes, refreshers, dispose = null) {
  mounted.dispose?.();
  const page = $('#page');
  page.replaceChildren(...nodes);
  mounted = { ...mounted, refreshers, dispose };
  refreshers.forEach((fn) => fn(store.state));
}

function showPage(id, { flashKey } = {}) {
  const page = PAGES.find((p) => p.id === id) || PAGES[0];
  const head = el('div', 'page-head');
  head.append(el('h1', '', page.title));
  if (page.description) head.append(el('p', '', page.description));
  const refreshers = [];
  let dispose = null;
  const body = [];
  if (page.render) {
    const r = page.render(ctx);
    body.push(r.node);
    refreshers.push(r.refresh);
    dispose = r.dispose || null;
  } else {
    for (const section of page.sections) body.push(renderSection(section, store.state, refreshers));
  }
  mounted.pageId = page.id;
  mount([head, ...body], refreshers, dispose);
  for (const item of document.querySelectorAll('.nav-item')) item.classList.toggle('on', item.dataset.page === page.id);
  if (location.hash !== `#${page.id}`) history.replaceState(null, '', `#${page.id}`);
  $('#content').scrollTop = 0;
  if (flashKey) flash(flashKey);
}

// Подсветить строку, к которой перешли из поиска
function flash(key) {
  const row = document.querySelector(`.row[data-key="${CSS.escape(key)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1500);
}

// --- поиск: строки всех разделов, где совпали подпись, пояснение или ключевые слова ---
// Совпадение — по началу слов: «ключ» находит «Ключ API», но не «вклЮЧать»
const wordsOf = (text) =>
  String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const matcher = (query) => {
  const want = wordsOf(query);
  return (text) => {
    const have = wordsOf(text);
    return want.every((w) => have.some((h) => h.startsWith(w)));
  };
};

function showSearch(query) {
  const matches = matcher(query);
  const refreshers = [];
  const nodes = [el('div', 'page-head')];
  nodes[0].append(el('h1', '', 'Поиск'), el('p', '', `«${query}»`));
  for (const page of PAGES) {
    // Совпало название раздела или его ключевые слова — весь раздел; иначе — отдельные строки
    const pageText = `${page.title} ${page.keywords || ''}`;
    if (page.render) {
      if (!matches(pageText)) continue;
      const link = el('button', 'btn', `Открыть «${page.title}»`);
      link.addEventListener('click', () => openPage(page.id));
      const box = el('section', 'section');
      box.append(el('p', 'found-in', page.title), link);
      nodes.push(box);
      continue;
    }
    const rows = page.sections.flatMap((s) => rowsOf(s, store.state));
    const found = matches(pageText) ? rows : rows.filter((row) => matches(searchText(row)));
    if (!found.length) continue;
    const box = el('section', 'section');
    const title = el('button', 'found-in', page.title);
    title.addEventListener('click', () => openPage(page.id));
    box.append(title);
    const card = el('div', 'card');
    for (const row of found) {
      const r = renderRow(row, ctx);
      card.append(r.node);
      refreshers.push(r.refresh);
    }
    box.append(card);
    nodes.push(box);
  }
  if (nodes.length === 1) nodes.push(el('p', 'empty', 'Ничего не нашлось. Попробуйте другое слово.'));
  mounted.pageId = null;
  mount(nodes, refreshers);
  for (const item of document.querySelectorAll('.nav-item')) item.classList.remove('on');
}

function openPage(id, options) {
  $('#search').value = '';
  showPage(id, options);
}

// --- боковая панель ---
function renderNav() {
  const nav = $('#nav');
  nav.replaceChildren(
    ...GROUPS.map((g) => {
      const group = el('div', 'nav-group');
      group.append(el('div', 'nav-title', g.title));
      for (const page of PAGES.filter((p) => p.group === g.id)) {
        const item = el('button', 'nav-item');
        item.type = 'button';
        item.dataset.page = page.id;
        item.append(icon(page.icon), el('span', '', page.title));
        item.addEventListener('click', () => openPage(page.id));
        group.append(item);
      }
      return group;
    }),
  );
}

// --- запуск ---
renderNav();
store.subscribe((state) => {
  mounted.refreshers.forEach((fn) => fn(state));
  $('#restart-bar').hidden = !state.restart;
  $('#error').hidden = !state.error;
  $('#error').textContent = state.error;
  $('#window-title').textContent = `${state.values.name || 'Орион'} — настройки`;
});
$('#restart').addEventListener('click', () => api.restart());
$('#search').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  if (q) showSearch(q);
  else showPage(mounted.pageId || location.hash.slice(1));
});
$('#search').addEventListener('keydown', (e) => e.key === 'Escape' && ((e.target.value = ''), showPage(location.hash.slice(1))));
api.onSettingsPage((id) => openPage(id));
window.addEventListener('hashchange', () => openPage(location.hash.slice(1)));
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    $('#search').focus();
  }
});

await store.load();
// Раздел навыков строится из списка, пришедшего из ядра: перерисовать, если он уже открыт
showPage(location.hash.slice(1) || 'general');
