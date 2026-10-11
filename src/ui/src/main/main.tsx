// Окно разговора: контроллер (поведение, без DOM) + React (вид по состоянию).
import { StrictMode, useEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import '../kit/kit.css';
import './main.css';
import { api } from '../bridge.ts';
import { createConversation, type Conversation, type CoreState } from './controller.ts';
import { createMic } from '../audio/mic.ts';
import { createSpeaker } from '../audio/speaker.ts';
import { createRadio } from '../audio/radio.ts';
import { playChime, setQuiet } from '../audio/chime.ts';
import { FullWindow } from './FullWindow.tsx';
import { CornerWindow } from './CornerWindow.tsx';
import { ErrorBoundary } from '../kit/ErrorBoundary.tsx';

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

// Точка состояния для панели задач Windows: кружок цвета шара с тёмной обводкой (видна на светлой и тёмной панели)
const DOT: Partial<Record<CoreState, [string, string]>> = {
  listening: ['93,255,180', 'Слушаю'],
  hearing: ['93,255,180', 'Слушаю'],
  thinking: ['180,140,255', 'Думаю'],
  speaking: ['95,255,224', 'Отвечаю'],
  ask: ['255,180,92', 'Жду ответа'],
  error: ['255,180,92', 'Не получилось'],
};
function taskbarDot(core: CoreState): [string | null, string] {
  const dot = DOT[core];
  if (!dot) return [null, ''];
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  if (!g) return [null, ''];
  g.beginPath();
  g.arc(16, 16, 13, 0, Math.PI * 2);
  g.fillStyle = `rgb(${dot[0]})`;
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(3,10,12,0.85)';
  g.stroke();
  return [c.toDataURL('image/png'), dot[1]];
}

function App({ c }: { c: Conversation }) {
  const s = useSyncExternalStore(c.subscribe, c.getState);
  useEffect(() => {
    document.body.className = `mode-${s.mode}`;
    document.title = s.name;
  }, [s.mode, s.name]);
  // Точка на кнопке в панели задач — цвет состояния, как у шара; без дела — без точки
  useEffect(() => api().taskbarState(...taskbarDot(s.core)), [s.core]);
  // Новый режим на экране (два кадра: разметка и отрисовка) — окно можно показывать
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => (second = requestAnimationFrame(() => api().painted(s.mode))));
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [s.mode]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && c.actions.escape();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [c]);
  // Скрытое окно — тоже угловой вид: голограмма ушла, а main ещё не сменил окно — не мелькнуть полным окном
  return s.mode === 'full' ? <FullWindow s={s} c={c} /> : <CornerWindow s={s} c={c} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App c={conversation} />
    </ErrorBoundary>
  </StrictMode>,
);
conversation.connect();
