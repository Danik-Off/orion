// Узнавание людей по голосу (CAM++ через sherpa-onnx, 27 МБ, ~20 мс на фразу).
//
// У каждого человека — несколько образцов голоса (векторы отдельных фраз), а не одно среднее:
// так устойчивее к разной интонации, громкости и длине фраз. Сравнение — со средним трёх лучших образцов.
// Порог подбирается при записи под конкретный голос и микрофон: насколько фразы человека похожи между собой
// и насколько он похож на остальных записанных (похожие голоса — порог выше, чтобы не путать).
// Обычный порог — замер npm run speaker-eval (VoxCeleb1, 40 человек, запись 4 фразы, проверка — короткие
// фразы других дней): при 0,38 своих не узнаёт ~3%, чужих принимает ~0,7%. Прежний потолок 0,55 не узнавал
// треть своих фраз — так и было в жизни: голос, записанный за один раз, похож сам на себя сильнее, чем
// на себя же в другой день, и порог по сходству записи выходил завышенным.
// Уверенные совпадения добавляются как новые образцы — со временем узнавание улучшается.
//
// Собеседник диалога: пока идёт разговор, фраза сравнивается ещё и с фразами этого же разговора —
// тот же микрофон, та же комната, то же настроение, поэтому они похожи сильнее, чем образцы из записи.
// И при сомнении между «тем, с кем говорю» и другим записанным голосом выигрывает собеседник.
// Всё хранится локально в people.json.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SAMPLE_RATE = 16000;
const MIN_SECONDS = 1.2; // по более коротким фразам («да», «стоп») отпечаток ненадёжен — решает проверка адресата
const ENROLL_PHRASES = 4;
const MAX_TEMPLATES = 12; // записанные при регистрации + выученные на ходу
const LEARN_MARGIN = 0.12; // выучить новый образец, если совпадение уверенно выше порога
const AMBIGUITY = 0.05; // два человека почти одинаково похожи — не угадываем
const THRESHOLD_MIN = 0.3;
const THRESHOLD_BASE = 0.38; // обычный порог (см. замер выше)
const THRESHOLD_MAX = 0.6; // выше — только если есть похожий записанный голос
const CALIBRATION = 2; // версия правила порога: записи со старым правилом пересчитываются при загрузке
const IMPOSTOR_MARGIN = 0.08; // порог выше сходства с чужими записанными голосами хотя бы на столько
const PARTNER_SLACK = 0.06; // собеседнику диалога прощаем чуть меньшее сходство
const SESSION_VECTORS = 6; // сколько фраз текущего разговора помнить
const HONORIFICS = ['сэр', 'мисс'];

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

// Сходство с человеком: среднее трёх лучших совпадений с его образцами
function personScore(templates, v) {
  const s = templates.map((t) => cosine(t, v)).sort((a, b) => b - a);
  const top = s.slice(0, Math.min(3, s.length));
  return top.reduce((a, b) => a + b, 0) / top.length;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x) => Math.round(x * 100) / 100;

// Порог под голос и микрофон: насколько фразы записи похожи между собой, с запасом.
// impostor — сходство с самым похожим из других записанных людей: порог должен быть выше него
// (но не выше обычного сходства собственных фраз — иначе человек перестанет узнаваться).
function calibrate(templates, fallback, impostor) {
  if (templates.length < 3) return fallback;
  const typical = median(
    templates.map((t, i) =>
      personScore(
        templates.filter((_, j) => j !== i),
        t,
      ),
    ),
  );
  // Запись шумная или неровная (свои фразы похожи слабо) — порог ниже обычного
  let threshold = Math.min(THRESHOLD_BASE, typical - 0.2);
  if (impostor != null) threshold = Math.max(threshold, Math.min(impostor + IMPOSTOR_MARGIN, typical - 0.08));
  return round(Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, threshold)));
}

// Громкость фразы, дБ относительно предела (0 — максимум; обычная речь у микрофона ≈ −20…−30)
function levelDb(samples) {
  if (!samples?.length) return -100;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.max(-100, 10 * Math.log10(sum / samples.length || 1e-10));
}

const publicPerson = (p) =>
  p
    ? {
        id: p.id,
        name: p.name,
        honorific: p.honorific,
        threshold: p.threshold,
        samples: p.templates.length,
        level: p.level,
        noise: p.noise,
      }
    : null;

function createSpeakerId({ modelsDir, dataDir, config, log = () => {} }) {
  const file = path.join(dataDir, 'people.json');
  const modelFile = path.join(modelsDir, config.model || '');
  let extractor = null;
  if (config.require !== 'off' && config.model && fs.existsSync(modelFile)) {
    try {
      const sherpa = require('sherpa-onnx-node');
      extractor = new sherpa.SpeakerEmbeddingExtractor({ model: modelFile, numThreads: 1, provider: 'cpu', debug: 0 });
    } catch (e) {
      log(`Модель голоса не загрузилась: ${e.message}`);
    }
  }

  let people = [];
  try {
    people = JSON.parse(fs.readFileSync(file, 'utf8')).map((p) => ({
      ...p,
      // старый формат: одно усреднённое embedding → один образец
      templates: (p.templates || [p.embedding]).filter(Boolean).map((t) => Float32Array.from(t)),
      threshold: p.threshold ?? config.threshold,
      learned: p.learned || 0,
    }));
  } catch {}
  const save = () =>
    fs.writeFileSync(
      file,
      JSON.stringify(people.map(({ embedding, ...p }) => ({ ...p, templates: p.templates.map((t) => Array.from(t)) }))),
    );
  if (people.some((p) => !p.templates.length)) people = people.filter((p) => p.templates.length);
  // Порог по старому правилу — пересчитать по образцам записи (первые ENROLL_PHRASES), перезаписывать голос не нужно
  if (people.some((p) => p.cal !== CALIBRATION)) {
    for (const p of people.filter((x) => x.cal !== CALIBRATION)) {
      const own = p.templates.slice(0, ENROLL_PHRASES);
      const others = people.filter((o) => o !== p);
      const impostor = others.length ? Math.max(...others.map((o) => median(own.map((t) => personScore(o.templates, t))))) : null;
      const before = p.threshold;
      p.threshold = calibrate(own, config.threshold, impostor);
      p.cal = CALIBRATION;
      log(`порог голоса ${p.name || p.id}: ${before} → ${p.threshold} (новое правило)`);
    }
    try {
      save();
    } catch {}
  }

  // Переход с самого старого формата (один отпечаток без имени)
  const legacy = path.join(dataDir, 'voiceprint.json');
  if (!people.length && fs.existsSync(legacy)) {
    try {
      const { embedding } = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      people.push({
        id: 'owner',
        name: '',
        honorific: 'сэр',
        templates: [Float32Array.from(embedding)],
        threshold: config.threshold,
        learned: 0,
        created: Date.now(),
      });
      save();
      fs.unlinkSync(legacy);
    } catch {}
  }

  let enrolling = null; // фразы во время записи: [{ v, level }]
  let last = null; // последняя оценка — для панели «Люди»
  let partner = null; // собеседник текущего диалога: { id, vectors } — векторы его фраз в этом разговоре

  function embed(audio) {
    if (!extractor || !audio || audio.length < SAMPLE_RATE * MIN_SECONDS) return null;
    const stream = extractor.createStream();
    stream.acceptWaveform({ samples: audio, sampleRate: SAMPLE_RATE });
    stream.inputFinished();
    if (!extractor.isReady(stream)) return null;
    return extractor.compute(stream, false); // false — Electron запрещает внешние буферы
  }

  // С кем идёт разговор (id записанного человека; null — гость или разговора нет)
  function setPartner(id) {
    if (!id || !people.some((p) => p.id === id)) partner = null;
    else if (partner?.id !== id) partner = { id, vectors: [] };
  }

  // Кто говорит → { person, score, match, ambiguous, candidates, best, via } или null
  // (нет модели, никого не записано, фраза слишком короткая)
  function identify(audio) {
    if (!people.length) return null;
    const v = embed(audio);
    if (!v) return null;
    const ranked = people.map((p) => ({ p, score: personScore(p.templates, v) })).sort((a, b) => b.score - a.score);
    const [best, second] = ranked;

    let chosen = null;
    let via = 'profile';
    // 1. Собеседник диалога: сходство с записью или с его же фразами в этом разговоре,
    //    с небольшой поблажкой — если никто другой не похож заметно сильнее
    const mate = partner && ranked.find((r) => r.p.id === partner.id);
    if (mate) {
      const session = partner.vectors.length ? personScore(partner.vectors, v) : 0;
      const score = Math.max(mate.score, session);
      const rival = ranked.find((r) => r !== mate);
      const beaten = rival && rival.score >= rival.p.threshold && rival.score - mate.score > AMBIGUITY;
      if (!beaten && score >= mate.p.threshold - PARTNER_SLACK) {
        chosen = { p: mate.p, score };
        via = session > mate.score ? 'session' : 'partner';
      }
    }
    // 2. Обычное узнавание: лучший из записанных, если он выше своего порога и нет двойника
    const ambiguous = !chosen && second && best.score - second.score < AMBIGUITY && second.score >= second.p.threshold;
    if (!chosen && best.score >= best.p.threshold && !ambiguous) chosen = best;

    const match = !!chosen;
    const shown = chosen || best;
    last = {
      name: shown.p.name,
      score: round(shown.score),
      threshold: shown.p.threshold,
      match,
      via: match ? via : undefined,
      at: Date.now(),
    };

    if (match) {
      // Фраза собеседника — запоминаем до конца разговора
      if (partner?.id === chosen.p.id) {
        partner.vectors.push(v);
        if (partner.vectors.length > SESSION_VECTORS) partner.vectors.shift();
      }
      // Уверенное совпадение по записи — новый образец голоса (выученные вытесняют старые выученные)
      const own = ranked.find((r) => r.p === chosen.p).score;
      if (own >= chosen.p.threshold + LEARN_MARGIN) {
        const p = chosen.p;
        if (p.templates.length >= MAX_TEMPLATES) p.templates.splice(ENROLL_PHRASES, 1);
        p.templates.push(v);
        p.learned += 1;
        save();
      }
    }
    // Неоднозначно (два записанных голоса почти одинаково похожи) — это НЕ чужой: отдаём кандидатов,
    // окно выберет того, с кем уже идёт разговор
    const candidates = ambiguous ? ranked.filter((r) => r.score >= r.p.threshold).map((r) => r.p.id) : undefined;
    return {
      person: match ? publicPerson(chosen.p) : null,
      score: last.score,
      match,
      ambiguous: ambiguous || undefined,
      candidates,
      best: best.p.id,
      via: last.via,
    };
  }

  const enroll = {
    start() {
      enrolling = [];
      return { needed: ENROLL_PHRASES };
    },
    // level — громкость фразы (дБ), noise — шум комнаты (дБ) → { count, needed, done } или { error }
    add(audio, { level, noise } = {}) {
      if (!enrolling) return { error: 'Запись голоса не начата' };
      const v = embed(audio);
      if (!v) return { error: 'Фраза слишком короткая — скажите чуть длиннее' };
      enrolling.push({ v, level: level ?? levelDb(audio), noise });
      return { count: enrolling.length, needed: ENROLL_PHRASES, done: enrolling.length >= ENROLL_PHRASES };
    },
    // Сохранить нового человека (или перезаписать голос существующего)
    finish({ name, honorific, id } = {}) {
      if (!enrolling || enrolling.length < ENROLL_PHRASES) return { error: 'Нужно ещё несколько фраз' };
      const phrases = enrolling;
      enrolling = null;
      const templates = phrases.map((x) => x.v);
      // Самый похожий из остальных записанных — чтобы не путать похожие голоса
      let similar = null;
      for (const o of people.filter((p) => p.id !== id)) {
        const score = median(templates.map((t) => personScore(o.templates, t)));
        if (!similar || score > similar.score) similar = { id: o.id, name: o.name, score: round(score), threshold: o.threshold };
      }
      const threshold = calibrate(templates, config.threshold, similar?.score);
      const level = round(median(phrases.map((x) => x.level)));
      const noises = phrases.map((x) => x.noise).filter((x) => typeof x === 'number');
      const noise = noises.length ? round(median(noises)) : undefined;
      let person = id && people.find((p) => p.id === id);
      if (person) Object.assign(person, { templates, threshold, cal: CALIBRATION, learned: 0, level, noise });
      else {
        person = {
          id: crypto.randomUUID(),
          name: '',
          honorific: 'сэр',
          templates,
          threshold,
          cal: CALIBRATION,
          learned: 0,
          level,
          noise,
          created: Date.now(),
        };
        people.push(person);
      }
      // Другой записанный голос почти неотличим — скорее всего, это тот же человек записан дважды
      // Иначе поднимаем и его порог, чтобы новые фразы не приписывались ему (но не выше его собственного сходства)
      if (similar && similar.score >= Math.min(similar.threshold, threshold)) {
        const other = people.find((p) => p.id === similar.id);
        if (other) other.threshold = Math.max(other.threshold, calibrate(other.templates, other.threshold, similar.score));
      } else similar = null;
      log(`голос записан: порог ${threshold}, громкость ${level} дБ${noise != null ? `, шум ${noise} дБ` : ''}`);
      update(person.id, { name, honorific });
      return { ...publicPerson(person), similar: similar ? { id: similar.id, name: similar.name, score: similar.score } : undefined };
    },
    cancel() {
      enrolling = null;
    },
  };

  function update(id, { name, honorific } = {}) {
    const p = people.find((x) => x.id === id);
    if (!p) return null;
    if (typeof name === 'string') p.name = name.trim().slice(0, 40);
    if (HONORIFICS.includes(honorific)) p.honorific = honorific;
    save();
    return publicPerson(p);
  }

  function remove(id) {
    people = people.filter((p) => p.id !== id);
    if (partner?.id === id) partner = null;
    save();
  }

  return {
    available: !!extractor,
    enrolling: () => !!enrolling,
    list: () => people.map(publicPerson),
    get: (id) => publicPerson(people.find((p) => p.id === id)),
    last: () => last,
    identify,
    setPartner,
    endSession: () => (partner = null),
    enroll,
    update,
    remove,
  };
}

module.exports = { createSpeakerId, cosine, personScore, calibrate, levelDb, HONORIFICS };
