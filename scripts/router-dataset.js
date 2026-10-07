// Набор для дообучения маленькой модели вызова функций (core/router.js) — из того, что знает большая модель.
//   npm run router-dataset -- --generate 12 --chat 150 --paraphrase 3 --relabel   — полный набор (рекомендуется)
//   --generate N  — по N новых фраз на каждый инструмент (большая модель придумывает, как его попросят голосом)
//   --chat N      — N фраз без инструментов: разговор, вопросы о мире, несколько задач — ответ «передаю»
//   --paraphrase N — по N перефразировок каждой команды
//   --relabel     — разметить все фразы заново учителем: нынешняя большая модель, разбор одним промптом, пустая память
//   --with-tools  — описания инструментов в каждом примере (для исходной FunctionGemma; router.toolsInPrompt: true)
//   --data <папка> — папка данных Ориона; --backend llamacpp — движок большой модели, если Ollama не запущена
//
// Источники (каждая фраза — один раз): примеры навыков, журнал actions.log, router-data.jsonl (записи при работе),
// сгенерированные и перефразированные фразы прошлых запусков (data/router/*.jsonl — кэш, повторно не генерируются).
// Фразы контрольных наборов (test/fixtures/eval-*.json) в обучение не попадают — на них идёт замер.
//
// Чему учим (без описаний инструментов — модель знает их наизусть, в запросе только фраза):
//   • одна задача с простым аргументом → вызов с аргументом: call:weather{arg:Казань};
//   • одна задача, аргумент которой пишет большая модель (llmArg, router.exclude) → только инструмент: call:timer{};
//   • разговор, вопрос без инструмента, несколько задач → текст «передаю» (дальше — большая модель).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return {};
  return originalLoad.call(this, request, ...rest);
};

const { loadConfig } = require('../src/core/config');
const { createSkillRegistry } = require('../src/core/skills');
const { routable, SYSTEM } = require('../src/core/router');

const argv = process.argv.slice(2);
const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const flag = (name) => argv.includes(name);
const root = path.join(__dirname, '..');
const appData =
  process.env.APPDATA ||
  (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support') : path.join(os.homedir(), '.config'));
const dataDir = path.resolve(opt('--data', process.env.ORION_DATA_DIR || path.join(appData, 'orion')));
const outDir = path.join(root, 'data', 'router');
const cacheFile = (name) => path.join(outDir, `${name}.jsonl`);

// Ответ «не моё» — любой текст: роутер всё, что не вызов, передаёт большой модели
const PASS = 'Передаю основной модели.';

let seed = 7;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const norm = (t) =>
  String(t)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

async function main() {
  const config = loadConfig(path.join(root, 'config.json'));
  config.skills = {}; // учим на всех навыках — выключенные сейчас могут понадобиться потом
  config.backend = opt('--backend', config.backend);
  config.planner = 'single'; // учитель — самый точный разбор (замер: single 96%, two-step 88%)
  const skills = createSkillRegistry(require('../src/skills'), { config, ctx: { config }, audit: () => {} });
  await skills.init();
  const exclude = new Set(config.router.exclude);
  const needsModel = (tool) => !!skills.toolInfo(tool)?.tool.llmArg || exclude.has(skills.skillOf(tool));

  const held = new Set(
    ['eval-cases.json', 'eval-holdout.json'].flatMap((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures', f), 'utf8')).cases.map((c) => norm(c.text));
      } catch {
        return [];
      }
    }),
  );

  // фраза → действия (последний план для фразы побеждает: свежие записи точнее)
  const plans = new Map();
  const add = (text, actions, source) => {
    const t = String(text || '').trim();
    if (!t || held.has(norm(t)) || !Array.isArray(actions)) return false;
    if (plans.has(norm(t)) && source !== 'журнал' && source !== 'запись') return false;
    plans.set(norm(t), { text: t, actions: actions.map((a) => ({ tool: a.tool, arg: String(a.arg ?? '') })), source });
    return true;
  };
  const readJsonl = (file, each) => {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      try {
        each(JSON.parse(line));
      } catch {}
    }
  };

  for (const s of require('../src/skills')) {
    for (const t of s.tools || []) for (const [phrase, plan] of t.examples || []) add(phrase, plan.actions || [], 'пример');
  }
  readJsonl(path.join(dataDir, 'actions.log'), (e) => {
    if (e.input && e.plan && !String(e.source || '').startsWith('followup') && e.plan.addressed !== false)
      add(e.input, e.plan.actions, 'журнал');
  });
  readJsonl(path.join(dataDir, 'router-data.jsonl'), (e) => add(e.text, e.actions, 'запись'));
  for (const name of ['generated', 'paraphrases']) readJsonl(cacheFile(name), (e) => add(e.text, e.actions || [], name));

  const teacher = createTeacher(config);
  const cache = (name, fresh) => {
    if (!fresh.length) return;
    fs.mkdirSync(outDir, { recursive: true });
    fs.appendFileSync(cacheFile(name), fresh.map((p) => JSON.stringify({ text: p.text, actions: p.actions })).join('\n') + '\n');
  };
  if (Number(opt('--generate', 0)) > 0) cache('generated', await generate(teacher, skills, Number(opt('--generate')), add, plans));
  if (Number(opt('--chat', 0)) > 0) cache('generated', await generateChat(teacher, Number(opt('--chat')), add, plans));
  if (Number(opt('--paraphrase', 0)) > 0) cache('paraphrases', await paraphrase(teacher, Number(opt('--paraphrase')), add, plans));
  if (flag('--relabel')) await relabel(teacher, plans);

  const withTools = flag('--with-tools');
  const rows = [];
  const stats = { call: 0, tool: 0, pass: 0 };
  const coverage = new Map(); // инструмент → сколько примеров
  for (const { text, actions } of plans.values()) {
    if (!routable(text)) continue; // такие фразы роутеру не достаются
    let answer;
    const one = actions.length === 1 && skills.toolInfo(actions[0].tool);
    if (one) {
      const { tool } = actions[0];
      const arg = skills.prepare(tool, actions[0].arg, text);
      const args = needsModel(tool) ? {} : { arg }; // аргумент, который надо вычислить, пишет большая модель
      answer = { role: 'assistant', tool_calls: [{ type: 'function', function: { name: tool, arguments: args } }] };
      stats[needsModel(tool) ? 'tool' : 'call']++;
      coverage.set(tool, (coverage.get(tool) || 0) + 1);
    } else {
      answer = { role: 'assistant', content: PASS }; // разговор, несколько задач
      stats.pass++;
    }
    const row = { messages: [{ role: 'developer', content: SYSTEM }, { role: 'user', content: text }, answer] };
    if (withTools)
      row.tools = skills.toolDefs(
        skills
          .scores(text)
          .slice(0, 3)
          .map((x) => x.id),
      );
    rows.push(row);
  }

  rows.sort(() => rand() - 0.5);
  const nVal = Math.max(1, Math.round(rows.length * 0.1));
  fs.mkdirSync(outDir, { recursive: true });
  const write = (name, list) => fs.writeFileSync(path.join(outDir, name), list.map((r) => JSON.stringify(r)).join('\n') + '\n');
  write('val.jsonl', rows.slice(0, nVal));
  write('train.jsonl', rows.slice(nVal));
  const missing = skills.names().filter((t) => !coverage.get(t));
  console.log(
    `Набор: ${rows.length} фраз (вызов с аргументом ${stats.call}, только инструмент ${stats.tool}, передать ${stats.pass}); ` +
      `обучение ${rows.length - nVal}, проверка ${nVal} → ${path.relative(root, outDir)}`,
  );
  if (missing.length) console.log(`Без примеров (${missing.length}): ${missing.join(', ')} — добавьте --generate`);
  teacher.stop();
}

// Учитель — большая модель; поднимается один раз на все шаги
function createTeacher(config) {
  let ready = null;
  async function start() {
    const { createLlm } = require('../src/core/llm');
    const { createLlamaServer } = require('../src/core/llama');
    const llama = createLlamaServer({ config, modelsDir: path.resolve(root, config.speech.modelsDir || 'models') });
    process.on('exit', () => llama.stop());
    return { llama, llm: createLlm({ config, llama }) };
  }
  const get = () => (ready ??= start());
  const phrases = async (system, user, n) => {
    const { llm } = await get();
    const schema = {
      type: 'object',
      properties: { phrases: { type: 'array', maxItems: n, items: { type: 'string' } } },
      required: ['phrases'],
    };
    const raw = await llm.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      schema,
      { temperature: 0.9 },
    );
    return (JSON.parse(raw).phrases || []).map((p) => String(p).trim()).filter(Boolean);
  };
  return { get, phrases, stop: () => ready?.then((t) => t.llama.stop()) };
}

const progress = (label, i, n, extra) => {
  if (i % 10 === 0 || i === n - 1) process.stdout.write(`\r${label}: ${i + 1}/${n}${extra ? `, ${extra}` : ''}   `);
};

// Новые фразы на каждый инструмент: как его попросят голосом разные люди. Разметка — потом, учителем (--relabel)
async function generate(teacher, skills, n, add, plans) {
  const fresh = [];
  const tools = skills.names();
  for (const [i, name] of tools.entries()) {
    const { tool, skill } = skills.toolInfo(name);
    const examples = (tool.examples || []).map(([p]) => `«${p}»`).join(', ');
    try {
      const list = await teacher.phrases(
        `Ты помогаешь собрать примеры для голосового ассистента. Придумай ${n} разных фраз, которыми человек вслух попросит ` +
          'ассистента о том, что делает этот инструмент. Разные люди, разные слова и порядок, короткие и длинные, разговорные; ' +
          'конкретные детали (города, названия, числа, время) — разные и правдоподобные. Без обращения по имени. ' +
          'Только одна просьба в каждой фразе. Ответ — JSON {"phrases": [...]}.',
        `Навык: ${skill}. Инструмент: ${name} — ${tool.use}.${examples ? ` Примеры: ${examples}.` : ''}`,
        n,
      );
      for (const text of list) {
        if (add(text, [{ tool: name, arg: '' }], 'generated')) fresh.push(plans.get(norm(text)));
      }
    } catch {}
    progress('Фразы на инструменты', i, tools.length, `новых ${fresh.length}`);
  }
  console.log();
  return fresh;
}

// Фразы без инструментов: разговор и вопросы — маленькая модель должна узнавать, что это не её
async function generateChat(teacher, n, add, plans) {
  const fresh = [];
  const kinds = [
    'болтовня и вопросы ассистенту о нём самом («как дела», «ты умеешь шутить»)',
    'рассказ человека о себе и своём дне, без просьбы',
    'просьбы рассказать: анекдот, историю, объяснить, посоветовать',
    'вопросы на общие знания, на которые отвечают из головы («почему небо голубое»)',
    'две разные просьбы в одной фразе («открой браузер и поставь таймер»)',
  ];
  const per = Math.ceil(n / kinds.length);
  for (const [i, kind] of kinds.entries()) {
    try {
      const list = await teacher.phrases(
        `Придумай ${per} разных фраз, которые человек скажет голосовому ассистенту вслух. Тип: ${kind}. ` +
          'Разные темы и формулировки, без обращения по имени. Ответ — JSON {"phrases": [...]}.',
        kind,
        per,
      );
      for (const text of list) if (add(text, [], 'generated')) fresh.push(plans.get(norm(text)));
    } catch {}
    progress('Фразы для разговора', i, kinds.length, `новых ${fresh.length}`);
  }
  console.log();
  return fresh;
}

// Перефразировки команд: та же просьба другими словами — тот же вызов (уточняется при --relabel)
async function paraphrase(teacher, n, add, plans) {
  const base = [...plans.values()].filter((p) => p.actions.length === 1 && routable(p.text));
  const fresh = [];
  for (const [i, p] of base.entries()) {
    try {
      const list = await teacher.phrases(
        `Перефразируй голосовую команду ассистенту ${n} разными способами — так, как её сказали бы разные люди вслух: ` +
          'короче, длиннее, разговорно, с другим порядком слов. Смысл и все детали (город, число, название, время) — те же. ' +
          'Без обращения по имени. Ответ — JSON {"phrases": [...]}.',
        p.text,
        n,
      );
      for (const text of list) if (add(text, p.actions, 'paraphrases')) fresh.push(plans.get(norm(text)));
    } catch {}
    progress('Перефразирую', i, base.length, `новых ${fresh.length}`);
  }
  console.log();
  return fresh;
}

// Разметка учителем: каждую фразу заново разбирает нынешняя большая модель (один промпт, пустая память),
// как npm run eval. Старые записи журнала бывают от прошлых версий промпта, а сгенерированные фразы
// разметки не имеют — единый учитель даёт ровный набор. Навыки не выполняются — нужен только план.
async function relabel(teacher, plans) {
  const { llm } = await teacher.get();
  const config = loadConfig(path.join(root, 'config.json'));
  Object.assign(config, { skills: {}, planner: 'single', backend: opt('--backend', config.backend) });
  const { createAssistant } = require('../src/core/assistant');
  const { createMemory } = require('../src/core/memory');
  const chat = llm.chat;
  const quiet = {
    ...llm,
    chat: (messages, ...rest) =>
      messages[0].content.startsWith('Ты — модуль долгой памяти') ? Promise.resolve('{"facts":[]}') : chat(messages, ...rest),
  };
  const registry = createSkillRegistry(require('../src/skills'), { config, ctx: { config }, audit: () => {} });
  await registry.init();
  const skills = { ...registry, run: async () => ({ ok: true }) };
  const memory = createMemory({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orion-relabel-')) });
  const assistant = createAssistant({ config, llm: quiet, skills, memory, audit: () => {}, notify: () => {} });
  const person = { id: 'relabel', honorific: 'сэр' };
  const list = [...plans.values()].filter((p) => routable(p.text));
  let changed = 0;
  for (const [i, p] of list.entries()) {
    try {
      const r = await assistant.handle(p.text, { source: 'wake', person });
      await assistant.reset();
      const actions = (r.actions || []).map((a) => ({ tool: a.tool, arg: String(a.arg ?? '') }));
      if (JSON.stringify(actions) !== JSON.stringify(p.actions)) changed++;
      p.actions = actions;
    } catch {}
    progress('Размечаю учителем', i, list.length, `изменилось ${changed}`);
  }
  console.log();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
