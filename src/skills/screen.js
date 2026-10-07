// Экран: снимок всего экрана в «Изображения\Screenshots» и яркость (встроенный дисплей ноутбука, через WMI).
const { powershell } = require('../lib/windows');
const { wordsToNumber, plural } = require('../lib/ru');

// Путь строит сам скрипт, имя файла (только цифры и дефисы) передаётся через переменную окружения
const SHOT =
  'Add-Type -AssemblyName System.Windows.Forms, System.Drawing; Add-Type -Namespace O -Name D -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();\'; ' +
  '[void][O.D]::SetProcessDPIAware(); $b = [System.Windows.Forms.SystemInformation]::VirtualScreen; ' +
  '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); ' +
  '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); ' +
  "$dir = Join-Path ([Environment]::GetFolderPath('MyPictures')) 'Screenshots'; New-Item -ItemType Directory -Force $dir | Out-Null; " +
  '$file = Join-Path $dir $env:ORION_SHOT; $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose(); $file';

async function screenshot(arg, ctx) {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const file = (await powershell(SHOT, { env: { ORION_SHOT: `Орион-${stamp}.png` } })).trim();
  ctx.audit({ screenshot: file });
  if (/show|покаж|открой/i.test(arg)) ctx.showItemInFolder?.(file);
  return { ok: true, speak: 'Снимок экрана сохранён в папку «Изображения», «Screenshots».' };
}

const GET_BRIGHTNESS =
  '(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1).CurrentBrightness';
const setBrightness = (n) =>
  powershell(
    'Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | ' +
      `Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = [byte]${n} } | Out-Null`,
  );

// arg: "70", "+10", "-20", "?"
async function brightness(arg) {
  let current;
  try {
    current = Number((await powershell(GET_BRIGHTNESS)).trim());
  } catch {
    return { ok: false, message: 'Яркость этого монитора из Windows не меняется — только кнопками на самом мониторе, сэр.' };
  }
  const a = String(arg).trim();
  const pct = (n) => `${n} ${plural(n, 'процент', 'процента', 'процентов')}`;
  if (!a || a === '?') return { ok: true, speak: `Яркость ${pct(current)}.` };
  const n = wordsToNumber(a);
  if (n === null) return { ok: false, message: 'Не понял, какую яркость поставить, сэр.' };
  const target = Math.max(0, Math.min(100, a.startsWith('+') ? current + n : a.startsWith('-') ? current - n : n));
  await setBrightness(target);
  return { ok: true, speak: `Яркость ${pct(target)}.` };
}

module.exports = {
  id: 'screen',
  needs: [],
  platforms: ['win32'], // PowerShell и программы Windows
  title: 'снимок экрана (скриншот), яркость экрана',
  keywords: ['скрин', 'снимок экрана', 'сфоткай экран', 'яркост', 'ярче', 'темнее', 'экран'],
  tools: [
    {
      name: 'screenshot',
      use: 'сделать снимок экрана',
      arg: 'пусто; "show" — ещё и показать файл',
      argEnum: ['', 'show'],
      examples: [['сделай скриншот', { addressed: true, say: '', actions: [{ tool: 'screenshot', arg: '' }] }]],
      run: screenshot,
    },
    {
      name: 'brightness',
      use: 'яркость экрана: поставить, изменить, узнать',
      arg: '"70" — поставить; "+10" / "-20" — изменить; "?" — узнать',
      run: brightness,
    },
  ],
};
