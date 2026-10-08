// Мини-плеер радио: показывает, что играет, и шлёт нажатия в ядро (src/app/radio-player.js).
// Звук — в окне разговора; здесь только пульт.
const $ = (id) => document.getElementById(id);
const player = $('player');
const toggle = $('toggle');
const volume = $('volume');
let playing = false;
let dragging = false; // пока тянут ползунок громкости, не перебивать его значением из ядра

window.jarvis.onRadioPlayer((s) => {
  playing = s.playing === true;
  player.classList.toggle('playing', playing);
  $('name').textContent = s.name || 'Радио';
  $('name').title = s.name || '';
  $('song').textContent = s.song || '';
  $('song').title = s.song || '';
  toggle.classList.toggle('paused', !playing);
  toggle.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  toggle.title = playing ? 'Пауза' : 'Играть';
  toggle.setAttribute('aria-label', toggle.title);
  if (!dragging && typeof s.volume === 'number') volume.value = String(Math.round(s.volume * 100));
});

toggle.addEventListener('click', () => window.jarvis.radioControl(playing ? 'pause' : 'resume'));
$('next').addEventListener('click', () => window.jarvis.radioControl('next'));
$('stop').addEventListener('click', () => window.jarvis.radioControl('stop'));

volume.addEventListener('input', () => {
  dragging = true;
  window.jarvis.radioControl('volume', Number(volume.value) / 100);
});
volume.addEventListener('change', () => {
  dragging = false;
  window.jarvis.radioControl('volume-done');
});
// Колёсико над плеером — тоже громкость
window.addEventListener(
  'wheel',
  (e) => {
    const v = Math.max(0, Math.min(100, Number(volume.value) + (e.deltaY < 0 ? 5 : -5)));
    volume.value = String(v);
    window.jarvis.radioControl('volume', v / 100);
    window.jarvis.radioControl('volume-done');
  },
  { passive: true },
);
