// Резервная копия: что входит, что нет, и что восстановление не пишет за пределы своей папки
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmp } = require('./helpers');
const { createBackup, checkBackup, restoreBackup } = require('../src/app/backup');

test('копия: настройки, память, голоса, заметки — да; журнал и модели — нет; открытые ключи — вырезаны', () => {
  const dir = tmp();
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({ name: 'Орион', remote: { apiKey: 'sk-plain' }, cloud: { providers: { a: { apiKey: 'enc:v1:AAAA' } } } }),
  );
  fs.writeFileSync(path.join(dir, 'people.json'), '{"people":[]}');
  fs.writeFileSync(path.join(dir, 'notes.json'), '{"lists":{}}');
  fs.writeFileSync(path.join(dir, 'actions.log'), 'журнал');
  fs.mkdirSync(path.join(dir, 'memory', 'people'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'people', 'anna.json'), '{"facts":[]}');
  fs.mkdirSync(path.join(dir, 'models'));
  fs.writeFileSync(path.join(dir, 'models', 'x.gguf'), 'big');

  const b = createBackup({ dataDir: dir, configFile, appVersion: '0.5.2' });
  assert.equal(b.format, 'orion-backup');
  assert.deepEqual(Object.keys(b.files).sort(), ['config.json', 'memory/people/anna.json', 'notes.json', 'people.json']);
  const cfg = JSON.parse(b.files['config.json']);
  assert.equal(cfg.remote.apiKey, '', 'ключ открытым текстом в копию не попадает');
  assert.equal(cfg.cloud.providers.a.apiKey, 'enc:v1:AAAA', 'зашифрованный системой — остаётся');
  assert.equal(cfg.name, 'Орион');
});

test('восстановление: свои файлы заменяются, старые — рядом; чужие пути и не-копии отвергаются', () => {
  const dir = tmp();
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(path.join(dir, 'notes.json'), 'старое');
  const data = {
    format: 'orion-backup',
    version: 1,
    created: '2026-10-10T10:00:00Z',
    files: {
      'notes.json': 'новое',
      'memory/shared/facts.json': '{"facts":["дом"]}',
      'config.json': '{"name":"Орион"}',
      '../evil.txt': 'x',
      'memory/../../evil2.txt': 'x',
      'C:/Windows/evil.txt': 'x',
      'actions.log': 'x',
    },
  };
  const r = restoreBackup(data, { dataDir: dir, configFile });
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.sort(), ['config.json', 'memory/shared/facts.json', 'notes.json']);
  assert.equal(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8'), 'новое');
  assert.equal(fs.readFileSync(path.join(dir, 'notes.json.before-restore'), 'utf8'), 'старое');
  assert.equal(fs.readFileSync(configFile, 'utf8'), '{"name":"Орион"}');
  assert.equal(fs.existsSync(path.join(dir, '..', 'evil.txt')), false);
  assert.equal(fs.existsSync(path.join(dir, 'actions.log')), false);

  assert.equal(checkBackup({ hello: 1 }).ok, false);
  assert.equal(checkBackup({ format: 'orion-backup', version: 99, files: { 'notes.json': '' } }).ok, false, 'копия новее приложения');
  assert.equal(checkBackup({ format: 'orion-backup', version: 1, files: { '../x': 'y' } }).ok, false, 'нет ни одного своего файла');
});
