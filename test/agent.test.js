// Передача задач агенту и отказ модели (skills/delegate.js)
require('./helpers'); // заглушка Electron — до подключения навыков
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAssistant } = require('../src/core/assistant');
const { createSkillRegistry } = require('../src/core/skills');
const { tmp, makeRegistry, fakeLlm } = require('./helpers');

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

  assert.equal(
    folderName('Написать скрипт: переименовать фото по дате!', new Date(2026, 8, 27, 9, 5)),
    '2026-09-27 09-05 Написать скрипт переименовать фото по',
  );
  const prompt = taskPrompt({ task: 'Написать парсер', text: 'напиши парсер новостей', clipboardFile: 'буфер.txt' });
  assert.match(prompt, /Задача: Написать парсер/);
  assert.match(prompt, /Дословно: «напиши парсер новостей»/);
  assert.match(prompt, /буфер\.txt/);
  assert.match(prompt, /по-русски/);

  assert.equal(
    summaryOf('Сделал так:\n\n```js\nconst a = 1;\n```\n\nГотово. Скрипт — в файле **rename.py**.'),
    'Готово. Скрипт — в файле rename.py.',
  );
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

test('агент: просьбы что-то разработать подгружают навык, обычные команды — нет', () => {
  const delegate = require('../src/skills/delegate');
  delegate._test.setAgent({ id: 'test', title: 'Тест', file: process.execPath, args: [] });
  const config = { skills: {}, delegate: {} };
  const reg = createSkillRegistry([delegate], { config, ctx: { config }, audit: () => {}, platform: 'win32' });
  for (const t of [
    'создай сет визитку',
    'создай сайт-визитку для кофейни',
    'сделай мне телеграм-бота',
    'напиши парсер новостей',
    'разработай игру змейка',
    'сверстай лендинг',
    'оптимизируй код',
  ]) {
    assert.equal(reg.likely(t), 'delegate', t);
  }
  for (const t of ['открой сайт ютуба', 'сделай громче', 'создай папку отпуск', 'создай напоминание', 'запусти игру', 'какая погода']) {
    assert.equal(reg.likely(t), null, t);
  }
  delegate._test.reset();
});

test('отказ модели («не умею») — переспрос с агентом; отказ в разговоре остаётся, в потоке не звучит', async () => {
  const { isRefusal, createSayStreamer } = require('../src/core/assistant');
  for (const s of [
    'Сэр, я пока не умею создавать файлы.',
    'Я не могу этого сделать.',
    'У меня нет доступа к вашему компьютеру.',
    'Это вне моих возможностей.',
  ])
    assert.ok(isRefusal(s), s);
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
    const { skills, store, ctx } = makeRegistry({ planner: 'single' });
    const f = fakeLlm(answers);
    const log = [];
    return {
      ...f,
      log,
      assistant: createAssistant({ config: ctx.config, llm: f.llm, skills, memory: store, audit: (e) => log.push(e), notify: () => {} }),
    };
  };
  // просьба, которую модель сама не может, — второй запрос с навыком агента и подсказкой
  let t = mk([
    '{"topic":"chat","actions":[],"say":"Сэр, я пока не умею собирать резюме."}',
    '{"topic":"delegate","actions":[{"tool":"delegate","arg":"Собрать резюме в HTML"}],"say":""}',
  ]);
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
  const plain = createAssistant({
    config: off.ctx.config,
    llm: f.llm,
    skills: off.skills,
    memory: off.store,
    audit: () => {},
    notify: () => {},
  });
  await plain.handle('собери мне резюме', { source: 'text' });
  await plain.reset();
  assert.equal(f.calls.length, 1);
  delegate._test.reset();
});

test('отказ модели: повтор засчитывается, только если задачу передали агенту', async () => {
  const delegate = require('../src/skills/delegate');
  delegate._test.setAgent({ id: 'test', title: 'Тест', file: process.execPath, args: [] });
  const { skills, store, ctx } = makeRegistry({ planner: 'single' });
  const f = fakeLlm([
    '{"topic":"chat","actions":[],"say":"Я не могу сходить в магазин, сэр."}',
    '{"topic":"reminders","actions":[{"tool":"timer","arg":"3600|магазин"}],"say":""}',
  ]);
  const assistant = createAssistant({ config: ctx.config, llm: f.llm, skills, memory: store, audit: () => {}, notify: () => {} });
  const r = await assistant.handle('сходи в магазин за хлебом', { source: 'text' });
  await assistant.reset();
  assert.deepEqual(r.actions, [], 'напоминание никто не просил');
  assert.match(r.say, /не могу сходить/);
  delegate._test.reset();
});
