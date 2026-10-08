// Реестр навыков и их база знаний. Ядро не знает, что умеют навыки, — оно собирает это из их описаний.
//
// Маленькой модели вредит длинный промпт, поэтому в постоянной части она видит только КАТАЛОГ —
// название и одну строку о каждом навыке. Полные описания инструментов, правила и примеры
// подгружаются лишь для навыков, нужных этой фразе (select). Первым полем ответа модель называет
// навык из каталога (topic); если его подробностей в запросе не было — запрос повторяется с ним.
//
// Контракт навыка (src/skills/*.js):
//   id        — короткое имя, по нему навык можно отключить в config.json: "skills": { "<id>": { "enabled": false } }
//   title     — строка для каталога: что умеет навык (коротко, через запятую)
//   keywords  — основы слов и фразы, по которым навык подгружается («погод», «курс валют»); можно RegExp
//               или функцию (text) → bool — например, «есть ли во фразе название установленной игры»
//   always    — подгружать всегда (запасной вариант на всё, что не нашлось по словам)
//   hint: false — не подсказывать модели этот навык, даже если слова совпали (память: «я устал» — не команда)
//   fallback: true — запасной навык: модель ответила «не умею» — запрос повторяется с ним (агент для сложных задач)
//   available(config) → false — навык не настроен (например, нет адреса умного дома) и не подключается
//   platforms — на каких ОС навык работает (['win32']); не указано — на всех
//   tools     — инструменты, которые модель может вызвать:
//     name      — имя инструмента (латиница)
//     arg       — что передавать в аргументе (одна строка)
//     use       — когда применять (попадает в промпт)
//     examples  — [фраза пользователя, план] — учат модель пользоваться инструментом
//     argEnum   — все допустимые значения arg: модель физически не сможет написать другое (грамматика движка)
//     normalize(arg, text) → arg — исправить типичную ошибку модели по исходной фразе (до выполнения)
//     run(arg, ctx, request) → { ok, speak?, message?, sources? }
//        speak   — готовый текст ответа (заменяет заготовку модели)
//        message — пояснение, если не получилось или нужно что-то сказать сверх плана
//     speaks: true — run всегда возвращает speak или message: реплику модели можно не дописывать
//     filler    — короткая фраза («Сейчас поищу.»): ядро скажет её сразу, пока медленный инструмент работает
//     llmArg: true — аргумент надо вычислить или переформулировать (время, дата, факт о человеке): маленькая
//               модель вызова функций только называет инструмент, аргумент пишет большая по узкому промпту
//   rules     — дополнительные строки правил для промпта (подгружаются вместе с навыком)
//   needs     — какие данные нужны узкому промпту навыка: 'now' (дата и время), 'person' (имя и обращение),
//               'city' (где находится ассистент), 'facts' (что известно о собеседнике и общее); по умолчанию ['now']
//   quick(text, ctx) → план или null — разбор частых фраз без модели (мгновенно)
//   router: false — маленькая модель этого навыка не знает (появился после её обучения): фразы о нём сразу
//               уходят большой модели (skills.external); router: N — знает с версии N orion-router (у кого стоит
//               прежняя, фразы по-прежнему у большой)
//   init(ctx) — подготовка при старте; может дополнить описание своих инструментов
//   offer(ctx) — предложить что-то при запуске, когда всё установлено (вопрос через ctx.confirm):
//               «Нашёл Claude Code — передавать ему сложные задачи?»
//
// ctx — то, чем ядро делится с навыками: config, dataDir, llm, confirm (true/false; null — не ответили),
//   say(text) — сказать самому, без вопроса (в окне и голосом), radio — { play(станция), stop(), state() } (радио в окне),
//   ask(вопрос) → ответ строкой или null (свободный ответ голосом или текстом), startEnrollment() — мастер записи голоса,
//   alarm({ id, label, radio }) — зазвонить будильником (окно звенит или включает радио, пока не выключат),
//   saveSettings(patch) — записать настройку в config.json (как окно настроек), remind, openExternal, openPath,
//   showItemInFolder, clipboard, audit, perform(text, request) — выполнить фразу как команду (для сценариев), а также
//   memory — база знаний ТЕКУЩЕГО собеседника (у каждого голоса своя; у гостя — только чтение пустой),
//   person — { id, name, honorific } или null,
//   shared — общая память (где находится ассистент, дом, семья) — одна на всех,
//   call(tool, arg) — вызвать инструмент другого навыка (например, музыка → программы).
// request — { text } исходная фраза пользователя.

const MAX_SELECTED = 4; // навыков с полным описанием в одном запросе (не считая always)
const CHAT_TOPIC = 'chat'; // тема «просто разговор» — без навыков

const normalize = (text) => String(text).toLowerCase().replace(/ё/g, 'е');
const wordsOf = (text) =>
  normalize(text)
    .split(/[^a-zа-я0-9]+/)
    .filter(Boolean);

// Насколько фраза похожа на тему навыка: каждое совпавшее ключевое слово — балл
function keywordScore(skill, text, words) {
  let score = 0;
  for (const k of skill.keywords || []) {
    if (typeof k === 'function')
      score += k(text) ? 2 : 0; // своя проверка навыка (например, названия установленных игр)
    else if (k instanceof RegExp) score += k.test(text) ? 2 : 0;
    else if (k.includes(' ')) score += text.includes(k) ? 2 : 0;
    else score += words.some((w) => w.startsWith(k)) ? 1 : 0;
  }
  return score;
}

// Пример плана коротко: weather("Казань") + ответ «…» — обёртку JSON и так задаёт схема ответа
function compactPlan({ actions = [], say = '' }) {
  const acts = actions.map((a) => `${a.tool}(${JSON.stringify(a.arg)})`);
  return [...acts, say && `ответ «${say}»`].filter(Boolean).join(' + ') || 'без действий';
}

// Версия маленькой модели: router.version (свой файл, замер) или номер из тега её релиза (models-router-v2 → 2)
function routerVersion(config) {
  const r = config?.router || {};
  if (Number.isFinite(r.version)) return r.version;
  return Number(String(r.release || 'models-router-v1').match(/v(\d+)$/)?.[1] || 1);
}

// Навык подходит этой ОС: без списка platforms — подходит всем
const supports = (skill, platform = process.platform) => !skill.platforms || skill.platforms.includes(platform);

function createSkillRegistry(skills, { config, ctx, audit, platform = process.platform }) {
  const enabled = skills.filter(
    (s) => supports(s, platform) && config.skills?.[s.id]?.enabled !== false && s.available?.(config) !== false,
  );
  const byId = new Map(enabled.map((s) => [s.id, s]));
  const tools = new Map(); // имя → { tool, skill }; храним ссылку, чтобы видеть правки из init()
  function register(skill) {
    if (skill.id === CHAT_TOPIC) throw new Error(`Имя навыка ${CHAT_TOPIC} занято`);
    for (const tool of skill.tools || []) {
      if (tools.has(tool.name)) throw new Error(`Инструмент ${tool.name} объявлен дважды`);
      tools.set(tool.name, { tool, skill: skill.id });
    }
  }
  enabled.forEach(register);

  // Навыки, появившиеся после запуска (инструменты MCP-серверов подключаются асинхронно). Выключенные
  // в настройках не добавляются; навык с занятым id или именем инструмента пропускается — с записью в журнал
  function add(list) {
    const added = [];
    for (const skill of list) {
      if (config.skills?.[skill.id]?.enabled === false || byId.has(skill.id)) continue;
      try {
        register(skill);
      } catch (err) {
        audit({ skill: skill.id, error: String(err.message) });
        continue;
      }
      enabled.push(skill);
      byId.set(skill.id, skill);
      added.push(skill.id);
    }
    return added;
  }
  // Убрать навык на ходу (удалили или выключили сервер MCP); replace — убрать и добавить заново (у сервера
  // изменился список инструментов)
  function remove(id) {
    const skill = byId.get(id);
    if (!skill) return false;
    for (const tool of skill.tools || []) if (tools.get(tool.name)?.skill === id) tools.delete(tool.name);
    enabled.splice(enabled.indexOf(skill), 1);
    byId.delete(id);
    return true;
  }
  const replace = (skill) => (remove(skill.id), add([skill]).length > 0);

  const skillsOf = (ids) => (ids ? ids.map((id) => byId.get(id)).filter(Boolean) : enabled);
  const toolsOf = (ids) => skillsOf(ids).flatMap((s) => s.tools || []);

  // --- промпт ---

  // Каталог: по строке на навык. Постоянная часть промпта — движок её кэширует.
  const catalogPrompt = () => enabled.map((s) => `- ${s.id}: ${s.title || s.tools?.map((t) => t.use).join('; ')}`).join('\n');
  // Каталог инструментов для диспетчера: строка на инструмент — что он делает, без формата аргумента (его пишет
  // узкий промпт инструмента на втором шаге). Постоянная часть промпта — движок её кэширует
  const toolCatalogPrompt = () => enabled.flatMap((s) => (s.tools || []).map((t) => `- ${t.name} (${s.id}): ${t.use}`)).join('\n');
  const toolsPrompt = (ids) =>
    toolsOf(ids)
      .map((t) => `- ${t.name} — ${t.use}. arg: ${t.argEnum ? t.argEnum.map((v) => JSON.stringify(v)).join(' | ') : t.arg}`)
      .join('\n');
  const rulesPrompt = (ids) =>
    skillsOf(ids)
      .flatMap((s) => s.rules || [])
      .join('\n');
  const examplesPrompt = (ids) =>
    skillsOf(ids)
      .flatMap((s) =>
        (s.tools || []).flatMap((t) => (t.examples || []).map(([phrase, plan]) => `"${phrase}" → ${s.id}: ${compactPlan(plan)}`)),
      )
      .join('\n');
  // Полное описание выбранных навыков — для меняющейся части промпта
  const detailsPrompt = (ids) =>
    [toolsPrompt(ids), rulesPrompt(ids), examplesPrompt(ids) && `Примеры:\n${examplesPrompt(ids)}`].filter(Boolean).join('\n\n');

  const names = (ids) => toolsOf(ids).map((t) => t.name);

  // Схема одного действия: инструменты с перечнем допустимых arg — отдельными вариантами (грамматика
  // не даст написать «play-pause» вместо «play_pause»), остальные — одним вариантом со свободной строкой
  function actionSchema(ids) {
    const list = toolsOf(ids);
    const variant = (tool, arg) => ({ type: 'object', properties: { tool, arg }, required: ['tool', 'arg'] });
    const free = list.filter((t) => !t.argEnum).map((t) => t.name);
    const variants = [
      ...list.filter((t) => t.argEnum).map((t) => variant({ type: 'string', enum: [t.name] }, { type: 'string', enum: t.argEnum })),
      ...(free.length ? [variant({ type: 'string', enum: free }, { type: 'string' })] : []),
    ];
    if (!variants.length) return variant({ type: 'string', enum: ['none'] }, { type: 'string' });
    return variants.length === 1 ? variants[0] : { anyOf: variants };
  }
  // Инструменты в формате OpenAI tools — для маленькой модели вызова функций (core/router.js)
  const toolDefs = (ids) =>
    toolsOf(ids).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.use,
        parameters: {
          type: 'object',
          properties: { arg: { type: 'string', description: t.arg || '', ...(t.argEnum && { enum: t.argEnum }) } },
          required: ['arg'],
        },
      },
    }));
  const argAllowed = (name, arg) => !tools.get(name)?.tool.argEnum || tools.get(name).tool.argEnum.includes(arg);

  // --- база знаний: какие навыки нужны фразе ---

  // Баллы навыков по словам фразы; recent — навыки из последних реплик разговора («а завтра?» после погоды)
  function scores(text, recent = []) {
    const t = normalize(text);
    const words = wordsOf(text);
    return enabled
      .filter((s) => !s.always)
      .map((s) => {
        const w = keywordScore(s, t, words);
        return { id: s.id, words: w, score: w + (recent.includes(s.id) ? 0.5 : 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  function select(text, recent = []) {
    const ranked = scores(text, recent)
      .slice(0, MAX_SELECTED)
      .map((x) => x.id);
    return [...enabled.filter((s) => s.always).map((s) => s.id), ...ranked];
  }

  // Навык, который слова фразы явно называют — подсказка, если модель ничего не сделала
  const likely = (text) => scores(text).find((x) => x.words >= 1 && byId.get(x.id).hint !== false)?.id || null;

  // Фраза — про навык, которого маленькая модель не знает (сервер MCP или новый навык с router: false — его не было
  // при её обучении), и его слова совпали не слабее, чем у любого знакомого ей навыка → id этого навыка.
  // Такие фразы маленькая модель не берёт: она схватила бы похожий знакомый инструмент (радио → YouTube)
  const unknownToRouter = (id) => {
    const r = byId.get(id).router;
    return !!byId.get(id).mcp || r === false || (typeof r === 'number' && routerVersion(config) < r);
  };
  function external(text) {
    const ranked = scores(text).filter((x) => x.words >= 1);
    const ext = ranked.find((x) => unknownToRouter(x.id));
    const own = ranked.find((x) => !unknownToRouter(x.id));
    return ext && (!own || ext.words >= own.words) ? ext.id : null;
  }

  // Навык по имени (id, имя инструмента или слово из названия)
  function resolve(arg) {
    const a = normalize(arg).trim();
    if (!a) return null;
    if (byId.has(a)) return a;
    if (tools.has(a)) return tools.get(a).skill;
    return enabled.find((s) => normalize(s.title || '').includes(a))?.id || null;
  }

  // Навык-запасной (fallback: true): ему уходят просьбы, от которых модель отказалась. Выключенный в настройках
  // после запуска — уже не запасной (список навыков пересоберётся при перезапуске)
  const fallback = () => enabled.find((s) => s.fallback && config.skills?.[s.id]?.enabled !== false)?.id || null;

  const skillOf = (toolName) => tools.get(toolName)?.skill || null;
  // Описание инструмента и его навык: { tool, skill } или null (инструмента нет или навык выключен)
  const toolInfo = (toolName) => tools.get(toolName) || null;
  const skillInfo = (id) => byId.get(id) || null;
  const fillerOf = (toolName) => tools.get(toolName)?.tool.filler || null;
  const speaksOf = (toolName) => tools.get(toolName)?.tool.speaks === true;

  function quickPlan(text) {
    for (const skill of enabled) {
      const plan = skill.quick?.(text, ctx);
      if (plan) return plan;
    }
    return null;
  }

  // Аргумент, который получит навык: исправленный по исходной фразе (normalize инструмента)
  function prepare(name, arg, text) {
    const tool = tools.get(name)?.tool;
    const a = String(arg ?? '');
    return tool?.normalize && text ? tool.normalize(a, text) : a;
  }

  // Каждый вызов получает память именно этого собеседника и может вызвать другой навык через ctx.call
  async function run(name, arg, request = {}, depth = 0) {
    const entry = tools.get(name);
    if (!entry) return { ok: false, message: 'Такого я не умею, сэр.' };
    if (depth > 3) return { ok: false, message: 'Слишком длинная цепочка навыков.' };
    const callCtx = {
      ...ctx,
      memory: request.memory || ctx.memory,
      person: request.person || null,
      call: (tool, a) => run(tool, a, request, depth + 1),
      depth,
    };
    try {
      // Исправляем аргумент от модели по исходной фразе; вызовы из других навыков — как есть
      if (depth === 0) arg = prepare(name, arg, request.text);
      const result = (await entry.tool.run(String(arg ?? ''), callCtx, request)) || { ok: true };
      audit({ skill: entry.skill, tool: name, arg, ok: result.ok });
      return result;
    } catch (err) {
      audit({ skill: entry.skill, tool: name, arg, error: String(err?.message || err) });
      return { ok: false, message: 'Не получилось выполнить, сэр.' };
    }
  }

  async function init() {
    for (const skill of enabled) await skill.init?.(ctx);
  }

  // Предложения навыков — по одному: в окне одновременно висит только один вопрос
  async function offer() {
    for (const skill of enabled) {
      try {
        await skill.offer?.(ctx);
      } catch (err) {
        audit({ skill: skill.id, offer: String(err?.message || err) });
      }
    }
  }

  return {
    names,
    catalogPrompt,
    toolCatalogPrompt,
    detailsPrompt,
    toolsPrompt,
    rulesPrompt,
    examplesPrompt,
    actionSchema,
    toolDefs,
    argAllowed,
    scores,
    select,
    likely,
    external,
    fallback,
    resolve,
    skillOf,
    toolInfo,
    skillInfo,
    fillerOf,
    speaksOf,
    quickPlan,
    prepare,
    run,
    init,
    add,
    remove,
    replace,
    offer,
    CHAT_TOPIC,
    ids: () => enabled.map((s) => s.id),
  };
}

module.exports = { createSkillRegistry, supports, CHAT_TOPIC };
