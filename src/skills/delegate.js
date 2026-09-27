// Передача сложных задач агенту для программистов — Claude Code или Codex, если он установлен:
// «напиши скрипт…», «оптимизируй код проекта…», «найди ошибку в…». Агент работает в фоне в своей папке,
// Орион сразу отвечает «передал», а когда агент закончит — говорит итог напоминанием.
// Согласие: при запуске Орион один раз предлагает включить передачу (offer); ответ хранится как
// skills.delegate.enabled. Пока не ответили — спросит и при первой такой задаче.
// Безопасность: текст задачи идёт агенту через stdin, а не в командную строку; Claude Code может править
// файлы только в папке задачи (acceptEdits, без запуска команд), Codex — в песочнице своей папки (--full-auto).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { plural } = require('../lib/ru');
const { userFolders } = require('./files');

// args — постоянные: ни одного слова от пользователя или модели в командной строке нет
const AGENTS = {
  claude: { title: 'Claude Code', args: ['-p', '--permission-mode', 'acceptEdits', '--output-format', 'text'] },
  codex: { title: 'Codex', args: ['exec', '--full-auto', '--skip-git-repo-check', '-'] },
};
const MAX_OUTPUT = 200_000;
// «Создай сайт-визитку», «сделай мне телеграм-бота», «напиши парсер» — просьба что-то разработать.
// «Сет» — так распознаватель слышит «сайт»; объект — сразу после глагола или через одно слово («сделай мне …»)
const CREATE = /(?:^|\s)(?:созда|сдела|напиш|разработа|сверста|запили)\S*\s+(?:\S+\s+)?(?:сайт|сет\s|лендинг|визитк|приложени|игр[уы]|бот|телеграм-?бот|скрипт|программ|парсер|утилит|расширени|плагин|функци|конвертер|генератор|виджет)/;

const normalize = (s) => String(s).toLowerCase().replace(/ё/g, 'е');
const minutes = (n) => `${n} ${plural(n, 'минуту', 'минуты', 'минут')}`;
const pad = (n) => String(n).padStart(2, '0');

// --- где агент ---

// Кроме PATH — места, куда агенты ставятся сами: у приложения из «Пуска» или Finder PATH бывает короче
const extraDirs = () =>
  [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.claude', 'local'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ].filter(Boolean);

function which(name, env = process.env, platform = process.platform) {
  const exts = platform === 'win32' ? ['.exe', '.cmd'] : [''];
  const dirs = [...String(env.PATH || env.Path || '').split(path.delimiter), ...extraDirs()].filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {}
    }
  }
  return null;
}

// config.delegate.agent — «claude» или «codex»; пусто — первый найденный
let found = null;
let testAgent = null;
function findAgent(config) {
  if (testAgent) return testAgent;
  const want = config.delegate?.agent || '';
  if (found?.want === want) return found.agent;
  const order = AGENTS[want] ? [want] : Object.keys(AGENTS);
  let agent = null;
  for (const id of order) {
    const file = which(id);
    if (file) {
      agent = { id, ...AGENTS[id], file };
      break;
    }
  }
  found = { want, agent };
  return agent;
}

// --- папка и текст задачи ---

// Проект по названию во фразе: config.delegate.projects = { "орион": "C:\\code\\orion" }; длинные названия — первыми
function findProject(projects, text) {
  const t = normalize(text);
  const hit = Object.entries(projects || {})
    .sort(([a], [b]) => b.length - a.length)
    .find(([name]) => name.trim() && t.includes(normalize(name).trim()));
  return hit ? { name: hit[0], dir: hit[1] } : null;
}

function folderName(task, now = new Date()) {
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const words = String(task).replace(/[^\p{L}\p{N} ]+/gu, ' ').trim().split(/\s+/).slice(0, 5).join(' ').slice(0, 40).trim();
  return words ? `${stamp} ${words}` : stamp;
}

// Промпт агенту — одной строкой «Ты …»: он не озвучивается (scripts/stress-phrases.js такие пропускает)
function taskPrompt({ task, text, project, clipboardFile }) {
  const said = text && normalize(text) !== normalize(task) ? text : '';
  return `Ты получил задачу от голосового ассистента «Орион»: пользователь сказал её голосом, распознавание речи могло ошибиться в отдельных словах.
Задача: ${task}${said ? '\nДословно: «' + said + '»' : ''}
${project ? 'Работай в текущей папке — это проект «' + project + '».' : 'Работай в текущей папке: она создана для этой задачи, результат (код, файлы) сохрани в неё.'}${clipboardFile ? '\nТекст, о котором говорит пользователь (из буфера обмена), — в файле ' + clipboardFile + '.' : ''}
Уточнений не спрашивай — отвечать некому: выбери разумный вариант сам и доведи дело до конца.
Последним сообщением ответь по-русски одним-двумя короткими предложениями без markdown и кода: что сделано и где результат. Его прочитают вслух.`;
}

// Итог для озвучки — последний абзац ответа агента без кода и разметки
function summaryOf(output, max = 300) {
  const paras = String(output)
    .replace(/\x60{3}[\s\S]*?\x60{3}/g, ' ') // блоки кода; \x60 — обратная кавычка (сбивала бы разбор строк в stress-phrases)
    .split(/\n\s*\n/)
    .map((s) => s.replace(/[*_#\x60>|]+/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const last = paras.at(-1) || '';
  if (last.length <= max) return last;
  const cut = last.slice(0, max);
  const end = cut.lastIndexOf('. ');
  return end > max / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

// --- фоновая задача: одна за раз ---

let job = null; // { agent, task, dir, started, proc, status: running|done|failed|timeout|cancelled, summary }

// Обёртка npm (.cmd) запускается только через cmd.exe — у неё и дочерние процессы, поэтому гасим деревом
function kill(proc) {
  if (process.platform === 'win32' && proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
  else proc.kill();
}

function saveLog(ctx, j, out, err) {
  if (!ctx.dataDir) return;
  try {
    const dir = path.join(ctx.dataDir, 'delegate');
    fs.mkdirSync(dir, { recursive: true });
    const body = `# ${j.task}\n\nАгент: ${j.agent.title}\nПапка: ${j.dir}\nИтог: ${j.status}\n\n${out}\n${err ? `\n---\n${err}\n` : ''}`;
    fs.writeFileSync(path.join(dir, `${folderName('', new Date(j.started))}.md`), body);
  } catch {}
}

function start(ctx, agent, { task, dir, prompt }) {
  // Текст задачи — только через stdin: так его не разберёт командная строка даже при запуске через cmd.exe
  const shell = /\.(cmd|bat)$/i.test(agent.file);
  const proc = spawn(shell ? `"${agent.file}"` : agent.file, agent.args, { cwd: dir, shell, windowsHide: true });
  const j = { agent, task, dir, started: Date.now(), proc, status: 'running', summary: '' };
  job = j;
  let out = '';
  let err = '';
  proc.stdout.setEncoding('utf8').on('data', (d) => (out = (out + d).slice(-MAX_OUTPUT)));
  proc.stderr.setEncoding('utf8').on('data', (d) => (err = (err + d).slice(-4000)));
  proc.stdin.on('error', () => {}); // агент мог выйти, не дочитав
  proc.stdin.end(prompt);
  const limit = Number(ctx.config.delegate?.timeoutMin) || 30;
  const timer = setTimeout(() => {
    j.status = 'timeout';
    kill(proc);
  }, limit * 60_000);

  let finished = false;
  const finish = (code, error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (j.status === 'running') j.status = code === 0 && out.trim() ? 'done' : 'failed';
    j.summary = summaryOf(out);
    j.proc = null;
    saveLog(ctx, j, out, err || error);
    ctx.audit?.({ delegate: j.status, agent: agent.id, code, dir });
    if (j.status === 'done') ctx.remind(`Задача готова. ${j.summary || `${agent.title} закончил работу.`}`);
    else if (j.status === 'timeout') ctx.remind(`${agent.title} не уложился в ${minutes(limit)} — я его остановил.`);
    else if (j.status === 'failed') ctx.remind(`${agent.title} не справился с задачей. Подробности — в журнале.`);
  };
  proc.once('error', (e) => finish(null, String(e?.message || e)));
  proc.once('close', (code) => finish(code));
  return j;
}

// --- инструменты ---

// Согласие: true — включено, false — выключено, null — не ответили (спросим в другой раз)
async function askConsent(ctx, agent, question) {
  const yes = await ctx.confirm(question);
  if (yes === null || yes === undefined) return null;
  try {
    ctx.saveSettings?.({ 'skills.delegate': !!yes }); // в config.json — чтобы не спрашивать снова
  } catch (err) {
    ctx.audit?.({ delegate: 'не сохранилось', error: String(err?.message || err) });
  }
  (ctx.config.skills ||= {}).delegate = { ...ctx.config.skills.delegate, enabled: !!yes };
  ctx.audit?.({ delegate: yes ? 'включено' : 'выключено', agent: agent.id });
  return !!yes;
}

async function delegate(arg, ctx, request = {}) {
  const text = String(request.text || '').trim();
  const task = String(arg).trim() || text;
  if (!task) return { ok: false, message: 'Что передать агенту, сэр?' };
  const agent = findAgent(ctx.config);
  if (!agent) return { ok: false, message: 'Не нашёл на компьютере ни Claude Code, ни Codex, сэр.' };
  const enabled = ctx.config.skills?.delegate?.enabled;
  if (enabled === false) return { ok: false, message: 'Передача задач агенту выключена — включить можно в настройках, сэр.' };
  if (enabled !== true) {
    const yes = await askConsent(ctx, agent, `Передать задачу ${agent.title}? Дальше такие задачи буду отдавать ему сам.`);
    if (!yes) return { ok: false, message: yes === false ? 'Хорошо, не передаю. Включить можно в настройках, сэр.' : 'Не передаю, сэр.' };
  }
  if (job?.status === 'running') {
    return { ok: false, message: `${agent.title} ещё занят прошлой задачей. Скажите «как там задача» или «отмени задачу», сэр.` };
  }

  const project = findProject(ctx.config.delegate?.projects, text || task);
  let dir;
  if (project) {
    dir = path.resolve(project.dir);
    if (!fs.existsSync(dir)) return { ok: false, message: `Папки проекта «${project.name}» нет на месте, сэр.` };
  } else {
    const base = ctx.config.delegate?.workDir || path.join((await userFolders()).documents, 'Задачи агента');
    dir = path.join(base, folderName(task));
    fs.mkdirSync(dir, { recursive: true });
  }
  // «…код, который я скопировал» — буфер обмена кладём агенту файлом рядом с задачей
  let clipboardFile = null;
  const clip = /буфер|скопир/i.test(text) ? (ctx.clipboard?.readText() || '').trim() : '';
  if (clip && !project) {
    clipboardFile = 'буфер.txt';
    fs.writeFileSync(path.join(dir, clipboardFile), clip);
  }
  start(ctx, agent, { task, dir, prompt: taskPrompt({ task, text, project: project?.name, clipboardFile }) });
  ctx.audit?.({ delegate: 'передано', agent: agent.id, task, dir });
  return { ok: true, speak: `Передал задачу ${agent.title}. Скажу, когда будет готово.` };
}

async function control(arg, ctx) {
  const a = String(arg).trim().toLowerCase();
  if (!job) return { ok: false, message: 'Агенту я пока ничего не передавал, сэр.' };
  const { agent } = job;
  if (a === 'cancel') {
    if (job.status !== 'running') return { ok: false, message: 'Задача уже закончена, сэр.' };
    job.status = 'cancelled';
    kill(job.proc);
    return { ok: true, speak: `Остановил ${agent.title}.` };
  }
  if (a === 'open') {
    await ctx.openPath(job.dir);
    return { ok: true, speak: 'Открываю папку задачи.' };
  }
  const passed = Math.max(1, Math.round((Date.now() - job.started) / 60_000));
  if (job.status === 'running') return { ok: true, speak: `${agent.title} работает над задачей уже ${minutes(passed)}.` };
  if (job.status === 'done') return { ok: true, speak: `Задача готова. ${job.summary}`.trim() };
  if (job.status === 'cancelled') return { ok: true, speak: 'Задачу вы отменили.' };
  return { ok: true, speak: `${agent.title} не справился с прошлой задачей. Подробности — в журнале.` };
}

// «Как там задача?», «отмени задачу», «открой результат» — без модели, но только когда задача была
function quick(text) {
  if (!job) return null;
  const t = normalize(text).replace(/[^а-яa-z ]+/g, '').replace(/\s+/g, ' ').trim();
  const act = (arg) => ({ addressed: true, say: '', actions: [{ tool: 'delegate_task', arg }] });
  if (/^(как там|что с|ну что) (задач\S*|агент\S*|клод\S*|кодекс\S*)$|^задача готова$/.test(t)) return act('status');
  if (/^(отмени|останови|прерви) (задачу|агента)$/.test(t)) return act('cancel');
  if (/^(открой|покажи) (результат|папку задачи)$/.test(t)) return act('open');
  return null;
}

module.exports = {
  id: 'delegate',
  title: 'передать сложную задачу агенту для программистов (Claude Code или Codex): создать сайт, программу, бота, написать код или скрипт, оптимизировать, исправить ошибку, разобраться в проекте',
  keywords: [
    'код', 'скрипт', 'оптимиз', 'рефактор', 'отлад', 'дебаг', 'баг', 'claude', 'клод', 'codex', 'кодекс', 'агент', 'делегир',
    'визитк', 'лендинг', 'сверста', 'как там задача', 'отмени задачу', 'открой результат',
    CREATE,
  ],
  available: (config) => !!findAgent(config),
  fallback: true, // модель сказала «не умею» — ядро переспросит её с этим навыком

  rules: [
    'Задача для программиста — создать или написать сайт, программу, бота, игру, скрипт, код; оптимизировать, исправить, отладить, разобраться в проекте — delegate: её в фоне сделает агент на компьютере. Не отвечай «не умею» — передай. Простые вопросы, расчёты, шутки, перевод — не delegate.',
    'Распознавание речи ошибается: «сет визитка» — это сайт-визитка.',
    'arg delegate — задача целиком и подробно словами пользователя: что сделать, на каком языке, для какого проекта; «это», «его» раскрой по разговору.',
    '«Как там задача?», «отмени задачу», «открой результат» — delegate_task.',
  ],
  tools: [
    {
      name: 'delegate',
      use: 'передать сложную задачу (код, скрипт, оптимизация, отладка) агенту — он сделает её в фоне и сообщит итог',
      arg: 'задача целиком и подробно',
      examples: [
        ['создай сайт визитку', { addressed: true, say: '', actions: [{ tool: 'delegate', arg: 'Создать сайт-визитку' }] }],
        ['напиши скрипт на питоне, который переименует фото по дате съёмки', { addressed: true, say: '', actions: [{ tool: 'delegate', arg: 'Написать скрипт на Python, который переименовывает фотографии по дате съёмки' }] }],
        ['оптимизируй код, который я скопировал', { addressed: true, say: '', actions: [{ tool: 'delegate', arg: 'Оптимизировать код из буфера обмена' }] }],
      ],
      speaks: true,
      run: delegate,
    },
    {
      name: 'delegate_task',
      use: 'переданная агенту задача: как идёт, отменить, открыть папку с результатом',
      arg: 'status | cancel | open',
      argEnum: ['status', 'cancel', 'open'],
      examples: [['как там задача', { addressed: true, say: '', actions: [{ tool: 'delegate_task', arg: 'status' }] }]],
      speaks: true,
      run: control,
    },
  ],
  quick,
  init(ctx) {
    const agent = findAgent(ctx.config);
    const projects = Object.keys(ctx.config.delegate?.projects || {});
    const tool = this.tools.find((t) => t.name === 'delegate');
    if (agent) tool.use = tool.use.replace('агенту', `агенту ${agent.title}`);
    if (projects.length) {
      tool.arg = `задача целиком и подробно; проекты по названию: ${projects.join(', ')}`;
      this.keywords = [...this.keywords, (text) => !!findProject(ctx.config.delegate.projects, text)];
    }
  },
  // При запуске: агент есть, а про передачу задач ещё не спрашивали — предложить
  async offer(ctx) {
    if (ctx.config.skills?.delegate?.enabled !== undefined) return;
    const agent = findAgent(ctx.config);
    if (!agent) return;
    await askConsent(ctx, agent, `Нашёл на компьютере ${agent.title}. Передавать ему сложные задачи — написать код, оптимизировать, найти ошибку?`);
  },
  // для тестов
  _test: {
    which,
    findProject,
    folderName,
    taskPrompt,
    summaryOf,
    setAgent: (a) => (testAgent = a),
    job: () => job,
    reset: () => ((job = null), (found = null), (testAgent = null)),
  },
};
