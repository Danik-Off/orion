// Заметки и списки: «добавь молоко в список покупок», «что в списке дел», «вычеркни хлеб».
// Списки общие для дома (notes.json): покупки удобно вести всей семьёй.
const { createStore } = require('../lib/store');

let store = createStore(null, '', { lists: {} });
const DEFAULT_LIST = 'заметки';

// «списке покупок» → «покупки», «дела» → «дела»: имя списка в одной форме
const ALIASES = [
  [/покуп|магазин/, 'покупки'],
  [/дел|задач|todo/, 'дела'],
  [/замет|note/, 'заметки'],
  [/фильм|кино|сериал/, 'фильмы'],
  [/книг/, 'книги'],
  [/иде/, 'идеи'],
];
function listName(raw) {
  const t = String(raw || '').toLowerCase().replace(/ё/g, 'е').replace(/^(список|списке|списка)\s+/, '').trim();
  if (!t) return DEFAULT_LIST;
  return ALIASES.find(([re]) => re.test(t))?.[1] || t.slice(0, 40);
}

const split = (arg) => {
  const i = String(arg).indexOf('|');
  return i < 0 ? [DEFAULT_LIST, String(arg)] : [listName(arg.slice(0, i)), arg.slice(i + 1)];
};
const items = (text) => text.split(/[;\n]|,\s*(?=\S)/).map((s) => s.trim()).filter(Boolean).map((s) => s.slice(0, 200));

function add(arg) {
  const [name, text] = split(arg);
  const add = items(text);
  if (!add.length) return { ok: false, message: 'Что записать, сэр?' };
  const lists = store.get().lists;
  const list = (lists[name] ||= []);
  for (const it of add) if (!list.some((x) => x.toLowerCase() === it.toLowerCase())) list.push(it);
  store.save();
  return { ok: true, speak: `Записал в список «${name}»: ${add.join(', ')}.` };
}

function show(arg) {
  const lists = store.get().lists;
  const names = Object.keys(lists).filter((n) => lists[n].length);
  if (!String(arg).trim()) {
    if (!names.length) return { ok: true, speak: 'Списков пока нет, сэр.' };
    return { ok: true, speak: names.map((n) => `${n}: ${lists[n].join(', ')}`).join('. ') + '.' };
  }
  const name = listName(arg);
  const list = lists[name] || [];
  return { ok: true, speak: list.length ? `В списке «${name}»: ${list.join(', ')}.` : `Список «${name}» пуст, сэр.` };
}

function remove(arg) {
  const [name, text] = split(arg);
  const lists = store.get().lists;
  const list = lists[name] || [];
  const what = text.trim().toLowerCase();
  if (!what || /^(все|всё|all|очисти)/.test(what)) {
    delete lists[name];
    store.save();
    return { ok: true, speak: `Список «${name}» очищен.` };
  }
  const drop = items(what).map((w) => list.findIndex((x) => x.toLowerCase().includes(w))).filter((i) => i >= 0);
  if (!drop.length) return { ok: false, message: `В списке «${name}» такого нет, сэр.` };
  const removed = drop.map((i) => list[i]);
  lists[name] = list.filter((_, i) => !drop.includes(i));
  store.save();
  return { ok: true, speak: `Вычеркнул: ${removed.join(', ')}.` };
}

module.exports = {
  id: 'notes',
  title: 'заметки и списки (покупки, дела, фильмы): добавить, прочитать, вычеркнуть',
  keywords: ['список', 'списк', 'заметк', 'запиши', 'записать', 'покуп', 'купить', 'вычеркн', 'список дел', 'в дела', 'задач'],
  rules: ['«Запиши/добавь в список» — note_add; «запомни» про самого человека — это память (remember), а не заметка.'],
  tools: [
    {
      name: 'note_add',
      use: 'записать заметку или добавить пункты в список',
      arg: '"список|пункт1; пункт2" (список: покупки, дела, фильмы… — или пусто для заметок)',
      examples: [['добавь в покупки молоко и хлеб', { addressed: true, say: '', actions: [{ tool: 'note_add', arg: 'покупки|молоко; хлеб' }] }]],
      run: async (arg) => add(arg),
    },
    {
      name: 'note_show',
      use: 'прочитать список или все заметки',
      arg: 'название списка; пусто — все списки',
      // «что в списке покупок» с пустым arg — список назван в самой фразе
      normalize: (arg, text) => (arg.trim() ? arg : ALIASES.find(([re]) => re.test(text.toLowerCase().replace(/^.*?спис\S*/, '')))?.[1] || arg),
      run: async (arg) => show(arg),
    },
    {
      name: 'note_remove',
      use: 'вычеркнуть пункты из списка или очистить список',
      arg: '"список|пункт" или "список|всё"',
      run: async (arg) => remove(arg),
    },
  ],
  init(ctx) {
    store = createStore(ctx.dataDir, 'notes.json', { lists: {} });
  },
  listName,
};
