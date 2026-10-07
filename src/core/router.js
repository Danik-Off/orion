// Первая ступень разбора: маленькая модель вызова функций (FunctionGemma 270M, ~300 МБ, десятки мс).
//
//   фраза → быстрый разбор навыков → FunctionGemma ─┬→ готовый вызов (простой аргумент, модель уверена)
//                                                   ├→ «это навык X» → Qwen с узким промптом этого навыка
//                                                   └→ не знает / разговор → Qwen с полным промптом → облако
//
// Дообученная модель (scripts/router-train.py) знает инструменты Ориона наизусть: в запрос идёт только фраза —
// короткий промпт, быстрый ответ. Исходной FunctionGemma нужны описания
// инструментов — тогда в запрос идут инструменты навыков, которые слова фразы называют (router.toolsInPrompt;
// по умолчанию — сам: исходная модель из списка core/llama.js — с описаниями, свой файл .gguf — без).
//
// Аргумент, который надо вычислить или переформулировать (время напоминания, дата, текст заметки, факт о
// человеке — инструменты с llmArg: true и навыки из router.exclude), маленькая модель не заполняет: она лишь
// называет инструмент, а аргумент пишет большая по узкому промпту (core/assistant/model-planner.js → planFocused).
// Каждый план большой модели записывается (router.collect) — это набор для следующего дообучения.
const fs = require('node:fs');
const path = require('node:path');
const { MODELS } = require('./llama');

// Строка, которой FunctionGemma учили объявлять функции (без неё она хуже вызывает инструменты)
const SYSTEM = 'You are a model that can do function calling with the following functions';

// Фраза опирается на прошлую реплику — без истории её не понять
const REFERS = /(?<!\p{L})(его|её|ее|их|это|этот|эту|там|туда|тоже|ещё|еще|снова|опять|обратно|такой же|а завтра|а сейчас)(?!\p{L})/iu;
const CONTINUATION = /^(а|и|но|ну|да|нет|ладно)\s/i;
// Несколько задач: «открой телеграм и включи музыку», «…, потом …»
const MULTI =
  /(?<!\p{L})(и|а потом|потом|затем|после этого|а ещё|а еще)\s+(?:\p{L}+\s+)?(включи|выключи|открой|закрой|запусти|поставь|найди|покажи|напомни|сделай|скажи|какая|какой|какие|сколько|что|как|где|когда)(?!\p{L})/iu;

// «<start_function_call>call:weather{arg:<escape>Казань<escape>}» → { name, arg }; «call:timer{}» → arg ''
function parseCall(raw) {
  const m = String(raw).match(/call:([A-Za-z_][\w]*)\{([\s\S]*?)(?:\}\s*(?:<end_function_call>)?\s*$|\}$|$)/);
  if (!m) return null;
  const a = m[2].match(/(?:^|,)\s*arg:(?:<escape>([\s\S]*?)<escape>|([^,}]*))/);
  return { name: m[1], arg: a ? (a[1] ?? a[2] ?? '').trim() : '' };
}

// Можно ли вообще давать фразу маленькой модели (то же правило — для записи набора)
function routable(text) {
  const t = String(text).trim();
  return t.length >= 3 && t.length <= 160 && !REFERS.test(t) && !CONTINUATION.test(t) && !MULTI.test(t);
}

// Уверенность в имени инструмента и в аргументе — вероятность самого сомнительного токена каждой части.
// Ошибается маленькая модель обычно в одном месте (не тот инструмент, выдуманный город), и там же она не уверена.
// tokens — logprobs ответа llama-server: [{ token, logprob }]; без них — 1 (проверка только по смыслу)
function confidence(tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return { name: 1, arg: 1 };
  let text = '';
  let name = 0;
  let arg = 0;
  for (const t of tokens) {
    const lp = Number.isFinite(t.logprob) ? t.logprob : 0;
    if (text.includes('{')) arg = Math.min(arg, lp);
    else name = Math.min(name, lp);
    text += t.token ?? '';
  }
  return { name: Math.exp(name), arg: Math.exp(arg) };
}

// server — свой llama-server с моделью router.model (core/llama.js); dataDir — куда писать набор
function createRouter({ config, server, skills, audit = () => {}, dataDir }) {
  // Настройки читаются при каждом запросе: включить, выключить или сменить порог можно без перезапуска
  const DEFAULTS = { enabled: true, exclude: [], maxSkills: 3, collect: true, minConfidence: 0.95 };
  const cfg = () => ({ ...DEFAULTS, ...config.router });
  // Описания инструментов в запросе: нужны исходной модели (известное имя из core/llama.js), не нужны дообученной (свой .gguf)
  const toolsInPrompt = () => cfg().toolsInPrompt ?? Boolean(MODELS[cfg().model]?.tools);

  const dataFile = dataDir && path.join(dataDir, 'router-data.jsonl');

  // Навыки, которые слова фразы называют явно — для исходной модели, которой нужны описания инструментов
  const skillsFor = (text) =>
    skills
      .scores(text)
      .filter((x) => x.words >= 1)
      .slice(0, cfg().maxSkills)
      .map((x) => x.id);

  async function call(text, tools) {
    const base = await server.url();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...server.headers },
      body: JSON.stringify({
        messages: [
          { role: 'developer', content: SYSTEM },
          { role: 'user', content: text },
        ],
        ...(tools && { tools }),
        temperature: 0,
        max_tokens: 64,
        // Сервер не разбирает формат вызова FunctionGemma — останавливаем на конце первого вызова и разбираем сами
        stop: ['<end_function_call>', '<start_function_response>'],
        cache_prompt: true,
        logprobs: true, // уверенность в каждом токене вызова — см. confidence
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`router ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const choice = data.choices?.[0];
    return { text: choice?.message?.content ?? '', sure: confidence(choice?.logprobs?.content) };
  }

  // Аргумент этого инструмента пишет большая модель: его надо вычислить или переформулировать
  const needsModel = (tool) => !!skills.toolInfo(tool)?.tool.llmArg || cfg().exclude.includes(skills.skillOf(tool));

  // → { plan } — готовый план; { focus: { skill, tool } } — навык понят, аргумент — большой модели по узкому
  //   промпту; null — передать большой модели целиком
  async function route(text, { followup = false } = {}) {
    if (!cfg().enabled || !server.available() || followup || !routable(text)) return null;
    let tools;
    if (toolsInPrompt()) {
      const ids = skillsFor(text);
      if (!ids.length) return null; // разговор или навык не назван — исходной модели не по силам
      tools = skills.toolDefs(ids);
    }
    const t0 = Date.now();
    let reply;
    try {
      reply = await call(text, tools);
    } catch (err) {
      audit({ router: 'ошибка', error: String(err?.message || err) });
      return null;
    }
    const ms = Date.now() - t0;
    const c = parseCall(reply.text);
    const p = { name: Math.round(reply.sure.name * 100) / 100, arg: Math.round(reply.sure.arg * 100) / 100 };
    const known = c && skills.toolInfo(c.name) && (!tools || tools.some((t) => t.function.name === c.name));
    if (!known || reply.sure.name < cfg().minConfidence) {
      audit({ router: 'передал', input: text, raw: String(reply.text).slice(0, 160), p, ms });
      return null;
    }
    const skill = skills.skillOf(c.name);
    if (needsModel(c.name) || reply.sure.arg < cfg().minConfidence || !skills.argAllowed(c.name, c.arg)) {
      audit({ router: 'навык', input: text, tool: c.name, arg: c.arg, p, ms });
      return { focus: { skill, tool: c.name } };
    }
    audit({ router: 'выполнил', input: text, tool: c.name, arg: c.arg, p, ms });
    // Ответ говорит сам инструмент (погода, курсы); для остальных — короткое подтверждение
    const say = skills.speaksOf(c.name) ? '' : 'Готово, сэр.';
    return { plan: { addressed: true, topic: skill, actions: [{ tool: c.name, arg: c.arg }], say, router: true } };
  }

  // План большой модели для фразы, которую мог бы взять роутер, — пример для дообучения.
  // Хранится только у вас, в папке данных; в сеть не уходит.
  function record(text, plan) {
    if (!cfg().collect || !dataFile || !routable(text) || plan.addressed === false) return;
    const row = { t: new Date().toISOString(), text, actions: plan.actions.map((a) => ({ tool: a.tool, arg: a.arg })) };
    try {
      fs.appendFileSync(dataFile, `${JSON.stringify(row)}\n`); // строка в сотню байт — быстрее, чем очередь записи
    } catch {}
  }

  // Загрузить модель заранее: она маленькая и держится в памяти всё время
  const warmup = () =>
    cfg().enabled && server.available()
      ? server.ensure().catch((err) => audit({ router: 'не запустился', error: String(err?.message || err) }))
      : null;

  return { route, record, warmup, needsModel, enabled: () => cfg().enabled && server.available() };
}

module.exports = { createRouter, parseCall, routable, confidence, SYSTEM };
