// Программа Ollama (ollama.com): /api/chat. Только localhost — разговоры не должны уходить в сеть.
const { withTimeout, readLines } = require('../stream');

function localOrigin(url) {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    throw new Error('ollamaUrl должен указывать на localhost — разговоры не должны уходить в сеть');
  }
  return u.origin;
}

// think() / setThink(v) — режим рассуждений общий для движков: модель без него отвечает 400, и его выключаем
function createOllamaBackend({ config, think, setThink }) {
  // Сколько держать модель в памяти без запросов; у llama.cpp то же делает core/llama.js
  const keepAlive = () => `${config.llmIdleMinutes > 0 ? config.llmIdleMinutes : 30}m`;

  async function send({ messages, format, options, cancel, onText }) {
    const origin = localOrigin(config.ollamaUrl);
    const signal = withTimeout(cancel);
    const request = () =>
      fetch(`${origin}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          messages,
          stream: !!onText,
          format,
          think: think(),
          keep_alive: keepAlive(),
          // Параметры генерации — из config.llm (по умолчанию: рекомендации Qwen3.5 для режима без рассуждений)
          options: { num_ctx: config.numCtx || 6144, ...config.llm, ...options },
        }),
        signal,
      });
    let res = await request();
    if (res.status === 400 && think() !== undefined) {
      // Модель без режима рассуждений (например, Gemma) — повторяем без параметра think
      const text = await res.text();
      if (!/think/i.test(text)) throw new Error(`Ollama 400: ${text}`);
      setThink(undefined);
      res = await request();
    }
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    if (!onText) {
      const data = await res.json();
      return { content: data.message?.content ?? '', promptTokens: data.prompt_eval_count };
    }
    // Поток: строки JSON с кусками текста; последняя (done) — со статистикой
    return readLines(
      res,
      (line) => {
        const part = JSON.parse(line);
        if (part.error) throw new Error(`Ollama: ${part.error}`);
        return { text: part.message?.content, done: part.done, stats: part.done ? { promptTokens: part.prompt_eval_count } : undefined };
      },
      onText,
    );
  }

  // Загрузить модель без ответа: запрос без prompt
  const prewarm = () =>
    fetch(`${localOrigin(config.ollamaUrl)}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, keep_alive: keepAlive() }),
    }).catch(() => {});

  // Есть ли модель в Ollama, выясняется запросом — ошибку объяснит окно (app/ask.js)
  return { send, prewarm, available: () => true };
}

module.exports = { createOllamaBackend, localOrigin };
