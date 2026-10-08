// Свои настройки голосом: «говори быстрее/медленнее», «смени голос», «голос номер три», «теперь тебя зовут Джарвис»,
// «мой город Казань», «жди ответа дольше», «какие у тебя настройки». Пишет через тот же путь, что окно настроек
// (проверка значений, оба окна узнают об изменении); имя меняет и слово отклика — после перезапуска.
const { wordsToNumber } = require('../lib/ru');

const SPEED_STEP = 0.1;
const FOLLOW_STEP = 3;
const SPEAKERS = 10; // голоса 0–9 у модели речи

const norm = (text) =>
  String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[?!.,;:«»"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const round = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Сохранить и сказать, что вышло; ошибка проверки — отказ
function save(ctx, patch, done) {
  const r = ctx.saveSettings(patch);
  if (!r?.ok) return { ok: false, message: 'Такое значение поставить нельзя, сэр.' };
  return { ok: true, speak: r.restart ? `${done} Заработает после перезапуска.` : done };
}

// arg: "speed faster|slower|1.2" | "voice next|N" | "name X" | "city X" | "wait longer|shorter|N" | "show"
function mySetting(arg, ctx) {
  const [what, ...rest] = String(arg || '')
    .trim()
    .split(/\s+/);
  const value = rest.join(' ').trim();
  const speech = ctx.config.speech || {};
  if (what === 'speed') {
    const now = speech.ttsSpeed ?? 1;
    const n = value === 'faster' ? now + SPEED_STEP : value === 'slower' ? now - SPEED_STEP : Number(value.replace(',', '.'));
    if (!Number.isFinite(n)) return { ok: false, message: 'Быстрее или медленнее, сэр?' };
    const next = round(clamp(n, 0.6, 1.6));
    if (next === now) return { ok: true, speak: value === 'slower' ? 'Медленнее уже некуда, сэр.' : 'Быстрее уже некуда, сэр.' };
    return save(ctx, { 'speech.ttsSpeed': next }, next > now ? 'Хорошо, буду говорить быстрее.' : 'Хорошо, буду говорить медленнее.');
  }
  if (what === 'voice') {
    const now = speech.ttsSpeaker ?? 0;
    const n = value === 'next' || !value ? (now + 1) % SPEAKERS : value === 'previous' ? (now + SPEAKERS - 1) % SPEAKERS : Number(value);
    if (!Number.isInteger(n) || n < 0 || n >= SPEAKERS) return { ok: false, message: `Голоса есть с нулевого по ${SPEAKERS - 1}-й, сэр.` };
    return save(ctx, { 'speech.ttsSpeaker': n }, `Голос номер ${n}. Так лучше?`);
  }
  if (what === 'name') {
    const name = value.replace(/^./, (c) => c.toUpperCase());
    if (!/^[А-ЯЁA-Z][а-яёa-z-]{1,19}$/.test(name)) return { ok: false, message: 'Какое имя мне взять, сэр?' };
    if (name === ctx.config.name) return { ok: true, speak: `Меня и так зовут ${name}.` };
    return save(ctx, { name }, `Теперь меня зовут ${name}, и откликаться буду на это имя.`);
  }
  if (what === 'city') {
    if (!value) return { ok: false, message: 'Какой город запомнить, сэр?' };
    const city = value.replace(/(^|[\s-])([а-яёa-z])/g, (_, s, c) => s + c.toUpperCase());
    const r = save(ctx, { city }, `Запомнил город: ${city}.`);
    if (r.ok) ctx.shared?.setProfile?.(`city=${city}`);
    return r;
  }
  if (what === 'wait') {
    const now = speech.followUpSeconds ?? 7;
    const n = value === 'longer' ? now + FOLLOW_STEP : value === 'shorter' ? now - FOLLOW_STEP : Number(value);
    if (!Number.isFinite(n)) return { ok: false, message: 'Дольше или короче ждать, сэр?' };
    const next = clamp(Math.round(n), 3, 20);
    return save(ctx, { 'speech.followUpSeconds': next }, `Буду ждать продолжения ${next} секунд.`);
  }
  if (what === 'show') {
    const speed = speech.ttsSpeed ?? 1;
    const pace = speed > 1.05 ? 'быстрее обычного' : speed < 0.95 ? 'медленнее обычного' : 'в обычном темпе';
    return {
      ok: true,
      speak:
        `Меня зовут ${ctx.config.name}. Говорю ${pace}, голос номер ${speech.ttsSpeaker ?? 0}. ` +
        `${ctx.config.city ? `Ваш город — ${ctx.config.city}. ` : ''}После ответа жду продолжения ${speech.followUpSeconds ?? 7} секунд. ` +
        'Остальное — в окне настроек.',
    };
  }
  return { ok: false, message: 'Эту настройку голосом не поменять, она в окне настроек, сэр.' };
}

function quick(text) {
  const t = norm(text);
  const plan = (arg) => ({ addressed: true, say: '', actions: [{ tool: 'my_setting', arg }] });
  if (/^(?:говори|разговаривай|читай)(?: (?:чуть|немного|побольше|по))? (?:быстрее|побыстрее)$/.test(t)) return plan('speed faster');
  if (/^(?:говори|разговаривай|читай)(?: (?:чуть|немного|по))? (?:медленнее|помедленнее)$/.test(t)) return plan('speed slower');
  if (/^(?:смени|поменяй|другой|следующий)(?: (?:свой|мне))? голос$/.test(t)) return plan('voice next');
  if (/^(?:верни|вернись на|предыдущий|прошлый)(?: (?:прошлый|предыдущий|старый))? голос$/.test(t)) return plan('voice previous');
  const voice = t.match(/^(?:включи|поставь|сделай|смени на)? ?голос (?:номер )?(\S+)$/);
  if (voice) {
    const n = /^\d+$/.test(voice[1]) ? Number(voice[1]) : wordsToNumber(voice[1]);
    if (n != null) return plan(`voice ${n}`);
  }
  const name = t.match(/^(?:теперь )?(?:тебя зовут|твое имя|зови себя|я буду звать тебя|я буду называть тебя) ([а-яa-z-]+)$/);
  if (name) return plan(`name ${name[1]}`);
  const city = t.match(/^(?:мой город|я живу в городе|я теперь живу в городе|запомни мой город) ([а-яa-z -]+)$/);
  if (city) return plan(`city ${city[1]}`);
  if (/^(?:жди|слушай)(?: ответа| продолжения| меня)? (?:дольше|подольше)$/.test(t)) return plan('wait longer');
  if (/^(?:жди|слушай)(?: ответа| продолжения| меня)? (?:меньше|короче|поменьше)$/.test(t)) return plan('wait shorter');
  if (/^(?:какие у тебя|расскажи свои|назови свои|покажи свои) настройки$/.test(t)) return plan('show');
  return null;
}

module.exports = {
  id: 'assistant-settings',
  router: 2, // маленькая модель знает навык с orion-router v2; с v1 фразы о нём сразу у большой
  title: 'свои настройки голосом: скорость речи, голос, имя, город, сколько ждать продолжения',
  // Только целые просьбы: просто «голос» или «настройки» встречаются и в других командах
  keywords: [
    /говори\S* (?:\S+ )?(?:быстр|медлен|побыстр|помедлен)/,
    /(?:смени|поменяй|другой|следующий|предыдущий|верни)\S* (?:\S+ )?голос|голос номер/,
    /тебя зовут|твое имя|зови себя|называть тебя/,
    /мой город|живу в городе/,
    /(?:жди|слушай)\S* (?:\S+ )?(?:дольше|подольше|меньше|короче)/,
    /какие у тебя настройки|свои настройки/,
  ],
  quick,
  rules: [
    'my_setting — поменять настройку самого ассистента: скорость речи, голос, имя, город пользователя, ожидание продолжения.',
    'Настройки Windows (тема, Wi-Fi, Bluetooth) — pc_setting; громкость — volume.',
  ],
  tools: [
    {
      name: 'my_setting',
      use: 'скорость речи, голос ассистента, его имя, город пользователя, сколько ждать продолжения; show — перечислить',
      arg: 'speed faster|slower|<0.6–1.6> | voice next|previous|<0–9> | name <имя> | city <город> | wait longer|shorter|<3–20> | show',
      speaks: true,
      examples: [
        ['говори помедленнее', { addressed: true, say: '', actions: [{ tool: 'my_setting', arg: 'speed slower' }] }],
        ['пусть тебя зовут Джарвис', { addressed: true, say: '', actions: [{ tool: 'my_setting', arg: 'name Джарвис' }] }],
      ],
      run: (arg, ctx) => mySetting(arg, ctx),
    },
  ],
  _test: { quick },
};
