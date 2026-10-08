// Проверка озвучки на слух распознавателем: фраза → нормализация и ударения → Supertonic → распознавание
// вторым (точным) проходом Ориона → какие слова не расслышаны. Так находятся слова, которые голос
// произносит неверно, — их ударение правится в src/assets/stress/extra-words.json, контекст омографа —
// в extra-phrases.json, чтение — в src/lib/speech-text.js.
//   npm run voice-check                         — типичные ответы (test/fixtures/voice-check.json)
//   npm run voice-check -- "Сколько стоит билет?" — своя фраза
//   npm run voice-check -- --no-stress            — сравнить без ударений
//   npm run voice-check -- --save                 — сохранить звук в voice-check/ (послушать)
const fs = require('node:fs');
const path = require('node:path');
const { projectConfigFile } = require('../src/app/paths');
const sherpa = require('sherpa-onnx-node');
const { loadConfig } = require('../src/core/config');
const { normalizeForSpeech } = require('../src/lib/speech-text');
const { forSynth } = require('../src/lib/stress');

const root = path.join(__dirname, '..');
const config = loadConfig(projectConfigFile(root));
const s = config.speech;
const modelsDir = path.resolve(root, s.modelsDir || 'models');
const args = process.argv.slice(2);
const stress = !args.includes('--no-stress');
const save = args.includes('--save');
const own = args.filter((a) => !a.startsWith('--'));
const phrases = own.length ? own : JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/voice-check.json'), 'utf8'));

function pick(dir, re) {
  const found = fs
    .readdirSync(dir)
    .filter((n) => re.test(n))
    .sort((a, b) => a.length - b.length);
  if (!found.length) throw new Error(`В ${dir} нет ${re}`);
  return path.join(dir, found[0]);
}

const ttsDir = path.join(modelsDir, s.ttsModel);
const fp32 = path.join(modelsDir, 'supertonic-3-fp32');
const part = (name) =>
  s.ttsPrecision === 'full' && fs.existsSync(path.join(fp32, `${name}.onnx`))
    ? path.join(fp32, `${name}.onnx`)
    : pick(ttsDir, new RegExp(`^${name}.*\\.onnx$`));
const tts = new sherpa.OfflineTts({
  model: {
    supertonic: {
      durationPredictor: part('duration_predictor'),
      textEncoder: part('text_encoder'),
      vectorEstimator: part('vector_estimator'),
      vocoder: part('vocoder'),
      ttsJson: path.join(ttsDir, 'tts.json'),
      unicodeIndexer: path.join(ttsDir, 'unicode_indexer.bin'),
      voiceStyle: path.join(ttsDir, 'voice.bin'),
    },
    numThreads: 2,
    provider: 'cpu',
  },
  maxNumSentences: 1,
});
const asrDir = path.join(modelsDir, s.asrSecondPass);
const asr = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: pick(asrDir, /^encoder.*\.onnx$/),
      decoder: pick(asrDir, /^decoder.*\.onnx$/),
      joiner: pick(asrDir, /^joiner.*\.onnx$/),
    },
    tokens: path.join(asrDir, 'tokens.txt'),
    numThreads: 2,
    provider: 'cpu',
  },
});

const words = (t) =>
  t
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[́+]/g, '')
    .split(/[^a-zа-я0-9]+/)
    .filter(Boolean);
if (save) fs.mkdirSync(path.join(root, 'voice-check'), { recursive: true });

let missed = 0;
let total = 0;
const counts = new Map();
phrases.forEach((raw, i) => {
  const spoken = normalizeForSpeech(raw);
  const text = stress ? forSynth(spoken) : spoken.replace(/\+/g, '');
  const audio = tts.generate({
    text,
    generationConfig: new sherpa.GenerationConfig({
      sid: s.ttsSpeaker ?? 0,
      speed: s.ttsSpeed || 1,
      numSteps: s.ttsSteps ?? 12,
      extra: { lang: 'ru' },
    }),
  });
  if (save) sherpa.writeWave(path.join(root, 'voice-check', `${String(i + 1).padStart(2, '0')}.wav`), audio);
  const stream = asr.createStream();
  stream.acceptWaveform({ samples: audio.samples, sampleRate: audio.sampleRate });
  asr.decode(stream);
  const heard = words(asr.getResult(stream).text);
  const lost = words(spoken).filter((w) => !heard.includes(w));
  missed += lost.length;
  total += words(spoken).length;
  for (const w of lost) counts.set(w, (counts.get(w) || 0) + 1);
  console.log(
    `${lost.length ? '✗' : '✓'} ${text}${lost.length ? `\n    не расслышано: ${lost.join(', ')} | услышано: ${heard.join(' ')}` : ''}`,
  );
});
console.log(
  `\n${stress ? 'С ударениями' : 'Без ударений'}: не расслышано ${missed} слов из ${total} (${((100 * missed) / total).toFixed(1)}%)`,
);
if (counts.size)
  console.log(
    'Чаще всего:',
    [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([w, n]) => `${w}×${n}`)
      .join(', '),
  );
