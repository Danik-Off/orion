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
const { installedRouterVersion } = require('./component-releases');
const { normalizeRequest } = require('../lib/idioms');

// Строка, которой FunctionGemma учили объявлять функции (без неё исходная хуже вызывает инструменты).
// Дообученной она не нужна: запрос — одна фраза, без системного промпта (router.system: false; так короче и быстрее)
const SYSTEM = 'You are a model that can do function calling with the following functions';

// Фраза опирается на прошлую реплику — без истории её не понять
const REFERS = /(?<!\p{L})(его|её|ее|их|это|этот|эту|там|туда|тоже|ещё|еще|снова|опять|обратно|такой же|а завтра|а сейчас)(?!\p{L})/iu;
// «а можешь включить музыку», «ну включи радио» — обычные просьбы; ссылки на прошлое («а завтра», «это», «тоже») ловит REFERS
const CONTINUATION = /^(и|но|да|нет|ладно)\s/i;
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

// server — свой llama-server с моделью router.model (core/llama.js); dataDir — куда писать набор;
// alone() — большой модели нет: передавать некому, поэтому догадка маленькой берётся и при меньшей уверенности
// (router.minConfidenceAlone), а аргумент, который писала бы большая, разбирают правила (lib/text-args.js)
// Инструменты, ошибка которых что-то делает с компьютером, — и глаголы, без которых их не зовут
const RISKY = new Set(['steam_launch', 'open_app', 'close_app', 'power', 'run_command', 'file_op', 'type_text', 'open_url', 'pc_setting']);
const ACTION_VERB =
  /(?<!\p{L})(?:запуст|откр|закр|включ|выключ|вруб|выруб|поигра|сыгра|играть|заверш|перезагр|напечат|набер|наби|создай|созда|удали|перемест|переимен|скопир|сохрани|зайди|перейди|отключ|подключ|сделай|поставь|поменяй|смени|верни|убери|усыпи|заблок|запусти|переключ|перевед|выстав|установ|убав|прибав|активир|деактивир)\p{L}*/iu;

function createRouter({ config, server, skills, audit = () => {}, dataDir, alone = () => false }) {
  // Настройки читаются при каждом запросе: включить, выключить или сменить порог можно без перезапуска
  const DEFAULTS = { enabled: true, exclude: [], maxSkills: 3, collect: true, minConfidence: 0.95 };
  const cfg = () => ({ ...DEFAULTS, ...config.router });
  // Описания инструментов в запросе: нужны исходной модели (известное имя из core/llama.js), не нужны дообученной (свой .gguf)
  const toolsInPrompt = () => cfg().toolsInPrompt ?? Boolean(MODELS[cfg().model]?.tools);
  // Системная строка: исходной модели — да; orion-router v1 обучена с ней, с v2 запрос — одна фраза
  const withSystem = () => cfg().system ?? (toolsInPrompt() || (cfg().model === 'orion-router' && installedRouterVersion(config) < 2));

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
        messages: [...(withSystem() ? [{ role: 'developer', content: SYSTEM }] : []), { role: 'user', content: text }],
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
    // «какая там погода», «ну это самое включи радио» — заполнители не делают фразу ссылкой на прошлое
    if (!cfg().enabled || !server.available() || followup || !(routable(text) || routable(normalizeRequest(text)))) return null;
    // Задача для подключённого сервера MCP — сразу большой модели: она видит его в каталоге и пишет параметры
    const ext = skills.external?.(text);
    if (ext) {
      skills.skillInfo(ext)?.prewarm?.(); // пока большая модель думает, сервер успеет подняться
      audit({ router: 'передал', input: text, mcp: ext });
      return null;
    }
    // Фраза по первым словам принадлежит инструменту (owns) — маленькую модель не спрашиваем: она путала
    // «напечатай привет, буду через 10 минут» с таймером
    const owned = skills.owner?.(text);
    if (owned) {
      audit({ router: 'навык', input: text, tool: owned.tool, owns: true });
      return { focus: owned };
    }
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
    const threshold = alone() ? (cfg().minConfidenceAlone ?? 0.6) : cfg().minConfidence;
    if (!known || reply.sure.name < threshold) {
      audit({ router: 'передал', input: text, raw: String(reply.text).slice(0, 160), p, ms });
      return null;
    }
    const skill = skills.skillOf(c.name);
    // Инструмент с последствиями — только если во фразе есть просьба это сделать: «вы на джойстике играете»
    // (разговор в комнате) маленькая модель уверенно приняла за «запусти Deadlock» (случай из журнала)
    if (RISKY.has(c.name) && !ACTION_VERB.test(text)) {
      audit({ router: 'передал', input: text, tool: c.name, p, ms, risky: 'нет глагола-просьбы' });
      return null;
    }
    if (alone()) {
      // Без большой модели проверить её некому: инструмент — только если во фразе есть слова его навыка
      // («сколько стоит iPhone» ≠ закрыть программу), аргумент — по правилам, а её собственный — лишь уверенный
      const info = skills.skillInfo(skill);
      const named = info?.always || !info?.keywords?.length || skills.scores(text).some((x) => x.id === skill);
      if (!named) {
        audit({ router: 'передал', input: text, tool: c.name, p, ms, alone: 'нет слов навыка' });
        return null;
      }
      const own = skills.argAllowed(c.name, c.arg) && reply.sure.arg >= (cfg().minArgAlone ?? 0.95) ? c.arg : null;
      audit({ router: 'навык', input: text, tool: c.name, arg: c.arg, p, ms, alone: true });
      return { focus: { skill, tool: c.name, arg: own } };
    }
    if (needsModel(c.name) || reply.sure.arg < threshold || !skills.argAllowed(c.name, c.arg)) {
      audit({ router: 'навык', input: text, tool: c.name, arg: c.arg, p, ms });
      // Её аргумент — запасной: пригодится, если большой модели нет и правила фразу не разобрали
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

module.exports = { createRouter, parseCall, routable, confidence, SYSTEM, MULTI, RISKY, ACTION_VERB };
