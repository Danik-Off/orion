// Всё, что касается Windows: запуск программ, окна процессов, медиа-клавиши.
// Правило: в PowerShell-скрипты подставляются только числа, проверенные кодом, — никогда текст от модели.
const { spawn } = require('node:child_process');

// Запуск без shell: аргументы никогда не интерпретируются командной строкой.
function launch(file, args = []) {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { shell: false, detached: true, stdio: 'ignore' });
    p.once('error', reject);
    p.once('spawn', () => {
      p.unref();
      resolve();
    });
  });
}

// env — способ передать в скрипт текст (из фразы, буфера): переменные окружения не исполняются как код
function powershell(script, { timeout = 15000, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
      { shell: false, windowsHide: true, env: env ? { ...process.env, ...env } : process.env },
    );
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    p.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill(), timeout);
    p.once('error', reject);
    p.once('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `powershell: код ${code}`));
    });
  });
}

const asJsonList = (out) => {
  const text = out.trim();
  return text ? [].concat(JSON.parse(text)) : [];
};

// --- Медиа-клавиши (работают с Яндекс Музыкой, браузером и почти любым плеером) ---

const MEDIA_KEYS = {
  play_pause: [0xb3, 1],
  next: [0xb0, 1],
  prev: [0xb1, 1],
  volume_up: [0xaf, 5],
  volume_down: [0xae, 5],
  mute: [0xad, 1],
};

const USER32 =
  "Add-Type -Namespace O -Name U -MemberDefinition '" +
  '[DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, System.UIntPtr e);' +
  '[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr l);' +
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);' +
  '[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);' +
  '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);' +
  "public delegate bool EnumProc(System.IntPtr h, System.IntPtr l);';";

function pressMediaKey(name) {
  const [vk, times] = MEDIA_KEYS[name];
  return powershell(
    `${USER32} for ($i = 0; $i -lt ${times}; $i++) { [O.U]::keybd_event(${vk}, 0, 1, [UIntPtr]::Zero); [O.U]::keybd_event(${vk}, 0, 3, [UIntPtr]::Zero) }`,
  );
}

// --- Окна и процессы ---

// Системные процессы и сам ассистент никогда не закрываются.
const PROTECTED = new Set([
  'explorer',
  'dwm',
  'winlogon',
  'csrss',
  'lsass',
  'services',
  'smss',
  'wininit',
  'svchost',
  'system',
  'sihost',
  'shellexperiencehost',
  'startmenuexperiencehost',
  'searchhost',
  'textinputhost',
  'ctfmon',
  'applicationframehost',
  'lockapp',
  'electron',
]);

// Программы с видимыми окнами: [{ id, name, title, description }]
async function listWindowedApps() {
  const out = await powershell(
    'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ' +
      'Select-Object Id, @{n="name";e={$_.ProcessName}}, @{n="title";e={$_.MainWindowTitle}}, @{n="description";e={$_.Description}} | ' +
      'ConvertTo-Json -Compress',
  );
  return asJsonList(out)
    .map((p) => ({ id: p.Id, name: p.name || '', title: p.title || '', description: p.description || '' }))
    .filter((p) => !PROTECTED.has(p.name.toLowerCase()) && p.id !== process.pid && p.id !== process.ppid);
}

// Закрыть ВСЕ окна программы так же, как крестиком (WM_CLOSE): несохранённое она спросит сама.
async function closeProcessWindows(processName) {
  const name = String(processName).toLowerCase();
  // Буквы любого алфавита («Яндекс Музыка»), цифры, пробел, _ . - — и никаких кавычек: имя попадает в скрипт
  if (!/^[\p{L}\p{N}_.\- ]+$/u.test(name) || PROTECTED.has(name)) throw new Error('Эту программу закрывать нельзя');
  const pids = (await powershell(`Get-Process | Where-Object { $_.ProcessName -eq '${name}' } | ForEach-Object { $_.Id }`))
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  if (!pids.length) return 0;
  const out = await powershell(
    `${USER32} $ids = @(${pids.join(',')}); $n = 0; ` +
      '[O.U]::EnumWindows({ param($h, $l) $p = 0; [void][O.U]::GetWindowThreadProcessId($h, [ref]$p); ' +
      'if ($ids -contains $p -and [O.U]::IsWindowVisible($h)) { [void][O.U]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); $script:n++ }; $true }, [IntPtr]::Zero) | Out-Null; $n',
  );
  return Number(out.trim()) || 0;
}

function minimizeAll() {
  return powershell('(New-Object -ComObject Shell.Application).MinimizeAll()');
}

// Браузер по умолчанию → имя процесса
const BROWSERS = {
  chrome: 'chrome',
  msedge: 'msedge',
  firefox: 'firefox',
  yandex: 'browser',
  opera: 'opera',
  brave: 'brave',
  vivaldi: 'vivaldi',
};
async function defaultBrowserProcess() {
  const progId = (
    await powershell(
      '(Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice" -ErrorAction SilentlyContinue).ProgId',
    ).catch(() => '')
  ).toLowerCase();
  if (progId.includes('chrome')) return BROWSERS.chrome;
  if (progId.includes('msedge')) return BROWSERS.msedge;
  if (progId.includes('firefox')) return BROWSERS.firefox;
  if (progId.includes('yandex')) return BROWSERS.yandex;
  if (progId.includes('opera')) return BROWSERS.opera;
  if (progId.includes('brave')) return BROWSERS.brave;
  if (progId.includes('vivaldi')) return BROWSERS.vivaldi;
  return null;
}

module.exports = {
  launch,
  powershell,
  asJsonList,
  MEDIA_KEYS,
  pressMediaKey,
  listWindowedApps,
  closeProcessWindows,
  minimizeAll,
  defaultBrowserProcess,
  BROWSERS,
};

// Вставить буфер обмена в активное окно (Ctrl+V) — для диктовки текста
function pasteClipboard() {
  return powershell(
    `${USER32} [O.U]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero); [O.U]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero); ` +
      '[O.U]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero); [O.U]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)',
  );
}
module.exports.pasteClipboard = pasteClipboard;
