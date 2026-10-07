// План от большой модели. Два способа (config.planner):
//   single (по умолчанию) — один промпт: каталог навыков и подробности выбранных по словам фразы.
//   two-step — сначала диспетчер решает, что делать: разговорная реплика или шаги «инструмент +
//     задача словами из фразы» (в промпте — каталог всех инструментов без форматов аргументов). Затем на каждый
//     шаг — новый короткий диалог с узким промптом этого инструмента (fill): он пишет аргумент в нужном формате,
//     видя только нужные навыку данные (имя, город, время). Маленькая модель, узнавшая инструмент, ведёт сразу
//     ко второму шагу (planFocused) — в любом режиме.
//
// После первого ответа модели — «спасательные» шаги, по порядку; первый, вернувший план, побеждает:
//   до озвучки (ответ ещё можно заменить, придержанный отказ не прозвучал):
//     • delegate — модель ответила «не умею», а есть навык-запасной (агент) — переспросить с ним;
//     • cloud    — модель ответила «не умею» / «не знаю», а облако подключено — спросить его;
//   после (разговорный ответ уже звучит — его не трогаем):
//     • loadNamedSkill — модель назвала в topic навык, подробностей которого в запросе не было, — подгрузить;
//     • hintLikelySkill — модель ничего не сделала, хотя слова фразы явно называют навык, — подсказать.
// Новый шаг — функция (plan, turn) → план | null в одном из списков ниже.
const { CHAT_TOPIC } = require('../skills');
const { planSchema, dispatchSchema, parsePlan, parseDispatch, chatPlan } = require('./plan');
const { createSayStreamer, createSayCutter } = require('./say-stream');
const { isRefusal, isUnknown, isCreative } = require('./intent');
const { SESSION_TURNS } = require('./session');

// Ответ, когда большой модели нет: что случилось и как это исправить
const NO_BRAIN =
  'Для этого мне нужна большая языковая модель, сэр. Её можно скачать или подключить внешнюю — в настройках, раздел «Модели». ' +
  'Простые команды я выполняю и без неё.';

function createModelPlanner({ config, llm, skills, prompts, audit, cloud = null }) {
  // Модель отказалась — переспросить с навыком-запасным: просьбу что-то сделать она передаст ему,
  // а на отказ в разговоре («я не могу чувствовать») ответит как раньше
  async function delegate(plan, turn) {
    const { fallback, ids, ask, query } = turn;
    if (!fallback || plan.addressed === false || plan.actions.length || !isRefusal(plan.say)) return null;
    const retry = await ask(
      [...new Set([...ids, fallback])],
      `подсказка: ты ответил, что не можешь. Если это просьба что-то сделать (создать, написать, настроить, оптимизировать, разобраться) — передай её инструментом навыка ${fallback}; если это просто разговор — ответь как обычно`,
    );
    // Засчитываем только передачу: другое действие после «не умею» («сходи в магазин» → напоминание) никто не просил
    const passed = retry.actions.length > 0 && retry.actions.every((a) => skills.skillOf(a.tool) === fallback);
    audit({ skillFallback: fallback, input: query, used: passed });
    return passed ? retry : null;
  }

  // Локальная модель не справилась — спросить облако (с разрешения; туда уходит только эта фраза)
  async function askCloud(plan, turn) {
    if (!cloud?.available() || plan.addressed === false || plan.actions.length) return null;
    if (!isRefusal(plan.say) && !isUnknown(plan.say)) return null;
    const answer = await cloud.ask(turn.query);
    return answer ? chatPlan(answer, { cloud: true }) : null;
  }

  async function loadNamedSkill(plan, turn) {
    const { ids, ask, query } = turn;
    if (plan.topic === CHAT_TOPIC || !skills.ids().includes(plan.topic) || ids.includes(plan.topic)) return null;
    audit({ skillLoaded: plan.topic, input: query });
    return ask([...ids, plan.topic]);
  }

  async function hintLikelySkill(plan, turn) {
    const { ids, ask, query, creative } = turn;
    if (plan.actions.length || creative) return null;
    const likely = plan.topic !== CHAT_TOPIC ? plan.topic : skills.likely(query);
    if (!likely) return null;
    const retry = await ask(
      [...new Set([...ids, likely])],
      `подсказка: похоже, это задача для навыка ${likely} — если он подходит, вызови его инструмент`,
    );
    audit({ skillHint: likely, input: query, used: retry.actions.length > 0 });
    return retry.actions.length ? retry : null;
  }

  const twoStep = () => config.planner === 'two-step';
  const BEFORE_SPEECH = [delegate, askCloud];
  // Диспетчер видит все инструменты — подгружать названный навык ему не нужно
  const afterSpeech = () => (twoStep() ? [hintLikelySkill] : [loadNamedSkill, hintLikelySkill]);
  const planOptions = () => ({ temperature: config.planTemperature ?? 0.1 });

  // Второй шаг: короткий диалог с узким промптом инструмента → { action, say } | null.
  // task — что сделать, словами диспетчера (или сама фраза, если инструмент назвала маленькая модель)
  async function fill({ tool, task }, { query, who, mem }) {
    const info = skills.toolInfo(tool);
    if (!info) return null;
    // Аргумент без вариантов («свернуть всё», «очистка диска») — диалог не нужен
    if (info.tool.argEnum?.length === 1) return { action: { tool, arg: info.tool.argEnum[0] }, say: '' };
    const skillId = info.skill;
    const raw = await llm.chat(
      [
        { role: 'system', content: prompts.focused({ skillId, tool, query, person: who, mem }) },
        { role: 'user', content: task && task !== query ? `Фраза: ${query}\nЗадача: ${task}` : query },
      ],
      planSchema({ topics: [skillId], action: skills.actionSchema([skillId]) }),
      planOptions(),
    );
    const p = parsePlan(raw, skills.names([skillId]), skills.argAllowed);
    const action = p.actions.find((a) => a.tool === tool) || p.actions[0];
    return action ? { action, say: p.say } : null;
  }

  // Маленькая модель узнала инструмент — сразу второй шаг; не вышло — null (дальше полный разбор)
  // Большой модели нет (не скачана, не подключена) — облако, если подключено (с разрешения), иначе честный ответ
  const brainless = () => llm.available?.() === false;
  async function withoutBrain(query) {
    const answer = cloud?.available() ? await cloud.ask(query) : null;
    if (answer) return chatPlan(answer, { cloud: true });
    audit({ brain: 'нет большой модели', input: query });
    return chatPlan(NO_BRAIN);
  }

  async function planFocused({ focus, query, who, mem }) {
    if (brainless()) return null;
    const filled = await fill({ tool: focus.tool, task: query }, { query, who, mem });
    if (!filled) return null;
    return { addressed: true, topic: focus.skill, actions: [filled.action], say: filled.say, focused: true };
  }

  async function firstOf(steps, plan, turn) {
    for (const step of steps) {
      const better = await step(plan, turn);
      if (better) return better;
    }
    return null;
  }

  // content — то, что видит модель (с пометкой [без обращения]); query — сама фраза
  // onSay(предложение) — говорить разговорный ответ по мере того, как модель его пишет
  async function makePlan(content, { query, who, mem, history = [], recent = [], followup = false, onSay }) {
    if (brainless()) return withoutBrain(query);
    const creative = isCreative(query);
    const options = creative ? {} : { temperature: config.planTemperature ?? 0.1 };
    const topics = [CHAT_TOPIC, ...skills.ids()];
    const userContent = (hint) => (hint ? `${content}\n(${hint})` : content);
    const single = async (ids, hint, onText) => {
      const cutter = createSayCutter(skills.speaksOf);
      const raw = await llm.chat(
        [
          { role: 'system', content: prompts.systemPrompt(query, who, mem, ids) },
          ...history.slice(-SESSION_TURNS),
          { role: 'user', content: userContent(hint) },
        ],
        planSchema({ topics, action: skills.actionSchema(ids), addressed: followup }),
        options,
        (text) => (onText?.(text), cutter.onText(text)),
      );
      return parsePlan(cutter.plan() ?? raw, skills.names(ids), skills.argAllowed);
    };
    // Двухшаговый: диспетчер → шаги → узкий диалог на каждый. Ни один шаг не заполнился — один промпт
    // с подробностями названных навыков (так ответ не обещает того, что не будет сделано)
    const allTools = skills.names();
    const dispatched = async (ids, hint, onText) => {
      const cutter = createSayCutter(skills.speaksOf);
      const raw = await llm.chat(
        [
          { role: 'system', content: prompts.dispatch(query, who, mem, ids) },
          ...history.slice(-SESSION_TURNS),
          { role: 'user', content: userContent(hint) },
        ],
        dispatchSchema({ topics, tools: allTools, addressed: followup }),
        options,
        (text) => (onText?.(text), cutter.onText(text)),
      );
      const draft = parseDispatch(cutter.plan() ?? raw, allTools);
      if (!draft.actions.length) return draft;
      const actions = [];
      for (const step of draft.actions) {
        const filled = await fill(step, { query, who, mem });
        if (filled) actions.push(filled.action);
      }
      if (actions.length) return { ...draft, actions };
      audit({ dispatch: 'шаги не заполнились', input: query, steps: draft.actions });
      return single([...new Set([...ids, ...draft.actions.map((a) => skills.skillOf(a.tool))])], hint);
    };
    const ask = (ids, hint, onText) => (twoStep() ? dispatched(ids, hint, onText) : single(ids, hint, onText));

    const ids = skills.select(query, recent);
    // Навык, которому уходят просьбы, от которых модель отказалась («не умею») — агент Claude Code / Codex
    const fallback = skills.fallback?.() || null;
    // Говорить по ходу можно, только если план уже не переспросят: у разговорного ответа (topic chat)
    // повтор бывает лишь с подсказкой навыка по словам фразы — тогда и не начинаем. Отказ придерживаем:
    // его могут заменить передачей задачи, а с облаком — и «не знаю»: ответ может прийти оттуда
    const hold = cloud?.available() ? (s) => isRefusal(s) || isUnknown(s) : fallback ? isRefusal : null;
    const streamer = onSay && (creative || !skills.likely(query)) ? createSayStreamer(onSay, { hold }) : null;
    const turn = { ask, ids, query, fallback, creative };

    const first = await ask(ids, undefined, streamer?.onText);
    const rescued = await firstOf(BEFORE_SPEECH, first, turn);
    if (rescued) return rescued;
    if (streamer?.started()) {
      streamer.finish(first.say);
      return { ...first, streamed: true };
    }
    if (first.addressed === false) return first;
    return (await firstOf(afterSpeech(), first, turn)) || first;
  }

  return { plan: makePlan, planFocused };
}

module.exports = { createModelPlanner, NO_BRAIN };
