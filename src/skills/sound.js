// Громкость Windows точным числом («громкость 30», «сделай потише на 10») и выключение звука — через Core Audio.
// В скрипт подставляются только числа, проверенные кодом.
const { powershell } = require('../lib/windows');
const { wordsToNumber, plural } = require('../lib/ru');

const CORE_AUDIO = `Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, System.Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class OrionAudio {
  static IAudioEndpointVolume Vol() {
    var e = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume v = null;
    var id = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref id, 23, 0, out v));
    return v;
  }
  public static float Volume { get { float v = -1; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(value, System.Guid.Empty)); } }
  public static bool Mute { get { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMute(value, System.Guid.Empty)); } }
}
'@;`;

const getLevel = async () => {
  const [v, m] = (await powershell(`${CORE_AUDIO} "$([math]::Round([OrionAudio]::Volume * 100)) $([OrionAudio]::Mute)"`)).trim().split(' ');
  return { level: Number(v), muted: m === 'True' };
};
const setLevel = (n) => powershell(`${CORE_AUDIO} [OrionAudio]::Mute = $false; [OrionAudio]::Volume = ${(n / 100).toFixed(2)}`);
const setMute = (on) => powershell(`${CORE_AUDIO} [OrionAudio]::Mute = $${on ? 'true' : 'false'}`);

const pct = (n) => `${n} ${plural(n, 'процент', 'процента', 'процентов')}`;

// arg: "30" — поставить; "+10" / "-10" — изменить; "mute" / "unmute"; "?" — узнать
async function volume(arg) {
  const a = String(arg).trim().toLowerCase();
  if (/^(mute|выкл)/.test(a)) return (await setMute(true), { ok: true });
  if (/^(unmute|вкл)/.test(a)) return (await setMute(false), { ok: true });
  const { level, muted } = await getLevel();
  if (!a || a === '?') return { ok: true, speak: muted ? `Звук выключен, громкость ${pct(level)}.` : `Громкость ${pct(level)}.` };
  const n = wordsToNumber(a);
  if (n === null) return { ok: false, message: 'Не понял, какую громкость поставить, сэр.' };
  const target = Math.max(0, Math.min(100, /^[+]/.test(a) ? level + n : /^-/.test(a) ? level - n : n));
  await setLevel(target);
  return { ok: true, speak: `Громкость ${pct(target)}.` };
}

// «громкость 30», «громкость на тридцать», «сделай громкость 50 процентов», «какая громкость»
function quick(text) {
  const t = text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,!?]/g, '')
    .trim();
  if (/^(какая|сколько) (сейчас )?громкост/.test(t)) return { addressed: true, say: '', actions: [{ tool: 'volume', arg: '?' }] };
  const m = t.match(/^(?:(?:поставь|сделай|установи) )?громкость (?:на )?(.+?)(?: процент[а-я]*)?$/);
  const n = m && wordsToNumber(m[1]);
  if (n === null || n === undefined || n > 100) return null;
  return { addressed: true, say: '', actions: [{ tool: 'volume', arg: String(n) }], silent: true };
}

module.exports = {
  id: 'sound',
  needs: [],
  platforms: ['win32'], // PowerShell и программы Windows
  title: 'громкость Windows точным числом, выключить или включить звук',
  keywords: ['громк', 'звук', 'тише', 'громче', 'погромч', 'потиш', 'mute', 'процент'],
  quick,
  rules: ['Громкость числом или «на сколько-то громче/тише» — volume; просто «громче/тише» без числа — media.'],
  tools: [
    {
      name: 'volume',
      use: 'поставить точную громкость, изменить на число процентов, выключить или включить звук, узнать громкость',
      arg: '"30" — поставить; "+10" или "-10" — изменить; "mute" / "unmute"; "?" — узнать',
      examples: [['сделай на 20 процентов тише', { addressed: true, say: '', actions: [{ tool: 'volume', arg: '-20' }] }]],
      // «на сколько-то громче», «половина» — число и знак берём из самой фразы
      normalize: (arg, text) => {
        if (/^(mute|unmute|\?)$/.test(arg) || wordsToNumber(arg) !== null) return arg;
        const t = text.toLowerCase();
        const n = /половин/.test(t) ? 50 : wordsToNumber(t);
        if (n === null) return arg;
        return /тише|меньше/.test(t) ? `-${n}` : /громче|больше/.test(t) ? `+${n}` : String(n);
      },
      run: volume,
    },
  ],
  volume,
};
