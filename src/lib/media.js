// Системный медиа-API Windows (Global System Media Transport Controls):
// что сейчас играет в любом плеере (браузер, Spotify, медиаплеер) и управление конкретным плеером.
const { spawn } = require('node:child_process');

// PowerShell 5.1 умеет WinRT: ждём асинхронные вызовы через AsTask.
// Имя приложения для фильтра и действие передаются через переменные окружения — не подставляются в скрипт.
const SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$filter = $env:ORION_MEDIA_APP
$action = $env:ORION_MEDIA_ACTION
$out = foreach ($s in $mgr.GetSessions()) {
  if ($filter -and ($s.SourceAppUserModelId -notlike "*$filter*")) { continue }
  switch ($action) {
    'play'  { $null = Await ($s.TryPlayAsync()) ([bool]) }
    'pause' { $null = Await ($s.TryPauseAsync()) ([bool]) }
    'next'  { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
    'prev'  { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
  }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  [pscustomobject]@{ app = $s.SourceAppUserModelId; status = [string]$s.GetPlaybackInfo().PlaybackStatus; title = $p.Title; artist = $p.Artist }
}
@($out) | ConvertTo-Json -Compress
`;

const ACTIONS = new Set(['status', 'play', 'pause', 'next', 'prev']);

function run(action = 'status', app = '') {
  if (!ACTIONS.has(action)) return Promise.reject(new Error(`Неизвестное действие ${action}`));
  if (!/^[\w.! -]*$/.test(app)) return Promise.reject(new Error('Недопустимое имя приложения'));
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
      shell: false,
      windowsHide: true,
      env: { ...process.env, ORION_MEDIA_APP: app, ORION_MEDIA_ACTION: action },
    });
    let out = '';
    p.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    const timer = setTimeout(() => p.kill(), 15000);
    p.once('error', reject);
    p.once('close', () => {
      clearTimeout(timer);
      try {
        const text = out.trim();
        resolve(text ? [].concat(JSON.parse(text)).filter(Boolean) : []);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Плееры: [{ app, status: 'Playing'|'Paused'|…, title, artist }]
const sessions = () => run('status');
const control = (action, app) => run(action, app);

// Имена браузеров в медиа-API
const BROWSER_APPS = ['Chrome', 'MSEdge', 'Firefox', 'Yandex', 'Opera', 'Brave', 'Vivaldi'];
const isBrowser = (app) => BROWSER_APPS.some((b) => app.toLowerCase().includes(b.toLowerCase()));

module.exports = { sessions, control, isBrowser };
