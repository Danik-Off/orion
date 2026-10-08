// Пакеты серверов MCP из npm — ставятся один раз в папку данных (mcp/<имя>/) и запускаются напрямую через node.
// Так сервер стартует за доли секунды, работает без интернета и не меняет версию сам по себе (npx при каждом
// запуске спрашивает npm о новой версии и качает её). Обновление — кнопкой «Обновить» в настройках.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const INSTALL_TIMEOUT = 5 * 60_000;
const SAFE_PACKAGE = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[\w.^~<>=-]+)?$/i; // имя пакета npm (и версия) — без пробелов и ключей

// Есть ли программа (npm, uvx) — для подсказки в настройках «Нужен Node.js» / «Нужен uv»
const found = new Map();
function hasCommand(cmd) {
  if (!found.has(cmd)) {
    try {
      found.set(cmd, spawnSync(cmd, ['--version'], { shell: true, windowsHide: true, timeout: 15_000 }).status === 0);
    } catch {
      found.set(cmd, false);
    }
  }
  return found.get(cmd);
}

// npx -y пакет … → { package, args }; иначе null
function npxPackage(server) {
  if (server.command !== 'npx') return null;
  const args = [...(server.args || [])];
  const i = args.findIndex((a) => !a.startsWith('-'));
  if (i < 0 || !SAFE_PACKAGE.test(args[i])) return null;
  return { package: args[i], args: args.slice(i + 1) };
}

const baseName = (pkg) => pkg.replace(/(?!^)@[^/]*$/, ''); // «@scope/pkg@1.2» → «@scope/pkg»

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    // На Windows npm — это npm.cmd: без оболочки не запускается. Аргументы — только проверенные имена пакетов
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32', windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `${cmd}: код ${code}`));
    });
  });
}

// Последняя версия пакета в npm (для проверки обновлений); нет связи — null
function latestVersion(pkg) {
  if (!SAFE_PACKAGE.test(pkg) || !hasCommand('npm')) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn('npm', ['view', baseName(pkg), 'version'], { shell: process.platform === 'win32', windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('error', () => resolve(null));
    child.on('close', (code) => (clearTimeout(timer), resolve(code === 0 ? out.trim() || null : null)));
  });
}

// Поставить (или обновить) пакет в dir → { command: 'node', args: [путь к программе], version }
async function installPackage({ dir, pkg, bin }) {
  if (!SAFE_PACKAGE.test(pkg)) throw new Error(`Странное имя пакета: ${pkg}`);
  if (!hasCommand('npm')) throw new Error('Нужен Node.js — скачайте с nodejs.org и перезапустите меня');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), '{ "private": true }\n');
  const spec = /(?!^)@/.test(pkg) ? pkg : `${pkg}@latest`;
  await run('npm', ['install', spec, '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'], dir);
  return resolveBin({ dir, pkg: baseName(pkg), bin });
}

// Программа пакета: поле bin его package.json (строка или { имя: путь })
function resolveBin({ dir, pkg, bin }) {
  const root = path.join(dir, 'node_modules', ...pkg.split('/'));
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const bins = typeof meta.bin === 'string' ? { [meta.name]: meta.bin } : meta.bin || {};
  const rel = bins[bin] || Object.values(bins)[0];
  if (!rel) throw new Error(`У пакета ${pkg} нет программы для запуска`);
  return { command: 'node', args: [path.join(root, rel)], version: meta.version };
}

module.exports = { installPackage, resolveBin, npxPackage, hasCommand, latestVersion, SAFE_PACKAGE };
