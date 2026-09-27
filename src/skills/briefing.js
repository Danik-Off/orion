// Сводка на день: приветствие, погода, напоминания на сегодня, списки дел и главные новости — одним ответом.
const reminders = require('./reminders');

function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
}

async function briefing(arg, ctx) {
  const parts = [`${greeting()}${ctx.person?.name ? `, ${ctx.person.name}` : ''}.`];
  const safe = async (tool, a) => {
    const r = await ctx.call(tool, a).catch(() => null);
    return r?.ok ? r.speak : '';
  };
  const [weather, dates, news] = await Promise.all([safe('weather', ''), safe('date_info', 'today'), safe('news', 'главное')]);
  if (dates) parts.push(dates);
  if (weather) parts.push(weather);

  const today = reminders.upcoming(24).filter((r) => new Date(r.at).toDateString() === new Date().toDateString());
  if (today.length) parts.push(`Напоминания на сегодня: ${today.map((r) => `${reminders.when(r).replace(/^сегодня /, '')} — ${r.text}`).join('; ')}.`);
  const todo = await safe('note_show', 'дела');
  if (todo && !/пуст/.test(todo)) parts.push(todo);
  if (news && !/brief/.test(arg)) parts.push(news);
  return { ok: true, speak: parts.join(' ') };
}

// «доброе утро», «что у меня на сегодня», «утренняя сводка»
function quick(text) {
  const t = text.toLowerCase().replace(/ё/g, 'е').replace(/[^а-я ]+/g, '').trim();
  if (/^(доброе утро|что у меня (на|сегодня)( сегодня)?|(утренняя )?сводка( на день| дня)?|брифинг|план на день)$/.test(t)) {
    return { addressed: true, say: 'Собираю сводку.', actions: [{ tool: 'briefing', arg: '' }] };
  }
  return null;
}

module.exports = {
  id: 'briefing',
  title: 'сводка на день: погода, напоминания, дела, новости',
  keywords: ['доброе утро', 'сводк', 'брифинг', 'на сегодня', 'план на день', 'что у меня'],
  quick,
  tools: [
    {
      name: 'briefing',
      speaks: true, // ответ всегда даёт сам инструмент
      use: 'сводка на день: погода, напоминания и дела на сегодня, главные новости',
      arg: 'пусто; "brief" — без новостей',
      argEnum: ['', 'brief'],
      run: briefing,
    },
  ],
};
