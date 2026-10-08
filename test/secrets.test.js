// Ключи API и токены серверов MCP в config.json — зашифрованы (core/secrets.js); в памяти — обычные значения
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmp } = require('./helpers');
const { createSecrets, isSecret, PREFIX } = require('../src/core/secrets');
const { createSettings } = require('../src/core/settings');

// Подставное системное хранилище: «шифрует» обратимо
const fakeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`🔒${s}`),
  decryptString: (b) => b.toString().replace(/^🔒/, ''),
});

test('секреты: какие пути — секреты', () => {
  assert.ok(isSecret(['remote', 'apiKey']));
  assert.ok(isSecret(['cloud', 'providers', 0, 'apiKey']));
  assert.ok(isSecret(['mcp', 'servers', 'github', 'headers', 'Authorization']));
  assert.ok(isSecret(['mcp', 'servers', 'brave', 'env', 'BRAVE_API_KEY']));
  assert.ok(!isSecret(['remote', 'model']));
  assert.ok(!isSecret(['mcp', 'servers', 'github', 'url']));
});

test('секреты: в файле — зашифрованы, в памяти — обычные; старый файл перешифровывается; без хранилища — как раньше', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ remote: { apiKey: 'старый-ключ', model: 'm' } }));
  const config = { remote: { apiKey: 'старый-ключ', model: 'm', type: 'openai', baseUrl: '' }, skills: {} };
  const secrets = createSecrets(fakeStorage());
  const settings = createSettings({ config, file, skills: [], setHotkey: () => true, secrets });

  assert.equal(settings.reseal(), true, 'ключ открытым текстом — перешифрован');
  let onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(onDisk.remote.apiKey.startsWith(PREFIX));
  assert.equal(onDisk.remote.model, 'm', 'обычные настройки — как есть');
  assert.equal(settings.reseal(), false, 'второй раз нечего');

  assert.equal(settings.save({ 'remote.apiKey': 'новый-ключ' }).ok, true);
  onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(onDisk.remote.apiKey.startsWith(PREFIX));
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /новый-ключ/, 'ключа открытым текстом в файле нет');
  assert.equal(config.remote.apiKey, 'новый-ключ', 'в памяти — обычный');

  settings.setPath(['mcp', 'servers', 'github'], { url: 'https://x', headers: { Authorization: 'Bearer токен' } });
  onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(onDisk.mcp.servers.github.headers.Authorization.startsWith(PREFIX));
  assert.equal(onDisk.mcp.servers.github.url, 'https://x');

  // При следующем запуске: файл → память
  const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  secrets.openInto(loaded);
  assert.equal(loaded.remote.apiKey, 'новый-ключ');
  assert.equal(loaded.mcp.servers.github.headers.Authorization, 'Bearer токен');

  // Системного хранилища нет — открытым текстом, как раньше (лучше так, чем не работать)
  const plain = createSecrets(fakeStorage(false));
  assert.deepEqual(plain.seal({ remote: { apiKey: 'k' } }), { remote: { apiKey: 'k' } });
});
