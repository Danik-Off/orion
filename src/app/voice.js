// Голос: микрофон → распознавание → ключевое слово и узнавание голоса → окно; синтез ответа; записи голосов людей.
const { createSpeech } = require('../core/speech');
const { createSpeakerId, levelDb, HONORIFICS } = require('../core/speaker');
const { normalizeForSpeech } = require('../lib/speech-text');
const { forSynth } = require('../lib/stress');
const { createQuietGate } = require('./quiet-gate');

const MAX_CHUNK = 16000; // кусок звука от окна — 100 мс при 16 кГц; больше секунды — не наш
const SPEECH_TARGET_DB = -26; // речь самого тихого записанного голоса доводится примерно до этой громкости
const debug = () => process.env.JARVIS_DEBUG;

// Ранний конец фразы: законченная короткая команда закрывается через ~0,7 с тишины вместо 1,2 с.
const QUICK_STOP = /^(стоп|хватит|замолчи|тихо|помолчи)$/;
const QUICK_ANSWER = /^(да|нет|ага|отмена|не надо|подтверждаю)$/;

// Фраза записи голоса сказана именно вами: распознанное похоже на текст на экране (по основам слов —
// распознаватель может ошибиться в окончаниях). Разговор или телевизор на фоне так не пройдут.
const stems = (t) =>
  String(t)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/)
    .filter((w) => w.length > 2)
    .map((w) => w.slice(0, 4));
function phraseMatch(expected, heard) {
  const want = stems(expected);
  const got = new Set(heard.flatMap(stems));
  return want.length ? want.filter((s) => got.has(s)).length / want.length : 1;
}

// Усиление микрофона под самый тихий из записанных голосов; speech.inputGainDb в config.json — вручную
function inputGainFor(levels, manual) {
  if (typeof manual === 'number') return manual;
  return levels.length ? SPEECH_TARGET_DB - Math.min(...levels) : 0;
}

function createVoice({ app, config, modelsDir, dataDir, services, ui, ipc }) {
  const { audit, memory, wake, learnWake, llm, skills } = services;
  const quiet = createQuietGate();

  // Речь и голоса людей. Хранилище изменяемое: установщик подключает модули по мере скачивания,
  // и все обработчики сразу видят новые (они берут модули отсюда при каждом вызове).
  const modules = {};
  function load() {
    const log = (m) => audit({ speech: m });
    modules.speaker = createSpeakerId({ modelsDir, dataDir, config: config.speech.speaker, log });
    modules.speech = createSpeech({ modelsDir, config: config.speech, log });
    modules.speech.setQuickEnd?.(isFinishedCommand);
    applyInputGain();
    // Переход со старой версии: общий профиль и факты — владельцу первого записанного голоса
    const first = modules.speaker.list()[0];
    if (first && memory.adoptLegacy(first.id).length) {
      const name = memory.forPerson(first.id).profile().name;
      if (name && !first.name) modules.speaker.update(first.id, { name });
    }
  }
  const ready = app.whenReady().then(() => (load(), modules));

  function applyInputGain() {
    const { speech, speaker } = modules;
    if (!speech?.setGain) return undefined;
    const levels = speaker
      .list()
      .map((p) => p.level)
      .filter((x) => typeof x === 'number');
    speech.setGain(inputGainFor(levels, config.speech.inputGainDb));
    return speech.levels().gain;
  }

  // Только после имени или когда окно ждёт фразу; «да/нет» — когда ждём подтверждения
  let waitingPhrase = false;
  function isFinishedCommand(text) {
    const command = wake.strip(text) ?? (waitingPhrase ? text : null);
    if (!command) return false;
    if (QUICK_STOP.test(command)) return true;
    if (services.awaitingConfirm() && QUICK_ANSWER.test(command)) return true;
    return !!skills.quickPlan(command);
  }

  let lastPerson = null; // последний узнанный по голосу — ему же отвечаем на набранный текст
  let lastUtterance = null;
  let lastHeard = []; // тексты последней фразы (оба прохода) — для записи голоса и настройки отклика на имя
  let lastAudioAt = 0;

  // personId: id узнанного по голосу; null — голос чужой; undefined — голос не проверялся (текст, короткая фраза)
  async function resolvePerson(personId) {
    const { speaker } = await ready;
    if (personId === null) return null;
    if (personId) return speaker.get(personId);
    return lastPerson || speaker.list()[0] || null;
  }

  async function peopleInfo() {
    const { speaker } = await ready;
    return { available: speaker.available, people: speaker.list(), last: speaker.last(), require: config.speech.speaker.require };
  }

  // Имя услышано: плашка появляется сразу (ошибка дешёвая — сама спрячется), большая модель — загружается
  function onName() {
    if (ui.mode() === 'hidden') ui.setMode('orb');
  }

  // Микрофон: куски по 100 мс (16 кГц) → VAD → распознавание → ключевое слово и голос → окно.
  // command: текст после имени; '' — прозвучало только имя; null — обращения нет.
  async function onAudio(samples) {
    if (!(samples instanceof Float32Array) || samples.length > MAX_CHUNK) return;
    if (debug() === '2') {
      const now = Date.now();
      if (lastAudioAt && now - lastAudioAt > 400) audit({ audioGap: now - lastAudioAt });
      lastAudioAt = now;
    }
    const { speech, speaker } = await ready;
    const result = speech.stt && speech.feed(samples);
    if (!result) return;
    quiet.setTalking(!result.final && !!result.partial);
    if (!result.final) {
      const command = wake.strip(result.partial);
      if (debug() === '2') audit({ partial: result.partial, command });
      if (command !== null) {
        onName();
        llm.prewarm(); // большая модель могла выгрузиться по простою — загрузить её, пока звучит команда
      }
      return ui.send('jarvis:heard', { partial: result.partial, command });
    }
    lastUtterance = result.audio;
    const voice = speaker.enrolling() ? null : speaker.identify(result.audio);
    if (voice?.person) lastPerson = voice.person;
    // Оценки голоса (только числа) — чтобы было видно, насколько уверенно узнаётся голос
    if (voice) {
      audit({
        voice: voice.score,
        match: voice.match,
        person: voice.person?.id ?? null,
        best: voice.best,
        ambiguous: voice.ambiguous,
        via: voice.via,
      });
    }
    // JARVIS_DEBUG=1 — писать в журнал всё распознанное (для настройки ключевого слова и порога голоса)
    if (debug()) audit({ heard: result.final, firstPass: result.firstPass, voice });
    // Имя ищем в обоих проходах распознавания: точный текст — второй, быстрый — запасной
    const command = wake.strip(result.final) ?? (result.firstPass ? wake.strip(result.firstPass) : null);
    lastHeard = [result.final, result.firstPass].filter(Boolean);
    // Журнал промахов: похоже на имя, но не принято (только первые два слова)
    const miss = command === null && wake.nearMiss(result.final);
    if (miss) audit({ wakeNearMiss: miss, firstPass: result.firstPass?.split(' ').slice(0, 2).join(' ') });
    if (command !== null) onName();
    ui.send('jarvis:heard', { final: result.final, command, voice });
  }

  // Числа, «ё», сокращения и английские названия — так, как их произносят; затем ударения.
  // Всё это только для синтезатора: окно показывает исходный текст ответа.
  async function synth(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) return null;
    try {
      const spoken = normalizeForSpeech(text);
      // Без ударений — убрать и те «+», что поставил нормализатор («ю-эс-б+и»)
      return await (await ready).speech.synth(config.speech.stress === false ? spoken.replace(/\+/g, '') : forSynth(spoken));
    } catch (err) {
      audit({ speech: String(err?.message || err) });
      return null;
    }
  }

  // expected — фраза, которую человек читал с экрана
  async function enrollAdd(expected) {
    const { speaker, speech } = await ready;
    const heard = lastHeard[0] || '';
    const match = typeof expected === 'string' ? phraseMatch(expected, lastHeard) : 1;
    const { noise, gain } = speech.levels?.() || {};
    const level = levelDb(lastUtterance) - (gain || 0); // громкость голоса без нашего усиления
    const snr = noise == null ? null : Math.round(level - noise);
    audit({ enroll: heard, match: Math.round(match * 100) / 100, level: Math.round(level), noise, snr });
    if (match < 0.45) {
      return {
        error: heard ? `Я расслышал «${heard}» — это не та фраза. Повторите её, пожалуйста` : 'Не расслышал. Повторите фразу',
        heard,
      };
    }
    if (snr !== null && snr < 6) return { error: 'Голос почти тонет в шуме. Скажите чуть громче или ближе к микрофону', heard };
    const result = speaker.enroll.add(lastUtterance, { level, noise: noise ?? undefined });
    // Каждая фраза записи начинается с имени — заодно запоминаем, как у вас слышится «Орион»
    if (!result.error) learnWake(lastHeard.map((t) => t.split(' ')[0]));
    return { ...result, heard, snr };
  }

  async function enrollFinish({ name, honorific, id } = {}) {
    const { speaker } = await ready;
    const isFirst = !speaker.list().length;
    const person = speaker.enroll.finish({ name: String(name || ''), honorific: HONORIFICS.includes(honorific) ? honorific : 'сэр', id });
    if (!person?.id) return person;
    if (isFirst) memory.adoptLegacy(person.id); // старая общая память — первому записанному
    if (person.name) memory.forPerson(person.id).setProfile(`name=${person.name}`);
    const gain = applyInputGain(); // усиление под громкость только что записанного голоса
    audit({
      person: 'записан голос',
      id: person.id,
      name: person.name,
      threshold: person.threshold,
      level: person.level,
      noise: person.noise,
      gain,
      similar: person.similar?.id,
    });
    return { ...person, gain };
  }

  // Настройка отклика на имя: человек говорит только имя, мы запоминаем, как его слышит распознаватель
  function wakeLearn() {
    const heard = lastHeard.map((t) => t.split(' ').slice(0, 2).join(' '));
    const recognized = lastHeard.some((t) => wake.strip(t) !== null);
    const added = learnWake(lastHeard.flatMap((t) => [t.split(' ')[0], t.split(' ').slice(0, 2).join('')]));
    audit({ wakeLearn: heard, added });
    return { heard: heard[0] || '', recognized, added };
  }

  // --- IPC ---
  const { on, handle } = ipc;
  on('jarvis:audio', onAudio);
  // Окно ждёт фразу (после имени, клавиши, в продолжении диалога) — распознавание без детектора речи,
  // чтобы не терять тихую речь
  on('jarvis:listening', async (value) => {
    waitingPhrase = value === true;
    (await ready).speech.setListening?.(value === true);
  });
  on('jarvis:mic-reset', async () => {
    if (debug() === '2') audit({ micReset: true });
    quiet.setTalking(false);
    (await ready).speech.resetStream?.();
  });
  handle('jarvis:synth', synth);
  handle('jarvis:people', peopleInfo);
  handle('jarvis:enroll-start', async () => (await ready).speaker.enroll.start());
  handle('jarvis:enroll-add', enrollAdd);
  handle('jarvis:wake-learn', wakeLearn);
  handle('jarvis:enroll-cancel', async () => (await ready).speaker.enroll.cancel());
  handle('jarvis:enroll-finish', enrollFinish);
  handle('jarvis:person-update', async (id, patch = {}) => {
    const person = (await ready).speaker.update(String(id), patch);
    if (person?.name) memory.forPerson(person.id).setProfile(`name=${person.name}`);
    return person;
  });
  handle('jarvis:person-remove', async (id) => {
    (await ready).speaker.remove(String(id));
    memory.removePerson(String(id));
    if (lastPerson?.id === id) lastPerson = null;
    applyInputGain();
    audit({ person: 'удалён', id });
  });

  return {
    ready,
    // Установщик докачал или обновление заменило модели речи — подключить; → что загрузилось
    reload: () => (load(), { stt: modules.speech.stt, tts: modules.speech.tts, secondPass: !!modules.speech.secondPass }),
    resolvePerson,
    peopleInfo,
    untilQuiet: quiet.untilQuiet,
    // С этим человеком идёт разговор — его следующие фразы узнаются увереннее (см. core/speaker.js)
    setPartner: async (id) => (await ready).speaker.setPartner?.(id),
    forgetPartner: () => modules.speaker?.endSession?.(),
  };
}

module.exports = { createVoice, phraseMatch, inputGainFor };
