// Отчёт о дне по журналу действий (actions.log): сколько было команд, что открывалось, что играло, напоминания.
const fs = require('node:fs');
const path = require('node:path');
const { plural } = require('../lib/ru');

const MAX_BYTES = 5_000_000; // читаем только хвост большого журнала

function readLog(dataDir) {
  const file = path.join(dataDir, 'actions.log');
  let text;
  try {
    const { size } = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, MAX_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const top = (list, n = 3) =>
  Object.entries(list.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {}))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);

function report(entries, day) {
  const sameDay = entries.filter((e) => new Date(e.t).toDateString() === day.toDateString());
  const inputs = sameDay.filter((e) => e.input);
  if (!inputs.length) return 'За этот день команд не было, сэр.';
  const tools = sameDay.filter((e) => e.tool && e.ok);
  const apps = tools.filter((e) => e.tool === 'open_app').map((e) => e.arg);
  const videos = sameDay.filter((e) => e.youtube).map((e) => e.youtube);
  const reminders = sameDay.filter((e) => e.reminder).length;
  const first = new Date(inputs[0].t);
  const n = inputs.length;
  const parts = [`${n} ${plural(n, 'команда', 'команды', 'команд')}, первая в ${first.getHours()}:${String(first.getMinutes()).padStart(2, '0')}.`];
  if (apps.length) parts.push(`Чаще всего открывали: ${top(apps).join(', ')}.`);
  if (videos.length) parts.push(`Включали ${videos.length} ${plural(videos.length, 'ролик', 'ролика', 'роликов')}, например «${videos[videos.length - 1]}».`);
  if (reminders) parts.push(`Сработало напоминаний: ${reminders}.`);
  const skills = top(tools.map((e) => e.skill).filter(Boolean));
  if (skills.length) parts.push(`Больше всего пригодились навыки: ${skills.join(', ')}.`);
  return parts.join(' ');
}

// «что я сегодня делал», «итоги дня», «что я делал вчера» — без модели
function quick(text) {
  const t = text.toLowerCase().replace(/ё/g, 'е').replace(/[^а-я ]+/g, '').trim();
  const m = t.match(/^(?:что я (?:сегодня |вчера )?делал(?:а)?(?: сегодня| вчера)?|итоги (?:дня|сегодня)|отчет (?:за|о) (?:день|сегодня|вчера)(?: день)?)$/);
  return m ? { addressed: true, say: '', actions: [{ tool: 'day_report', arg: /вчера/.test(t) ? 'вчера' : '' }] } : null;
}

module.exports = {
  id: 'journal',
  quick,
  title: 'отчёт о дне: сколько было команд, что открывали, что слушали',
  keywords: ['что я сегодня делал', 'что я делал', 'отчет', 'отчёт', 'статистик', 'итоги дня', 'журнал'],
  tools: [
    {
      name: 'day_report',
      use: 'что делали сегодня или вчера: команды, программы, музыка, напоминания',
      arg: 'пусто — сегодня; "вчера"',
      argEnum: ['', 'вчера'],
      examples: [['что я сегодня делал', { addressed: true, say: '', actions: [{ tool: 'day_report', arg: '' }] }]],
      run: async (arg, ctx) => {
        if (!ctx.dataDir) return { ok: false, message: 'Журнал недоступен, сэр.' };
        const day = new Date();
        if (/вчера|yesterday/i.test(arg)) day.setDate(day.getDate() - 1);
        return { ok: true, speak: report(readLog(ctx.dataDir), day) };
      },
    },
  ],
  report,
};
