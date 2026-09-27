// Ключевое слово («Орион») в распознанном тексте.
//
// Маленький распознаватель не знает имени и слышит его по-разному: «ореон», «арион», «орен», «орёл»,
// «ори он»… Поэтому слово сравнивается фонетически: гласные сводятся к классам (о/а → a, е/и/э/ы/ё/я/ю → i),
// мягкий знак и «й» отбрасываются, сравнение идёт с допуском в одну букву.
// Для частых подмен, которые фонетически далеко (орион → «орёл»), — отдельный список.
// Проверено на 336 фразах 14 голосами (+шум, разная скорость) и 172 обычных фразах: см. test/wake.test.js.

const VOWELS = { о: 'a', а: 'a', е: 'i', ё: 'i', и: 'i', э: 'i', ы: 'i', я: 'a', ю: 'u', у: 'u' };

// Фонетический ключ слова: «ореон» → arian, «арион» → arian, «орен» → arin
function key(word) {
  return String(word)
    .toLowerCase()
    .replace(/[ьъй]/g, '')
    .replace(/[оаеёиэыяюу]/g, (v) => VOWELS[v])
    .replace(/[^a-zа-я]/g, '')
    .replace(/(.)\1+/g, '$1'); // «аллон» → «алон»
}

function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

// Частые ошибки распознавателя, которые фонетически далеко от оригинала (из испытаний)
const KNOWN_MISHEARINGS = {
  орион: ['орёл', 'орел', 'орём', 'орем', 'орёла', 'орела', 'аллон', 'алон', 'аливон', 'оренка', 'орёлка', 'орелка'],
  джарвис: ['жарвис', 'дарвис', 'джервиз', 'джалис', 'чарльз'],
};

// Слова, после которых имя всё ещё считается обращением: «слушай, Орион», «эй, Орион»
const LEAD_INS = new Set(['слушай', 'слушая', 'слуша', 'слышь', 'эй', 'ну', 'так', 'окей', 'ок', 'привет', 'а', 'и', 'хей']);

// Слова, с которых начинается команда: после них похожее на имя слово посреди речи считается обращением.
// Для настоящих слов («орёл») — только повелительные: «…летал орёл, какой красивый» — не обращение.
const IMPERATIVES = new Set([
  'включи', 'выключи', 'открой', 'закрой', 'запусти', 'поставь', 'найди', 'покажи', 'расскажи', 'скажи',
  'напомни', 'запомни', 'забудь', 'сделай', 'сверни', 'переключи', 'останови', 'продолжи', 'пауза', 'стоп',
  'громче', 'тише', 'дальше',
]);
const COMMAND_START = new Set([...IMPERATIVES, 'какая', 'какой', 'сколько']);
const QUESTIONS = new Set(['как', 'что', 'где', 'кто', 'когда', 'почему', 'зачем', 'сколько', 'какая', 'какой', 'какие', 'скажи', 'расскажи']);
const REAL_WORDS = new Set(['орел', 'орем', 'орела']);

// Обычные короткие слова, которые не должны будить ассистента, даже если звучат похоже
const COMMON_WORDS = new Set(['алло', 'ало', 'ага', 'арена', 'арина', 'ирина', 'район', 'регион', 'радио', 'рион', 'орех', 'орехи']);

const normalizeText = (text) =>
  String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\- ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

function createWakeMatcher(wakeWords) {
  const targets = wakeWords.map((w) => {
    const word = w.toLowerCase().replace(/ё/g, 'е');
    const k = key(word);
    return {
      key: k,
      tolerance: k.length >= 8 ? 2 : k.length >= 4 ? 1 : 0,
      extra: new Set((KNOWN_MISHEARINGS[word] || []).map((x) => x.replace(/ё/g, 'е'))),
      latin: /^[a-z]+$/.test(word) ? word : null,
    };
  });

  function isWake(token) {
    const k = key(token);
    return targets.some(
      (t) => t.extra.has(token) || t.latin === token || (k.length >= 3 && levenshtein(k, t.key) <= t.tolerance),
    );
  }

  // Отдельно сказанное слово, похожее на имя («арип», «орен»): допуск шире.
  // Ошибка здесь дешёвая — ассистент лишь подаст сигнал «слушаю».
  function isLoneWake(token) {
    const k = key(token);
    return !COMMON_WORDS.has(token) && k.length >= 3 && targets.some((t) => levenshtein(k, t.key) <= t.tolerance + 1);
  }

  // Середина фразы: только точное звучание имени (ключ совпадает целиком: «орион», «арион», «ореон»).
  // Похожие настоящие слова («орёл», «Орионом», «миллион») здесь не принимаются.
  const isExactWake = (token) => {
    const k = key(token);
    return targets.some((t) => t.latin === token || k === t.key);
  };

  // → текст команды после имени; '' — прозвучало только имя; null — обращения нет
  function strip(text) {
    const words = normalizeText(text);
    if (words.length === 1 && isLoneWake(words[0])) return '';

    // 1. Имя в начале фразы или после вводного слова («слушай, Орион») — сравнение с допуском
    for (let start = 0; start <= 2 && start < words.length; start++) {
      if (start > 0 && !LEAD_INS.has(words[start - 1])) break;
      for (const n of [1, 2]) {
        const candidate = words.slice(start, start + n).join('');
        if (candidate && isWake(candidate)) return dropRepeats(words.slice(start + n));
      }
    }

    // 1б. Сильно искажённое имя в самом начале («алён, как меня зовут», «ален скажи»), если сразу за ним
    //     вопрос или команда: допуск на одну букву шире
    if (words.length >= 2 && (COMMAND_START.has(words[1]) || QUESTIONS.has(words[1])) && !COMMON_WORDS.has(words[0])) {
      const k = key(words[0]);
      if (k.length >= 3 && targets.some((t) => levenshtein(k, t.key) <= t.tolerance + 1)) return words.slice(1).join(' ');
    }

    // 2. Имя посреди речи («так, ну ладно, Орион, погода»): точное звучание — или похожее,
    //    если сразу за ним идёт команда («…орен, включи…»). Команда — после последнего упоминания.
    for (let i = words.length - 1; i >= 1; i--) {
      for (const n of [1, 2]) {
        if (i + n > words.length) continue;
        const candidate = words.slice(i, i + n).join('');
        const next = words[i + n];
        const commandFollows = next && (REAL_WORDS.has(candidate) ? IMPERATIVES : COMMAND_START).has(next);
        if (isExactWake(candidate) || (commandFollows && isWake(candidate))) {
          return dropRepeats(words.slice(i + n));
        }
      }
    }
    return null;
  }

  // «Орион, Орион, включи» → «включи»
  const dropRepeats = (rest) => {
    let i = 0;
    while (i < rest.length && isWake(rest[i])) i++;
    return rest.slice(i).join(' ');
  };

  // Личные варианты: как распознаватель слышит имя именно в вашем произношении и с вашим микрофоном.
  // Принимаются только слова, похожие на имя, и не обычные слова русского языка.
  function learn(heardWords) {
    const added = [];
    for (const raw of heardWords) {
      const token = normalizeText(raw).join('');
      const k = key(token);
      if (!token || token.length < 3 || COMMON_WORDS.has(token) || isWake(token)) continue;
      if (!targets.some((t) => levenshtein(k, t.key) <= t.tolerance + 2)) continue; // совсем не похоже — не учим
      targets[0].extra.add(token);
      added.push(token);
    }
    return added;
  }

  // Похоже на имя, но не принято — для журнала промахов (только первые слова, не вся фраза)
  function nearMiss(text) {
    const words = normalizeText(text).slice(0, 2);
    return words.some((w) => targets.some((t) => levenshtein(key(w), t.key) <= t.tolerance + 2)) ? words.join(' ') : null;
  }

  return { strip, isWake, learn, nearMiss, learned: () => [...targets[0].extra] };
}

module.exports = { createWakeMatcher, key, levenshtein };
