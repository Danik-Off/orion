// Установка, сборка под ОС, встроенный llama.cpp, настройки
require('./helpers'); // заглушка Electron — до подключения навыков
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSkillRegistry } = require('../src/core/skills');
const { loadConfig } = require('../src/core/config');
const { tmp, loadTestConfig } = require('./helpers');
const allSkills = require('../src/skills');

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

test('навыки Windows не подключаются на других ОС', () => {
  const { supports } = require('../src/core/skills');
  const power = allSkills.find((s) => s.id === 'power');
  const weatherSkill = allSkills.find((s) => s.id === 'weather');
  assert.equal(supports(power, 'win32'), true);
  assert.equal(supports(power, 'darwin'), false);
  assert.equal(supports(weatherSkill, 'linux'), true);
  const config = loadTestConfig();
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
  const config = loadTestConfig();
  const p = paths({ ...config, model: 'qwen3.5:4b' }, '/m');
  assert.ok(p.gguf.endsWith(path.join('llm', 'Qwen3.5-4B-Q4_K_M.gguf')));
  assert.match(p.ggufUrl, /^https:\/\/huggingface\.co\/unsloth\//);
  assert.match(p.url, /\/b\d+\/llama-b\d+-bin-/);
  assert.equal(paths({ ...config, model: 'my.gguf' }, '/m').ggufUrl, undefined); // своя модель не качается
});

test('установка: первый запуск — голос, слух и быстрые команды; большая модель — отдельно и по выбору движка', () => {
  const { plan, FIRST_RUN, brainReady, remoteConfigured } = require('../src/core/setup');
  const base = loadTestConfig();
  const names = (config, stage) =>
    plan(config, '/m')
      .filter((i) => i.stage === stage)
      .map((i) => i.name);

  assert.deepEqual(FIRST_RUN, ['voice', 'hearing', 'router'], 'Qwen в первый набор не входит');
  const router = names({ ...base, router: { ...base.router, enabled: true } }, 'router');
  assert.ok(
    router.some((n) => n.startsWith('llama.cpp')),
    'llama.cpp — вместе с маленькой моделью',
  );
  assert.ok(router.includes('orion-router-q8_0.gguf'), 'дообученная маленькая модель скачивается');

  const local = names({ ...base, backend: 'llamacpp' }, 'brain');
  assert.deepEqual(local, ['Qwen3.5-4B-Q4_K_M.gguf'], 'llama.cpp уже поставлен с быстрыми командами');
  assert.deepEqual(names({ ...base, backend: 'ollama' }, 'brain'), [], 'модель Ollama качает сам Ollama');
  assert.deepEqual(names({ ...base, backend: 'remote' }, 'brain'), [], 'внешней модели качать нечего');
  assert.deepEqual(names({ ...base, backend: 'none' }, 'brain'), []);
  const noRouter = names({ ...base, backend: 'llamacpp', router: { ...base.router, enabled: false } }, 'brain');
  assert.ok(
    noRouter.some((n) => n.startsWith('llama.cpp')),
    'без быстрых команд llama.cpp ставится с большой моделью',
  );

  assert.equal(remoteConfigured({ remote: { type: 'openai', baseUrl: 'https://x/v1', model: 'm' } }), true);
  assert.equal(remoteConfigured({ remote: { type: 'openai', baseUrl: '', model: 'm' } }), false);
  return brainReady({ ...base, backend: 'none' }, '/m').then((r) => assert.equal(r, false));
});
