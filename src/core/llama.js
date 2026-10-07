// Встроенная языковая модель: llama.cpp (llama-server) и файл модели GGUF — оба лежат в папке models,
// скачиваются установщиком (core/setup.js) и удаляются вместе с ней. Никаких сторонних программ.
// Сервер слушает только 127.0.0.1 на свободном порту и принимает запросы лишь с ключом этого запуска.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const RELEASES = 'https://github.com/ggml-org/llama.cpp/releases/download';

// Модели по короткому имени (то же имя, что у Ollama, — настройка «model» одна на оба движка)
// repo — файл с Hugging Face; url — прямая ссылка; tools: true — модели нужны описания инструментов в запросе
const MODELS = {
  'qwen3.5:4b': { repo: 'unsloth/Qwen3.5-4B-GGUF', file: 'Qwen3.5-4B-Q4_K_M.gguf', size: 2.74e9 },
  // Маленькая модель вызова функций (core/router.js), дообученная под навыки Ориона (scripts/router-train.py):
  // инструменты знает наизусть. Скачивается при первом запуске — с ней Орион выполняет команды без большой модели
  'orion-router': {
    url: 'https://github.com/Danik-Off/orion/releases/download/models-router-v1/orion-router-q8_0.gguf',
    file: 'orion-router-q8_0.gguf',
    size: 2.92e8,
  },
  // Исходная FunctionGemma — для дообучения и сравнения; ей нужны описания инструментов
  'functiongemma:270m': { repo: 'unsloth/functiongemma-270m-it-GGUF', file: 'functiongemma-270m-it-Q8_0.gguf', size: 2.92e8, tools: true },
};

// Сборка llama.cpp для этой машины. Vulkan работает на видеокартах NVIDIA, AMD и Intel, а без видеокарты —
// на процессоре (модули процессора лежат в той же сборке). На macOS — Metal.
function variant(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'arm64' ? 'win-cpu-arm64' : 'win-vulkan-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  return arch === 'arm64' ? 'ubuntu-vulkan-arm64' : 'ubuntu-vulkan-x64';
}

// Где что лежит и откуда качать. model — имя из MODELS или имя своего файла .gguf в models/llm
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
    gguf: path.join(modelsDir, 'llm', file),
    ggufUrl: known && (known.url || `https://huggingface.co/${known.repo}/resolve/main/${known.file}`),
    size: known?.size,
  };
}

// Модели для списка в настройках: известные и свои файлы .gguf из models/llm
function localModels(modelsDir) {
  let files = [];
  try {
    files = fs.readdirSync(path.join(modelsDir, 'llm')).filter((f) => f.endsWith('.gguf'));
  } catch {}
  const knownFiles = new Set(Object.values(MODELS).map((m) => m.file));
  return [...Object.keys(MODELS), ...files.filter((f) => !knownFiles.has(f))];
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

// «Vulkan0: NVIDIA GeForce RTX 5070 (11943 MiB, 11175 MiB free)» → [{ name, title, free }]
function parseDevices(text) {
  return [...String(text).matchAll(/^\s*([A-Za-z]+\d+):\s*(.+?)\s*\((\d+) MiB, (\d+) MiB free\)/gm)].map((m) => ({
    name: m[1],
    title: m[2],
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

module.exports = { createLlamaServer, paths, variant, localModels, parseDevices, pickDevice, MODELS };
