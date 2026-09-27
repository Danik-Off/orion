// Поиск: ответ голосом по прочитанным страницам. Браузер — только если об этом попросили.
const { research, wiki } = require('../lib/websearch');

async function webSearch(query, ctx, request) {
  if (!query) return { ok: false, message: 'Что именно искать, сэр?' };
  let { results, pages } = await research(query);
  if (!results.length) {
    // DuckDuckGo ограничил частые запросы — справка из Википедии
    const w = await wiki(query).catch(() => null);
    if (w) (results = [{ title: w.title, url: w.url, snippet: '' }]), (pages = [{ ...results[0], text: w.text }]);
  }
  // Если не нашлось ничего — модель ответит из своих знаний и предупредит об этом
  const read = new Set(pages.map((p) => p.url));
  const context = results.length
    ? [
        ...pages.map((p, i) => `[${i + 1}] ${p.title} (${new URL(p.url).hostname})\n${p.text}`),
        ...results.filter((r) => !read.has(r.url)).map((r) => `• ${r.title}: ${r.snippet}`),
      ].join('\n\n')
    : null;
  // request.onText — ядро озвучивает ответ по предложениям, пока модель его пишет
  const speak = (await ctx.llm.answer(request?.text || query, context, request?.onText)).trim();
  return { ok: true, speak, sources: results };
}

module.exports = {
  id: 'search',
  title: 'ответ на конкретный вопрос из интернета: кто выиграл, сколько стоит, кто такой, что случилось; поиск в браузере',
  always: true, // запасной вариант для всего, что не нашлось по словам
  rules: [
    'События, спорт, цены, курсы, люди, «кто выиграл», «сколько стоит», «когда выйдет» — web_search: твои знания могли устареть.',
    'История и точные факты — годы, даты, числа, население, биографии, «в каком году», «сколько лет», «кто изобрёл» — тоже web_search:',
    'маленькая модель путает такие факты, даже когда уверена. Про группы и исполнителей — тоже web_search.',
    '«Что такое…», «объясни…», «как работает…» — общие знания: отвечай сам, без поиска.',
  ],
  tools: [
    {
      name: 'web_search',
      speaks: true, // ответ всегда даёт сам инструмент
      use: 'факты, новости, люди, события — всё, что могло измениться или чего ты не знаешь; ответ будет зачитан голосом',
      arg: 'поисковый запрос',
      filler: 'Сейчас поищу.', // поиск идёт 2–5 секунд — сразу отозваться голосом
      examples: [['кто такой Илон Маск', { addressed: true, say: 'Сейчас узнаю, сэр.', actions: [{ tool: 'web_search', arg: 'Илон Маск' }] }]],
      run: webSearch,
    },
    {
      name: 'browser_search',
      use: 'ТОЛЬКО если пользователь сам просит показать или открыть поиск в браузере',
      arg: 'поисковый запрос',
      examples: [['покажи в браузере рецепт борща', { addressed: true, say: 'Открываю поиск, сэр.', actions: [{ tool: 'browser_search', arg: 'рецепт борща' }] }]],
      run: async (query, ctx) => {
        if (!query) return { ok: false, message: 'Что именно искать, сэр?' };
        await ctx.openExternal(ctx.config.search.browserUrl + encodeURIComponent(query));
        return { ok: true };
      },
    },
  ],
};
