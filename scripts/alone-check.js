// Орион без большой модели — что он ответит на каждую фразу контрольных наборов: действие, честное «нужна большая
// модель», короткий ответ или молчание. Настоящая цепочка: быстрый разбор → маленькая модель → правила.
// Навыки не выполняются. Ищем ответы не по делу: «не расслышал» на настоящую просьбу, действие не туда.
//   node scripts/alone-check.js [--router orion-router-v2-q8_0.gguf] [--router-version 2] [-v]
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
const { createAssistant } = require('../src/core/assistant');
const { createMemory } = require('../src/core/memory');
const { createLlamaServer } = require('../src/core/llama');
const { createRouter } = require('../src/core/router');

const argv = process.argv.slice(2);
const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const root = path.join(__dirname, '..');

async function main() {
  const config = loadConfig(path.join(root, 'test/fixtures/config.json'));
  config.backend = 'none';
  // Сборка llama.cpp — какая установлена (в тестовом конфиге может быть уже удалённая)
  const builds = path.join(root, 'models', 'llama.cpp');
  const have = fs.existsSync(builds)
    ? fs
        .readdirSync(builds)
        .filter((d) => /^b\d+/.test(d))
        .sort()
    : [];
  if (have.length && !have.some((d) => d.startsWith(config.llamaCpp.build)))
    config.llamaCpp = { ...config.llamaCpp, build: have.at(-1).split('-')[0] };
  const model = opt('--router', 'orion-router-v2-q8_0.gguf');
  config.router = { ...config.router, enabled: true, collect: false, model, version: Number(opt('--router-version', 2)) };
  const registry = createSkillRegistry(require('../src/skills'), { config, ctx: { config }, audit: () => {} });
  await registry.init();
  const skills = { ...registry, run: async () => ({ ok: true }) };
  const server = createLlamaServer({
    config: { ...config, model, numCtx: 2048, llamaCpp: { ...config.llamaCpp, gpuLayers: config.router.gpuLayers, slots: 1 } },
    modelsDir: path.resolve(root, config.speech.modelsDir || 'models'),
    name: 'router',
  });
  process.on('exit', () => server.stop());
  const llm = { chat: async () => '', answer: async () => '', available: () => false, prewarm: async () => {} };
  const router = createRouter({ config, server, skills, audit: () => {}, alone: () => true });
  await server.ensure();
  const memory = createMemory({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orion-alone-')) });
  const assistant = createAssistant({ config, llm, skills, memory, audit: () => {}, notify: () => {}, router });

  const files = fs.readdirSync(path.join(root, 'test/fixtures')).filter((f) => /^eval-.*\.json$/.test(f) && f !== 'eval-files.json');
  const kinds = { действие: 0, 'нужна модель': 0, 'не расслышал': 0, 'слушаю/болтовня': 0, молчание: 0 };
  const suspicious = [];
  for (const file of files) {
    for (const c of JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures', file), 'utf8')).cases) {
      if (c.before) continue; // продолжения проверяются в eval
      const r = await assistant.handle(c.text, { source: c.source || 'wake' });
      await assistant.reset();
      const say = String(r.say || '');
      const kind = r.actions?.length
        ? 'действие'
        : r.ignored
          ? 'молчание'
          : /большой модел|большая модел|большая языковая/.test(say)
            ? 'нужна модель'
            : /расслышал/.test(say)
              ? 'не расслышал'
              : 'слушаю/болтовня';
      kinds[kind]++;
      const want = c.tool === null ? null : [].concat(c.tool ?? c.all ?? []);
      // Подозрительно: «не расслышал» на любую фразу, где ждали команду; действие не того инструмента
      const wrongTool = want && r.actions?.length && !r.actions.some((a) => want.includes(a.tool));
      if (kind === 'не расслышал' && want) suspicious.push(`НЕ РАССЛЫШАЛ на команду: «${c.text}» (${file})`);
      if (wrongTool)
        suspicious.push(
          `не тот инструмент: «${c.text}» → ${r.actions.map((a) => `${a.tool}(${a.arg})`).join(' ')}, нужен ${want.join('|')}`,
        );
      if (argv.includes('-v'))
        console.log(`${kind.padEnd(16)} «${c.text}» → ${r.actions?.map((a) => `${a.tool}(${a.arg})`).join(' ') || say.slice(0, 60)}`);
    }
  }
  console.log('\nИтог без большой модели:', JSON.stringify(kinds));
  console.log(suspicious.length ? `\nПодозрительно (${suspicious.length}):\n${suspicious.join('\n')}` : '\nПодозрительного нет');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
