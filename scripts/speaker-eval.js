// Замер узнавания голоса — как в приложении (core/speaker.js): запись из 4 фраз одного сеанса, порог
// подбирается по ним же, проверка — короткие фразы из ДРУГИХ сеансов (другой день, микрофон, комната).
//   npm run speaker-eval -- <папка> [--models a.onnx,b.onnx] [--test-seconds 2] [--limit 40]
// Папка — как VoxCeleb1: <человек>/<сеанс>/<фраза>.wav (16 кГц); VoxCeleb1 test — 1 ГБ:
//   huggingface.co/datasets/ProgramComputer/voxceleb → vox1/vox1_test_wav.zip, распаковать в data/speaker-eval/vox1.
// Модели — модель приложения (config.json → speech.speaker.model) и все .onnx из data/speaker-eval/models
// (кандидаты для сравнения — с github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models). Считает: «не узнал своего» (промах) и «принял чужого» (ложный) при пороге приложения,
// EER (где промахи равны ложным) и промахи, если ложных не больше 1%.
const fs = require('node:fs');
const path = require('node:path');
const { projectConfigFile } = require('../src/app/paths');
const sherpa = require('sherpa-onnx-node');
const speaker = require('../src/core/speaker');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const dataDir = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const SR = 16000;
const ENROLL = 4;
const ENROLL_SECONDS = 4; // фразы записи — длиннее: человек читает предложение
const TEST_SECONDS = Number(opt('test-seconds', 2)); // команды Ориону — короткие
const PER_SESSION = 3; // проверочных фраз из каждого другого сеанса
const LIMIT = Number(opt('limit', 40));

function modelPaths() {
  const dirs = [path.join(root, 'data', 'speaker-eval', 'models'), path.join(root, 'models')];
  const list = opt('models', '');
  if (list) return list.split(',').map((m) => dirs.map((d) => path.join(d, m)).find(fs.existsSync) || m);
  const { loadConfig } = require('../src/core/config');
  const own = path.join(dirs[1], loadConfig(projectConfigFile(root)).speech.speaker.model);
  const candidates = fs.existsSync(dirs[0])
    ? fs
        .readdirSync(dirs[0])
        .filter((f) => f.endsWith('.onnx') && f !== path.basename(own))
        .map((f) => path.join(dirs[0], f))
    : [];
  return [own, ...candidates];
}

// Люди → сеансы → файлы; запись — первый сеанс, где хватает фраз; проверка — остальные
function plan() {
  const people = fs
    .readdirSync(dataDir)
    .filter((d) => fs.statSync(path.join(dataDir, d)).isDirectory())
    .sort()
    .slice(0, LIMIT);
  return people
    .map((id) => {
      const sessions = fs
        .readdirSync(path.join(dataDir, id))
        .sort()
        .map((s) => ({
          s,
          files: fs
            .readdirSync(path.join(dataDir, id, s))
            .filter((f) => f.endsWith('.wav'))
            .sort()
            .map((f) => path.join(dataDir, id, s, f)),
        }));
      const enrollSession = sessions.find((x) => x.files.length >= ENROLL);
      if (!enrollSession) return null;
      const test = sessions.filter((x) => x !== enrollSession).flatMap((x) => x.files.slice(0, PER_SESSION));
      return { id, enroll: enrollSession.files.slice(0, ENROLL), test };
    })
    .filter((p) => p && p.test.length);
}

// Середина фразы нужной длины (начало и конец часто — тишина или чужой голос)
function crop(samples, seconds) {
  const n = Math.round(seconds * SR);
  if (samples.length <= n) return samples;
  const start = Math.floor((samples.length - n) / 2);
  return samples.subarray(start, start + n);
}

function embedder(modelFile) {
  const ex = new sherpa.SpeakerEmbeddingExtractor({ model: modelFile, numThreads: 2, provider: 'cpu', debug: 0 });
  return (file, seconds) => {
    const wave = sherpa.readWave(file);
    if (wave.sampleRate !== SR) throw new Error(`${file}: ${wave.sampleRate} Гц`);
    const stream = ex.createStream();
    stream.acceptWaveform({ samples: crop(wave.samples, seconds), sampleRate: SR });
    stream.inputFinished();
    return ex.compute(stream, false);
  };
}

// Сколько своих не узнано (miss) и чужих принято (fa) при пороге; EER; промахи при ложных ≤ 1%
function metrics(own, other) {
  const sorted = [...other].sort((a, b) => b - a);
  const at1 = sorted[Math.floor(sorted.length * 0.01)] ?? 1;
  const missAt = (t) => own.filter((s) => s < t).length / own.length;
  const faAt = (t) => other.filter((s) => s >= t).length / other.length;
  let eer = 1;
  for (let t = -0.2; t <= 1; t += 0.005) eer = Math.min(eer, Math.max(missAt(t), faAt(t)));
  return { eer, missAt1: missAt(at1 + 1e-9), missAt, faAt };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(6);

function evaluate(modelFile, people) {
  const embed = embedder(modelFile);
  const t0 = Date.now();
  const enrolled = people.map((p) => ({ id: p.id, templates: p.enroll.map((f) => embed(f, ENROLL_SECONDS)) }));
  const tests = people.map((p) => p.test.map((f) => embed(f, TEST_SECONDS)));
  const ms = (Date.now() - t0) / (people.length * ENROLL + tests.flat().length);
  // Порог — как у приложения: по записи одного человека (в доме записан один голос)
  for (const e of enrolled) e.threshold = speaker.calibrate(e.templates, 0.42, null);

  const variants = {
    'топ-3 (сейчас)': (e, v) => speaker.personScore(e.templates, v),
    центроид: (e, v) => speaker.cosine(centroid(e.templates), v),
  };
  const out = {};
  for (const [name, score] of Object.entries(variants)) {
    const own = [];
    const other = [];
    let miss = 0;
    let fa = 0;
    let faN = 0;
    enrolled.forEach((e, i) => {
      tests.forEach((list, j) =>
        list.forEach((v) => {
          const s = score(e, v);
          if (i === j) {
            own.push(s);
            if (s < e.threshold) miss++;
          } else {
            other.push(s);
            faN++;
            if (s >= e.threshold) fa++;
          }
        }),
      );
    });
    out[name] = { ...metrics(own, other), miss: miss / own.length, fa: fa / faN, own, other };
  }
  const thresholds = enrolled.map((e) => e.threshold).sort((a, b) => a - b);
  return { ms, variants: out, threshold: thresholds[thresholds.length >> 1] };
}

function centroid(templates) {
  const c = new Float32Array(templates[0].length);
  for (const t of templates) {
    const n = Math.hypot(...t);
    for (let i = 0; i < c.length; i++) c[i] += t[i] / n;
  }
  return c;
}

if (!dataDir || !fs.existsSync(dataDir)) {
  console.error('Укажите папку: npm run speaker-eval -- data/speaker-eval/vox1/wav');
  process.exit(1);
}
const people = plan();
console.log(
  `${people.length} человек, запись ${ENROLL}×${ENROLL_SECONDS} с, проверка ${people.reduce((n, p) => n + p.test.length, 0)} фраз по ${TEST_SECONDS} с из других сеансов\n`,
);
console.log('модель'.padEnd(58), 'способ'.padEnd(15), 'EER', '  пром.@1%', 'порог', ' пром.', ' ложн.', ' мс/фраза');
for (const m of modelPaths()) {
  try {
    const r = evaluate(m, people);
    for (const [name, v] of Object.entries(r.variants)) {
      console.log(
        path.basename(m).padEnd(58),
        name.padEnd(15),
        pct(v.eer),
        pct(v.missAt1),
        '  ',
        r.threshold.toFixed(2),
        pct(v.miss),
        pct(v.fa),
        r.ms.toFixed(0).padStart(6),
      );
      // --sweep: где лежат свои и чужие оценки и что даёт каждый порог — для выбора правила порога
      if (args.includes('--sweep')) {
        const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))].toFixed(2);
        console.log(
          `   свои: p5 ${q(v.own, 0.05)} p10 ${q(v.own, 0.1)} p25 ${q(v.own, 0.25)} медиана ${q(v.own, 0.5)}`,
          `| чужие: p99 ${q(v.other, 0.99)} p99.9 ${q(v.other, 0.999)} max ${q(v.other, 1)}`,
        );
        for (const t of [0.3, 0.33, 0.36, 0.4, 0.45, 0.5])
          console.log(`   порог ${t}: промахи ${pct(v.missAt(t))}, ложные ${pct(v.faAt(t))}`);
      }
    }
  } catch (err) {
    console.log(path.basename(m).padEnd(58), 'ошибка:', err.message);
  }
}
