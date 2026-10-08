// Встроенная языковая модель: llama.cpp (llama-server) и файл модели GGUF — оба лежат в папке models,
// скачиваются установщиком (core/setup.js) и удаляются вместе с ней. Никаких сторонних программ.
// Сервер слушает только 127.0.0.1 на свободном порту и принимает запросы лишь с ключом этого запуска.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const RELEASES = 'https://github.com/ggml-org/llama.cpp/releases/download';

// Модели по короткому имени (то же имя, что у Ollama, — настройка «model» одна на оба движка).
// Большие — каталог «Модели на компьютере»: каждая проверена в Орионе (npm run eval -- --model …), см. docs/TECHNICAL.md.
//   repo — файл с Hugging Face; url — прямая ссылка; size — байты; title, about, tags, license — для каталога;
//   accuracy, ms — замер на 108 фразах (доля верных планов и среднее время ответа, RTX 5070) — видно в каталоге;
//   tools: true — модели нужны описания инструментов в запросе; internal — маленькая модель первой ступени
const MODELS = {
  'qwen3.5:4b': {
    accuracy: 0.96,
    ms: 435,
    repo: 'unsloth/Qwen3.5-4B-GGUF',
    file: 'Qwen3.5-4B-Q4_K_M.gguf',
    size: 2.74e9,
    title: 'Qwen 3.5 4B',
    about: 'Лучший баланс скорости и ума для Ориона',
    tags: ['по умолчанию', 'рекомендую'],
    license: 'Apache 2.0',
  },
  'qwen3.5:0.8b': {
    accuracy: 0.6,
    ms: 317,
    repo: 'unsloth/Qwen3.5-0.8B-GGUF',
    file: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    size: 5.33e8,
    title: 'Qwen 3.5 0.8B',
    about: 'Самая лёгкая, для слабых компьютеров; понимает заметно хуже',
    tags: ['лёгкая'],
    license: 'Apache 2.0',
  },
  'qwen3.5:2b': {
    accuracy: 0.86,
    ms: 252,
    repo: 'unsloth/Qwen3.5-2B-GGUF',
    file: 'Qwen3.5-2B-Q4_K_M.gguf',
    size: 1.28e9,
    title: 'Qwen 3.5 2B',
    about: 'Быстрая и нетребовательная',
    tags: ['лёгкая'],
    license: 'Apache 2.0',
  },
  'qwen3.5:9b': {
    repo: 'unsloth/Qwen3.5-9B-GGUF',
    file: 'Qwen3.5-9B-Q4_K_M.gguf',
    size: 5.68e9,
    title: 'Qwen 3.5 9B',
    about: 'Старшая Qwen 3.5: умнее в разговоре, медленнее; точность не замерялась',
    tags: [],
    license: 'Apache 2.0',
  },
  'gemma4:e4b': {
    accuracy: 0.95,
    ms: 1639,
    repo: 'ggml-org/gemma-4-E4B-it-GGUF',
    file: 'gemma-4-E4B-it-Q4_0.gguf',
    size: 4.59e9,
    title: 'Gemma 4 E4B',
    about: 'Модель Google: понимает почти как Qwen 4B, но отвечает медленнее',
    tags: [],
    license: 'Apache 2.0',
  },
  'gemma4:12b': {
    repo: 'google/gemma-4-12B-it-qat-q4_0-gguf',
    file: 'gemma-4-12b-it-qat-q4_0.gguf',
    size: 6.98e9,
    title: 'Gemma 4 12B',
    about: 'Старшая Gemma 4 для мощной видеокарты; точность не замерялась',
    tags: [],
    license: 'Apache 2.0',
  },
  'yandexgpt5-lite:8b': {
    accuracy: 0.83,
    ms: 751,
    repo: 'yandex/YandexGPT-5-Lite-8B-instruct-GGUF',
    file: 'YandexGPT-5-Lite-8B-instruct-Q4_K_M.gguf',
    size: 4.92e9,
    title: 'YandexGPT 5 Lite',
    about: 'Модель Яндекса, обучена на русском',
    tags: ['русская'],
    license: 'YandexGPT-5-Lite',
  },
  // Маленькая модель вызова функций (core/router.js), дообученная под навыки Ориона (scripts/router-train.py):
  // инструменты знает наизусть. Скачивается при первом запуске — с ней Орион выполняет команды без большой модели
  'orion-router': {
    url: 'https://github.com/Danik-Off/orion/releases/download/models-router-v2/orion-router-q8_0.gguf',
    file: 'orion-router-q8_0.gguf',
    size: 2.92e8,
    internal: true, // своя внутренняя модель первой ступени — в списке больших моделей не показывается
    // Скачанный файл сверяется с этой суммой (npm run router-release печатает её для нового файла)
    sha256: '1914e12408becaf48ec78a7c3594bc8631be98821ed86c4c186ec89d08fded5a',
  },
  // Исходная FunctionGemma — для дообучения и сравнения; ей нужны описания инструментов
  'functiongemma:270m': {
    repo: 'unsloth/functiongemma-270m-it-GGUF',
    file: 'functiongemma-270m-it-Q8_0.gguf',
    size: 2.92e8,
    tools: true,
    internal: true,
  },
};

// Сборка llama.cpp для этой машины. Vulkan работает на видеокартах NVIDIA, AMD и Intel, а без видеокарты —
// на процессоре (модули процессора лежат в той же сборке). На macOS — Metal.
function variant(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'arm64' ? 'win-cpu-arm64' : 'win-vulkan-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  return arch === 'arm64' ? 'ubuntu-vulkan-arm64' : 'ubuntu-vulkan-x64';
}

// Где что лежит и откуда качать. model — имя из MODELS, имя своего файла .gguf в models/llm или полный путь к .gguf
function paths(config, modelsDir) {
  const { build } = config.llamaCpp;
  const v = config.llamaCpp.variant || variant();
  const dir = path.join(modelsDir, 'llama.cpp', `${build}-${v}`);
  const known = MODELS[config.model];
  const file = known ? known.file : config.model;
  return {
    dir,
    exe: path.join(dir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'),
    url: `${RELEASES}/${build}/llama-${build}-bin-${v}.${v.startsWith('win') ? 'zip' : 'tar.gz'}`,
    gguf: path.isAbsolute(file) ? file : path.join(modelsDir, 'llm', file),
    ggufUrl: known && (known.url || `https://huggingface.co/${known.repo}/resolve/main/${known.file}`),
    size: known?.size,
    sha256: known?.sha256,
  };
}

// Модели для списка в настройках: известные и свои файлы .gguf из models/llm
// Маленькие модели первой ступени (orion-router, FunctionGemma и их файлы, в том числе свои дообученные) —
// внутренние: большой моделью их не выбирают
const isInternalModel = (name) => !!MODELS[name]?.internal || /^(orion-router|functiongemma)/i.test(String(name));

// Скачанные модели (и текущая, даже если её файла ещё нет) — для списка «Модель» в настройках
function localModels(modelsDir, current = '') {
  let files = [];
  try {
    files = fs.readdirSync(path.join(modelsDir, 'llm')).filter((f) => f.endsWith('.gguf'));
  } catch {}
  const have = new Set(files);
  const known = Object.keys(MODELS).filter((id) => have.has(MODELS[id].file) || id === current);
  const knownFiles = new Set(Object.values(MODELS).map((m) => m.file));
  return [...known, ...files.filter((f) => !knownFiles.has(f))].filter((m) => !isInternalModel(m));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// «Vulkan0: NVIDIA GeForce RTX 5070 (11943 MiB, 11175 MiB free)» → [{ name, title, total, free }] (МиБ)
function parseDevices(text) {
  return [...String(text).matchAll(/^\s*([A-Za-z]+\d+):\s*(.+?)\s*\((\d+) MiB, (\d+) MiB free\)/gm)].map((m) => ({
    name: m[1],
    title: m[2],
    total: Number(m[3]),
    free: Number(m[4]),
  }));
}

// Одна видеокарта, самая подходящая: дискретная, а среди них — с большей свободной памятью.
// Встроенная видеокарта берёт «память» из общей и показывает её много — по одному объёму её не отличить.
const DISCRETE = /nvidia|geforce|rtx|quadro|tesla|radeon\s*(rx|pro)|\barc\b|apple/i;
function pickDevice(devices) {
  return [...devices].sort((a, b) => DISCRETE.test(b.title) - DISCRETE.test(a.title) || b.free - a.free)[0] || null;
}

function listDevices(exe) {
  return new Promise((resolve) =>
    execFile(exe, ['--list-devices'], { cwd: path.dirname(exe), timeout: 30_000, windowsHide: true }, (_err, out, err) =>
      resolve(parseDevices(`${out}\n${err}`)),
    ),
  );
}

// Сервер запускается при первом запросе (или заранее — ensure). idleMs — выгрузить модель после стольких
// миллисекунд без запросов (видеопамять свободна, пока ассистент молчит); 0 — держать, пока живёт приложение
function createLlamaServer({ config, modelsDir, log = () => {}, idleMs = 0, name = 'llama' }) {
  const key = crypto.randomBytes(24).toString('hex');
  let proc = null;
  let port = 0;
  let starting = null;
  let tail = []; // последние строки журнала сервера — для понятной ошибки, если он не поднялся
  let idleTimer = null;
  function touch() {
    clearTimeout(idleTimer);
    if (idleMs > 0) {
      idleTimer = setTimeout(() => proc && (log({ [name]: 'выгружен после простоя', min: Math.round(idleMs / 60000) }), stop()), idleMs);
      idleTimer.unref?.();
    }
  }

  async function start() {
    const p = paths(config, modelsDir);
    if (!fs.existsSync(p.exe) || !fs.existsSync(p.gguf)) {
      throw Object.assign(new Error('Языковая модель ещё не скачана'), { code: 'NO_MODEL' });
    }
    port = await freePort();
    const devices = await listDevices(p.exe);
    const device = config.llamaCpp.device || pickDevice(devices)?.name;
    // Слоты: у каждого своё окно контекста и свой кэш начала промпта. Сервер сам ведёт запрос в слот с самым
    // похожим началом — длинный промпт диспетчера и короткие промпты инструментов не вытесняют друг друга
    // (замер: повторный запрос 50 мс вместо 300). Окно — на каждый слот
    const slots = Math.max(1, config.llamaCpp.slots ?? 1);
    const args = [
      '-m',
      p.gguf,
      '-c',
      String((config.numCtx || 6144) * slots),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--api-key',
      key,
      '-np',
      String(slots),
      '-ngl',
      String(config.llamaCpp.gpuLayers ?? 999), // всё на видеокарту; без неё параметр ничего не делает
    ];
    if (device) args.push('-dev', device);
    // Без «размышлений вслух»: у Qwen это выключает и chat_template_kwargs, а у других моделей (Gemma 4 и т. п.)
    // свой шаблон — флаг движка выключает для любой. Включить — config.think: true
    if (config.think !== true) args.push('--reasoning', 'off');
    // Свои параметры запуска (config.json → llamaCpp.args: ["-ctk", "q8_0"]) — для тонкой подстройки
    const extra = Array.isArray(config.llamaCpp.args) ? config.llamaCpp.args.map(String) : [];
    args.push(...extra);
    tail = [];
    proc = spawn(p.exe, args, { cwd: p.dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.setEncoding('utf8').on('data', (d) => (tail = [...tail, ...d.split('\n').filter(Boolean)].slice(-15)));
    const me = proc;
    proc.on('exit', (code) => {
      log({ [name]: 'сервер остановлен', code });
      if (proc === me) {
        proc = null;
        starting = null;
      }
    });
    log({ [name]: 'запуск', model: path.basename(p.gguf), device: device || 'процессор', devices: devices.map((d) => d.title) });

    // Модель загружается несколько секунд: /health отвечает 503, пока не готова
    const t0 = Date.now();
    while (Date.now() - t0 < 180_000) {
      if (proc !== me) throw new Error(`llama.cpp не запустился: ${tail.slice(-3).join(' | ') || 'без сообщения'}`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          log({ [name]: 'готов', ms: Date.now() - t0 });
          return;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    stop();
    throw new Error('llama.cpp слишком долго загружает модель');
  }

  function ensure() {
    starting ||= start().catch((err) => {
      starting = null;
      throw err;
    });
    return starting;
  }

  function stop() {
    const p = proc;
    proc = null;
    starting = null;
    p?.kill();
  }

  return {
    ensure,
    // Каждый запрос откладывает выгрузку по простою
    url: async () => (await ensure(), touch(), `http://127.0.0.1:${port}`),
    running: () => !!proc, // запущен или загружается
    // Скачаны ли llama.cpp и файл модели — без них сервер не запустить (ступень тогда пропускается)
    available: () => {
      const p = paths(config, modelsDir);
      return fs.existsSync(p.exe) && fs.existsSync(p.gguf);
    },
    headers: { Authorization: `Bearer ${key}` },
    stop,
    restart: () => (stop(), ensure()),
  };
}

module.exports = { createLlamaServer, paths, variant, localModels, isInternalModel, parseDevices, pickDevice, listDevices, MODELS };
