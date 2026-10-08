// Настройки компьютера голосом: «включи тёмную тему», «выключи блютуз», «включи вай-фай», «выключи экран»,
// «режим экономии энергии», «открой настройки звука». Громкость — навык sound, яркость — screen.
// Выключить Wi-Fi — с разрешения: без сети пропадут поиск, погода и большая модель по API.
const pc = require('../lib/pc-settings');

const ACTIONS = {
  'theme dark': async () => (await pc.setTheme(true), 'Включил тёмную тему.'),
  'theme light': async () => (await pc.setTheme(false), 'Включил светлую тему.'),
  'wifi on': () => radio('WiFi', true, 'Wi-Fi'),
  'wifi off': () => radio('WiFi', false, 'Wi-Fi'),
  'bluetooth on': () => radio('Bluetooth', true, 'Bluetooth'),
  'bluetooth off': () => radio('Bluetooth', false, 'Bluetooth'),
  'screen off': async () => (await pc.screenOff(), ''),
  'power performance': async () => (await pc.setPowerPlan('performance'), 'Режим высокой производительности.'),
  'power balanced': async () => (await pc.setPowerPlan('balanced'), 'Сбалансированный режим питания.'),
  'power saver': async () => (await pc.setPowerPlan('saver'), 'Режим экономии энергии.'),
};

async function radio(kind, on, title) {
  const state = await pc.setRadio(kind, on);
  if (state === 'нет') return `${title} на этом компьютере нет, сэр.`;
  if (state === 'запрещено') return `Windows не разрешает мне переключать ${title}. Это можно сделать в центре уведомлений.`;
  return `${title} ${state === 'On' ? 'включён' : 'выключен'}.`;
}

const norm = (text) =>
  String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[?!.,;:«»"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const WIFI = '(?:вай[ -]?фай|wi[ -]?fi)';
const BT = '(?:блютуз|блютус|bluetooth|блю туз)';
const ON = '(?:включи|вруби|активируй)';
const OFF = '(?:выключи|отключи|выруби|деактивируй)';
// Разделы «Параметров» по словам из фразы
const PAGES = [
  [/звук/, 'звук'],
  [/блютуз|bluetooth/, 'bluetooth'],
  [/вай[ -]?фай|wi[ -]?fi/, 'wi-fi'],
  [/сет[иь]|интернет/, 'сеть'],
  [/экран|дисплей|монитор/, 'экран'],
  [/обновлен/, 'обновления'],
  [/приложени|программ/, 'приложения'],
  [/уведомлени/, 'уведомления'],
  [/фон|обо[ий]/, 'фон'],
  [/персонализ|тем[ыу]/, 'персонализация'],
  [/батаре|аккумулятор/, 'батарея'],
  [/питани|сна|спящ/, 'питание'],
  [/памят|хранилищ|диск/, 'память'],
  [/мыш|тачпад/, 'мышь'],
  [/клавиатур|раскладк/, 'клавиатура'],
  [/язык/, 'язык'],
  [/врем|дат[аы]/, 'время'],
  [/принтер/, 'принтеры'],
  [/микрофон/, 'микрофон'],
];

function quick(text) {
  const t = norm(text);
  const plan = (tool, arg) => ({ addressed: true, say: '', actions: [{ tool, arg }] });
  if (new RegExp(`^${ON} ${WIFI}$`).test(t)) return plan('pc_setting', 'wifi on');
  if (new RegExp(`^${OFF} ${WIFI}$`).test(t)) return plan('pc_setting', 'wifi off');
  if (new RegExp(`^${ON} ${BT}$`).test(t)) return plan('pc_setting', 'bluetooth on');
  if (new RegExp(`^${OFF} ${BT}$`).test(t)) return plan('pc_setting', 'bluetooth off');
  if (/^(?:включи|сделай|поставь)(?: мне)? (?:темн\S* (?:тему|режим|оформление)|ночную тему)$/.test(t))
    return plan('pc_setting', 'theme dark');
  if (/^(?:включи|сделай|поставь)(?: мне)? светл\S* (?:тему|режим|оформление)$/.test(t)) return plan('pc_setting', 'theme light');
  if (/^(?:выключи|погаси|отключи)(?: мне)? (?:экран|монитор|дисплей)$/.test(t)) return plan('pc_setting', 'screen off');
  // Режим питания — только просьбой («что такое режим экономии энергии» — вопрос, не команда)
  const asked = t.match(/^((?:включи|поставь|сделай|переключи(?:сь)? на|перейди в|переведи(?: компьютер)? в) )?(режим )?(.+)$/);
  const mode = asked[1] || asked[2] ? asked[3] : ''; // одно «экономия» — не команда
  if (/^(?:(?:максимальной |высокой )?производительност\S*|максимальной мощности)$/.test(mode))
    return plan('pc_setting', 'power performance');
  if (/^(?:экономи\S*(?: энерги\S*)?|энергосбережени\S*)$/.test(mode)) return plan('pc_setting', 'power saver');
  if (/^(?:сбалансированн\S*(?: режим)?|обычный режим питания)$/.test(mode)) return plan('pc_setting', 'power balanced');
  // «Открой настройки звука», «параметры блютуза»; «настройки виндовс / компьютера» — главная страница
  const page = t.match(/^(?:открой|покажи|зайди в)(?: мне)? (?:настройки|параметры)(?: windows| виндовс| компьютера| системы)?(?: (.+))?$/);
  if (page && (page[1] || /windows|виндовс|компьютера|системы/.test(t))) {
    const p = page[1] ? PAGES.find(([re]) => re.test(page[1]))?.[1] : 'параметры';
    if (p) return plan('windows_settings', p);
  }
  return null;
}

module.exports = {
  id: 'system',
  platforms: ['win32'],
  router: 2, // маленькая модель знает навык с orion-router v2; с v1 фразы о нём сразу у большой
  title: 'настройки компьютера: тёмная тема, Wi-Fi, Bluetooth, выключить экран, режим питания, разделы «Параметров Windows»',
  // Только целые команды: «скорость вайфая» — навык network, «экран темнее» — яркость; им нужна маленькая модель
  keywords: [
    /(?:включ|выключ|отключ|выруб|вруб)\S* (?:вай[ -]?фай|wi[ -]?fi|блют|bluetooth|блю туз)/,
    /(?:темн|светл)\S* (?:тем|режим|оформлени)/,
    /(?:выключ|погас|отключ)\S* (?:экран|монитор|дисплей)/,
    /режим\S* (?:питани|производительн|экономи|энергосбер|сбалансир)|энергосбережени/,
    /(?:настройк|параметр)\S* (?:виндовс|windows|компьютера|системы|звука|блют|bluetooth|экрана|wi|вай)/,
  ],
  quick,
  rules: [
    'pc_setting — переключить настройку компьютера. windows_settings — открыть раздел «Параметров Windows».',
    'Громкость — volume, яркость — brightness. Настройки самого ассистента (голос, скорость речи, имя) — my_setting.',
  ],
  tools: [
    {
      name: 'pc_setting',
      use: 'тёмная или светлая тема, Wi-Fi, Bluetooth, выключить экран, режим питания',
      arg: Object.keys(ACTIONS).join(' | '),
      argEnum: Object.keys(ACTIONS),
      speaks: true,
      examples: [['включи тёмную тему', { addressed: true, say: '', actions: [{ tool: 'pc_setting', arg: 'theme dark' }] }]],
      async run(arg, ctx) {
        const action = ACTIONS[arg];
        if (!action) return { ok: false, message: 'Такой настройки компьютера я не знаю, сэр.' };
        if (arg === 'wifi off' && !(await ctx.confirm('Выключить Wi-Fi? Без интернета я не смогу искать и узнавать погоду.'))) {
          return { ok: false, message: 'Оставил Wi-Fi включённым.' };
        }
        try {
          const speak = await action();
          return { ok: true, speak, silentAfter: arg === 'screen off' };
        } catch (err) {
          ctx.audit?.({ system: arg, error: String(err?.message || err).slice(0, 160) });
          return { ok: false, message: 'Не получилось переключить, сэр.' };
        }
      },
    },
    {
      name: 'windows_settings',
      use: 'открыть раздел «Параметров Windows»',
      arg: Object.keys(pc.SETTINGS_PAGES).join(' | '),
      argEnum: Object.keys(pc.SETTINGS_PAGES),
      speaks: true,
      examples: [['открой настройки блютуза', { addressed: true, say: '', actions: [{ tool: 'windows_settings', arg: 'bluetooth' }] }]],
      async run(arg, ctx) {
        const uri = pc.SETTINGS_PAGES[arg];
        if (!uri) return { ok: false, message: 'Не знаю такого раздела настроек, сэр.' };
        await ctx.openExternal(uri);
        return { ok: true, speak: 'Открываю.' };
      },
    },
  ],
};
