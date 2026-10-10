// Звуки для сна, синтезированные прямо в окне (Web Audio): дождь, море, белый и «тёплый» (коричневый) шум.
// Без сети и без файлов. Шум считается один раз в буфер на 20 секунд с плавной склейкой концов —
// петля без щелчка; стерео — каналы независимые, звук объёмный.
export const NOISE_IDS = ['rain', 'sea', 'white', 'brown'] as const;

export interface Noise {
  output: GainNode;
  stop(): void;
}

// Буфер с бесшовной петлёй: начало плавно переходит из продолжения — конец стыкуется с началом без скачка
function loopBuffer(ctx: BaseAudioContext, seconds: number, fill: (n: number) => Float32Array): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.round(seconds * rate);
  const fade = Math.round(0.5 * rate);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const raw = fill(len + fade);
    const out = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i] = raw[i];
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      out[i] = raw[i] * k + raw[len + i] * (1 - k);
    }
  }
  return buf;
}

const white = (n: number): Float32Array => {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.random() * 2 - 1;
  return a;
};

// Коричневый шум: «гул», мягче белого — интеграл белого с утечкой
function brown(n: number): Float32Array {
  const a = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    a[i] = last * 3.5;
  }
  return a;
}

// Розовый шум (фильтр Пола Келлета) — основа дождя; поверх — редкие капли (короткие затухающие щелчки)
function rain(n: number, rate: number): Float32Array {
  const a = new Float32Array(n);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
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

export function createNoise(ctx: BaseAudioContext, id: string): Noise {
  const rate = ctx.sampleRate;
  const fills: Record<string, (n: number) => Float32Array> = { white, brown, sea: brown, rain: (n) => rain(n, rate) };
  const fill = fills[id] || fills.rain;
  const src = ctx.createBufferSource();
  src.buffer = loopBuffer(ctx, 20, fill);
  src.loop = true;
  const output = ctx.createGain();
  const extra: OscillatorNode[] = [];
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
        } catch {
          // уже остановлен
        }
      }
      output.disconnect();
    },
  };
}
