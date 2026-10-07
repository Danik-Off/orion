// Замер точности планирования на контрольных фразах (test/fixtures/eval-cases.json) с настоящей моделью —
// на движке из config.json (встроенный llama.cpp из models/ или Ollama).
// Навыки НЕ выполняются — проверяется только план: какой инструмент, с каким аргументом, кому адресовано.
//   npm run eval                 — модель на всех фразах (быстрые фразы без модели отключены — мерим модель)
//   npm run eval -- --quick      — как в приложении: сначала быстрый разбор, потом модель
//   npm run eval -- --all        — старый режим: описания всех навыков в каждом запросе
//   npm run eval -- -v           — показать и удачные фразы
//   npm run eval -- --only погод — только фразы, содержащие подстроку
//   npm run eval -- --cases файл.json — другой набор фраз
//   npm run eval -- --config файл.json — другой конфиг (test/fixtures/config.json — все навыки, как в тестах)
//   npm run eval -- --planner single  — разбор одним промптом вместо двухшагового (сравнить)
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
const { createLlm } = require('../src/core/llm');
const { createLlamaServer } = require('../src/core/llama');
const { createSkillRegistry } = require('../src/core/skills');
const { createAssistant } = require('../src/core/assistant');
const { createMemory } = require('../src/core/memory');

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

async function main() {
  const root = path.join(__dirname, '..');
  const config = loadConfig(argv.includes('--config') ? path.resolve(argv[argv.indexOf('--config') + 1]) : path.join(root, 'config.json'));
  if (argv.includes('--planner')) config.planner = argv[argv.indexOf('--planner') + 1]; // two-step или single
  const { cases } = JSON.parse(
    fs.readFileSync(
      argv.includes('--cases') ? path.resolve(argv[argv.indexOf('--cases') + 1]) : path.join(root, 'test/fixtures/eval-cases.json'),
      'utf8',
    ),
  );
  const list = cases.filter((c) => !only || c.text.includes(only));

  const llama = createLlamaServer({ config, modelsDir: path.resolve(root, config.speech.modelsDir || 'models') });
  process.on('exit', () => llama.stop());
  const llm = createLlm({ config, llama });
  let calls = 0;
  let promptChars = 0;
  const chat = llm.chat;
  llm.chat = (messages, ...rest) => {
    // Итог разговора в память не нужен замеру: он засорял бы память фактами между фразами
    if (messages[0].content.startsWith('Ты — модуль долгой памяти')) return Promise.resolve('{"facts":[]}');
    calls++;
    promptChars += messages.reduce((n, m) => n + m.content.length, 0);
    // --trace — показать каждый вызов модели: начало промпта, что спросили и что она ответила
    if (!flag('--trace')) return chat(messages, ...rest);
    return chat(messages, ...rest).then((raw) => {
      console.log(
        `   · ${messages[0].content.slice(0, 50).replace(/\n/g, ' ')}… | ${messages.at(-1).content.replace(/\n/g, ' / ')}\n     → ${raw}`,
      );
      return raw;
    });
  };

  const registry = createSkillRegistry(require('../src/skills'), { config, ctx: { config }, audit: () => {} });
  await registry.init();
  // replies — что «ответили» навыки на реплики before: { steam_price: 'Ведьмак стоит 25 долларов.' }
  let replies = {};
  const skills = { ...registry, run: async (tool) => ({ ok: true, speak: replies[tool] }) };
  if (!flag('--quick')) skills.quickPlan = () => null;
  if (flag('--all')) skills.select = () => registry.ids();

  // --router файл.gguf — весь путь: маленькая модель → узкий промпт → большая (по умолчанию — только большая)
  let router = null;
  const stages = {};
  if (argv.includes('--router')) {
    const { createRouter } = require('../src/core/router');
    const model = argv[argv.indexOf('--router') + 1];
    config.router = { ...config.router, enabled: true, collect: false, model };
    const routerServer = createLlamaServer({
      config: { ...config, model, numCtx: 2048, llamaCpp: { ...config.llamaCpp, gpuLayers: config.router.gpuLayers, slots: 1 } },
      modelsDir: path.resolve(root, config.speech.modelsDir || 'models'),
      name: 'router',
    });
    process.on('exit', () => routerServer.stop());
    router = createRouter({ config, server: routerServer, skills, audit: () => {} });
    await routerServer.ensure();
  }
  const memory = createMemory({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orion-eval-')) });
  // Какая ступень ответила (router — сразу, focused — узкий промпт, model — полный разбор)
  const audit = (e) => e.plan?.stage && (stages[e.plan.stage] = (stages[e.plan.stage] || 0) + 1);
  const assistant = createAssistant({ config, llm, skills, memory, audit, notify: () => {}, router });
  await assistant.warmup();
  const person = { id: 'eval', honorific: 'сэр' };

  let passed = 0;
  let time = 0;
  const times = [];
  const rows = [];
  for (const c of list) {
    replies = c.replies || {};
    for (const b of c.before || []) await assistant.handle(b, { source: 'wake', person });
    replies = {};
    const callsBefore = calls;
    const t = Date.now();
    const r = await assistant.handle(c.text, { source: c.source || 'wake', person });
    const dt = Date.now() - t;
    await assistant.reset();
    time += dt;
    times.push(dt);

    // Аргумент — тот, что дойдёт до навыка (после исправления по исходной фразе)
    const actions = (r.ignored ? [] : r.actions).map((a) => ({ tool: a.tool, arg: registry.prepare(a.tool, a.arg, c.text) }));
    const tools = actions.map((a) => a.tool);
    const problems = [];
    if (c.addressed === false && !r.ignored) problems.push('не понял, что фраза не ему');
    if (c.addressed !== false && r.ignored) problems.push('проигнорировал фразу к себе');
    if ('tool' in c) {
      if (c.tool === null && tools.length) problems.push('лишнее действие');
      const expected = [].concat(c.tool || []); // можно несколько верных вариантов
      const hit = expected.find((x) => tools.includes(x));
      if (c.tool && !hit) problems.push(`нужен ${expected.join(' или ')}`);
      if (hit && c.arg && hit === expected[0]) {
        const a = actions.find((x) => x.tool === hit);
        if (a && !new RegExp(c.arg, 'iu').test(a.arg)) problems.push(`arg не /${c.arg}/`);
      }
    }
    // all — несколько задач в одной фразе: нужны все эти инструменты, в этом порядке
    if (c.all) {
      const missing = c.all.filter((x) => !tools.includes(x));
      if (missing.length) problems.push(`нет ${missing.join(', ')}`);
      else if (c.all.some((x, i) => i && tools.indexOf(x) < tools.indexOf(c.all[i - 1]))) problems.push(`порядок не ${c.all.join(' → ')}`);
    }
    for (const bad of c.not || []) if (tools.includes(bad)) problems.push(`лишний ${bad}`);
    // say — регулярное выражение для ответа; notSay — чего в ответе быть не должно
    if (c.say && !r.ignored && !new RegExp(c.say, 'iu').test(r.say || ''))
      problems.push(`ответ не /${c.say}/: «${String(r.say).slice(0, 60)}»`);
    if (c.notSay && new RegExp(c.notSay, 'iu').test(r.say || '')) problems.push(`в ответе /${c.notSay}/`);
    const ok = !problems.length;
    passed += ok;
    const extra = calls - callsBefore > 1 ? ` (+${calls - callsBefore - 1} повтор)` : '';
    if (!ok || flag('-v')) {
      rows.push(
        `${ok ? '✓' : '✗'} ${String(dt).padStart(5)} мс  ${c.text.padEnd(48)} ${r.ignored ? 'ignored' : JSON.stringify(actions)}${extra}${ok ? '' : `  ← ${problems.join(', ')}`}`,
      );
    }
  }
  times.sort((a, b) => a - b);
  console.log(rows.join('\n'));
  console.log(
    `\n${flag('--all') ? 'все навыки' : 'каталог'}${flag('--quick') ? ' + быстрые фразы' : ''}: ` +
      `${passed}/${list.length} верно (${Math.round((100 * passed) / list.length)}%), ` +
      `среднее ${Math.round(time / list.length)} мс, p90 ${times[Math.floor(times.length * 0.9)]} мс, ` +
      `промпт в среднем ${Math.round(promptChars / calls)} символов (максимум ${llm.stats.maxPromptTokens} токенов), вызовов модели ${calls}`,
  );
  if (router)
    console.log(
      `ступени: ${Object.entries(stages)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
    );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
