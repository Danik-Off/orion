// Релиз дообученной FunctionGemma (orion-router) на GitHub — оттуда её качает первый запуск (src/core/llama.js).
//   npm run router-release                     → dist/release/models-router-v1/: модель, NOTICE, условия Gemma,
//                                                 карточка модели, SHA256SUMS; проверка контрольной суммы
//   npm run router-release -- --publish        → то же и выложить в релиз (нужен gh auth login)
//   --model <файл.gguf>  --tag <тег>
// Условия Gemma (docs/models/orion-router/GEMMA_TERMS.txt, раздел 3.1): модель распространяется только вместе
// с копией условий, файлом NOTICE и пометкой, что она изменена, — всё это кладётся рядом с файлом модели.
// Релиз не помечается «последним»: по последнему релизу установленные копии Ориона ищут обновления.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MODELS } = require('../src/core/llama');

const root = path.join(__dirname, '..');
const opt = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const known = MODELS['orion-router'];
const tag = opt('tag', known.url.split('/').at(-2));
const model = path.resolve(root, opt('model', path.join('models', 'llm', known.file)));
const docs = path.join(root, 'docs', 'models', 'orion-router');
const out = path.join(root, 'dist', 'release', tag);
const REPO = 'Danik-Off/orion';

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function stage() {
  if (!fs.existsSync(model)) throw new Error(`Нет модели: ${model}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  // Имя файла — как в ссылке, по которой его качает Орион
  fs.copyFileSync(model, path.join(out, known.file));
  for (const f of ['README.md', 'NOTICE', 'GEMMA_TERMS.txt', 'PROHIBITED_USE_POLICY.txt']) {
    fs.copyFileSync(path.join(docs, f), path.join(out, f));
  }
  const files = fs.readdirSync(out).sort();
  const sums = files.map((f) => `${sha256(path.join(out, f))}  ${f}`);
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), sums.join('\n') + '\n');
  return { files: [...files, 'SHA256SUMS'], hash: sha256(path.join(out, known.file)) };
}

function publish(files) {
  const gh = (args, opts = {}) => spawnSync('gh', args, { cwd: out, encoding: 'utf8', ...opts });
  if (gh(['auth', 'status']).status !== 0) throw new Error('gh не авторизован: выполните gh auth login');
  const exists = gh(['release', 'view', tag, '--repo', REPO]).status === 0;
  const r = exists
    ? gh(['release', 'upload', tag, ...files, '--repo', REPO, '--clobber'], { stdio: 'inherit' })
    : gh(
        [
          'release',
          'create',
          tag,
          ...files,
          '--repo',
          REPO,
          '--title',
          'orion-router (FunctionGemma 270M, fine-tuned)',
          '--notes-file',
          'README.md',
          '--latest=false',
        ],
        { stdio: 'inherit' },
      );
  if (r.status !== 0) throw new Error('gh: релиз не выложен');
}

try {
  const { files, hash } = stage();
  console.log(`готово: ${out}\n  ${files.join('\n  ')}`);
  console.log(`sha256 модели: ${hash}`);
  if (known.sha256 !== hash) {
    console.log(`\n⚠ в src/core/llama.js у 'orion-router' sha256 другой (${known.sha256 || 'не указан'}) — впишите этот,`);
    console.log('  иначе Орион отбросит скачанный файл как повреждённый.');
    if (process.argv.includes('--publish')) process.exit(1);
  }
  if (process.argv.includes('--publish')) {
    publish(files);
    console.log(`выложено: https://github.com/${REPO}/releases/tag/${tag}`);
  } else {
    console.log('\nвыложить: npm run router-release -- --publish');
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
