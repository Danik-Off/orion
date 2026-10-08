// Речь по ходу ответа: модель ещё пишет, а готовые предложения уже озвучиваются.
const { STOP } = require('../llm');

// Только для разговора без действий — когда план уже не изменится: начало JSON должно быть
// {"topic":"chat","actions":[],"say":"… (у фраз без имени перед ним "addressed":true).
const CHAT_PREFIX = /^\s*\{\s*(?:"addressed"\s*:\s*true\s*,\s*)?"topic"\s*:\s*"chat"\s*,\s*"actions"\s*:\s*\[\s*\]\s*,\s*"say"\s*:\s*"/;
// Точка после инициала или короткого сокращения («А. С. Пушкин», «г. Казань», «т. е.») — не конец предложения:
// нормализатор речи должен получить сокращение вместе с тем, к чему оно относится
const SENTENCE_END = /(?:(?<!(?:^|[^\p{L}])(?:\p{L}|ул|пр|проф|им|ст|стр|рис|тел|кв|обл|ок|см|рт|напр))\.|[!?…])[.!?…]*["»)]*(?=\s)/gu;

// Конец последнего законченного предложения в тексте (0 — ни одного)
function lastSentenceEnd(text) {
  let last = 0;
  for (const m of text.matchAll(SENTENCE_END)) last = m.index + m[0].length;
  return last;
}

// Текст реплики из недописанного JSON (после CHAT_PREFIX): до закрывающей кавычки; хвост с недописанной
// экранировкой (\ или \u12) отбрасывается. → { text, closed } или null, если кусок пока не читается
function readSay(raw) {
  let end = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') i++;
    else if (raw[i] === '"') {
      end = i;
      break;
    }
  }
  const closed = end >= 0;
  const body = closed ? raw.slice(0, end) : raw.replace(/\\(u[0-9a-fA-F]{0,3})?$/, '');
  try {
    return { text: JSON.parse(`"${body}"`), closed };
  } catch {
    return null;
  }
}

// Начало JSON уже другое (есть действия, другая тема, «не мне») — этот ответ не разговорный
function notChat(content) {
  const topic = content.match(/"topic"\s*:\s*"([^"]*)"/)?.[1];
  return (
    content.length > 120 || (topic !== undefined && topic !== 'chat') || /"actions"\s*:\s*\[\s*\{|"addressed"\s*:\s*false/.test(content)
  );
}

// Возвращает onText(накопленный JSON) и finish() — договорить остаток после конца ответа.
// plain — поток обычного текста, а не JSON (ответ навыка: пересказ найденного поиском).
// hold(предложение) → true — придержать это предложение и всё после него до finish() (отказ «не умею»:
// возможно, задачу передадут агенту, и отказ звучать не должен)
function createSayStreamer(onSentence, { plain = false, hold = null } = {}) {
  let prefix = plain ? 0 : null; // длина начала JSON до текста реплики; null — ещё неясно, false — не наш случай
  let sent = 0; // сколько символов реплики уже отдано
  let text = '';
  let closed = false;
  let held = false;
  const emit = (upTo, force = false) => {
    const part = text.slice(sent, upTo).trim();
    if (!force && (held || (hold && part && hold(part)))) return void (held = true);
    sent = upTo;
    if (part) onSentence(part);
  };
  const emitSentences = () => {
    const last = lastSentenceEnd(text);
    if (last > sent) emit(last);
  };
  function onText(content) {
    if (prefix === false || closed) return;
    if (plain) {
      text = content;
      return emitSentences();
    }
    if (prefix === null) {
      const m = content.match(CHAT_PREFIX);
      if (!m) {
        if (notChat(content)) prefix = false;
        return;
      }
      prefix = m[0].length;
    }
    const say = readSay(content.slice(prefix));
    if (!say) return;
    text = say.text;
    closed = say.closed;
    if (closed) return emit(text.length);
    emitSentences();
  }
  // full — реплика из готового плана: договорить остаток, даже если последний кусок потока не дошёл
  const finish = (full) => {
    if (prefix === false || prefix === null || (plain && !sent)) return;
    const done = text.slice(0, sent).trim();
    if (typeof full === 'string' && full.startsWith(done)) ((text = full), (sent = done.length));
    emit(text.length, true);
  };
  return { onText, finish, started: () => sent > 0 };
}

// Действия выбраны, и все их инструменты сами дают текст ответа (погода, поиск, курсы…) — реплику модели
// всё равно заменит ответ навыка, поэтому её не дописываем: экономия 15–25 токенов (~0,1–0,15 с) на команде.
// speaks(tool) — отвечает ли инструмент сам. plan() — JSON плана с пустым say, если ответ оборван, иначе null.
const SAY_AFTER_ACTIONS = /\]\s*,\s*"say"\s*:\s*"/;
function createSayCutter(speaks = () => false) {
  let decided = false;
  let cut = null;
  function onText(content) {
    if (decided) return undefined;
    const m = content.match(SAY_AFTER_ACTIONS);
    if (!m) return undefined;
    decided = true;
    const head = content.slice(0, m.index + m[0].length);
    try {
      const plan = JSON.parse(`${head}"}`);
      const actions = Array.isArray(plan.actions) ? plan.actions : [];
      if (!actions.length || !actions.every((a) => speaks(a?.tool))) return undefined;
      cut = `${head}"}`;
      return STOP;
    } catch {
      return undefined;
    }
  }
  return { onText, plan: () => cut };
}

module.exports = { createSayStreamer, createSayCutter };
