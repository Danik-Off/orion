// Оркестратор: фраза → план (быстрый разбор или модель) → навыки → ответ.
// Не знает ни об одном навыке напрямую — всё берёт из реестра.
//
// Контекст живёт ровно один диалог (маленькая модель путается на длинном): в запрос идут только
// его реплики и несколько подходящих фактов о собеседнике. Диалог заканчивается, когда окно
// закрыло приём продолжения (голос), после 2 минут тишины (переписка), при смене собеседника или по ↺.
// Тогда полезное переносится в базу знаний собеседника, остальное забывается.

const { similarity } = require('./memory');
const { CHAT_TOPIC } = require('./skills');
const { STOP } = require('./llm');

const MAX_ACTIONS = 3;
const SESSION_TURNS = 6; // реплик текущего разговора в запросе
const SESSION_IDLE_MS = 2 * 60 * 1000; // тишина, после которой разговор считается законченным

// Модель обязана ответить ровно этим JSON (грамматика llama.cpp / structured outputs Ollama): работает даже без нативного tool calling.
// Порядок полей — это порядок, в котором модель думает (JSON пишется слева направо):
//   addressed — только для фраз без имени: сначала решить, мне ли это;
//   topic     — навык из каталога или chat: сначала понять тему (дешёвый шаг рассуждения);
//   actions   — потом выбрать действия в рамках темы (arg с перечнем значений ограничен грамматикой);
//   say       — и только потом слова, уже зная, что будет сделано.
function planSchema({ topics, action, addressed = false }) {
  const properties = {};
  if (addressed) properties.addressed = { type: 'boolean' };
  properties.topic = { type: 'string', enum: topics };
  properties.actions = { type: 'array', maxItems: MAX_ACTIONS, items: action };
  properties.say = { type: 'string' };
  return { type: 'object', properties, required: Object.keys(properties) };
}

// allowed(tool, arg) — допустимо ли значение arg (для инструментов с перечнем)
function parsePlan(raw, toolNames, allowed = () => true) {
  let p;
  try {
    p = JSON.parse(raw);
  } catch {
    return { addressed: true, topic: CHAT_TOPIC, say: String(raw).slice(0, 800), actions: [] };
  }
  const actions = (Array.isArray(p.actions) ? p.actions : [])
    .filter((a) => a && toolNames.includes(a.tool))
    .map((a) => ({ tool: a.tool, arg: typeof a.arg === 'string' ? a.arg.trim().slice(0, 300) : '' }))
    .filter((a) => allowed(a.tool, a.arg))
    .slice(0, MAX_ACTIONS);
  return {
    addressed: p.addressed !== false,
    topic: typeof p.topic === 'string' ? p.topic : CHAT_TOPIC,
    say: typeof p.say === 'string' ? p.say.slice(0, 1200) : '',
    actions,
  };
}

// Глагол фразы важнее выбора маленькой модели: «закрой дедлок» не может запускать игру. Модель копирует
// пример «запусти дедлок» и прошлую реплику «Запускаю Deadlock», не замечая глагола, — поправляем план кодом.
const CLOSE_VERB = /(?<!\p{L})(?:закр|выруб|заверш)\p{L}*/iu;
const OPEN_VERB = /(?<!\p{L})(?:откр|запус|включ|вруб)\p{L}*/iu;
const OPENERS = new Set(['open_app', 'steam_launch', 'open_url']);
function guardCloseIntent(plan, text) {
  if (!CLOSE_VERB.test(text) || OPEN_VERB.test(text) || !plan.actions.length) return plan;
  const said = text.match(/(?:закр|выруб|заверш)\p{L}*\s+(?:(?:игру|программу|приложение)\s+)?(.+?)[.!?]*$/iu)?.[1]?.trim() || '';
  let changed = false;
  const actions = plan.actions.map((a) => {
    if (OPENERS.has(a.tool)) {
      changed = true;
      return { tool: 'close_app', arg: a.tool === 'open_url' ? said || a.arg : a.arg || said };
    }
    // игру модель путает с самим Steam: «закрой дедлок» → close_app steam
    if (a.tool === 'close_app' && /^(steam|стим)$/i.test(a.arg) && said && !/стим|steam/i.test(said)) {
      changed = true;
      return { ...a, arg: said };
    }
    return a;
  });
  const closing = actions.find((a) => a.tool === 'close_app');
  // Реплика не должна обещать обратное: «Запускаю Steam», а окно закрывается
  const contradicts = closing && /(?<!\p{L})(запуска|открыва|включа)/iu.test(plan.say);
  if (!changed && !contradicts) return plan;
  return { ...plan, actions, say: closing ? `Закрываю ${closing.arg}, сэр.` : plan.say, guarded: true };
}

// Потоковая речь: модель ещё пишет, а готовые предложения реплики уже можно говорить.
// Только для разговора без действий — когда план уже не изменится: начало JSON должно быть
// {"topic":"chat","actions":[],"say":"… (у фраз без имени перед ним "addressed":true).
// Возвращает onText(накопленный JSON) и finish() — договорить остаток после конца ответа.
// plain — поток обычного текста, а не JSON (ответ навыка: пересказ найденного поиском)
const CHAT_PREFIX = /^\s*\{\s*(?:"addressed"\s*:\s*true\s*,\s*)?"topic"\s*:\s*"chat"\s*,\s*"actions"\s*:\s*\[\s*\]\s*,\s*"say"\s*:\s*"/;
// Точка после инициала или короткого сокращения («А. С. Пушкин», «г. Липецк», «т. е.») — не конец предложения:
// нормализатор речи должен получить сокращение вместе с тем, к чему оно относится
const SENTENCE_END = /(?:(?<!(?:^|[^\p{L}])(?:\p{L}|ул|пр|проф|им|ст|стр|рис|тел|кв|обл|ок|см|рт|напр))\.|[!?…])[.!?…]*["»)]*(?=\s)/gu;
// hold(предложение) → true — придержать это предложение и всё после него до finish() (отказ «не умею»:
// возможно, задачу передадут агенту, и отказ звучать не должен)
function createSayStreamer(onSentence, { plain = false, hold = null } = {}) {
  let prefix = plain ? 0 : null; // длина начала JSON до текста реплики; null — ещё неясно, false — не наш случай
  let sent = 0; // сколько символов реплики уже отдано
  let text = '';
  let closed = false;
  let held = false;
  const emit = (upTo, force = false) => {
    const part = text.slice(sent, upTo).trim();
    if (!force && (held || (hold && part && hold(part)))) return void (held = true);
    sent = upTo;
    if (part) onSentence(part);
  };
  function onText(content) {
    if (prefix === false || closed) return;
    if (plain) {
      text = content;
      let last = 0;
      for (const m of text.matchAll(SENTENCE_END)) last = m.index + m[0].length;
      if (last > sent) emit(last);
      return;
    }
    if (prefix === null) {
      const m = content.match(CHAT_PREFIX);
      if (!m) {
        // Начало JSON уже другое (есть действия, другая тема, «не мне») — ничего не говорим
        const topic = content.match(/"topic"\s*:\s*"([^"]*)"/)?.[1];
        if (content.length > 120 || (topic !== undefined && topic !== 'chat') || /"actions"\s*:\s*\[\s*\{|"addressed"\s*:\s*false/.test(content)) prefix = false;
        return;
      }
      prefix = m[0].length;
    }
    // Текст реплики: до закрывающей кавычки; хвост с недописанной экранировкой (\ или \u12) отбрасываем
    let raw = content.slice(prefix);
    let end = -1;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '\\') i++;
      else if (raw[i] === '"') {
        end = i;
        break;
      }
    }
    if (end >= 0) {
      raw = raw.slice(0, end);
      closed = true;
    } else raw = raw.replace(/\\(u[0-9a-fA-F]{0,3})?$/, '');
    try {
      text = JSON.parse(`"${raw}"`);
    } catch {
      return;
    }
    if (closed) return emit(text.length);
    let last = 0;
    for (const m of text.matchAll(SENTENCE_END)) last = m.index + m[0].length;
    if (last > sent) emit(last);
  }
  // full — реплика из готового плана: договорить остаток, даже если последний кусок потока не дошёл
  const finish = (full) => {
    if (prefix === false || prefix === null || (plain && !sent)) return;
    const done = text.slice(0, sent).trim();
    if (typeof full === 'string' && full.startsWith(done)) (text = full), (sent = done.length);
    emit(text.length, true);
  };
  return { onText, finish, started: () => sent > 0 };
}

// Действия выбраны, и все их инструменты сами дают текст ответа (погода, поиск, курсы…) — реплику модели
// всё равно заменит ответ навыка, поэтому её не дописываем: экономия 15–25 токенов (~0,1–0,15 с) на команде.
// speaks(tool) — отвечает ли инструмент сам. plan() — JSON плана с пустым say, если ответ оборван, иначе null.
const SAY_AFTER_ACTIONS = /\]\s*,\s*"say"\s*:\s*"/;
function createSayCutter(speaks = () => false) {
  let decided = false;
  let cut = null;
  function onText(content) {
    if (decided) return undefined;
    const m = content.match(SAY_AFTER_ACTIONS);
    if (!m) return undefined;
    decided = true;
    const head = content.slice(0, m.index + m[0].length);
    try {
      const plan = JSON.parse(`${head}"}`);
      const actions = Array.isArray(plan.actions) ? plan.actions : [];
      if (!actions.length || !actions.every((a) => speaks(a?.tool))) return undefined;
      cut = `${head}"}`;
      return STOP;
    } catch {
      return undefined;
    }
  }
  return { onText, plan: () => cut };
}

// Модель отказалась сама: «я не умею создавать файлы», «не могу этого сделать», «нет доступа»
const REFUSAL =
  /(?<!\p{L})(?:не (?:умею|могу|способен|в состоянии|имею (?:возможности|доступа)|поддерживаю)|нет (?:возможности|доступа)|вне моих возможностей|мне не под силу|не входит в мои)(?!\p{L})/iu;
const isRefusal = (say) => REFUSAL.test(String(say || '').replace(/ё/g, 'е'));

// Просьбы сочинить — с обычной температурой (иначе анекдоты повторялись бы), остальное — почти без случайности
const CREATIVE = /анекдот|шутк|пошути|сказк|стих|истори|придума|сочини|поздрав|тост|загадк|рассмеши/;

// Без обращения по имени точно к ассистенту: короткое продолжение («а завтра?», «спасибо»),
// а также команда или вопрос («включи…», «открой…», «какая…»). Остальное проверяет модель.
const CONTINUATION = /^(а|и|ещё|еще|тоже|спасибо|благодарю|давай|да|нет|ок|окей|хорошо|отлично|понятно|стоп|хватит|повтори)(\s|$)/;
const DIRECT =
  /^(включи|выключи|открой|закрой|запусти|поставь|найди|покажи|расскажи|скажи|напомни|запомни|забудь|сделай|сверни|переключи|останови|продолжи|какая|какой|какие|какое|сколько|кто|что|где|когда|почему|зачем|как)(\s|$)/;
const looksLikeContinuation = (text) => {
  const t = text.toLowerCase();
  return (CONTINUATION.test(t) && t.split(/\s+/).length <= 6) || DIRECT.test(t);
};

// Голос подтверждён как тот же собеседник — достаточно, чтобы фраза была похожа на обращение:
// «ты / тебя / можешь / скажи…» в любом месте или вопросительное слово в начале («в каком городе ты…»)
const ADDRESSED = /(^|\s)(ты|тебя|тебе|тобой|твой|твоя|твоё|твое|твои|можешь|сможешь|скажи|расскажи|подскажи|покажи|включи|открой|найди|напомни|запомни|давай)(\s|$)/;
const QUESTION = /^(что|где|когда|кто|как|какой|какая|какие|какое|каком|какую|сколько|почему|зачем|куда|откуда)$/;
const PREPOSITION = /^(в|во|на|о|об|про|за|с|со|из|до|к|по|у)$/;
// Обращение к другому человеку в начале фразы — точно не ассистенту
const VOCATIVE = /^(мам|мама|пап|папа|сын|дочь|доча|брат|сестра|дорогая|дорогой|милая|милый|бабушка|дедушка|бабуль|дед)$/;
const talksToOther = (text) => VOCATIVE.test(text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean)[0] || '');
const looksAddressed = (text) => {
  const w = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (VOCATIVE.test(w[0] || '')) return false;
  const question = QUESTION.test(w[0] || '') || (PREPOSITION.test(w[0] || '') && QUESTION.test(w[1] || ''));
  return question || ADDRESSED.test(w.join(' '));
};

// Обращение из профиля голоса: «сэр» → «мисс»; к гостю — без обращения
// (\b в JavaScript не понимает кириллицу — границы слова задаём через \p{L} с флагом u)
function applyHonorific(text, honorific) {
  if (!text || honorific === 'сэр') return text;
  if (!honorific) return text.replace(/,?\s*(?<!\p{L})[Сс]эр(?!\p{L})/gu, '').replace(/\s+([.!?])/g, '$1');
  const title = honorific[0].toUpperCase() + honorific.slice(1);
  return text.replace(/(?<!\p{L})сэр(?!\p{L})/gu, honorific).replace(/(?<!\p{L})Сэр(?!\p{L})/gu, title);
}

// «Как меня зовут», «кто я», «ты меня узнал», «с кем говоришь» — ответ прямо из узнанного голоса.
// Маленькая модель иногда отвечала «не знаю вашего имени», хотя имя было в промпте (см. журнал).
const WHO_AM_I = /^(а\s+)?(как\s+меня\s+зовут|как\s+моё\s+имя|как\s+мое\s+имя|кто\s+я|ты\s+(меня\s+)?(узнал|узнаешь|узнаёшь|знаешь\s+кто\s+я)|с\s+кем\s+ты\s+(сейчас\s+)?(говоришь|разговариваешь))[\s?!.]*$/i;
// Набранный текст голоса не несёт: собеседник там лишь предполагается (последний узнанный голос),
// поэтому «узнал» не говорим.
function whoAmIPlan(text, who, mem, source) {
  if (!WHO_AM_I.test(String(text).trim())) return null;
  const name = who?.name || (who ? mem.profile?.().name : '');
  const say = source === 'text'
    ? 'По тексту я не могу понять, кто пишет, сэр. Скажите что-нибудь голосом — узнаю.'
    : !who
    ? 'Ваш голос я не узнал. Если хотите, запишите его в разделе «Люди».'
    : name
      ? `Вы — ${name}, сэр. Узнал по голосу.`
      : 'Голос узнал, сэр, а имени пока не знаю. Как вас зовут?';
  return { addressed: true, topic: CHAT_TOPIC, say, actions: [] };
}

// «Очисти диалог», «начнём сначала», «новый разговор» — то же, что кнопка ↺: разговор закрывается
// (полезное — в память), окно стирает реплики. Распознаватель пишет и «очистый диалог»; одно слово перед
// командой допускается — так бывает, когда имя услышано неузнаваемо («артём очистый диалог» в журнале).
const RESET_DIALOG =
  /^(?:[а-я]+\s+)?(?:(?:давай\s+)?(?:очист\S*|сбрось|обнули|забудь|удали)\s+(?:весь\s+|этот\s+|наш\s+)?(?:диалог|разговор|контекст|переписку|чат)|(?:давай\s+)?начн[её]м\s+(?:сначала|заново|с\s+чистого\s+листа)|новый\s+(?:разговор|диалог))$/;
const isResetDialog = (text) => RESET_DIALOG.test(String(text).toLowerCase().replace(/ё/g, 'е').replace(/[.,!?]+/g, '').trim());

// onSessionEnd(reason) — разговор закончился: окно стирает его реплики (ассистент — «золотая рыбка»:
// помнит только то, что перенесено в базу знаний)
function createAssistant({ config, llm, skills, memory, audit, notify, onSessionEnd = () => {} }) {
  const name = config.name;
  let session = { personId: undefined, turns: [], recent: [], timer: null };

  // --- промпт: неизменная часть первой (движок кэширует начало промпта), меняющаяся — в конце ---

  function staticPrompt() {
    return `Ты — ${name}, персональный голосовой ИИ-ассистент. Язык — русский. О себе — в мужском роде.
Обращение к собеседнику — строго из поля «обращение» ниже («сэр» или «мисс»); имя — если известно.
Действия — только по просьбе, вопросу или правилу навыка. Человек просто рассказывает о себе или делится мнением — поддержи разговор, actions пустой.

Ответ — ровно один JSON-объект: {"topic": "...", "actions": [{"tool": "...", "arg": "..."}], "say": "..."}.
"topic" — навык из каталога ниже, к которому относится просьба (несколько действий — навык первого), или "chat", если это просто разговор.
"actions" — от 0 до ${MAX_ACTIONS} действий, выполняются по порядку; для разговора — пустой список.
Несколько задач в одной фразе — отдельное действие на каждую, в порядке фразы. Ни одну не пропускай.
Одна задача — одно действие. Без повторов и без действий, о которых не просили.
"say" — текст для озвучки: 1–2 предложения; просят рассказать (анекдот, историю, объяснение) — до 6.
Числа, даты, годы — цифрами. Всегда буква «ё» (ещё, всё, идёт, её).
Запрещено: эмодзи, markdown, скобки, списки. Дата и время — только из строки «Сейчас» ниже.
Только то, в чём уверен. Не знаешь — так и скажи или предложи поискать. Имена, даты, события не выдумывай.
Фраза без смысла (обрывок распознавания, одно непонятное слово) — переспроси: «Не расслышал, сэр. Повторите?». Смысл не угадывай.
Разговор, шутки, анекдоты, истории, советы, объяснения — без инструментов.

Пометка [без обращения] — фраза услышана без твоего имени сразу после твоего ответа. Тогда первое поле — "addressed".
По умолчанию addressed=true: это продолжение разговора с тобой. addressed=false — ТОЛЬКО если фраза явно не тебе:
люди говорят между собой, обращаются друг к другу, телевизор, бессвязный набор слов. Тогда say и actions пустые.

Твои навыки (каталог: id и что умеет):
${skills.catalogPrompt()}
Инструменты нужных этой фразе навыков — в конце, в разделе «Инструменты для этой фразы». Вызывай только их.
Просьба или вопрос подходит под инструмент или правило навыка — вызови инструмент. По памяти не отвечай: числа, даты, отчёты, новости, свежие факты не выдумывай.
Навык есть в каталоге, но его инструментов в том разделе нет — назови его в topic, я подгружу его и спрошу снова.
Навыка нет и в каталоге — topic "chat", честно скажи, что пока так не умеешь.

Примеры (навык: действия + ответ):
"как дела" → chat: ответ «Все системы в норме, сэр.»
"который час и какое число" → chat: ответ «Сейчас 14:05, 3 марта, вторник.»
"я сегодня так устал" → chat: ответ «Сочувствую, сэр. Может, включить что-нибудь спокойное?» — рассказ о себе, а не команда
"закипёж" → chat: ответ «Не расслышал, сэр. Повторите?» — обрывок распознавания без смысла: не угадывай и не выдумывай, что имелось в виду
"открой телеграм и включи музыку" → apps: open_app("телеграм") + youtube("музыка микс") + ответ «Открываю Telegram и включаю музыку, сэр.» — две задачи, два действия
"какая погода и почём доллар" → weather: weather("") + rate("USD") + ответ «Сейчас посмотрю, сэр.» — две задачи, два действия
[без обращения] "а что ты вообще умеешь?" → addressed=true, chat: ответ «Погода, музыка, программы, поиск, напоминания и многое другое, сэр.»
[без обращения] "ну я ему и говорю, а он молчит" → addressed=false: без действий и без ответа
[без обращения] "пап, ты ключи от машины не видел" → addressed=false: без действий и без ответа`;
  }

  function contextPrompt(query, person, mem, skillIds) {
    const who = person?.id
      ? `Собеседник: ${person.name || 'владелец голоса (имя пока неизвестно — можно спросить)'}; обращение: ${person.honorific || 'сэр'}.`
      : 'Собеседник: гость — голос не узнан, обращение: без обращения. Личное о нём не запоминай.';
    const facts = mem.factsText(query);
    const place = memory.shared.profile().city;
    const common = memory.shared.factsText(query).replace(/^#/gm, '#о'); // общие факты — с префиксом «о»
    return `Сейчас: ${new Date().toLocaleString('ru-RU', { dateStyle: 'full', timeStyle: 'short' })}.
${who}
Профиль собеседника: ${mem.profileText() || '(пусто)'}
Что ты знаешь о собеседнике (номер и факт):
${facts || '(пока ничего)'}
Общая память (не о конкретном человеке): ${place ? `ты находишься в городе ${place}.` : 'где ты находишься — неизвестно.'}
${common || '(общих фактов пока нет)'}

Инструменты для этой фразы:
${skills.detailsPrompt(skillIds) || '(не нужны — просто ответь)'}`;
  }

  const systemPrompt = (query, person, mem, skillIds) => `${staticPrompt()}\n\n${contextPrompt(query, person, mem, skillIds)}`;

  // --- сессия разговора ---

  function touchSession() {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => endSession('тишина'), SESSION_IDLE_MS);
  }

  // Конец разговора: факты о собеседнике — в его базу знаний, общие — в общую; реплики забываем.
  // С гостем (голос не узнан) сохраняется только общее.
  async function endSession(reason) {
    clearTimeout(session.timer);
    const { personId, turns } = session;
    session = { personId: undefined, turns: [], recent: [], timer: null };
    onSessionEnd(reason);
    if (turns.length < 2) return;
    const mem = memory.forPerson(personId);
    try {
      const facts = await extractFacts(turns, mem);
      const saved = [];
      for (const f of facts) {
        const text = String(f.text || '').trim();
        // Защита от ошибок маленькой модели: итог только ДОБАВЛЯЕТ факты (удаляет — лишь явное «забудь»),
        // обрывки и имя не записываются, повтор уже известного не плодится (remember сам заменит похожий)
        if (text.length < 8 || text.split(/\s+/).length < 2 || /^(имя|зовут|пользователя зовут)/i.test(text)) continue;
        const target = f.scope === 'shared' ? memory.shared : mem;
        if (!target.writable) continue;
        const known = `${target.allFactsText()} ${target.profileText()}`;
        if (similarity(known, text) >= 0.65) continue; // уже известно другими словами
        // Замена старого факта — только если он на ту же тему («Живёт в Москве» → «Живёт в Казани»)
        const replaced = f.replaces && factText(target, f.replaces);
        const sameTopic = replaced && similarity(replaced, text) >= 0.3;
        const ttl = f.days > 0 && f.days <= 60 ? `|${f.days}` : ''; // срок — только для ближайших планов
        target.remember(`${sameTopic ? `#${f.replaces} ` : ''}${text}${ttl}`);
        saved.push({ scope: f.scope, text, replaced: sameTopic ? replaced : undefined });
      }
      audit({ memory: 'итог разговора', reason, person: personId, saved });
    } catch (err) {
      audit({ memory: 'итог не удался', error: String(err?.message || err) });
    }
  }

  const factText = (mem, id) => mem.allFactsText().match(new RegExp(`^#${Number(id)} (.+?)(?: \\(до .+\\))?$`, 'm'))?.[1];

  const FACTS_SCHEMA = {
    type: 'object',
    properties: {
      facts: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['person', 'shared'] },
            text: { type: 'string' },
            replaces: { type: 'integer' }, // номер устаревшего факта на ту же тему
            days: { type: 'integer' }, // для планов: сколько дней помнить
          },
          required: ['scope', 'text'],
        },
      },
    },
    required: ['facts'],
  };

  async function extractFacts(turns, mem) {
    const dialog = turns
      .filter((t) => t.role === 'user') // факты берём из слов человека, а не из ответов ассистента
      .map((t) => `— ${t.content}`)
      .join('\n');
    const raw = await llm.chat(
      [
        {
          role: 'system',
          content:
            'Ты — модуль долгой памяти голосового ассистента. Перед тобой реплики человека из одного разговора. ' +
            'Выпиши НОВЫЕ устойчивые факты, которые стоит помнить неделями:\n' +
            '• scope=person — о самом человеке: где живёт, семья и близкие, работа, увлечения, вкусы, привычки, планы с датами;\n' +
            '• scope=shared — не о конкретном человеке: где находится ассистент, дом, питомцы, соседи, общие договорённости.\n' +
            'Не записывай: имя, просьбы и команды («включи…», «какая погода»), вопросы, шутки, эмоции, то, что уже известно.\n' +
            'Каждый факт — короткое полное утверждение от третьего лица. Если факт обновляет известный на ту же тему — укажи replaces.\n' +
            'Планы на дату — с days. Ничего подходящего — пустой список.\n\n' +
            'Примеры:\n' +
            '«я работаю дизайнером, включи музыку» → [{"scope":"person","text":"Работает дизайнером"}]\n' +
            '«завтра с женой едем на дачу, кота кормит соседка Лена» → [{"scope":"person","text":"Женат","days":0},' +
            '{"scope":"person","text":"Завтра едет с женой на дачу","days":2},{"scope":"shared","text":"Кота кормит соседка Лена"}]\n' +
            '«какая погода», «спасибо», «расскажи анекдот» → []\n' +
            '«я переехал в Казань» при известном «#2 Живёт в Москве» → [{"scope":"person","text":"Живёт в Казани","replaces":2}]\n\n' +
            `Уже известно о человеке:\n${[mem.profileText(), mem.allFactsText()].filter(Boolean).join('\n') || '(ничего)'}\n` +
            `Уже известно общее:\n${[memory.shared.profileText(), memory.shared.allFactsText()].filter(Boolean).join('\n') || '(ничего)'}`,
        },
        { role: 'user', content: dialog },
      ],
      FACTS_SCHEMA,
      { temperature: config.planTemperature ?? 0.1 }, // факты — не творчество
    );
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.facts) ? parsed.facts.slice(0, 5) : [];
  }

  // --- обработка фразы ---

  // source: 'wake' — с ключевым словом, 'hotkey' — после клавиши или клика, 'followup' — продолжение без имени, 'text' — набрано
  // person: { id, name, honorific } — собеседник (узнан по голосу или владелец при наборе текста); null — гость
  // signal — отмена (фразу дополнили или перебили): до начала действий запрос просто бросается
  // onSay(предложение) — готовые предложения разговорного ответа, пока модель ещё пишет (озвучка начинается раньше)
  // beforeActions() — дождаться, пока человек договорит (голос); onFiller(текст) — сказать сразу, пока работает медленный навык
  async function handle(text, { source = 'text', person = null, signal, onSay, beforeActions, onFiller } = {}) {
    const who = person?.id ? person : null;
    const personId = who?.id ?? null;
    const mem = memory.forPerson(personId);
    const honorific = personId ? who?.honorific || 'сэр' : '';
    // Ответ — в том виде, как его написали (цифрами): окно показывает его так, а для речи его готовит синтез (main.js)
  const sayPart = onSay && ((s) => !signal?.aborted && onSay(applyHonorific(s, honorific)));

    // Продолжение без имени проверяет модель («это мне?»), кроме очевидных случаев.
    // Голос подтверждён как тот же собеседник — верим ему; спрашиваем модель, только если фраза
    // начинается с обращения к другому человеку («мам, …»). По журналу модель отсекала именно свои фразы.
    const followup =
      source === 'followup' ? !looksLikeContinuation(text) : source === 'followup-voice' ? talksToOther(text) : false;
    // «Очисти диалог» — сразу, без модели; сама фраза в новый разговор не попадает
    if (isResetDialog(text)) {
      await endSession('новый разговор');
      audit({ input: text, source, person: personId, reset: true });
      return { say: applyHonorific('Начнём с чистого листа, сэр.', honorific), actions: [] };
    }
    let plan = skills.quickPlan(text) || whoAmIPlan(text, who, mem, source);
    if (!plan) plan = await makePlan(followup ? `[без обращения] ${text}` : text, { query: text, who, mem, history: session.turns, followup, onSay: sayPart });
    plan = guardCloseIntent(plan, text);
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

    // Другой голос обратился к Ориону — только теперь прошлый разговор закрывается и переносится в память.
    // Чужая реплика в комнате (выше — ignored) разговор не обрывает.
    if (session.turns.length && personId !== session.personId) await endSession('смена собеседника');
    session.personId = personId;

    if (plan.actions.length && plan.say) notify(applyHonorific(plan.say, honorific));
    // Медленный навык (поиск, состояние ПК) — сразу сказать короткое «Сейчас поищу», пока он работает
    const filler = plan.actions.length === 1 && skills.fillerOf?.(plan.actions[0].tool);
    if (filler && onFiller && !signal?.aborted) onFiller(applyHonorific(filler, honorific));

    // Единственный навык может говорить ответ по мере готовности (поиск: модель пересказывает найденное)
    const skillStream = plan.actions.length === 1 && sayPart ? createSayStreamer(sayPart, { plain: true }) : null;
    const request = { text, person: who || null, memory: mem, onText: skillStream?.onText };
    const { spoken, problems, sources, noFollowUp } = await runActions(plan.actions, request);
    // Ответ навыка уже звучит по предложениям — договорить остаток; ошибка — окно скажет всё заново
    const skillStreamed = !!skillStream?.started() && spoken.length === 1 && !problems.length && !signal?.aborted;
    if (skillStreamed) skillStream.finish(spoken[0]);
    // Настоящие данные и сообщения навыков важнее заготовленной фразы
    const say = applyHonorific(spoken.length || problems.length ? [...spoken, ...problems].join(' ') : plan.say, honorific);

    // Навыки этой реплики остаются «под рукой» на пару следующих («а завтра?» после погоды)
    const used = plan.actions.map((a) => skills.skillOf(a.tool)).filter(Boolean);
    session.recent = [...new Set([...used, ...session.recent])].slice(0, 3);
    // В историю — ответ в том же виде, в каком его пишет модель: с темой и действиями (чтобы «закрой его»
    // знало, что было открыто) и с цифрами, а не словами (иначе модель начинает подражать озвучке)
    const topic = used[0] || (plan.topic && plan.topic !== CHAT_TOPIC ? plan.topic : CHAT_TOPIC);
    session.turns.push(
      { role: 'user', content: text },
      { role: 'assistant', content: JSON.stringify({ topic, actions: plan.actions, say }) },
    );
    session.turns = session.turns.slice(-SESSION_TURNS * 2);
    touchSession();
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

  // План от модели. В запрос идут подробности только навыков, выбранных для этой фразы. Повтор — не больше одного:
  //  • модель назвала в topic навык, подробностей которого в запросе не было, — подгружаем его;
  //  • модель ничего не сделала, хотя слова фразы явно называют навык («сколько дней до…»), — подсказываем.
  // onSay(предложение) — говорить разговорный ответ по мере того, как модель его пишет
  async function makePlan(content, { query, who, mem, history = [], followup = false, onSay }) {
    const all = skills.ids();
    const creative = CREATIVE.test(query.toLowerCase());
    const options = creative ? {} : { temperature: config.planTemperature ?? 0.1 };
    const ask = async (ids, hint, onText) => {
      const names = skills.names(ids);
      const cutter = createSayCutter(skills.speaksOf);
      const raw = await llm.chat(
        [
          { role: 'system', content: systemPrompt(query, who, mem, ids) },
          ...history.slice(-SESSION_TURNS),
          { role: 'user', content: hint ? `${content}\n(${hint})` : content },
        ],
        planSchema({ topics: [CHAT_TOPIC, ...all], action: skills.actionSchema(ids), addressed: followup }),
        options,
        (text) => (onText?.(text), cutter.onText(text)),
      );
      return parsePlan(cutter.plan() ?? raw, names, skills.argAllowed);
    };

    const ids = skills.select(query, session.recent);
    // Навык, которому уходят просьбы, от которых модель отказалась («не умею») — агент Claude Code / Codex
    const fallback = skills.fallback?.() || null;
    // Говорить по ходу можно, только если план уже не переспросят: у разговорного ответа (topic chat)
    // повтор бывает лишь с подсказкой навыка по словам фразы — тогда и не начинаем. Отказ придерживаем:
    // его могут заменить передачей задачи
    const streamer = onSay && (creative || !skills.likely(query)) ? createSayStreamer(onSay, { hold: fallback ? isRefusal : null }) : null;
    const plan = await ask(ids, undefined, streamer?.onText);
    // Модель ответила «не умею» — переспросить с навыком-запасным: просьбу что-то сделать она передаст ему,
    // а на отказ в разговоре («я не могу чувствовать») ответит как раньше
    if (fallback && plan.addressed !== false && !plan.actions.length && isRefusal(plan.say)) {
      const retry = await ask(
        [...new Set([...ids, fallback])],
        `подсказка: ты ответил, что не можешь. Если это просьба что-то сделать (создать, написать, настроить, оптимизировать, разобраться) — передай её инструментом навыка ${fallback}; если это просто разговор — ответь как обычно`,
      );
      // Засчитываем только передачу: другое действие после «не умею» («сходи в магазин» → напоминание) никто не просил
      const passed = retry.actions.length > 0 && retry.actions.every((a) => skills.skillOf(a.tool) === fallback);
      audit({ skillFallback: fallback, input: query, used: passed });
      if (passed) return retry;
    }
    if (streamer?.started()) {
      streamer.finish(plan.say);
      return { ...plan, streamed: true };
    }
    if (plan.addressed === false) return plan;
    if (plan.topic !== CHAT_TOPIC && all.includes(plan.topic) && !ids.includes(plan.topic)) {
      audit({ skillLoaded: plan.topic, input: query });
      return ask([...ids, plan.topic]);
    }
    const likely = plan.actions.length || creative ? null : plan.topic !== CHAT_TOPIC ? plan.topic : skills.likely(query);
    if (likely) {
      const retry = await ask([...new Set([...ids, likely])], `подсказка: похоже, это задача для навыка ${likely} — если он подходит, вызови его инструмент`);
      audit({ skillHint: likely, input: query, used: retry.actions.length > 0 });
      if (retry.actions.length) return retry;
    }
    return plan;
  }

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

  // Выполнить фразу как команду без разговора — шаги сценариев («утро» → «какая погода», «включи джаз»).
  // Возвращает то, что стоит сказать. Сценарий внутри сценария — не глубже двух уровней.
  async function perform(text, request = {}) {
    const depth = (request.performDepth || 0) + 1;
    if (depth > 2) return 'Сценарий слишком глубоко вложен.';
    const mem = request.memory || memory.guest;
    const plan = guardCloseIntent(skills.quickPlan(text) || (await makePlan(text, { query: text, who: request.person || null, mem })), text);
    audit({ perform: text, plan });
    const { spoken, problems } = await runActions(plan.actions, { ...request, text, memory: mem, performDepth: depth });
    return [...spoken, ...problems].join(' ') || (plan.actions.length ? '' : plan.say);
  }

  // Прогрев: модель обрабатывает неизменную часть промпта заранее, первый ответ приходит быстро.
  function warmup() {
    return llm
      .chat(
        [{ role: 'system', content: systemPrompt('', null, memory.guest, []) }, { role: 'user', content: 'привет' }],
        planSchema({ topics: [CHAT_TOPIC, ...skills.ids()], action: skills.actionSchema([]) }),
      )
      .catch(() => {});
  }

  return { handle, perform, warmup, endSession, reset: () => endSession('новый разговор') };
}

module.exports = { createAssistant, createSayStreamer, isRefusal, parsePlan, planSchema, guardCloseIntent, looksLikeContinuation, looksAddressed, talksToOther, applyHonorific, MAX_ACTIONS };
