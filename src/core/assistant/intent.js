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

module.exports = { guardCloseIntent, isRefusal, isUnknown, isCreative };
