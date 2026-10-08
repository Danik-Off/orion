// Реестр навыков и сами навыки (core/skills.js, skills/*)
require('./helpers'); // заглушка Electron — до подключения навыков
const test = require('node:test');
const assert = require('node:assert/strict');
const allSkills = require('../src/skills');
const { score } = require('../src/lib/app-catalog');
const fs = require('node:fs');
const path = require('node:path');
const { createSkillRegistry } = require('../src/core/skills');
const { isPublicUrl, extractMainText } = require('../src/lib/websearch');
const { pickForListening } = require('../src/lib/youtube');
const { tmp, makeRegistry, makeZip } = require('./helpers');
const music = require('../src/skills/music');

test('реестр: все инструменты, промпт, отключение навыка, вызов навыка из навыка', async () => {
  const { skills } = makeRegistry();
  for (const t of [
    'weather',
    'rate',
    'web_search',
    'open_app',
    'close_app',
    'minimize_all',
    'youtube',
    'media',
    'now_playing',
    'timer',
    'profile',
    'remember',
    'remember_shared',
    'forget',
    'open_url',
    'run_command',
    'pc_status',
  ]) {
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

test('страницы из выдачи: только публичные адреса, текст без меню', () => {
  assert.equal(isPublicUrl('https://example.com/a'), true);
  assert.equal(isPublicUrl('http://192.168.1.1/admin'), false);
  const html = '<nav><p>Меню сайта навигация</p></nav><p>Курс доллара сегодня составил 84 рубля по данным ЦБ.</p>';
  assert.equal(extractMainText(html, 'курс доллара'), 'Курс доллара сегодня составил 84 рубля по данным ЦБ.');
});

test(
  'close_app закрывает программу, которую сам и открыл (Windows)',
  { skip: process.platform !== 'win32' || process.env.ORION_SYSTEM_TESTS !== '1' },
  async () => {
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
  },
);

test('состояние ПК: фраза из цифр, предупреждения, быстрые команды', () => {
  const pc = require('../src/skills/pc');
  const GB = 1024 ** 3;
  const base = {
    cpu: 12,
    memTotal: 16 * GB,
    memFree: 6 * GB,
    uptime: 3600,
    disks: [{ drive: 'C', size: 500 * GB, free: 120 * GB }],
    battery: null,
    topMem: [{ name: 'Google Chrome', mem: 3 * GB }],
    topCpu: [{ name: 'chrome', cpu: 8 }],
  };
  const ok = pc.report(base);
  assert.match(ok, /12 процентов/);
  assert.match(ok, /10 гигабайт из 16 гигабайт/);
  assert.match(ok, /диске C свободно 120 гигабайт из 500 гигабайт/);
  assert.match(pc.report({ ...base, memTotal: 31 * GB }), /из 31 гигабайта/);
  assert.match(ok, /всё в порядке/);
  const bad = pc.report({
    ...base,
    cpu: 97,
    memFree: 1 * GB,
    uptime: 9 * 86400,
    disks: [{ drive: 'C', size: 500 * GB, free: 4 * GB }],
    battery: { charge: 15, charging: false },
  });
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
  assert.ok(
    schema.anyOf.some((v) => v.properties.tool.enum.includes('rate') && v.properties.arg.type === 'string' && !v.properties.arg.enum),
  );
  assert.match(skills.detailsPrompt(['music']), /media — .*"next"/, 'в описании — те же значения');
  assert.equal(skills.likely('сколько дней до отпуска'), 'dates');
  assert.equal(skills.likely('я так устал сегодня'), null, 'память не подсказываем: рассказ о себе — не команда');
  assert.equal(skills.resolve('weather'), 'weather');
  assert.equal(skills.resolve('note_add'), 'notes', 'по имени инструмента');
  assert.equal(skills.resolve('нет такого'), null);
});

test('навыки исправляют аргумент модели по исходной фразе', async () => {
  const { skills } = makeRegistry();
  const all = require('../src/skills');
  const norm = (tool, arg, text) =>
    all
      .flatMap((s) => s.tools || [])
      .find((t) => t.name === tool)
      .normalize(arg, text);
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
  assert.equal(
    norm('file_op', 'mkdir текст документы|рабочий стол', 'создай на рабочем столе текст документы'),
    'newfile текст документы|рабочий стол',
  );
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
  const bad = pc.warnings({
    memTotal: 16 * GB,
    memFree: 0.5 * GB,
    disks: [{ drive: 'D', size: 500 * GB, free: 2 * GB }],
    battery: { charge: 10, charging: false },
  });
  assert.deepEqual(
    bad.map(([k]) => k),
    ['disk-D', 'battery', 'memory'],
  );
  assert.equal(pc.warnings({ ...calm, battery: { charge: 10, charging: true } }).length, 0, 'на зарядке — не тревожим');
});

test('Steam: библиотека из VDF, игра по искажённому названию; факты: первое предложение статьи', () => {
  const { parseVdf, pick } = require('../src/lib/vdf');
  const v = parseVdf(
    '"AppState"\n{\n\t"appid"\t\t"1422450"\n\t"name"\t\t"Deadlock"\n\t"Inner" { "Apps" { "730" { "Playtime" "11" } } }\n}',
  );
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
  fs.writeFileSync(
    path.join(f.documents, 'Договор аренды.docx'),
    makeZip({
      'word/document.xml':
        '<w:document><w:body><w:p><w:r><w:t>Срок оплаты — до 5 числа.</w:t></w:r></w:p><w:p><w:r><w:t>Штраф 1%.</w:t></w:r></w:p></w:body></w:document>',
    }),
  );
  fs.writeFileSync(path.join(f.documents, 'старое.txt'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])); // «Привет» в Windows-1251
  fs.utimesSync(path.join(f.documents, 'старое.txt'), old, old);
  fs.writeFileSync(path.join(f.downloads, 'setup.exe'), 'x');
  fs.writeFileSync(path.join(f.downloads, 'отчёт.pdf'), '%PDF');
  const said = [];
  const trash = [];
  const ctx = {
    openPath: async () => '',
    showItemInFolder: (p) => said.push(`show ${path.basename(p)}`),
    clipboard: { writeText: (t) => said.push(`clip ${t}`) },
    confirm: async () => true,
    trashItem: async (p) => (trash.push(p), fs.rmSync(p)),
    audit: () => {},
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
  r = await tool('file_op')('rename это|..\\..\\Windows\\evil', ctx);
  assert.ok(!fs.existsSync(path.join(home, '..', 'Windows')), 'путь в имени не уводит из папки');
  assert.equal(files._test.safeName('a/b:c*?'), 'a b c');
  assert.equal(files._test.inside(f, path.join(home, 'desktop', 'x')), true);
  assert.equal(files._test.inside(f, path.join(home, '..', 'x')), false);
  files._test.reset();
});

test('программы: похожие по звучанию названия и недослышанное', () => {
  assert.ok(score('гугл хром', 'Google Chrome') > 0, 'по костяку согласных: гугл ~ google, хром ~ chrome');
  assert.ok(score('продник', 'Проводник') > 0, 'две ошибки в длинном слове');
  assert.ok(score('эксель', 'Excel') > 0);
  assert.equal(score('кот', 'Калькулятор'), 0, 'короткие слова не притягиваются');
  assert.ok(score('проводник', 'Проводник') > score('продник', 'Проводник'), 'точное совпадение — выше');
});

test('router: N — навык, выученный маленькой моделью версии N: с прежней версией его фразы у большой', () => {
  const skill = { id: 'probe_new', router: 2, keywords: ['зонд'], tools: [{ name: 'probe_new', use: 'зонд', run: async () => ({ ok: true }) }] };
  const make = (router) =>
    createSkillRegistry([skill], { config: { router, skills: {} }, ctx: {}, audit: () => {}, platform: 'win32' });
  assert.equal(make({}).external('запусти зонд'), 'probe_new', 'по умолчанию — v1');
  assert.equal(make({ release: 'models-router-v1' }).external('запусти зонд'), 'probe_new');
  assert.equal(make({ release: 'models-router-v2' }).external('запусти зонд'), null);
  assert.equal(make({ version: 3 }).external('запусти зонд'), null);
});
