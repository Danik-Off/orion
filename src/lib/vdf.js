// Разбор текстового формата Valve KeyValues (VDF/ACF) — так Steam хранит библиотеку и статистику:
//   "key" "value"  и  "key" { ... }
function parseVdf(text) {
  const tokens = String(text).match(/"(?:[^"\\]|\\.)*"|[{}]/g) || [];
  let i = 0;
  const unquote = (t) => t.slice(1, -1).replace(/\\(.)/g, (m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  function object() {
    const out = {};
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t === '}') return out;
      if (t === '{') continue; // лишняя скобка — пропускаем
      const key = unquote(t);
      const next = tokens[i++];
      if (next === '{') out[key] = object();
      else if (next !== undefined) out[key] = unquote(next);
    }
    return out;
  }
  return object();
}

// Ключ без учёта регистра: Steam пишет то "apps", то "Apps"
function pick(obj, ...path) {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    const k = Object.keys(cur).find((x) => x.toLowerCase() === key.toLowerCase());
    cur = k === undefined ? undefined : cur[k];
  }
  return cur;
}

module.exports = { parseVdf, pick };
