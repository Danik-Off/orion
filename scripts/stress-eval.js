// Точность ударений на трудных словах: test/fixtures/stress-gold.json — фраза и ожидаемые формы
// трудных слов по порядку (омографы, «все/всё»). npm run stress-eval [-- -v]
const { accentuate } = require('../src/lib/stress');
const file = process.argv.includes('--holdout') ? 'stress-holdout.json' : 'stress-gold.json';
const gold = require(`../test/fixtures/${file}`);
const verbose = process.argv.includes('-v');

const plain = (w) => w.replace(/\+/g, '').toLowerCase().replace(/ё/g, 'е');
let ok = 0;
let total = 0;
for (const [text, expected] of gold) {
  const words = accentuate(text).match(/[А-Яа-яЁё+]+/g) || [];
  let from = 0;
  const got = expected.map((exp) => {
    const i = words.findIndex((w, k) => k >= from && plain(w) === plain(exp));
    if (i < 0) return '?';
    from = i + 1;
    return words[i].toLowerCase();
  });
  expected.forEach((exp, k) => {
    total++;
    // «все/всё» сравниваются с буквой «ё»; остальное — по месту ударения
    const good = got[k] === exp.toLowerCase();
    if (good) ok++;
    else if (!verbose) console.log(`✗ ${text}  →  ${got[k]}  (надо ${exp})`);
  });
  if (verbose) console.log(`${expected.every((e, k) => got[k] === e.toLowerCase()) ? '✓' : '✗'} ${accentuate(text)}`);
}
console.log(`\nверно ${ok} из ${total} (${((100 * ok) / total).toFixed(1)}%)`);
