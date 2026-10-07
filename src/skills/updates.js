// Что нового: Орион зачитывает изменения своей версии из update/<версия>.md (src/lib/release-notes.js).
// «что нового», «что изменилось в обновлении», «что нового в версии 0.3.0», «какая у тебя версия».
// После обновления при запуске сам предлагает рассказать, что изменилось (offer): прошлую версию помнит
// в config.json → lastVersion. При первой установке не спрашивает — рассказывать не о чем.
const notes = require('../lib/release-notes');

const current = () => require('../../package.json').version;

function whatsNew(arg, { dir, version = current(), since } = {}) {
  const asked = String(arg || '').match(/\d+\.\d+(?:\.\d+)?/)?.[0];
  if (asked) {
    const v = asked.split('.').length === 2 ? `${asked}.0` : asked;
    const n = notes.read(v, dir);
    return n ? notes.spoken(n) : `Описания версии ${v} у меня нет, сэр.`;
  }
  const list = since ? notes.between(since, version, dir) : [notes.read(version, dir)].filter(Boolean);
  return list.length ? notes.spoken(list) : `Я на версии ${version}, но описания изменений к ней нет, сэр.`;
}

const norm = (text) =>
  String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-яa-z0-9. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Частые фразы — без модели
function quick(text) {
  const t = norm(text);
  if (/^(?:какая|какой) (?:у тебя )?(?:сейчас )?верси[яи]|^(?:твоя|какая твоя) верси[яи]/.test(t)) {
    return { addressed: true, say: '', actions: [{ tool: 'my_version', arg: '' }] };
  }
  const m = t.match(
    /^(?:ну )?(?:что|чего) (?:нового|изменилось|поменялось)(?: (?:у тебя|в (?:обновлении|последнем обновлении|новой версии|версии ([\d.]+))))?$/,
  );
  if (m) return { addressed: true, say: '', actions: [{ tool: 'whats_new', arg: m[1] || '' }] };
  return null;
}

module.exports = {
  id: 'updates',
  title: 'что нового в моей версии, номер версии',
  keywords: ['что нового', 'что изменилось', 'поменялось', 'обновлени', 'верси', 'новенького'],
  needs: [],
  quick,
  tools: [
    {
      name: 'whats_new',
      use: 'что изменилось в этой версии Ориона (или в названной), что нового в обновлении',
      arg: 'пусто — текущая версия; номер версии, например "0.3.0"',
      speaks: true,
      examples: [['что нового в обновлении', { addressed: true, say: '', actions: [{ tool: 'whats_new', arg: '' }] }]],
      run: async (arg) => ({ ok: true, speak: whatsNew(arg) }),
    },
    {
      name: 'my_version',
      use: 'какая сейчас версия Ориона',
      arg: 'пусто',
      argEnum: [''],
      speaks: true,
      examples: [['какая у тебя версия', { addressed: true, say: '', actions: [{ tool: 'my_version', arg: '' }] }]],
      run: async () => ({ ok: true, speak: `Версия ${current()}, сэр. Спросите «что нового» — расскажу, что изменилось.` }),
    },
  ],
  // При запуске после обновления: «Я обновился до версии … Рассказать, что нового?»
  async offer(ctx) {
    const version = current();
    const last = ctx.config.lastVersion;
    if (last === version) return;
    ctx.saveSettings({ lastVersion: version });
    if (!last || notes.compare(version, last) < 0) return; // первая установка или откат — молчим
    const list = notes.between(last, version);
    if (!list.length) return;
    const yes = await ctx.confirm(`Я обновился до версии ${version}. Рассказать, что нового?`);
    ctx.audit?.({ updates: yes ? 'рассказал' : 'не стал', from: last, to: version });
    if (yes) ctx.say?.(notes.spoken(list));
  },
  _test: { whatsNew },
};
