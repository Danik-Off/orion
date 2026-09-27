// Открыть сайт в браузере — только http(s).
const { isHttpUrl } = require('../lib/websearch');

module.exports = {
  id: 'web',
  title: 'открыть сайт по адресу',
  keywords: ['сайт', 'ютуб', 'youtube', /(^|\s)вк(\s|$)/, 'вконтакте', 'github', 'гитхаб', 'страниц', 'ссылк', 'адрес', 'почт'],
  tools: [
    {
      name: 'open_url',
      use: 'открыть известный сайт (YouTube, VK, GitHub…) или поиск на YouTube',
      arg: 'полный адрес, начинающийся с https://',
      examples: [
        ['открой ютуб', { addressed: true, say: 'Открываю YouTube.', actions: [{ tool: 'open_url', arg: 'https://www.youtube.com' }] }],
        [
          'включи на ютубе лофи',
          { addressed: true, say: 'Ищу на YouTube.', actions: [{ tool: 'open_url', arg: 'https://www.youtube.com/results?search_query=lofi' }] },
        ],
      ],
      run: async (url, ctx) => {
        if (!isHttpUrl(url)) return { ok: false, message: 'Это не похоже на безопасный адрес, сэр.' };
        await ctx.openExternal(url);
        return { ok: true };
      },
    },
  ],
};
