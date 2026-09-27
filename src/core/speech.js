// Офлайн-речь через sherpa-onnx: потоковое распознавание (Vosk zipformer) и синтез (Piper или Supertonic).
const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_RATE = 16000;

function pick(dir, re) {
  const found = fs.readdirSync(dir).filter((n) => re.test(n)).sort((a, b) => a.length - b.length);
  if (!found.length) throw new Error(`В ${dir} нет файла ${re}`);
  return path.join(dir, found[0]);
}

// Словарь BPE для подсказок (hotwords): sherpa-onnx ждёт текстовый bpe.vocab («кусок\tвес»),
// а в моделях лежит только bpe.model (protobuf sentencepiece). Разбираем его сами: без Python.
function ensureBpeVocab(dir) {
  const vocab = path.join(dir, 'bpe.vocab');
  if (fs.existsSync(vocab)) return vocab;
  const buf = fs.readFileSync(path.join(dir, 'bpe.model'));
  const varint = (b, p) => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const x = b[p++];
      v += (x & 0x7f) * 2 ** shift;
      shift += 7;
      if (x < 0x80) return [v, p];
    }
  };
  const lines = [];
  for (let p = 0; p < buf.length; ) {
    let tag;
    [tag, p] = varint(buf, p);
    const wire = tag & 7;
    if (wire === 0) [, p] = varint(buf, p);
    else if (wire === 5) p += 4;
    else if (wire === 1) p += 8;
    else if (wire === 2) {
      let len;
      [len, p] = varint(buf, p);
      if (tag >> 3 === 1) {
        // SentencePiece { 1: piece, 2: score }
        let piece = '';
        let score = 0;
        for (let q = p; q < p + len; ) {
          let t;
          [t, q] = varint(buf, q);
          if ((t & 7) === 2) {
            let l;
            [l, q] = varint(buf, q);
            if (t >> 3 === 1) piece = buf.toString('utf8', q, q + l);
            q += l;
          } else if ((t & 7) === 5) {
            if (t >> 3 === 2) score = buf.readFloatLE(q);
            q += 4;
          } else if ((t & 7) === 0) [, q] = varint(buf, q);
          else if ((t & 7) === 1) q += 8;
          else break;
        }
        lines.push(`${piece}\t${score}`);
      }
      p += len;
    } else break;
  }
  fs.writeFileSync(vocab, lines.join('\n') + '\n');
  return vocab;
}

// Подсказки распознавателю (contextual biasing): имя ассистента и слова из speech.hotwords.
// Модель не знает слова «Орион» и слышит «алён», «орёт», «айон»; подсказка поднимает вероятность нужных
// кусочков слова. Замер (240 фраз, 10 голосов, шум): имя дословно 100/120 → 114/120, ложных срабатываний 0;
// при весе 3,5 появляются ложные — поэтому 1,5.
function hotwordsFor(config) {
  const words = [...(config.wakeWords || []), ...(config.hotwords || [])]
    .map((w) => String(w).toLowerCase().replace(/ё/g, 'е').trim())
    .filter((w) => /^[а-я -]+$/.test(w)); // в словаре моделей только кириллица
  if (!words.length || config.hotwordsScore === 0) return null;
  const file = path.join(require('node:os').tmpdir(), 'orion-hotwords.txt');
  fs.writeFileSync(file, [...new Set(words)].join('\n') + '\n');
  return { file, score: config.hotwordsScore ?? 1.5 };
}

// Подключить подсказки к модели: нужен beam search (greedy их не поддерживает) и словарь BPE
function withHotwords(dir, modelConfig, hotwords, log) {
  if (!hotwords) return { modelConfig, decoding: { decodingMethod: 'greedy_search' } };
  try {
    return {
      modelConfig: { ...modelConfig, modelingUnit: 'bpe', bpeVocab: ensureBpeVocab(dir) },
      decoding: { decodingMethod: 'modified_beam_search', maxActivePaths: 4, hotwordsFile: hotwords.file, hotwordsScore: hotwords.score },
    };
  } catch (e) {
    log(`Подсказки распознавателю недоступны: ${e.message}`);
    return { modelConfig, decoding: { decodingMethod: 'greedy_search' } };
  }
}

// Supertonic окружает речь тишиной: 0,3–0,5 с в начале и 0,5–0,6 с в конце. Начальная откладывала первый звук,
// а вместе с конечной давала почти секунду паузы между предложениями. Оставляем по краю немного —
// паузы между кусками ставит окно (после точки длиннее, после запятой короче).
// Граница — на 50 дБ тише самого громкого места, окнами по 10 мс: тихое начало слова не срезается.
function trimSilence(samples, sampleRate, { lead = 0.04, tail = 0.1 } = {}) {
  const win = Math.max(1, Math.round(sampleRate / 100));
  const energy = [];
  for (let i = 0; i < samples.length; i += win) {
    let e = 0;
    const end = Math.min(samples.length, i + win);
    for (let k = i; k < end; k++) e += samples[k] * samples[k];
    energy.push(e / (end - i));
  }
  const floor = Math.max(...energy, 0) * 1e-5; // −50 дБ по мощности
  const first = energy.findIndex((e) => e > floor);
  if (first < 0) return samples;
  let last = energy.length - 1;
  while (last > first && energy[last] <= floor) last--;
  const from = Math.max(0, first * win - Math.round(lead * sampleRate));
  const to = Math.min(samples.length, (last + 1) * win + Math.round(tail * sampleRate));
  return from === 0 && to === samples.length ? samples : samples.slice(from, to);
}

function createSpeech({ modelsDir, config = {}, log = console.warn }) {
  let sherpa;
  try {
    sherpa = require('sherpa-onnx-node');
  } catch (e) {
    log(`sherpa-onnx недоступен: ${e.message}`);
    return { stt: false, tts: false };
  }

  let recognizer = null;
  let stream = null;
  const asrDir = path.join(modelsDir, config.asrModel || '');
  const hotwords = hotwordsFor(config);
  if (config.asrModel && fs.existsSync(asrDir)) {
    try {
      const { modelConfig, decoding } = withHotwords(
        asrDir,
        {
          transducer: {
            encoder: pick(asrDir, /^encoder.*\.onnx$/),
            decoder: pick(asrDir, /^decoder.*\.onnx$/),
            joiner: pick(asrDir, /^joiner.*\.onnx$/),
          },
          tokens: path.join(asrDir, 'tokens.txt'),
          numThreads: 1,
          provider: 'cpu',
          debug: 0,
        },
        hotwords,
        log,
      );
      recognizer = new sherpa.OnlineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig,
        ...decoding,
        enableEndpoint: true,
        rule1MinTrailingSilence: 2.4, // тишина без слов — сброс
        rule2MinTrailingSilence: 1.2, // пауза после слов — конец фразы (можно подумать посреди команды)
        rule3MinUtteranceLength: 30, // длинные команды до 30 секунд
      });
      stream = recognizer.createStream();
    } catch (e) {
      log(`Не удалось загрузить модель распознавания: ${e.message}`);
      recognizer = null;
    }
  }

  // Второй проход: готовая фраза один раз перераспознаётся точной офлайн-моделью (~50 мс на фразу).
  // Потоковая модель остаётся для текста на лету и быстрого отклика на имя.
  let secondPass = null;
  const secondDir = path.join(modelsDir, config.asrSecondPass || '');
  if (recognizer && config.asrSecondPass && fs.existsSync(secondDir)) {
    try {
      const { modelConfig, decoding } = withHotwords(
        secondDir,
        {
          transducer: {
            encoder: pick(secondDir, /^encoder.*\.onnx$/),
            decoder: pick(secondDir, /^decoder.*\.onnx$/),
            joiner: pick(secondDir, /^joiner.*\.onnx$/),
          },
          tokens: path.join(secondDir, 'tokens.txt'),
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
        hotwords,
        log,
      );
      secondPass = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 }, modelConfig, ...decoding });
    } catch (e) {
      log(`Второй проход распознавания не загрузился: ${e.message}`);
    }
  }

  function recognizeAgain(audio) {
    if (!secondPass || audio.length < SAMPLE_RATE * 0.3) return '';
    const s = secondPass.createStream();
    const padded = new Float32Array(audio.length + SAMPLE_RATE / 2); // хвост тишины — чтобы не терять последнее слово
    padded.set(audio);
    s.acceptWaveform({ samples: padded, sampleRate: SAMPLE_RATE });
    secondPass.decode(s);
    return secondPass.getResult(s).text.trim().toLowerCase();
  }

  // Детектор речи (Silero VAD, 1 МБ): пока в комнате тишина или шум, распознаватель не работает вовсе.
  let vad = null;
  const vadFile = path.join(modelsDir, config.vadModel || 'silero_vad.onnx');
  if (recognizer && fs.existsSync(vadFile)) {
    try {
      vad = new sherpa.Vad(
        {
          // порог 0.35 (а не 0.5): тихое «Орион» чаще доходит до распознавателя
          sileroVad: { model: vadFile, threshold: config.vadThreshold ?? 0.35, minSilenceDuration: 0.4, minSpeechDuration: 0.15, windowSize: 512 },
          sampleRate: SAMPLE_RATE,
          numThreads: 1,
          provider: 'cpu',
          debug: 0,
        },
        5,
      );
    } catch (e) {
      log(`VAD не загрузился, распознаю без него: ${e.message}`);
    }
  }

  let tts = null;
  const ttsDir = path.join(modelsDir, config.ttsModel || '');
  // Два движка: Piper (VITS) — самый лёгкий; Supertonic 3 — естественнее, 10 голосов.
  const supertonic = fs.existsSync(path.join(ttsDir, 'tts.json'));
  // Полноточные файлы Supertonic (скачиваются установщиком по ttsPrecision) — чище звук, чуть медленнее
  const fp32Dir = path.join(modelsDir, 'supertonic-3-fp32');
  const precise = (part) => {
    const wanted = config.ttsPrecision === 'full' || (config.ttsPrecision === 'vocoder' && part === 'vocoder');
    const file = path.join(fp32Dir, `${part}.onnx`);
    return wanted && fs.existsSync(file) ? file : pick(ttsDir, new RegExp(`^${part}.*\\.onnx$`));
  };
  if (config.ttsModel && fs.existsSync(ttsDir)) {
    try {
      const model = supertonic
        ? {
            supertonic: {
              durationPredictor: precise('duration_predictor'),
              textEncoder: precise('text_encoder'),
              vectorEstimator: precise('vector_estimator'),
              vocoder: precise('vocoder'),
              ttsJson: path.join(ttsDir, 'tts.json'),
              unicodeIndexer: path.join(ttsDir, 'unicode_indexer.bin'),
              voiceStyle: path.join(ttsDir, 'voice.bin'),
            },
          }
        : {
            vits: {
              model: pick(ttsDir, /\.onnx$/),
              tokens: path.join(ttsDir, 'tokens.txt'),
              dataDir: path.join(ttsDir, 'espeak-ng-data'),
              // Тембр: noiseScale — живость интонации, lengthScale > 1 — речь неспешнее
              ...(config.ttsTuning || {}),
            },
          };
      tts = new sherpa.OfflineTts({
        model: {
          ...model,
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
        maxNumSentences: 1,
      });
    } catch (e) {
      log(`Не удалось загрузить голос: ${e.message}`);
      tts = null;
    }
  }

  let lastPartial = '';
  // quickEnd(текст) → true — фраза уже законченная команда, закрыть её раньше обычной паузы
  let quickEnd = null;
  let quickChecked = '';
  const QUICK_END_MS = 300;
  let active = !vad; // без VAD распознаватель слушает всё подряд
  let silentMs = 0;
  const preroll = []; // последние ~0.5 с звука, чтобы не терять начало слова
  const PREROLL_CHUNKS = 8; // 0,8 с: не срезать тихое начало слова («О-рион»)
  const HANGOVER_MS = 1200; // сколько ждать после конца речи, прежде чем закрыть фразу

  // Звук текущей фразы (не дольше 30 с): целиком с паузами — для второго прохода,
  // только речь — для узнавания голоса (тишина портит отпечаток)
  let utterance = [];
  let voiceOnly = [];
  let utteranceLen = 0;
  const MAX_UTTERANCE = SAMPLE_RATE * 30;
  const keep = (chunk, isSpeech = true) => {
    if (utteranceLen >= MAX_UTTERANCE) return;
    utterance.push(chunk);
    if (isSpeech) voiceOnly.push(chunk);
    utteranceLen += chunk.length;
  };
  const join = (chunks) => {
    const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) out.set(c, (o += c.length) - c.length);
    return out;
  };
  const takeUtterance = () => {
    const result = { all: join(utterance), voice: join(voiceOnly) };
    utterance = [];
    voiceOnly = [];
    utteranceLen = 0;
    return result;
  };

  // Режим «жду вас» (после имени, клавиши, в окне продолжения диалога): весь звук идёт в распознаватель,
  // детектор речи не отсекает тихую фразу. Проверено: тише на 30 дБ — услышано 60 из 60 вместо 40,
  // на 36 дБ — 59 из 60 вместо 0; ложных фраз в тишине комнаты нет. В остальное время детектор экономит ресурсы.
  let listening = false;
  function setListening(value) {
    listening = !!value;
    if (listening) active = true;
  }

  // Усиление под голос: подбирается при записи голоса по громкости ваших фраз (тихий голос или далёкий
  // микрофон — до +12 дБ), чтобы детектор речи и распознаватель слышали вас так же, как громкую речь.
  let gain = 1;
  let gainDb = 0;
  function setGain(db) {
    gainDb = Math.max(0, Math.min(12, Number(db) || 0));
    gain = 10 ** (gainDb / 20);
  }
  const amplify = (samples) => {
    if (gain === 1) return samples;
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = Math.max(-1, Math.min(1, samples[i] * gain));
    return out;
  };

  // Шум комнаты (дБ, до усиления): медленное среднее громкости там, где детектор не слышит речи.
  // Нужен при записи голоса — проверить, что фраза записалась громче фона.
  let noiseDb = null;
  const chunkDb = (s) => {
    let sum = 0;
    for (let i = 0; i < s.length; i++) sum += s[i] * s[i];
    return Math.max(-100, 10 * Math.log10(sum / s.length || 1e-10));
  };

  // Принимает кусок аудио 16 кГц; возвращает {partial} по ходу речи или {final, audio} в конце фразы.
  function feed(raw) {
    if (!recognizer) return null;
    const samples = amplify(raw);

    if (vad) {
      vad.acceptWaveform(samples);
      while (!vad.isEmpty()) vad.pop(); // готовые сегменты не нужны — важен только факт речи
      const speech = vad.isDetected();
      if (!speech) {
        const db = chunkDb(raw);
        noiseDb = noiseDb === null ? db : noiseDb * 0.97 + db * 0.03;
      }
      preroll.push(samples);
      if (preroll.length > PREROLL_CHUNKS) preroll.shift();
      if (!active) {
        if (!speech && !listening) return null; // тишина: ноль работы для распознавателя
        active = true;
        silentMs = 0;
        for (const chunk of preroll) {
          stream.acceptWaveform({ samples: chunk, sampleRate: SAMPLE_RATE });
          keep(chunk);
        }
      } else {
        stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
        keep(samples, speech);
      }
      silentMs = speech ? 0 : silentMs + (samples.length / SAMPLE_RATE) * 1000;
    } else {
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      keep(samples);
    }

    while (recognizer.isReady(stream)) recognizer.decode(stream);
    const text = recognizer.getResult(stream).text.trim().toLowerCase();
    // Конец фразы: пауза по распознавателю; по детектору речи — только вне режима «жду вас»
    // (иначе тихая фраза обрывалась бы посередине)
    const vadSilence = vad && !listening && silentMs >= HANGOVER_MS;
    // Законченная короткая команда («пауза», «громче», «который час», «да» в подтверждении) — не ждём полную
    // паузу 1,2 с: детектор речи уже слышит тишину (сам он отпускает речь через 0,4 с) плюс QUICK_END_MS
    let quick = false;
    if (quickEnd && text && vad && silentMs >= QUICK_END_MS && text !== quickChecked) {
      quickChecked = text;
      try {
        quick = !!quickEnd(text);
      } catch {}
    }
    if (recognizer.isEndpoint(stream) || vadSilence || quick) {
      recognizer.reset(stream);
      lastPartial = '';
      quickChecked = '';
      if (vadSilence) active = false;
      const { all, voice } = takeUtterance();
      if (!text) return null;
      // Точный текст — от второго прохода; быстрый остаётся запасным (и для поиска имени)
      const precise = recognizeAgain(all);
      return { final: precise || text, firstPass: text, audio: voice };
    }
    if (text === lastPartial) return null;
    lastPartial = text;
    return { partial: text };
  }

  // Забыть недослушанное (например, пока ассистент говорил сам).
  function resetStream() {
    if (!recognizer) return;
    stream = recognizer.createStream();
    lastPartial = '';
    quickChecked = '';
    active = !vad || listening;
    silentMs = 0;
    preroll.length = 0;
    takeUtterance();
    vad?.reset();
  }

  // Синтез в фоновом потоке аддона; запросы выполняются по очереди.
  // Короткие частые фразы («Готово, сэр.», «Сейчас поищу.») берутся из кэша — без синтеза вовсе.
  let queue = Promise.resolve();
  const cache = new Map();
  const CACHE_SIZE = 40;
  const CACHE_TEXT = 60;
  function synth(text) {
    if (!tts) return Promise.resolve(null);
    const sid = config.ttsSpeaker ?? 0;
    const speed = config.ttsSpeed || 1.0;
    const key = `${sid}|${speed}|${config.ttsSteps}|${text}`;
    if (cache.has(key)) {
      const hit = cache.get(key);
      cache.delete(key); // в конец очереди — давно не нужные вытесняются первыми
      cache.set(key, hit);
      return Promise.resolve(hit);
    }
    const job = queue.then(async () => {
      const request = supertonic
        ? {
            text,
            generationConfig: new sherpa.GenerationConfig({
              sid,
              speed,
              numSteps: config.ttsSteps ?? 8, // больше шагов — чище звук, но медленнее
              extra: { lang: 'ru' },
            }),
          }
        : { text, sid, speed };
      // enableExternalBuffer: false — Electron запрещает внешние буферы (V8 memory cage)
      const audio = await tts.generateAsync({ ...request, enableExternalBuffer: false });
      const result = { samples: trimSilence(audio.samples, audio.sampleRate), sampleRate: audio.sampleRate };
      if (text.length <= CACHE_TEXT) {
        cache.set(key, result);
        if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
      }
      return result;
    });
    queue = job.catch(() => {});
    return job;
  }

  const levels = () => ({ noise: noiseDb === null ? null : Math.round(noiseDb * 10) / 10, gain: gainDb });

  const setQuickEnd = (fn) => (quickEnd = typeof fn === 'function' ? fn : null);

  return { stt: !!recognizer, tts: !!tts, vad: !!vad, secondPass: !!secondPass, sampleRate: SAMPLE_RATE, feed, resetStream, setListening, setGain, setQuickEnd, levels, synth };
}

module.exports = { createSpeech, trimSilence };
