// Голограмма в углу экрана (режим orb): куб у края, от него — луч, в луче — прозрачная панель с ответом.
// Окно не забирает фокус; клики мимо куба и панели уходят программе под ним. Высота окна — по панели.
import { useEffect, useRef } from 'react';
import type { Conversation, State } from './controller.ts';
import { Cube } from '../kit/Cube.tsx';
import { Holo, Label } from '../kit/Holo.tsx';
import { Button, IconButton } from '../kit/controls.tsx';
import { CardView } from '../kit/cards.tsx';
import { FollowBar } from './parts.tsx';
import { spinOf, tagOf, toneOf } from './look.ts';
import { api } from '../bridge.ts';

const MARGIN_TOP = 22; // над панелью — место под кнопки и свечение

export function HoloWindow({ s, c }: { s: State; c: Conversation }) {
  const a = c.actions;
  const tone = toneOf(s.core);
  const stage = useRef<HTMLDivElement>(null);
  const through = useRef<boolean | null>(null);

  // Высота окна — под голограмму: низ на месте, растёт вверх
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const report = () => api().orbHeight(Math.ceil(el.getBoundingClientRect().height) + 36 + MARGIN_TOP);
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
  }, []);

  // Клики мимо голограммы — программе под окном (окно видит движение мыши и в «сквозном» режиме)
  useEffect(() => {
    const pass = (on: boolean) => {
      if (through.current === on) return;
      through.current = on;
      api().orbPassthrough(on);
    };
    const move = (e: MouseEvent) => pass(!(e.target as Element | null)?.closest?.('.orb-hit'));
    const leave = () => pass(true);
    through.current = null;
    pass(true);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseleave', leave);
    return () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseleave', leave);
    };
  }, []);

  const asking = !!s.confirm;
  const long = s.caption.length > 220;
  return (
    <div className={`orb holo-${s.holo} tone-${tone}${s.calm ? ' calm' : ''}`}>
      <div className="orb-stage" ref={stage}>
        <span className="orb-beam" aria-hidden="true" />
        <Holo
          className="orb-panel orb-hit"
          tone={tone}
          onMouseEnter={() => a.hover(true)}
          onMouseLeave={() => a.hover(false)}
          onClick={(e) => !(e.target as Element).closest('button') && a.expand()}
        >
          <div className="orb-head">
            <Label>{tagOf(s.core, !!s.follow)}</Label>
            <span className="orb-tools">
              <IconButton icon="expand" label="Открыть окно" onClick={a.expand} />
              <IconButton icon="close" label="Закрыть" danger onClick={a.closeHolo} />
            </span>
          </div>
          {s.caption && <div className={`orb-caption${s.core === 'hearing' ? ' hearing' : ''}${long ? ' clamp' : ''}`}>{s.caption}</div>}
          {long && (
            <button type="button" className="orb-more" onClick={a.expand}>
              Открыть полностью
            </button>
          )}
          {s.holoCards?.map((card, i) => (
            <CardView key={i} card={card} onCancel={a.cancelSchedule} compact />
          ))}
          {asking && (
            <div className="row-actions">
              <Button variant="danger" wide onClick={() => a.confirm(true)}>
                Да
              </Button>
              <Button wide onClick={() => a.confirm(false)}>
                Нет
              </Button>
            </div>
          )}
          {s.alarm && (
            <div className="row-actions">
              <Button variant="danger" wide onClick={a.alarmStop}>
                Выключить
              </Button>
              <Button wide onClick={a.alarmSnooze}>
                Ещё 10 минут
              </Button>
            </div>
          )}
          {s.follow && (
            <div className="orb-follow">
              <span>Можно продолжать без имени</span>
              <FollowBar follow={s.follow} />
            </div>
          )}
        </Holo>
      </div>
      <button type="button" className="orb-cube orb-hit" aria-label="Открыть окно Ориона" onClick={a.expand}>
        <Cube size={40} tone={tone} spin={spinOf(s.core)} voice />
      </button>
    </div>
  );
}

// Свёрнутый вид: только куб в углу (окно 64 × 64). Щелчок — открыть окно
export function CubeWindow({ s, c }: { s: State; c: Conversation }) {
  const tone = toneOf(s.core);
  return (
    <button
      type="button"
      className={`cube-only tone-${tone}${s.calm ? ' calm' : ''}`}
      title={`${s.name}: нажмите или скажите «${s.name}»`}
      aria-label={`Открыть окно — ${s.name}`}
      onClick={c.actions.expand}
    >
      <Cube size={24} tone={tone} spin={spinOf(s.core)} dim={s.core === 'off'} />
    </button>
  );
}
