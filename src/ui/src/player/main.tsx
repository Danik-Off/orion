// Мини-плеер радио: голографическая полоска поверх окон — куб, станция и песня, пауза, другая станция,
// громкость (ползунок и колёсико), выключить. Звук играет окно разговора; здесь — только пульт.
// Окно перетаскивается за любое место, кроме кнопок и громкости (main прилепит его к ближайшему углу).
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../kit/kit.css';
import './player.css';
import { api, type PlayerState } from '../bridge.ts';
import { Cube } from '../kit/Cube.tsx';
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

  // Колёсико над плеером — тоже громкость
  useEffect(() => {
    const wheel = (e: WheelEvent) =>
      setVolume((v) => {
        const next = Math.max(0, Math.min(100, v + (e.deltaY < 0 ? 5 : -5)));
        api().radioControl('volume', next / 100);
        api().radioControl('volume-done');
        return next;
      });
    window.addEventListener('wheel', wheel, { passive: true });
    return () => window.removeEventListener('wheel', wheel);
  }, []);

  const playing = s.playing === true;
  return (
    <Holo className={`player${playing ? ' playing' : ''}`} tone="teal" corners={false} flicker={false}>
      <Cube size={24} tone={playing ? 'teal' : 'grey'} spin={playing ? 5 : 30} />
      <div className="player-info" title="Перетащите в любой угол или на другой экран">
        <span className="player-name">{s.name || 'Радио'}</span>
        {s.song && <span className="player-song">{s.song}</span>}
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
    <Player />
  </StrictMode>,
);
