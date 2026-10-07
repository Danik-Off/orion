// Оркестратор: фраза → план → навыки → ответ. Не знает ни об одном навыке напрямую — всё берёт из реестра.
//
// План ищется цепочкой ступеней — от дешёвой к дорогой; первая, вернувшая план, побеждает:
//   quick    — быстрый разбор навыков, без модели («пауза», «громче», «который час»);
//   whoAmI   — «как меня зовут», «кто я» — прямо из узнанного голоса;
//   router   — маленькая модель вызова функций (core/router.js), если подключена: готовый вызов
//              или только имя инструмента (turn.focus);
//   focused  — инструмент назван — аргумент пишет большая модель по узкому промпту этого инструмента;
//   model    — большая модель (model-planner.js): диспетчер + узкий диалог на каждый шаг, переспросы и облако;
//              отвечает всегда.
// Своя ступень — объект { name, plan(turn) → план | null } в списке stages (опция createAssistant).
//
// Модули: plan.js (схема плана), prompts.js (промпт), session.js (разговор и память), say-stream.js (речь
// по ходу ответа), intent.js (проверки смысла), addressing.js (кому фраза и как обращаться).
const { CHAT_TOPIC } = require('../skills');
const { planSchema, parsePlan, chatPlan, MAX_ACTIONS } = require('./plan');
const { createPrompts } = require('./prompts');
const { createSession } = require('./session');
const { createModelPlanner } = require('./model-planner');
const { createSayStreamer } = require('./say-stream');
const { guardCloseIntent, isRefusal, isUnknown } = require('./intent');
const addressing = require('./addressing');

const { applyHonorific, needsAddressCheck, whoAmIPlan, isResetDialog } = addressing;

// Стандартные ступени. turn: { text, content, source, followup, who, mem, history, recent, onSay }
function defaultStages({ skills, router, modelPlanner }) {
  return [
    { name: 'quick', plan: ({ text }) => skills.quickPlan(text) },
    { name: 'whoAmI', plan: ({ text, who, mem, source }) => whoAmIPlan(text, who, mem, source) },
    router && {
      name: 'router',
      // Готовый план — сразу; узнан только инструмент — запомнить для следующей ступени
      plan: async (turn) => {
        const r = await router.route(turn.text, { followup: turn.source.startsWith('followup') });
        if (r?.focus) turn.focus = r.focus;
        return r?.plan || null;
      },
    },
    // Инструмент назван маленькой моделью — аргумент пишет большая по узкому промпту этого инструмента
    { name: 'focused', plan: (turn) => (turn.focus ? modelPlanner.planFocused(turn) : null) },
    {
      name: 'model',
      plan: async (turn) => {
        const plan = await modelPlanner.plan(turn.content, turn);
        // Пример для дообучения маленькой модели (продолжения и шаги сценариев ей не достаются, облачные ответы — не её)
        if (!turn.source.startsWith('followup') && turn.source !== 'perform' && !plan.cloud) router?.record(turn.text, plan);
        return plan;
      },
    },
  ].filter(Boolean);
}

async function runStages(stages, turn) {
  for (const stage of stages) {
    const plan = await stage.plan(turn);
    if (plan) return { ...plan, stage: plan.stage || stage.name };
  }
  return chatPlan('');
}

// router — первая ступень (маленькая модель вызова функций, core/router.js); cloud — последняя (core/cloud.js)
// onSessionEnd(reason) — разговор закончился: окно стирает его реплики
// stages(defaults) → свой список ступеней (по умолчанию — стандартный)
function createAssistant({
  config,
  llm,
  skills,
  memory,
  audit,
  notify,
  onSessionEnd = () => {},
  router = null,
  cloud = null,
  stages = null,
}) {
  const prompts = createPrompts({ name: config.name, skills, memory });
  const session = createSession({ config, llm, memory, audit, onEnd: onSessionEnd });
  const modelPlanner = createModelPlanner({ config, llm, skills, prompts, audit, cloud });
  const standard = defaultStages({ skills, router, modelPlanner });
  const chain = typeof stages === 'function' ? stages(standard) : standard;
  // Сценарии выполняют фразы как команды: без вопросов о собеседнике и без маленькой модели (ей не видна цель сценария)
  const commandChain = standard.filter((s) => s.name === 'quick' || s.name === 'model');

  async function runActions(actions, request) {
    const spoken = [];
    const problems = [];
    let sources;
    let noFollowUp = false; // после включения видео не слушаем продолжение — услышим сам ролик
    for (const { tool, arg } of actions) {
      const result = await skills.run(tool, arg, request);
      if (result.speak) spoken.push(result.speak);
      else if (result.message) problems.push(result.message);
      if (result.sources?.length) sources = result.sources;
      if (result.silentAfter) noFollowUp = true;
    }
    return { spoken, problems, sources, noFollowUp };
  }

  // source: 'wake' — с ключевым словом, 'hotkey' — после клавиши или клика, 'followup' — продолжение без имени,
  //   'followup-voice' — продолжение, голос подтверждён, 'text' — набрано
  // person: { id, name, honorific } — собеседник (узнан по голосу или владелец при наборе текста); null — гость
  // signal — отмена (фразу дополнили или перебили): до начала действий запрос просто бросается
  // onSay(предложение) — готовые предложения разговорного ответа, пока модель ещё пишет (озвучка начинается раньше)
  // beforeActions() — дождаться, пока человек договорит (голос); onFiller(текст) — сказать сразу, пока работает медленный навык
  async function handle(text, { source = 'text', person = null, signal, onSay, beforeActions, onFiller } = {}) {
    const who = person?.id ? person : null;
    const personId = who?.id ?? null;
    const mem = memory.forPerson(personId);
    const honorific = personId ? who?.honorific || 'сэр' : '';
    const address = (s) => applyHonorific(s, honorific);
    // Ответ — в том виде, как его написали (цифрами): окно показывает его так, а для речи его готовит синтез (app/voice.js)
    const sayPart = onSay && ((s) => !signal?.aborted && onSay(address(s)));
    const followup = needsAddressCheck(text, source);

    // «Очисти диалог» — сразу, без модели; сама фраза в новый разговор не попадает
    if (isResetDialog(text)) {
      await session.end('новый разговор');
      audit({ input: text, source, person: personId, reset: true });
      return { say: address('Начнём с чистого листа, сэр.'), actions: [] };
    }

    const turn = {
      text,
      content: followup ? `[без обращения] ${text}` : text,
      query: text,
      source,
      followup,
      who,
      mem,
      history: session.history(),
      recent: session.recent(),
      onSay: sayPart,
    };
    const plan = guardCloseIntent(await runStages(chain, turn), text);
    audit({ input: text, source, person: personId, plan });
    // Человек договаривает или перебил новой командой — этот план уже не нужен, действия не выполняем
    if (signal?.aborted) return { cancelled: true };
    // Фоновый разговор, услышанный без обращения, — молча игнорируем; текущий разговор при этом не трогаем
    if (followup && plan.addressed === false) return { ignored: true };

    // Человек договаривает фразу после паузы — действия ждут: договорённое заменит этот запрос (signal),
    // и действия по обрывку («напомни… через десять» → напоминание на завтра) не выполнятся
    if (plan.actions.length && beforeActions) {
      await beforeActions();
      if (signal?.aborted) return { cancelled: true };
    }
    // Чужая реплика в комнате (выше — ignored) разговор не обрывает; другой голос, обратившийся к ассистенту, — закрывает
    await session.switchTo(personId);

    if (plan.actions.length && plan.say) notify(address(plan.say));
    // Медленный навык (поиск, состояние ПК) — сразу сказать короткое «Сейчас поищу», пока он работает
    const filler = plan.actions.length === 1 && skills.fillerOf?.(plan.actions[0].tool);
    if (filler && onFiller && !signal?.aborted) onFiller(address(filler));

    // Единственный навык может говорить ответ по мере готовности (поиск: модель пересказывает найденное)
    const skillStream = plan.actions.length === 1 && sayPart ? createSayStreamer(sayPart, { plain: true }) : null;
    const request = { text, person: who || null, memory: mem, onText: skillStream?.onText };
    const { spoken, problems, sources, noFollowUp } = await runActions(plan.actions, request);
    // Ответ навыка уже звучит по предложениям — договорить остаток; ошибка — окно скажет всё заново
    const skillStreamed = !!skillStream?.started() && spoken.length === 1 && !problems.length && !signal?.aborted;
    if (skillStreamed) skillStream.finish(spoken[0]);
    // Настоящие данные и сообщения навыков важнее заготовленной фразы
    const say = address(spoken.length || problems.length ? [...spoken, ...problems].join(' ') : plan.say);

    const used = plan.actions.map((a) => skills.skillOf(a.tool)).filter(Boolean);
    const topic = used[0] || (plan.topic && plan.topic !== CHAT_TOPIC ? plan.topic : CHAT_TOPIC);
    session.add({ text, topic, actions: plan.actions, say, used });
    // streamed — ответ уже звучит по предложениям, окну не нужно озвучивать его заново
    return {
      say,
      actions: plan.actions,
      sources,
      noFollowUp,
      silent: !!plan.silent && !problems.length,
      streamed: (!!plan.streamed && !plan.actions.length) || skillStreamed,
    };
  }

  // Выполнить фразу как команду без разговора — шаги сценариев («утро» → «какая погода», «включи джаз»).
  // Возвращает то, что стоит сказать. Сценарий внутри сценария — не глубже двух уровней.
  async function perform(text, request = {}) {
    const depth = (request.performDepth || 0) + 1;
    if (depth > 2) return 'Сценарий слишком глубоко вложен.';
    const mem = request.memory || memory.guest;
    const turn = { text, content: text, query: text, source: 'perform', who: request.person || null, mem, recent: session.recent() };
    const plan = guardCloseIntent(await runStages(commandChain, turn), text);
    audit({ perform: text, plan });
    const { spoken, problems } = await runActions(plan.actions, { ...request, text, memory: mem, performDepth: depth });
    return [...spoken, ...problems].join(' ') || (plan.actions.length ? '' : plan.say);
  }

  // Прогрев: модель обрабатывает неизменную часть промпта заранее, первый ответ приходит быстро.
  function warmup() {
    router?.warmup();
    if (llm.available?.() === false) return Promise.resolve(); // большой модели нет — греть нечего
    return llm
      .chat(
        [
          { role: 'system', content: prompts.systemPrompt('', null, memory.guest, []) },
          { role: 'user', content: 'привет' },
        ],
        planSchema({ topics: [CHAT_TOPIC, ...skills.ids()], action: skills.actionSchema([]) }),
      )
      .catch(() => {});
  }

  const endSession = (reason) => session.end(reason);
  return { handle, perform, warmup, endSession, reset: () => endSession('новый разговор') };
}

module.exports = {
  createAssistant,
  createSayStreamer,
  isRefusal,
  isUnknown,
  parsePlan,
  planSchema,
  guardCloseIntent,
  MAX_ACTIONS,
  ...addressing,
};
