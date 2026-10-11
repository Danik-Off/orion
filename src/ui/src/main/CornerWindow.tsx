// Угол экрана: свёрнутый шар (режим cube, окно 64 × 64) и голограмма (режим orb): шар проецирует вверх конус
// света, на его конце — прозрачная панель с ответом. Один вид на оба режима: шар — тот же элемент на том же
// месте (в 32 px от правого и нижнего края окна), при раскрытии и сворачивании он не перерисовывается и не прыгает.
// Появление (holo: seed → open): шар вспыхивает, луч выдвигается, на месте удара света — черта, из неё
// разворачивается панель, потом проступает текст. Уход (closing) — то же в обратном порядке.
// Смена состояния — без рывков: высота панели доезжает до нового содержимого, подпись и текст проявляются заново,
// цвет перетекает (tokens.css), кольца шара разгоняются плавно (Sphere.tsx).
// Окно не забирает фокус; клики мимо шара и панели уходят программе под ним. Высота окна — по панели.
import { useEffect, useRef, useState } from 'react';
import type { Conversation, State } from './controller.ts';
import { Sphere } from '../kit/Sphere.tsx';
import { Holo, Label } from '../kit/Holo.tsx';
import { Button, IconButton } from '../kit/controls.tsx';
import { CardView } from '../kit/cards.tsx';
import { FollowBar } from './parts.tsx';
import { spinOf, tagOf, toneOf } from './look.ts';
import { api } from '../bridge.ts';

const MARGIN_TOP = 22; // над панелью — место под свечение
const PANEL_BOTTOM = 84; // низ панели над краем окна: шар (48 px) и луч под ней
const PANEL_PAD = 26; // отступы панели сверху и снизу (main.css, .orb-panel > .holo-body)
const RESIZE_MS = 300; // переход высоты панели (main.css) — окно уменьшается, когда панель уже сжалась

export function CornerWindow({ s, c }: { s: State; c: Conversation }) {
  const orb = s.mode === 'orb';
  const a = c.actions;
  const tone = toneOf(s.core);
  const content = useRef<HTMLDivElement>(null);
  const through = useRef<boolean | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  // Высота панели — по содержимому, с переходом; окно — под панель: низ на месте, растёт вверх.
  // Растёт — окно сразу (над панелью оно прозрачное), сжимается — после перехода, чтобы не срезать панель
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    let shown = 0;
    let shrink: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const h = Math.ceil(el.getBoundingClientRect().height) + PANEL_PAD;
      setHeight(h);
      const need = h + PANEL_BOTTOM + MARGIN_TOP;
      clearTimeout(shrink);
      if (need >= shown) api().orbHeight((shown = need));
      else shrink = setTimeout(() => api().orbHeight((shown = need)), RESIZE_MS);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => {
      ro.disconnect();
      clearTimeout(shrink);
      setHeight(null); // следующее появление — сразу нужной высоты, без перехода от прошлой
    };
  }, [orb]);

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
  }, [orb]); // в режим голограммы — заново: сквозные клики main включает только в нём

  const asking = !!s.confirm;
  const tag = tagOf(s.core, !!s.follow);
  const long = s.caption.length > 220;
  return (
    <div className={`orb${orb ? ` orb-open holo-${s.holo}` : ''} tone-${tone}${s.calm ? ' calm' : ''}`}>
      {orb && <span className="orb-beam" aria-hidden="true" />}
      {orb && (
        <div className="orb-stage">
          <Holo
            className="orb-panel orb-hit"
            tone={tone}
            style={height ? { height } : undefined}
            onMouseEnter={() => a.hover(true)}
            onMouseLeave={() => a.hover(false)}
            onClick={(e) => !(e.target as Element).closest('button') && a.expand()}
          >
            <div className="orb-content" ref={content}>
              <div className="orb-head">
                <Label key={tag} className="swap">
                  {tag}
                </Label>
                <span className="orb-tools">
                  <IconButton icon="expand" label="Открыть окно" onClick={a.expand} />
                  <IconButton icon="close" label="Закрыть" danger onClick={a.closeHolo} />
                </span>
              </div>
              {s.caption && (
                // Новый ответ проявляется; распознаваемая фраза обновляется на месте (ключ не меняется)
                <div
                  key={s.core === 'hearing' ? 'heard' : s.caption}
                  className={`orb-caption swap${s.core === 'hearing' ? ' hearing' : ''}${long ? ' clamp' : ''}`}
                >
                  {s.caption}
                </div>
              )}
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
            </div>
          </Holo>
        </div>
      )}
      <button
        type="button"
        className="orb-sphere orb-hit"
        title={orb ? undefined : `${s.name}: нажмите или скажите «${s.name}»`}
        aria-label={`Открыть окно — ${s.name}`}
        onClick={a.expand}
      >
        <Sphere size={48} tone={tone} spin={spinOf(s.core)} voice={orb} dim={s.core === 'off'} />
      </button>
    </div>
  );
}
