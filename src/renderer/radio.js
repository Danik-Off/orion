// Радио прямо в окне Ориона, без браузера: поток станции через <audio>.
//   - пока Орион слушает команду или говорит, радио приглушается (duck) и возвращается после;
//   - звук идёт из того же окна, что и микрофон, — эхоподавление вычитает радио из записи, распознаванию не мешает;
//   - медиаклавиши и «пауза» работают: станция видна системе как обычный плеер (Media Session);
//   - «станции» с адресом sound:<id> — звуки для сна (дождь, море, шум): их синтезирует noise.js, без сети.
// report(state) — сообщить ядру, что играет: { playing, active (станция выбрана, хоть и на паузе), name } (для «что играет», «выключи радио»).
/* exported createRadio */
/* global createNoise */
function createRadio({ report = () => {} } = {}) {
  const audio = new Audio();
  audio.preload = 'none';
  let station = null; // { name, url }
  let volume = 0.8;
  let ducked = false;
  let retried = false;
  // Звук для сна: свой AudioContext (создаётся при первом звуке), генератор и громкость
  let noiseCtx = null;
  let noise = null;
  let noiseGain = null;
  let noisePaused = false;

  const level = () => (ducked ? volume * 0.15 : volume);
  const apply = () => {
    audio.volume = level();
    if (noiseGain) noiseGain.gain.setTargetAtTime(level(), noiseCtx.currentTime, 0.08);
  };
  const isPlaying = () => !!station && (noise ? !noisePaused : !audio.paused);
  const send = () => report({ playing: isPlaying(), active: !!station, name: station?.name || '' });

  function stopNoise() {
    noise?.stop();
    noise = null;
    noisePaused = false;
  }

  function playNoise(id) {
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

  function play(s) {
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
    if (noise) {
      noisePaused = true;
      noiseCtx.suspend().finally(send);
    } else audio.pause();
  }

  function resume() {
    if (!station) return;
    if (noise) {
      noisePaused = false;
      noiseCtx.resume().finally(send);
    } else audio.play().catch(() => {});
  }

  // Поток оборвался (сеть) — одна попытка переподключиться
  audio.addEventListener('error', () => {
    if (!station || noise || retried) return send();
    retried = true;
    setTimeout(() => station && ((audio.src = station.url), audio.play().catch(() => send())), 1500);
  });
  audio.addEventListener('pause', send);
  audio.addEventListener('playing', send);

  return {
    play,
    stop,
    pause,
    resume,
    // Приглушить, пока Орион слушает или говорит
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
    active: () => !!station, // станция выбрана (играет или на паузе)
    sound: () => !!noise, // играет звук для сна, а не станция
  };
}

if (typeof module !== 'undefined') module.exports = { createRadio };
