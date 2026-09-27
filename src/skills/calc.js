// Калькулятор: модель переводит фразу в выражение, считает код (маленькие модели ошибаются в арифметике).
// Свой разбор выражения — никакого eval.
const { money } = require('../lib/ru');

// + - * / ^, скобки, «15%» (= 0,15), sqrt(), десятичная запятая
function evaluate(expr) {
  const src = String(expr).replace(/,/g, '.').replace(/\s+/g, '').replace(/\*\*/g, '^').replace(/[×х]/g, '*').replace(/[÷:]/g, '/');
  if (!src || src.length > 200) throw new Error('пустое выражение');
  let i = 0;
  const peek = () => src[i];
  const eat = (c) => (src[i] === c ? (i++, true) : false);

  function number() {
    const m = src.slice(i).match(/^\d+(\.\d+)?/);
    if (!m) throw new Error(`не понял «${src.slice(i, i + 5)}»`);
    i += m[0].length;
    return Number(m[0]);
  }
  function primary() {
    if (eat('-')) return -primary();
    if (eat('+')) return primary();
    if (src.startsWith('sqrt(', i)) {
      i += 5;
      const v = expr1();
      if (!eat(')')) throw new Error('нет скобки');
      return Math.sqrt(v);
    }
    let v;
    if (eat('(')) {
      v = expr1();
      if (!eat(')')) throw new Error('нет скобки');
    } else v = number();
    if (eat('%')) v /= 100;
    return v;
  }
  function power() {
    const base = primary();
    return eat('^') ? base ** power() : base;
  }
  function term() {
    let v = power();
    for (;;) {
      if (eat('*')) v *= power();
      else if (eat('/')) {
        const d = power();
        if (d === 0) throw new Error('деление на ноль');
        v /= d;
      } else return v;
    }
  }
  function expr1() {
    let v = term();
    for (;;) {
      if (eat('+')) v += term();
      else if (eat('-')) v -= term();
      else return v;
    }
  }
  const v = expr1();
  if (i < src.length) throw new Error(`лишнее «${peek()}»`);
  if (!Number.isFinite(v)) throw new Error('слишком большое число');
  return v;
}

const format = (v) => (Math.abs(v) >= 1e15 ? v.toExponential(3).replace('.', ',') : money(Math.round(v * 1e4) / 1e4, 4));

async function calc(arg) {
  try {
    return { ok: true, speak: `Получается ${format(evaluate(arg))}.` };
  } catch (err) {
    return { ok: false, message: `Не смог посчитать: ${err.message}, сэр.` };
  }
}

module.exports = {
  id: 'calc',
  title: 'калькулятор: посчитать выражение, проценты',
  keywords: ['сколько будет', 'посчитай', 'вычисл', 'умнож', 'подели', 'раздели', 'плюс', 'минус', 'процент от', 'корень', 'в степени', /\d+\s*[-+*/x×]\s*\d+/],
  rules: ['Любую арифметику считай через calc, а не в уме.'],
  tools: [
    {
      name: 'calc',
      speaks: true, // ответ всегда даёт сам инструмент
      use: 'посчитать арифметику',
      arg: 'выражение: + - * / ^ ( ) sqrt(); проценты как 15% (15% от 3400 → 3400*15%)',
      examples: [['сколько будет 15 процентов от 3400', { addressed: true, say: '', actions: [{ tool: 'calc', arg: '3400*15%' }] }]],
      run: calc,
    },
  ],
  evaluate,
};
