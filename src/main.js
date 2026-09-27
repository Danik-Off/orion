// Точка входа: собирает ядро, навыки и окно, связывает их через IPC. Логики ассистента здесь нет.
const { app, ipcMain, globalShortcut, session, shell, Notification, clipboard, systemPreferences } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { loadConfig, ensureUserConfig } = require('./core/config');
const { createAudit } = require('./core/audit');
const { createLlm } = require('./core/llm');
const { createLlamaServer, localModels } = require('./core/llama');
const { createMemory } = require('./core/memory');
const { createSkillRegistry } = require('./core/skills');
const { createAssistant } = require('./core/assistant');
const { createSpeech } = require('./core/speech');
const { createSpeakerId, levelDb, HONORIFICS } = require('./core/speaker');
const { createWakeMatcher } = require('./core/wake');
const { createWindowManager } = require('./core/window');
const { createSettings } = require('./core/settings');
const { createTray } = require('./core/tray');
const { install, missing, estimate, formatBytes, brainReady } = require('./core/setup');
const { createUpdater } = require('./core/updater');
const { supports } = require('./core/skills');
const { isHttpUrl } = require('./lib/websearch');
const { normalizeForSpeech } = require('./lib/speech-text');
const { forSynth } = require('./lib/stress');
const allSkills = require('./skills');
const pkg = require('../package.json');

// Папка данных одна и та же в разработке и в установленной версии на любой ОС (имя пакета, а не продукта).
// До requestSingleInstanceLock: блокировка второго экземпляра живёт в этой папке.
// ORION_DATA_DIR — своя папка (переносная установка, проверка сборки рядом с работающим Орионом).
app.setPath('userData', process.env.ORION_DATA_DIR || path.join(app.getPath('appData'), pkg.name));
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0); // дальше не идём: второй экземпляр не должен трогать настройки и модели
}

const root = path.join(__dirname, '..');
const dataDir = app.getPath('userData');
// Установленная версия: пакет только для чтения — настройки и модели в папке данных пользователя.
// В разработке — как раньше, config.json и models/ рядом с проектом.
const baseDir = app.isPackaged ? dataDir : root;
fs.mkdirSync(dataDir, { recursive: true });
const configFile = app.isPackaged
  ? ensureUserConfig(path.join(root, 'config.json'), path.join(dataDir, 'config.json'))
  : path.join(root, 'config.json');
const config = loadConfig(configFile);
const modelsDir = resolveModelsDir();

// Папка models (речь, llama.cpp и языковая модель — гигабайты) — рядом с программой: удалили программу —
// удалилось и всё скачанное. Установщик Windows при обновлении её не трогает (installer/installer.nsh).
// Где рядом с программой писать нельзя (macOS — внутри .app, пакеты Linux, Program Files) — в папке данных.
function resolveModelsDir() {
  if (config.speech.modelsDir) return path.resolve(baseDir, config.speech.modelsDir);
  if (!app.isPackaged) return path.join(root, 'models');
  if (process.platform === 'win32') {
    const nextToApp = path.join(path.dirname(process.execPath), 'models');
    try {
      fs.mkdirSync(nextToApp, { recursive: true });
      const probe = path.join(nextToApp, '.write-test');
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      return nextToApp;
    } catch {}
  }
  return path.join(dataDir, 'models');
}

const audit = createAudit(path.join(dataDir, 'actions.log'));
const memory = createMemory({ dir: path.join(dataDir, 'memory') });
// Встроенный llama.cpp: сервер поднимается при первом запросе к модели (или заранее — при прогреве)
const llama = createLlamaServer({ config, modelsDir, log: (m) => audit(m) });
const llm = createLlm({ config, llama });
const wake = createWakeMatcher(config.speech.wakeWords);
// Личные варианты имени (как распознаватель слышит «Орион» у этого пользователя) — переживают перезапуск
const wakeFile = path.join(dataDir, 'wake-variants.json');
try {
  wake.learn(JSON.parse(fs.readFileSync(wakeFile, 'utf8')));
} catch {}
function learnWake(words) {
  const added = wake.learn(words);
  if (added.length) fs.writeFile(wakeFile, JSON.stringify(wake.learned()), () => {});
  return added;
}
const ui = createWindowManager({
  title: config.name,
  preload: path.join(__dirname, 'preload.js'),
  html: path.join(__dirname, 'renderer', 'index.html'),
});

// --- Возможности ядра, которые получают навыки ---

const pendingConfirms = new Map();

// Подтверждение опасных действий: голосом («да»/«нет») или кнопками в окне.
// Без ответа за 30 с — null: для действия это «нет», а предложение можно повторить в другой раз.
function confirm(text) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    pendingConfirms.set(id, resolve);
    ui.setMode('full');
    ui.send('jarvis:confirm', { id, text });
    setTimeout(() => pendingConfirms.delete(id) && resolve(null), 30_000);
  });
}

// Сработавший таймер: плашка, голос и системное уведомление (на случай, если звук выключен).
function remind(text) {
  if (ui.mode() === 'hidden') ui.setMode('orb');
  ui.send('jarvis:remind', text);
  if (Notification.isSupported()) new Notification({ title: `${config.name} — напоминание`, body: text }).show();
}

const ctx = {
  config,
  memory: memory.guest,
  shared: memory.shared, // общая память: дом, место, факты не о конкретном человеке
  llm,
  confirm,
  remind,
  audit,
  openExternal: (url) => shell.openExternal(url),
  openPath: (p) => shell.openPath(p),
  showItemInFolder: (p) => shell.showItemInFolder(p),
  trashItem: (p) => shell.trashItem(p), // удаление файлов — только в корзину
  clipboard: { readText: () => clipboard.readText(), writeText: (t) => clipboard.writeText(t) },
  dataDir,
  saveSettings: (patch) => settings.save(patch), // settings создаётся ниже; навыки зовут это уже после запуска
  perform: async () => '', // подменяется ниже, когда ассистент создан (сценарии выполняют фразы как команды)
};
const skills = createSkillRegistry(allSkills, { config, ctx, audit });
const assistant = createAssistant({
  config,
  llm,
  skills,
  memory,
  audit,
  notify: (t) => ui.send('jarvis:status', t),
  onSessionEnd: (reason) => ui.send('jarvis:session-end', reason), // окно стирает реплики закончившегося разговора
});
ctx.perform = (text, request) => assistant.perform(text, request);

// Речь и голоса людей. Хранилище изменяемое: установщик подключает модули по мере скачивания,
// и все обработчики сразу видят новые (они берут модули отсюда при каждом вызове).
const voiceModules = {};
function loadVoiceModules() {
  const log = (m) => audit({ speech: m });
  voiceModules.speaker = createSpeakerId({ modelsDir, dataDir, config: config.speech.speaker, log });
  voiceModules.speech = createSpeech({ modelsDir, config: config.speech, log });
  voiceModules.speech.setQuickEnd?.(isFinishedCommand);
  applyInputGain();
  // Переход со старой версии: общий профиль и факты — владельцу первого записанного голоса
  const first = voiceModules.speaker.list()[0];
  if (first && memory.adoptLegacy(first.id).length) {
    const name = memory.forPerson(first.id).profile().name;
    if (name && !first.name) voiceModules.speaker.update(first.id, { name });
  }
}
const speechReady = app.whenReady().then(() => (loadVoiceModules(), voiceModules));

// Усиление микрофона под самый тихий из записанных голосов: его речь должна доходить примерно до −26 дБ.
// Громкость каждого голоса измеряется при записи; speech.inputGainDb в config.json задаёт усиление вручную.
const SPEECH_TARGET_DB = -26;
function applyInputGain() {
  const { speech, speaker } = voiceModules;
  if (!speech?.setGain) return;
  const manual = config.speech.inputGainDb;
  const levels = speaker.list().map((p) => p.level).filter((x) => typeof x === 'number');
  const gain = typeof manual === 'number' ? manual : levels.length ? SPEECH_TARGET_DB - Math.min(...levels) : 0;
  speech.setGain(gain);
  return speech.levels().gain;
}

// Фраза записи голоса сказана именно вами: распознанное похоже на текст на экране (по основам слов —
// распознаватель может ошибиться в окончаниях). Разговор или телевизор на фоне так не пройдут.
const stems = (t) => String(t).toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).filter((w) => w.length > 2).map((w) => w.slice(0, 4));
function phraseMatch(expected, heard) {
  const want = stems(expected);
  const got = new Set(heard.flatMap(stems));
  return want.length ? want.filter((s) => got.has(s)).length / want.length : 1;
}

// Прежде чем качать гигабайты — показать, что и сколько весит, и дождаться согласия.
// «Позже» только прячет вопрос: окно может задать его снова, ответ по-прежнему ждётся здесь.
let answerSetupOffer = null;
async function offerSetup() {
  const offer = await estimate(config, modelsDir);
  audit({ setup: 'предложение', total: offer.total, ollama: offer.ollama });
  ui.send('jarvis:setup-offer', {
    parts: offer.parts.map((p) => ({ title: p.title, size: formatBytes(p.bytes) })),
    total: formatBytes(offer.total),
    ollama: offer.ollama, // false — Ollama не установлен, его ставят отдельно
  });
  return new Promise((resolve) => (answerSetupOffer = resolve));
}

// Установка недостающего: сначала голос (чтобы сразу представиться), потом слух, потом языковая модель.
// Ответ: true — всё на месте (или установилось), false — пользователь отказался
async function runSetup() {
  const needModels = missing(config, modelsDir).length > 0;
  const needBrain = !(await brainReady(config, modelsDir));
  if (!needModels && !needBrain) return true;
  if (!(await offerSetup())) {
    audit({ setup: 'отказ' });
    return false;
  }
  audit({ setup: 'начало', models: missing(config, modelsDir).map((i) => i.name), brain: needBrain });
  await install({
    config,
    modelsDir,
    report: (r) => ui.send('jarvis:setup', r),
    onStageDone: async (stage, changed) => {
      if (changed && stage !== 'brain') {
        await speechReady;
        loadVoiceModules(); // подключить только что скачанное
      }
      if (changed && stage === 'brain') {
        if (config.backend !== 'ollama') await llama.restart().catch(() => {}); // модель только что скачана
        assistant.warmup();
      }
      ui.send('jarvis:setup', { stage, done: true, ready: stage });
    },
  }).catch((err) => {
    audit({ setup: 'ошибка', error: String(err?.message || err) });
    ui.send('jarvis:setup', { error: true, title: `Установка прервалась: ${err.message}. Перезапустите меня — докачаю.` });
  });
  ui.send('jarvis:setup', { finished: true });
  audit({ setup: 'готово' });
  return true;
}

function explainError(err) {
  const msg = String(err?.cause?.code || err?.message || err);
  if (err?.code === 'NO_MODEL') return 'Языковая модель ещё не скачана. Перезапустите меня — докачаю.';
  if (/llama.cpp не запустился|долго загружает/i.test(msg)) return 'Языковая модель не запустилась. Подробности — в журнале.';
  if (config.backend === 'ollama' && /ECONNREFUSED|fetch failed/i.test(msg)) return 'Не могу связаться с Ollama. Он запущен? Или выберите в настройках встроенный движок.';
  if (/not found/i.test(msg)) return `Модель ${config.model} не найдена. Выполните: ollama pull ${config.model}`;
  if (/timeout|aborted/i.test(msg)) return 'Модель слишком долго отвечает.';
  return `Сбой: ${msg}`;
}

// --- IPC: окно ↔ ядро. Каждый обработчик принимает сообщения только от своего окна. ---

const on = (channel, fn) => ipcMain.on(channel, (e, ...a) => ui.isOurs(e) && fn(...a));
const handle = (channel, fn) => ipcMain.handle(channel, (e, ...a) => (ui.isOurs(e) ? fn(...a) : null));

let busy = false;
let lastPerson = null; // последний узнанный по голосу — ему же отвечаем на набранный текст
const SOURCES = ['text', 'wake', 'hotkey', 'followup', 'followup-voice']; // followup-voice — продолжение, голос подтверждён

// personId: id узнанного по голосу; null — голос чужой; undefined — голос не проверялся (текст, короткая фраза)
async function resolvePerson(personId) {
  const { speaker } = await speechReady;
  if (personId === null) return null;
  if (personId) return speaker.get(personId);
  return lastPerson || speaker.list()[0] || null;
}

// streamId — номер запроса в окне: по нему окно узнаёт предложения ответа, пришедшие раньше самого ответа
handle('jarvis:ask', async (text, source, personId, streamId) => {
  if (typeof text !== 'string' || !text.trim() || text.length > 1000) {
    return { say: 'Пустой или слишком длинный запрос.', error: true };
  }
  // Новый запрос, пока старый ещё думает (человек договорил фразу или перебил) — старый обрываем:
  // Ollama бросает генерацию, а его ответ окну уже не нужен
  if (busy) await cancelAsk();
  busy = true;
  const controller = new AbortController();
  let done;
  current = { controller, done: new Promise((r) => (done = r)) };
  const person = await resolvePerson(personId);
  audit({ ask: text.trim(), source, person: person?.id ?? null });
  try {
    const onSay = Number.isInteger(streamId) ? (part) => ui.send('jarvis:say-part', { id: streamId, text: part }) : undefined;
    const onFiller = Number.isInteger(streamId) ? (part) => ui.send('jarvis:filler', { id: streamId, text: part }) : undefined;
    const voice = SOURCES.includes(source) && source !== 'text';
    const result = await assistant.handle(text.trim(), {
      source: SOURCES.includes(source) ? source : 'text',
      person,
      signal: controller.signal,
      onSay,
      onFiller,
      beforeActions: voice ? () => untilQuiet(controller.signal) : undefined,
    });
    if (result.cancelled || controller.signal.aborted) return { cancelled: true };
    // С этим человеком идёт разговор — его следующие фразы узнаются увереннее (см. core/speaker.js)
    if (!result.ignored) (await speechReady).speaker.setPartner?.(person?.id ?? null);
    // Подпись реплики в чате — только по настоящей проверке голоса: имя, «Гость» (голос чужой);
    // без проверки (текст, короткая фраза) — null, окно оставит «Вы»
    const speakerLabel = typeof personId === 'string' && person ? person.name || 'Без имени' : personId === null ? 'Гость' : null;
    return { ...result, person: person?.id ?? null, speakerLabel }; // окно запомнит, с кем идёт разговор
  } catch (err) {
    if (controller.signal.aborted) return { cancelled: true };
    audit({ error: String(err?.message || err) });
    return { say: explainError(err), error: true };
  } finally {
    busy = false;
    if (current?.controller === controller) current = null;
    done();
  }
});

// Оборвать запрос в работе и дождаться, пока он освободит ядро
let current = null;
async function cancelAsk() {
  if (!current) return;
  const { controller, done } = current;
  controller.abort();
  llm.abortAll();
  audit({ ask: 'отменён' });
  await done;
}
on('jarvis:cancel', () => cancelAsk());

async function peopleInfo() {
  const { speaker } = await speechReady;
  return { available: speaker.available, people: speaker.list(), last: speaker.last(), require: config.speech.speaker.require };
}

handle('jarvis:settings', async () => {
  const { speech } = await speechReady;
  return {
    name: config.name,
    model: config.model,
    hotkey: config.hotkey,
    stt: speech.stt,
    tts: speech.tts,
    listenOnStart: config.speech.listenOnStart !== false,
    followUpSeconds: config.speech.followUpSeconds,
    echoCancellation: config.speech.echoCancellation !== false,
    speaker: await peopleInfo(),
    mode: ui.mode(),
  };
});

// Человек сейчас говорит (идут промежуточные результаты). Действия голосовой команды ждут конца его фразы:
// если это продолжение («напомни… через десять» — пауза — «секунд»), окно заменит запрос договорённым,
// и действия по обрывку не выполнятся. После конца фразы — ещё GRACE_MS на решение окна.
let userTalking = false;
let quietWaiters = [];
const GRACE_MS = 250;
const MAX_WAIT_MS = 6000; // рядом говорят без конца (телевизор) — дольше не ждём
function setTalking(on) {
  userTalking = on;
  if (on) return;
  const waiters = quietWaiters;
  quietWaiters = [];
  waiters.forEach((w) => w());
}
function untilQuiet(signal) {
  if (!userTalking) return Promise.resolve();
  return new Promise((resolve) => {
    const giveUp = setTimeout(finish, MAX_WAIT_MS);
    let grace = null;
    function finish() {
      clearTimeout(giveUp);
      clearTimeout(grace);
      resolve();
    }
    const onQuiet = () => {
      grace = setTimeout(() => (userTalking ? quietWaiters.push(onQuiet) : finish()), GRACE_MS);
    };
    quietWaiters.push(onQuiet);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

// Ранний конец фразы: законченная короткая команда закрывается через ~0,7 с тишины вместо 1,2 с.
// Только после имени или когда окно ждёт фразу; «да/нет» — когда ждём подтверждения.
let waitingPhrase = false;
const QUICK_STOP = /^(стоп|хватит|замолчи|тихо|помолчи)$/;
const QUICK_ANSWER = /^(да|нет|ага|отмена|не надо|подтверждаю)$/;
function isFinishedCommand(text) {
  const command = wake.strip(text) ?? (waitingPhrase ? text : null);
  if (!command) return false;
  if (QUICK_STOP.test(command)) return true;
  if (pendingConfirms.size && QUICK_ANSWER.test(command)) return true;
  return !!skills.quickPlan(command);
}

// Микрофон: куски по 100 мс (16 кГц) → VAD → распознавание → ключевое слово и голос → окно.
// command: текст после имени; '' — прозвучало только имя; null — обращения нет.
let lastUtterance = null;
let lastHeard = []; // тексты последней фразы (оба прохода) — для настройки отклика на имя
let lastAudioAt = 0;
on('jarvis:audio', async (samples) => {
  if (!(samples instanceof Float32Array) || samples.length > 16000) return;
  if (process.env.JARVIS_DEBUG === '2') {
    const now = Date.now();
    if (lastAudioAt && now - lastAudioAt > 400) audit({ audioGap: now - lastAudioAt });
    lastAudioAt = now;
  }
  const { speech, speaker } = await speechReady;
  const result = speech.stt && speech.feed(samples);
  if (!result) return;
  setTalking(!result.final && !!result.partial);
  if (!result.final) {
    const command = wake.strip(result.partial);
    if (process.env.JARVIS_DEBUG === '2') audit({ partial: result.partial, command });
    // Прозвучало имя — плашка появляется сразу, по первому же промежуточному результату, не дожидаясь окна
    // (раньше: ядро → окно → ядро). Ошибка дешёвая: плашка сама спрячется, если команды не будет.
    if (command !== null && ui.mode() === 'hidden') ui.setMode('orb');
    return ui.send('jarvis:heard', { partial: result.partial, command });
  }
  lastUtterance = result.audio;
  const voice = speaker.enrolling() ? null : speaker.identify(result.audio);
  if (voice?.person) lastPerson = voice.person;
  // Оценки голоса (только числа) — чтобы было видно, насколько уверенно узнаётся голос
  if (voice) audit({ voice: voice.score, match: voice.match, person: voice.person?.id ?? null, best: voice.best, ambiguous: voice.ambiguous, via: voice.via });
  // JARVIS_DEBUG=1 — писать в журнал всё распознанное (для настройки ключевого слова и порога голоса)
  if (process.env.JARVIS_DEBUG) audit({ heard: result.final, firstPass: result.firstPass, voice });
  // Имя ищем в обоих проходах распознавания: точный текст — второй, быстрый — запасной
  const command = wake.strip(result.final) ?? (result.firstPass ? wake.strip(result.firstPass) : null);
  lastHeard = [result.final, result.firstPass].filter(Boolean);
  // Журнал промахов: похоже на имя, но не принято (только первые два слова)
  const miss = command === null && wake.nearMiss(result.final);
  if (miss) audit({ wakeNearMiss: miss, firstPass: result.firstPass?.split(' ').slice(0, 2).join(' ') });
  if (command !== null && ui.mode() === 'hidden') ui.setMode('orb'); // имя узнано только в конце фразы — плашка тоже сразу
  ui.send('jarvis:heard', { final: result.final, command, voice });
});

// Окно ждёт фразу (после имени, клавиши, в продолжении диалога) — распознавание без детектора речи,
// чтобы не терять тихую речь
on('jarvis:listening', async (on) => {
  waitingPhrase = on === true;
  (await speechReady).speech.setListening?.(on === true);
});

on('jarvis:mic-reset', async () => {
  if (process.env.JARVIS_DEBUG === '2') audit({ micReset: true });
  setTalking(false);
  (await speechReady).speech.resetStream?.();
});

handle('jarvis:synth', async (text) => {
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) return null;
  try {
    // Числа, «ё», сокращения и английские названия — так, как их произносят; затем ударения.
    // Всё это только для синтезатора: окно показывает исходный текст ответа.
    const spoken = normalizeForSpeech(text);
    // Без ударений — убрать и те «+», что поставил нормализатор («ю-эс-б+и»)
    return await (await speechReady).speech.synth(config.speech.stress === false ? spoken.replace(/\+/g, '') : forSynth(spoken));
  } catch (err) {
    audit({ speech: String(err?.message || err) });
    return null;
  }
});

// --- Люди: запись голоса, имя и обращение ---

handle('jarvis:people', peopleInfo);
handle('jarvis:enroll-start', async () => (await speechReady).speaker.enroll.start());
// expected — фраза, которую человек читал с экрана
handle('jarvis:enroll-add', async (expected) => {
  const { speaker, speech } = await speechReady;
  const heard = lastHeard[0] || '';
  const match = typeof expected === 'string' ? phraseMatch(expected, lastHeard) : 1;
  const { noise, gain } = speech.levels?.() || {};
  const level = levelDb(lastUtterance) - (gain || 0); // громкость голоса без нашего усиления
  const snr = noise == null ? null : Math.round(level - noise);
  audit({ enroll: heard, match: Math.round(match * 100) / 100, level: Math.round(level), noise, snr });
  if (match < 0.45) return { error: heard ? `Я расслышал «${heard}» — это не та фраза. Повторите её, пожалуйста` : 'Не расслышал. Повторите фразу', heard };
  if (snr !== null && snr < 6) return { error: 'Голос почти тонет в шуме. Скажите чуть громче или ближе к микрофону', heard };
  const result = speaker.enroll.add(lastUtterance, { level, noise: noise ?? undefined });
  // Каждая фраза записи начинается с имени — заодно запоминаем, как у вас слышится «Орион»
  if (!result.error) learnWake(lastHeard.map((t) => t.split(' ')[0]));
  return { ...result, heard, snr };
});

// Настройка отклика на имя: человек говорит только имя, мы запоминаем, как его слышит распознаватель
handle('jarvis:wake-learn', () => {
  const heard = lastHeard.map((t) => t.split(' ').slice(0, 2).join(' '));
  const recognized = lastHeard.some((t) => wake.strip(t) !== null);
  const added = learnWake(lastHeard.flatMap((t) => [t.split(' ')[0], t.split(' ').slice(0, 2).join('')]));
  audit({ wakeLearn: heard, added });
  return { heard: heard[0] || '', recognized, added };
});
handle('jarvis:enroll-cancel', async () => (await speechReady).speaker.enroll.cancel());
handle('jarvis:enroll-finish', async ({ name, honorific, id } = {}) => {
  const { speaker } = await speechReady;
  const isFirst = !speaker.list().length;
  const person = speaker.enroll.finish({ name: String(name || ''), honorific: HONORIFICS.includes(honorific) ? honorific : 'сэр', id });
  if (person?.id) {
    if (isFirst) memory.adoptLegacy(person.id); // старая общая память — первому записанному
    if (person.name) memory.forPerson(person.id).setProfile(`name=${person.name}`);
    const gain = applyInputGain(); // усиление под громкость только что записанного голоса
    audit({ person: 'записан голос', id: person.id, name: person.name, threshold: person.threshold, level: person.level, noise: person.noise, gain, similar: person.similar?.id });
    return { ...person, gain };
  }
  return person;
});
handle('jarvis:person-update', async (id, patch = {}) => {
  const person = (await speechReady).speaker.update(String(id), patch);
  if (person?.name) memory.forPerson(person.id).setProfile(`name=${person.name}`);
  return person;
});
handle('jarvis:person-remove', async (id) => {
  (await speechReady).speaker.remove(String(id));
  memory.removePerson(String(id));
  if (lastPerson?.id === id) lastPerson = null;
  applyInputGain();
  audit({ person: 'удалён', id });
});

on('jarvis:confirm-reply', ({ id, ok } = {}) => {
  const resolve = pendingConfirms.get(id);
  if (resolve) {
    pendingConfirms.delete(id);
    resolve(ok === true);
  }
});

handle('jarvis:open-link', (url) => isHttpUrl(url) && ctx.openExternal(url));
const forgetPartner = () => voiceModules.speaker?.endSession?.();
on('jarvis:reset', () => (forgetPartner(), assistant.reset()));
on('jarvis:dialog-end', () => (forgetPartner(), assistant.endSession('конец диалога')));
on('jarvis:presence', (next) => {
  if (next === 'collapse') return ui.setMode('orb', { collapse: true }); // закрыли окно посреди диалога
  if (['full', 'orb', 'hidden'].includes(next)) ui.setMode(next);
});
on('jarvis:orb-height', (h) => ui.setOrbHeight(h));

// Горячая клавиша всегда «будит»: показать окно, перебить речь и слушать следующую фразу.
// Новое сочетание из настроек: если оно занято, остаётся прежнее.
function registerHotkey(accelerator) {
  const wake = () => {
    ui.setMode('full');
    ui.send('jarvis:focus');
  };
  let ok = false;
  try {
    globalShortcut.unregisterAll();
    ok = globalShortcut.register(accelerator, wake);
  } catch {} // неверная запись сочетания
  if (!ok && accelerator !== config.hotkey) {
    try {
      globalShortcut.register(config.hotkey, wake);
    } catch {}
  }
  return ok;
}

// Вкладка «Настройки» (навыки — только те, что работают на этой ОС)
const settings = createSettings({ config, file: configFile, skills: allSkills.filter((s) => supports(s)), setHotkey: registerHotkey });
// Модели для списка в настройках: у llama.cpp — известные и свои файлы .gguf, у Ollama — установленные в нём
async function llmModels() {
  if (config.backend !== 'ollama') return localModels(modelsDir);
  try {
    const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()).models || []).map((m) => m.name) : [];
  } catch {
    return []; // Ollama не запущен — модель можно ввести вручную
  }
}
handle('jarvis:settings-get', async () => ({
  values: settings.values(),
  skills: settings.skills(),
  models: await llmModels(),
  version: app.getVersion(),
}));
handle('jarvis:settings-save', (patch) => {
  try {
    const r = settings.save(patch);
    if (r.ok) audit({ settings: Object.keys(patch || {}) });
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
on('jarvis:restart', () => {
  app.relaunch();
  app.quit(); // обычный выход: итог разговора успевает сохраниться в память
});

// Первый запуск: ответ на «скачать N ГБ?»
on('jarvis:setup-answer', (ok) => {
  answerSetupOffer?.(ok === true);
  answerSetupOffer = null;
});

// --- Обновления с GitHub Releases ---

// https://github.com/<owner>/<repo>/releases/latest — куда вести, если обновиться само не может
const releasesUrl = `${String(pkg.repository?.url || pkg.repository || '').replace(/^git\+/, '').replace(/\.git$/, '')}/releases/latest`;
const updater = createUpdater({
  app,
  confirm,
  audit,
  report: (r) => ui.send('jarvis:update', r),
  beforeInstall: saveBeforeQuit,
  openExternal: (url) => isHttpUrl(url) && shell.openExternal(url),
  releasesUrl,
});
handle('jarvis:update-check', () => updater.check({ manual: true }));

// Окно никогда не уходит на чужие страницы и не открывает новые окна.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.whenReady().then(async () => {
  // Разрешён только микрофон и только нашему окну. Камера, геолокация и прочее — запрещены.
  const micOnly = (wc, perm, types = []) =>
    perm === 'media' && wc === ui.webContents() && types.length > 0 && types.every((t) => t === 'audio');
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, d) => cb(micOnly(wc, perm, d?.mediaTypes)));
  session.defaultSession.setPermissionCheckHandler((wc, perm, _o, d) => micOnly(wc, perm, d?.mediaType ? [d.mediaType] : []));

  // macOS спрашивает доступ к микрофону сам, но только по запросу приложения
  if (process.platform === 'darwin') systemPreferences.askForMediaAccess('microphone').catch(() => {});

  await skills.init();
  assistant.warmup(); // после init: в промпте уже полные описания навыков
  await ui.create();
  // При автозапуске вместе с системой — сразу в трей, иначе показать окно.
  ui.setMode(process.argv.includes('--hidden') ? 'hidden' : 'full');
  // Первый запуск: спросить и докачать модели и языковую модель, показывая прогресс в окне.
  // Когда всё на месте — предложения навыков («нашёл Claude Code — передавать ему задачи?»), затем
  // проверка обновлений (если не отключена в настройках). Вопросы — по очереди: в окне виден только один.
  runSetup().then(async (ready) => {
    if (!ready) return;
    await new Promise((r) => setTimeout(r, 3000));
    await skills.offer();
    if (config.updates?.notify !== false) setTimeout(() => updater.check(), 2000);
  });

  createTray({
    name: config.name,
    hotkey: config.hotkey,
    onShow: () => ui.setMode('full'),
    onToggleMic: () => ui.send('jarvis:toggle-mic'),
    onCheckUpdates: () => {
      ui.setMode('full');
      updater.check({ manual: true });
    },
    onQuit: () => app.quit(),
  });

  if (!registerHotkey(config.hotkey)) audit({ warning: `Горячая клавиша ${config.hotkey} занята другой программой` });
});

// Перед выходом — сохранить итог текущего разговора в память. Установщик обновления вызывает это заранее,
// чтобы потом выйти сразу: пока приложение не закрылось, новая версия не встанет.
let quitting = false;
async function saveBeforeQuit() {
  quitting = true;
  await Promise.race([assistant.endSession('выход'), new Promise((r) => setTimeout(r, 8000))]).catch(() => {});
}
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  saveBeforeQuit().finally(() => app.quit());
});

app.on('second-instance', () => ui.setMode('full'));
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  llama.stop(); // llama-server не должен пережить приложение и держать память видеокарты
});
app.on('window-all-closed', () => {}); // приложение остаётся в трее; выход — через меню трея
