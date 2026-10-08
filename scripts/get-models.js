// Скачивает всё, что нужно ассистенту (модели речи, llama.cpp и языковую модель; или модель в Ollama) — то же,
// что приложение делает само при первом запуске. Запуск: npm run models
const path = require('node:path');
const { projectConfigFile } = require('../src/app/paths');
const { loadConfig } = require('../src/core/config');
const { install, missing, ALL_STAGES } = require('../src/core/setup');

const root = path.join(__dirname, '..');
const config = loadConfig(projectConfigFile(root));
const modelsDir = path.resolve(root, config.speech.modelsDir || 'models');

console.log(missing(config, modelsDir).length ? 'Не хватает:' : 'Модели речи на месте.');
for (const item of missing(config, modelsDir)) console.log(`  • ${item.name}`);

let line = '';
install({
  config,
  modelsDir,
  stages: ALL_STAGES, // всё сразу, вместе с большой моделью (приложение спрашивает о ней отдельно)
  report: (r) => {
    const text = r.error ? `✗ ${r.title}` : r.done ? `✓ ${r.title}` : `${r.title}: ${Math.round((r.progress || 0) * 100)}%`;
    if (text !== line) process.stdout.write(`\r${text.padEnd(90)}${r.done || r.error ? '\n' : ''}`);
    line = text;
  },
}).catch((e) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
