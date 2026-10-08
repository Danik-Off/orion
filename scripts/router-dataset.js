// Набор для дообучения маленькой модели вызова функций (core/router.js) — из того, что знает большая модель.
//   npm run router-dataset -- --generate 12 --chat 150 --paraphrase 3 --relabel   — полный набор (рекомендуется)
//   --generate N  — по N новых фраз на каждый инструмент (большая модель придумывает, как его попросят голосом)
//   --chat N      — N фраз без инструментов: разговор, вопросы о мире, несколько задач — ответ «передаю»
//   --paraphrase N — по N перефразировок каждой команды
//   --relabel     — разметить учителем новые фразы (нынешняя большая модель, разбор одним промптом, пустая память);
//                   разметка кэшируется в data/router/labels.jsonl; --relabel-all — разметить заново все
//   --mcp N       — N просьб к подключениям MCP (GitHub, Notion, Obsidian, документация, умный дом) — ответ «передаю»:
//                   их выполняет большая модель, которая видит подключённые серверы; разметке учителя не подлежат
//   --keep <файл.gguf> — доучивание: где нынешняя маленькая модель уверенно вызывает знакомый ей инструмент, её ответ
//                   и остаётся меткой (она не забывает выученное; учитель от прогона к прогону размечает по-разному)
//   --system      — со строкой FunctionGemma в запросе (так обучена v1); по умолчанию запрос — одна фраза
//   --with-tools  — описания инструментов в каждом примере (для исходной FunctionGemma; router.toolsInPrompt: true)
//   --data <папка> — папка данных Ориона; --backend llamacpp — движок большой модели, если Ollama не запущена
//
// data/router/manual.jsonl — примеры, написанные вручную (новые навыки): метка точная, учитель её не трогает.
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
const { projectConfigFile } = require('../src/app/paths');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return {};
  return originalLoad.call(this, request, ...rest);
};

const { loadConfig } = require('../src/core/config');
const { createSkillRegistry } = require('../src/core/skills');
const { routable, parseCall, confidence, SYSTEM } = require('../src/core/router');

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
  const config = loadConfig(projectConfigFile(root));
  config.skills = {}; // учим на всех навыках — выключенные сейчас могут понадобиться потом
  config.backend = opt('--backend', config.backend);
  config.planner = 'single'; // учитель — самый точный разбор (замер: single 96%, two-step 88%)
  const skills = createSkillRegistry(require('../src/skills'), { config, ctx: { config }, audit: () => {} });
  await skills.init();
  const exclude = new Set(config.router.exclude);
  const needsModel = (tool) => !!skills.toolInfo(tool)?.tool.llmArg || exclude.has(skills.skillOf(tool));

  const held = new Set(
    fs
      .readdirSync(path.join(root, 'test/fixtures'))
      .filter((f) => /^eval-.*\.json$/.test(f))
      .flatMap((f) => {
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
  for (const name of ['generated', 'paraphrases', 'mcp', 'manual']) readJsonl(cacheFile(name), (e) => add(e.text, e.actions || [], name));

  const teacher = createTeacher(config);
  const cache = (name, fresh) => {
    if (!fresh.length) return;
    fs.mkdirSync(outDir, { recursive: true });
    fs.appendFileSync(cacheFile(name), fresh.map((p) => JSON.stringify({ text: p.text, actions: p.actions })).join('\n') + '\n');
  };
  if (Number(opt('--generate', 0)) > 0) cache('generated', await generate(teacher, skills, Number(opt('--generate')), add, plans));
  if (Number(opt('--chat', 0)) > 0) cache('generated', await generateChat(teacher, Number(opt('--chat')), add, plans));
  if (Number(opt('--paraphrase', 0)) > 0) cache('paraphrases', await paraphrase(teacher, Number(opt('--paraphrase')), add, plans));
  if (Number(opt('--mcp', 0)) > 0) cache('mcp', await generateMcp(teacher, Number(opt('--mcp')), add, plans));
  // Задуманный инструмент сгенерированной фразы — до разметки (проверка согласия учителя ниже)
  for (const p of plans.values()) if (p.source === 'generated' && p.actions.length === 1) p.intended = p.actions[0].tool;
  // Разметка учителя — из кэша (labels.jsonl): заново размечаются только новые фразы; --relabel-all — все
  const labels = new Map();
  readJsonl(cacheFile('labels'), (e) => labels.set(norm(e.text), e.actions));
  // Просьбы к подключениям — всегда «передаю», учитель их не размечает
  const fixed = (p) => p.source === 'mcp' || p.source === 'manual';
  for (const p of plans.values()) if (fixed(p)) p.labeled = true;
  if (!flag('--relabel-all'))
    for (const p of plans.values()) if (!fixed(p) && labels.has(norm(p.text))) ((p.actions = labels.get(norm(p.text))), (p.labeled = true));
  if (flag('--relabel') || flag('--relabel-all')) {
    const fresh = await relabel(teacher, plans, { all: flag('--relabel-all') });
    cache('labels', fresh);
  }
  cleanup(plans, skills);
  await teacher.stop();
  if (opt('--keep')) await keepKnown(opt('--keep'), config, skills, plans);

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
    const system = flag('--system') ? [{ role: 'developer', content: SYSTEM }] : [];
    const row = { messages: [...system, { role: 'user', content: text }, answer] };
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
  // Досоздание: только инструментам, у которых примеров меньше n (новые навыки) — у остальных фразы уже в кэше
  const have = new Map();
  for (const p of plans.values()) if (p.actions.length === 1) have.set(p.actions[0].tool, (have.get(p.actions[0].tool) || 0) + 1);
  const tools = skills.names().filter((name) => (have.get(name) || 0) < n);
  console.log(`Новые фразы — для ${tools.length} инструментов: ${tools.join(', ') || 'всем хватает'}`);
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

// Просьбы к подключениям MCP: маленькая модель их не выполняет — серверы у каждого свои, параметры пишет большая
async function generateMcp(teacher, n, add, plans) {
  const fresh = [];
  const kinds = [
    'GitHub: задачи, запросы на слияние, репозитории, коммиты («какие у меня открытые issue»)',
    'Notion: страницы, базы, заметки в Notion («создай страницу в ноушене»)',
    'Obsidian: заметки в хранилище Obsidian («найди в обсидиане заметку про отпуск»)',
    'документация библиотек и сервисов: React, Python, AWS, Cloudflare («что в документации про хуки»)',
    'Home Assistant: устройства умного дома по названию («включи увлажнитель в спальне через home assistant»)',
    'поиск через подключённые сервисы: Exa, Tavily, Brave, Hugging Face («поищи модели на хаггинг фейс»)',
  ];
  const per = Math.ceil(n / kinds.length);
  for (const [i, kind] of kinds.entries()) {
    try {
      const list = await teacher.phrases(
        `Придумай ${per} разных фраз, которыми человек вслух попросит голосового ассистента поработать с внешним сервисом. ` +
          `Сервис: ${kind}. Сервис назван в каждой фразе (его название, можно по-русски). Разные формулировки, ` +
          'без обращения по имени, одна просьба в фразе. Ответ — JSON {"phrases": [...]}.',
        kind,
        per,
      );
      for (const text of list) if (add(text, [], 'mcp')) fresh.push(plans.get(norm(text)));
    } catch {}
    progress('Просьбы к подключениям', i, kinds.length, `новых ${fresh.length}`);
  }
  console.log();
  return fresh;
}

// Доучивание (--keep): ответ нынешней маленькой модели — метка там, где она уверенно (≥ 0,95) вызывает инструмент,
// который знала. Учитель размечает от прогона к прогону по-разному (замер 2026-10-08: переразметка поменяла 65%
// ответов, неверных вызовов стало вдвое больше) — так модель не теряет выученное. Новые инструменты, «передаю»
// и фразы быстрого разбора — по учителю и быстрому разбору, как раньше.
async function keepKnown(file, config, skills, plans) {
  const { createLlamaServer } = require('../src/core/llama');
  const server = createLlamaServer({
    config: {
      ...config,
      model: file,
      numCtx: 2048,
      llamaCpp: { ...config.llamaCpp, gpuLayers: config.router.gpuLayers, slots: 1 },
    },
    modelsDir: path.resolve(root, config.speech.modelsDir || 'models'),
    name: 'router-keep',
  });
  process.on('exit', () => server.stop());
  await server.ensure();
  const base = await server.url();
  // Что знала модель: инструменты навыков без router: false / N (те ей в обучение не попадали)
  const known = (tool) => {
    const r = skills.skillInfo(skills.skillOf(tool))?.router;
    return !!skills.toolInfo(tool) && r !== false && typeof r !== 'number'; // router: N — выучен позже, не ею
  };
  // Только там, где и учитель назвал один знакомый ей инструмент: «передаю», несколько задач и новые навыки — не трогать
  const list = [...plans.values()].filter(
    (p) =>
      routable(p.text) && p.source !== 'mcp' && p.source !== 'manual' && !p.quick && p.actions.length === 1 && known(p.actions[0].tool),
  );
  let kept = 0;
  let changed = 0;
  for (const [i, p] of list.entries()) {
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...server.headers },
        body: JSON.stringify({
          messages: [
            { role: 'developer', content: SYSTEM },
            { role: 'user', content: p.text },
          ],
          temperature: 0,
          max_tokens: 64,
          stop: ['<end_function_call>', '<start_function_response>'],
          logprobs: true,
        }),
      });
      const choice = (await res.json()).choices?.[0];
      const c = parseCall(choice?.message?.content ?? '');
      const sure = confidence(choice?.logprobs?.content);
      if (c && known(c.name) && sure.name >= 0.95 && sure.arg >= 0.95) {
        const actions = [{ tool: c.name, arg: c.arg }];
        if (JSON.stringify(actions) !== JSON.stringify(p.actions)) changed++;
        p.actions = actions;
        kept++;
      }
    } catch {}
    progress('Ответы нынешней модели', i, list.length, `уверенных ${kept}, отличаются от учителя ${changed}`);
  }
  console.log();
  server.stop();
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
// Чистка разметки:
//   • фраза, которую понимает быстрый разбор навыка (quick), — его план: он детерминирован и проверен тестами;
//   • сгенерированная для инструмента фраза, которую учитель отнёс к другому, — выбросить (генератор ошибся:
//     «включи городовой час» для будильника);
//   • вызов инструмента, хотя в фразе нет ни одного слова его навыка («Пн включи» → будильник), — выбросить:
//     учитель угадывал по обрывку распознавания.
function cleanup(plans, skills) {
  const n = { quick: 0, generated: 0, words: 0 };
  for (const [key, p] of plans) {
    const quick = skills.quickPlan?.(p.text, {});
    if (quick?.actions?.length === 1 && quick.actions[0].tool) {
      if (JSON.stringify(quick.actions) !== JSON.stringify(p.actions)) n.quick++;
      p.actions = quick.actions.map((a) => ({ tool: a.tool, arg: String(a.arg ?? '') }));
      p.quick = true; // быстрый разбор главнее и ответов нынешней модели (--keep)
      continue;
    }
    const tool = p.actions.length === 1 ? p.actions[0].tool : null;
    if (p.intended && tool !== p.intended) {
      plans.delete(key);
      n.generated++;
      continue;
    }
    const skill = tool && skills.skillOf(tool);
    const info = skill && skills.skillInfo(skill);
    if (info && !info.always && p.source !== 'пример' && p.source !== 'manual' && !skills.scores(p.text).some((x) => x.id === skill)) {
      plans.delete(key);
      n.words++;
    }
  }
  console.log(`Чистка: по быстрому разбору ${n.quick}, генератор ошибся ${n.generated}, без слов навыка ${n.words}`);
}

// Разметка учителем → новые разметки для кэша [{ text, actions }]; all — и те, что уже размечены
async function relabel(teacher, plans, { all = false } = {}) {
  const { llm } = await teacher.get();
  const config = loadConfig(projectConfigFile(root));
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
  const list = [...plans.values()].filter((p) => routable(p.text) && (all || !p.labeled));
  let changed = 0;
  const fresh = [];
  for (const [i, p] of list.entries()) {
    try {
      const r = await assistant.handle(p.text, { source: 'wake', person });
      await assistant.reset();
      const actions = (r.actions || []).map((a) => ({ tool: a.tool, arg: String(a.arg ?? '') }));
      if (JSON.stringify(actions) !== JSON.stringify(p.actions)) changed++;
      p.actions = actions;
      fresh.push(p);
    } catch {}
    progress('Размечаю учителем', i, list.length, `изменилось ${changed}`);
  }
  console.log();
  return fresh;
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
