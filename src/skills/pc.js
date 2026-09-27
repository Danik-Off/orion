// Состояние компьютера: процессор, память, диски, батарея, время работы и кто больше всех нагружает;
// сколько мусора; фоновое слежение — само предупредит, если кончается место, память или заряд.
// Скрипт PowerShell постоянный — в него ничего не подставляется.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { powershell, launch } = require('../lib/windows');
const { plural } = require('../lib/ru');

const GB = 1024 ** 3;

// Части скрипта собираются под вопрос: про диск не нужно мерить процессы.
// Нагрузка процессов — разница счётчиков Get-Process за SAMPLE_MS, а не Win32_PerfFormattedData_PerfProc_Process:
// тот запрос шёл 5,9 секунды и сам грузил процессор.
const SAMPLE_MS = 800;
const PARTS = {
  disks: "$r.disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue | Select-Object DeviceID, Size, FreeSpace); ",
  battery: '$r.battery = @(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object EstimatedChargeRemaining, BatteryStatus); ',
  topMem:
    '$r.topMem = @(Get-Process | Group-Object ProcessName | ForEach-Object { [pscustomobject]@{ name = $_.Name; ' +
    'description = ($_.Group | Where-Object Description | Select-Object -First 1).Description; ' +
    'mem = ($_.Group | Measure-Object WorkingSet64 -Sum).Sum } } | Sort-Object mem -Descending | Select-Object -First 3); ',
  // cpu — проценты одного ядра (как у счётчиков Windows), на число ядер делит collect()
  topCpu:
    '$t0 = @{}; Get-Process | Where-Object { $_.Id -and $_.CPU } | ForEach-Object { $t0[$_.Id] = $_.CPU }; $w = [Diagnostics.Stopwatch]::StartNew(); ' +
    `Start-Sleep -Milliseconds ${SAMPLE_MS}; $s = $w.Elapsed.TotalSeconds; ` +
    '$r.topCpu = @(Get-Process | Where-Object { $_.CPU -and $t0.ContainsKey($_.Id) } | ' +
    'ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; cpu = $_.CPU - $t0[$_.Id] } } | ' +
    'Group-Object name | ForEach-Object { [pscustomobject]@{ name = $_.Name; cpu = 100 * ($_.Group | Measure-Object cpu -Sum).Sum / $s } } | ' +
    'Sort-Object cpu -Descending | Select-Object -First 3); ',
};
const NEEDS = {
  all: ['disks', 'battery', 'topMem', 'topCpu'],
  processes: ['topMem', 'topCpu'],
  memory: ['topMem'],
  disk: ['disks'],
  battery: ['battery'],
  cpu: ['topCpu'],
};
const scriptFor = (focus) => `$r = @{}; ${(NEEDS[focus] || NEEDS.all).map((p) => PARTS[p]).join('')}$r | ConvertTo-Json -Compress -Depth 3`;

// Загрузка процессора за секунду: разница счётчиков os.cpus()
async function cpuLoad(ms = 1000) {
  const snap = () => os.cpus().map((c) => c.times).reduce(
    (a, t) => ({ idle: a.idle + t.idle, total: a.total + t.user + t.nice + t.sys + t.idle + t.irq }),
    { idle: 0, total: 0 },
  );
  const a = snap();
  await new Promise((r) => setTimeout(r, ms));
  const b = snap();
  const total = b.total - a.total;
  return total > 0 ? Math.round(100 * (1 - (b.idle - a.idle) / total)) : 0;
}

async function collect(focus = 'all') {
  const [cpu, extra] = await Promise.all([
    ['all', 'cpu', 'processes'].includes(focus) ? cpuLoad(SAMPLE_MS) : 0,
    powershell(scriptFor(focus), { timeout: 20000 }).then((out) => JSON.parse(out.trim() || '{}')).catch(() => ({})),
  ]);
  const cores = os.cpus().length;
  const list = (x) => [].concat(x || []).filter(Boolean);
  return {
    cpu,
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    uptime: os.uptime(),
    disks: list(extra.disks).map((d) => ({ drive: String(d.DeviceID || '').replace(':', ''), size: d.Size, free: d.FreeSpace })).filter((d) => d.size > 0),
    battery: list(extra.battery).map((b) => ({ charge: b.EstimatedChargeRemaining, charging: b.BatteryStatus === 2 }))[0] || null,
    topMem: list(extra.topMem).map((p) => ({ name: p.description || p.name, mem: p.mem })),
    topCpu: list(extra.topCpu).map((p) => ({ name: p.name, cpu: Math.round(p.cpu / cores) })).filter((p) => p.cpu >= 5),
  };
}

const pct = (n) => `${n} ${plural(n, 'процент', 'процента', 'процентов')}`;
// gb(bytes) — «16 гигабайт»; gb(bytes, true) — после «из»: «из 31 гигабайта», «из 16 гигабайт»
const gb = (bytes, genitive = false) => {
  const n = bytes >= 10 * GB ? Math.round(bytes / GB) : Math.round((bytes / GB) * 10) / 10;
  if (!Number.isInteger(n)) return `${String(n).replace('.', ',')} гигабайта`;
  return `${n} ${genitive ? plural(n, 'гигабайта', 'гигабайт', 'гигабайт') : plural(n, 'гигабайт', 'гигабайта', 'гигабайт')}`;
};
const days = (n) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;

// Что искать: '' — общий обзор
function focusOf(arg) {
  const t = String(arg).toLowerCase();
  if (/процесс(?!ор)|грузит|тормоз|top/.test(t)) return 'processes';
  if (/проц|cpu/.test(t)) return 'cpu';
  if (/памят|озу|оператив|ram|mem/.test(t)) return 'memory';
  if (/диск|мест|disk/.test(t)) return 'disk';
  if (/батар|заряд|аккум|battery/.test(t)) return 'battery';
  return 'all';
}

// Готовая фраза из собранных цифр (отдельно от сбора — чтобы проверять тестами)
function report(s, focus = 'all') {
  const memUsed = s.memTotal - s.memFree;
  const memPct = Math.round((100 * memUsed) / s.memTotal);
  const upDays = Math.floor(s.uptime / 86400);
  const lowDisks = s.disks.filter((d) => d.free / d.size < 0.1 || d.free < 10 * GB);
  const hogCpu = s.topCpu[0];
  const hogMem = s.topMem[0];

  const cpuLine = `Процессор загружен на ${pct(s.cpu)}${s.cpu >= 50 && hogCpu ? `, больше всех его нагружает ${hogCpu.name}` : ''}.`;
  const memLine = `Память занята на ${pct(memPct)}: ${gb(memUsed)} из ${gb(s.memTotal, true)}${memPct >= 70 && hogMem ? `, больше всего ест ${hogMem.name}` : ''}.`;
  const diskLine = s.disks.length
    ? s.disks.map((d) => `на диске ${d.drive} свободно ${gb(d.free)} из ${gb(d.size, true)}`).join(', ').replace(/^./, (c) => c.toUpperCase()) + '.'
    : 'Не удалось узнать место на дисках.';
  const batteryLine = s.battery
    ? `Заряд батареи ${pct(s.battery.charge)}${s.battery.charging ? ', идёт зарядка' : ''}.`
    : 'Батареи нет — компьютер работает от сети.';

  if (focus === 'cpu') return cpuLine;
  if (focus === 'memory') return memLine;
  if (focus === 'disk') return diskLine;
  if (focus === 'battery') return batteryLine;
  if (focus === 'processes') {
    const cpu = s.topCpu.length ? `Процессор нагружают: ${s.topCpu.map((p) => `${p.name} — ${pct(p.cpu)}`).join(', ')}.` : 'Процессор сейчас почти никто не нагружает.';
    const mem = s.topMem.length ? ` Больше всего памяти у: ${s.topMem.map((p) => `${p.name} — ${gb(p.mem)}`).join(', ')}.` : '';
    return cpu + mem;
  }

  const issues = [];
  if (s.cpu >= 85) issues.push('процессор перегружен');
  if (memPct >= 85) issues.push('почти не осталось оперативной памяти');
  if (lowDisks.length) issues.push(`мало места на ${lowDisks.length > 1 ? 'дисках' : 'диске'} ${lowDisks.map((d) => d.drive).join(', ')}`);
  if (s.battery && !s.battery.charging && s.battery.charge <= 20) issues.push('батарея почти разряжена');
  if (upDays >= 7) issues.push(`компьютер не перезагружался ${days(upDays)}, стоит перезагрузить`);

  const lines = [cpuLine, memLine, diskLine];
  if (s.battery) lines.push(batteryLine);
  if (upDays >= 1) lines.push(`Работает без перезагрузки ${days(upDays)}.`);
  lines.push(issues.length ? `Обратите внимание: ${issues.join('; ')}.` : 'В целом всё в порядке, сэр.');
  return lines.join(' ');
}

// «как там компьютер», «состояние пк», «что грузит процессор» — без модели
const PC = '(?:компьютер[а-я]*|комп[а-я]*|пк|систем[а-я]*)';
const QUICK = [
  [new RegExp(`(?:что|кто) (?:[а-я]+ )?(?:грузит|нагружает|тормозит)|почему (?:[а-я]+ )?${PC} (?:[а-я]+ )?тормоз|${PC} тормоз`), 'процессы'],
  [/(?:загрузк|нагрузк)[а-я]* (?:на )?процессор|процессор (?:загружен|нагружен)/, 'процессор'],
  [/сколько (?:свободно[а-я]* )?(?:оперативн|памят)/, 'память'],
  [/(?:сколько|много ли) (?:свободного )?места|свободно на диске|место на диске/, 'диск'],
  // «состояние пока» — так распознаватель слышит «состояние ПК»
  [new RegExp(`состояни[а-я]* (?:${PC}|пока)(?: [а-я]+)?$`), ''],
  [new RegExp(`состояни[а-я]* ${PC}|(?:проверь|оцени|диагностик[а-я]*) ${PC}|как (?:там |себя чувствует |поживает |дела у |с )?(?:мой |моим |наш )?${PC}$`), ''],
];

// «сколько места занимают загрузки», «…файлы на рабочем столе» — это папка (навык files), не весь диск
const FOLDER_WORDS = /загрузк|скачан|документ|рабоч[а-я]* стол|папк|фото|видео|музык|скриншот|изображен/;

function quick(text) {
  const t = text.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z ]+/g, '').replace(/\s+/g, ' ').trim();
  const hit = QUICK.find(([re, arg]) => re.test(t) && !(arg === 'диск' && FOLDER_WORDS.test(t)));
  return hit ? { addressed: true, say: 'Проверяю.', actions: [{ tool: 'pc_status', arg: hit[1] }] } : null;
}

// --- мусор: временные файлы и корзина ---

function dirSize(dir, budget = { left: 200_000 }) {
  let size = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (--budget.left < 0) break;
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) size += dirSize(full, budget);
      else if (e.isFile()) size += fs.statSync(full).size;
    } catch {}
  }
  return size;
}

async function junk() {
  const temp = dirSize(os.tmpdir());
  const bin = Number(
    (await powershell('((New-Object -ComObject Shell.Application).Namespace(10).Items() | Measure-Object -Property Size -Sum).Sum').catch(() => '0')).trim(),
  ) || 0;
  const total = temp + bin;
  const verdict = total > 5 * GB ? ' Стоит почистить — скажите «запусти очистку диска».' : ' Мусора немного.';
  return `Временные файлы занимают ${gb(temp)}, корзина — ${gb(bin)}.${verdict}`;
}

// --- фоновое слежение: предупреждает сам, не чаще раза в 6 часов по каждой причине ---

const MONITOR_MS = 5 * 60_000;
const REPEAT_MS = 6 * 3_600_000;
const MONITOR_SCRIPT =
  "$d = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID, Size, FreeSpace); " +
  '$b = @(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object EstimatedChargeRemaining, BatteryStatus); ' +
  '@{ disks = $d; battery = $b } | ConvertTo-Json -Compress -Depth 3';
const warned = new Map();
let monitor = null;

// Что сейчас стоит сказать без спроса (отдельно от сбора — чтобы проверять тестами)
function warnings(s) {
  const out = [];
  for (const d of s.disks) {
    if (d.free / d.size < 0.05 || d.free < 3 * GB) out.push([`disk-${d.drive}`, `На диске ${d.drive} почти не осталось места: ${gb(d.free)}.`]);
  }
  if (s.battery && !s.battery.charging && s.battery.charge <= 15) out.push(['battery', `Батарея садится: ${pct(s.battery.charge)}. Подключите зарядку.`]);
  const memPct = Math.round((100 * (s.memTotal - s.memFree)) / s.memTotal);
  if (memPct >= 93) out.push(['memory', `Оперативная память почти закончилась: занято ${pct(memPct)}. Закройте что-нибудь лишнее.`]);
  return out;
}

async function checkInBackground(ctx) {
  const extra = await powershell(MONITOR_SCRIPT).then((o) => JSON.parse(o.trim() || '{}')).catch(() => null);
  if (!extra) return;
  const list = (x) => [].concat(x || []).filter(Boolean);
  const s = {
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    disks: list(extra.disks).map((d) => ({ drive: String(d.DeviceID || '').replace(':', ''), size: d.Size, free: d.FreeSpace })).filter((d) => d.size > 0),
    battery: list(extra.battery).map((b) => ({ charge: b.EstimatedChargeRemaining, charging: b.BatteryStatus === 2 }))[0] || null,
  };
  for (const [key, text] of warnings(s)) {
    if (Date.now() - (warned.get(key) || 0) < REPEAT_MS) continue;
    warned.set(key, Date.now());
    ctx.audit({ pcWarning: key });
    ctx.remind(text);
  }
}

module.exports = {
  id: 'pc',
  platforms: ['win32'], // PowerShell и программы Windows
  title: 'состояние компьютера: процессор, память, диски, батарея, что тормозит, мусор и очистка диска',
  keywords: ['процессор', 'памят', 'оператив', 'диск', 'батар', 'заряд', 'тормоз', 'грузит', 'нагрузк', 'состояни', 'компьютер', 'комп', 'пк', 'мусор', 'очист', 'временные файлы', 'корзин'],
  quick,
  rules: ['Вопросы о состоянии, нагрузке, памяти, дисках, батарее или «почему тормозит компьютер» — pc_status.'],
  tools: [
    {
      name: 'pc_status',
      speaks: true, // ответ всегда даёт сам инструмент
      use: 'оценить состояние компьютера: нагрузка процессора, память, место на дисках, батарея, что тормозит, сколько мусора',
      arg: 'пусто — общий обзор; «процессы» — что тормозит и грузит; остальное — одна часть',
      argEnum: ['', 'процессор', 'память', 'диск', 'батарея', 'процессы', 'мусор'],
      filler: 'Проверяю.', // замер нагрузки занимает около секунды
      // «почему тормозит» — это про процессы, даже если модель выбрала общий обзор
      normalize: (arg, text) => (/тормоз|грузит|виснет|лага|медленн/i.test(text) ? 'процессы' : /мусор|почист/i.test(text) ? 'мусор' : arg),
      examples: [
        ['как себя чувствует компьютер', { addressed: true, say: 'Проверяю.', actions: [{ tool: 'pc_status', arg: '' }] }],
        ['почему комп тормозит', { addressed: true, say: 'Сейчас гляну.', actions: [{ tool: 'pc_status', arg: 'процессы' }] }],
      ],
      run: async (arg) => ({ ok: true, speak: /мусор|junk|временн|корзин/i.test(arg) ? await junk() : report(await collect(focusOf(arg)), focusOf(arg)) }),
    },
    {
      name: 'disk_cleanup',
      use: 'открыть стандартную «Очистку диска» Windows',
      arg: 'пусто',
      argEnum: [''],
      run: async () => (await launch('cleanmgr.exe'), { ok: true }),
    },
  ],
  init(ctx) {
    clearInterval(monitor);
    if (!ctx.dataDir || ctx.config.pc?.monitor === false) return; // в тестах и по желанию — без слежения
    monitor = setInterval(() => checkInBackground(ctx), MONITOR_MS);
    monitor.unref?.();
  },
  report,
  focusOf,
  warnings,
};
