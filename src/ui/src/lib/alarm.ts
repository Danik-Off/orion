// Будильник: звенит (или включает радио), пока человек не выключит.
//   - громкость нарастает: сначала тихо, через минуту — в полную силу;
//   - выключить — кнопкой или голосом БЕЗ имени («стоп», «встаю», «проснулся»): спросонья «Орион» никто не скажет;
//     «ещё 5 минут», «отложи», «дай поспать» — позвонит снова через столько минут (по умолчанию 10);
//   - сам смолкает через 15 минут, чтобы не звенеть весь день в пустой квартире.
// Без DOM: кнопки рисует окно по onChange; звук — через переданные radio и chime (в тестах — заглушки).
import type { AlarmMsg, Station } from '../bridge.ts';

export const ALARM_STOP =
  /^(стоп|хватит|выключи|выключай|отключи|встаю|встал|встала|проснулся|проснулась|я встал|я проснулся|все|всё|ладно|тихо)( будильник| его)?$/;
export const ALARM_SNOOZE = /(ещ[её]|отложи|дай поспать|разбуди позже|попозже|через)/;
const RING_FOR_MS = 15 * 60_000;

export function snoozeMinutes(text: string): number {
  const words: Record<string, number> = {
    одну: 1,
    две: 2,
    три: 3,
    пять: 5,
    десять: 10,
    пятнадцать: 15,
    двадцать: 20,
    тридцать: 30,
    полчаса: 30,
  };
  const digits = String(text).match(/\d+/);
  if (digits) return Number(digits[0]);
  for (const [w, n] of Object.entries(words)) if (new RegExp(`(^|\\s)${w}(\\s|$)`).test(text)) return n;
  return 10;
}

export interface AlarmPayload {
  id?: number;
  label?: string;
  radio?: string;
}
export interface Alarm {
  ring(msg: AlarmMsg): void;
  stop(opts?: { silent?: boolean }): boolean;
  snooze(minutes?: number): boolean;
  heard(text: string): boolean;
  ringing(): boolean;
  label(): string;
}

export function createAlarm({
  radio,
  chime,
  onSnooze = () => {},
  onChange = () => {},
}: {
  radio: { play(s: Station): unknown; stop(): void; setVolume(v: number): void };
  chime: (volume: number) => void;
  onSnooze?: (payload: AlarmPayload, minutes: number) => void;
  onChange?: (ringing: boolean) => void;
}): Alarm {
  let current: {
    payload: AlarmPayload;
    started: number;
    chime?: ReturnType<typeof setInterval>;
    timer?: ReturnType<typeof setTimeout>;
  } | null = null;

  function ring(msg: AlarmMsg) {
    stop({ silent: true });
    const payload = { id: msg.id, label: msg.label || 'Будильник', radio: msg.radio };
    const now = { payload, started: Date.now() } as NonNullable<typeof current>;
    current = now;
    if (msg.station?.url) {
      // Радио с нарастанием громкости
      radio.setVolume(0.15);
      radio.play(msg.station);
      now.chime = setInterval(() => radio.setVolume(Math.min(0.9, 0.15 + ((Date.now() - now.started) / 60_000) * 0.75)), 2000);
    } else {
      // Сигнал: каждые 1,5 с, громче с каждой минутой
      const beep = () => chime(Math.min(1, 0.25 + (Date.now() - now.started) / 60_000));
      beep();
      now.chime = setInterval(beep, 1500);
    }
    now.timer = setTimeout(() => stop(), RING_FOR_MS);
    onChange(true);
  }

  function stop({ silent = false } = {}) {
    if (!current) return false;
    clearInterval(current.chime);
    clearTimeout(current.timer);
    if (current.payload.radio) radio.stop();
    current = null;
    if (!silent) onChange(false);
    return true;
  }

  function snooze(minutes = 10) {
    if (!current) return false;
    const payload = current.payload;
    stop();
    onSnooze(payload, minutes);
    return true;
  }

  // Фраза, пока звенит: выключить или отложить → true (фраза — для будильника, дальше её не разбирать)
  function heard(text: string) {
    if (!current) return false;
    const t = String(text)
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/^орион\s+/, '')
      .trim();
    if (ALARM_SNOOZE.test(t)) return snooze(snoozeMinutes(t));
    if (ALARM_STOP.test(t) || /выключи будильник|отключи будильник/.test(t)) return stop();
    return false;
  }

  return { ring, stop, snooze, heard, ringing: () => !!current, label: () => current?.payload.label || '' };
}
