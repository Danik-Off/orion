// Значки — тонкие линии, цвет текста. Только нужные окнам.
const PATHS = {
  mic: 'M9 3h6v11H9zM5 11a7 7 0 0 0 14 0M12 18v3',
  micOff: 'M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.9 2.3M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18',
  sound: 'M4 9v6h4l5 4V5L8 9H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
  soundOff: 'M4 9v6h4l5 4V5L8 9H4zM17 9l5 6M22 9l-5 6',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  min: 'M6 17h12',
  close: 'M6 6l12 12M18 6L6 18',
  expand: 'M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7',
  send: 'M5 12h13M13 6l6 6-6 6',
  new: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4',
  owner: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21a8 8 0 0 1 16 0',
  pin: 'M9 3h6M10 3v6l-3 4h10l-3-4V3M12 13v8',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  timer: 'M12 5a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 9v4l2.5 2.5M9 2h6',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2zM10 21h4',
  alarm: 'M12 5.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zM12 9.5V13l2.5 1.5M4 5l3-2.5M20 5l-3-2.5',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 4l13 8-13 8z',
  next: 'M5 5l10 7-10 7zM19 5v14',
  search: 'M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM20 20l-4.5-4.5',
  wifiOff: 'M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0M3 3l18 18',
  // погода
  clear:
    'M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8',
  partly:
    'M8 4.5V3M3.5 9H2M4.6 5.6 3.5 4.5M12.4 5.6l1.1-1.1M5.2 11.5A4 4 0 1 1 12 7.6M8 20h9.5a3.5 3.5 0 0 0 .3-7A5 5 0 0 0 8.4 13.6 3.2 3.2 0 0 0 8 20z',
  cloud: 'M7 19h10.5a4 4 0 0 0 .4-8A6 6 0 0 0 6.6 12.2 3.4 3.4 0 0 0 7 19z',
  fog: 'M7 13h10.5a3.5 3.5 0 0 0 .3-7A5.5 5.5 0 0 0 7.5 7.2 3 3 0 0 0 7 13zM4 17h16M6 21h12',
  rain: 'M7 15h10.5a3.5 3.5 0 0 0 .3-7A5.5 5.5 0 0 0 7.5 9.2 3 3 0 0 0 7 15zM8 18l-1 3M12 18l-1 3M16 18l-1 3',
  snow: 'M7 14h10.5a3.5 3.5 0 0 0 .3-7A5.5 5.5 0 0 0 7.5 8.2 3 3 0 0 0 7 14zM8 18v.01M12 20v.01M16 18v.01M10 22v.01M14 22v.01',
  storm: 'M7 14h10.5a3.5 3.5 0 0 0 .3-7A5.5 5.5 0 0 0 7.5 8.2 3 3 0 0 0 7 14zM12.5 15l-2 3.5h3l-2 3.5',
  // настройки
  general: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM10 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  voice: 'M4 9v6h4l5 4V5L8 9H4zM16.5 8.5a5 5 0 0 1 0 7',
  hearing: 'M9 3h6v11H9zM5 11a7 7 0 0 0 14 0M12 18v3',
  models: 'M6 6h12v12H6zM10 10h4v4h-4zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
  skills: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  advanced: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  components: 'M12 3l9 5v8l-9 5-9-5V8l9-5zM3 8l9 5 9-5M12 13v8',
  about: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7v1',
  library: 'M4 4h4v16H4zM10 4h4v16h-4zM16.5 4.5l3.8 1-4 15-3.8-1z',
  connections: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8zM12 17v4',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  className = '',
  fill = false,
}: {
  name: IconName;
  size?: number;
  className?: string;
  fill?: boolean;
}) {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="square"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
