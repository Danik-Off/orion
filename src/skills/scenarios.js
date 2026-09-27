// Сценарии и обучение командам: одна фраза → цепочка обычных команд.
//   «Когда я говорю "я дома" — включи джаз и скажи погоду» → сценарий «я дома» из двух шагов.
// Шаги — обычные фразы: они выполняются так же, как если бы их сказали (ctx.perform), поэтому
// сценарий может всё, что умеют навыки, и ничего сверх этого. Хранятся в scenarios.json;
// готовые можно задать в config.json → scenarios: { "название": ["фраза", "фраза"] }.
// Здесь же режим фокуса: закрыть отвлекающие программы и поставить помодоро.
const { createStore } = require('../lib/store');
const { wordsToNumber, plural } = require('../lib/ru');

let store = createStore(null, '', { scenarios: {} });
let config = {};
const MAX_STEPS = 8;

const key = (s) => String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const all = () => ({ ...(config.scenarios || {}), ...store.get().scenarios });
const find = (name) => {
  const k = key(name).replace(/^(сценарий|режим|запусти|включи) /, '');
  const list = all();
  return Object.keys(list).find((n) => key(n) === k || key(n) === key(name)) || null;
};

async function runScenario(name, ctx, request) {
  const found = find(name);
  if (!found) return { ok: false, message: `Сценария «${name}» нет, сэр.` };
  const said = [];
  for (const step of all()[found].slice(0, MAX_STEPS)) {
    const out = await ctx.perform(step, request);
    if (out) said.push(out);
  }
  ctx.audit({ scenario: found });
  return { ok: true, speak: said.join(' ') || `Сценарий «${found}» выполнен.` };
}

// arg: "название|шаг 1; шаг 2"
function saveScenario(arg) {
  const i = String(arg).indexOf('|');
  if (i < 0) return { ok: false, message: 'Скажите название и что делать, сэр.' };
  const name = key(arg.slice(0, i)).slice(0, 60);
  const steps = arg
    .slice(i + 1)
    .split(/;|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_STEPS);
  if (!name || !steps.length) return { ok: false, message: 'Скажите название и что делать, сэр.' };
  if (key(name).split(' ').length > 6) return { ok: false, message: 'Название лучше покороче, сэр.' };
  store.get().scenarios[name] = steps;
  store.save();
  return { ok: true, speak: `Запомнил: на «${name}» — ${steps.join(', ')}.` };
}

function listScenarios(arg) {
  const a = String(arg).trim();
  if (/^(delete|удал|забуд)/i.test(a)) {
    const name = find(a.replace(/^\S+\s*/, ''));
    if (!name || !store.get().scenarios[name]) return { ok: false, message: 'Такого сценария нет, сэр.' };
    delete store.get().scenarios[name];
    store.save();
    return { ok: true, speak: `Сценарий «${name}» удалён.` };
  }
  const names = Object.keys(all());
  return { ok: true, speak: names.length ? `Сценарии: ${names.join(', ')}.` : 'Сценариев пока нет. Научите меня: «когда я говорю „я дома“ — включи музыку».' };
}

// Режим фокуса: закрыть отвлекающие программы (config.focus.close) и поставить таймер помодоро
async function focus(arg, ctx) {
  const min = wordsToNumber(arg) || 25;
  if (min > 240) return { ok: false, message: 'Фокус можно поставить до 4 часов, сэр.' };
  const close = ctx.config.focus?.close || ['telegram', 'discord'];
  for (const app of close) await ctx.call('close_app', app).catch(() => {});
  await ctx.call('timer', `${min * 60}|Время фокуса вышло — сделайте перерыв`);
  return { ok: true, speak: `Режим фокуса на ${min} ${plural(min, 'минуту', 'минуты', 'минут')}. Отвлекающее закрыл, напомню о перерыве.` };
}

// Название сценария целиком — запуск без модели
function quick(text) {
  const t = key(text);
  if (!t || t.split(' ').length > 6) return null;
  const name = find(t);
  return name ? { addressed: true, say: '', actions: [{ tool: 'scenario_run', arg: name }] } : null;
}

module.exports = {
  id: 'scenarios',
  title: 'сценарии и обучение командам (одна фраза → несколько действий), режим фокуса и помодоро',
  keywords: ['сценари', 'когда я говорю', 'когда скажу', 'научись', 'запомни команду', 'режим', 'фокус', 'помодоро', 'сосредоточ'],
  quick,
  rules: [
    '«Когда я говорю X — делай Y» — scenario_save "X|Y"; шаги — короткие команды, как их сказал бы пользователь.',
    'Если фраза совпадает с названием сценария — scenario_run.',
  ],
  tools: [
    {
      name: 'scenario_run',
      use: 'выполнить сценарий по названию',
      arg: 'название сценария',
      run: runScenario,
    },
    {
      name: 'scenario_save',
      use: 'научиться новой команде: фраза → несколько действий',
      arg: '"название|команда 1; команда 2"',
      examples: [
        [
          'когда я говорю я дома включи джаз и скажи погоду',
          { addressed: true, say: '', actions: [{ tool: 'scenario_save', arg: 'я дома|включи джаз; какая погода' }] },
        ],
      ],
      run: async (arg) => saveScenario(arg),
    },
    {
      name: 'scenario_list',
      use: 'какие есть сценарии; удалить сценарий',
      arg: 'пусто — список; "delete название"',
      run: async (arg) => listScenarios(arg),
    },
    {
      name: 'focus',
      use: 'режим фокуса или помодоро: закрыть отвлекающие программы и поставить таймер',
      arg: 'минуты (по умолчанию 25; час = 60)',
      examples: [['режим фокуса на час', { addressed: true, say: '', actions: [{ tool: 'focus', arg: '60' }] }]],
      run: focus,
    },
  ],
  init(ctx) {
    config = ctx.config;
    store = createStore(ctx.dataDir, 'scenarios.json', { scenarios: {} });
  },
  saveScenario,
  find,
};
