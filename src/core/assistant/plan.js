// План ответа — JSON, который пишет модель (или собирает быстрый разбор навыка):
// { addressed?, topic, actions: [{ tool, arg }], say }.
const { CHAT_TOPIC } = require('../skills');

const MAX_ACTIONS = 3;

// Модель обязана ответить ровно этим JSON (грамматика llama.cpp / structured outputs Ollama): работает даже без нативного tool calling.
// Порядок полей — это порядок, в котором модель думает (JSON пишется слева направо):
//   addressed — только для фраз без имени: сначала решить, мне ли это;
//   topic     — навык из каталога или chat: сначала понять тему (дешёвый шаг рассуждения);
//   actions   — потом выбрать действия в рамках темы (arg с перечнем значений ограничен грамматикой);
//   say       — и только потом слова, уже зная, что будет сделано.
function planSchema({ topics, action, addressed = false }) {
  const properties = {};
  if (addressed) properties.addressed = { type: 'boolean' };
  properties.topic = { type: 'string', enum: topics };
  properties.actions = { type: 'array', maxItems: MAX_ACTIONS, items: action };
  properties.say = { type: 'string' };
  return { type: 'object', properties, required: Object.keys(properties) };
}

// Ответ диспетчера (двухшаговый разбор): какие инструменты нужны и что каждым сделать — словами из фразы.
// Аргумент в формате инструмента пишет второй шаг — короткий диалог с узким промптом инструмента.
// Поля называются так же, как у плана (actions/tool), — потоковая речь и обрезка реплики работают и здесь.
function dispatchSchema({ topics, tools, addressed = false }) {
  const action = {
    type: 'object',
    properties: { tool: { type: 'string', enum: tools }, task: { type: 'string' } },
    required: ['tool', 'task'],
  };
  return planSchema({ topics, action, addressed });
}

// allowed(tool, arg) — допустимо ли значение arg (для инструментов с перечнем)
function parsePlan(raw, toolNames, allowed = () => true) {
  let p;
  try {
    p = JSON.parse(raw);
  } catch {
    return chatPlan(String(raw).slice(0, 800));
  }
  const actions = (Array.isArray(p.actions) ? p.actions : [])
    .filter((a) => a && toolNames.includes(a.tool))
    .map((a) => ({ tool: a.tool, arg: typeof a.arg === 'string' ? a.arg.trim().slice(0, 300) : '' }))
    .filter((a) => allowed(a.tool, a.arg))
    .slice(0, MAX_ACTIONS);
  return {
    addressed: p.addressed !== false,
    topic: typeof p.topic === 'string' ? p.topic : CHAT_TOPIC,
    say: typeof p.say === 'string' ? p.say.slice(0, 1200) : '',
    actions,
  };
}

// Ответ диспетчера → план, где у шага вместо arg — task (что сделать, словами из фразы)
function parseDispatch(raw, toolNames) {
  let p;
  try {
    p = JSON.parse(raw);
  } catch {
    return chatPlan(String(raw).slice(0, 800));
  }
  const actions = (Array.isArray(p.actions) ? p.actions : [])
    .filter((a) => a && toolNames.includes(a.tool))
    .map((a) => ({ tool: a.tool, task: typeof a.task === 'string' ? a.task.trim().slice(0, 300) : '' }))
    .slice(0, MAX_ACTIONS);
  return {
    addressed: p.addressed !== false,
    topic: typeof p.topic === 'string' ? p.topic : CHAT_TOPIC,
    say: typeof p.say === 'string' ? p.say.slice(0, 1200) : '',
    actions,
  };
}

// Ответ без действий — разговор
const chatPlan = (say, extra = {}) => ({ addressed: true, topic: CHAT_TOPIC, actions: [], say, ...extra });

module.exports = { MAX_ACTIONS, planSchema, dispatchSchema, parsePlan, parseDispatch, chatPlan };
