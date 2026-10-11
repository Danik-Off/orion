// Мини-плеер радио: голографическая полоска поверх окон — шар, станция и песня, пауза, другая станция,
// громкость (ползунок и колёсико), выключить. Звук играет окно разговора; здесь — только пульт.
// Окно перетаскивается за любое место, кроме кнопок и громкости (main прилепит его к ближайшему углу).
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../kit/kit.css';
import './player.css';
import { api, type PlayerState } from '../bridge.ts';
import { ErrorBoundary } from '../kit/ErrorBoundary.tsx';
import { Sphere } from '../kit/Sphere.tsx';
import { Holo } from '../kit/Holo.tsx';
import { IconButton } from '../kit/controls.tsx';

function Player() {
  const [s, setS] = useState<PlayerState>({});
  const [volume, setVolume] = useState(80);
  const dragging = useRef(false); // пока тянут ползунок, значение из ядра его не перебивает

  useEffect(() => {
    api().onRadioPlayer((next) => {
      setS(next);
      if (!dragging.current && typeof next.volume === 'number') setVolume(Math.round(next.volume * 100));
    });
  }, []);

  // Колёсико над плеером — тоже громкость. Прокрутка копится: щелчок мыши (100 единиц) — 5%, тачпад со
  // множеством мелких событий меняет громкость плавно, а не скачет 0 ↔ 100; горизонтальный жест — не громкость
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  useEffect(() => {
    let pending = 0;
    let done: ReturnType<typeof setTimeout> | undefined;
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      pending += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // строки → пиксели
      const steps = Math.trunc(pending / 100);
      if (!steps) return;
      pending -= steps * 100;
      const next = Math.max(0, Math.min(100, volumeRef.current - steps * 5));
      if (next === volumeRef.current) return;
      setVolume(next);
      api().radioControl('volume', next / 100);
      clearTimeout(done);
      done = setTimeout(() => api().radioControl('volume-done'), 400); // запомнить — когда крутить перестали
    };
    window.addEventListener('wheel', wheel, { passive: true });
    return () => {
      window.removeEventListener('wheel', wheel);
      clearTimeout(done);
    };
  }, []);

  const playing = s.playing === true;
  const loading = s.status === 'loading';
  const failed = s.status === 'error';
  return (
    <Holo
      className={`player${playing ? ' playing' : ''}${failed ? ' failed' : ''}`}
      tone={failed ? 'amber' : 'teal'}
      corners={false}
      flicker={false}
    >
      <Sphere size={24} tone={failed ? 'amber' : playing || loading ? 'teal' : 'grey'} spin={loading ? 1.5 : playing ? 5 : 30} />
      <div
        className="player-info"
        title={failed ? 'Станция не отвечает — попробуйте другую' : s.song || 'Перетащите в любой угол или на другой экран'}
      >
        <span className="player-name">{s.name || 'Радио'}</span>
        {failed ? (
          <span className="player-song">Не отвечает</span>
        ) : loading ? (
          <span className="player-song">Подключаюсь…</span>
        ) : (
          s.song && <span className="player-song">{s.song}</span>
        )}
      </div>
      <div className="player-eq" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="player-controls">
        <IconButton
          icon={playing ? 'pause' : 'play'}
          label={playing ? 'Пауза' : 'Играть'}
          onClick={() => api().radioControl(playing ? 'pause' : 'resume')}
        />
        <IconButton icon="next" label="Другая станция" onClick={() => api().radioControl('next')} />
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={volume}
          aria-label="Громкость"
          title="Громкость"
          className="player-volume"
          onChange={(e) => {
            dragging.current = true;
            const v = Number(e.target.value);
            setVolume(v);
            api().radioControl('volume', v / 100);
          }}
          onPointerUp={() => {
            dragging.current = false;
            api().radioControl('volume-done');
          }}
        />
        <IconButton icon="close" label="Выключить радио" danger onClick={() => api().radioControl('stop')} />
      </div>
    </Holo>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary title="радио">
      <Player />
    </ErrorBoundary>
  </StrictMode>,
);
