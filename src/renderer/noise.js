// Звуки для сна, синтезированные прямо в окне (Web Audio): дождь, море, белый и «тёплый» (коричневый) шум.
// Без сети и без файлов. Шум считается один раз в буфер на 20 секунд с плавной склейкой концов —
// петля без щелчка; стерео — каналы независимые, звук объёмный.
//   createNoise(audioCtx, id) → { output (узел, его подключают к громкости), stop() }
/* exported createNoise, NOISE_IDS */
const NOISE_IDS = ['rain', 'sea', 'white', 'brown'];

// Буфер с бесшовной петлёй: fill(channel, n) → Float32Array длиной n
function loopBuffer(ctx, seconds, fill) {
  const rate = ctx.sampleRate;
  const len = Math.round(seconds * rate);
  const fade = Math.round(0.5 * rate);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const raw = fill(ch, len + fade);
    const out = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i] = raw[i];
    // Начало петли плавно переходит из её же продолжения: конец буфера стыкуется с началом без скачка
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      out[i] = raw[i] * k + raw[len + i] * (1 - k);
    }
  }
  return buf;
}

const white = (n) => {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.random() * 2 - 1;
  return a;
};

// Коричневый шум: «гул», мягче белого — интеграл белого с утечкой
function brown(n) {
  const a = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    a[i] = last * 3.5;
  }
  return a;
}

// Розовый шум (фильтр Пола Келлета) — основа дождя; поверх — редкие капли (короткие затухающие щелчки)
function rain(n, rate) {
  const a = new Float32Array(n);
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    a[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.09;
    b6 = w * 0.115926;
  }
  const drops = Math.round((n / rate) * 40);
  for (let d = 0; d < drops; d++) {
    const at = Math.floor(Math.random() * n);
    const amp = 0.05 + Math.random() * 0.2;
    const decay = rate * (0.002 + Math.random() * 0.004);
    for (let j = 0; j < decay * 5 && at + j < n; j++) a[at + j] += (Math.random() * 2 - 1) * amp * Math.exp(-j / decay);
  }
  return a;
}

function createNoise(ctx, id) {
  const rate = ctx.sampleRate;
  const fills = { white, brown, sea: brown, rain: (n) => rain(n, rate) };
  const fill = fills[id] || fills.rain;
  const src = ctx.createBufferSource();
  src.buffer = loopBuffer(ctx, 20, (_ch, n) => fill(n));
  src.loop = true;
  const output = ctx.createGain();
  const extra = []; // генераторы, которые надо остановить вместе со звуком
  if (id === 'sea') {
    // Волны: громкость и яркость шума медленно накатывают и отступают (~9 с), две волны вразнобой
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700;
    const swell = ctx.createGain();
    swell.gain.value = 0.55;
    for (const [freq, depth, cut] of [
      [0.11, 0.3, 450],
      [0.071, 0.15, 250],
    ]) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = depth;
      lfo.connect(g).connect(swell.gain);
      const f = ctx.createGain();
      f.gain.value = cut;
      lfo.connect(f).connect(filter.frequency);
      lfo.start();
      extra.push(lfo);
    }
    src.connect(filter).connect(swell).connect(output);
  } else if (id === 'rain') {
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 6000;
    const high = ctx.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 180;
    src.connect(high).connect(low).connect(output);
  } else if (id === 'white') {
    const g = ctx.createGain();
    g.gain.value = 0.25; // белый шум резкий — тише остальных при той же громкости
    src.connect(g).connect(output);
  } else src.connect(output);
  src.start();
  return {
    output,
    stop() {
      for (const n of [src, ...extra]) {
        try {
          n.stop();
        } catch {}
      }
      output.disconnect();
    },
  };
}

if (typeof module !== 'undefined') module.exports = { createNoise, NOISE_IDS };
