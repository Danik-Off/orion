// Аргумент инструмента прямо из фразы — без большой модели. У инструментов с llmArg аргумент обычно пишет
// большая модель (время напоминания, текст заметки, выражение); когда её нет, маленькая модель всё равно
// называет инструмент, а аргумент разбирают эти правила. Урезанно: частые формулировки, а не всё подряд.
// fromText(tool, text, ctx) → строка аргумента в формате инструмента, null («не этот инструмент» / не разобрать)
// или undefined (правила нет).
const { durationFromText, wordsToNumber } = require('./ru');
const { parseClock, formatClock } = require('./clock');
const { dayOf } = require('./days');

const norm = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const bare = (t) =>
  norm(t)
    // «2,5» — дробь: точка и запятая между цифрами остаются, остальные знаки — пробел
    .replace(/(?<!\d)[.,]|[.,](?!\d)|[?!;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
// «пожалуйста», «мне», «орион» — не часть аргумента
const filler = (t) =>
  t
    .replace(/(^|\s)(пожалуйста|плиз|мне|ка|давай|будь добр)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
// Название списка — в той форме, что у навыка заметок: «покупок» → «покупки», «делах» → «дела»
const listOf = (w) =>
  [
    [/покуп|магазин/, 'покупки'],
    [/^дел|задач/, 'дела'],
    [/замет/, 'заметки'],
    [/фильм|кино/, 'фильмы'],
    [/книг/, 'книги'],
  ].find(([re]) => re.test(w))?.[1] || w;

// Слова длительности и служебные — убрать из текста напоминания
const DURATION_WORDS =
  /(^|\s)(через|на|за|в течение)?\s*(?:(\d+|[а-я]+(?: [а-я]+)?)\s+)?(секунд[уыа]?|сек|минут[уыа]?|минутк[уи]|мин|час|часа|часов|часик|полчаса|полтора часа)(?=\s|$)/g;

// Текст напоминания: после «напомни/таймер …» без времени и связок («про», «чтобы», «что надо»)
function reminderText(t) {
  return filler(
    t
      .replace(/^(поставь|заведи|засеки|включи|сделай|установи)\s+(таймер|напоминание)?/, '')
      .replace(/(^|\s)(?:напомни|напоминай|напомнить)(?=\s|$)/g, ' ')
      .replace(/^(таймер|напоминание)\s*/, '')
      .replace(/через сколько(?: минут)?/g, ' ')
      // Длительность — только с числом или без него («час»): «воду каждый час» — «воду» не число, остаётся
      // («через час размяться»: «через» — предлог, а не слово напоминания)
      .replace(DURATION_WORDS, (all, pre, prep, n) => (n && wordsToNumber(n) === null && !/^(через|на|за)$/.test(n) ? ` ${n} ` : ' '))
      .replace(
        /(^|\s)(завтра|сегодня|послезавтра|утром|вечером|днем|ночью|каждый день|кажд(?:ый|ые|ую|ое)|в половине [а-я]+|в \d{1,2}(?: \d{2})?|в [а-я]+ (?:утра|вечера|дня|ночи)|утра|вечера|дня|ночи)(?=\s|$)/g,
        ' ',
      )
      // «в девять», «в семь тридцать», «в двадцать два тридцать» — время словами (числа — уже выше):
      // убрать все слова-числа подряд после «в», первое не-число оставить
      .replace(/(^|\s)(?:в|к)((?: [а-я]+){1,4})(?=\s|$)/g, (all, pre, rest) => {
        const words = rest.trim().split(' ');
        if (wordsToNumber(words[0]) === null) return all;
        const keep = words.findIndex((w) => wordsToNumber(w) === null);
        return keep < 0 ? ' ' : ` ${words.slice(keep).join(' ')} `;
      })
      .replace(/(^|\s)(про|о|об|что|чтобы|что надо|что нужно|мне надо|нужно|надо)(?=\s)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

// Число со словами: «семнадцать» → 17, «2,5» → 2.5
function num(w) {
  if (/^\d+([.,]\d+)?$/.test(w)) return w.replace(',', '.');
  const n = wordsToNumber(w);
  return n === null || n === undefined ? null : String(n);
}

// «сколько будет 17 умножить на 23», «15 процентов от 3400», «двадцать пять процентов от двух тысяч», «корень из 144»
// Сначала числа словами → цифры (целыми группами: «тысяча двести», «двух тысяч»), потом действия
const NUMBER_WORD =
  /^(?:ноль|один|одна|одну|два|две|двух|три|трех|четыре|четырех|пять|пяти|шесть|шести|семь|семи|восемь|восьми|девять|девяти|десять|десяти|\S*надцат\S*|двадцат\S*|тридцат\S*|сорок\S*|пятьдесят|пятидесяти|шестьдесят|шестидесяти|семьдесят|семидесяти|восемьдесят|восьмидесяти|девяносто|девяноста|сто|ста|двести|двухсот|триста|трехсот|четыреста|четырехсот|пятьсот|пятисот|шестьсот|шестисот|семьсот|семисот|восемьсот|восьмисот|девятьсот|девятисот|одного|одной|тысяч\S*|миллион\S*)$/;
function calcExpr(text) {
  const t = bare(text)
    .replace(/^(?:сколько будет|сколько получится|сколько|посчитай|вычисли|подсчитай|реши)\s*(?:пример\s*)?/, '')
    .replace(/\s*(будет|равно)$/, '');
  const tokens = t.split(/\s+/).filter(Boolean);
  const words = [];
  for (let i = 0; i < tokens.length;) {
    if (!NUMBER_WORD.test(tokens[i])) {
      words.push(tokens[i++]);
      continue;
    }
    let j = i;
    while (j < tokens.length && NUMBER_WORD.test(tokens[j])) j++;
    const n = wordsToNumber(tokens.slice(i, j).join(' '));
    words.push(n === null ? tokens.slice(i, j).join(' ') : String(n));
    i = j;
  }
  const expr = words
    .join(' ')
    .replace(/^(?:раздели|подели) (\S+) на (\S+)$/, '$1 / $2')
    .replace(/^умножь (\S+) на (\S+)$/, '$1 * $2')
    .replace(/^сложи (\S+) и (\S+)$/, '$1 + $2')
    .replace(/^(?:вычти|отними) (\S+) из (\S+)$/, '$2 - $1')
    .replace(/(\S+) процент(?:а|ов)? от (\S+)/g, '$2 * $1%')
    .replace(/(\S+)% от (\S+)/g, '$2 * $1%') // «15% от 300»
    .replace(/(\d+(?:,\d+)?) процент(?:а|ов)?/g, '$1%') // «200 плюс 10 процентов» → 200 + 10%
    .replace(/корень (?:квадратный )?из (\S+)/g, 'sqrt($1)')
    .replace(/(\S+) в квадрате/g, '$1 ^ 2')
    .replace(/(\S+) в кубе/g, '$1 ^ 3')
    .replace(/(\S+) в степени (\S+)/g, '$1 ^ $2')
    .replace(/умножить на|умножь на|помножить на|умноженное на| х | x /g, ' * ')
    .replace(/разделить на|делить на|поделить на|деленное на/g, ' / ')
    .replace(/плюс|прибавить|сложить с/g, ' + ')
    .replace(/минус|отнять|вычесть/g, ' - ')
    .replace(/(\d%?)\s+на\s+(?=\d)/g, '$1 * ') // «двести на три»
    .replace(/\s+/g, ' ')
    .trim();
  return /^[\d\s+\-*/^().,%sqrt]+$/.test(expr) && /\d/.test(expr) ? expr : null;
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const HOLIDAYS = { 'новый год': '01-01', 'нового года': '01-01', рождества: '01-07', '8 марта': '03-08', 'дня победы': '05-09' };
// «5 октября», «первого января 2000 года» → «10-05» / «2000-01-01»
function dateOf(t) {
  for (const [name, d] of Object.entries(HOLIDAYS)) if (t.includes(name)) return d;
  const m = t.match(
    /(\d{1,2}|[а-я]+(?: [а-я]+)?) (января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?: (\d{4}))?/,
  );
  if (!m) return null;
  const ordinal = {
    первого: 1,
    второго: 2,
    третьего: 3,
    четвертого: 4,
    пятого: 5,
    шестого: 6,
    седьмого: 7,
    восьмого: 8,
    девятого: 9,
    десятого: 10,
  };
  const day = /^\d+$/.test(m[1]) ? Number(m[1]) : (ordinal[m[1].split(' ').pop()] ?? wordsToNumber(m[1]));
  if (!day || day > 31) return null;
  const md = `${String(MONTHS.indexOf(m[2]) + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return m[3] ? `${m[3]}-${md}` : md;
}

const SITES = [
  [/ютуб|youtube/, 'https://www.youtube.com'],
  [/(^|\s)вк(\s|$)|вконтакте/, 'https://vk.com'],
  [/гугл|google/, 'https://www.google.com'],
  [/яндекс|yandex/, 'https://ya.ru'],
  [/гитхаб|github/, 'https://github.com'],
  [/почт[ауы]|gmail|джимейл/, 'https://mail.google.com'],
  [/википеди/, 'https://ru.wikipedia.org'],
  [/кинопоиск/, 'https://www.kinopoisk.ru'],
  [/авито/, 'https://www.avito.ru'],
  [/озон|ozon/, 'https://www.ozon.ru'],
  [/вайлдберриз|wildberries/, 'https://www.wildberries.ru'],
];

const LANGS = {
  английск: 'английский',
  немецк: 'немецкий',
  французск: 'французский',
  испанск: 'испанский',
  итальянск: 'итальянский',
  китайск: 'китайский',
  японск: 'японский',
  русск: 'русский',
};
const langOf = (t) => Object.entries(LANGS).find(([k]) => t.includes(k))?.[1] || null;

const RULES = {
  timer(t) {
    if (/отмени|сбрось|убери|выключи|останови/.test(t) && /таймер/.test(t))
      return `cancel ${t.match(/таймер[ыа]? (?:для|на|про) (.+)$/)?.[1] || ''}`.trim(); // «для пасты» — отменить только его
    let sec = durationFromText(t);
    if (!sec) {
      const amount = t.match(/через (\d+|[а-я]+(?: [а-я]+)?)$/)?.[1]; // «напомни через семь» — минуты
      const n = amount ? wordsToNumber(amount) : null;
      if (n) sec = n * 60;
    }
    if (!sec) return null;
    // «напомни через семь» — число в конце убрать; «через час размяться» — «размяться» остаётся текстом
    const what = reminderText(
      t.replace(/через (\d+|[а-я]+(?: [а-я]+)?)$/, (all, n) => (/^\d+$/.test(n) || wordsToNumber(n) !== null ? '' : all)),
    );
    return `${sec}|${what || 'таймер'}`;
  },
  remind_at(t) {
    t = t.replace(/(?:на|в) половину/, 'в половине');
    const what = reminderText(t);
    const every = t.match(/кажды[йеx] (\d+ |[а-я]+ )?(минут[уы]?|час[аов]*)/);
    if (every) {
      const n = every[1] ? Number(num(every[1].trim())) || 1 : 1;
      return `every ${/час/.test(every[2]) ? n * 60 : n}|${what || 'напоминание'}`;
    }
    // День — отдельно: «5 октября» не время 5:00, «в пятницу в 10» — пятница, а не сегодня
    const said = dayOf(t);
    const clock = parseClock(said ? said.rest : t);
    if (!clock) return said ? `${said.spec}09:00|${reminderText(said.rest) || 'напоминание'}` : null; // день без времени — утром
    let h = clock.h;
    // «в 7 вечера» parseClock уже учёл; «в 3» без уточнения днём — скорее 15:00, если 3 часа ночи прошли бы зря
    if (/вечером|вечера/.test(t) && h < 12) h += 12;
    else if (!/утра|утром|ночи|ночью|вечера|дня/.test(t) && h >= 1 && h <= 6) h += 12;
    const day = dayOf(t, { h, m: clock.m });
    return `${day?.spec || ''}${formatClock({ h, m: clock.m })}|${reminderText(day?.rest ?? t) || what || 'напоминание'}`;
  },
  alarm(t) {
    t = t.replace(/(?:на|в) половину/, 'в половине'); // «на половину седьмого» → как «в половине седьмого»
    if (/какие|список|покажи/.test(t)) return 'list';
    if (/отмени|удали|выключи|отключи|убери|сними|не буди|не надо будить/.test(t)) return 'cancel';
    const clock = parseClock(t);
    if (!clock) {
      const sec = durationFromText(t);
      return sec ? `in ${Math.round(sec / 60)}` : null;
    }
    const day = /по будням/.test(t) ? 'weekdays ' : /каждый день|ежедневно/.test(t) ? 'daily ' : /завтра/.test(t) ? 'tomorrow ' : '';
    const radio = t.match(/под радио (.+)$/);
    return `${day}${formatClock(clock)}${radio ? `|радио ${radio[1]}` : ''}`;
  },
  reminders(t) {
    if (!/напоминан/.test(t)) return null;
    const cancel = t.match(/(?:отмени|удали|убери)(?: все)? напоминани[ея]\s*(.*)$/);
    if (cancel) return `cancel ${cancel[1].replace(/^(про|о|об)\s+/, '') || 'все'}`;
    return '';
  },
  note_add(t) {
    const items = (s) =>
      s
        .split(/,\s*|\s+и\s+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .join('; ');
    // «добавь в покупки молоко и хлеб» / «добавь молоко в список покупок»
    const first = t.match(/^(?:добавь|допиши|запиши|внеси|закинь)\s+в\s+(?:список\s+)?(\S+)\s+(.+)$/);
    if (first) return `${first[1]}|${items(first[2])}`;
    const last = t.match(/^(?:добавь|допиши|внеси|закинь)\s+(.+?)\s+в\s+(?:список\s+)?(\S+)$/);
    if (last) return `${last[2]}|${items(last[1])}`;
    const note = t.match(/^(?:запиши|запомни|сделай заметку|заметка)(?:\s+(?:идею|мысль|заметку))?\s*:?\s+(.+)$/);
    return note ? `|${note[1]}` : null;
  },
  note_remove(t) {
    const m = t.match(/^(?:вычеркни|удали|убери|сотри)\s+(.+?)\s+из\s+(?:списка\s+)?(\S+)$/);
    if (m) return `${listOf(m[2])}|${m[1]}`;
    // «удали из списка сахар», «вычеркни из покупок хлеб»
    const first = t.match(/^(?:вычеркни|удали|убери|сотри)\s+из\s+(?:списка\s+)?(покупок|дел|заметок|фильмов|книг)?\s*(.+)$/);
    if (first) return `${listOf(first[1] || 'покупки')}|${first[2]}`;
    const all = t.match(/^(?:очисти|удали все из)\s+(?:список\s+)?(\S+)$/);
    return all ? `${listOf(all[1])}|всё` : null;
  },
  profile(t) {
    const name = t.match(/(?:меня зовут|мое имя|зови меня|называй меня)\s+([а-яa-z-]+)$/);
    if (name) return `name=${cap(name[1])}`;
    const city = t.match(/я (?:живу|нахожусь|сейчас) в (?:городе )?([а-яa-z -]+)$/);
    return city ? `city=${cap(city[1].trim())}` : null;
  },
  remember(t) {
    const m = t.match(/^(?:запомни|запиши себе|учти)(?:,)?\s+(?:что\s+)?(.+)$/);
    return m ? cap(m[1]) : null;
  },
  forget(t) {
    const m = t.match(/^забудь(?:,)?\s+(?:что я (?:просил|говорил)\s+)?(?:про|о|об|что)?\s*(.+)$/);
    return m ? m[1] : null;
  },
  open_url(t) {
    if (!/^(?:открой|зайди|перейди|запусти)(?:\s|$)/.test(t)) return null; // «найди issue на гитхабе» — не открыть сайт
    return SITES.find(([re]) => re.test(t))?.[1] || null;
  },
  power(t) {
    // Только если о компьютере сказано прямо: «выключи свет в гостиной» — не про питание
    if (!/компьют|комп|пк|ноут|систем|перезагру|выключени|спящ|усыпи/.test(t)) return null;
    if (/отмени|отбой/.test(t)) return 'cancel';
    if (/спящ|усыпи|сон/.test(t)) return 'sleep';
    const restart = /перезагру/.test(t);
    if (!restart && !/выключи|отключи|заверши работу/.test(t)) return null;
    const sec = durationFromText(t);
    return `${restart ? 'restart' : 'shutdown'} ${sec ? Math.max(1, Math.round(sec / 60)) : 1}`;
  },
  sleep_timer(t) {
    if (/отмени/.test(t)) return 'cancel';
    const sec = durationFromText(t);
    return sec ? String(Math.max(1, Math.round(sec / 60))) : null;
  },
  run_command(t, ctx) {
    const names = Object.keys(ctx?.config?.commands || {});
    return (
      names.find((n) => t.includes(norm(n))) ||
      names.find((n) =>
        norm(n)
          .split(' ')
          .some((w) => w.length > 4 && t.includes(w)),
      ) ||
      null
    );
  },
  find_file(t) {
    const open = /^открой/.test(t);
    const m = t.match(
      /(?:найди|поищи|где|открой)\s+(?:мне\s+)?(?:файл|документ|папку|фото|файлы)?\s*(?:с|со|про|под названием|который называется)?\s*(.+)$/,
    );
    return m ? `${open ? 'open ' : ''}${m[1]}` : null;
  },
  recent_files(t) {
    if (!/скача|загрузил|последн|недавн|сегодня|вчера|новые файлы/.test(t)) return null;
    const when = /вчера/.test(t) ? ' вчера' : /сегодня/.test(t) ? ' сегодня' : '';
    const where = /скача|загруз/.test(t)
      ? 'загрузки'
      : /фото|картин|изображ/.test(t)
        ? 'изображения'
        : /документ/.test(t)
          ? 'документы'
          : '';
    return `${where}${when}`.trim();
  },
  clipboard(t) {
    if (!/скопир|буфер|выделен/.test(t)) return null; // «как будет по-немецки спасибо» — перевод сказанного, не буфера
    const lang = /перевед|переведи|по-|на (?:английск|немецк|французск|испанск|китайск|русск)/.test(t) && langOf(t);
    if (lang) return `translate ${lang}`;
    if (/перескажи|кратко|суть|сократи/.test(t)) return 'summary';
    if (/исправ|ошибк/.test(t)) return 'fix';
    if (/объясни|что значит|что означает/.test(t)) return 'explain';
    return 'read';
  },
  translate(t) {
    const lang = langOf(t);
    if (!lang) return null;
    const m =
      t.match(/^как (?:будет |сказать )?(?:по-? ?[а-я]+|на [а-я]+ом?)\s+(.+)$/) ||
      t.match(/^переведи(?: на [а-я]+(?: язык)?)?\s+(.+?)(?:\s+на [а-я]+(?: язык)?)?$/);
    return m ? `${lang}|${m[1]}` : null;
  },
  type_text(t, ctx, raw) {
    const m = String(raw).match(/^\s*(?:напечатай|набери|введи|впиши|напиши текст)\s*:?\s+([\s\S]+)$/i);
    return m ? cap(m[1].trim()) : null;
  },
  calc: (t) => calcExpr(t),
  date_info(t) {
    if (/праздник/.test(t)) return 'holidays';
    if (/какое (?:сегодня )?число|какой сегодня день|какая сегодня дата/.test(t)) return 'today';
    const d = dateOf(t);
    if (!d) return null;
    if (/день недели/.test(t)) return `weekday ${d}`;
    if (/сколько (?:дней|осталось)|до /.test(t)) return `until ${d}`;
    return `weekday ${d}`;
  },
  news_about(t) {
    const m = t.match(/(?:новости|пишут|слышно|говорят|нового)\s+(?:про|о|об|по|из|в|во|у)\s+(.+)$/);
    // «что нового в новостях», «в мире» — это главные новости, а не тема
    return m && !/^(новост|мир|стран|россии$|целом)/.test(m[1]) ? m[1] : null;
  },
  delegate: (t, ctx, raw) => cap(String(raw).trim()),

  // «что завтра в Питере с погодой» → «Питере|завтра» (падеж погода разбирает сама); город можно не называть
  weather(t, ctx, raw) {
    const when =
      // «на выходных», «в выходные дни» — тоже выходные
      t
        .match(/послезавтра|завтра|сегодня|на выходн\S*|выходн\S*|на неделю|неделю|через \S+ дн[яей]+/)?.[0]
        ?.replace(/^на /, '')
        .replace(/^выходн\S*/, 'выходные') ||
      t.match(/понедельник|вторник|среду|среда|четверг|пятницу|пятница|субботу|суббота|воскресенье/)?.[0] ||
      '';
    // Часть дня: «будет ли дождь вечером», «завтра утром»
    const part = t.match(/(?:^|\s)(утром|днем|вечером|ночью|к вечеру|на вечер|на ночь|с утра)(?=\s|$)/)?.[1].replace(/^(?:к|на|с) /, '');
    const whenAll = [when, part].filter(Boolean).join(' ');
    // Город — слово после «в/во» (распознавание пишет всё строчными, заглавной буквы может не быть);
    // «в выходные», «в пятницу», «в городе» — не город
    const NOT_CITY =
      /^(выходные|понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье|городе|районе|течение|этот|эти|начале|конце|обед|полдень|час|\d)/;
    const words = String(raw)
      .replace(/[?!.,;:«»"]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const at = words.findIndex((w, i) => /^(в|во)$/i.test(w) && words[i + 1] && !NOT_CITY.test(words[i + 1].toLowerCase()));
    let city = at >= 0 ? words[at + 1] : '';
    // «в нижнем новгороде», «в санкт петербурге» — два слова, если первое — прилагательное или «санкт»
    if (
      city &&
      /^(нижн|велик|санкт|ростов|набережн|старом|новом|южно|петропавловск|комсомольск|нью|лос|сан|лас)$|^(нижн|велик|набережн|старом|новом)/i.test(
        city,
      ) &&
      words[at + 2]
    )
      city += ` ${words[at + 2]}`;
    if (/^ростов/i.test(city) && /^на$/i.test(words[at + 2] || '') && words[at + 3]) city = `${words[at + 1]} на ${words[at + 3]}`;
    if (/^(москве|питере|городе)$/i.test(city) === false && /^(погод|улиц|доме|квартир|комнат)/i.test(city)) city = '';
    if (!/погод|зонт|дожд|снег|холодно|тепло|жарко|мороз|градус|температур|ветер|одеться|надеть/.test(t)) return null;
    return `${city}|${whenAll || 'сегодня'}`;
  },
  // «почём биткоин», «курс евро», «сколько стоит 25 долларов»
  rate(t) {
    const codes = [
      [/доллар|бакс|usd/, 'USD'],
      [/евро(?!п)|eur/, 'EUR'], // «европа плюс» — радио, а не евро
      [/юан|cny/, 'CNY'],
      [/биткоин|биток|btc/, 'BTC'],
      [/эфир|эфириум|eth/, 'ETH'],
      [/(^|\s)тон(\s|$)|toncoin/, 'TON'],
      [/фунт/, 'GBP'],
      [/тенге/, 'KZT'],
      [/лир/, 'TRY'],
    ];
    // Все упомянутые валюты по порядку: «1000 рублей в долларах» → RUB, USD
    const mentions = [...codes, [/рубл|rub/, 'RUB']]
      .map(([re, c]) => [t.search(re), c])
      .filter(([at]) => at >= 0)
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => c);
    const code = mentions.find((c) => c !== 'RUB') ? mentions[0] : null;
    if (!code) return null;
    const CUR = '(?:доллар|евро|юан|биткоин|фунт|тенге|лир|рубл)';
    const digits = t.match(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${CUR})`));
    let amount = digits?.[1];
    let amountCur = digits?.[2];
    if (!amount) {
      // «сто долларов», «двадцать пять евро» — число словами перед валютой
      const words = t.match(new RegExp(`((?:[а-я]+ ){1,3}?)(${CUR})`));
      const n = words ? wordsToNumber(words[1].trim().split(' ').slice(-3).join(' ')) : null;
      if (n) [amount, amountCur] = [String(n), words[2]];
    }
    const codeOf = (word) => mentions.find((c) => [...codes, [/рубл|rub/, 'RUB']].find(([, k]) => k === c)[0].test(word));
    // Переводят то, у чего сумма: «сколько юаней за 1000 рублей» — рубли в юани
    const from = amountCur ? codeOf(amountCur) : code;
    const other = mentions.find((c) => c !== from);
    const asked =
      /(?:^|\s)(?:в|во|на)\s+\S+\s*$|(?:^|\s)(?:в|на)\s+(?:доллар|евро|юан|рубл|фунт|тенге|лир|биткоин)|^сколько \S+ (?:за|на)\s/.test(t);
    // Во что перевести — вторая валюта; «в рублях» — обычный перевод в рубли
    if (other && asked && other !== 'RUB') return `${amount ? `${amount.replace(',', '.')} ` : ''}${from}>${other}`;
    if (from === 'RUB' && other) return `${amount ? `${amount.replace(',', '.')} ` : ''}RUB>${other}`;
    return amount ? `${amount.replace(',', '.')} ${from}` : from;
  },

  // Простые инструменты: аргумент обычно пишет сама маленькая модель, но без проверки большой — правило надёжнее
  close_app(t) {
    if (/радио|музык|звук|видео на ютубе/.test(t)) return null; // это не программа: «выруби радио» — radio_stop
    const m = t.match(/^(?:закрой|выключи|выруби|заверши|убей)\s+(?:программу\s+|приложение\s+)?(.+)$/);
    return m ? m[1] : null;
  },
  screenshot(t) {
    if (!/скрин|снимок экрана|сфоткай экран|сфотографируй экран/.test(t)) return null;
    return /покажи|открой/.test(t) ? 'show' : '';
  },
  youtube(t) {
    const m =
      t.match(
        /^(?:включи|поставь|запусти|найди на ютубе|включи на ютубе)\s+(?:мне\s+)?(?:на ютубе\s+)?(?:песню\s+|клип\s+|видео\s+)?(.+)$/,
      ) || t.match(/^найди\s+(?:мне\s+)?(?:песню|клип|музыку)\s+(?:про\s+|под названием\s+)?(.+)$/); // «найди мне песню про миллион алых роз»
    if (!m || /^радио|^(?:тёмн|темн|светл)\S* тему|вай|блют|будильник|таймер|режим/.test(m[1])) return null;
    // «включи музыку», «что-нибудь послушать» — пусто: навык включит популярный микс
    return /^(?:какую[ -]нибудь |что[ -]нибудь )?(?:музыку|песенку|песню|музычку|послушать)$|^что[ -]нибудь(?: послушать)?$/.test(m[1])
      ? ''
      : m[1];
  },
  open_app(t) {
    const m = t.match(/^(?:открой|запусти|включи)\s+(?:программу\s+|приложение\s+)?(.+)$/);
    return m && !/папк|сайт|настройк|параметр/.test(m[1]) ? m[1] : null;
  },
  open_folder(t) {
    if (!/^(?:открой|покажи|зайди в)/.test(t)) return null;
    const folders = [
      [/загрузк/, 'загрузки'],
      [/документ/, 'документы'],
      [/рабоч/, 'рабочий стол'],
      [/изображ|картин|фото/, 'изображения'],
      [/музык/, 'музыка'],
      [/видео/, 'видео'],
    ];
    return folders.find(([re]) => re.test(t))?.[1] || null;
  },
  // Радио: «выруби радио» — не включить (у включения правила нет: станцию называет маленькая модель)
  radio(t) {
    return /выключ|выруби|останови|хватит|убери|стоп/.test(t) ? null : undefined;
  },
  radio_stop(t) {
    return /выключ|выруби|останови|хватит|убери|стоп|не надо/.test(t) ? '' : null;
  },
  volume(t) {
    if (!/громк|звук|тише|громче|потише|погромче|mute|не слыш/.test(t)) return null; // «15 процентов от 1000» — не громкость
    if (/выключи звук|без звука|замьють|mute/.test(t)) return 'mute';
    if (/включи звук/.test(t)) return 'unmute';
    if (/какая|сколько сейчас/.test(t)) return '?';
    const n = t.match(/(\d+|[а-я]+(?: [а-я]+)?)\s*(?:процент|%)/);
    const value = n ? wordsToNumber(n[1]) : (t.match(/громкость (?:на )?(\d+)/)?.[1] ?? null);
    const down = /тише|убав|уменьш|понизь/.test(t);
    const up = /громче|прибав|увелич|повысь/.test(t);
    if (down || up) return `${down ? '-' : '+'}${value || 10}`;
    if (/половин/.test(t)) return '50';
    return value !== null ? String(value) : null;
  },
  focus(t) {
    if (!/фокус|не беспокоить|сосредоточ|концентрац/.test(t)) return null;
    const sec = durationFromText(t);
    return sec ? String(Math.round(sec / 60)) : '';
  },
  steam_launch(t) {
    const m = t.match(/^(?:запусти|включи|давай поиграем в|поиграем в|хочу поиграть в|играть в)\s+(?:игру\s+)?(.+)$/);
    return m ? m[1] : null;
  },
  steam_stats(t) {
    if (/больше всего (?:играю|играл)|во что я (?:играю|играл)/.test(t)) return '';
    if (!/наиграл|статистик|сколько час/.test(t)) return null;
    const m = t.match(/(?:наиграл|играл)\s+(?:в\s+)?(.+)$/);
    return m ? m[1] : '';
  },
  steam_price(t) {
    const m = t.match(/(?:скидк[аи]|цена|стоит|почем)\s+(?:на\s+)?(?:игру\s+)?(.+)$/);
    return m ? m[1] : null;
  },
};

// Есть ли разбор без модели для этого инструмента
const canParse = (tool) => Object.hasOwn(RULES, tool);

// → строка аргумента; null — «это не этот инструмент» (или так не разобрать); undefined — правила нет или оно
// не знает («включи радио Маяк» — станцию называет маленькая модель)
function fromText(tool, text, ctx) {
  const rule = RULES[tool];
  if (!rule) return undefined;
  try {
    const arg = rule(bare(text), ctx, text);
    return arg === undefined ? undefined : arg === null ? null : String(arg);
  } catch {
    return null;
  }
}

module.exports = { fromText, canParse, calcExpr, dateOf };
