// Конфигурация: config.json поверх значений по умолчанию. В config.json достаточно указать то, что меняется.
const fs = require('node:fs');

const DEFAULTS = {
  name: 'Орион',
  city: 'Москва',
  // Движок языковой модели: llamacpp — встроенный llama.cpp, он и модель скачиваются в папку models;
  // ollama — отдельная программа Ollama (ollama.com) со своими моделями
  backend: 'llamacpp',
  // llama.cpp: build — версия сборки (github.com/ggml-org/llama.cpp/releases); variant — своя сборка
  // (например, win-cuda-13.4-x64), иначе Vulkan или Metal под эту машину; device — видеокарта (Vulkan0 и т. п.)
  llamaCpp: { build: 'b11205', variant: '', device: '', gpuLayers: 999 },
  ollamaUrl: 'http://127.0.0.1:11434',
  model: 'qwen3.5:4b', // имя модели (одно для обоих движков) или имя своего файла .gguf в models/llm
  think: false,
  // Генерация: рекомендации Qwen3.5 для режима без рассуждений (huggingface.co/Qwen/Qwen3.5-4B, Best Practices)
  // presence_penalty = 0: штраф за повторы заставлял модель избегать чисел из промпта (текущий год → «26-й год»)
  llm: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 0, repeat_penalty: 1.0 },
  // План действий — почти без случайности: выбор инструмента должен быть одинаковым для одной фразы.
  // Для шуток, историй и сочинений — обычная температура из llm (иначе анекдоты повторялись бы).
  planTemperature: 0.1,
  // Окно контекста: промпт с каталогом, навыками фразы, памятью и историей — до ~4 тыс. токенов в худшем случае
  numCtx: 6144,
  hotkey: 'CommandOrControl+Alt+J',
  speech: {
    modelsDir: '',
    asrModel: 'sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16', // быстрый: текст на лету и имя
    // Второй проход: готовая фраза перераспознаётся точнее (ошибок в словах 6,2% → 4,5%, ~50 мс на фразу)
    asrSecondPass: 'sherpa-onnx-zipformer-ru-int8-2025-04-20',
    ttsModel: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11',
    // Точность голоса Supertonic: int8 — легче всего; vocoder — полноточный вокодер (+76 МБ, чище звук); full — всё (+330 МБ)
    ttsPrecision: 'full',
    ttsSpeaker: 9,
    ttsSteps: 12, // Supertonic: больше шагов — чище звук (8 → 0,6 с, 12 → 0,9 с, 16 → 1,2 с на 7 с речи)
    ttsSpeed: 1.0,
    stress: true, // ставить ударения перед озвучкой (lib/stress.js): «зам+ок на двери», «вс+ё готово»
    listenOnStart: true,
    wakeWords: ['орион', 'orion'],
    // Подсказки распознавателю: имя и wakeWords подсказываются всегда; сюда — редкие слова, которые он путает
    // (названия программ, имена). Вес 0 — выключить подсказки.
    hotwords: [],
    hotwordsScore: 1.5,
    followUpSeconds: 7,
    vadThreshold: 0.35, // детектор речи в фоне (пока Орион ждёт имя): ниже — чувствительнее к тихой речи
    echoCancellation: true, // вычитать голос Ориона из микрофона (нужно, чтобы перебивать его голосом через колонки)
    // Узнавание голоса хозяина: off — выключено; followup — без ключевого слова слушать только хозяина;
    // always — вообще все команды только от хозяина
    speaker: {
      model: '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
      threshold: 0.42, // для голосов без калибровки; при записи порог подбирается под голос и микрофон
      require: 'followup',
    },
  },
  skills: {}, // { "music": { "enabled": false } } — отключить навык
  // Передача сложных задач (код, оптимизация, отладка) агенту Claude Code или Codex, если он установлен.
  // Включается согласием: Орион спросит сам (skills.delegate.enabled). agent — "claude" или "codex", пусто —
  // первый найденный; workDir — где создавать папки задач (пусто — «Документы\Задачи агента»);
  // projects — свои проекты по названию: { "орион": "C:\\code\\orion" } — «оптимизируй код ориона»
  delegate: { agent: '', workDir: '', projects: {}, timeoutMin: 30 },
  discoverApps: true,
  apps: {},
  search: { browserUrl: 'https://ya.ru/search/?text=' },
  commands: {},
  // Обновления с GitHub: notify — при запуске проверить и спросить голосом «Хотите обновить?»
  updates: { notify: true },
};

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function loadConfig(file) {
  const user = JSON.parse(fs.readFileSync(file, 'utf8'));
  const config = merge(DEFAULTS, user);
  if (!Array.isArray(config.speech.wakeWords) || !config.speech.wakeWords.length) {
    config.speech.wakeWords = [config.name.toLowerCase()];
  }
  return config;
}

// Установленное приложение: config.json лежит внутри пакета и только для чтения, поэтому личные настройки
// живут в папке данных пользователя. При первом запуске туда копируется config.json из пакета.
function ensureUserConfig(bundled, file) {
  if (!fs.existsSync(file)) fs.copyFileSync(bundled, file);
  return file;
}

module.exports = { loadConfig, ensureUserConfig, DEFAULTS };
