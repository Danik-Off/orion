// Последняя ступень: облачная модель — когда локальная честно ответила «не умею» или «не знаю».
//
// Выключено по умолчанию. Включается в config.json (cloud.enabled) и спрашивает разрешения перед КАЖДОЙ
// отправкой (cloud.ask, по умолчанию true): «Передать вопрос в облако?». В облако уходит только текст
// этой фразы — без памяти о людях, истории разговора и имени собеседника.
//
// Провайдеры подключаются списком cloud.providers, выбранный — cloud.use (id):
//   { "id": "claude", "type": "anthropic", "apiKey": "", "model": "claude-opus-5-5" }
//       ключ можно не писать — тогда берётся из переменной ANTHROPIC_API_KEY;
//   { "id": "openrouter", "type": "openai", "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "…", "model": "…" }
//       любой сервис с OpenAI-совместимым /chat/completions: OpenRouter, DeepSeek, YandexGPT, OpenAI и др.

const { remoteConfigured } = require('./setup');

const MAX_TOKENS = 1024; // голосовой ответ — несколько предложений

function systemPrompt(name) {
  const today = new Date().toLocaleDateString('ru-RU', { dateStyle: 'long' });
  return (
    `Ты ${name}, голосовой ассистент. Сегодня ${today}. Ответ будет озвучен: по-русски, 1–4 коротких предложения, ` +
    'без markdown, списков и эмодзи, числа цифрами, всегда буква «ё». Если не уверен — так и скажи.'
  );
}

// Модели Claude пятого поколения: усилие рассуждений и запасная модель при отказе — на стороне сервера
const CLAUDE_5 = /^claude-(opus-5|fable-5|sonnet-5-5)/;

async function viaAnthropic(p, system, question) {
  const { Anthropic } = require('@anthropic-ai/sdk');
  const client = new Anthropic({ ...(p.apiKey && { apiKey: p.apiKey }), timeout: 60_000, maxRetries: 1 });
  const model = p.model || 'claude-opus-5-5';
  const modern = CLAUDE_5.test(model);
  const response = await client.beta.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: question }],
    // Короткий голосовой ответ — низкое усилие: быстрее и дешевле
    ...(modern && { output_config: { effort: 'low' } }),
    // Отказ по правилам безопасности — сервер сам повторит запрос на подходящей модели
    ...(modern && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
  });
  if (response.stop_reason === 'refusal') return null;
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim();
}

async function viaOpenAI(p, system, question) {
  if (!p.baseUrl) throw new Error('у провайдера не указан baseUrl');
  const res = await fetch(`${p.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(p.apiKey && { Authorization: `Bearer ${p.apiKey}` }) },
    body: JSON.stringify({
      model: p.model,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: question },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${p.id || 'облако'} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return String(data.choices?.[0]?.message?.content ?? '').trim();
}

// Провайдеры по полю type. Свой — функция (provider, system, question) → текст ответа | null
const PROVIDERS = { anthropic: viaAnthropic, openai: viaOpenAI };

// confirm(текст) → true / false / null (не ответили) — как подтверждение опасных действий
function createCloud({ config, confirm, audit = () => {} }) {
  const cfg = () => ({ enabled: false, ask: true, use: '', providers: [], ...config.cloud });
  const provider = () => {
    const c = cfg();
    if (!c.enabled) return null;
    const list = Array.isArray(c.providers) ? c.providers : [];
    const chosen = list.find((p) => p.id === c.use) || list[0];
    if (chosen) return chosen;
    // Отдельных провайдеров нет — внешняя модель из настроек «Модели» (config.remote): так комбинируются
    // локальная модель и удалённая
    return remoteConfigured(config) ? { id: 'remote', ...config.remote } : null;
  };

  // → текст ответа; null — облако выключено, человек не разрешил или ответа нет
  async function ask(question) {
    const p = provider();
    if (!p) return null;
    if (cfg().ask !== false) {
      const ok = await confirm(`Сам не справлюсь. Передать вопрос в облако (${p.id || p.type})? «${String(question).slice(0, 120)}»`);
      if (ok !== true) {
        audit({ cloud: 'не разрешено', provider: p.id });
        return null;
      }
    }
    const t0 = Date.now();
    try {
      const send = PROVIDERS[p.type];
      if (!send) throw new Error(`неизвестный тип провайдера «${p.type}» (есть: ${Object.keys(PROVIDERS).join(', ')})`);
      const answer = await send(p, systemPrompt(config.name), question);
      audit({ cloud: 'ответ', provider: p.id, model: p.model, ms: Date.now() - t0, chars: answer?.length || 0 });
      return answer || null;
    } catch (err) {
      audit({ cloud: 'ошибка', provider: p.id, error: String(err?.message || err).slice(0, 300) });
      return null;
    }
  }

  return { ask, available: () => !!provider() };
}

module.exports = { createCloud, PROVIDERS };
