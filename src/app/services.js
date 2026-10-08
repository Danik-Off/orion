// Сборка ядра: журнал, память, языковые модели, навыки, ступени разбора и ассистент.
// Здесь только связи между частями — логика живёт в src/core.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAudit } = require('../core/audit');
const { createLlm } = require('../core/llm');
const { createLlamaServer } = require('../core/llama');
const { createMemory } = require('../core/memory');
const { createSkillRegistry } = require('../core/skills');
const { createAssistant } = require('../core/assistant');
const { createRouter } = require('../core/router');
const { createCloud } = require('../core/cloud');
const { createWakeMatcher } = require('../core/wake');
const allSkills = require('../skills');

const CONFIRM_TIMEOUT_MS = 30_000;

// electron — { shell, clipboard, Notification }; ui — окно (core/window.js)
function createServices({ config, dataDir, modelsDir, ui, electron, saveSettings }) {
  const audit = createAudit(path.join(dataDir, 'actions.log'));
  const memory = createMemory({ dir: path.join(dataDir, 'memory') });
  // Встроенный llama.cpp: сервер поднимается при первом запросе к модели (или заранее — при прогреве)
  // и выгружается после llmIdleMinutes без запросов
  const llama = createLlamaServer({ config, modelsDir, log: audit, idleMs: (config.llmIdleMinutes || 0) * 60_000 });
  // Маленькая модель вызова функций (первая ступень) — свой llama-server: небольшое окно контекста, всегда в памяти
  const routerServer = createLlamaServer({
    config: { ...config, model: config.router.model, numCtx: 2048, llamaCpp: { ...config.llamaCpp, gpuLayers: config.router.gpuLayers } },
    modelsDir,
    log: audit,
    name: 'router',
  });
  const llm = createLlm({ config, llama });

  // Ключевое слово. Личные варианты имени (как распознаватель слышит «Орион» у этого пользователя) — переживают перезапуск
  const wake = createWakeMatcher(config.speech.wakeWords);
  const wakeFile = path.join(dataDir, 'wake-variants.json');
  try {
    wake.learn(JSON.parse(fs.readFileSync(wakeFile, 'utf8')));
  } catch {}
  function learnWake(words) {
    const added = wake.learn(words);
    if (added.length) fs.writeFile(wakeFile, JSON.stringify(wake.learned()), () => {});
    return added;
  }

  // Подтверждение опасных действий: голосом («да»/«нет») или кнопками в окне.
  // Без ответа за 30 с — null: для действия это «нет», а предложение можно повторить в другой раз.
  const pendingConfirms = new Map();
  function confirm(text) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      pendingConfirms.set(id, resolve);
      ui.setMode('full');
      ui.send('jarvis:confirm', { id, text });
      setTimeout(() => pendingConfirms.delete(id) && resolve(null), CONFIRM_TIMEOUT_MS);
    });
  }
  // Вопрос со свободным ответом (город при знакомстве): голосом — следующая фраза без имени, или текстом.
  // «Пропустить» — null; без ответа за timeoutMs (человек отошёл) — undefined
  const pendingQuestions = new Map();
  function ask(text, { timeoutMs = 60_000 } = {}) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      pendingQuestions.set(id, resolve);
      ui.setMode('full');
      ui.send('jarvis:question', { id, text });
      setTimeout(() => pendingQuestions.delete(id) && resolve(undefined), timeoutMs); // не ответили — undefined
    });
  }
  function answerQuestion(id, text) {
    const resolve = pendingQuestions.get(id);
    if (!resolve) return;
    pendingQuestions.delete(id);
    const t = typeof text === 'string' ? text.trim().slice(0, 200) : '';
    resolve(t || null);
  }
  // Открыть в окне мастер записи голоса (там же — имя и обращение)
  const startEnrollment = () => (ui.setMode('full'), ui.send('jarvis:enroll-offer'));

  function answerConfirm(id, ok) {
    const resolve = pendingConfirms.get(id);
    if (!resolve) return;
    pendingConfirms.delete(id);
    resolve(ok === true);
  }

  // Сработавший таймер: плашка, голос и системное уведомление (на случай, если звук выключен).
  function remind(text) {
    if (ui.mode() === 'hidden') ui.setMode('orb');
    ui.send('jarvis:remind', text);
    const { Notification } = electron;
    if (Notification.isSupported()) new Notification({ title: `${config.name} — напоминание`, body: text }).show();
  }

  // Сказать что-то самому, без вопроса (рассказ после обновления): реплика в окне и голосом
  function say(text) {
    if (ui.mode() === 'hidden') ui.setMode('orb');
    ui.send('jarvis:announce', String(text));
  }

  // Радио играет в окне разговора (renderer/radio.js): ядро говорит, что включить; окно сообщает, что играет.
  // active — станция выбрана (играет или на паузе); подписчики (мини-плеер) узнают о каждом изменении
  let radioState = { playing: false, active: false, name: '', url: '', volume: config.radio?.volume ?? 0.8 };
  const radioListeners = new Set();
  let radioPlayer = null;
  const radioChanged = (patch) => {
    radioState = { ...radioState, ...patch };
    for (const fn of radioListeners) fn(radioState);
  };
  const radio = {
    play: (station) => {
      radioChanged({ playing: false, active: true, name: station.name, url: station.url }); // окно сообщит, когда заиграет
      ui.send('jarvis:radio', { action: 'play', station: { name: station.name, url: station.url }, volume: radioState.volume });
    },
    stop: () => ui.send('jarvis:radio', { action: 'stop' }),
    pause: () => ui.send('jarvis:radio', { action: 'pause' }),
    resume: () => ui.send('jarvis:radio', { action: 'resume' }),
    setVolume: (v) => {
      const volume = Math.max(0, Math.min(1, Number(v) || 0));
      radioChanged({ volume });
      ui.send('jarvis:radio', { action: 'volume', volume });
    },
    next: () => skills.run('radio', 'другое'), // «другая станция» кнопкой — как голосом
    state: () => radioState,
    onChange: (fn) => (radioListeners.add(fn), () => radioListeners.delete(fn)),
    // Мини-плеер (app/radio-player.js) подключается после ядра: «перенеси радио в правый верхний угол», «спрячь плеер»
    setPlayer: (p) => (radioPlayer = p),
    place: (where) => radioPlayer?.place(where) ?? false,
    report: (s) =>
      radioChanged({
        playing: s?.playing === true,
        active: s?.active === true,
        name: String(s?.name || radioState.name),
        url: s?.active === false ? '' : radioState.url,
      }),
  };

  // Будильник: окно звенит (или включает радио), пока человек не выключит; «ещё 5 минут» — повтор через ядро.
  // payload: { id, label, radio } — radio: название станции; находится здесь, окну — готовый адрес
  async function alarm(payload) {
    let station = null;
    if (payload.radio)
      station = await require('../lib/radio')
        .findStation(payload.radio)
        .catch(() => null);
    ui.setMode('full');
    ui.send('jarvis:alarm', { id: payload.id, label: String(payload.label || 'Будильник'), station, radio: payload.radio || '' });
    audit({ alarm: 'звенит', label: payload.label, radio: payload.radio || undefined, found: payload.radio ? !!station : undefined });
  }
  const alarmSnooze = (payload, minutes) => {
    const ms = Math.min(60, Math.max(1, Number(minutes) || 10)) * 60_000;
    const t = setTimeout(() => alarm(payload), ms);
    t.unref?.();
    audit({ alarm: 'отложен', minutes: ms / 60_000 });
  };

  // Возможности ядра, которые получают навыки (контракт — в core/skills.js)
  const { shell, clipboard } = electron;
  const ctx = {
    config,
    memory: memory.guest,
    shared: memory.shared, // общая память: дом, место, факты не о конкретном человеке
    llm,
    confirm,
    remind,
    say,
    radio,
    alarm,
    ask,
    startEnrollment,
    audit,
    openExternal: (url) => shell.openExternal(url),
    openPath: (p) => shell.openPath(p),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    trashItem: (p) => shell.trashItem(p), // удаление файлов — только в корзину
    clipboard: { readText: () => clipboard.readText(), writeText: (t) => clipboard.writeText(t) },
    dataDir,
    saveSettings: (patch) => saveSettings(patch), // настройки создаются позже; навыки зовут это уже после запуска
    perform: async () => '', // подменяется ниже, когда ассистент создан (сценарии выполняют фразы как команды)
  };
  const skills = createSkillRegistry(allSkills, { config, ctx, audit });
  const router = createRouter({ config, server: routerServer, skills, audit, dataDir });
  const cloud = createCloud({ config, confirm, audit });
  const assistant = createAssistant({
    config,
    llm,
    skills,
    memory,
    audit,
    router,
    cloud,
    notify: (t) => ui.send('jarvis:status', t),
    onSessionEnd: (reason) => ui.send('jarvis:session-end', reason), // окно стирает реплики закончившегося разговора
  });
  ctx.perform = (text, request) => assistant.perform(text, request);

  // Языковые модели не должны пережить приложение и держать память видеокарты
  const stopModels = () => (llama.stop(), routerServer.stop());

  return {
    audit,
    memory,
    llama,
    routerServer, // маленькая модель первой ступени — свой llama-server (перезапуск при смене llama.cpp)
    llm,
    wake,
    learnWake,
    confirm,
    answerConfirm,
    awaitingConfirm: () => pendingConfirms.size > 0,
    answerQuestion,
    radio,
    alarmSnooze,
    allSkills, // все навыки — для списка в настройках
    ctx,
    skills,
    assistant,
    stopModels,
  };
}

module.exports = { createServices };
