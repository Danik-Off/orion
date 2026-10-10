// Голосовые команды самому Ориону, которые окно решает без модели. Чистые функции — проверяются тестами в Node.
import type { VoiceMatch, Voices } from '../bridge.ts';

// Перебить ответ или раздумье: «Орион, стоп», «Орион, хватит», «Орион, спасибо»
export const STOP_WORDS = /^(стоп|хватит|замолчи|тихо|помолчи|достаточно|спасибо|всё|все)$/;
// Закончить разговор, пока Орион ждёт продолжения: «стоп», «отбой», «не слушай» (без «спасибо» — на него он ответит)
const STOP_ALL = /^(стоп|хватит|замолчи|помолчи|тихо|отбой|не слушай|перестань слушать|можешь не слушать)$/;

const clean = (t: unknown): string =>
  String(t ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,!?…]+/g, '')
    .trim();

// «Стоп» относится к самому Ориону — он говорит, думает или ждёт продолжения разговора: замолчать, бросить
// запрос и перестать слушать (до следующего «Орион»). Иначе (Орион ничего не делает) «Орион, стоп» —
// обычная команда: например, пауза музыки.
//   command — текст после имени (null — имени не было); final — вся фраза; listening — окно ждёт фразу;
//   speaking / busy — Орион говорит / думает; dialogOpen — идёт разговор (ответил недавно)
export function isStopForOrion({
  command,
  final,
  listening = false,
  speaking = false,
  busy = false,
  dialogOpen = false,
}: {
  command?: string | null;
  final?: string;
  listening?: boolean;
  speaking?: boolean;
  busy?: boolean;
  dialogOpen?: boolean;
}): boolean {
  const byName = command !== null && command !== undefined;
  if (speaking || busy) return byName && STOP_WORDS.test(clean(command)); // посреди ответа слушаем только имя
  const said = clean(byName ? command : listening ? final : '');
  if (!said || !STOP_ALL.test(said)) return false;
  return dialogOpen || (!byName && listening);
}

// Пока модель думает, человек снова заговорил. Это договаривание той же фразы («поставь будильник… на семь»),
// только если начал почти сразу и коротко. Иначе это уже другой разговор — например, с кем-то в комнате:
// приклеенный к запросу, он портил ответ (журнал: к «роутер называется» прилипли 10 секунд чужой речи).
export const CONTINUE_WITHIN_MS = 1500;
const CONTINUE_MAX_WORDS = 12;
export function isContinuation({ askedAt, startedAt, text = '' }: { askedAt?: number; startedAt?: number | null; text?: string }): boolean {
  if (!Number.isFinite(askedAt) || !Number.isFinite(startedAt)) return false;
  if ((startedAt as number) - (askedAt as number) > CONTINUE_WITHIN_MS) return false;
  return clean(text).split(/\s+/).filter(Boolean).length <= CONTINUE_MAX_WORDS;
}

// Ответ на «Выключить компьютер? Скажите да или нет»: true / false / null — это не ответ.
// Ответ бывает и в конце фразы: «выключи компьютер через час, да». (\b не работает с кириллицей)
const YES = /^(да|ага|подтверждаю|конечно|давай|выполняй|ок|окей)(\s|$)/;
const NO = /^(нет|отмена|отмени|не надо|стоп)(\s|$)/;
const YES_END = /(^|\s)(да|ага|подтверждаю|конечно|давай|выполняй)$/;
const NO_END = /(^|\s)(нет|не надо|отмена)$/;
export function confirmAnswer(text: unknown): boolean | null {
  const t = clean(text);
  if (YES.test(t) || YES_END.test(t)) return true;
  if (NO.test(t) || NO_END.test(t)) return false;
  return null;
}

// «Э-э», «ну», «хм» — не команда
export const isInterjection = (text: unknown): boolean => /^(э+|а+|м+|ну|угу|хм+)$/.test(clean(text).replace(/-/g, ''));

// Кто говорит → id человека; null — голос чужой; undefined — не проверялось (нет записанных, слишком коротко).
// Два записанных голоса почти одинаково похожи: если один из них — текущий собеседник (talkingTo), это он
export function speakerOf(voice: VoiceMatch | null | undefined, talkingTo?: string | null): string | null | undefined {
  if (!voice) return undefined;
  if (voice.match) return voice.person?.id;
  if (voice.ambiguous) return talkingTo && voice.candidates?.includes(talkingTo) ? talkingTo : undefined;
  return null;
}

// Фразу без имени от другого человека считаем разговором не с Орионом.
// Неоднозначность между записанными людьми — не «чужой» (так ошибочно отсекались свои фразы).
//   talkingTo — id, null (гость) или undefined (разговора нет)
export function isStrangerVoice({
  voice,
  source,
  talkingTo,
  voices,
}: {
  voice: VoiceMatch | null | undefined;
  source: string;
  talkingTo?: string | null;
  voices: Pick<Voices, 'people' | 'require'> | null | undefined;
}): boolean {
  if (!voices?.people?.length || !voice || voice.ambiguous) return false;
  if (voices.require === 'always' && !voice.match) return true;
  if (source !== 'followup' || voices.require === 'off' || talkingTo === undefined) return false;
  // Продолжение без имени — только от того, кто начал разговор (гость — любой незнакомый голос)
  return talkingTo === null ? !!voice.match : !voice.match || voice.person?.id !== talkingTo;
}

// Пока играет радио или звук для сна, короткие команды — без имени (как «быстрые команды» Алисы).
// Только фраза целиком из списка — разговор в комнате («давай потише, ребёнок спит») командой не считается.
export type MediaCommand = 'stop' | 'pause' | 'resume' | 'next' | 'louder' | 'quieter';
const MEDIA_COMMANDS: [RegExp, MediaCommand][] = [
  [/^(стоп|хватит|выключи|выключай|выключи радио|выключи музыку|выключи шум|выруби)$/, 'stop'],
  [/^(пауза|поставь на паузу|подожди)$/, 'pause'],
  [/^(продолжи|продолжай|играй|включи обратно|сними с паузы)$/, 'resume'],
  [/^(дальше|следующая|следующую|другую станцию|другое радио|переключи)$/, 'next'],
  [/^(громче|погромче|сделай громче|сделай погромче)$/, 'louder'],
  [/^(тише|потише|сделай тише|сделай потише)$/, 'quieter'],
];
export function mediaCommand(text: unknown): MediaCommand | null {
  const t = clean(text)
    .replace(/^(пожалуйста|ну|давай) /, '')
    .replace(/ пожалуйста$/, '');
  return MEDIA_COMMANDS.find(([re]) => re.test(t))?.[1] || null;
}

// Ночной режим: доля громкости сейчас. Часы через полночь (23 → 7) — тоже
export interface Night {
  enabled?: boolean;
  from?: number;
  to?: number;
  volume?: number;
}
export function nightLevel(night: Night | null | undefined, hour = new Date().getHours()): number {
  if (!night?.enabled) return 1;
  const { from = 23, to = 7, volume = 0.4 } = night;
  const inside = from === to ? false : from < to ? hour >= from && hour < to : hour >= from || hour < to;
  return inside ? volume : 1;
}

// Подсказки на пустом экране — по времени суток: утром — сводка и новости, вечером и ночью — будильник,
// радио и звуки для сна. Каждая фраза должна выполняться и без большой модели (test/cards.test.js)
export const HINTS = {
  morning: ['Доброе утро', 'Какая погода?', 'Что нового в мире?', 'Включи радио', 'Поставь таймер на 10 минут'],
  day: ['Какая погода?', 'Почём доллар?', 'Включи музыку', 'Поставь таймер на 10 минут', 'Напомни через час размяться'],
  evening: ['Какая погода завтра?', 'Включи радио', 'Разбуди меня в семь', 'Что нового в мире?', 'Включи звуки дождя'],
  night: ['Разбуди меня в семь', 'Включи звуки дождя', 'Выключи компьютер через час', 'Какая погода завтра?', 'Сделай тише'],
};
export function hintsFor(hour: number): string[] {
  if (hour >= 5 && hour < 11) return HINTS.morning;
  if (hour >= 11 && hour < 18) return HINTS.day;
  if (hour >= 18 && hour < 23) return HINTS.evening;
  return HINTS.night;
}
