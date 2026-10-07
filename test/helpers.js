// Общее для тестов: заглушка Electron, временные папки, реестр навыков на фиксированном конфиге,
// подставная модель. Тесты — без сети, без моделей и без Electron. Запуск: npm test
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// навыки подключают electron косвенно — подменяем его заглушкой (общей: тест окна кладёт в неё свой BrowserWindow)
const electron = {};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electron;
  return originalLoad.call(this, request, ...rest);
};

// Тесты не трогают компьютер: громкость, яркость, программы, клавиши, питание. Системные вызовы подменены до
// загрузки навыков — те берут функции при подключении. Что было бы сделано — в system.calls.
// ORION_SYSTEM_TESTS=1 — настоящие вызовы (только для тестов, которые сами за собой убирают).
// (Без этой защиты тест «сделай на 20 процентов тише» при каждом прогоне по-настоящему убавлял звук.)
const system = { calls: [], real: process.env.ORION_SYSTEM_TESTS === '1' };
if (!system.real) {
  const record =
    (name, result) =>
    async (...args) => (system.calls.push({ name, args }), result);
  const windows = require('../src/lib/windows');
  Object.assign(windows, {
    powershell: record('powershell', ''),
    launch: record('launch', { ok: true }),
    pressMediaKey: record('pressMediaKey'),
    listWindowedApps: record('listWindowedApps', []),
    closeProcessWindows: record('closeProcessWindows', 0),
    minimizeAll: record('minimizeAll'),
    pasteClipboard: record('pasteClipboard'),
  });
  const media = require('../src/lib/media');
  Object.assign(media, { sessions: record('media.sessions', []), control: record('media.control', true) });
}

const { loadConfig } = require('../src/core/config');
const { createSkillRegistry } = require('../src/core/skills');
const { createMemory } = require('../src/core/memory');
const allSkills = require('../src/skills');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orion-test-'));

// Конфиг тестов — свой, а не config.json проекта: личные настройки (выключенные навыки, имя) не меняют результат
const CONFIG_FILE = path.join(__dirname, 'fixtures', 'config.json');
const loadTestConfig = () => loadConfig(CONFIG_FILE);

function makeRegistry(overrides = {}) {
  const config = loadTestConfig();
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
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

module.exports = { tmp, makeRegistry, fakeLlm, makeZip, loadTestConfig, CONFIG_FILE, system, electron };
