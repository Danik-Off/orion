// Внешняя модель как основная (backend: remote) — по выбору человека в настройках. В отличие от облака-подстраховки
// (core/cloud.js), сюда уходит весь запрос: промпт с памятью о собеседнике и история разговора — окно настроек
// говорит об этом прямо. config.remote: { type: 'openai' | 'anthropic', baseUrl, apiKey, model }.
const { withTimeout, readLines } = require('../stream');
const { remoteConfigured } = require('../../setup');

const MAX_TOKENS = 2048;
const CLAUDE_5 = /^claude-(opus-5|fable-5|sonnet-5-5)/;

// Anthropic: строгий JSON-ответ требует additionalProperties: false у каждого объекта схемы
function strict(schema) {
  if (Array.isArray(schema)) return schema.map(strict);
  if (!schema || typeof schema !== 'object') return schema;
  const out = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, strict(v)]));
  if (out.type === 'object' && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

function createRemoteBackend({ config }) {
  const r = () => config.remote || {};

  // OpenAI-совместимый /chat/completions: только стандартные поля (чужие сервисы отвергают незнакомые)
  async function viaOpenAI({ messages, format, options, cancel, onText }) {
    const { baseUrl, apiKey, model } = r();
    const gen = { ...config.llm, ...options };
    const body = (responseFormat) =>
      JSON.stringify({
        model,
        messages,
        stream: !!onText,
        temperature: gen.temperature,
        top_p: gen.top_p,
        max_tokens: gen.num_predict || MAX_TOKENS,
        ...(responseFormat && { response_format: responseFormat }),
        ...(onText && { stream_options: { include_usage: true } }),
      });
    const send = (responseFormat) =>
      fetch(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey && { Authorization: `Bearer ${apiKey}` }) },
        body: body(responseFormat),
        signal: withTimeout(cancel),
      });
    let res = await send(format && { type: 'json_schema', json_schema: { name: 'answer', schema: format } });
    // Сервис не умеет ответ по схеме (DeepSeek и др.) — просим просто JSON: формат плана описан в промпте
    if (res.status === 400 && format && /response_format|json_schema/i.test(await res.clone().text()))
      res = await send({ type: 'json_object' });
    if (!res.ok) throw new Error(`Внешняя модель ${res.status}: ${(await res.text()).slice(0, 300)}`);
    if (!onText) {
      const data = await res.json();
      return { content: data.choices?.[0]?.message?.content ?? '', promptTokens: data.usage?.prompt_tokens };
    }
    return readLines(
      res,
      (line) => {
        if (!line.startsWith('data:')) return null;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return { done: true };
        const part = JSON.parse(payload);
        if (part.error) throw new Error(`Внешняя модель: ${part.error.message || part.error}`);
        return { text: part.choices?.[0]?.delta?.content, stats: part.usage ? { promptTokens: part.usage.prompt_tokens } : undefined };
      },
      onText,
    );
  }

  // Anthropic — официальный SDK; ответ по JSON-схеме (output_config.format). Без потока: ответ приходит целиком
  async function viaAnthropic({ messages, format, cancel, onText }) {
    const { Anthropic } = require('@anthropic-ai/sdk');
    const { apiKey, model = 'claude-opus-5-5' } = r();
    const client = new Anthropic({ ...(apiKey && { apiKey }), timeout: 60_000, maxRetries: 1 });
    const modern = CLAUDE_5.test(model);
    const response = await client.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        system: messages
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .join('\n\n'),
        messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
        output_config: {
          ...(format && { format: { type: 'json_schema', schema: strict(format) } }),
          ...(modern && { effort: 'low' }), // голосовой ответ — быстрее и дешевле
        },
      },
      { signal: cancel },
    );
    if (response.stop_reason === 'refusal') throw new Error('Внешняя модель отказалась отвечать');
    const content = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    onText?.(content);
    return { content, promptTokens: response.usage?.input_tokens };
  }

  const send = (request) => (r().type === 'anthropic' ? viaAnthropic(request) : viaOpenAI(request));
  return { send, prewarm: () => Promise.resolve(), available: () => remoteConfigured(config) };
}

// Без большой модели: ступени, которым она нужна, видят available() === false и отвечают сами
function createNoneBackend() {
  return {
    send: async () => {
      throw Object.assign(new Error('Большая языковая модель не подключена'), { code: 'NO_BRAIN' });
    },
    prewarm: () => Promise.resolve(),
    available: () => false,
  };
}

module.exports = { createRemoteBackend, createNoneBackend, strict };
