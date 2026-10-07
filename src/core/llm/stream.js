// Общее для движков: потоковый ответ построчно и таймаут запроса.

const STOP = Symbol('stop'); // onText вернул STOP — остаток ответа не нужен
const REQUEST_TIMEOUT_MS = 90_000;
const withTimeout = (cancel) => AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), cancel]);

// Потоковый ответ построчно: pick(строка) → { text?, done?, stats? } или null (строку пропустить).
// onText может вернуть STOP — дальше не нужно: соединение закрывается, и движок бросает генерацию
async function readLines(res, pick, onText) {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let stats = {};
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const part = pick(line);
      if (!part) continue;
      if (part.stats) stats = part.stats;
      if (part.text) {
        content += part.text;
        let verdict;
        try {
          verdict = onText(content);
        } catch {} // ошибка слушателя не должна ломать ответ
        if (verdict === STOP) return { content, stopped: true };
      }
      if (part.done) return { content, ...stats };
    }
  }
  return { content, ...stats };
}

module.exports = { STOP, withTimeout, readLines };
