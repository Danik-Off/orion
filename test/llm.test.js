// Клиент языковой модели и его движки (core/llm) — на подставном локальном сервере
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLlm, STOP } = require('../src/core/llm');
const { localOrigin } = require('../src/core/llm/backends/ollama');

// Сервер отвечает handler(путь, тело) → { status?, json? } | { status?, lines: [...] } (поток)
async function fakeServer(handler) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ path: req.url, body: parsed, headers: req.headers });
      const r = handler(req.url, parsed, requests.length);
      res.statusCode = r.status || 200;
      if (r.lines) return res.end(r.lines.map((l) => `${l}\n`).join(''));
      res.setHeader('Content-Type', 'application/json');
      res.end(typeof r.json === 'string' ? r.json : JSON.stringify(r.json));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return { url, requests, close: () => srv.close() };
}

const llamaAt = (url) => ({
  url: async () => url,
  headers: { Authorization: 'Bearer k' },
  running: () => true,
  ensure: async () => {},
  available: () => true,
});
const baseConfig = { name: 'Орион', think: false, llm: { temperature: 0.7 }, numCtx: 4096 };

test('llm: llama.cpp — ответ целиком и поток SSE с подсчётом токенов промпта', async () => {
  const srv = await fakeServer((_path, body) =>
    body.stream
      ? {
          lines: [
            'data: {"choices":[{"delta":{"content":"При"}}]}',
            'data: {"choices":[{"delta":{"content":"вет"}}],"usage":{"prompt_tokens":42}}',
            'data: [DONE]',
          ],
        }
      : { json: { choices: [{ message: { content: 'целиком' } }], usage: { prompt_tokens: 7 } } },
  );
  try {
    const llm = createLlm({ config: { ...baseConfig, backend: 'llamacpp' }, llama: llamaAt(srv.url) });
    assert.equal(await llm.chat([{ role: 'user', content: 'x' }], { type: 'object' }, { temperature: 0.1 }), 'целиком');
    const sent = srv.requests[0].body;
    assert.equal(sent.temperature, 0.1, 'параметры вызова поверх config.llm');
    assert.equal(sent.response_format.json_schema.schema.type, 'object', 'ответ по JSON-схеме');
    assert.equal(sent.chat_template_kwargs.enable_thinking, false);
    assert.equal(srv.requests[0].headers.authorization, 'Bearer k', 'ключ этого запуска');
    assert.equal(llm.stats.promptTokens, 7);

    const parts = [];
    assert.equal(await llm.chat([{ role: 'user', content: 'x' }], undefined, {}, (t) => parts.push(t)), 'Привет');
    assert.deepEqual(parts, ['При', 'Привет']);
    assert.equal(llm.stats.promptTokens, 42);
  } finally {
    srv.close();
  }
});

test('llm: onText вернул STOP — ответ обрывается, статистика не портится', async () => {
  const srv = await fakeServer(() => ({
    lines: [
      'data: {"choices":[{"delta":{"content":"раз "}}]}',
      'data: {"choices":[{"delta":{"content":"два "}}]}',
      'data: {"choices":[{"delta":{"content":"три"}}]}',
      'data: [DONE]',
    ],
  }));
  try {
    const llm = createLlm({ config: { ...baseConfig, backend: 'llamacpp' }, llama: llamaAt(srv.url) });
    llm.stats.promptTokens = 5;
    const text = await llm.chat([{ role: 'user', content: 'x' }], undefined, {}, (t) => (t.includes('два') ? STOP : undefined));
    assert.equal(text, 'раз два ');
    assert.equal(llm.stats.promptTokens, 5);
  } finally {
    srv.close();
  }
});

test('llm: Ollama — поток NDJSON; модель без рассуждений — повтор без think; смена движка на лету', async () => {
  const srv = await fakeServer((path, body, n) => {
    if (path === '/api/chat' && n === 1) return { status: 400, json: { error: 'model does not support thinking' } };
    if (path === '/api/chat')
      return {
        lines: [
          JSON.stringify({ message: { content: 'Да' } }),
          JSON.stringify({ message: { content: '.' }, done: true, prompt_eval_count: 9 }),
        ],
      };
    return { json: { choices: [{ message: { content: 'из llama.cpp' } }] } };
  });
  try {
    const config = { ...baseConfig, backend: 'ollama', ollamaUrl: srv.url, model: 'gemma3', think: true, llmIdleMinutes: 10 };
    const llm = createLlm({ config, llama: llamaAt(srv.url) });
    assert.equal(await llm.chat([{ role: 'user', content: 'x' }], undefined, {}, () => {}), 'Да.');
    assert.equal(srv.requests[0].body.think, true);
    assert.equal(srv.requests[1].body.think, undefined, 'второй раз — без think');
    assert.equal(srv.requests[1].body.keep_alive, '10m', 'модель держится в памяти столько, сколько llmIdleMinutes');
    assert.equal(srv.requests[1].body.options.num_ctx, 4096);
    assert.equal(llm.stats.promptTokens, 9);

    config.backend = 'llamacpp'; // настройки сменили движок — без перезапуска
    assert.equal(await llm.chat([{ role: 'user', content: 'x' }]), 'из llama.cpp');
    assert.equal(srv.requests.at(-1).path, '/v1/chat/completions');
  } finally {
    srv.close();
  }
});

test('llm: Ollama только на localhost — разговоры не уходят в сеть', () => {
  assert.equal(localOrigin('http://127.0.0.1:11434/x'), 'http://127.0.0.1:11434');
  assert.equal(localOrigin('http://localhost:11434'), 'http://localhost:11434');
  assert.throws(() => localOrigin('http://example.com:11434'), /localhost/);
  assert.throws(() => localOrigin('http://192.168.1.5:11434'), /localhost/);
});

test('llm: прогрев — не чаще раза в 30 с; без выгруженной модели сервер не трогается', async () => {
  let ensured = 0;
  const llama = { url: async () => '', headers: {}, running: () => false, ensure: async () => ensured++ };
  const llm = createLlm({ config: { ...baseConfig, backend: 'llamacpp' }, llama });
  await llm.prewarm();
  await llm.prewarm();
  assert.equal(ensured, 1);
});

test('llm: внешняя модель по OpenAI-совместимому API — только стандартные поля, ответ по схеме; без схемы — просто JSON', async () => {
  const srv = await fakeServer((_path, body, n) => {
    if (n === 1 && body.response_format?.type === 'json_schema')
      return { status: 400, json: { error: { message: 'response_format json_schema is not supported' } } };
    return { json: { choices: [{ message: { content: '{"topic":"chat","actions":[],"say":"Да."}' } }], usage: { prompt_tokens: 3 } } };
  });
  try {
    const config = {
      ...baseConfig,
      backend: 'remote',
      remote: { type: 'openai', baseUrl: `${srv.url}/v1/`, apiKey: 'sk-x', model: 'deepseek-chat' },
    };
    const llm = createLlm({ config, llama: null });
    assert.equal(llm.available(), true);
    assert.equal(await llm.chat([{ role: 'user', content: 'x' }], { type: 'object' }), '{"topic":"chat","actions":[],"say":"Да."}');
    const [first, second] = srv.requests;
    assert.equal(first.path, '/v1/chat/completions');
    assert.equal(first.headers.authorization, 'Bearer sk-x');
    assert.equal(first.body.model, 'deepseek-chat');
    for (const field of ['cache_prompt', 'chat_template_kwargs', 'top_k', 'min_p', 'repeat_penalty']) {
      assert.equal(field in first.body, false, `${field} — поле llama.cpp, чужой сервис его не знает`);
    }
    assert.equal(second.body.response_format.type, 'json_object', 'схема не поддерживается — просто JSON');

    config.remote.baseUrl = '';
    assert.equal(llm.available(), false, 'без адреса внешняя модель не настроена');
    config.backend = 'none';
    assert.equal(llm.available(), false);
    await assert.rejects(llm.chat([{ role: 'user', content: 'x' }]), (e) => e.code === 'NO_BRAIN');
  } finally {
    srv.close();
  }
});

test('llm: схема ответа для Anthropic — у каждого объекта additionalProperties: false', () => {
  const { strict } = require('../src/core/llm/backends/remote');
  const schema = { type: 'object', properties: { actions: { type: 'array', items: { anyOf: [{ type: 'object', properties: {} }] } } } };
  const s = strict(schema);
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.actions.items.anyOf[0].additionalProperties, false);
  assert.equal(schema.additionalProperties, undefined, 'исходная схема не меняется');
});
