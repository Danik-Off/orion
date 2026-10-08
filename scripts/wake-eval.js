// Замер ожидания имени: сколько раз «Орион» услышан, сколько ложных срабатываний и сколько это стоит процессору.
// Звук — синтез Supertonic (10 голосов, две скорости, с шумом и без); фразы с именем и обычная речь без него.
//   npm run wake-eval              — сравнить все способы
//   npm run wake-eval -- --save    — сохранить звук в wake-eval/ (послушать)
// Способ — как в приложении: потоковый распознаватель Vosk, имя ищется в тексте (core/wake.js).
// Проверено 2026-10-07: маленькая модель поиска ключевых слов (KWS 3.3M, англ.) русское «Орион» не слышит (0%),
// KWS на модели Vosk — 95% и ложные; текущий способ — 98% без ложных при 1,5% одного ядра.
const fs = require('node:fs');
const path = require('node:path');
const { projectConfigFile } = require('../src/app/paths');
const sherpa = require('sherpa-onnx-node');
const { loadConfig } = require('../src/core/config');
const { createWakeMatcher } = require('../src/core/wake');
const { forSynth } = require('../src/lib/stress');

const root = path.join(__dirname, '..');
const config = loadConfig(projectConfigFile(root));
const s = config.speech;
const modelsDir = path.resolve(root, s.modelsDir || 'models');
const save = process.argv.includes('--save');
const SR = 16000;

function pick(dir, re) {
  const found = fs
    .readdirSync(dir)
    .filter((n) => re.test(n))
    .sort((a, b) => a.length - b.length);
  if (!found.length) throw new Error(`В ${dir} нет ${re}`);
  return path.join(dir, found[0]);
}

const POSITIVE = [
  'Орион.',
  'Орион, включи музыку.',
  'Орион, какая погода?',
  'Слушай, Орион, который час?',
  'Эй, Орион.',
  'Орион, открой телеграм.',
  'Так, Орион, поставь будильник на семь.',
  'Орион, громче.',
];
const NEGATIVE = [
  'Включи музыку погромче.',
  'Мне нужно купить хлеба и молока.',
  'Над горами летал орёл.',
  'В нашем регионе сегодня дождь.',
  'Это стоит миллион рублей.',
  'Позвони Ирине вечером.',
  'По радио передавали новости.',
  'Созвездие Ориона видно зимой.',
  'Он ориентировался по карте.',
  'Привет, как дела на работе?',
  'Давай закажем пиццу на ужин.',
  'Мы поедем на дачу в субботу.',
];

// --- синтез ---
const ttsDir = path.join(modelsDir, s.ttsModel);
const fp32 = path.join(modelsDir, 'supertonic-3-fp32');
const part = (name) =>
  fs.existsSync(path.join(fp32, `${name}.onnx`)) ? path.join(fp32, `${name}.onnx`) : pick(ttsDir, new RegExp(`^${name}.*\\.onnx$`));
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
    numThreads: 4,
    provider: 'cpu',
  },
  maxNumSentences: 1,
});

// Простой генератор шума с фиксированным зерном — замер повторяем
let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

function clip(text, sid, speed, noiseDb) {
  const a = tts.generate({
    text: forSynth(text),
    generationConfig: new sherpa.GenerationConfig({ sid, speed, numSteps: 8, extra: { lang: 'ru' } }),
  });
  const res = new sherpa.LinearResampler(a.sampleRate, SR);
  const speech = res.resample(a.samples, true);
  // 0,6 с тишины до и 1,5 с после — как в комнате
  const out = new Float32Array(Math.round(SR * 0.6) + speech.length + Math.round(SR * 1.5));
  out.set(speech, Math.round(SR * 0.6));
  if (noiseDb !== null) {
    let p = 0;
    for (const v of speech) p += v * v;
    const amp = Math.sqrt(p / speech.length) * 10 ** (-noiseDb / 20);
    for (let i = 0; i < out.length; i++) out[i] += amp * rand() * 1.7;
  }
  return out;
}

console.log('Синтез…');
const clips = [];
for (let sid = 0; sid < 10; sid++) {
  for (const speed of [0.9, 1.15]) {
    const noise = speed > 1 ? 10 : null; // половина — с шумом 10 дБ ниже речи
    for (const text of POSITIVE) clips.push({ text, wake: true, sid, speed, samples: clip(text, sid, speed, noise) });
    for (const text of NEGATIVE) clips.push({ text, wake: false, sid, speed, samples: clip(text, sid, speed, noise) });
  }
}
if (save) {
  fs.mkdirSync(path.join(root, 'wake-eval'), { recursive: true });
  clips.forEach((c, i) =>
    sherpa.writeWave(path.join(root, 'wake-eval', `${String(i).padStart(3, '0')}-${c.wake ? 'y' : 'n'}.wav`), {
      samples: c.samples,
      sampleRate: SR,
    }),
  );
}
const seconds = clips.reduce((n, c) => n + c.samples.length / SR, 0);

function report(name, detect) {
  const t0 = process.cpuUsage();
  const w0 = performance.now();
  let hit = 0;
  let fa = 0;
  const misses = [];
  const falses = [];
  for (const c of clips) {
    const found = detect(c.samples);
    if (c.wake && found) hit++;
    if (c.wake && !found) misses.push(`${c.sid}/${c.speed}: ${c.text}`);
    if (!c.wake && found) (fa++, falses.push(`${c.sid}/${c.speed}: ${c.text}`));
  }
  const cpu = process.cpuUsage(t0);
  const pos = clips.filter((c) => c.wake).length;
  const neg = clips.length - pos;
  const cpuMs = (cpu.user + cpu.system) / 1000;
  console.log(
    `${name.padEnd(28)} услышал ${hit}/${pos} (${Math.round((hit / pos) * 100)}%), ложных ${fa}/${neg}, ` +
      `процессор ${((cpuMs / 1000 / seconds) * 100).toFixed(1)}% одного ядра (стена ${Math.round(performance.now() - w0)} мс на ${Math.round(seconds)} с звука)`,
  );
  if (process.argv.includes('-v')) {
    for (const m of misses) console.log(`   не услышал  ${m}`);
    for (const f of falses) console.log(`   ложное      ${f}`);
  }
}

// --- способ 1: распознаватель Vosk + поиск имени в тексте (как сейчас) ---
const asrDir = path.join(modelsDir, s.asrModel);
const wake = createWakeMatcher(s.wakeWords);
const asr = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: SR, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: pick(asrDir, /^encoder.*\.onnx$/),
      decoder: pick(asrDir, /^decoder.*\.onnx$/),
      joiner: pick(asrDir, /^joiner.*\.onnx$/),
    },
    tokens: path.join(asrDir, 'tokens.txt'),
    numThreads: 1,
    provider: 'cpu',
  },
  decodingMethod: 'greedy_search',
  enableEndpoint: true,
  rule2MinTrailingSilence: 1.2,
});
report('asr (Vosk + текст)', (samples) => {
  const st = asr.createStream();
  let found = false;
  for (let i = 0; i < samples.length && !found; i += 1600) {
    st.acceptWaveform({ samples: samples.subarray(i, i + 1600), sampleRate: SR });
    while (asr.isReady(st)) asr.decode(st);
    const text = asr.getResult(st).text.toLowerCase();
    if (text && wake.strip(text) !== null) found = true;
    if (asr.isEndpoint(st)) asr.reset(st);
  }
  return found;
});
