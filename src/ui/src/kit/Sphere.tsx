// Шар — лицо Ориона: светящееся ядро-глобус, вокруг — кольца табло (плоские, крутятся в разные стороны)
// и две наклонные орбиты со спутником (настоящее 3D: задняя половина орбиты уходит за шар).
// Цвет и скорость — состояние, ядро дышит голосом (--lvl). Маленький (< 28 px) — только ядро и дуги.
// Скорость меняется плавно: длительности в CSS постоянные (от BASE_SPIN), а состояние задаёт playbackRate —
// угол колец сохраняется, кольца разгоняются и тормозят, а не перескакивают (как при смене animation-duration).
import { useEffect, useRef, type CSSProperties } from 'react';

export type Tone = 'teal' | 'mint' | 'violet' | 'amber' | 'grey';

const BASE_SPIN = 9; // секунд на оборот при скорости 1
const EASE_MS = 600; // разгон и торможение

export function Sphere({
  size,
  tone = 'teal',
  spin = BASE_SPIN,
  voice = false,
  dim = false,
  className = '',
}: {
  size: number;
  tone?: Tone;
  spin?: number; // секунд на оборот кольца
  voice?: boolean; // ядро пульсирует в такт голосу
  dim?: boolean; // микрофон выключен — почти замер
  className?: string;
}) {
  const el = useRef<HTMLSpanElement>(null);
  const rate = useRef(BASE_SPIN / spin); // скорость сейчас (во время разгона — промежуточная)
  const mini = size < 28;

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const anims = () => node.getAnimations({ subtree: true }).filter((a) => (a as CSSAnimation).animationName?.startsWith('sph-'));
    const from = rate.current;
    const to = BASE_SPIN / spin;
    const t0 = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / EASE_MS);
      rate.current = from + (to - from) * (1 - (1 - k) ** 3);
      for (const a of anims()) a.playbackRate = rate.current; // playbackRate сохраняет текущий угол
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [spin, mini]); // mini: другие кольца — новым анимациям тоже нужна скорость

  const style = { '--cs': `${size}px`, '--spin': `${BASE_SPIN}s` } as CSSProperties;
  return (
    <span
      ref={el}
      className={`sph tone-${tone}${mini ? ' sph-mini' : ''}${voice ? ' sph-voice' : ''}${dim ? ' sph-dim' : ''} ${className}`}
      style={style}
      aria-hidden="true"
    >
      <span className="sph-halo" />
      <svg className="sph-rings" viewBox="0 0 100 100">
        {!mini && <circle className="sph-r1" cx="50" cy="50" r="47" pathLength="120" />}
        {!mini && <circle className="sph-r2" cx="50" cy="50" r="42" pathLength="100" />}
        <circle className="sph-r3" cx="50" cy="50" r={mini ? 44 : 37} pathLength="100" />
      </svg>
      <span className="sph-space">
        {!mini && (
          <>
            <span className="sph-orbit sph-o1">
              <i className="sph-sat" />
            </span>
            <span className="sph-orbit sph-o2" />
          </>
        )}
        <span className="sph-core">
          <span className="sph-meridian" />
        </span>
      </span>
    </span>
  );
}
