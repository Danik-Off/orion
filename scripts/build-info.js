// Перед сборкой установщика: записать коммит в src/build-info.json — в установленной версии git нет,
// а окно показывает версию с хешем (src/core/version.js). Файл не хранится в git.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { BUILD_INFO } = require('../src/core/version');

let commit = process.env.GITHUB_SHA || '';
if (!commit) {
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {}
}
fs.writeFileSync(BUILD_INFO, `${JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2)}\n`);
console.log(`build-info: ${commit.slice(0, 7) || 'без коммита'}`);
