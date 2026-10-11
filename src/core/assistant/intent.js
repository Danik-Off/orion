// Смысл фразы и ответа, который код проверяет сам, не доверяя маленькой модели.

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

// «Найди/покажи вчерашний скриншот» — это поиск файла: новый снимок экрана сделал бы не то (случай из замера)
// Поисковый глагол должен относиться к самому скриншоту («найди вчерашний скриншот»), а «сделай скриншот и
// открой загрузки» — это новый снимок и папка
const FIND_SHOT = /(?<!\p{L})(?:найди|найти|где|покажи|открой)\s+(?:\p{L}+\s+){0,2}(?:скрин|снимок экрана)/iu;
const MAKE_SHOT = /(?<!\p{L})(?:сделай|сними|заскринь|сфоткай|скриншотни)(?!\p{L})/iu;
function guardFindScreenshot(plan, text) {
  if (!FIND_SHOT.test(text) || MAKE_SHOT.test(text) || !plan.actions.some((a) => a.tool === 'screenshot')) return plan;
  const when = String(text).match(/вчера|сегодня|на неделе|последн/i)?.[0] || '';
  const actions = plan.actions.map((a) => (a.tool === 'screenshot' ? { tool: 'recent_files', arg: `скриншоты ${when}`.trim() } : a));
  return { ...plan, actions, say: '', guarded: true };
}

const plain = (say) => String(say || '').replace(/ё/g, 'е');

// Модель отказалась сама: «я не умею создавать файлы», «не могу этого сделать», «нет доступа»
const REFUSAL =
  /(?<!\p{L})(?:не (?:умею|могу|способен|в состоянии|имею (?:возможности|доступа)|поддерживаю)|нет (?:возможности|доступа)|вне моих возможностей|мне не под силу|не входит в мои)(?!\p{L})/iu;
const isRefusal = (say) => REFUSAL.test(plain(say));

// Модель не знает ответа: «не знаю», «у меня нет данных» — повод спросить облако (если оно подключено)
const UNKNOWN = /(?<!\p{L})(?:не знаю|не уверен|нет (?:данных|сведений|информации)|не располагаю|затрудняюсь)(?!\p{L})/iu;
const isUnknown = (say) => UNKNOWN.test(plain(say));

// Просьбы сочинить — с обычной температурой (иначе анекдоты повторялись бы), остальное — почти без случайности
const CREATIVE = /анекдот|шутк|пошути|сказк|стих|истори|придума|сочини|поздрав|тост|загадк|рассмеши/;
const isCreative = (text) => CREATIVE.test(String(text).toLowerCase());

// Передумал на полуслове: «выключи компьютер… нет», «поставь будильник, а хотя не надо». Команда с отказом
// в конце не выполняется. «…или нет» — вопрос, а не отказ; одно «нет» — ответ на вопрос, его разбирают другие.
const RETRACT =
  /(?:^|[\s,.!])(?:нет|не надо|не нужно|не стоит|отмена|отмени|отбой|забудь|неважно|передумал|передумала|ладно не надо)[.!]*$/u;
const COMMAND_VERB =
  /^(?:вк?ыключ|включ|откр|закр|постав|запуст|напомн|сдела|перезагр|перезапуст|удал|отправ|позвон|напиш|найд|скаж|расскаж|покаж|убав|прибав|разбуд|завед|запиш|сохран|перевед|созда|скача|купи|заказ|убер|отмен|останов|верн|сбрось|очист|переимен|перемест|скопир|отключ|подключ|измен|повтор|прочит|продолж|заблок|усыпи|выруб|вруб|сыгра|поставь|засеки|добав)\p{L}*$/u;
function isRetraction(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .trim();
  if (!RETRACT.test(t) || /(?:^|\s)или (?:нет|не надо)[.!?]*$/.test(t)) return false;
  // Перед отказом — хоть какая-то просьба: иначе это просто «нет» или «не надо» на вопрос
  const before = t
    .replace(RETRACT, '')
    .replace(/[\s,.!]+$/, '')
    .replace(/(?:^|\s)(?:а|ой|хотя|ну|нет|ладно)$/, '')
    .replace(/^(?:а|ну|ой)\s+/, '')
    .trim();
  if (!before || /^(?:почему|зачем|как|что|кто|разве|правда|может|ли)(?:\s|$)/.test(before)) return false;
  // Отказываются от команды: перед «нет» должен быть глагол-просьба. «Радио больше не надо» — это и есть
  // просьба (выключить радио), её разбирают навыки
  return before.split(/\s+/).some((w) => COMMAND_VERB.test(w));
}

// «Повтори», «что ты сказал», «ещё раз скажи» — повторить последний ответ (не расслышали из-за шума)
const REPEAT =
  /^(?:а |ну |орион )?(?:повтори(?:те)?(?: (?:еще раз|пожалуйста|последнее|что сказал|ответ))?|что ты (?:сказал|сказала|говорил|говорила)|еще раз(?: скажи| повтори)?|скажи еще раз|не (?:расслышал|расслышала|услышал|услышала)(?: повтори)?|прости не расслышал(?:а)?)[?!.]*$/;
const isRepeat = (text) =>
  REPEAT.test(
    String(text || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[,;:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );

// Модель сама не поняла фразу: «Не расслышал, сэр. Повторите?», «не понял смысла», «фраза кажется обрывком»
const NOT_HEARD = /не расслышал|не понял(?:а)?(?: смысла| вас|,|\.|$)|не понимаю(?:,)? о ч|обрывк|повторите/i;
const isNotHeard = (say) => NOT_HEARD.test(plain(say));
// Похоже на разговор в комнате, а не на просьбу: длинная фраза, которую модель не поняла.
// Короткую («зовут», «давай») после имени переспросить уместно; длинную — значит, говорили не с нами
const looksLikeChatter = (text, plan) => !plan.actions.length && isNotHeard(plan.say) && String(text).trim().split(/\s+/).length >= 4;

module.exports = {
  guardCloseIntent,
  guardFindScreenshot,
  isRefusal,
  isUnknown,
  isCreative,
  isRetraction,
  isRepeat,
  isNotHeard,
  looksLikeChatter,
};
