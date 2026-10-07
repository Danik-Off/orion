// Ударения перед озвучкой: микромодель silero-stress (MIT, © Silero Team, github.com/snakers4/silero-stress),
// перенесённая на JS — без PyTorch и ONNX, ~3 МБ, доли миллисекунды на слово.
//   1. Омографы («замок», «мука», «все») — по фразам-подсказкам из контекста («закрыто на замок» → зам+ок).
//      Нейросетевой решатель омографов Silero (BERT, 30 МБ) не перенесён: на типичных фразах Ориона он
//      ошибается в частых словах («я п+отом позвоню», «сколько сто+ит») — 12 верных из 17 против 16 у подсказок.
//   2. Свои ударения (extra-words.json), затем исключения Silero — готовые ударения для ~20 тыс. слов.
//   3. Остальные слова — сеть: символьные n-граммы слова → вектор → номер ударной гласной (и где «ё»).
// Модель ставит «+» перед ударной гласной (как Silero); ударение, уже стоящее в тексте («ю-эс-б+и» из нормализатора),
// сохраняется. forSynth() переводит «+» в знак ударения U+0301 после гласной — его понимает Supertonic —
// и ставит твёрдое «э» в заимствованиях (hard-e.json). Односложные слова не размечаются: ударение в них очевидно.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DIR = path.join(__dirname, '..', 'assets', 'stress');
const VOWELS = 'аоуыэиеяёю';
const WINDOW = 150; // символов контекста с каждой стороны омографа
const ACUTE = '́';

let model = null;

function load() {
  if (model) return model;
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'meta.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(DIR, 'weights.bin'));
  const { rows, dim, scale, zeroPoint } = meta.embedding;
  const q = new Int8Array(buf.buffer, buf.byteOffset, rows * dim);
  // Веса слоя: копия в выровненный буфер (Float32Array требует смещение, кратное 4)
  const layer = (name) => {
    const { shape, offset } = meta.layers[name];
    const n = shape.reduce((a, b) => a * b, 1);
    return {
      w: new Float32Array(buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + n * 4)),
      rows: shape[0],
      cols: shape[1] ?? 1,
    };
  };
  const mlp = (prefix) => [0, 2, 4, 6].map((i) => ({ weight: layer(`${prefix}.${i}.weight`), bias: layer(`${prefix}.${i}.bias`).w }));
  const gunzip = (file) => zlib.gunzipSync(fs.readFileSync(path.join(DIR, file))).toString('utf8');
  const ngrams = new Map(
    gunzip('ngrams.txt.gz')
      .split('\n')
      .map((g, i) => [g, i]),
  );
  const exceptions = new Map(
    gunzip('exceptions.txt.gz')
      .split('\n')
      .map((line) => line.split(' '))
      .map(([w, s, y]) => [w, [Number(s), Number(y)]]),
  );
  const { homodict, phrases } = JSON.parse(gunzip('homographs.json.gz'));
  // Свои подсказки — для того, что часто говорит Орион («всё готово»); проверяются раньше подсказок Silero
  const extra = JSON.parse(fs.readFileSync(path.join(DIR, 'extra-phrases.json'), 'utf8'));
  for (const [word, variants] of Object.entries(extra)) phrases[word] = [...variants, ...(phrases[word] || [])];
  // Свои ударения — важнее словаря Silero: «крас+ивее» → [позиция ударной, позиция «ё» или −1]
  const own = JSON.parse(fs.readFileSync(path.join(DIR, 'extra-words.json'), 'utf8'));
  for (const [word, stressed] of Object.entries(own)) {
    if (word === '_' || !stressed.includes('+')) continue;
    exceptions.set(word, [stressed.indexOf('+'), stressed.replace('+', '').indexOf('ё')]);
  }
  model = {
    q,
    dim,
    scale,
    zeroPoint,
    ngrams,
    exceptions,
    homodict,
    phrases,
    stress: mlp('stress_clf'),
    yo: mlp('yo_clf'),
    rules: new Map(),
    hardE: loadHardE(),
    grammar: loadGrammar(),
  };
  return model;
}

function loadGrammar() {
  const g = JSON.parse(fs.readFileSync(path.join(DIR, 'grammar-homographs.json'), 'utf8'));
  return { words: g.words, genitive: new Set(g.genitivePrepositions), few: new Set(g.few), pluralBefore: new Set(g.pluralBefore) };
}

// Твёрдое «э»: основа → основа с «э», окончания — по классу слова (hard-e.json)
const ENDINGS = {
  m: ['', 'а', 'у', 'ом', 'е', 'ы', 'ов', 'ам', 'ами', 'ах'],
  m_soft: ['ь', 'я', 'ю', 'ем', 'е', 'и', 'ей', 'ям', 'ями', 'ях'],
  f_soft: ['ь', 'и', 'ью', 'ей', 'ям', 'ями', 'ях'],
  f: ['а', 'ы', 'и', 'е', 'у', 'ой', 'ою', 'ам', 'ами', 'ах'],
  adj: ['ый', 'ий', 'ая', 'ое', 'ые', 'ого', 'ому', 'ым', 'ом', 'ой', 'ую', 'ых', 'ыми'],
  fixed: [''],
};
function loadHardE() {
  const dict = JSON.parse(fs.readFileSync(path.join(DIR, 'hard-e.json'), 'utf8'));
  const forms = new Map();
  for (const [cls, stems] of Object.entries(dict)) {
    if (!ENDINGS[cls]) continue;
    for (const [stem, hard] of Object.entries(stems)) for (const end of ENDINGS[cls]) forms.set(stem + end, hard + end);
  }
  return forms;
}

// «интерн+ет» → «интэрн+эт»: буквы из словаря, ударение и регистр — из слова
function applyHardE(m, word) {
  const plain = word.replace(/\+/g, '');
  const hard = m.hardE.get(plain.toLowerCase());
  if (!hard) return word;
  let i = 0;
  return [...word]
    .map((c) => {
      if (c === '+') return c;
      const h = hard[i++];
      return h === 'э' && c.toLowerCase() === 'е' ? (c === 'Е' ? 'Э' : 'э') : c;
    })
    .join('');
}

// --- сеть ---

// Вектор слова: среднее векторов его символьных n-грамм «<слово>» (как fastText EmbeddingBag, mode=mean)
function embed(m, word) {
  const text = `<${word}>`;
  const ids = [];
  for (let n = 1; n <= word.length + 3; n++) {
    for (let i = 0; i + n <= text.length; i++) {
      const id = m.ngrams.get(text.slice(i, i + n));
      if (id !== undefined) ids.push(id);
    }
  }
  if (!ids.length) ids.push(m.ngrams.get('UNK'));
  const v = new Float32Array(m.dim);
  for (const id of ids) for (let d = 0; d < m.dim; d++) v[d] += m.q[id * m.dim + d];
  for (let d = 0; d < m.dim; d++) v[d] = m.scale * (v[d] / ids.length - m.zeroPoint);
  return v;
}

// Linear → ReLU → Linear → ReLU → Linear → ReLU → Linear, затем softmax
function classify(layers, x) {
  let v = x;
  layers.forEach(({ weight, bias }, k) => {
    const out = new Float32Array(weight.rows);
    for (let r = 0; r < weight.rows; r++) {
      let s = bias[r];
      const row = r * weight.cols;
      for (let c = 0; c < weight.cols; c++) s += weight.w[row + c] * v[c];
      out[r] = k < layers.length - 1 ? Math.max(0, s) : s;
    }
    v = out;
  });
  const max = Math.max(...v);
  const e = v.map((y) => Math.exp(y - max));
  const sum = e.reduce((a, b) => a + b, 0);
  let best = 0;
  for (let i = 1; i < e.length; i++) if (e[i] > e[best]) best = i;
  return { index: best, prob: e[best] / sum };
}

// --- омографы по фразам-подсказкам ---

// Контекст омографа — чистится так же, как в silero-stress (иначе фразы не совпадут)
function cleanContext(text, isStart) {
  let t = text
    .replace(/[^a-zA-Zа-яА-ЯёЁ0-9\s.!?,-]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, ' - ')
    .replace(/([.!?])\1+/g, '$1')
    .replace(/,{2,}/g, ',')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/([.,!?])(?=\S)/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
  if (isStart) t = t.replace(/^[ .,!?-]+/, '');
  else if (t && !/[.!?]$/.test(t)) t += '.';
  return t;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function rulesFor(m, word) {
  if (!m.rules.has(word)) {
    const variants = (m.phrases[word] || []).map(([variant, list]) => ({
      variant,
      re: new RegExp(
        `(?<![а-яА-ЯёЁ-])(?:${[...list]
          .sort((a, b) => b.length - a.length)
          .map(escapeRe)
          .join('|')})(?![а-яА-ЯёЁ-])`,
        'i',
      ),
    }));
    m.rules.set(word, variants);
  }
  return m.rules.get(word);
}

// Слово-омограф с подходящей фразой рядом → вариант с ударением («з+амок»), иначе null
function solveHomograph(m, text, start, end, lower) {
  const rules = rulesFor(m, lower);
  if (!rules.length) return null;
  const left = cleanContext(text.slice(0, start), true).slice(-WINDOW);
  const right = cleanContext(text.slice(end), false).slice(0, WINDOW);
  const marked = `${left} [HOMO] ${lower} [/HOMO] ${right}`.trim();
  // Совпало несколько подсказок — берётся самая длинная (точнее описывает контекст), затем первая по списку
  let best = null;
  for (const { variant, re } of rules) {
    const hit = re.exec(marked);
    if (hit && (!best || hit[0].length > best.length)) best = { length: hit[0].length, variant };
  }
  return best?.variant ?? null;
}

// Перенести ударение и «ё» из варианта словаря в слово, сохранив регистр букв
function applyVariant(word, variant) {
  const at = variant.indexOf('+');
  const plain = variant.replace('+', '');
  const cased = [...plain].map((c, i) => (word[i] && word[i] !== word[i].toLowerCase() ? c.toUpperCase() : c)).join('');
  return `${cased.slice(0, at)}+${cased.slice(at)}`;
}

// --- омографы по грамматике соседних слов ---

// Соседи в пределах части предложения: предыдущее слово (только если между ними нет знаков) и до четырёх следующих;
// listPrev/listNext — соседи по перечислению («покупки, дела, фильмы», «напоминания и дела»)
function neighbours(text, start, end) {
  const low = (w) => w?.replace(/\+/g, '').toLowerCase() ?? null;
  const prev = low(text.slice(0, start).match(/([а-яё+-]+)[ \u00A0]+$/i)?.[1]);
  const next = (
    text
      .slice(end)
      .split(/[.!?;:,—()«»"]/)[0]
      .match(/[а-яё+]+/gi) || []
  )
    .slice(0, 4)
    .map(low);
  const listPrev = low(text.slice(0, start).match(/([а-яё+-]+)(?:\s*,\s*|\s+и\s+)$/i)?.[1]);
  const listNext = low(text.slice(end).match(/^(?:\s*,\s*|\s+и\s+)([а-яё+-]+)/i)?.[1]);
  return { prev, next, listPrev, listNext };
}
const PLURALISH = /(ы|и|ия|ые|ие)$/; // «покупки», «напоминания», «новости» — множественное в перечислении

const PLURAL_VERB = /(ют|ят|ут|ат|ли|лись|ются|ятся|ны|ты)$/; // «стоят», «идут», «пришли», «заняты»
const PLURAL_NOUN = /[ыи]$/; // «моря и океаны»

// «города» после «из» — г+орода, после «эти» — город+а, после «два» — г+орода, «две руки» — р+уки.
// Число или предлог перед словом — надёжный признак (strong): он важнее фраз-подсказок
function strongGrammar(m, lower, { prev }) {
  const w = m.grammar.words[lower];
  if (!w || !prev) return null;
  if (m.grammar.few.has(prev)) return w.count || (w.g === 'f' ? w.pl : w.gen);
  if (m.grammar.genitive.has(prev)) return w.gen;
  return null;
}
function grammarHomograph(m, lower, { prev, next, listPrev, listNext }) {
  const w = m.grammar.words[lower];
  if (!w) return null;
  if (prev && (m.grammar.pluralBefore.has(prev) || /(ые|ие)$/.test(prev))) return w.pl;
  // Перечисление множественного числа: «покупки, дел+а, фильмы», «напоминания и дел+а на сегодня»
  if ([listPrev, listNext].some((x) => x && PLURALISH.test(x) && !m.grammar.words[x])) return w.pl;
  // Глагол во множественном числе — признак, только если слово начинает часть предложения («Дома стоят…»);
  // в «стены дома покрашены» глагол относится к «стенам», а «дома» — «чьи стены»
  if (prev && !/^(и|а|но|или|да)$/.test(prev)) return null;
  const verb = next.slice(0, 3).find((x) => PLURAL_VERB.test(x) || /(ет|ит|ёт|ал|ла|ло|ется|ится)$/.test(x));
  if (verb && PLURAL_VERB.test(verb)) return w.pl;
  if (next[0] === 'и' && next[1] && PLURAL_NOUN.test(next[1])) return w.pl;
  return null;
}

// «стоит» — цена или место: «сколько ст+оит», «ст+оит сто рублей», «ст+оит попробовать»; «сто+ит стол», «сто+ит на холме»
const PRICE_BEFORE = /^(сколько|почём|почем|дорого|недорого|дёшево|дешево|не|ничего|сколечко)$/;
const PRICE_AFTER =
  /^(ли|того|денег|дорого|недорого|дёшево|дешево|дороже|дешевле|около|примерно|всего|почти|целых|больше|меньше|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|\S+надцать|двадцать|тридцать|сорок|пятьдесят|шестьдесят|семьдесят|восемьдесят|девяносто|сто|двести|триста|четыреста|пятьсот|шестьсот|семьсот|восемьсот|девятьсот|тысяч\S*|миллион\S*|полтора|полторы|копейк\S*|рубл\S*|доллар\S*|евро)$/;
function stoitRule(lower, { prev, next }) {
  const forms = { стоит: ['ст+оит', 'сто+ит'], стоят: ['ст+оят', 'сто+ят'] }[lower];
  if (!forms) return null;
  const [price, place] = forms;
  if (prev && PRICE_BEFORE.test(prev)) return price;
  if (!next.length) return null;
  if (PRICE_AFTER.test(next[0]) || /(ть|ти|чь|ться)$/.test(next[0])) return price; // «стоит попробовать»
  return place;
}

function markHomographs(m, text) {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(/[а-яё+]*[а-яё][а-яё+]*/gi)) {
    const word = match[0];
    const lower = word.toLowerCase();
    if (word.includes('+')) continue;
    const start = match.index;
    const end = start + word.length;
    const near = neighbours(text, start, end);
    const variant =
      stoitRule(lower, near) ??
      strongGrammar(m, lower, near) ??
      (m.phrases[lower] ? solveHomograph(m, text, start, end, lower) : null) ??
      grammarHomograph(m, lower, near);
    if (!variant) continue;
    out += text.slice(last, match.index) + applyVariant(word, variant);
    last = match.index + word.length;
  }
  return out + text.slice(last);
}

// --- ударения в словах (AccentorNgram из silero-stress) ---

const vowelPositions = (w) => [...w].flatMap((c, i) => (VOWELS.includes(c) ? [i] : []));

// note(source, stressed, prob) — откуда ударение: для explain() и проверки готовых фраз
function stressWord(m, raw, note = () => {}) {
  const lower = raw.toLowerCase();
  const clean = lower.replace(/[^а-яё]/g, '');
  if (!clean) return raw;
  const vowels = vowelPositions(lower);
  if (!vowels.length) return raw;
  const haveStress = lower.includes('+');
  const haveYo = lower.includes('ё');
  if (haveStress) return (note('given', raw), raw); // уже размечено (омограф, нормализатор или вручную)
  if (vowels.length === 1) return raw; // односложное — ударение очевидно, синтезатору метка не нужна
  if (haveYo) return (note('yo', raw), raw); // «ё» всегда ударная

  if (m.exceptions.has(clean)) {
    const [s, y] = m.exceptions.get(clean);
    let word = raw;
    if (y !== -1) word = word.slice(0, y) + (word[y] === word[y].toLowerCase() ? 'ё' : 'Ё') + word.slice(y + 1);
    const stressed = `${word.slice(0, s)}+${word.slice(s)}`;
    note('dictionary', stressed);
    return stressed;
  }

  const v = embed(m, clean);
  const stress = classify(m.stress, v);
  const yo = classify(m.yo, v);
  let word = raw;
  const stressPos = stress.prob > 0.5 ? vowels[stress.index] : undefined;
  // «ё»: номер буквы «е» среди всех «е» слова (с 1; 0 — «ё» нет); ставим, только если она и есть ударная
  if (yo.prob > 0.5 && yo.index > 0) {
    const ye = [...lower].flatMap((c, i) => (c === 'е' ? [i] : []));
    const pos = ye[yo.index - 1];
    if (pos !== undefined && pos === stressPos) word = word.slice(0, pos) + (word[pos] === 'е' ? 'ё' : 'Ё') + word.slice(pos + 1);
  }
  const stressed = stressPos === undefined ? word : `${word.slice(0, stressPos)}+${word.slice(stressPos)}`;
  note('model', stressed, stress.prob);
  return stressed;
}

// Текст с ударениями в виде «+» перед ударной гласной: «Зам+ок на двер+и»
function accentuate(text, note) {
  const m = load();
  // «+» перед гласной — готовое ударение (из нормализатора или вручную), остальные «+» не нужны
  const clean = String(text).replace(/\+(?![аоуыэиеяёюАОУЫЭИЕЯЁЮ])/g, '');
  const withHomographs = markHomographs(m, clean);
  return withHomographs
    .split(/([\s.,!?;:<>=()/\\«»"„“—–]+)/)
    .map((token, i) =>
      i % 2
        ? token
        : token
            .split(/(-)/)
            .map((p) => (p === '-' || /^то$/i.test(p) ? p : stressWord(m, p, note)))
            .join(''),
    )
    .join('');
}

// Откуда каждое ударение: [{ stressed, source: given|yo|dictionary|model, prob? }] — для проверки готовых фраз
function explain(text) {
  const words = [];
  accentuate(text, (source, stressed, prob) => words.push({ stressed, source, prob }));
  return words;
}

// Для синтезатора: знак ударения U+0301 после ударной гласной вместо «+» перед ней
function forSynth(text) {
  const m = load();
  return accentuate(text)
    .replace(/[А-Яа-яЁё+]+/g, (word) => applyHardE(m, word))
    .replace(/\+([аоуыэиеяёюАОУЫЭИЕЯЁЮ])/g, `$1${ACUTE}`);
}

module.exports = { accentuate, forSynth, explain };
