// Замер маленькой модели вызова функций (core/router.js) на контрольных фразах (test/fixtures/eval-cases.json).
//   npm run router-eval                          — модель из config.router.model
//   npm run router-eval -- --model файл.gguf     — другая модель из models/llm (например, только что дообученная)
//   npm run router-eval -- --with-tools          — описания инструментов в запросе (исходная FunctionGemma)
//   npm run router-eval -- --system / --no-system — со строкой «You are a model that can do function calling…» или без
//   npm run router-eval -- --cases файл.json     — другой контрольный набор (eval-holdout.json, eval-delegate.json)
//   npm run router-eval -- --router-version 2    — версия модели для навыков с router: N (свой файл .gguf)
//   npm run router-eval -- -v                    — показать все фразы
// Исходы: «вызов» — готовый вызов, выполняется сразу; «навык» — модель назвала инструмент, аргумент пишет большая
// по узкому промпту; «передал» — дальше полный разбор большой моделью.
// Главное число — НЕВЕРНЫЙ вызов: такая команда выполнилась бы не так. Неверный навык дешевле — узкий промпт
// вернёт пустой план, и фразу разберут полностью (потеряно время). Передать — не ошибка, а лишь потерянная скорость.
const fs = require('node:fs');
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
const { createLlamaServer } = require('../src/core/llama');
const { createRouter } = require('../src/core/router');

const argv = process.argv.slice(2);
const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const root = path.join(__dirname, '..');

async function main() {
  const config = loadConfig(projectConfigFile(root));
  config.skills = {};
  // Порог уверенности — из настроек; таблица в конце показывает, что было бы при других
  const threshold = config.router.minConfidence ?? 0.95;
  config.router = {
    ...config.router,
    enabled: true,
    collect: false,
    minConfidence: 0,
    toolsInPrompt: argv.includes('--with-tools') || undefined, // без ключа — само: исходной модели описания нужны
    system: argv.includes('--system') ? true : argv.includes('--no-system') ? false : undefined, // системная строка в запросе
    model: opt('--model', config.router.model),
    version: opt('--router-version') ? Number(opt('--router-version')) : config.router.version, // навыки с router: N
  };
  const skills = createSkillRegistry(require('../src/skills'), { config, ctx: { config }, audit: () => {} });
  await skills.init();
  const server = createLlamaServer({
    config: {
      ...config,
      model: config.router.model,
      numCtx: 2048,
      llamaCpp: { ...config.llamaCpp, gpuLayers: config.router.gpuLayers, slots: 1 },
    },
    modelsDir: path.resolve(root, config.speech.modelsDir || 'models'),
    name: 'router',
  });
  process.on('exit', () => server.stop());
  const log = [];
  const router = createRouter({ config, server, skills, audit: (e) => log.push(e) });
  await server.ensure();

  const { cases } = JSON.parse(fs.readFileSync(path.resolve(opt('--cases', path.join(root, 'test/fixtures/eval-cases.json'))), 'utf8'));
  const list = cases.filter((c) => !c.before && c.source === undefined); // продолжения роутеру не достаются
  const times = [];
  const seen = []; // { c, call: { tool, arg, p } | null }
  for (const c of list) {
    const before = log.length;
    const t0 = Date.now();
    await router.route(c.text);
    times.push(Date.now() - t0);
    const e = log.slice(before).find((x) => x.router === 'выполнил' || x.router === 'навык');
    seen.push({ c, call: e ? { tool: e.tool, arg: e.arg, p: e.p } : null });
  }

  // Исход при пороге t — как решил бы роутер (core/router.js → route)
  const outcome = ({ c, call }, t) => {
    if (!call || call.p.name < t) return { kind: 'передал' };
    const expected = [].concat(c.tool ?? []);
    const skillOk = c.tool !== null && expected.some((x) => skills.skillOf(x) === skills.skillOf(call.tool));
    if (router.needsModel(call.tool) || call.p.arg < t || !skills.argAllowed(call.tool, call.arg)) return { kind: 'навык', ok: skillOk };
    const arg = skills.prepare(call.tool, call.arg, c.text);
    const ok =
      c.tool !== null &&
      expected.includes(call.tool) &&
      (!c.all || c.all.length <= 1) &&
      (!c.arg || call.tool !== expected[0] || new RegExp(c.arg, 'iu').test(arg));
    return { kind: 'вызов', ok, arg };
  };
  const count = (t) => {
    const r = { right: 0, wrong: 0, skillRight: 0, skillWrong: 0, passed: 0 };
    for (const s of seen) {
      const o = outcome(s, t);
      if (o.kind === 'передал') r.passed++;
      else if (o.kind === 'навык') r[o.ok ? 'skillRight' : 'skillWrong']++;
      else r[o.ok ? 'right' : 'wrong']++;
    }
    return r;
  };

  for (const s of seen) {
    const o = outcome(s, threshold);
    const expected = s.c.tool === null ? 'без действий' : [].concat(s.c.tool ?? []).join('|') + (s.c.arg ? ` /${s.c.arg}/` : '');
    const bad = o.ok === false;
    if (!bad && !argv.includes('-v')) continue;
    const p = s.call ? `${s.call.p.name.toFixed(2)}/${s.call.p.arg.toFixed(2)}` : '    —    ';
    const what =
      o.kind === 'передал' ? '→ большой' : o.kind === 'навык' ? `навык ${s.call.tool}` : `${s.call.tool}(${JSON.stringify(o.arg)})`;
    console.log(`${bad ? '✗' : '✓'} ${p} ${what}`.padEnd(54) + ` ${s.c.text}${bad ? `   ← нужно ${expected}` : ''}`);
  }
  times.sort((x, y) => x - y);
  const n = list.length;
  const r = count(threshold);
  const pct = (x) => `${x} (${Math.round((x / n) * 100)}%)`;
  console.log(
    `\n${path.basename(config.router.model)}${config.router.toolsInPrompt ? ' с описаниями инструментов' : ''} (порог ${threshold}), ${n} фраз:\n` +
      `  готовый вызов: верно ${pct(r.right)}, НЕВЕРНО ${pct(r.wrong)}\n` +
      `  навык для узкого промпта: верно ${pct(r.skillRight)}, неверно ${pct(r.skillWrong)}\n` +
      `  передал большой целиком: ${pct(r.passed)}\n` +
      `  время p50 ${times[Math.floor(n / 2)]} мс, p90 ${times[Math.floor(n * 0.9)]} мс`,
  );
  // Что было бы при другом пороге (config.router.minConfidence)
  console.log('\nпорог  вызов✓  вызов✗  навык✓  навык✗  передал');
  for (const t of [0, 0.5, 0.7, 0.8, 0.9, 0.95, 0.98]) {
    const x = count(t);
    const cols = [x.right, x.wrong, x.skillRight, x.skillWrong, x.passed].map((v, i) => String(v).padStart(i ? 7 : 6)).join(' ');
    console.log(`${t.toFixed(2).padStart(5)} ${cols}${t === threshold ? '   ← сейчас' : ''}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
