// Подпись версии в окне: orionAssistent:0.2.0(1a2b3c4) — версия из package.json и коммит, из которого собрано.
// В установленной версии git нет — коммит записывается при сборке в src/build-info.json (scripts/build-info.js).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LABEL = 'orionAssistent';
const BUILD_INFO = path.join(__dirname, '..', 'build-info.json');

// Короткий хеш коммита: из файла сборки, иначе из git рядом с проектом; не вышло — 'dev'
function commitHash({ root = path.join(__dirname, '..', '..'), buildInfo = BUILD_INFO, git = execFileSync } = {}) {
  try {
    const { commit } = JSON.parse(fs.readFileSync(buildInfo, 'utf8'));
    if (commit) return String(commit).slice(0, 7);
  } catch {}
  try {
    return (
      String(git('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 3000 })).trim() ||
      'dev'
    );
  } catch {
    return 'dev';
  }
}

let cached = null;
function versionLabel(version = require('../../package.json').version, options) {
  if (options) return `${LABEL}:${version}(${commitHash(options)})`;
  return (cached ??= `${LABEL}:${version}(${commitHash()})`);
}

module.exports = { versionLabel, BUILD_INFO };
