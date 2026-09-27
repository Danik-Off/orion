// Ударения в готовых фразах Ориона: собирает русские строки из src (реплики навыков, ядра и окна),
// ставит ударения и показывает слова, в которых модель не уверена или которые ещё не проверены.
// Проверенные ударения — test/fixtures/stress-reviewed.json; тест падает, если в фразах появилось
// непроверенное слово или ударение проверенного изменилось.
//   npm run stress-phrases              — сомнительные слова (уверенность < 0,9)
//   npm run stress-phrases -- --new     — слова, которых нет среди проверенных (их надо проверить глазами)
//   npm run stress-phrases -- --accept  — добавить эти слова в проверенные (после проверки!)
//   npm run stress-phrases -- --all     — все фразы с ударениями
//   npm run stress-phrases -- --json    — список фраз
const fs = require('node:fs');
const path = require('node:path');
const { accentuate, explain } = require('../src/lib/stress');
const { normalizeForSpeech } = require('../src/lib/speech-text');

const root = path.join(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['assets', 'node_modules'].includes(e.name)) walk(p);
    } else if (/\.js$/.test(e.name)) files.push(p);
  }
})(path.join(root, 'src'));

// Строки в кавычках и шаблонные (подстановки ${…} → «…»), только русский текст из двух и более слов
const phrases = new Set();
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    let s = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, '…').replace(/\\n/g, ' ').trim();
    if (!/[а-яё]{2,}.*\s.*[а-яё]{2,}/i.test(s)) continue;
    if (/^[\s…]*$/.test(s) || /\\[dswp]|\(\?|\[\^|\|.*\|/.test(s)) continue; // регулярные выражения
    if (/^(Ты |Отвечай|Правило|Ответь|Выпиши|Не записывай|Каждый факт)/.test(s)) continue; // промпты модели — не озвучиваются
    phrases.add(s);
  }
}
const list = [...phrases].sort();
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(list, null, 1)}\n`);
  process.exit(0);
}

// Слова с ударением от модели или словаря — то, что нужно проверить глазами один раз
const key = (w) => w.toLowerCase().replace(/[^а-яё+-]/g, '');
function stressedWords() {
  const out = new Set();
  for (const p of list) for (const w of explain(normalizeForSpeech(p))) if (['model', 'dictionary'].includes(w.source) && key(w.stressed)) out.add(key(w.stressed));
  return out;
}
const reviewedFile = path.join(root, 'test/fixtures/stress-reviewed.json');
if (process.argv.includes('--new') || process.argv.includes('--accept')) {
  const reviewed = new Set(fs.existsSync(reviewedFile) ? JSON.parse(fs.readFileSync(reviewedFile, 'utf8')) : []);
  const fresh = [...stressedWords()].filter((w) => !reviewed.has(w)).sort((a, b) => a.localeCompare(b, 'ru'));
  if (process.argv.includes('--accept')) {
    const all = [...new Set([...reviewed, ...fresh])].sort((a, b) => a.localeCompare(b, 'ru'));
    fs.writeFileSync(reviewedFile, `${JSON.stringify(all, null, 0).replace(/","/g, '",\n"').replace(/^\[/, '[\n').replace(/\]$/, '\n]')}\n`);
    console.log(`добавлено в проверенные: ${fresh.length}, всего: ${all.length}`);
  } else console.log(fresh.length ? `не проверено (${fresh.length}): ${fresh.join(' ')}` : 'все слова проверены');
  process.exit(0);
}

let doubtful = 0;
for (const p of list) {
  const spoken = normalizeForSpeech(p);
  const words = explain(spoken).filter((w) => w.source === 'model' && w.prob < 0.9);
  if (process.argv.includes('--all')) console.log(accentuate(spoken));
  else if (words.length) {
    doubtful += words.length;
    console.log(`${accentuate(spoken)}\n    сомнительно: ${words.map((w) => `${w.stressed} (${w.prob.toFixed(2)})`).join(', ')}`);
  }
}
console.log(`\nфраз: ${list.length}${process.argv.includes('--all') ? '' : `, сомнительных слов: ${doubtful}`}`);
