// Встроенный llama.cpp (core/llama.js): OpenAI-совместимый /v1/chat/completions на 127.0.0.1.
const { withTimeout, readLines } = require('../stream');

// llama — сервер из core/llama.js: url() запускает его при первом запросе (загрузка модели — вне таймаута)
function createLlamaCppBackend({ config, llama, think }) {
  async function send({ messages, format, options, cancel, onText }) {
    const base = await llama.url();
    const gen = { ...config.llm, ...options };
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...llama.headers },
      body: JSON.stringify({
        messages,
        stream: !!onText,
        temperature: gen.temperature,
        top_p: gen.top_p,
        top_k: gen.top_k,
        min_p: gen.min_p,
        presence_penalty: gen.presence_penalty,
        repeat_penalty: gen.repeat_penalty,
        ...(gen.num_predict && { max_tokens: gen.num_predict }),
        // Ответ строго по JSON-схеме — грамматика llama.cpp, как format у Ollama
        ...(format && { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: format } } }),
        chat_template_kwargs: { enable_thinking: think() === true },
        cache_prompt: true, // неизменное начало промпта не пересчитывается
        ...(onText && { stream_options: { include_usage: true } }),
      }),
      signal: withTimeout(cancel),
    });
    if (!res.ok) throw new Error(`llama.cpp ${res.status}: ${await res.text()}`);
    if (!onText) {
      const data = await res.json();
      return { content: data.choices?.[0]?.message?.content ?? '', promptTokens: data.usage?.prompt_tokens };
    }
    // Поток SSE: «data: {…}», в конце — «data: [DONE]»
    return readLines(
      res,
      (line) => {
        if (!line.startsWith('data:')) return null;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return { done: true };
        const part = JSON.parse(payload);
        if (part.error) throw new Error(`llama.cpp: ${part.error.message || part.error}`);
        return {
          text: part.choices?.[0]?.delta?.content,
          stats: part.usage ? { promptTokens: part.usage.prompt_tokens } : undefined,
        };
      },
      onText,
    );
  }

  // Модель выгружена по простою — запустить сервер заранее
  const prewarm = () => (llama.running() ? Promise.resolve() : llama.ensure().catch(() => {}));

  // Готова, когда llama.cpp и файл модели скачаны (большую модель ставят по согласию — core/setup.js)
  return { send, prewarm, available: () => llama.available() };
}

module.exports = { createLlamaCppBackend };
