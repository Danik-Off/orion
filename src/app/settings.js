// Настройки из окна: значения, сохранение в config.json, список моделей, горячая клавиша.
const { localModels } = require('../core/llama');
const { versionLabel } = require('../core/version');
const { createSettings } = require('../core/settings');
const { supports } = require('../core/skills');

// Горячая клавиша всегда «будит»: показать окно, перебить речь и слушать следующую фразу.
// Новое сочетание из настроек: если оно занято, остаётся прежнее.
function createHotkey({ globalShortcut, config, ui }) {
  const summon = () => {
    ui.setMode('full');
    ui.send('jarvis:focus');
  };
  return function register(accelerator) {
    let ok = false;
    try {
      globalShortcut.unregisterAll();
      ok = globalShortcut.register(accelerator, summon);
    } catch {} // неверная запись сочетания
    if (!ok && accelerator !== config.hotkey) {
      try {
        globalShortcut.register(config.hotkey, summon);
      } catch {}
    }
    return ok;
  };
}

// Модели для списка в настройках: у llama.cpp — известные и свои файлы .gguf, у Ollama — установленные в нём
async function llmModels(config, modelsDir) {
  if (config.backend !== 'ollama') return localModels(modelsDir);
  try {
    const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()).models || []).map((m) => m.name) : [];
  } catch {
    return []; // Ollama не запущен — модель можно ввести вручную
  }
}

function createSettingsIpc({ app, config, configFile, modelsDir, services, voice, ui, settingsWindow, ipc, registerHotkey }) {
  // Вкладка «Настройки» (навыки — только те, что работают на этой ОС)
  const settings = createSettings({
    config,
    file: configFile,
    skills: services.allSkills.filter((s) => supports(s)),
    setHotkey: registerHotkey,
  });

  ipc.handle('jarvis:settings', async () => {
    const { speech } = await voice.ready;
    return {
      name: config.name,
      model: config.model,
      version: versionLabel(), // подпись в заголовке окна: orionAssistent:0.2.0(хеш)
      hotkey: config.hotkey,
      stt: speech.stt,
      tts: speech.tts,
      listenOnStart: config.speech.listenOnStart !== false,
      followUpSeconds: config.speech.followUpSeconds,
      echoCancellation: config.speech.echoCancellation !== false,
      speaker: await voice.peopleInfo(),
      mode: ui.mode(),
      pinned: ui.pinned(),
    };
  });
  ipc.handle('jarvis:settings-get', async () => ({
    values: settings.values(),
    skills: settings.skills(),
    models: await llmModels(config, modelsDir),
    version: app.getVersion(),
  }));
  ipc.handle('jarvis:settings-save', (patch) => {
    try {
      const r = settings.save(patch);
      if (r.ok) {
        services.audit({ settings: Object.keys(patch || {}) });
        // Окно разговора применяет то, что держит у себя (ожидание продолжения, знакомые голоса…). Ключ — не отдаём
        const shared = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => !k.endsWith('apiKey')));
        ui.send('jarvis:settings-changed', shared);
      }
      return r;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipc.on('jarvis:open-settings', (page) => settingsWindow.open(String(page || '')));
  // Окно разговора: свернуть; закрепить поверх остальных (запоминается в config.json)
  ipc.on('jarvis:minimize', () => ui.minimize());
  ipc.on('jarvis:pin', (on) => {
    ui.setPinned(on === true);
    settingsWindow.refreshLayer();
    settings.setPath(['pinned'], on === true || undefined);
  });
  ipc.on('jarvis:preview-voice', () => ui.send('jarvis:preview-voice')); // голос звучит в окне разговора
  ipc.on('jarvis:restart', () => {
    app.relaunch();
    app.quit(); // обычный выход: итог разговора успевает сохраниться в память
  });

  return settings;
}

module.exports = { createSettingsIpc, createHotkey, llmModels };
