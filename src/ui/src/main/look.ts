// Как состояние разговора выглядит: цвет куба и голограммы, скорость вращения, метка
import type { Tone } from '../kit/Cube.tsx';
import type { CoreState } from './controller.ts';

export function toneOf(core: CoreState): Tone {
  if (core === 'listening' || core === 'hearing') return 'mint';
  if (core === 'thinking') return 'violet';
  if (core === 'ask' || core === 'error') return 'amber';
  if (core === 'off') return 'grey';
  return 'teal';
}

export function spinOf(core: CoreState): number {
  if (core === 'thinking') return 1.2;
  if (core === 'hearing') return 2;
  if (core === 'listening' || core === 'speaking') return 4;
  if (core === 'off') return 40;
  return 9;
}

export function tagOf(core: CoreState, follow: boolean): string {
  switch (core) {
    case 'listening':
      return follow ? '● Говорите — без имени' : '● Слушаю';
    case 'hearing':
      return '● Распознаю';
    case 'thinking':
      return '◇ Думаю';
    case 'speaking':
      return '◆ Отвечаю';
    case 'ask':
      return '? Нужно подтверждение';
    case 'error':
      return '! Не получилось';
    case 'off':
      return 'Микрофон выключен';
    default:
      return '◆ Готов';
  }
}
