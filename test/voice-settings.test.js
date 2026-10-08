// Голосом — настройки компьютера (тема, Wi-Fi, Bluetooth, экран, питание, «Параметры») и свои настройки Ориона.
// Системные вызовы подменены (helpers): проверяем, что было бы сделано, а не делаем.
const { system, makeRegistry } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const toolOf = (skills, text) => {
  const a = skills.quickPlan(text)?.actions?.[0];
  return a ? `${a.tool} ${a.arg}` : null;
};

test('настройки компьютера: фразы → команды без модели', () => {
  const { skills } = makeRegistry();
  const cases = {
    'включи тёмную тему': 'pc_setting theme dark',
    'Сделай светлую тему.': 'pc_setting theme light',
    'выключи вай фай': 'pc_setting wifi off',
    'включи wi-fi': 'pc_setting wifi on',
    'выключи блютуз': 'pc_setting bluetooth off',
    'выключи экран': 'pc_setting screen off',
    'включи режим экономии энергии': 'pc_setting power saver',
    'режим высокой производительности': 'pc_setting power performance',
    'открой настройки звука': 'windows_settings звук',
    'открой параметры блютуза': 'windows_settings bluetooth',
    'открой настройки виндовс': 'windows_settings параметры',
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(toolOf(skills, text), want, text);
  assert.equal(skills.quickPlan('открой настройки')?.actions?.[0]?.tool === 'windows_settings', false); // свои — не «Параметры Windows»
});

test('настройки компьютера: Wi-Fi выключается только с разрешения; тема — реестр', async () => {
  const { skills, ctx, opened } = makeRegistry();
  system.calls.length = 0;
  ctx.confirm = async () => false;
  const no = await skills.run('pc_setting', 'wifi off');
  assert.equal(no.ok, false);
  assert.equal(system.calls.length, 0);

  await skills.run('pc_setting', 'theme dark');
  const ps = system.calls.find((c) => c.name === 'powershell');
  assert.match(ps.args[0], /AppsUseLightTheme/);
  assert.equal(ps.args[1].env.ORION_LIGHT, '0');

  assert.equal((await skills.run('pc_setting', 'format c')).ok, false);
  await skills.run('windows_settings', 'звук');
  assert.deepEqual(opened, ['ms-settings:sound']);
});

test('свои настройки: фразы → my_setting', () => {
  const { skills } = makeRegistry();
  const cases = {
    'говори помедленнее': 'my_setting speed slower',
    'говори чуть быстрее': 'my_setting speed faster',
    'смени голос': 'my_setting voice next',
    'голос номер три': 'my_setting voice 3',
    'теперь тебя зовут джарвис': 'my_setting name джарвис',
    'мой город Казань': 'my_setting city казань',
    'жди ответа подольше': 'my_setting wait longer',
    'какие у тебя настройки': 'my_setting show',
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(toolOf(skills, text), want, text);
});

test('свои настройки: сохраняются через saveSettings, границы соблюдаются', async () => {
  const { skills, ctx } = makeRegistry();
  const saved = [];
  ctx.saveSettings = (patch) => {
    saved.push(patch);
    for (const [k, v] of Object.entries(patch)) {
      const keys = k.split('.');
      let o = ctx.config;
      for (const key of keys.slice(0, -1)) o = o[key] ??= {};
      o[keys.at(-1)] = v;
    }
    return { ok: true, restart: 'name' in patch };
  };
  ctx.config.speech.ttsSpeed = 1;
  await skills.run('my_setting', 'speed faster');
  assert.deepEqual(saved.at(-1), { 'speech.ttsSpeed': 1.1 });
  ctx.config.speech.ttsSpeed = 1.6;
  assert.match((await skills.run('my_setting', 'speed faster')).speak, /некуда/);

  ctx.config.speech.ttsSpeaker = 9;
  await skills.run('my_setting', 'voice next');
  assert.deepEqual(saved.at(-1), { 'speech.ttsSpeaker': 0 });
  assert.equal((await skills.run('my_setting', 'voice 12')).ok, false);

  const r = await skills.run('my_setting', 'name джарвис');
  assert.deepEqual(saved.at(-1), { name: 'Джарвис' });
  assert.match(r.speak, /перезапуска/);
  assert.equal((await skills.run('my_setting', 'name ')).ok, false);

  await skills.run('my_setting', 'city нижний новгород');
  assert.deepEqual(saved.at(-1), { city: 'Нижний Новгород' });
  assert.match((await skills.run('my_setting', 'show')).speak, /Джарвис.*Нижний Новгород/s);
});

test('настройки голосом: большой модели — только целые команды, яркость и скорость сети остаются маленькой', () => {
  const { skills } = makeRegistry();
  assert.equal(skills.external('выключи вайфай'), 'system');
  assert.equal(skills.external('пусть тебя зовут Пятница'), 'assistant-settings');
  for (const t of ['сделай экран темнее', 'какая скорость вайфая', 'открой настройки', 'запиши мой голос'])
    assert.equal(skills.external(t), null, t);
});
