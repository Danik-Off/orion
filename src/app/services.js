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

  // Возможности ядра, которые получают навыки (контракт — в core/skills.js)
  const { shell, clipboard } = electron;
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
    llm,
    wake,
    learnWake,
    confirm,
    answerConfirm,
    awaitingConfirm: () => pendingConfirms.size > 0,
    allSkills, // все навыки — для списка в настройках
    ctx,
    skills,
    assistant,
    stopModels,
  };
}

module.exports = { createServices };
