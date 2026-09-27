// Быстрые тесты — без сети, без моделей и без Electron. Запуск: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// навыки подключают electron косвенно — подменяем его заглушкой
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return {};
  return originalLoad.call(this, request, ...rest);
};

const { parsePlan, planSchema, looksLikeContinuation, applyHonorific, createAssistant } = require('../src/core/assistant');
const { createSkillRegistry } = require('../src/core/skills');
const { createMemory, similarity } = require('../src/core/memory');
const { loadConfig } = require('../src/core/config');
const { cosine } = require('../src/core/speaker');
const { createWakeMatcher } = require('../src/core/wake');
const { score } = require('../src/lib/app-catalog');
const { plural, degrees } = require('../src/lib/ru');
const { isPublicUrl, extractMainText } = require('../src/lib/websearch');
const { pickForListening } = require('../src/lib/youtube');
const allSkills = require('../src/skills');
const music = require('../src/skills/music');
const weather = require('../src/skills/weather');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orion-test-'));

function makeRegistry(overrides = {}) {
  const config = loadConfig(path.join(__dirname, '../config.json'));
  Object.assign(config, overrides);
  const opened = [];
  const reminders = [];
  const store = createMemory({ dir: tmp() });
  const ctx = {
    config,
    memory: store.guest,
    llm: { answer: async () => 'ответ' },
    confirm: async () => false,
    remind: (t) => reminders.push(t),
    shared: store.shared,
    audit: () => {},
    openExternal: async (u) => opened.push(u),
    openPath: async () => '',
  };
  const skills = createSkillRegistry(allSkills, { config, ctx, audit: () => {}, platform: 'win32' }); // тесты одинаковы на любой ОС
  return { skills, ctx, opened, reminders, store };
}

// --- ключевое слово: регрессия на реальных ответах распознавателя (14 голосов, шум, скорость) ---

test('ключевое слово «Орион»: ≥95% в начале, ≥95% после «слушай», без ложных на обычной речи', () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/wake-asr.json'), 'utf8'));
  const wake = createWakeMatcher(['орион', 'orion']);
  const rate = (list) => list.filter((t) => wake.strip(t) !== null).length / list.length;
  assert.ok(rate(data.atStart) >= 0.95, `в начале: ${rate(data.atStart)}`);
  assert.ok(rate(data.afterLeadIn) >= 0.95, `после «слушай»: ${rate(data.afterLeadIn)}`);
  assert.equal(data.negative.filter((t) => wake.strip(t) !== null).length, 0);
});

test('ключевое слово посреди речи: ≥80% находится, длинная обычная речь не будит', () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/wake-asr.json'), 'utf8'));
  const wake = createWakeMatcher(['орион', 'orion']);
  const prefixes = ['так ну ладно', 'кот жирный', 'я сейчас приду', 'ну вот смотри', 'короче'];
  const mid = data.atStart.flatMap((t) => prefixes.map((p) => `${p} ${t}`));
  const found = mid.filter((t) => wake.strip(t) !== null).length / mid.length;
  assert.ok(found >= 0.8, `посреди речи: ${found}`);
  const glued = data.negative.flatMap((a, i) => data.negative.slice(i + 1, i + 4).map((b) => `${a} ${b}`));
  assert.deepEqual(glued.filter((t) => wake.strip(t) !== null), []);
  assert.equal(wake.strip('так ну ладно орион какая погода'), 'какая погода');
  assert.equal(wake.strip('кот жирный орёл включи музыку'), 'включи музыку');
  assert.equal(wake.strip('над горами летал орёл какой красивый'), null);
  assert.equal(wake.strip('орион орион включи музыку'), 'включи музыку');
});

test('ключевое слово: команда после имени сохраняется, похожие слова не будят', () => {
  const wake = createWakeMatcher(['орион', 'orion']);
  assert.equal(wake.strip('орион открой телеграм'), 'открой телеграм');
  assert.equal(wake.strip('ореон какая погода'), 'какая погода');
  assert.equal(wake.strip('арион включи музыку'), 'включи музыку');
  assert.equal(wake.strip('орёл какая погода'), 'какая погода');
  assert.equal(wake.strip('ори он включи музыку'), 'включи музыку');
  assert.equal(wake.strip('слушай орион включи музыку'), 'включи музыку');
  assert.equal(wake.strip('орион'), '');
  assert.equal(wake.strip('арип'), '', 'одно похожее слово — «слушаю»');
  for (const t of ['включи радио', 'в нашем регионе дожди', 'мы живём в районе', 'он выиграл миллион', 'алло', 'ирина пришла', 'я вчера говорил с орионом']) {
    assert.equal(wake.strip(t), null, t);
  }
});

// --- разговор ---

test('без обращения: продолжения и команды принимаются без модели', () => {
  for (const t of ['а завтра?', 'и дискорд тоже', 'спасибо', 'давай ещё один', 'включи какую-нибудь музыку на ютубе', 'какая погода']) {
    assert.ok(looksLikeContinuation(t), t);
  }
  for (const t of ['и тут он забивает гол на последней минуте матча', 'мам где носки', 'короче я купил машину']) {
    assert.ok(!looksLikeContinuation(t), t);
  }
});

test('обращение по голосу: сэр, мисс, гость', () => {
  assert.equal(applyHonorific('Готово, сэр.', 'сэр'), 'Готово, сэр.');
  assert.equal(applyHonorific('Готово, сэр. Сэр, ещё что-то?', 'мисс'), 'Готово, мисс. Мисс, ещё что-то?');
  assert.equal(applyHonorific('Открываю Telegram, сэр.', ''), 'Открываю Telegram.');
});

test('план модели: неизвестные инструменты и лишние действия отбрасываются', () => {
  const names = ['open_app', 'media'];
  const p = parsePlan('{"addressed":true,"say":"ок","actions":[{"tool":"open_app","arg":"x"},{"tool":"rm_rf","arg":"/"},{"tool":"media","arg":"next"},{"tool":"media","arg":"prev"},{"tool":"media","arg":"mute"}]}', names);
  assert.deepEqual(p.actions.map((a) => a.tool), ['open_app', 'media', 'media']);
  assert.equal(parsePlan('{"addressed":false,"say":"","actions":[]}', names).addressed, false);
  // arg вне перечня — действие отбрасывается
  const onlyNext = (tool, arg) => tool !== 'media' || arg === 'next';
  assert.deepEqual(parsePlan('{"topic":"music","actions":[{"tool":"media","arg":"louder"},{"tool":"media","arg":"next"}],"say":""}', names, onlyNext).actions, [{ tool: 'media', arg: 'next' }]);
  // порядок полей = порядок мысли: (addressed) → topic → actions → say
  assert.deepEqual(Object.keys(planSchema({ topics: ['chat'], action: {} }).properties), ['topic', 'actions', 'say']);
  assert.deepEqual(Object.keys(planSchema({ topics: ['chat'], action: {}, addressed: true }).properties), ['addressed', 'topic', 'actions', 'say']);
});

// --- навыки ---

test('реестр: все инструменты, промпт, отключение навыка, вызов навыка из навыка', async () => {
  const { skills } = makeRegistry();
  for (const t of ['weather', 'rate', 'web_search', 'open_app', 'close_app', 'minimize_all', 'youtube', 'media', 'now_playing', 'timer', 'profile', 'remember', 'remember_shared', 'forget', 'open_url', 'run_command', 'pc_status']) {
    assert.ok(skills.names().includes(t), t);
  }
  await skills.init();
  assert.match(skills.toolsPrompt(), /run_command .*заблокировать компьютер/, 'init() навыка дополняет описание');
  const off = makeRegistry({ skills: { music: { enabled: false } } }).skills;
  assert.ok(!off.names().includes('youtube'));

  // ctx.call: один навык вызывает другой — через временный навык-обёртку
  const probe = { id: 'probe', tools: [{ name: 'probe', use: 'x', arg: 'x', run: (a, c) => c.call('timer', 'cancel') }] };
  const { ctx } = makeRegistry();
  const reg = createSkillRegistry([...allSkills, probe], { config: ctx.config, ctx, audit: () => {}, platform: 'win32' });
  assert.match((await reg.run('probe', '')).message, /таймер/i);
});

test('быстрые команды плеера и «ещё»', () => {
  assert.deepEqual(music.quick('Пауза.').actions, [{ tool: 'media', arg: 'play_pause' }]);
  assert.deepEqual(music.quick('следующая песня').actions, [{ tool: 'media', arg: 'next' }]);
  assert.equal(music.quick('включи Кино'), null);
  assert.equal(music.quick('ещё'), null, '«ещё» без предыдущего действия — не команда');
});

test('YouTube: для прослушивания — не шортс и не многочасовая запись', () => {
  const v = [
    { id: 's', seconds: 30 },
    { id: 'long', seconds: 36000 },
    { id: 'song', seconds: 240 },
  ];
  assert.equal(pickForListening(v).id, 'song');
  assert.equal(pickForListening(v, { mix: true }).id, 'long');
});

test('таймер: секунды, текст, отмена, границы', async () => {
  const { skills, reminders } = makeRegistry();
  assert.equal((await skills.run('timer', '1|чайник')).ok, true);
  assert.equal((await skills.run('timer', '1')).ok, true);
  assert.equal((await skills.run('timer', 'abc')).ok, false);
  assert.equal((await skills.run('timer', '0|x')).ok, false);
  assert.equal(reminders.length, 0, 'таймер не должен срабатывать сразу');
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(reminders.sort(), ['время вышло', 'чайник']);
  assert.match((await skills.run('timer', 'cancel')).message, /таймер/i);
});

test('браузер открывается только явным browser_search и только http(s)', async () => {
  const { skills, opened } = makeRegistry();
  await skills.run('browser_search', 'рецепт борща');
  assert.match(opened[0], /^https:\/\/ya\.ru\/search\/\?text=/);
  assert.equal((await skills.run('open_url', 'file:///C:/Windows')).ok, false);
});

test('поиск программ: транслит и опечатки', () => {
  assert.ok(score('телеграм', 'Telegram') >= 90);
  assert.ok(score('дискорд', 'Discord') >= 90);
  assert.ok(score('стим', 'Steam') >= 90);
  assert.equal(score('фотошоп', 'Telegram'), 0);
});

// --- память ---

test('память раздельная по людям; гость ничего не записывает', async () => {
  const store = createMemory({ dir: tmp() });
  const dan = store.forPerson('p-dan');
  const ann = store.forPerson('p-ann');
  dan.setProfile('city=Липецк');
  dan.remember('Любит джаз');
  ann.remember('Любит классику');
  assert.match(dan.allFactsText(), /джаз/);
  assert.doesNotMatch(dan.allFactsText(), /классик/);
  assert.equal(ann.profile().city, undefined);
  assert.equal(store.forPerson(null).remember('x').ok, false);

  // память и навыки: погода берёт город конкретного собеседника
  const { skills, store: s2 } = makeRegistry();
  const mem = s2.forPerson('p-1');
  mem.remember('Живёт в Казани');
  assert.equal(weather.homeCity({ memory: mem, config: { city: 'Москва' } }), 'Казани');
  mem.setProfile('city=Липецк');
  assert.equal(weather.homeCity({ memory: mem, config: { city: 'Москва' } }), 'Липецк');
  assert.equal((await skills.run('remember', 'Любит чай', { memory: mem })).ok, true);
  assert.match(mem.allFactsText(), /чай/);
});

test('база знаний: обновление по номеру, без дубликатов, срок жизни, нечёткое «забудь»', () => {
  const m = createMemory({ dir: tmp() }).forPerson('p');
  m.remember('Предпочитает шутливый стиль общения');
  m.remember('Работает программистом');
  m.remember('Работает программистом');
  assert.equal(m.count(), 2);
  m.remember('#2 Работает дизайнером');
  assert.match(m.allFactsText(), /#2 Работает дизайнером/);
  m.remember('Собеседование завтра|1');
  assert.match(m.allFactsText(), /Собеседование завтра \(до/);
  assert.equal(m.forget('стель общение').ok, true, 'опечатки из распознавания');
  assert.equal(m.forget('что-то несуществующее').ok, false);
  assert.ok(similarity('стиль общения', 'Предпочитает шутливый стиль общения') >= 0.5);
});

// --- прочее ---

test('голосовой отпечаток: косинусная близость', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(Math.round(cosine([1, 0], [0, 1]) * 100), 0);
});

test('склонения для озвучки', () => {
  assert.equal(plural(3, 'градус', 'градуса', 'градусов'), 'градуса');
  assert.equal(plural(12, 'градус', 'градуса', 'градусов'), 'градусов');
  assert.equal(degrees(-3.4), 'минус 3 градуса');
});

test('страницы из выдачи: только публичные адреса, текст без меню', () => {
  assert.equal(isPublicUrl('https://example.com/a'), true);
  assert.equal(isPublicUrl('http://192.168.1.1/admin'), false);
  const html = '<nav><p>Меню сайта навигация</p></nav><p>Курс доллара сегодня составил 84 рубля по данным ЦБ.</p>';
  assert.equal(extractMainText(html, 'курс доллара'), 'Курс доллара сегодня составил 84 рубля по данным ЦБ.');
});

test('close_app закрывает программу, которую сам и открыл (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const { launch, listWindowedApps, closeProcessWindows } = require('../src/lib/windows');
  await launch('notepad.exe');
  let found = false;
  for (let i = 0; i < 20 && !found; i++) {
    await new Promise((r) => setTimeout(r, 300));
    found = (await listWindowedApps()).some((a) => a.name.toLowerCase() === 'notepad');
  }
  assert.ok(found, 'блокнот должен появиться среди окон');
  assert.ok((await closeProcessWindows('notepad')) >= 1);
  await assert.rejects(closeProcessWindows('explorer'), /нельзя/);
  await assert.rejects(closeProcessWindows("x'; rm"), /нельзя/, 'кавычки в имени запрещены');
});

test('речь: числа словами с согласованием, деньги, время, даты, «ё», названия', () => {
  const { normalizeForSpeech: n } = require('../src/lib/speech-text');
  assert.equal(n('Курс ЦБ: доллар — 84,34 рубля.'), 'Курс цэ-б+э: доллар — восемьдесят четыре рубля тридцать четыре копейки.');
  assert.equal(n('Напомню через 1 минуту, таймер на 2 минуты и 21 секунду.'), 'Напомню через одну минуту, таймер на две минуты и двадцать одну секунду.');
  assert.equal(n('1 окно, 2 недели, 22 дня, 1 час'), 'одно окно, две недели, двадцать два дня, один час');
  assert.equal(n('Биткоин стоит 84 116 долларов'), 'Биткоин стоит восемьдесят четыре тысячи сто шестнадцать долларов');
  assert.equal(n('Осадки 85%, -3°C, ветер 12 м/с'), 'Осадки восемьдесят пять процентов, минус три градуса, ветер двенадцать метров в секунду');
  assert.equal(n('в 10:30 и в 9:05'), 'в десять тридцать и в девять ноль пять');
  assert.equal(n('Встреча 26.09.2026'), 'Встреча двадцать шестого сентября две тысячи двадцать шестого года');
  for (const d of ['26.09.26', '26.09.2026 г.', '26.09.2026г.', '2026-09-26', '26/09/2026']) {
    assert.equal(n(d), 'двадцать шестого сентября две тысячи двадцать шестого года', d);
  }
  assert.equal(n('Сегодня 26.09, суббота'), 'Сегодня двадцать шестое сентября, суббота');
  assert.equal(n('к 26.09'), 'к двадцать шестому сентября');
  assert.equal(n('Цена 26.09 рубля'), 'Цена двадцать шесть рублей девять копеек');
  assert.equal(n('версия 1.05'), 'версия один точка ноль пять');
  assert.equal(n('Сегодня 26 сентября'), 'Сегодня двадцать шестое сентября');
  assert.equal(n('в 1962 году'), 'в тысяча девятьсот шестьдесят втором году');
  assert.equal(n('Гагарин полетел 12 апреля 1961 года'), 'Гагарин полетел двенадцатого апреля тысяча девятьсот шестьдесят первого года');
  assert.equal(n('к 2030 году, с 2000 года, 1812 год'), 'к две тысячи тридцатому году, с двухтысячного года, тысяча восемьсот двенадцатый год');
  assert.equal(n('с 12 по 15 апреля'), 'с двенадцатого по пятнадцатое апреля');
  assert.equal(n('от плюс 5 до плюс 8, около 1 минуты'), 'от плюс пяти до плюс восьми, около одной минуты');
  assert.equal(n('с 5 друзьями и с 2 детьми'), 'с пятью друзьями и с двумя детьми');
  assert.equal(n('Тон стоит 1,48 доллара'), 'Тон стоит один доллар сорок восемь центов');
  assert.equal(n('Еще немного, он идет вперед. Все хорошо.'), 'Ещё немного, он идёт вперёд. Все хорошо.');
  assert.equal(n('Открываю YouTube и Telegram'), 'Открываю ютуб и телеграм');
});

test('общая память: место и факты не о человеке, видна всем, отдельные номера', async () => {
  const { skills, store } = makeRegistry();
  const dan = store.forPerson('p-dan');
  const req = { memory: dan };
  assert.equal((await skills.run('remember_shared', 'city=Липецк', req)).ok, true);
  assert.equal((await skills.run('remember_shared', 'Дома живёт кот Барсик', req)).ok, true);
  assert.equal((await skills.run('remember', 'Любит джаз', req)).ok, true);
  assert.equal(store.shared.profile().city, 'Липецк');
  assert.match(store.shared.allFactsText(), /Барсик/);
  assert.doesNotMatch(dan.allFactsText(), /Барсик/);
  // погода: у собеседника без города — город из общей памяти
  assert.equal(weather.homeCity({ memory: store.forPerson('p-ann'), shared: store.shared, config: { city: 'Москва' } }), 'Липецк');
  // забыть: «#о1» — общий, описание — сначала личное, потом общее
  assert.equal((await skills.run('forget', 'барсик', req)).ok, true);
  assert.doesNotMatch(store.shared.allFactsText(), /Барсик/);
  assert.match(dan.allFactsText(), /джаз/);
});

test('голос: калибровка порога под разброс фраз, среднее лучших образцов', () => {
  const { calibrate, personScore } = require('../src/core/speaker');
  const near = (k) => Float32Array.from([1, k, 0]);
  const tight = [near(0.05), near(0.1), near(0.15), near(0.2)];
  const loose = [near(0.1), near(0.9), Float32Array.from([1, 0, 1]), Float32Array.from([0.5, 0.5, 0.5])];
  assert.ok(calibrate(tight, 0.42) >= calibrate(loose, 0.42), 'разброс больше — порог ниже');
  assert.ok(calibrate(loose, 0.42) >= 0.3 && calibrate(tight, 0.42) <= 0.55, 'в допустимых пределах');
  assert.ok(personScore(tight, near(0.1)) > 0.99);
});

test('голос: похожий записанный голос поднимает порог, но не выше сходства своих фраз', () => {
  const { calibrate, levelDb } = require('../src/core/speaker');
  const v = (a, b, c) => Float32Array.from([a, b, c]);
  const own = [v(1, 0.3, 0), v(1, 0.5, 0.1), v(1, 0.2, 0.3), v(1, 0.6, 0.2)];
  const alone = calibrate(own, 0.42);
  const withTwin = calibrate(own, 0.42, alone + 0.1);
  assert.ok(withTwin > alone, 'похожий голос — порог выше');
  assert.ok(withTwin <= 0.6);
  const quiet = new Float32Array(1600).fill(0.01);
  assert.ok(Math.abs(levelDb(quiet) + 40) < 0.5, 'громкость в дБ');
});

test('продолжение диалога: подтверждённый голос не отсекается, обращение к другому — проверяется', () => {
  const { talksToOther } = require('../src/core/assistant');
  assert.equal(talksToOther('мам, а где ключи'), true);
  assert.equal(talksToOther('меня как зовут поищу себя'), false);
  assert.equal(talksToOther('артём очисти диалог'), false);
});

test('состояние ПК: фраза из цифр, предупреждения, быстрые команды', () => {
  const pc = require('../src/skills/pc');
  const GB = 1024 ** 3;
  const base = {
    cpu: 12, memTotal: 16 * GB, memFree: 6 * GB, uptime: 3600,
    disks: [{ drive: 'C', size: 500 * GB, free: 120 * GB }], battery: null,
    topMem: [{ name: 'Google Chrome', mem: 3 * GB }], topCpu: [{ name: 'chrome', cpu: 8 }],
  };
  const ok = pc.report(base);
  assert.match(ok, /12 процентов/);
  assert.match(ok, /10 гигабайт из 16 гигабайт/);
  assert.match(ok, /диске C свободно 120 гигабайт из 500 гигабайт/);
  assert.match(pc.report({ ...base, memTotal: 31 * GB }), /из 31 гигабайта/);
  assert.match(ok, /всё в порядке/);
  const bad = pc.report({ ...base, cpu: 97, memFree: 1 * GB, uptime: 9 * 86400, disks: [{ drive: 'C', size: 500 * GB, free: 4 * GB }], battery: { charge: 15, charging: false } });
  assert.match(bad, /перегружен/);
  assert.match(bad, /оперативной памяти/);
  assert.match(bad, /мало места на диске C/);
  assert.match(bad, /батарея почти разряжена/);
  assert.match(bad, /9 дней/);
  assert.match(bad, /больше всех его нагружает chrome/);
  assert.match(pc.report(base, 'processes'), /Google Chrome — 3 гигабайта/);
  assert.equal(pc.focusOf('Память'), 'memory');

  const arg = (t) => pc.quick(t)?.actions[0].arg;
  assert.equal(arg('как там мой компьютер'), '');
  assert.equal(arg('проверь состояние компьютера'), '');
  assert.equal(arg('почему комп тормозит'), 'процессы');
  assert.equal(arg('что грузит процессор'), 'процессы');
  assert.equal(arg('сколько места на диске'), 'диск');
  assert.equal(arg('сколько свободно оперативной памяти'), 'память');
  for (const t of ['открой диск C', 'как дела', 'включи музыку', 'как настроить компьютер для игр']) assert.equal(pc.quick(t), null, t);
});

test('погода: какие дни понимает', () => {
  const { parseWhen } = require('../src/skills/weather');
  const sat = new Date(2026, 8, 26); // суббота
  assert.deepEqual(parseWhen('', sat), [0]);
  assert.deepEqual(parseWhen('завтра', sat), [1]);
  assert.deepEqual(parseWhen('послезавтра', sat), [2]);
  assert.deepEqual(parseWhen('в понедельник', sat), [2], '«понедельник» — не «неделя»');
  assert.deepEqual(parseWhen('во вторник', sat), [3]);
  assert.deepEqual(parseWhen('через три дня', sat), [3]);
  assert.deepEqual(parseWhen('через 5 дней', sat), [5]);
  assert.deepEqual(parseWhen('28 сентября', sat), [2]);
  assert.deepEqual(parseWhen('3.10', sat), [7]);
  assert.deepEqual(parseWhen('неделя', sat), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(parseWhen('непонятно', sat), null);
});

test('имя: личные варианты произношения учатся, обычные слова — нет', () => {
  const wake = createWakeMatcher(['орион', 'orion']);
  assert.equal(wake.strip('радион и всё'), null);
  assert.deepEqual(wake.learn(['радион', 'алло', 'кот', 'включи']), ['радион']);
  assert.equal(wake.strip('радион и всё'), 'и все');
  assert.equal(wake.strip('алло кто это'), null);
  assert.equal(wake.nearMiss('кот жирный'), null, 'непохожее не пишется в журнал промахов');
  assert.equal(typeof wake.nearMiss('арбидон включи'), 'string', 'похожее на имя — пишется');
});

test('искажённое имя с вопросом и обращение при подтверждённом голосе', () => {
  const wake = createWakeMatcher(['орион', 'orion']);
  assert.equal(wake.strip('алён как меня зовут'), 'как меня зовут');
  assert.equal(wake.strip('ален скажи погоду'), 'скажи погоду');
  for (const t of ['алло как дела', 'ирина как дела', 'кот как дела']) assert.equal(wake.strip(t), null, t);
  const { looksAddressed } = require('../src/core/assistant');
  for (const t of ['в городе ты находишься', 'в каком городе ты находишься', 'можешь включить свет', 'где мои ключи']) assert.ok(looksAddressed(t), t);
  for (const t of ['мам где носки', 'ну я ему и говорю', 'последние новости это про наркотики да']) assert.ok(!looksAddressed(t), t);
});

// --- база знаний навыков ---

test('база знаний: каталог всегда, подробности — только нужных навыков', async () => {
  const { skills } = makeRegistry();
  await skills.init();
  const catalog = skills.catalogPrompt();
  for (const id of skills.ids()) assert.match(catalog, new RegExp(`^- ${id}: `, 'm'), id);
  assert.doesNotMatch(catalog, /smarthome/, 'умный дом без настроек не подключается');

  const pick = (t, recent) => skills.select(t, recent);
  assert.ok(pick('какая погода в Казани').includes('weather'));
  assert.ok(pick('добавь молоко в список покупок').includes('notes'));
  assert.ok(pick('громкость на 30').includes('sound'));
  assert.ok(!pick('как дела').includes('notes'), '«дела» в «как дела» — не список дел');
  assert.ok(!pick('включи Кино').includes('web'), '«включи» — не «вк»');
  assert.ok(pick('кто такой Илон Маск').includes('search'), 'поиск — всегда');
  assert.ok(pick('а завтра?', ['weather']).includes('weather'), 'навык из прошлой реплики остаётся под рукой');
  assert.ok(pick('что-нибудь').length <= 5);

  const full = skills.detailsPrompt().length;
  const one = skills.detailsPrompt(pick('какая погода'));
  assert.ok(one.length * 4 < full, `подробности на фразу (${one.length}) намного короче всех (${full})`);
  assert.match(one, /- weather — /);
  assert.doesNotMatch(one, /- youtube — /);
  assert.deepEqual(skills.names(['rates']), ['rate'], 'модель может позвать только инструменты выбранных навыков');
  // инструменты с перечнем arg — отдельными вариантами схемы: грамматика не даст написать другое значение
  const schema = skills.actionSchema(['music', 'rates']);
  const media = schema.anyOf.find((v) => v.properties.tool.enum[0] === 'media');
  assert.deepEqual(media.properties.arg.enum, ['play_pause', 'next', 'prev', 'volume_up', 'volume_down', 'mute']);
  assert.ok(schema.anyOf.some((v) => v.properties.tool.enum.includes('rate') && v.properties.arg.type === 'string' && !v.properties.arg.enum));
  assert.match(skills.detailsPrompt(['music']), /media — .*"next"/, 'в описании — те же значения');
  assert.equal(skills.likely('сколько дней до отпуска'), 'dates');
  assert.equal(skills.likely('я так устал сегодня'), null, 'память не подсказываем: рассказ о себе — не команда');
  assert.equal(skills.resolve('weather'), 'weather');
  assert.equal(skills.resolve('note_add'), 'notes', 'по имени инструмента');
  assert.equal(skills.resolve('нет такого'), null);
});

// Подставная модель: отвечает по очереди заготовками и запоминает, что ей показали
function fakeLlm(answers) {
  const calls = [];
  const toolsOf = (format) => {
    const items = format.properties.actions.items;
    return (items.anyOf || [items]).flatMap((v) => v.properties.tool.enum);
  };
  const chat = async (messages, format, options = {}) => {
    calls.push({ messages, system: messages[0].content, tools: toolsOf(format), format, options });
    return answers[Math.min(calls.length, answers.length) - 1];
  };
  return { llm: { chat }, calls };
}

test('база знаний: модель назвала навык в topic — он подгружается и запрос повторяется', async () => {
  const { skills, store, ctx } = makeRegistry();
  const { llm, calls } = fakeLlm([
    '{"topic":"calc","actions":[],"say":""}',
    '{"topic":"calc","actions":[{"tool":"calc","arg":"2+2"}],"say":""}',
  ]);
  const assistant = createAssistant({ config: ctx.config, llm, skills, memory: store, audit: () => {}, notify: () => {} });
  const r = await assistant.handle('реши-ка задачку про яблоки', { source: 'text' });
  await assistant.reset();
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].tools.includes('calc') && calls[1].tools.includes('calc'));
  assert.match(calls[1].system, /- calc — /);
  assert.match(r.say, /4/, 'в окне ответ как есть — цифрами; словами его делает только синтез');
  assert.equal(calls[0].options.temperature, 0.1, 'план — почти без случайности');
});

test('план: подсказка при расхождении с роутером, температура для шуток, история с цифрами и действиями', async () => {
  const { skills, store, ctx } = makeRegistry();
  const mk = (answers) => {
    const f = fakeLlm(answers);
    return { ...f, assistant: createAssistant({ config: ctx.config, llm: f.llm, skills, memory: store, audit: () => {}, notify: () => {} }) };
  };

  // слова называют навык dates, а модель ничего не сделала — второй запрос с подсказкой
  let t = mk(['{"topic":"chat","actions":[],"say":"Много."}', '{"topic":"dates","actions":[{"tool":"date_info","arg":"until 12-31"}],"say":""}']);
  let r = await t.assistant.handle('сколько дней до отпуска в декабре', { source: 'text' });
  await t.assistant.reset();
  assert.equal(t.calls.length, 2);
  assert.match(t.calls[1].messages.at(-1).content, /подсказка: .*dates/);
  assert.deepEqual(r.actions, [{ tool: 'date_info', arg: 'until 12-31' }]);

  // просто разговор — без повторов
  t = mk(['{"topic":"chat","actions":[],"say":"Сочувствую."}']);
  await t.assistant.handle('я так устал сегодня', { source: 'text' });
  await t.assistant.reset();
  assert.equal(t.calls.length, 1);

  // анекдот — с обычной температурой
  t = mk(['{"topic":"chat","actions":[],"say":"Шутка."}']);
  await t.assistant.handle('расскажи анекдот', { source: 'text' });
  await t.assistant.reset();
  assert.equal(t.calls[0].options.temperature, undefined);

  // в историю — JSON плана с цифрами (не озвученный текст) и действиями
  t = mk(['{"topic":"calc","actions":[{"tool":"calc","arg":"20+1"}],"say":""}', '{"topic":"chat","actions":[],"say":"ок"}']);
  r = await t.assistant.handle('сколько будет 20 плюс 1', { source: 'text' });
  assert.match(r.say, /21/, 'в окне — цифрами');
  assert.match(require('../src/lib/speech-text').normalizeForSpeech(r.say), /двадцать один/, 'озвучка — словами');
  await t.assistant.handle('спасибо', { source: 'text' });
  await t.assistant.reset();
  const history = JSON.parse(t.calls[1].messages.find((m) => m.role === 'assistant').content);
  assert.deepEqual(history.actions, [{ tool: 'calc', arg: '20+1' }]);
  assert.equal(history.topic, 'calc');
  assert.match(history.say, /21/);

  // addressed — только для фраз без имени
  t = mk(['{"addressed":false,"topic":"chat","actions":[],"say":""}']);
  r = await t.assistant.handle('ну я ему и говорю', { source: 'followup' });
  assert.equal(r.ignored, true);
  assert.ok('addressed' in t.calls[0].format.properties);
});

test('навыки исправляют аргумент модели по исходной фразе', async () => {
  const { skills } = makeRegistry();
  const all = require('../src/skills');
  const norm = (tool, arg, text) => all.flatMap((s) => s.tools || []).find((t) => t.name === tool).normalize(arg, text);
  assert.equal(norm('weather', 'Москва|сегодня', 'какая погода'), 'Москва');
  assert.equal(norm('weather', 'Казань|завтра', 'а завтра'), 'Казань|завтра');
  assert.equal(norm('pc_status', '', 'почему комп тормозит'), 'процессы');
  assert.equal(norm('clipboard', 'translate', 'переведи скопированное на немецкий'), 'translate немецкий');
  assert.equal(norm('clipboard', 'read', 'перескажи скопированный текст'), 'summary');
  assert.equal(norm('date_info', '2026-10-05', 'какой день недели 5 октября'), 'weekday 2026-10-05');
  assert.equal(norm('volume', 'на сколько-то тише', 'сделай на 20 тише'), '-20');
  assert.equal(norm('volume', 'unmute', 'включи звук'), 'unmute');
  // длительность — из фразы: модель путает минуты с секундами
  assert.equal(norm('power', 'restart 600', 'перезагрузи комп через 10 минут'), 'restart 10');
  assert.equal(norm('power', 'shutdown 3600', 'выключи компьютер через час'), 'shutdown 60');
  assert.equal(norm('sleep_timer', '3600', 'и выключи его через час'), '60');
  assert.equal(norm('timer', '10|выключить чайник', 'напомни через 10 минут выключить чайник'), '600|выключить чайник');
  assert.equal(norm('timer', 'cancel', 'отмени таймер на 5 минут'), 'cancel');
  // просили файл, а модель создаёт папку
  assert.equal(norm('file_op', 'mkdir текст документы|рабочий стол', 'создай на рабочем столе текст документы'), 'newfile текст документы|рабочий стол');
  assert.equal(norm('file_op', 'mkdir отпуск|рабочий стол', 'создай на рабочем столе папку отпуск'), 'mkdir отпуск|рабочий стол');
  const { durationFromText: dur } = require('../src/lib/ru');
  assert.equal(dur('через два часа пятнадцать минут'), 8100);
  assert.equal(dur('на полчаса'), 1800);
  assert.equal(dur('через 10 минут выключи чайник, он кипит 5 минут'), 600, 'только первая длительность');
  assert.equal(dur('какая погода сейчас'), null, '«сейчас» — не час');
  assert.equal(dur('я часто слушаю музыку'), null);
  // исправление применяется только к аргументу от модели (с исходной фразой), не к вызовам из навыков
  assert.equal((await skills.run('calc', '2+2', { text: 'сколько будет два плюс два' })).speak, 'Получается 4.');
});

test('новые навыки: напоминания, списки, калькулятор, даты, громкость, сценарии', async () => {
  const reminders = require('../src/skills/reminders');
  const now = new Date(2026, 8, 26, 10, 0);
  assert.equal(new Date(reminders.parse('tomorrow 09:00|мама', now).at).getDate(), 27);
  assert.equal(new Date(reminders.parse('09:00|x', now).at).getDate(), 27, 'время уже прошло — завтра');
  assert.equal(new Date(reminders.parse('11:30|x', now).at).getDate(), 26);
  assert.equal(reminders.parse('every 60|вода', now).every, 60);
  assert.ok(reminders.parse('every 1|x', now).error);
  assert.ok(reminders.parse('2025-01-01 10:00|x', now).error);

  const { skills, ctx } = makeRegistry();
  await skills.init();
  assert.equal((await skills.run('note_add', 'список покупок|молоко; хлеб')).ok, true);
  assert.match((await skills.run('note_show', 'покупки')).speak, /молоко, хлеб/);
  assert.match((await skills.run('note_remove', 'покупки|хлеб')).speak, /хлеб/);
  assert.doesNotMatch((await skills.run('note_show', 'покупки')).speak, /хлеб/);

  const calc = require('../src/skills/calc');
  assert.equal(calc.evaluate('3400*15%'), 510);
  assert.equal(calc.evaluate('(1,5+2)^2'), 12.25);
  assert.equal(calc.evaluate('2**3'), 8);
  assert.throws(() => calc.evaluate('process.exit()'));
  assert.equal((await skills.run('calc', '1/0')).ok, false);

  const rates = require('../src/skills/rates');
  assert.deepEqual(rates.parseArg('USD'), { code: 'USD', amount: null });
  assert.deepEqual(rates.parseArg('25 USD'), { code: 'USD', amount: 25 });
  assert.deepEqual(rates.parseArg('1 000,5 eur'), { code: 'EUR', amount: 1000.5 });

  const dates = require('../src/skills/dates');
  assert.match(dates.dateInfo('until 01-01', now), /97 дней/);
  assert.match(dates.dateInfo('weekday 2026-10-05', now), /понедельник/);
  assert.equal(dates.quick('сколько дней до нового года').actions[0].arg, 'until 01-01');
  assert.equal(dates.quick('сколько осталось до дня рождения'), null, 'день рождения — не Рождество');
  assert.match(dates.quick('Который час?').say, /^Сейчас \d+:\d\d\.$/);

  const sound = require('../src/skills/sound');
  assert.equal(sound.quick('громкость на тридцать пять процентов').actions[0].arg, '35');
  assert.equal(sound.quick('громкость 30').actions[0].arg, '30');
  assert.equal(sound.quick('громче'), null, 'без числа — медиа-клавиша');

  // сценарий: шаги выполняются как обычные фразы через ctx.perform
  const performed = [];
  ctx.perform = async (text) => (performed.push(text), `сделано: ${text}`);
  assert.equal((await skills.run('scenario_save', 'Я дома|включи джаз; какая погода')).ok, true);
  const plan = skills.quickPlan('я дома');
  assert.deepEqual(plan.actions, [{ tool: 'scenario_run', arg: 'я дома' }]);
  assert.match((await skills.run('scenario_run', 'я дома')).speak, /сделано: включи джаз сделано: какая погода/);
  assert.deepEqual(performed, ['включи джаз', 'какая погода']);
  assert.equal(skills.quickPlan('я дома и мне скучно'), null, 'только точное название');

  const journal = require('../src/skills/journal');
  const day = new Date();
  const log = [
    { t: day.toISOString(), input: 'открой телеграм' },
    { t: day.toISOString(), skill: 'apps', tool: 'open_app', arg: 'телеграм', ok: true },
    { t: day.toISOString(), youtube: 'Кино — Группа крови' },
  ];
  assert.match(journal.report(log, day), /1 команда.*телеграм.*Группа крови/s);
});

test('ПК в фоне: предупреждает о месте, заряде и памяти', () => {
  const pc = require('../src/skills/pc');
  const GB = 1024 ** 3;
  const calm = { memTotal: 16 * GB, memFree: 8 * GB, disks: [{ drive: 'C', size: 500 * GB, free: 100 * GB }], battery: null };
  assert.deepEqual(pc.warnings(calm), []);
  const bad = pc.warnings({ memTotal: 16 * GB, memFree: 0.5 * GB, disks: [{ drive: 'D', size: 500 * GB, free: 2 * GB }], battery: { charge: 10, charging: false } });
  assert.deepEqual(bad.map(([k]) => k), ['disk-D', 'battery', 'memory']);
  assert.equal(pc.warnings({ ...calm, battery: { charge: 10, charging: true } }).length, 0, 'на зарядке — не тревожим');
});

test('речь: диапазоны лет и десятилетия', () => {
  const { normalizeForSpeech: n } = require('../src/lib/speech-text');
  assert.equal(n('в период 1905—1907 годов'), 'в период тысяча девятьсот пятого — тысяча девятьсот седьмого годов');
  assert.equal(n('в 1905-1907 годах'), 'в тысяча девятьсот пятом — тысяча девятьсот седьмом годах');
  assert.equal(n('война 1914-1918'), 'война тысяча девятьсот четырнадцатого — тысяча девятьсот восемнадцатого годов');
  assert.equal(n('с 1905 по 1907 год'), 'с тысяча девятьсот пятого по тысяча девятьсот седьмой год');
  assert.equal(n('в 1990-х'), 'в девяностых');
  assert.equal(n('2-3 дня'), 'два-три дня', 'маленькие числа через дефис — не годы');
});

test('золотая рыбка: конец разговора — реплики забыты, окно получает сигнал стереть их', async () => {
  const { skills, store, ctx } = makeRegistry();
  const ended = [];
  const { llm, calls } = fakeLlm(['{"topic":"chat","actions":[],"say":"Привет."}']);
  const assistant = createAssistant({ config: ctx.config, llm, skills, memory: store, audit: () => {}, notify: () => {}, onSessionEnd: (r) => ended.push(r) });
  await assistant.handle('привет', { source: 'wake' });
  await assistant.endSession('конец диалога');
  assert.deepEqual(ended, ['конец диалога']);
  await assistant.handle('как дела', { source: 'wake' });
  const last = calls.at(-1).messages;
  assert.equal(last.filter((m) => m.role !== 'system').length, 1, 'в новый разговор прошлые реплики не попадают');
  await assistant.reset();
  assert.equal(ended.at(-1), 'новый разговор');
});

test('другой голос закрывает разговор, только если обращается к Ориону', async () => {
  const { skills, store, ctx } = makeRegistry();
  const ended = [];
  const answers = [];
  const llm = { chat: async (messages) => (answers.push(messages), answers.length === 2 ? '{"addressed":false,"topic":"chat","actions":[],"say":""}' : '{"addressed":true,"topic":"chat","actions":[],"say":"Да."}') };
  const assistant = createAssistant({ config: ctx.config, llm, skills, memory: store, audit: () => {}, notify: () => {}, onSessionEnd: (r) => ended.push(r) });
  const dan = { id: 'p-dan', honorific: 'сэр' };
  const ann = { id: 'p-ann', honorific: 'мисс' };
  await assistant.handle('привет', { source: 'wake', person: dan });
  // Анна говорит рядом не Ориону — разговор с Даном продолжается
  assert.equal((await assistant.handle('пойдём уже ужинать', { source: 'followup', person: ann })).ignored, true);
  assert.deepEqual(ended, []);
  // Анна обратилась к Ориону — теперь разговор с Даном закрыт
  await assistant.handle('Орион, какая погода', { source: 'wake', person: ann });
  assert.deepEqual(ended, ['смена собеседника']);
  await assistant.reset();
});

test('речь: сокращения разрядов и единиц — словами, с согласованием и падежом', () => {
  const { normalizeForSpeech: n } = require('../src/lib/speech-text');
  assert.equal(n('Население — 13 млн человек.'), 'Население — тринадцать миллионов человек.');
  assert.equal(n('Выручка 1,5 млрд ₽.'), 'Выручка полтора миллиарда рублей.');
  assert.equal(n('Сделка на $2 млрд. Это рекорд.'), 'Сделка на два миллиарда долларов. Это рекорд.');
  assert.equal(n('Около 1 млн просмотров.'), 'Около одного миллиона просмотров.');
  assert.equal(n('от 1 млн до 5 млн'), 'от одного миллиона до пяти миллионов');
  assert.equal(n('Зарплата 150 тыс. рублей.'), 'Зарплата сто пятьдесят тысяч рублей.');
  assert.equal(n('1,5 тыс. шагов'), 'полторы тысячи шагов');
  assert.equal(n('Купил 3 шт. за 2 ч.'), 'Купил три штуки за два часа.');
  assert.equal(n('Диск на 512 ГБ.'), 'Диск на пятьсот двенадцать гигабайт.');
  assert.equal(n('несколько млн человек'), 'несколько миллионов человек');
});

test('речь: счёт лет не путается с годом, римские цифры — словами', () => {
  const { normalizeForSpeech: n } = require('../src/lib/speech-text');
  assert.equal(
    n('Липецк отмечает 323 года со дня основания по указу Петра I в 1703 году.'),
    'Липецк отмечает триста двадцать три года со дня основания по указу Петра первого в тысяча семьсот третьем году.',
  );
  assert.equal(n('Городу 323 года.'), 'Городу триста двадцать три года.');
  assert.equal(n('в 323 году'), 'в триста двадцать третьем году');
  assert.equal(n('321 год до н. э.'), 'триста двадцать первый год до нашей эры');
  assert.equal(n('около 1703 года'), 'около тысяча семьсот третьего года');
  assert.equal(n('Пётр I основал Петербург.'), 'Пётр первый основал Петербург.');
  assert.equal(n('Указ Екатерины II.'), 'Указ Екатерины второй.');
  assert.equal(n('При Николае II.'), 'При Николае втором.');
  assert.equal(n('Это было в XIX в. Потом'), 'Это было в девятнадцатом веке. Потом');
  assert.equal(n('XVIII–XIX веков'), 'восемнадцатого — девятнадцатого веков');
  assert.equal(n('глава IV'), 'глава четвёртая');
  assert.equal(n('I love you'), 'I love you');
});

test('Steam: библиотека из VDF, игра по искажённому названию; факты: первое предложение статьи', () => {
  const { parseVdf, pick } = require('../src/lib/vdf');
  const v = parseVdf('"AppState"\n{\n\t"appid"\t\t"1422450"\n\t"name"\t\t"Deadlock"\n\t"Inner" { "Apps" { "730" { "Playtime" "11" } } }\n}');
  assert.equal(pick(v, 'appstate', 'name'), 'Deadlock');
  assert.equal(pick(v, 'AppState', 'inner', 'apps', '730', 'playtime'), '11', 'ключи без учёта регистра');

  const steam = require('../src/skills/steam');
  const games = ['Teardown', 'Deadlock', 'Counter-Strike 2', 'Bodycam', 'MECCHA CHAMELEON'].map((name, id) => ({ id: String(id), name }));
  const find = (q) => steam.findGame(q, games)?.name;
  assert.equal(find('дедлок'), 'Deadlock');
  assert.equal(find('тирдаун'), 'Teardown', 'похожее звучание');
  assert.equal(find('кс'), 'Counter-Strike 2', 'народное название');
  assert.equal(find('контр страйк'), 'Counter-Strike 2');
  assert.equal(find('бодикам'), 'Bodycam');
  assert.equal(find('погода'), undefined);

  const { firstSentence } = require('../src/skills/facts');
  assert.equal(
    firstSentence('«Степной король Лир» (1870) — повесть Ивана Тургенева. Написана в Баден-Бадене.'),
    '«Степной король Лир» — повесть Ивана Тургенева.',
  );
});

test('потоковая речь: разговорный ответ звучит по предложениям, пока модель пишет; действия — нет', async () => {
  const { createSayStreamer } = require('../src/core/assistant');
  const feed = (json) => {
    const out = [];
    const s = createSayStreamer((t) => out.push(t));
    for (let i = 1; i <= json.length; i++) s.onText(json.slice(0, i));
    s.finish();
    return out;
  };
  assert.deepEqual(feed(JSON.stringify({ topic: 'chat', actions: [], say: 'Раз, сэр. Приходит "Вовочка" в школу! И всё.' })), ['Раз, сэр.', 'Приходит "Вовочка" в школу!', 'И всё.']);
  assert.deepEqual(feed(JSON.stringify({ topic: 'weather', actions: [{ tool: 'weather', arg: '' }], say: 'Сейчас. Посмотрю.' })), [], 'с действиями — не говорим заранее');
  assert.deepEqual(feed(JSON.stringify({ addressed: false, topic: 'chat', actions: [], say: '' })), []);

  // через ассистента: модель отдаёт ответ кусками
  const { skills, store, ctx } = makeRegistry();
  const streamingLlm = (json) => ({
    chat: async (messages, format, options, onText) => {
      if (onText) for (let i = 1; i <= json.length; i += 7) onText(json.slice(0, i));
      return json;
    },
  });
  const mk = (json) => createAssistant({ config: ctx.config, llm: streamingLlm(json), skills, memory: store, audit: () => {}, notify: () => {} });
  const parts = [];
  let a = mk(JSON.stringify({ topic: 'chat', actions: [], say: 'У меня 2 новости. Обе хорошие.' }));
  let r = await a.handle('расскажи анекдот', { source: 'wake', onSay: (t) => parts.push(t) });
  await a.reset();
  assert.equal(r.streamed, true);
  assert.deepEqual(parts, ['У меня 2 новости.', 'Обе хорошие.'], 'по предложениям, как написано (словами — только в синтезе)');
  // фраза называет навык — план могут переспросить с подсказкой: заранее не говорим
  parts.length = 0;
  a = mk(JSON.stringify({ topic: 'chat', actions: [], say: 'Не знаю.' }));
  r = await a.handle('сколько дней до отпуска', { source: 'wake', onSay: (t) => parts.push(t) });
  await a.reset();
  assert.deepEqual(parts, []);
  assert.ok(!r.streamed);
});

test('«очисти диалог» — без модели; «забудь» находит и напоминание; промахи из журнала', async () => {
  const { skills, store, ctx } = makeRegistry();
  const ended = [];
  const { llm, calls } = fakeLlm(['{"topic":"chat","actions":[],"say":"Привет."}']);
  const assistant = createAssistant({ config: ctx.config, llm, skills, memory: store, audit: () => {}, notify: () => {}, onSessionEnd: (r) => ended.push(r) });
  await assistant.handle('привет', { source: 'wake' });
  const r = await assistant.handle('артём очистый диалог', { source: 'wake' });
  assert.match(r.say, /чистого листа/);
  assert.equal(calls.length, 1, 'модель не спрашивали');
  assert.deepEqual(ended, ['новый разговор']);
  await assistant.reset();

  // напоминание про стоматолога есть, факта в памяти нет: «забудь» отменяет напоминание
  await skills.init();
  const dan = store.forPerson('p-dan');
  const req = { text: 'забудь про стоматолога', memory: dan };
  assert.equal((await skills.run('remind_at', 'tomorrow 10:00|визит к стоматологу', req)).ok, true);
  assert.match((await skills.run('forget', 'стоматолог', req)).speak, /напоминание/);
  assert.match((await skills.run('reminders', '', req)).speak, /нет/);
  // модель выбрала отмену напоминания, а это факт в памяти — забывается факт
  dan.remember('Завтра визит к стоматологу|2');
  assert.equal((await skills.run('reminders', 'cancel стоматолог', req)).ok, true);
  assert.doesNotMatch(dan.allFactsText(), /стоматолог/);

  const pc = require('../src/skills/pc');
  const music = require('../src/skills/music');
  assert.equal(pc.quick('можешь сказать состояние пока').actions[0].tool, 'pc_status', '«пока» — это «ПК»');
  assert.equal(pc.quick('как дела'), null);
  assert.equal(pc.quick('пока'), null);
  assert.deepEqual(music.quick('играй дальше').actions, [{ tool: 'media', arg: 'play_pause' }]);
});

test('скорость отклика: обрезка тишины синтеза, оборванная реплика, заготовка, ответ поиска по предложениям', async () => {
  // Тишина по краям синтезированной речи срезается, тихое начало слова — нет
  const { trimSilence } = require('../src/core/speech');
  const sr = 1000;
  const audio = new Float32Array(2000);
  for (let i = 500; i < 1200; i++) audio[i] = i < 520 ? 0.002 : 0.5; // тихое начало, потом громко
  const trimmed = trimSilence(audio, sr);
  assert.equal(trimmed.length, 700 + 40 + 100, 'по краям остаётся 40 мс и 100 мс');
  assert.equal(trimmed[40], Math.fround(0.002), 'тихое начало слова на месте');
  assert.equal(trimSilence(new Float32Array(100), sr).length, 100, 'сплошная тишина — как есть');

  // Все инструменты отвечают сами — реплику модели не дописываем
  const { skills, store, ctx } = makeRegistry();
  const { STOP } = require('../src/core/llm');
  let stopped = false;
  const json = JSON.stringify({ topic: 'weather', actions: [{ tool: 'weather', arg: 'Казань' }], say: 'Сейчас посмотрю погоду, сэр.' });
  const cutLlm = {
    chat: async (messages, format, options, onText) => {
      for (let i = 1; i <= json.length; i++) if (onText(json.slice(0, i)) === STOP) return (stopped = true), json.slice(0, i);
      return json;
    },
  };
  const ran = [];
  const quiet = { ...skills, run: async (tool, arg) => (ran.push([tool, arg]), { ok: true, speak: 'В Казани плюс 5.' }) };
  let fillers = [];
  let waited = 0;
  let a = createAssistant({ config: ctx.config, llm: cutLlm, skills: quiet, memory: store, audit: () => {}, notify: () => {} });
  let r = await a.handle('погода в казани', { source: 'wake', onFiller: (t) => fillers.push(t), beforeActions: async () => waited++ });
  await a.reset();
  assert.ok(stopped, 'генерация оборвана после списка действий');
  assert.deepEqual(ran, [['weather', 'Казань']]);
  assert.equal(waited, 1, 'действия ждали конца речи');
  assert.deepEqual(fillers, [], 'погода быстрая — без заготовки');

  // Инструмент без собственного ответа — реплика модели нужна, генерация идёт до конца
  const openJson = JSON.stringify({ topic: 'apps', actions: [{ tool: 'open_app', arg: 'блокнот' }], say: 'Открываю блокнот.' });
  stopped = false;
  const fullLlm = { chat: async (m, f, o, onText) => ((stopped = [...openJson].some((_, i) => onText(openJson.slice(0, i + 1)) === STOP)), openJson) };
  a = createAssistant({ config: ctx.config, llm: fullLlm, skills: { ...skills, run: async () => ({ ok: true }) }, memory: store, audit: () => {}, notify: () => {} });
  r = await a.handle('открой блокнот', { source: 'wake' });
  await a.reset();
  assert.equal(stopped, false);
  assert.match(r.say, /Открываю блокнот/);

  // Пока человек договаривает, запрос заменили — действия по обрывку не выполняются
  ran.length = 0;
  const controller = new AbortController();
  a = createAssistant({ config: ctx.config, llm: cutLlm, skills: quiet, memory: store, audit: () => {}, notify: () => {} });
  r = await a.handle('погода в', { source: 'wake', signal: controller.signal, beforeActions: async () => controller.abort() });
  await a.reset();
  assert.equal(r.cancelled, true);
  assert.deepEqual(ran, []);

  // Поиск: сразу «Сейчас поищу», ответ звучит по предложениям, пока модель его пишет
  const searchJson = JSON.stringify({ topic: 'search', actions: [{ tool: 'web_search', arg: 'Илон Маск' }], say: '' });
  const answer = 'Илон Маск — предприниматель. Он основал SpaceX в 2002 году.';
  const searching = {
    ...skills,
    run: async (tool, arg, request) => {
      for (let i = 1; i <= answer.length; i += 5) request.onText?.(answer.slice(0, i));
      return { ok: true, speak: answer };
    },
  };
  fillers = [];
  const parts = [];
  a = createAssistant({ config: ctx.config, llm: { chat: async () => searchJson }, skills: searching, memory: store, audit: () => {}, notify: () => {} });
  r = await a.handle('кто такой илон маск', { source: 'wake', person: { id: 'p1', honorific: 'сэр' }, onSay: (t) => parts.push(t), onFiller: (t) => fillers.push(t) });
  await a.reset();
  assert.deepEqual(fillers, ['Сейчас поищу.']);
  assert.equal(r.streamed, true);
  assert.equal(parts.length, 2);
  assert.equal(parts[1], 'Он основал SpaceX в 2002 году.', 'по предложениям, как написано (словами — только в синтезе)');
});

test('таймер «на секунд десять»; вопрос про процессор — не список процессов', () => {
  const { durationFromText } = require('../src/lib/ru');
  assert.equal(durationFromText('поставь таймер на секунд десять'), 10, 'число после единицы (было: 1 секунда)');
  assert.equal(durationFromText('напомни минут через пять'), 300);
  assert.equal(durationFromText('через час двадцать'), 3600, '«час двадцать» — не двадцать часов');
  assert.equal(durationFromText('через 2 часа 15 минут'), 8100);
  assert.equal(durationFromText('таймер на пятнадцать секунд'), 15);
  const { focusOf } = require('../src/skills/pc');
  assert.equal(focusOf('процессор'), 'cpu');
  assert.equal(focusOf('процессы'), 'processes');
});

test('настройки: новое имя — новое слово отклика', () => {
  const { createSettings } = require('../src/core/settings');
  const file = path.join(tmp(), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'Орион', speech: { wakeWords: ['орион', 'orion'] } }));
  const config = loadConfig(file);
  const settings = createSettings({ config, file, skills: [], setHotkey: () => true });
  assert.equal(settings.save({ name: 'Джарвис' }).ok, true);
  assert.deepEqual(config.speech.wakeWords, ['джарвис']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).speech.wakeWords, ['джарвис'], 'и в config.json');
});

// --- сборка под разные ОС и первый запуск ---

test('навыки Windows не подключаются на других ОС', () => {
  const { supports } = require('../src/core/skills');
  const power = allSkills.find((s) => s.id === 'power');
  const weatherSkill = allSkills.find((s) => s.id === 'weather');
  assert.equal(supports(power, 'win32'), true);
  assert.equal(supports(power, 'darwin'), false);
  assert.equal(supports(weatherSkill, 'linux'), true);
  const config = loadConfig(path.join(__dirname, '../config.json'));
  const reg = createSkillRegistry(allSkills, { config, ctx: { config }, audit: () => {}, platform: 'linux' });
  assert.ok(!reg.catalogPrompt?.().includes('- power:'));
});

test('размер загрузки для предупреждения при первом запуске', () => {
  const { formatBytes } = require('../src/core/setup');
  assert.equal(formatBytes(128774318), '129 МБ');
  assert.equal(formatBytes(3389983260), '3,4 ГБ');
  assert.equal(formatBytes(643854), '1 МБ');
  assert.equal(formatBytes(0), 'размер неизвестен');
});

// --- встроенный llama.cpp ---

test('llama.cpp: выбирает дискретную видеокарту, а не встроенную с «большей» общей памятью', () => {
  const { parseDevices, pickDevice } = require('../src/core/llama');
  const devices = parseDevices(
    'Available devices:\n  Vulkan0: NVIDIA GeForce RTX 5070 (11943 MiB, 11175 MiB free)\n  Vulkan1: AMD Radeon(TM) Graphics (16066 MiB, 15262 MiB free)\n',
  );
  assert.equal(devices.length, 2);
  assert.equal(pickDevice(devices).name, 'Vulkan0');
  assert.equal(pickDevice(parseDevices('  Vulkan0: Intel(R) UHD Graphics (8000 MiB, 7000 MiB free)')).name, 'Vulkan0');
  assert.equal(pickDevice([]), null);
});

test('llama.cpp: сборка под ОС и модель — в папке models', () => {
  const { variant, paths } = require('../src/core/llama');
  assert.equal(variant('win32', 'x64'), 'win-vulkan-x64');
  assert.equal(variant('darwin', 'arm64'), 'macos-arm64');
  assert.equal(variant('linux', 'x64'), 'ubuntu-vulkan-x64');
  const config = loadConfig(path.join(__dirname, '../config.json'));
  const p = paths({ ...config, model: 'qwen3.5:4b' }, '/m');
  assert.ok(p.gguf.endsWith(path.join('llm', 'Qwen3.5-4B-Q4_K_M.gguf')));
  assert.match(p.ggufUrl, /^https:\/\/huggingface\.co\/unsloth\//);
  assert.match(p.url, /\/b\d+\/llama-b\d+-bin-/);
  assert.equal(paths({ ...config, model: 'my.gguf' }, '/m').ggufUrl, undefined); // своя модель не качается
});

// --- ударения перед озвучкой (lib/stress.js) ---

test('ударения: как у исходной модели silero-stress, омографы по подсказкам, «ё»', () => {
  const { accentuate, forSynth } = require('../src/lib/stress');
  const VOWELS = /[аоуыэиеяёю]/gi;
  // Эталон — вывод исходной модели (без нейросети для омографов); односложные слова мы не размечаем
  const plain = (t) => t.replace(/[А-Яа-яЁё+]+/g, (w) => ((w.replace(/\+/g, '').match(VOWELS) || []).length <= 1 || /ё/i.test(w) ? w.replace(/\+/g, '') : w));
  const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/stress-reference.json'), 'utf8'));
  for (const r of [ref[0], ref[2], ref[3]]) assert.equal(plain(accentuate(r.text)), plain(r.noHomo));

  assert.equal(accentuate('Замок на двери или старинный замок.'), 'Зам+ок на двер+и +или стар+инный з+амок.');
  assert.equal(accentuate('Всё готово. Это все, что вы просили.'), 'Всё гот+ово. +Это вс+ё, что вы прос+или.');
  assert.equal(accentuate('Мука для пирога'), 'Мук+а для пирог+а');
  assert.equal(accentuate('что-то'), 'что-то', 'частица «-то» и односложные слова — без меток');
  // Для синтезатора — знак ударения после гласной; текст без букв не трогается
  assert.equal(forSynth('Замок на двери'), 'Замо́к на двери́');
  assert.equal(forSynth('123, ok!'), '123, ok!');
});

test('«закрой X» не запускает X, даже если модель ошиблась (случаи из журнала)', () => {
  const { guardCloseIntent: g } = require('../src/core/assistant');
  const plan = (say, ...actions) => ({ addressed: true, topic: 'steam', say, actions: actions.map(([tool, arg]) => ({ tool, arg })) });
  // «закрой дедлок» → модель запустила игру
  let p = g(plan('Запускаю Deadlock, сэр.', ['steam_launch', 'Deadlock']), 'закрой дедлок');
  assert.deepEqual(p.actions, [{ tool: 'close_app', arg: 'Deadlock' }]);
  assert.equal(p.say, 'Закрываю Deadlock, сэр.');
  // «знагрион закрой дедлок» → модель закрыла сам Steam и сказала «Запускаю Steam»
  p = g(plan('Запускаю Steam, сэр.', ['close_app', 'steam']), 'знагрион закрой дедлок');
  assert.deepEqual(p.actions, [{ tool: 'close_app', arg: 'дедлок' }]);
  assert.equal(p.say, 'Закрываю дедлок, сэр.');
  // верные планы не трогаем
  const ok = plan('Закрываю Chrome.', ['close_app', 'chrome']);
  assert.equal(g(ok, 'закрой хром'), ok);
  const steam = plan('', ['close_app', 'steam']);
  assert.equal(g(steam, 'закрой стим'), steam);
  const launch = plan('', ['steam_launch', 'Deadlock']);
  assert.equal(g(launch, 'запусти дедлок'), launch);
  const music = plan('', ['media', 'pause']);
  assert.equal(g(music, 'выключи музыку'), music);
  // «закрой и открой заново» — оба глагола: решает модель
  const both = plan('', ['steam_launch', 'Deadlock']);
  assert.equal(g(both, 'закрой и открой дедлок заново'), both);
});

test('речь: порядковые с окончанием, падеж после предлога, время, половины, дроби, версии, сокращения', () => {
  const { normalizeForSpeech: n } = require('../src/lib/speech-text');
  const cases = [
    // порядковые с окончанием
    ['Вышло 3-е издание.', 'Вышло третье издание.'],
    ['На 2-м месте.', 'На втором месте.'],
    ['21-го века', 'двадцать первого века'],
    ['К 3-му числу', 'К третьему числу'],
    ['В 90-е годы', 'В девяностые годы'],
    // падеж после предлога: единицы, знак, дательный
    ['Свободно 12,5 ГБ из 512 ГБ', 'Свободно двенадцать с половиной гигабайта из пятисот двенадцати гигабайт'],
    ['Днём до +15', 'Днём до плюс пятнадцати'],
    ['К 5 часам', 'К пяти часам'],
    ['По 1 штуке', 'По одной штуке'],
    ['Ок. 5 км', 'Около пяти километров'],
    // время, счёт, размеры
    ['С 9:00 до 18:30', 'С девяти часов до восемнадцати тридцати'],
    ['Будильник на 7:00', 'Будильник на семь часов'],
    ['Встреча в 12.05', 'Встреча в двенадцать ноль пять'],
    ['Счёт 3:1', 'Счёт три — один'],
    ['Соотношение 16:9', 'Соотношение шестнадцать на девять'],
    ['Экран 1920x1080', 'Экран тысяча девятьсот двадцать на тысяча восемьдесят'],
    // половины, деньги, диапазоны, дроби, выражения
    ['Прошло 1,5 часа', 'Прошло полтора часа'],
    ['Осталось 2,5 минуты', 'Осталось две с половиной минуты'],
    ['Евро — 101,5 рубля', 'Евро — сто один рубль пятьдесят копеек'],
    ['Цена $19.99', 'Цена девятнадцать долларов девяносто девять центов'],
    ['Итого 1 234,56 руб.', 'Итого тысяча двести тридцать четыре рубля пятьдесят шесть копеек.'],
    ['цена 999 руб.', 'цена девятьсот девяносто девять рублей.'],
    ['2-3 минуты', 'две-три минуты'],
    ['3/4 населения', 'три четверти населения'],
    ['2 + 2 = 4', 'два плюс два равно четыре'],
    ['1 сутки', 'одни сутки'],
    // версии — не даты и не дроби
    ['Python 3.12', 'пайтон три точка двенадцать'],
    ['Версия 2.3.1 вышла', 'Версия два точка три точка один вышла'],
    // сокращения и адреса
    ['Г. Липецк, ул. Ленина, д. 5, №3', 'Город Липецк, улица Ленина, дом пять, номер три'],
    ['Т.е. всё хорошо', 'то есть всё хорошо'],
    ['МКС и УК', 'эм-ка-+эс и у-к+а'],
    ['НАТО и ДА', 'НАТО и ДА'],
    ['5G и 3D', 'пять-дж+и и три-д+э'],
    ['Ехать 120 км/ч.', 'Ехать сто двадцать километров в час.'],
    ['Высота 8848 м.', 'Высота восемь тысяч восемьсот сорок восемь метров.'],
  ];
  for (const [src, want] of cases) assert.equal(n(src), want, src);
});

test('речь: латинские сокращения — по буквам, дата с годом — «когда»', () => {
  const { normalizeForSpeech: n } = require('../src/lib/speech-text');
  assert.equal(n('Свободно 120 ГБ на диске C.'), 'Свободно сто двадцать гигабайт на диске си.');
  assert.equal(n('Порт USB, режим HDR, NASA и IT.'), 'Порт ю-эс-б+и, режим эйч-ди-+ар, наса и ай-т+и.');
  assert.equal(n('I love you'), 'I love you', 'английская фраза не трогается');
  assert.match(n('Первый полёт в космос, 12 апреля 1961 года.'), /космос, двенадцатого апреля тысяча девятьсот шестьдесят первого года/);
  assert.match(n('12 апреля — День космонавтики.'), /^двенадцатое апреля/);
  assert.match(n('Сегодня 27 сентября 2026 года.'), /Сегодня двадцать седьмое сентября/);
});

test('ударения: свои слова, «стоит», твёрдое «э», готовые ударения из нормализатора', () => {
  const { accentuate, forSynth } = require('../src/lib/stress');
  assert.equal(accentuate('Это красивее.'), '+Это крас+ивее.', 'свой словарь важнее модели');
  assert.equal(accentuate('Сколько стоит билет? Дом стоит на холме.'), 'Ск+олько ст+оит бил+ет? Дом сто+ит на холм+е.');
  assert.equal(accentuate('ю-эс-б+и'), 'ю-эс-б+и', 'ударение из нормализатора сохраняется');
  assert.equal(forSynth('Интернет и тестовый режим, кафе.'), 'Интэрнэ́т и тэ́стовый режи́м, кафэ́.');
  assert.equal(forSynth('Тесто для пирога.'), 'Те́сто для пирога́.', '«тесто» — не «тест»: мягкое «е» остаётся');
});

test('ударения: омографы по грамматике — эталон и отложенный набор без ошибок', () => {
  const { accentuate } = require('../src/lib/stress');
  const plain = (w) => w.replace(/\+/g, '').toLowerCase().replace(/ё/g, 'е');
  for (const file of ['stress-gold.json', 'stress-holdout.json']) {
    const bad = [];
    for (const [text, expected] of JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8'))) {
      const words = accentuate(text).match(/[А-Яа-яЁё+]+/g) || [];
      let from = 0;
      for (const exp of expected) {
        const i = words.findIndex((w, k) => k >= from && plain(w) === plain(exp));
        const got = i < 0 ? '?' : words[i].toLowerCase();
        if (i >= 0) from = i + 1;
        if (got !== exp.toLowerCase()) bad.push(`${text}: ${got} (надо ${exp})`);
      }
    }
    assert.deepEqual(bad, [], file);
  }
  // признаки по отдельности
  assert.equal(accentuate('из города'), 'из г+орода');
  assert.equal(accentuate('эти города'), '+эти город+а');
  assert.equal(accentuate('два часа'), 'два час+а', 'у «часа» своё счётное ударение');
  assert.equal(accentuate('около часа'), '+около ч+аса');
  assert.equal(accentuate('две руки'), 'две р+уки', 'женский род после «две» — как во множественном');
  assert.equal(accentuate('Стены дома покрашены.'), 'Ст+ены д+ома покр+ашены.', 'глагол относится к «стенам»');
});

test('речь: символы, ссылки, почта, давление, юникодные дроби', () => {
  const { normalizeSymbols: s } = require('../src/lib/speech-symbols');
  assert.equal(s('сайт https://ya.ru/search?text=погода'), 'сайт я точка ру');
  assert.equal(s('на www.google.com'), 'на гугл точка ком');
  assert.equal(s('Пишите на orion@mail.ru'), 'Пишите на orion собака мейл точка ру');
  assert.equal(s('госуслуги.рф'), 'госуслуги точка эр-+эф');
  assert.equal(s('760 мм рт. ст.'), '760 миллиметров ртутного столба');
  assert.equal(s('~5 минут'), 'около 5 минут');
  assert.equal(s('≈ 20%'), 'примерно 20%');
  assert.equal(s('±2 градуса'), 'плюс-минус 2 градуса');
  assert.equal(s('Tom & Jerry'), 'Tom и Jerry');
  assert.equal(s('½ стакана'), 'половина стакана');
  assert.equal(s('т.е. это, файл 3.14 и г. Москва'), 'т.е. это, файл 3.14 и г. Москва', 'сокращения и числа — не ссылки');
});

test('ударения в готовых фразах Ориона: все слова проверены (test/fixtures/stress-reviewed.json)', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, [path.join(__dirname, '../scripts/stress-phrases.js'), '--new'], { encoding: 'utf8' }).trim();
  // Новая фраза в коде — новое слово: проверьте его ударение (npm run stress-phrases -- --new), при ошибке поправьте
  // src/assets/stress/extra-words.json, затем npm run stress-phrases -- --accept
  assert.equal(out, 'все слова проверены');
});

// Маленький zip (без сжатия) — чтобы проверить чтение docx без готовых файлов
function makeZip(files) {
  const zlib = require('node:zlib');
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(nameBuf.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('файлы: поиск по названию, типу и дате, «его», переименование, перенос, копия, корзина, создание, чтение', async () => {
  const files = require('../src/skills/files');
  const tool = (name) => files.tools.find((t) => t.name === name).run;
  const home = tmp();
  const f = {};
  for (const k of ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos']) fs.mkdirSync((f[k] = path.join(home, k)));
  f.screenshots = path.join(f.pictures, 'Screenshots');
  files._test.reset();
  files._test.setFolders(f);
  const old = Date.now() / 1000 - 10 * 86400;
  fs.writeFileSync(path.join(f.documents, 'Договор аренды.docx'), makeZip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Срок оплаты — до 5 числа.</w:t></w:r></w:p><w:p><w:r><w:t>Штраф 1%.</w:t></w:r></w:p></w:body></w:document>' }));
  fs.writeFileSync(path.join(f.documents, 'старое.txt'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])); // «Привет» в Windows-1251
  fs.utimesSync(path.join(f.documents, 'старое.txt'), old, old);
  fs.writeFileSync(path.join(f.downloads, 'setup.exe'), 'x');
  fs.writeFileSync(path.join(f.downloads, 'отчёт.pdf'), '%PDF');
  const said = [];
  const trash = [];
  const ctx = {
    openPath: async () => '', showItemInFolder: (p) => said.push(`show ${path.basename(p)}`), clipboard: { writeText: (t) => said.push(`clip ${t}`) },
    confirm: async () => true, trashItem: async (p) => (trash.push(p), fs.rmSync(p)), audit: () => {},
    llm: { chat: async () => 'Кратко: оплата до пятого.', answer: async (q, c) => (c.includes('Срок оплаты') ? 'До пятого числа.' : '?') },
  };

  let r = await tool('find_file')('договор', ctx);
  assert.match(r.speak, /Договор аренды/);
  r = await tool('find_file')('open последний pdf', ctx);
  assert.match(r.speak, /Открываю «отчёт»/, 'по типу');
  r = await tool('latest_download')('open', ctx);
  assert.ok(r.ok);
  r = await tool('find_file')('open setup', ctx);
  assert.match(r.speak, /программа или скрипт, сам не запускаю/, 'программы голосом не запускаются');
  r = await tool('recent_files')('документы сегодня', ctx);
  assert.match(r.speak, /Договор аренды/);
  assert.doesNotMatch(r.speak, /старое/, 'старый файл — не «сегодня»');

  r = await tool('read_file')('старое', ctx);
  assert.match(r.speak, /Привет/, 'Windows-1251');
  r = await tool('read_file')('договор', ctx);
  assert.match(r.speak, /Срок оплаты — до 5 числа\.\nШтраф 1%\./, 'docx: абзацы');
  r = await tool('read_file')('это|когда платить', ctx);
  assert.equal(r.speak, 'До пятого числа.', '«это» — последний упомянутый файл');
  r = await tool('read_file')('отчёт', ctx);
  assert.match(r.message, /PDF/);

  r = await tool('file_op')('rename договор|Договор 2026', ctx);
  assert.match(r.speak, /Договор 2026/);
  assert.ok(fs.existsSync(path.join(f.documents, 'Договор 2026.docx')), 'расширение сохранилось');
  r = await tool('file_op')('copy это|рабочий стол', ctx);
  assert.ok(fs.existsSync(path.join(f.desktop, 'Договор 2026.docx')));
  r = await tool('file_op')('copy Договор 2026|рабочий стол', ctx);
  assert.ok(fs.existsSync(path.join(f.desktop, 'Договор 2026 (2).docx')), 'существующий файл не перезаписывается');
  r = await tool('file_op')('move последний скачанный|документы', ctx);
  assert.match(r.speak, /Переместил/);
  r = await tool('file_op')('mkdir Отпуск|рабочий стол', ctx);
  assert.ok(fs.statSync(path.join(f.desktop, 'Отпуск')).isDirectory());
  r = await tool('file_op')('newfile список дел|Отпуск|купить билеты', ctx);
  assert.equal(fs.readFileSync(path.join(f.desktop, 'Отпуск', 'список дел.txt'), 'utf8'), 'купить билеты\n');
  r = await tool('file_op')('newfile текст документы|рабочий стол', ctx);
  assert.ok(fs.existsSync(path.join(f.desktop, 'Новый текстовый документ.txt')), '«текстовый документ» — тип, а не имя');
  r = await tool('open_folder')('отпуск', ctx);
  assert.ok(r.ok, 'папка по названию');
  r = await tool('file_op')('delete это', ctx);
  assert.match(r.speak, /в корзине/);
  assert.equal(trash.length, 1);
  r = await tool('folder_info')('документы', ctx);
  assert.match(r.speak, /В документах \d+ файл/);
  r = await tool('file_op')('rename это|..\..\Windows\evil', ctx);
  assert.ok(!fs.existsSync(path.join(home, '..', 'Windows')), 'путь в имени не уводит из папки');
  assert.equal(files._test.safeName('a/b:c*?'), 'a b c');
  assert.equal(files._test.inside(f, path.join(home, 'desktop', 'x')), true);
  assert.equal(files._test.inside(f, path.join(home, '..', 'x')), false);
  files._test.reset();
});

// --- передача задач агенту (Claude Code / Codex) ---

test('агент: поиск в PATH, проекты, папка задачи, итог для озвучки', () => {
  const delegate = require('../src/skills/delegate');
  const { which, findProject, folderName, taskPrompt, summaryOf } = delegate._test;
  const bin = tmp();
  const file = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  fs.writeFileSync(file, '');
  assert.equal(which('codex', { PATH: bin }), file);
  assert.equal(which('claude-нет-такого', { PATH: bin }), null);

  const projects = { орион: 'C:\\code\\orion', 'орион сайт': 'C:\\code\\site' };
  assert.equal(findProject(projects, 'оптимизируй код Ориона').dir, 'C:\\code\\orion');
  assert.equal(findProject(projects, 'поправь вёрстку в проекте орион сайт').name, 'орион сайт', 'длинное название — первым');
  assert.equal(findProject(projects, 'напиши скрипт'), null);

  assert.equal(folderName('Написать скрипт: переименовать фото по дате!', new Date(2026, 8, 27, 9, 5)), '2026-09-27 09-05 Написать скрипт переименовать фото по');
  const prompt = taskPrompt({ task: 'Написать парсер', text: 'напиши парсер новостей', clipboardFile: 'буфер.txt' });
  assert.match(prompt, /Задача: Написать парсер/);
  assert.match(prompt, /Дословно: «напиши парсер новостей»/);
  assert.match(prompt, /буфер\.txt/);
  assert.match(prompt, /по-русски/);

  assert.equal(summaryOf('Сделал так:\n\n```js\nconst a = 1;\n```\n\nГотово. Скрипт — в файле **rename.py**.'), 'Готово. Скрипт — в файле rename.py.');
  assert.ok(summaryOf(`${'Очень длинный ответ. '.repeat(40)}`).length <= 300);
});

test('агент: согласие, фоновая задача, итог напоминанием, отмена', async () => {
  const delegate = require('../src/skills/delegate');
  const tool = (name) => delegate.tools.find((t) => t.name === name).run;
  delegate._test.reset();
  // Агент-заглушка: читает задачу из stdin, пишет файл в свою папку, последним абзацем — итог
  const script =
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{require('fs').writeFileSync('task.txt',s);" +
    "if(s.includes('долго'))return setTimeout(()=>{},60000);console.log('Работаю.\\n\\nСкрипт готов, лежит в папке задачи.')})";
  delegate._test.setAgent({ id: 'test', title: 'Тестовый агент', file: process.execPath, args: ['-e', script] });
  const workDir = tmp();
  const saved = [];
  const reminders = [];
  let answer = true;
  let asked = 0;
  const ctx = {
    config: { skills: {}, delegate: { workDir, projects: {} } },
    confirm: async () => (asked++, answer),
    saveSettings: (p) => saved.push(p),
    remind: (t) => reminders.push(t),
    audit: () => {},
    clipboard: { readText: () => 'def f(): pass' },
    openPath: async () => '',
  };

  // Не ответили — ничего не сохраняем, при запуске спросим снова
  answer = null;
  let r = await tool('delegate')('Написать скрипт', ctx, { text: 'напиши скрипт' });
  assert.equal(r.ok, false);
  assert.deepEqual(saved, []);
  await delegate.offer(ctx);
  assert.equal(asked, 2, 'предложение при запуске — пока не ответили');

  // «Да» — включено, задача ушла агенту, итог приходит напоминанием
  answer = true;
  r = await tool('delegate')('Оптимизировать код из буфера обмена', ctx, { text: 'оптимизируй код который я скопировал' });
  assert.match(r.speak, /Передал задачу Тестовый агент/);
  assert.deepEqual(saved, [{ 'skills.delegate': true }]);
  assert.equal(ctx.config.skills.delegate.enabled, true);
  await delegate.offer(ctx);
  assert.equal(asked, 3, 'после ответа больше не предлагает');
  const job = delegate._test.job();
  assert.ok(job.dir.startsWith(workDir));
  for (let i = 0; i < 100 && job.status === 'running'; i++) await new Promise((res) => setTimeout(res, 50));
  assert.equal(job.status, 'done');
  assert.deepEqual(reminders, ['Задача готова. Скрипт готов, лежит в папке задачи.']);
  assert.match(fs.readFileSync(path.join(job.dir, 'task.txt'), 'utf8'), /Задача: Оптимизировать код/);
  assert.equal(fs.readFileSync(path.join(job.dir, 'буфер.txt'), 'utf8'), 'def f(): pass', 'буфер обмена — файлом рядом с задачей');
  assert.deepEqual(delegate.quick('как там задача').actions, [{ tool: 'delegate_task', arg: 'status' }]);
  assert.match((await tool('delegate_task')('status', ctx)).speak, /Задача готова/);

  // Долгая задача: вторую не берёт, отмена останавливает агента без напоминания
  r = await tool('delegate')('Сделать что-то долго', ctx, { text: 'сделай долго' });
  assert.ok(r.ok);
  assert.equal(asked, 3, 'уже включено — не переспрашивает');
  assert.match((await tool('delegate')('Ещё задача', ctx, { text: 'ещё' })).message, /занят/);
  assert.match((await tool('delegate_task')('status', ctx)).speak, /работает над задачей/);
  const long = delegate._test.job();
  for (let i = 0; i < 40 && !fs.existsSync(path.join(long.dir, 'task.txt')); i++) await new Promise((res) => setTimeout(res, 50));
  assert.match((await tool('delegate_task')('cancel', ctx)).speak, /Остановил/);
  for (let i = 0; i < 100 && long.proc; i++) await new Promise((res) => setTimeout(res, 50));
  assert.equal(long.status, 'cancelled');
  assert.equal(reminders.length, 1);

  // «Нет» — выключено и больше не спрашивает
  ctx.config.skills = {};
  answer = false;
  r = await tool('delegate')('Написать бота', ctx, { text: 'напиши бота' });
  assert.match(r.message, /не передаю/);
  assert.equal(ctx.config.skills.delegate.enabled, false);
  r = await tool('delegate')('Написать бота', ctx, { text: 'напиши бота' });
  assert.match(r.message, /выключена/);
  assert.equal(asked, 4);
  delegate._test.reset();
  assert.equal(delegate.quick('как там задача'), null, 'без задачи — не команда');
});

test('программы: похожие по звучанию названия и недослышанное', () => {
  const { score } = require('../src/lib/app-catalog');
  assert.ok(score('гугл хром', 'Google Chrome') > 0, 'по костяку согласных: гугл ~ google, хром ~ chrome');
  assert.ok(score('продник', 'Проводник') > 0, 'две ошибки в длинном слове');
  assert.ok(score('эксель', 'Excel') > 0);
  assert.equal(score('кот', 'Калькулятор'), 0, 'короткие слова не притягиваются');
  assert.ok(score('проводник', 'Проводник') > score('продник', 'Проводник'), 'точное совпадение — выше');
});

test('агент: просьбы что-то разработать подгружают навык, обычные команды — нет', () => {
  const delegate = require('../src/skills/delegate');
  delegate._test.setAgent({ id: 'test', title: 'Тест', file: process.execPath, args: [] });
  const config = { skills: {}, delegate: {} };
  const reg = createSkillRegistry([delegate], { config, ctx: { config }, audit: () => {}, platform: 'win32' });
  for (const t of ['создай сет визитку', 'создай сайт-визитку для кофейни', 'сделай мне телеграм-бота', 'напиши парсер новостей', 'разработай игру змейка', 'сверстай лендинг', 'оптимизируй код']) {
    assert.equal(reg.likely(t), 'delegate', t);
  }
  for (const t of ['открой сайт ютуба', 'сделай громче', 'создай папку отпуск', 'создай напоминание', 'запусти игру', 'какая погода']) {
    assert.equal(reg.likely(t), null, t);
  }
  delegate._test.reset();
});

test('отказ модели («не умею») — переспрос с агентом; отказ в разговоре остаётся, в потоке не звучит', async () => {
  const { isRefusal, createSayStreamer } = require('../src/core/assistant');
  for (const s of ['Сэр, я пока не умею создавать файлы.', 'Я не могу этого сделать.', 'У меня нет доступа к вашему компьютеру.', 'Это вне моих возможностей.']) assert.ok(isRefusal(s), s);
  for (const s of ['Готово, сэр.', 'Не могли бы вы повторить?', 'Невозможно не улыбнуться.']) assert.ok(!isRefusal(s), s);

  // поток: первое предложение звучит, отказ придерживается до finish()
  const said = [];
  const st = createSayStreamer((p) => said.push(p), { hold: isRefusal });
  const json = '{"topic":"chat","actions":[],"say":"Интересная идея. Я не умею создавать сайты. Могу подсказать шаблон."}';
  for (let i = 10; i <= json.length; i += 7) st.onText(json.slice(0, i));
  st.onText(json);
  assert.deepEqual(said, ['Интересная идея.']);
  st.finish('Интересная идея. Я не умею создавать сайты. Могу подсказать шаблон.');
  assert.deepEqual(said, ['Интересная идея.', 'Я не умею создавать сайты. Могу подсказать шаблон.']);

  const delegate = require('../src/skills/delegate');
  delegate._test.setAgent({ id: 'test', title: 'Тест', file: process.execPath, args: [] });
  const mk = (answers) => {
    const { skills, store, ctx } = makeRegistry();
    const f = fakeLlm(answers);
    const log = [];
    return { ...f, log, assistant: createAssistant({ config: ctx.config, llm: f.llm, skills, memory: store, audit: (e) => log.push(e), notify: () => {} }) };
  };
  // просьба, которую модель сама не может, — второй запрос с навыком агента и подсказкой
  let t = mk(['{"topic":"chat","actions":[],"say":"Сэр, я пока не умею собирать резюме."}', '{"topic":"delegate","actions":[{"tool":"delegate","arg":"Собрать резюме в HTML"}],"say":""}']);
  let r = await t.assistant.handle('собери мне резюме в html', { source: 'text' });
  await t.assistant.reset();
  assert.equal(t.calls.length, 2);
  assert.ok(!t.calls[0].tools.includes('delegate') && t.calls[1].tools.includes('delegate'));
  assert.match(t.calls[1].messages.at(-1).content, /подсказка: ты ответил, что не можешь/);
  assert.deepEqual(r.actions, [{ tool: 'delegate', arg: 'Собрать резюме в HTML' }]);
  assert.ok(t.log.some((e) => e.skillFallback === 'delegate' && e.used));

  // отказ в разговоре — модель не передаёт, ответ прежний
  t = mk(['{"topic":"chat","actions":[],"say":"Я не могу чувствовать вкус, сэр."}', '{"topic":"chat","actions":[],"say":"Другое."}']);
  r = await t.assistant.handle('ты любишь пиццу', { source: 'text' });
  await t.assistant.reset();
  assert.equal(t.calls.length, 2);
  assert.deepEqual(r.actions, []);
  assert.match(r.say, /не могу чувствовать/);

  // передача выключена — не переспрашиваем
  const off = makeRegistry({ skills: { delegate: { enabled: false } } });
  const f = fakeLlm(['{"topic":"chat","actions":[],"say":"Я не умею."}']);
  const plain = createAssistant({ config: off.ctx.config, llm: f.llm, skills: off.skills, memory: off.store, audit: () => {}, notify: () => {} });
  await plain.handle('собери мне резюме', { source: 'text' });
  await plain.reset();
  assert.equal(f.calls.length, 1);
  delegate._test.reset();
});

test('отказ модели: повтор засчитывается, только если задачу передали агенту', async () => {
  const delegate = require('../src/skills/delegate');
  delegate._test.setAgent({ id: 'test', title: 'Тест', file: process.execPath, args: [] });
  const { skills, store, ctx } = makeRegistry();
  const f = fakeLlm(['{"topic":"chat","actions":[],"say":"Я не могу сходить в магазин, сэр."}', '{"topic":"reminders","actions":[{"tool":"timer","arg":"3600|магазин"}],"say":""}']);
  const assistant = createAssistant({ config: ctx.config, llm: f.llm, skills, memory: store, audit: () => {}, notify: () => {} });
  const r = await assistant.handle('сходи в магазин за хлебом', { source: 'text' });
  await assistant.reset();
  assert.deepEqual(r.actions, [], 'напоминание никто не просил');
  assert.match(r.say, /не могу сходить/);
  delegate._test.reset();
});
