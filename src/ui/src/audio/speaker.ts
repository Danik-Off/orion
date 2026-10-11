// Озвучка: предложения синтезируются по одному и ставятся в очередь — первое звучит почти сразу.
// Свой голос (Supertonic в main) или, пока его нет, системный.
import { api } from '../bridge.ts';
import { quietLevel } from './chime.ts';

export interface SpeechStream {
  push(text: string): void;
  end(): void;
}
export interface Speaker {
  speak(text: string): void;
  stream(): SpeechStream;
  stop(): void;
  dispose(): void; // замолчать и освободить звук (голос сменили — создан новый)
}

// Конец предложения — знак, пробел и заглавная (цифра, кавычка): «26.09.2026», «84.34», «т. е. это» не режем —
// нормализатор речи должен увидеть дату или сокращение целиком. Точка после инициала или короткого
// сокращения («А. С. Пушкин», «г. Казань», «ул. Ленина») — тоже не конец.
export const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?…]["»)]*)(?<!(?:^|[^\p{L}])(?:\p{L}|ул|пр|проф|им|ст|стр|рис|тел|кв|обл|ок|см|рт|напр)\.)\s+(?=[«"(]?[А-ЯЁA-Z\d])/u)
    .map((s) => s.trim())
    .filter(Boolean);

// Первое предложение — до первой запятой: время синтеза растёт с длиной фразы, а остаток синтезируется,
// пока звучит начало
const FIRST_CHUNK_MIN = 40;
export function splitFirst(sentence: string): string[] {
  if (sentence.length < FIRST_CHUNK_MIN) return [sentence];
  const at = sentence.slice(12, -12).search(/[,;:—–]\s/);
  if (at < 0) return [sentence];
  const cut = 12 + at + 1;
  return [sentence.slice(0, cut).trim(), sentence.slice(cut).trim()];
}

// Паузы между кусками: после конца предложения — как в живой речи, после запятой — короткая
const pauseAfter = (text: string): number => (/[.!?…]["»)]*$/.test(text) ? 0.3 : 0.08);

export function createSpeaker({ ownVoice, onStart, onEnd }: { ownVoice: boolean; onStart: () => void; onEnd: () => void }): Speaker {
  let ctx: AudioContext | null = null;
  let generation = 0;
  let sources: AudioBufferSourceNode[] = [];
  let endAt = 0; // когда закончится уже поставленный в очередь звук

  function stop() {
    generation++;
    endAt = 0;
    for (const s of sources) {
      try {
        s.stop();
      } catch {
        // уже отзвучал
      }
    }
    sources = [];
    speechSynthesis.cancel();
  }

  // Поток речи: предложения дописываются по мере готовности (модель ещё пишет), звучат подряд.
  // onEnd — только когда поток закрыт и отзвучало последнее предложение
  function stream(): SpeechStream {
    stop();
    const my = generation;
    const queue: string[] = [];
    let closed = false;
    let wake: (() => void) | null = null;
    let started = false;
    let playing = 0;
    let working = false;
    let finished = false;
    let pushed = false;
    const done = () => {
      if (finished || my !== generation || !closed || queue.length || playing || working) return;
      finished = true;
      onEnd();
    };
    const began = () => {
      if (!started) {
        started = true;
        onStart();
      }
    };

    void (async () => {
      for (;;) {
        if (my !== generation) return;
        if (!queue.length) {
          if (closed) break;
          await new Promise<void>((r) => (wake = r));
          continue;
        }
        const sentence = queue.shift()!;
        working = true;
        if (!ownVoice) {
          const u = new SpeechSynthesisUtterance(sentence);
          u.lang = 'ru-RU';
          u.volume = quietLevel();
          const ru = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('ru'));
          u.voice = ru.find((v) => /pavel|dmitry/i.test(v.name)) || ru[0] || null;
          playing++;
          u.onstart = began;
          u.onend = u.onerror = () => {
            playing--;
            done();
          };
          speechSynthesis.speak(u);
          working = false;
          continue;
        }
        ctx ??= new AudioContext();
        const audio = await api().synth(sentence);
        working = false;
        if (my !== generation) return;
        if (!audio?.samples?.length) continue;
        const buf = ctx.createBuffer(1, audio.samples.length, audio.sampleRate);
        buf.copyToChannel(audio.samples as Float32Array<ArrayBuffer>, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const gain = ctx.createGain();
        gain.gain.value = quietLevel();
        src.connect(gain).connect(ctx.destination);
        began();
        endAt = Math.max(endAt, ctx.currentTime + 0.02);
        src.start(endAt);
        endAt += buf.duration + pauseAfter(sentence);
        sources.push(src);
        playing++;
        src.onended = () => {
          playing--;
          done();
        };
      }
      done();
    })();

    return {
      push(text: string) {
        if (closed || my !== generation) return;
        const parts = sentences(String(text || ''));
        if (!pushed && parts.length) parts.splice(0, 1, ...splitFirst(parts[0]));
        pushed ||= parts.length > 0;
        queue.push(...parts);
        wake?.();
        wake = null;
      },
      end() {
        closed = true;
        wake?.();
        wake = null;
        done();
      },
    };
  }

  function speak(text: string) {
    const s = stream();
    s.push(text);
    s.end();
  }

  function dispose() {
    stop();
    void ctx?.close().catch(() => {});
    ctx = null;
  }

  return { speak, stream, stop, dispose };
}
