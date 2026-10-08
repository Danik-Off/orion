// Радио прямо в окне Ориона, без браузера: поток станции через <audio>.
//   - пока Орион слушает команду или говорит, радио приглушается (duck) и возвращается после;
//   - звук идёт из того же окна, что и микрофон, — эхоподавление вычитает радио из записи, распознаванию не мешает;
//   - медиаклавиши и «пауза» работают: станция видна системе как обычный плеер (Media Session).
// report(state) — сообщить ядру, что играет: { playing, active (станция выбрана, хоть и на паузе), name } (для «что играет», «выключи радио»).
/* exported createRadio */
function createRadio({ report = () => {} } = {}) {
  const audio = new Audio();
  audio.preload = 'none';
  let station = null; // { name, url }
  let volume = 0.8;
  let ducked = false;
  let retried = false;

  const apply = () => (audio.volume = ducked ? volume * 0.15 : volume);
  const send = () => report({ playing: !!station && !audio.paused, active: !!station, name: station?.name || '' });

  function play(s) {
    station = { name: String(s.name || 'Радио'), url: String(s.url) };
    retried = false;
    audio.src = station.url;
    apply();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: station.name, artist: 'Радио' });
      navigator.mediaSession.setActionHandler('play', () => audio.play());
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('stop', stop);
    }
    return audio.play().then(
      () => (send(), true),
      () => (send(), false),
    );
  }

  function stop() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    station = null;
    send();
  }

  // Поток оборвался (сеть) — одна попытка переподключиться
  audio.addEventListener('error', () => {
    if (!station || retried) return send();
    retried = true;
    setTimeout(() => station && ((audio.src = station.url), audio.play().catch(() => send())), 1500);
  });
  audio.addEventListener('pause', send);
  audio.addEventListener('playing', send);

  return {
    play,
    stop,
    pause: () => audio.pause(),
    resume: () => station && audio.play().catch(() => {}),
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
    playing: () => !!station && !audio.paused,
  };
}

if (typeof module !== 'undefined') module.exports = { createRadio };
