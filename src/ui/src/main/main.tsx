// Окно разговора: контроллер (поведение, без DOM) + React (вид по состоянию).
import { StrictMode, useEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import '../kit/kit.css';
import './main.css';
import { api } from '../bridge.ts';
import { createConversation, type Conversation } from './controller.ts';
import { createMic } from '../audio/mic.ts';
import { createSpeaker } from '../audio/speaker.ts';
import { createRadio } from '../audio/radio.ts';
import { playChime, setQuiet } from '../audio/chime.ts';
import { FullWindow } from './FullWindow.tsx';
import { CubeWindow, HoloWindow } from './HoloWindow.tsx';

const conversation = createConversation({
  api: api(),
  createMic,
  createSpeaker,
  createRadio,
  playChime,
  setQuiet,
  // Громкость голоса — CSS-переменная мимо React: десять раз в секунду, перерисовывать нечего
  setLevel: (level) => document.documentElement.style.setProperty('--lvl', level.toFixed(3)),
});
// Скриншоты и проверка через DevTools управляют окном отсюда
(window as unknown as { __orion: Conversation }).__orion = conversation;

function App({ c }: { c: Conversation }) {
  const s = useSyncExternalStore(c.subscribe, c.getState);
  useEffect(() => {
    document.body.className = `mode-${s.mode}`;
    document.title = s.name;
  }, [s.mode, s.name]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && c.actions.escape();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [c]);
  if (s.mode === 'orb') return <HoloWindow s={s} c={c} />;
  if (s.mode === 'cube') return <CubeWindow s={s} c={c} />;
  return <FullWindow s={s} c={c} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App c={conversation} />
  </StrictMode>,
);
conversation.connect();
