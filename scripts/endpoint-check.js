// Конец фразы на настоящих моделях: фраза голосом Ориона → распознаватель в режиме «жду вас» → за ней фон.
// Меряет, через сколько после конца фразы она закрывается и не прилипло ли лишнее. Фон — шум (вентилятор,
// гул), тихая речь другим голосом (телевизор, разговор в комнате) или тишина.
//   node scripts/endpoint-check.js
const path = require('node:path');
const { loadConfig } = require('../src/core/config');
const { createSpeech } = require('../src/core/speech');
const { projectConfigFile } = require('../src/app/paths');

const root = path.join(__dirname, '..');
const config = loadConfig(projectConfigFile(root));
const modelsDir = path.resolve(root, config.speech.modelsDir || 'models');
const RATE = 16000;
const CHUNK = 1600; // 100 мс, как от микрофона

// Перевести звук синтезатора в 16 кГц (линейно — для проверки хватает)
function resample(samples, from) {
  if (from === RATE) return samples;
  const out = new Float32Array(Math.floor((samples.length * RATE) / from));
  for (let i = 0; i < out.length; i++) {
    const x = (i * from) / RATE;
    const j = Math.floor(x);
    out[i] = samples[j] + ((samples[j + 1] ?? samples[j]) - samples[j]) * (x - j);
  }
  return out;
}

let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const noise = (sec, level) => Float32Array.from({ length: sec * RATE }, () => rnd() * level);
const scale = (s, k) => s.map((x) => x * k);
const concat = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};

async function main() {
  const speech = createSpeech({ modelsDir, config: config.speech, log: () => {} });
  const say = async (text, speaker) => {
    const r = await speech.synth(text, { sid: speaker });
    return resample(r.samples, r.sampleRate);
  };
  const phrase = await say('поставь будильник на семь утра', config.speech.ttsSpeaker ?? 0);
  const chatter = await say('ну короче я вчера смотрел этот сериал и там такое было что вообще не ожидал', 3);
  const cases = [
    ['тишина', new Float32Array(4 * RATE)],
    ['шум вентилятора', noise(4, 0.01)],
    ['громкий шум', noise(4, 0.05)],
    ['тихий разговор фоном', concat(new Float32Array(0.6 * RATE), scale(chatter, 0.15), noise(1, 0.005))],
    ['разговор фоном погромче', concat(new Float32Array(0.6 * RATE), scale(chatter, 0.35), noise(1, 0.005))],
    ['разговор сразу за фразой', concat(new Float32Array(0.2 * RATE), scale(chatter, 0.2), noise(1, 0.005))],
  ];
  // Сама фраза: тихая (далеко от микрофона) и с паузой посередине — не должны обрываться
  const quiet = scale(phrase, 0.15);
  const half = Math.floor(phrase.length / 2);
  const paused = concat(phrase.subarray(0, half), new Float32Array(0.8 * RATE), phrase.subarray(half));
  const runs = [
    ...cases.map(([title, tail]) => [title, phrase, tail]),
    ['тихая фраза', quiet, new Float32Array(3 * RATE)],
    ['пауза 0,8 с посреди фразы', paused, new Float32Array(3 * RATE)],
  ];
  for (const [title, said, tail] of runs) {
    speech.resetStream();
    speech.setListening(true);
    const audio = concat(new Float32Array(0.3 * RATE), said, tail);
    const end = (0.3 * RATE + said.length) / RATE;
    let final = null;
    let at = 0;
    for (let i = 0; i + CHUNK <= audio.length && !final; i += CHUNK) {
      const r = speech.feed(audio.subarray(i, i + CHUNK));
      if (r?.final) ((final = r.final), (at = (i + CHUNK) / RATE));
    }
    const after = final ? `${Math.round((at - end) * 1000)} мс после конца фразы` : 'не закрылась';
    console.log(`${title.padEnd(26)} ${after.padEnd(28)} «${final ?? ''}»`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
