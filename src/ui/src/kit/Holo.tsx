// Голографическая панель: прозрачная подложка, развёртка, уголки и мерцающая рамка (текст не мерцает).
import type { HTMLAttributes, ReactNode } from 'react';
import type { Tone } from './Sphere.tsx';

export function Holo({
  tone = 'teal',
  glass = 'holo',
  corners = true,
  flicker = true,
  className = '',
  children,
  ...rest
}: {
  tone?: Tone;
  glass?: 'holo' | 'solid';
  corners?: boolean;
  flicker?: boolean;
  className?: string;
  children?: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`holo holo-${glass} tone-${tone} ${className}`} {...rest}>
      <span className={`holo-frame${flicker ? ' holo-flicker' : ''}`} aria-hidden="true" />
      <span className="holo-scan" aria-hidden="true" />
      {corners && (
        <>
          <span className="holo-corner tl" aria-hidden="true" />
          <span className="holo-corner tr" aria-hidden="true" />
          <span className="holo-corner bl" aria-hidden="true" />
          <span className="holo-corner br" aria-hidden="true" />
        </>
      )}
      <div className="holo-body">{children}</div>
    </div>
  );
}

// Метка: «◆ ПОГОДА · 14:02» — моноширинным, разрядкой
export const Label = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <span className={`label ${className}`}>{children}</span>
);
