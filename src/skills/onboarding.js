// Знакомство после установки — один раз: город (для погоды и новостей), запись голоса (там же — имя и обращение:
// Орион узнаёт человека и помнит, как его зовут), несколько команд для начала.
// Без ответа (человек отошёл) — спросит при следующем запуске; «Пропустить» — больше не спрашивает.
const fs = require('node:fs');
const path = require('node:path');
const weather = require('./weather'); // weather.geocode — через объект: тест подменяет поиск города
const { usedBefore } = require('../lib/first-run');

const TIPS = '«Орион, какая погода?», «включи радио», «разбуди меня в семь», «новости про космос», «найди в интернете…»';

// «Я живу в Казани», «город Казань», «в Нижнем Новгороде» → «Казани», «Казань», «Нижнем Новгороде»
// (падеж погода переварит сама: пробует название как есть и без окончания)
const FILLER = /^(?:ну|так|я|мы|живу|живём|живем|нахожусь|находимся|сейчас|в|во|из|город|городе)\s+/i;
function cityOf(answer) {
  let t = String(answer || '')
    .replace(/[.!?«»"]/g, '')
    .trim();
  while (FILLER.test(t)) t = t.replace(FILLER, ''); // «ну мы в Санкт-Петербурге» → «Санкт-Петербурге»
  if (!t || t.split(/\s+/).length > 4 || /^(нет|не скажу|не хочу|пропусти|потом|не надо)$/i.test(t)) return '';
  return t
    .split(/(\s+|-)/)
    .map((w) => (/^[а-яёa-z]/i.test(w) && !/^(на|на-|дон)$/i.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join('');
}

// Записан ли уже чей-то голос
function hasVoices(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'people.json'), 'utf8')).length > 0;
  } catch {
    return false;
  }
}

module.exports = {
  id: 'onboarding',
  router: false,
  title: 'знакомство после установки: город, голос, первые команды',
  keywords: [],
  hint: false,
  tools: [],
  async offer(ctx) {
    if (ctx.config.onboarded || !ctx.ask) return;
    // Уже пользовались (обновление со старой версии) — знакомиться поздно: просто отметить
    if (usedBefore(ctx.dataDir) || hasVoices(ctx.dataDir)) return ctx.saveSettings({ onboarded: true });
    const answer = await ctx.ask('Давайте знакомиться. В каком городе вы живёте? Это нужно для погоды и новостей.');
    if (answer === undefined) return; // не ответили — спросим при следующем запуске
    ctx.saveSettings({ onboarded: true });
    // Название — как у сервиса погоды: «Казани» → «Казань»; не нашёлся — как сказано (погода разберёт и так)
    const said = cityOf(answer);
    const place = said ? await weather.geocode(said).catch(() => null) : null;
    const city = place?.name || said;
    if (city) {
      ctx.saveSettings({ city });
      ctx.shared?.setProfile?.(`city=${city}`);
      ctx.audit?.({ onboarding: 'город', city });
    }
    if (ctx.startEnrollment && !hasVoices(ctx.dataDir)) {
      const yes = await ctx.confirm('Хотите, чтобы я узнавал вас по голосу и обращался по имени? Нужно сказать четыре фразы — это минута.');
      if (yes === true) return ctx.startEnrollment();
    }
    ctx.say?.(`${city ? `Запомнил: ${city}. ` : ''}Для начала попробуйте: ${TIPS}`);
  },
  _test: { cityOf },
};
