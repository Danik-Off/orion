// Ответ без языковой модели: из найденного текста — предложения, в которых больше всего слов вопроса.
// Нужен, когда большой модели нет (не скачана, выключена): поиск, факты, пересказ документа всё равно
// что-то отвечают — пусть короче и суше. Основы слов — первые 5 букв: «революция»/«революции» совпадут.
const STOP = new Set(
  'и в во на не что как кто где когда какой какая какие сколько это то у о об от до по за из с со к ко для ли же бы а но или мне ты вы он она они был была было были есть'.split(
    ' ',
  ),
);
const stem = (w) => w.slice(0, 5);
const wordsOf = (t) =>
  String(t || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));

// Предложения текста (без заголовков-списков «[1] Заголовок (сайт)» и маркеров «•»)
function sentencesOf(context) {
  return String(context || '')
    .replace(/^\[\d+\][^\n]*\n/gm, '')
    .replace(/^•\s*[^:\n]*:\s*/gm, '')
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 400 && /[а-яa-z]/i.test(s));
}

// question — вопрос; context — найденный текст; maxWords — длина ответа. Нечего сказать — ''
function extractAnswer(question, context, { maxWords = 45 } = {}) {
  const want = new Set(wordsOf(question).map(stem));
  const list = sentencesOf(context);
  if (!list.length) return '';
  const scored = list.map((s, i) => {
    const have = new Set(wordsOf(s).map(stem));
    let hits = 0;
    for (const w of want) if (have.has(w)) hits++;
    return { s, i, score: hits + (/\d/.test(s) ? 0.3 : 0) - i * 0.01 }; // цифры — обычно и есть ответ; раньше — важнее
  });
  const best = [...scored].sort((a, b) => b.score - a.score);
  // Ни одного слова вопроса — первое предложение (начало статьи обычно и есть определение)
  const picked = want.size && best[0].score >= 1 ? best.slice(0, 2).sort((a, b) => a.i - b.i) : [scored[0]];
  const words = picked
    .map((x) => x.s)
    .join(' ')
    .split(/\s+/);
  const text = words.slice(0, maxWords).join(' ');
  return words.length > maxWords ? `${text.replace(/[,;:]$/, '')}…` : text;
}

module.exports = { extractAnswer, sentencesOf };
