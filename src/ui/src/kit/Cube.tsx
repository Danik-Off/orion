// Куб — лицо Ориона: светящийся, вращается; цвет и скорость — состояние, грани дышат голосом (--lvl).
import type { CSSProperties } from 'react';

export type Tone = 'teal' | 'mint' | 'violet' | 'amber' | 'grey';

const FACES = ['front', 'right', 'back', 'left', 'top', 'bottom'] as const;

export function Cube({
  size,
  tone = 'teal',
  spin = 9,
  voice = false,
  dim = false,
  className = '',
}: {
  size: number;
  tone?: Tone;
  spin?: number; // секунд на оборот
  voice?: boolean; // пульсировать в такт голосу
  dim?: boolean; // микрофон выключен — почти замер
  className?: string;
}) {
  const style = { '--cs': `${size}px`, '--spin': `${spin}s` } as CSSProperties;
  return (
    <span
      className={`cube tone-${tone}${voice ? ' cube-voice' : ''}${dim ? ' cube-dim' : ''} ${className}`}
      style={style}
      aria-hidden="true"
    >
      <span className="cube-halo" />
      <span className="cube-body">
        <span className="cube-spin">
          {FACES.map((f) => (
            <i key={f} className={`cube-face cube-${f}`} />
          ))}
        </span>
      </span>
    </span>
  );
}
