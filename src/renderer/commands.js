// Голосовые команды самому Ориону, которые окно решает без модели. Чистые функции — проверяются тестами в Node.
/* exported isStopForOrion, STOP_WORDS */

// Перебить ответ или раздумье: «Орион, стоп», «Орион, хватит», «Орион, спасибо»
const STOP_WORDS = /^(стоп|хватит|замолчи|тихо|помолчи|достаточно|спасибо|всё|все)$/;
// Закончить разговор, пока Орион ждёт продолжения: «стоп», «отбой», «не слушай» (без «спасибо» — на него он ответит)
const STOP_ALL = /^(стоп|хватит|замолчи|помолчи|тихо|отбой|не слушай|перестань слушать|можешь не слушать)$/;

const clean = (t) =>
  String(t ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,!?…]+/g, '')
    .trim();

// «Стоп» относится к самому Ориону — он говорит, думает или ждёт продолжения разговора: замолчать, бросить
// запрос и перестать слушать (до следующего «Орион»). Иначе (Орион ничего не делает) «Орион, стоп» —
// обычная команда: например, пауза музыки.
//   command — текст после имени (null — имени не было); final — вся фраза; listening — окно ждёт фразу;
//   speaking / busy — Орион говорит / думает; dialogOpen — идёт разговор (ответил недавно)
function isStopForOrion({ command, final, listening = false, speaking = false, busy = false, dialogOpen = false }) {
  const byName = command !== null && command !== undefined;
  if (speaking || busy) return byName && STOP_WORDS.test(clean(command)); // посреди ответа слушаем только имя
  const said = clean(byName ? command : listening ? final : '');
  if (!said || !STOP_ALL.test(said)) return false;
  return dialogOpen || (!byName && listening);
}

if (typeof module !== 'undefined') module.exports = { isStopForOrion, STOP_WORDS };
