// Установка всего, что нужно ассистенту: модели речи и языковые модели. Идёт по этапам, чтобы ассистент
// как можно раньше заговорил:
//   voice   — голос (синтез) и детектор речи: после него ассистент может представиться;
//   hearing — распознавание речи и узнавание голоса;
//   router  — маленькая модель вызова функций (~300 МБ) и llama.cpp: команды без большой модели;
//   brain   — большая языковая модель (Qwen, ~2,7 ГБ, или модель в Ollama) — только по согласию:
//             после первой установки ассистент предлагает её сам, позже — кнопка в настройках.
// Первый запуск ставит FIRST_RUN. Используется приложением и командой `npm run models`.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');
const llama = require('./llama');

const SHERPA = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const SUPERTONIC_FP32 = 'https://huggingface.co/Supertone/supertonic-3/resolve/main/onnx';

// Системный bsdtar из Windows 10+ (а не GNU tar из Git Bash — тот не понимает пути C:\). Понимает и .zip
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';

const useOllama = (config) => config.backend === 'ollama';
const FIRST_RUN = ['voice', 'hearing', 'router'];
const ALL_STAGES = ['voice', 'hearing', 'router', 'brain'];

// Что скачать: { stage, name, url, target, archive?, unpackTo? } — target проверяется на существование
function plan(config, modelsDir) {
  const s = config.speech;
  const items = [];
  const archive = (stage, release, name) => ({
    stage,
    name,
    url: `${SHERPA}/${release}/${name}.tar.bz2`,
    target: path.join(modelsDir, name),
    archive: true,
  });
  const file = (stage, release, name) => ({ stage, name, url: `${SHERPA}/${release}/${name}`, target: path.join(modelsDir, name) });

  items.push(file('voice', 'asr-models', 'silero_vad.onnx'));
  if (s.ttsModel) items.push(archive('voice', 'tts-models', s.ttsModel));
  // Полноточные файлы Supertonic 3 (чище звук): vocoder — только вокодер, full — всё
  if (/supertonic-3/.test(s.ttsModel || '') && ['vocoder', 'full'].includes(s.ttsPrecision)) {
    const parts = s.ttsPrecision === 'full' ? ['vocoder', 'vector_estimator', 'text_encoder', 'duration_predictor'] : ['vocoder'];
    for (const p of parts) {
      items.push({
        stage: 'voice',
        name: `supertonic-3 ${p}`,
        url: `${SUPERTONIC_FP32}/${p}.onnx`,
        target: path.join(modelsDir, 'supertonic-3-fp32', `${p}.onnx`),
      });
    }
  }
  if (s.asrModel) items.push(archive('hearing', 'asr-models', s.asrModel));
  if (s.asrSecondPass) items.push(archive('hearing', 'asr-models', s.asrSecondPass));
  if (s.speaker?.model && s.speaker.require !== 'off') items.push(file('hearing', 'speaker-recongition-models', s.speaker.model));

  // llama.cpp (~35 МБ) — один на обе модели; ставится с той, что качается первой
  const l = llama.paths(config, modelsDir);
  const engine = (stage) => ({
    stage,
    name: `llama.cpp ${config.llamaCpp.build}`,
    url: l.url,
    target: l.exe,
    archive: true,
    unpackTo: l.dir,
  });
  // Маленькая модель первой ступени (core/router.js) всегда работает во встроенном llama.cpp — даже при Ollama
  if (config.router?.enabled) {
    items.push(engine('router'));
    const r = llama.paths({ ...config, model: config.router.model }, modelsDir);
    if (r.ggufUrl)
      items.push({ stage: 'router', name: path.basename(r.gguf), url: r.ggufUrl, target: r.gguf, size: r.size, sha256: r.sha256 });
  }
  // Большая модель на этом компьютере. В Ollama её качает сам Ollama (см. install), внешней качать нечего
  if (config.backend === 'llamacpp') {
    if (!config.router?.enabled) items.push(engine('brain'));
    if (l.ggufUrl)
      items.push({ stage: 'brain', name: path.basename(l.gguf), url: l.ggufUrl, target: l.gguf, size: l.size, sha256: l.sha256 });
  }
  return items;
}

// Чего не хватает на этапах stages (по умолчанию — на всех)
const missing = (config, modelsDir, stages = ALL_STAGES) =>
  plan(config, modelsDir).filter((i) => stages.includes(i.stage) && !fs.existsSync(i.target));

// Скачивание с прогрессом: onProgress(доля 0..1). Оборванная загрузка продолжается с того же места
// (файл модели — гигабайты, начинать заново обидно)
async function download(url, file, onProgress) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.part`;
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const res = await fetch(url, { redirect: 'follow', headers: have ? { Range: `bytes=${have}-` } : {} });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const resumed = res.status === 206;
  const start = resumed ? have : 0;
  const total = start + (Number(res.headers.get('content-length')) || 0);
  let done = start;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      if (total > start) onProgress(done / total);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
  if (total > start && fs.statSync(part).size !== total) throw new Error('Загрузка оборвалась');
  fs.renameSync(part, file);
}

// Распаковать архив llama.cpp: в архиве для Windows файлы лежат в корне, для macOS и Linux — в папке.
// Папку с llama-server делаем папкой unpackTo — так путь к нему не зависит от устройства архива.
function unpackLlama(archiveFile, unpackTo) {
  const tmp = `${unpackTo}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  execFileSync(TAR, ['-xf', archiveFile, '-C', tmp], { stdio: 'ignore' });
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const find = (dir) => {
    if (fs.existsSync(path.join(dir, exe))) return dir;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const found = e.isDirectory() && find(path.join(dir, e.name));
      if (found) return found;
    }
    return null;
  };
  const bin = find(tmp);
  if (!bin) throw new Error('В архиве llama.cpp нет llama-server');
  fs.rmSync(unpackTo, { recursive: true, force: true });
  fs.renameSync(bin, unpackTo);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Контрольная сумма файла (sha256) — потоком: модели весят сотни мегабайт
async function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

async function installItem(item, modelsDir, onProgress) {
  const tmp = item.archive ? path.join(modelsDir, path.basename(new URL(item.url).pathname)) : item.target;
  for (let attempt = 1; ; attempt++) {
    try {
      await download(item.url, tmp, onProgress);
      break;
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  // Известна сумма (свои модели из релизов GitHub) — битый или подменённый файл не запускаем.
  // Не перекачиваем: несовпадение скорее значит, что файл на сервере другой, — повтор качал бы его же
  if (item.sha256 && (await sha256Of(tmp)) !== item.sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${item.name}: файл повреждён или не той версии`);
  }
  if (!item.archive) return;
  if (item.unpackTo) unpackLlama(tmp, item.unpackTo);
  else execFileSync(TAR, ['-xf', tmp, '-C', modelsDir], { stdio: 'ignore' });
  fs.unlinkSync(tmp);
}

// --- Ollama: языковая модель, если в настройках выбран он ---

async function ollamaHasModel(config) {
  const origin = new URL(config.ollamaUrl).origin;
  const res = await fetch(`${origin}/api/tags`, { signal: AbortSignal.timeout(3000) });
  const { models = [] } = await res.json();
  const want = config.model.includes(':') ? config.model : `${config.model}:latest`;
  return models.some((m) => m.name === want || m.model === want);
}

// Скачать модель через Ollama с прогрессом (Ollama отдаёт построчный JSON)
async function ollamaPull(config, onProgress) {
  const origin = new URL(config.ollamaUrl).origin;
  const res = await fetch(`${origin}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, stream: true }),
  });
  if (!res.ok) throw new Error(`Ollama: HTTP ${res.status}`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      if (msg.total) onProgress(msg.completed / msg.total);
    }
  }
}

// Внешняя модель настроена: есть модель и адрес (у OpenAI-совместимой) или ключ (у Anthropic — можно в окружении)
function remoteConfigured(config) {
  const r = config.remote || {};
  if (!r.model) return false;
  return r.type === 'anthropic' ? !!(r.apiKey || process.env.ANTHROPIC_API_KEY) : !!r.baseUrl;
}

// Большая модель готова? llama.cpp — файлы на месте; Ollama — модель в Ollama; внешняя — настроена; none — нет
async function brainReady(config, modelsDir) {
  if (config.backend === 'llamacpp') return missing(config, modelsDir, ['brain']).length === 0;
  if (useOllama(config)) return ollamaHasModel(config).catch(() => false);
  if (config.backend === 'remote') return remoteConfigured(config);
  return false;
}

// --- Сколько весит установка: показываем до начала загрузки ---

// Запасные размеры загрузки в байтах, если сервер не ответил (замерено 2026-09)
const KNOWN_SIZES = {
  'silero_vad.onnx': 0.7e6,
  'sherpa-onnx-supertonic-3-tts-int8-2026-05-11': 129e6,
  'supertonic-3 vocoder': 102e6,
  'supertonic-3 vector_estimator': 257e6,
  'supertonic-3 text_encoder': 36e6,
  'supertonic-3 duration_predictor': 4e6,
  'sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16': 24e6,
  'sherpa-onnx-zipformer-ru-int8-2025-04-20': 60e6,
  '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx': 28e6,
};
const KNOWN_OLLAMA_SIZES = { 'qwen3.5:4b': 3.4e9 };
const PART_TITLES = {
  voice: 'Голос',
  hearing: 'Слух: распознавание речи и голосов',
  router: 'Быстрые команды (маленькая модель)',
  brain: 'Большая языковая модель',
};

async function remoteSize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const n = Number(res.headers.get('content-length'));
    return res.ok && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// Размер модели Ollama — сумма слоёв в манифесте реестра (qwen3.5:4b → library/qwen3.5, тег 4b)
async function ollamaModelSize(model) {
  const [name, tag = 'latest'] = model.split(':');
  const repo = name.includes('/') ? name : `library/${name}`;
  try {
    const res = await fetch(`https://registry.ollama.ai/v2/${repo}/manifests/${tag}`, {
      headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' },
      signal: AbortSignal.timeout(8000),
    });
    const m = await res.json();
    const n = (m.layers || []).reduce((s, l) => s + (l.size || 0), 0);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

// Что предстоит скачать: { parts: [{ stage, title, bytes }], total, ollama }
//   ollama: false — выбран движок Ollama, а он не отвечает: его нужно поставить отдельно (ollama.com)
async function estimate(config, modelsDir, stages = FIRST_RUN) {
  const todo = missing(config, modelsDir, stages);
  const sizes = await Promise.all(todo.map(async (i) => (await remoteSize(i.url)) ?? i.size ?? KNOWN_SIZES[i.name] ?? 0));
  const brainTitle = `${PART_TITLES.brain} ${config.model}`;
  const parts = stages
    .map((stage) => ({
      stage,
      title: stage === 'brain' ? brainTitle : PART_TITLES[stage],
      bytes: todo.reduce((s, item, k) => s + (item.stage === stage ? sizes[k] : 0), 0),
      count: todo.filter((i) => i.stage === stage).length,
    }))
    .filter((p) => p.count > 0);

  let ollama = true;
  if (useOllama(config) && stages.includes('brain')) {
    const has = await ollamaHasModel(config).catch(() => ((ollama = false), false));
    if (!has) {
      const bytes = (await ollamaModelSize(config.model)) ?? KNOWN_OLLAMA_SIZES[config.model] ?? 0;
      parts.push({ stage: 'brain', title: brainTitle, bytes, count: 1 });
    }
  }
  return { parts, total: parts.reduce((s, p) => s + p.bytes, 0), ollama };
}

// 128774318 → «129 МБ», 3389983260 → «3,4 ГБ»
function formatBytes(n) {
  if (!n) return 'размер неизвестен';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace('.', ',')} ГБ`;
  return `${Math.max(1, Math.round(n / 1e6))} МБ`;
}

// --- Установка по этапам ---

const STAGES = {
  voice: 'Устанавливаю голосовой модуль',
  hearing: 'Устанавливаю слух: распознавание речи и голосов',
  router: 'Устанавливаю быстрые команды',
  brain: 'Загружаю большую языковую модель',
};

// report({ stage, title, progress 0..1, done?, error? }); onStageDone(stage, changed) — подключать модули по мере готовности
// stages — какие этапы ставить (по умолчанию — первый запуск: без большой модели)
async function install({ config, modelsDir, stages = FIRST_RUN, report = () => {}, onStageDone = async () => {} }) {
  const todo = missing(config, modelsDir, stages);
  for (const stage of stages) {
    const items = todo.filter((i) => i.stage === stage);
    try {
      for (const [k, item] of items.entries()) {
        const title = items.length > 1 ? `${STAGES[stage]} (${k + 1} из ${items.length})` : STAGES[stage];
        report({ stage, title, progress: 0 });
        let last = 0;
        await installItem(item, modelsDir, (p) => {
          if (p - last >= 0.005) report({ stage, title, progress: (last = p) });
        });
      }
    } catch (err) {
      if (stage !== 'brain' && stage !== 'router') throw err; // без моделей ассистент работает, без голоса и слуха — нет
      report({ stage, title: `Модель не загрузилась: ${err.message}. Перезапустите меня — докачаю.`, error: true });
      if (stage === 'brain') return;
      continue; // быстрые команды не скачались — остальное ставим дальше
    }
    if (stage === 'brain' && useOllama(config)) break; // модель в Ollama качается ниже
    if (items.length) report({ stage, title: STAGES[stage], progress: 1, done: true });
    await onStageDone(stage, items.length > 0);
  }
  if (!useOllama(config) || !stages.includes('brain')) return;

  // Языковая модель в Ollama
  try {
    if (!(await ollamaHasModel(config))) {
      report({ stage: 'brain', title: `${STAGES.brain} ${config.model}`, progress: 0 });
      let last = 0;
      await ollamaPull(config, (p) => {
        if (p - last >= 0.005) report({ stage: 'brain', title: `${STAGES.brain} ${config.model}`, progress: (last = p) });
      });
      report({ stage: 'brain', title: STAGES.brain, progress: 1, done: true });
      await onStageDone('brain', true);
    } else {
      await onStageDone('brain', false);
    }
  } catch (err) {
    const noOllama = /ECONNREFUSED|fetch failed|timeout|aborted/i.test(String(err?.cause?.code || err?.message));
    report({
      stage: 'brain',
      title: noOllama
        ? 'Не найден Ollama — установите его с ollama.com или выберите в настройках встроенный движок'
        : `Модель не загрузилась: ${err.message}`,
      error: true,
      needOllama: noOllama,
    });
  }
}

module.exports = {
  install,
  installItem,
  plan,
  missing,
  estimate,
  formatBytes,
  brainReady,
  remoteConfigured,
  ollamaHasModel,
  STAGES,
  PART_TITLES,
  FIRST_RUN,
  ALL_STAGES,
};
