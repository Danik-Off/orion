// Кнопки, поля, переключатели, полоски — общие для всех окон.
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon.tsx';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet';

export function Button({
  variant = 'secondary',
  wide = false,
  className = '',
  children,
  ...rest
}: { variant?: ButtonVariant; wide?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`btn btn-${variant}${wide ? ' btn-wide' : ''} ${className}`} {...rest}>
      {children}
    </button>
  );
}

// Кнопка-значок: подпись обязательна — для экранного диктора и подсказки
export function IconButton({
  icon,
  label,
  on = false,
  danger = false,
  className = '',
  ...rest
}: { icon: IconName; label: string; on?: boolean; danger?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`icon-btn${on ? ' on' : ''}${danger ? ' danger' : ''} ${className}`}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

export const Chip = ({ children, ...rest }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button type="button" className="chip" {...rest}>
    {children}
  </button>
);

export function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <label className="toggle" title={label}>
      <input type="checkbox" checked={checked} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export const TextField = (props: InputHTMLAttributes<HTMLInputElement>) => <input className="field" spellCheck={false} {...props} />;

export function Select({ options, ...rest }: { options: [string | number, string][] } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className="field" {...rest}>
      {options.map(([v, label]) => (
        <option key={String(v)} value={String(v)}>
          {label}
        </option>
      ))}
    </select>
  );
}

export const Progress = ({ value }: { value: number }) => (
  <span className="progress" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
    <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
  </span>
);
