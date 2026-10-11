// Время и числа для карточек, полоски «Запланировано» и голограммы. Чистые функции — проверяются в Node.

const pad2 = (n: number): string => String(n).padStart(2, '0');

// Сколько осталось: «0:42», «4:05», «1:02:30»; больше суток — «2 дн»
export function countdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 86_400) return `${Math.floor(s / 86_400)} дн`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

// Когда сработает: «в 07:30», «завтра в 07:30», «пт в 09:00», «12.10 в 09:00»
const SHORT_DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
export function whenLabel(at: number, now = Date.now()): string {
  const d = new Date(at);
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const diff = Math.round((day(at) - day(now)) / 86_400_000);
  if (diff <= 0) return `в ${clock}`;
  if (diff === 1) return `завтра в ${clock}`;
  if (diff < 7) return `${SHORT_DAYS[d.getDay()]} в ${clock}`;
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} в ${clock}`;
}

// Отсчёт виден до часа; дальше — время срабатывания (секунды до утра никому не нужны)
export const SHOW_COUNTDOWN_MS = 3_600_000;
export const timeText = (at: number, now = Date.now()): string =>
  at - now <= SHOW_COUNTDOWN_MS ? countdown(at - now) : whenLabel(at, now);

export const degreesText = (t: number): string => `${t > 0 ? '+' : ''}${t}°`;

// Голограмма висит, пока ответ читают: 4 с + 60 мс на символ, не дольше 15 с
export const lingerMs = (text: unknown): number => Math.min(15_000, 4000 + 60 * String(text || '').length);

// Распознаваемая фраза в голограмме — её конец: «…и поставь будильник на семь»
export function tailText(text: unknown, max = 70): string {
  const t = String(text || '');
  if (t.length <= max) return t;
  const cut = t.slice(-max);
  const space = cut.indexOf(' ');
  return `…${space > 0 && space < 15 ? cut.slice(space + 1) : cut}`;
}
