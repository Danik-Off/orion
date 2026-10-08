// Настройки Windows голосом — без прав администратора и сторонних программ:
//   тема (тёмная/светлая) — реестр текущего пользователя; Wi-Fi и Bluetooth — системный API радиомодулей
//   (Windows.Devices.Radios, как переключатели в центре уведомлений); выключить экран — сообщение системе
//   (экран проснётся от мыши или клавиш); режим питания — powercfg; разделы «Параметров» — ссылки ms-settings:.
const { powershell } = require('./windows');

// Ожидание асинхронной операции WinRT из PowerShell 5.1
const WINRT = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
`;

// Радиомодуль (WiFi | Bluetooth): включить/выключить → 'On' | 'Off' | 'нет' (такого модуля нет) | 'запрещено'
async function setRadio(kind, on) {
  const out = await powershell(
    `${WINRT}
$access = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
if ($access -ne 'Allowed') { 'запрещено'; exit }
$radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
$r = $radios | Where-Object { $_.Kind -eq $env:ORION_RADIO } | Select-Object -First 1
if (-not $r) { 'нет'; exit }
Await ($r.SetStateAsync($env:ORION_STATE)) ([Windows.Devices.Radios.RadioAccessStatus]) | Out-Null
$r.State`,
    { env: { ORION_RADIO: kind, ORION_STATE: on ? 'On' : 'Off' }, timeout: 20_000 },
  );
  return out.trim().split(/\r?\n/).pop();
}

// Тёмная или светлая тема для приложений и системы (панель задач, меню «Пуск»)
async function setTheme(dark) {
  await powershell(
    `$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
Set-ItemProperty -Path $k -Name AppsUseLightTheme -Value $env:ORION_LIGHT -Type DWord
Set-ItemProperty -Path $k -Name SystemUsesLightTheme -Value $env:ORION_LIGHT -Type DWord`,
    { env: { ORION_LIGHT: dark ? '0' : '1' } },
  );
}

// Выключить экран (компьютер работает; экран проснётся от мыши или клавиатуры)
async function screenOff() {
  await powershell(`Add-Type -Namespace Orion -Name Monitor -MemberDefinition '[DllImport("user32.dll")] public static extern int SendMessage(int h, int m, int w, int l);'
[Orion.Monitor]::SendMessage(0xffff, 0x0112, 0xF170, 2) | Out-Null`);
}

// Режим питания: встроенные схемы Windows (их псевдонимы есть на любой системе)
const POWER = { performance: 'SCHEME_MIN', balanced: 'SCHEME_BALANCED', saver: 'SCHEME_MAX' };
async function setPowerPlan(mode) {
  await powershell(`powercfg /setactive ${POWER[mode]}`);
}

// Разделы «Параметров Windows»
const SETTINGS_PAGES = {
  звук: 'ms-settings:sound',
  bluetooth: 'ms-settings:bluetooth',
  'wi-fi': 'ms-settings:network-wifi',
  сеть: 'ms-settings:network-status',
  экран: 'ms-settings:display',
  обновления: 'ms-settings:windowsupdate',
  приложения: 'ms-settings:appsfeatures',
  уведомления: 'ms-settings:notifications',
  персонализация: 'ms-settings:personalization',
  фон: 'ms-settings:personalization-background',
  батарея: 'ms-settings:batterysaver',
  питание: 'ms-settings:powersleep',
  память: 'ms-settings:storagesense',
  мышь: 'ms-settings:mousetouchpad',
  клавиатура: 'ms-settings:typing',
  язык: 'ms-settings:regionlanguage',
  время: 'ms-settings:dateandtime',
  принтеры: 'ms-settings:printers',
  микрофон: 'ms-settings:privacy-microphone',
  параметры: 'ms-settings:',
};

module.exports = { setRadio, setTheme, screenOff, setPowerPlan, SETTINGS_PAGES, POWER };
