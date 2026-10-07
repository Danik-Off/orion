// Память: личная (о собеседнике — у каждого голоса своя) и общая (дом, место, семья — одна на всех).
// Хранение — в ядре (core/memory.js); здесь только то, как модель этим пользуется.
// Номера фактов: личные — «#3», общие — «#о3».

const SHARED_ID = /^#о(\d+)/i;

module.exports = {
  id: 'memory',
  needs: ['person', 'facts', 'city'],
  hint: false, // «я устал», «мне нравится» — разговор, а не команда: не подталкиваем модель к памяти
  title: 'память о собеседнике и доме: запомнить, «забудь про …», имя, город',
  keywords: [
    'запомн',
    'забуд',
    'забыть',
    'зовут',
    'живу',
    'помнишь',
    'знаешь обо',
    'обо мне',
    'мое имя',
    'меня',
    /(^|\s)(я|мне|мой|моя|мои|у меня|у нас)\s/,
  ],
  rules: [
    'Память: имя и город собеседника — в profile (город — в именительном падеже).',
    'Факты о самом собеседнике (близкие, предпочтения, планы) — remember. Факты не о конкретном человеке',
    '(где ты находишься, дом, семья в целом, питомцы, общие договорённости) — remember_shared.',
    'Изменившийся факт обновляй по номеру, а не добавляй новый. Устаревшее или ошибочное — forget. Планы на дату — временным фактом.',
    'Пользуйся памятью в ответах, но не пересказывай её без просьбы.',
    '«Забудь про …» — forget (даже если это был план на дату); отменять напоминание — только если прямо сказано «напоминание».',
  ],
  tools: [
    {
      name: 'profile',

      llmArg: true,
      use: 'запомнить имя или город собеседника',
      arg: '"name=Имя" или "city=Город"',
      examples: [
        ['меня зовут Саша', { addressed: true, say: 'Приятно познакомиться, Саша.', actions: [{ tool: 'profile', arg: 'name=Саша' }] }],
        [
          'запомни, что я живу в Липецке',
          { addressed: true, say: 'Запомнил, вы в Липецке.', actions: [{ tool: 'profile', arg: 'city=Липецк' }] },
        ],
      ],
      run: async (arg, ctx) => ctx.memory.setProfile(arg),
    },
    {
      name: 'remember',

      llmArg: true,
      use: 'запомнить факт о собеседнике',
      arg: 'короткий факт от третьего лица; обновить: "#номер новый текст"; временный: "текст|дней"',
      examples: [
        ['я не ем мясо', { addressed: true, say: 'Учту, сэр.', actions: [{ tool: 'remember', arg: 'Не ест мясо' }] }],
        [
          'завтра в 10 у меня стоматолог',
          { addressed: true, say: 'Запомнил, сэр.', actions: [{ tool: 'remember', arg: 'Завтра в 10:00 визит к стоматологу|2' }] },
        ],
      ],
      run: async (arg, ctx) => ctx.memory.remember(arg),
    },
    {
      name: 'remember_shared',

      llmArg: true,
      use: 'запомнить общее: где ты находишься, про дом, семью, питомцев — не про конкретного собеседника',
      arg: 'факт; город, где ты находишься: "city=Город"; обновить: "#о номер текст"',
      examples: [
        [
          'запомни, что ты находишься в Липецке',
          { addressed: true, say: 'Запомнил: я в Липецке.', actions: [{ tool: 'remember_shared', arg: 'city=Липецк' }] },
        ],
        [
          'у нас дома живёт кот Барсик',
          { addressed: true, say: 'Запомню Барсика.', actions: [{ tool: 'remember_shared', arg: 'Дома живёт кот Барсик' }] },
        ],
      ],
      run: async (arg, ctx) => {
        if (/^\s*city\s*=/.test(arg)) return ctx.shared.setProfile(arg);
        return ctx.shared.remember(arg.replace(SHARED_ID, '#$1'));
      },
    },
    {
      name: 'forget',

      llmArg: true,
      use: 'забыть факт (личный или общий)',
      arg: '"#номер" (личный), "#о номер" (общий) или описание факта',
      examples: [['забудь про стоматолога', { addressed: true, say: 'Забыл.', actions: [{ tool: 'forget', arg: 'стоматолог' }] }]],
      run: async (arg, ctx) => {
        if (SHARED_ID.test(arg)) return ctx.shared.forget(arg.replace(SHARED_ID, '#$1'));
        if (/^#?\d+$/.test(arg.trim())) return ctx.memory.forget(arg);
        // По описанию: сначала в личной памяти, потом в общей
        const personal = ctx.memory.writable ? ctx.memory.forget(arg) : { ok: false };
        const found = personal.ok ? personal : ctx.shared.forget(arg);
        if (found.ok) return found;
        // «Забудь про стоматолога», а в памяти такого нет — может, это напоминание
        const what = String(arg).trim();
        if (what.length > 2 && !/^(вс[её]|all)$/i.test(what)) {
          const r = await ctx.call('reminders', `cancel ${what}`);
          if (r?.ok) return { ok: true, speak: 'В памяти такого не было — отменил напоминание об этом, сэр.' };
        }
        return found;
      },
    },
  ],
};
