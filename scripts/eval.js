// Замер точности планирования на контрольных фразах (test/fixtures/eval-cases.json) с настоящей моделью —
// на движке из config.json (встроенный llama.cpp из models/ или Ollama).
// Навыки НЕ выполняются — проверяется только план: какой инструмент, с каким аргументом, кому адресовано.
//   npm run eval                 — модель на всех фразах (быстрые фразы без модели отключены — мерим модель)
//   npm run eval -- --quick      — как в приложении: сначала быстрый разбор, потом модель
//   npm run eval -- --all        — старый режим: описания всех навыков в каждом запросе
//   npm run eval -- -v           — показать и удачные фразы
//   npm run eval -- --only погод — только фразы, содержащие подстроку
//   npm run eval -- --cases файл.json — другой набор фраз
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
  const config = loadConfig(path.join(root, 'config.json'));
  const { cases } = JSON.parse(fs.readFileSync(argv.includes('--cases') ? path.resolve(argv[argv.indexOf('--cases') + 1]) : path.join(root, 'test/fixtures/eval-cases.json'), 'utf8'));
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
    return chat(messages, ...rest);
  };

  const registry = createSkillRegistry(require('../src/skills'), { config, ctx: { config }, audit: () => {} });
  await registry.init();
  const skills = { ...registry, run: async () => ({ ok: true }) };
  if (!flag('--quick')) skills.quickPlan = () => null;
  if (flag('--all')) skills.select = () => registry.ids();

  const memory = createMemory({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orion-eval-')) });
  const assistant = createAssistant({ config, llm, skills, memory, audit: () => {}, notify: () => {} });
  await assistant.warmup();
  const person = { id: 'eval', honorific: 'сэр' };

  let passed = 0;
  let time = 0;
  const times = [];
  const rows = [];
  for (const c of list) {
    for (const b of c.before || []) await assistant.handle(b, { source: 'wake', person });
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
    for (const bad of c.not || []) if (tools.includes(bad)) problems.push(`лишний ${bad}`);
    // say — регулярное выражение для ответа; notSay — чего в ответе быть не должно
    if (c.say && !r.ignored && !new RegExp(c.say, 'iu').test(r.say || '')) problems.push(`ответ не /${c.say}/: «${String(r.say).slice(0, 60)}»`);
    if (c.notSay && new RegExp(c.notSay, 'iu').test(r.say || '')) problems.push(`в ответе /${c.notSay}/`);
    const ok = !problems.length;
    passed += ok;
    const extra = calls - callsBefore > 1 ? ` (+${calls - callsBefore - 1} повтор)` : '';
    if (!ok || flag('-v')) {
      rows.push(`${ok ? '✓' : '✗'} ${String(dt).padStart(5)} мс  ${c.text.padEnd(48)} ${r.ignored ? 'ignored' : JSON.stringify(actions)}${extra}${ok ? '' : `  ← ${problems.join(', ')}`}`);
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
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
