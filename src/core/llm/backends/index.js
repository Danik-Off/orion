// Движки языковой модели по имени настройки backend. Свой движок — файл в этой папке и строка здесь.
// Контракт: create({ config, llama, think, setThink }) → {
//   send({ messages, format, options, cancel, onText }) → { content, promptTokens?, stopped? },
//   prewarm() → Promise — загрузить модель заранее (имя уже услышано, команда ещё звучит),
//   available() → готова ли (скачана, настроена): нет — ступени разбора, которым нужна модель, отвечают сами
// }
// format — JSON-схема ответа (движок обязан её соблюсти: грамматика, structured outputs);
// onText(накопленный текст) может вернуть STOP (../stream.js) — тогда ответ обрывается.
const { createLlamaCppBackend } = require('./llamacpp');
const { createOllamaBackend } = require('./ollama');
const { createRemoteBackend, createNoneBackend } = require('./remote');

const BACKENDS = {
  llamacpp: createLlamaCppBackend,
  ollama: createOllamaBackend,
  remote: createRemoteBackend, // внешняя модель по API — по выбору в настройках
  none: createNoneBackend, // без большой модели
};
const DEFAULT_BACKEND = 'llamacpp';

module.exports = { BACKENDS, DEFAULT_BACKEND };
