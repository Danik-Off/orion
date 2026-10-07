// Конфигурация: config.json поверх значений по умолчанию. В config.json достаточно указать то, что меняется.
const fs = require('node:fs');

const DEFAULTS = {
  name: 'Орион',
  city: 'Москва',
  // Первой отвечает маленькая модель (router, ниже). Не уверена — передаёт большой, если escalate включён.
  escalate: true,
  // Большая языковая модель («мозг»): llamacpp — Qwen на этом компьютере (встроенный llama.cpp, скачивается
  // по согласию — см. brainOffer); ollama — отдельная программа Ollama; remote — внешняя модель по API (remote ниже);
  // none — без большой модели: только быстрые команды и маленькая модель вызова функций (router).
  // Выбранная, но ещё не скачанная модель работает как none
  backend: 'llamacpp',
  // Внешняя модель как основная (backend: remote) и для подстраховки локальной (cloud.enabled):
  // type — 'openai' (любой OpenAI-совместимый /chat/completions: OpenRouter, DeepSeek, YandexGPT, LM Studio…)
  // или 'anthropic' (официальный SDK; ключ — apiKey или ANTHROPIC_API_KEY)
  remote: { type: 'openai', baseUrl: '', apiKey: '', model: '' },
  // После первой установки предложить: «Я могу стать умнее — докачать Qwen или подключить внешнюю модель»
  brainOffer: true,
  // llama.cpp: build — версия сборки (github.com/ggml-org/llama.cpp/releases); variant — своя сборка
  // (например, win-cuda-13.4-x64), иначе Vulkan или Metal под эту машину; device — видеокарта (Vulkan0 и т. п.);
  // slots — окна контекста с отдельным кэшем: диспетчер и узкие промпты инструментов не вытесняют друг друга
  llamaCpp: { build: 'b11205', variant: '', device: '', gpuLayers: 999, slots: 2 },
  // Разбор фразы большой моделью, когда маленькая не узнала инструмент: 'single' — один промпт (каталог навыков
  // и подробности подходящих); 'two-step' — диспетчер решает, что делать, затем на каждый шаг — короткий диалог
  // с узким промптом инструмента. Замер 2026-10-07 (108 фраз, Qwen 3.5 4B): single 96% / 435 мс,
  // two-step 88% / 747 мс — лишний вызов модели. Узнанный маленькой моделью инструмент идёт в узкий промпт всегда.
  planner: 'single',
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
  // Выгружать большую модель после стольких минут без запросов (видеопамять свободна, пока ассистент молчит).
  // Загружается снова, как только услышано имя, — пока звучит команда. 0 — не выгружать
  llmIdleMinutes: 10,
  // Первая ступень (core/router.js): маленькая модель вызова функций берёт простые команды сама, остальное
  // передаёт большой. enabled — включена (скачивается при первом запуске вместе с голосом и слухом); model — имя из списка
  // llama.js или свой файл .gguf в models/llm; exclude — навыки с тонкими аргументами, их ведёт только большая;
  // collect — записывать планы большой модели как примеры для дообучения (router-data.jsonl в папке данных)
  router: {
    enabled: true,
    model: 'orion-router', // дообученная (скачивается при первом запуске); свой файл .gguf из models/llm — тоже можно
    gpuLayers: 999,
    exclude: ['delegate', 'memory', 'scenarios', 'files', 'journal', 'notes', 'text', 'reminders', 'facts', 'power', 'dates', 'calc'],
    collect: true,
    // Вызов принимается, только если модель уверена в каждом его токене не меньше этого (0…1);
    // подбирается по npm run router-eval — так, чтобы «взял неверно» было около нуля
    minConfidence: 0.95,
  },
  // Последняя ступень (core/cloud.js): облачная модель, когда локальная ответила «не умею» / «не знаю».
  // Выключено; ask — спрашивать разрешения перед каждой отправкой; use — id провайдера из providers
  // (пусто и providers пуст — внешняя модель из remote):
  //   { "id": "claude", "type": "anthropic", "apiKey": "", "model": "claude-opus-5-5" }
  //   { "id": "openrouter", "type": "openai", "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "…", "model": "…" }
  cloud: { enabled: false, ask: true, use: '', providers: [] },
  // Сторонние MCP-серверы — как навыки (core/mcp.js): { "<имя>": { command, args, env } | { url, headers } }.
  // Ставятся из каталога в настройках («Подключения») или вручную; trust: true — действия без вопроса
  mcp: { servers: {} },
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
