// Радио прямо в окне Ориона, без браузера: поток станции через <audio>.
//   - пока Орион слушает команду или говорит, радио приглушается (duck) и возвращается после;
//   - звук идёт из того же окна, что и микрофон, — эхоподавление вычитает радио из записи;
//   - медиаклавиши и «пауза» работают: станция видна системе как обычный плеер (Media Session);
//   - «станции» с адресом sound:<id> — звуки для сна (дождь, море, шум): их синтезирует noise.ts, без сети.
// report(state) — сообщить ядру, что играет (для «что играет», «выключи радио»).
import type { Station } from '../bridge.ts';
import { createNoise, type Noise } from './noise.ts';

export interface Radio {
  play(s: Station): Promise<boolean>;
  stop(): void;
  pause(): void;
  resume(): void;
  duck(on: boolean): void;
  setVolume(v: number): void;
  playing(): boolean;
  active(): boolean;
  sound(): boolean;
}

export function createRadio({
  report = () => {},
}: { report?: (s: { playing: boolean; active: boolean; name: string }) => void } = {}): Radio {
  const audio = new Audio();
  audio.preload = 'none';
  let station: Station | null = null;
  let volume = 0.8;
  let ducked = false;
  let retried = false;
  let noiseCtx: AudioContext | null = null;
  let noise: Noise | null = null;
  let noiseGain: GainNode | null = null;
  let noisePaused = false;

  const level = () => (ducked ? volume * 0.15 : volume);
  const apply = () => {
    audio.volume = level();
    if (noiseGain && noiseCtx) noiseGain.gain.setTargetAtTime(level(), noiseCtx.currentTime, 0.08);
  };
  const isPlaying = () => !!station && (noise ? !noisePaused : !audio.paused);
  const send = () => report({ playing: isPlaying(), active: !!station, name: station?.name || '' });

  function stopNoise() {
    noise?.stop();
    noise = null;
    noisePaused = false;
  }

  function playNoise(id: string) {
    noiseCtx ??= new AudioContext();
    if (!noiseGain) {
      noiseGain = noiseCtx.createGain();
      noiseGain.connect(noiseCtx.destination);
    }
    noiseGain.gain.value = 0; // плавно, без щелчка
    noise = createNoise(noiseCtx, id);
    noise.output.connect(noiseGain);
    noiseGain.gain.setTargetAtTime(level(), noiseCtx.currentTime, 0.6);
    return noiseCtx.resume();
  }

  function play(s: Station) {
    station = { name: String(s.name || 'Радио'), url: String(s.url) };
    retried = false;
    stopNoise();
    const sound = station.url.match(/^sound:([a-z]+)$/)?.[1];
    if (sound) {
      audio.pause();
      audio.removeAttribute('src');
    } else audio.src = station.url;
    apply();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: station.name, artist: sound ? 'Орион' : 'Радио' });
      navigator.mediaSession.setActionHandler('play', resume);
      navigator.mediaSession.setActionHandler('pause', pause);
      navigator.mediaSession.setActionHandler('stop', stop);
    }
    return (sound ? playNoise(sound) : audio.play()).then(
      () => (send(), true),
      () => (send(), false),
    );
  }

  function stop() {
    stopNoise();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    station = null;
    send();
  }

  function pause() {
    if (noise && noiseCtx) {
      noisePaused = true;
      void noiseCtx.suspend().finally(send);
    } else audio.pause();
  }

  function resume() {
    if (!station) return;
    if (noise && noiseCtx) {
      noisePaused = false;
      void noiseCtx.resume().finally(send);
    } else audio.play().catch(() => {});
  }

  // Поток оборвался (сеть) — одна попытка переподключиться
  audio.addEventListener('error', () => {
    if (!station || noise || retried) return send();
    retried = true;
    setTimeout(() => {
      if (!station) return;
      audio.src = station.url;
      audio.play().catch(() => send());
    }, 1500);
  });
  audio.addEventListener('pause', send);
  audio.addEventListener('playing', send);

  return {
    play,
    stop,
    pause,
    resume,
    duck(on) {
      if (ducked === !!on) return;
      ducked = !!on;
      apply();
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, Number(v)));
      apply();
    },
    playing: isPlaying,
    active: () => !!station,
    sound: () => !!noise,
  };
}
