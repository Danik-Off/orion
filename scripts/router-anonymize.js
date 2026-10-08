// Набор для публикуемой модели — без личного: город, имена и прочее из журнала заменяются в каждом примере
// другими (в том же падеже: меняется основа, окончание остаётся). Веса запоминают частые слова — без этой
// замены дообученная модель «знает» город и имя того, кто её обучал.
//   npm run router-anonymize -- --city <ваш город> --name <ваше имя>        → data/router-public/{train,val}.jsonl
//   затем: python scripts/router-train.py --data data/router-public …
// Город из config.json (city) и имена людей из speaker.people добавляются сами.
const fs = require('node:fs');
const path = require('node:path');
const { projectConfigFile } = require('../src/app/paths');

const root = path.join(__dirname, '..');
const arg = (name) => process.argv.flatMap((a, i) => (a === `--${name}` ? [process.argv[i + 1]] : []));
const from = arg('from')[0] || path.join(root, 'data', 'router');
const to = arg('to')[0] || path.join(root, 'data', 'router-public');

// Подмены: основы на согласную — окончания падежей подходят как есть (Тамбов-е → Воронеж-е, Олег-у → Артём-у)
const CITIES = ['Воронеж', 'Саратов', 'Тамбов', 'Новосибирск', 'Екатеринбург', 'Омск', 'Томск', 'Курск', 'Брянск', 'Иркутск'];
const NAMES = ['Артём', 'Иван', 'Олег', 'Максим', 'Роман', 'Денис', 'Степан', 'Глеб', 'Тимур', 'Руслан'];

function personal() {
  const words = { city: arg('city'), name: arg('name') };
  try {
    const config = JSON.parse(fs.readFileSync(projectConfigFile(root), 'utf8'));
    if (config.city) words.city.push(config.city);
    for (const p of config.speaker?.people || []) if (p.name) words.name.push(p.name);
  } catch {}
  return Object.fromEntries(Object.entries(words).map(([k, v]) => [k, [...new Set(v.filter(Boolean))]]));
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sameCase = (sample, word) =>
  sample === sample.toLowerCase() ? word.toLowerCase() : sample[0] === sample[0].toUpperCase() ? word : word.toLowerCase();

// Заменить в строке основы stems подменой pick (одной на весь пример — вопрос и ответ модели согласованы)
function replaceStems(text, stems, pick) {
  if (!stems.length) return text;
  const re = new RegExp(`(?<![\\p{L}])(${stems.map(escape).join('|')})(?=\\p{L}{0,3}(?![\\p{L}]))`, 'giu');
  return text.replace(re, (m) => sameCase(m, pick));
}

function anonymize(rows, words, seed = 7) {
  let n = seed;
  const next = (list) => list[(n = (n * 1103515245 + 12345) % 2 ** 31) % list.length];
  let changed = 0;
  const out = rows.map((row) => {
    const city = next(CITIES);
    const name = next(NAMES);
    const json = JSON.stringify(row);
    const fixed = replaceStems(replaceStems(json, words.city, city), words.name, name);
    if (fixed !== json) changed++;
    return JSON.parse(fixed);
  });
  return { out, changed };
}

if (require.main === module) {
  const words = personal();
  if (!words.city.length && !words.name.length) {
    console.error('Нечего заменять: укажите --city и --name (или city в config.json)');
    process.exit(1);
  }
  fs.mkdirSync(to, { recursive: true });
  for (const file of ['train.jsonl', 'val.jsonl']) {
    const rows = fs
      .readFileSync(path.join(from, file), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const { out, changed } = anonymize(rows, words);
    fs.writeFileSync(path.join(to, file), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`${file}: ${rows.length} примеров, изменено ${changed}`);
  }
  console.log(`заменено: ${[...words.city, ...words.name].join(', ')} → ${to}`);
}

module.exports = { anonymize, replaceStems };
