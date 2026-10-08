// Питание и системные команды: выключить или перезагрузить (сразу или через N минут), отменить, сон,
// таймер сна для музыки, заблокировать компьютер и другие готовые команды из config.json → commands.
// Выключение, перезагрузка и сон — только после подтверждения; команды с confirm — тоже.
const path = require('node:path');
const { launch } = require('../lib/windows');
const media = require('../lib/media');
const { wordsToNumber, plural, durationFromText } = require('../lib/ru');

let sleepTimer = null;
const minutes = (n) => `${n} ${plural(n, 'минуту', 'минуты', 'минут')}`;
// Модель иногда пишет секунды: «через час» → 3600. Столько минут не бывает (больше лимита) — значит, секунды
const toMinutes = (n, limit) => (n > limit && n % 60 === 0 ? n / 60 : n);
// Питание трогаем, только если о компьютере сказано прямо: «выключи его через час» после музыки — это про музыку
const ABOUT_PC = /компьют|комп|пк|ноут|систем|перезагр|спящ|усып|сон|выключени/i;

// arg: "shutdown 60" | "restart 10" | "sleep" | "cancel"
async function power(arg, ctx, request = {}) {
  const a = String(arg).trim().toLowerCase();
  if (request.text && !ABOUT_PC.test(request.text)) return { ok: false, message: 'Выключить компьютер? Скажите это прямо, сэр.' };
  if (/^(cancel|отмен)/.test(a)) {
    await launch('shutdown.exe', ['/a']).catch(() => {});
    return { ok: true, speak: 'Выключение отменено.' };
  }
  if (/^(sleep|сон|усып)/.test(a)) {
    if (!(await ctx.confirm('Перевести компьютер в спящий режим?'))) return { ok: false, message: 'Отменено, сэр.' };
    await launch('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']);
    return { ok: true };
  }
  const restart = /^(restart|перезагр)/.test(a);
  if (!restart && !/^(shutdown|выкл)/.test(a)) return { ok: false, message: 'Не понял, что сделать с питанием, сэр.' };
  const min = toMinutes(wordsToNumber(a.replace(/^\S+/, '')) ?? 1, 24 * 60);
  if (min < 0 || min > 24 * 60) return { ok: false, message: 'Можно от 0 минут до суток, сэр.' };
  const what = restart ? 'Перезагрузить' : 'Выключить';
  if (!(await ctx.confirm(`${what} компьютер через ${minutes(min)}?`))) return { ok: false, message: 'Отменено, сэр.' };
  // Уже запланировано (повторили команду или назвали другое время) — Windows второе не примет: снять прежнее
  await launch('shutdown.exe', ['/a']).catch(() => {});
  await launch('shutdown.exe', [restart ? '/r' : '/s', '/t', String(min * 60)]);
  return {
    ok: true,
    speak: `${restart ? 'Перезагружу' : 'Выключу'} компьютер через ${minutes(min)}. Скажите «отмени выключение», если передумаете.`,
  };
}

// Таймер сна: через N минут поставить на паузу всё, что играет
async function sleepAfter(arg, ctx) {
  const a = String(arg).trim().toLowerCase();
  clearTimeout(sleepTimer);
  if (/^(cancel|отмен)/.test(a)) return { ok: true, speak: 'Таймер сна отменён.' };
  const min = toMinutes(wordsToNumber(a), 600);
  if (!min || min > 600) return { ok: false, message: 'На сколько минут поставить таймер сна, сэр?' };
  sleepTimer = setTimeout(async () => {
    const playing = (await media.sessions().catch(() => [])).filter((s) => s.status === 'Playing');
    for (const s of playing) await media.control('pause', s.app).catch(() => {});
    ctx.audit({ sleepTimer: 'музыка на паузе', sessions: playing.length });
  }, min * 60_000);
  sleepTimer.unref?.();
  return { ok: true, speak: `Выключу музыку через ${minutes(min)}.` };
}

// Готовые команды из config.json → commands: только они, произвольных команд нет
function findCommand(commands, name) {
  const key = name.toLowerCase().trim();
  if (!key) return null;
  const entries = Object.entries(commands || {});
  return (
    entries.find(([k]) => k.toLowerCase() === key) ||
    entries.find(([k]) => k.toLowerCase().includes(key) || key.includes(k.toLowerCase())) ||
    null
  );
}

async function runCommand(name, ctx) {
  const found = findCommand(ctx.config.commands, name);
  if (!found) return { ok: false, message: `Команды «${name}» нет в списке разрешённых, сэр.` };
  const [title, cmd] = found;
  if (cmd.confirm && !(await ctx.confirm(`Выполнить «${title}»?`))) return { ok: false, message: 'Отменено, сэр.' };
  await launch(cmd.file, Array.isArray(cmd.args) ? cmd.args.map(String) : []);
  return { ok: true };
}

// Выключение и перезагрузка описаны инструментом power — пресеты с shutdown.exe модели не показываем,
// чтобы у одного действия не было двух инструментов (сами пресеты по-прежнему работают)
const shownCommands = (commands) =>
  Object.entries(commands || {})
    .filter(([, c]) => !/^shutdown(\.exe)?$/i.test(path.basename(String(c?.file || ''))))
    .map(([k]) => k);

module.exports = {
  id: 'power',
  needs: ['now'],
  platforms: ['win32'], // PowerShell и программы Windows
  title:
    'заблокировать компьютер, выключить или перезагрузить (сразу или через N минут), отменить выключение, спящий режим, таймер сна для музыки',
  keywords: ['выключ', 'перезагр', 'спящ', 'сон', 'усып', 'отмени выключение', 'таймер сна', 'через час', 'на ночь', 'заблок', 'блокир'],
  rules: [
    'Заблокировать компьютер и другие готовые команды — run_command; выключение и перезагрузка — power.',
    '«Выключи музыку через 30 минут» — sleep_timer; «выключи компьютер через час» — power.',
    '«Выключи его/её через …» после музыки или видео — это про музыку: только sleep_timer. power — только если прямо сказано про компьютер.',
    'Время в arg — в МИНУТАХ: час = 60.',
  ],
  tools: [
    {
      name: 'power',
      llmArg: true,
      use: 'выключение/перезагрузка компьютера через N минут, отмена, сон',
      arg: '"shutdown МИНУТЫ" | "restart МИНУТЫ" | "sleep" | "cancel"',
      examples: [['выключи компьютер через час', { addressed: true, say: '', actions: [{ tool: 'power', arg: 'shutdown 60' }] }]],
      // Минуты — из самой фразы («через 10 минут»), если названы: модель путает их с секундами
      normalize: (arg, text) => {
        const sec = durationFromText(text);
        return arg.replace(
          /^(shutdown|restart)\s+(\d+)$/,
          (m, verb, n) => `${verb} ${sec ? Math.round(sec / 60) : toMinutes(Number(n), 24 * 60)}`,
        );
      },
      run: power,
    },
    {
      name: 'sleep_timer',
      llmArg: true,
      use: 'выключить музыку и видео через N минут (перед сном)',
      arg: 'МИНУТЫ (не секунды); "cancel" — отменить',
      examples: [['выключи музыку через полчаса', { addressed: true, say: '', actions: [{ tool: 'sleep_timer', arg: '30' }] }]],
      normalize: (arg, text) => {
        const sec = durationFromText(text);
        return arg.replace(/^\d+$/, (n) => String(sec ? Math.round(sec / 60) : toMinutes(Number(n), 600)));
      },
      run: sleepAfter,
    },
    {
      name: 'run_command',
      llmArg: true,
      use: 'готовая системная команда из списка',
      arg: 'ровно одно из списка команд', // список подставляется при старте, см. init
      run: runCommand,
    },
  ],
  init(ctx) {
    const tool = this.tools.find((t) => t.name === 'run_command');
    const list = shownCommands(ctx.config.commands);
    tool.arg = `ровно одно из: ${list.join(', ') || '(нет)'}`;
    const lock = list.find((k) => /блок/i.test(k));
    tool.examples = lock
      ? [['заблокируй компьютер', { addressed: true, say: 'Блокирую.', actions: [{ tool: 'run_command', arg: lock }] }]]
      : [];
  },
};
