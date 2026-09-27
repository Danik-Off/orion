// Сеть: есть ли интернет и какой отклик, Wi-Fi и сила сигнала, скорость загрузки, IP-адреса.
const os = require('node:os');
const { spawn } = require('node:child_process');
const { plural } = require('../lib/ru');

// Отклик — по второму запросу: первый включает установку соединения (TLS)
async function ping(url = 'https://ya.ru') {
  let best = null;
  for (let i = 0; i < 2; i++) {
    const t = Date.now();
    try {
      await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    } catch {
      return null;
    }
    best = Math.min(best ?? Infinity, Date.now() - t);
  }
  return best;
}

// netsh выводит по-русски или по-английски — берём SSID и проценты, они не переводятся
function wifi() {
  return new Promise((resolve) => {
    const p = spawn('netsh.exe', ['wlan', 'show', 'interfaces'], { shell: false, windowsHide: true });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.once('error', () => resolve(null));
    p.once('close', () => {
      // netsh пишет в кодировке консоли (cp866)
      const out = new TextDecoder('ibm866').decode(Buffer.concat(chunks));
      const ssid = out.match(/^\s*SSID\s*:\s*(.+)$/m)?.[1]?.trim();
      const signal = out.match(/:\s*(\d{1,3})%/)?.[1];
      resolve(ssid ? { ssid, signal: signal ? Number(signal) : null } : null);
    });
  });
}

async function speed() {
  const bytes = 25_000_000;
  const t = Date.now();
  const res = await fetch(`https://speed.cloudflare.com/__down?bytes=${bytes}`, { signal: AbortSignal.timeout(30_000) });
  const got = (await res.arrayBuffer()).byteLength;
  const mbit = (got * 8) / 1e6 / ((Date.now() - t) / 1000);
  return Math.round(mbit);
}

const localIp = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal && !/^169\.254/.test(i.address))?.address;

const ms = (n) => `${n} ${plural(n, 'миллисекунда', 'миллисекунды', 'миллисекунд')}`;

// arg: '' — общая проверка; speed; ip; wifi
async function network(arg) {
  const a = String(arg).trim().toLowerCase();
  if (/^(speed|скорост)/.test(a)) {
    const latency = await ping();
    if (latency === null) return { ok: true, speak: 'Интернета нет, сэр — скорость измерить не могу.' };
    const mbit = await speed().catch(() => null);
    return mbit === null
      ? { ok: false, message: 'Не удалось измерить скорость, сэр.' }
      : { ok: true, speak: `Скорость загрузки около ${mbit} ${plural(mbit, 'мегабита', 'мегабит', 'мегабит')} в секунду, отклик ${ms(latency)}.` };
  }
  if (/^(ip|айпи)/.test(a)) {
    const local = localIp();
    const pub = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) }).then((r) => r.text()).catch(() => null);
    return { ok: true, speak: `Локальный адрес ${local || 'не найден'}${pub ? `, внешний ${pub}` : ''}.` };
  }
  const [latency, w] = await Promise.all([ping(), wifi()]);
  const parts = [latency === null ? 'Интернета нет, сэр.' : `Интернет есть, отклик ${ms(latency)}.`];
  if (w) parts.push(`Wi-Fi «${w.ssid}»${w.signal ? `, сигнал ${w.signal} ${plural(w.signal, 'процент', 'процента', 'процентов')}` : ''}.`);
  else if (localIp()) parts.push('Подключение по кабелю.');
  if (latency !== null && latency > 300) parts.push('Отклик медленный — сеть загружена или сигнал слабый.');
  return { ok: true, speak: parts.join(' ') };
}

module.exports = {
  id: 'network',
  platforms: ['win32'], // PowerShell и программы Windows
  title: 'интернет: есть ли связь, Wi-Fi и сигнал, скорость, IP-адрес',
  keywords: ['интернет', 'сеть', 'wi-fi', 'wifi', 'вайфай', 'вай фай', 'скорость интернета', 'пинг', 'ip', 'айпи', 'роутер', 'связь'],
  tools: [
    {
      name: 'network',
      use: 'проверить интернет и Wi-Fi, измерить скорость, узнать IP',
      arg: 'пусто — проверка связи; "speed" — скорость; "ip" — адреса',
      argEnum: ['', 'speed', 'ip'],
      examples: [['какая у меня скорость интернета', { addressed: true, say: 'Измеряю, это секунд десять.', actions: [{ tool: 'network', arg: 'speed' }] }]],
      run: network,
    },
  ],
};
