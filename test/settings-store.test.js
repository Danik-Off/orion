// Окно настроек без браузера (src/ui/src/settings/store.ts): загрузка, ошибка у своей строки, сбой связи с ядром
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../src/ui/src/settings/store.ts');

test('настройки: до загрузки — не загружено; ошибка сохранения — у своей строки; сбой связи с ядром не теряется', async () => {
  let answer = { ok: false, error: 'Сочетание занято другой программой' };
  const api = {
    settingsGet: async () => ({ values: { name: 'Орион', hotkey: 'CommandOrControl+Alt+J' }, skills: [], models: [], version: '0.5.1' }),
    settingsSave: async () => (answer instanceof Error ? Promise.reject(answer) : answer),
  };
  const store = createStore(api);
  assert.equal(store.getState().loaded, false, 'переключатели не рисуются «включёнными» до загрузки');
  await store.load();
  assert.equal(store.getState().loaded, true);

  assert.equal(await store.save({ hotkey: 'Alt+J' }), false);
  assert.equal(store.getState().errors.hotkey, 'Сочетание занято другой программой', 'ошибка — у строки, где меняли');
  assert.equal(store.getState().error, '');
  assert.equal(store.get('hotkey'), 'CommandOrControl+Alt+J', 'значение не поменялось');

  answer = { ok: true };
  assert.equal(await store.save({ hotkey: 'Alt+K' }), true);
  assert.equal(store.getState().errors.hotkey, undefined, 'исправили — ошибка ушла');

  answer = new Error('ipc: окно ядра закрыто');
  assert.equal(await store.save({ name: 'Джарвис' }), false, 'отклонённый вызов — не необработанное исключение');
  assert.match(store.getState().errors.name, /ipc/);

  const broken = createStore({ settingsGet: async () => Promise.reject(new Error('нет ответа')) });
  await broken.load();
  assert.equal(broken.getState().loaded, false);
  assert.match(broken.getState().loadError, /нет ответа/, 'есть что показать вместо пустой страницы');
});
