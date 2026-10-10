// Короткие сигналы: «слушаю» (два тона вверх), «разговор окончен» (вниз и тише), напоминание и будильник
// (четыре тона). И общая громкость ночного режима: голос и сигналы тише в заданные часы; будильник — нет.

let quiet: () => number = () => 1;
export const setQuiet = (fn: (() => number) | null): void => {
  quiet = typeof fn === 'function' ? fn : () => 1;
};
export const quietLevel = (): number => quiet();

export type ChimeKind = 'listen' | 'end' | 'alarm';

let ctx: AudioContext | null = null;
// volume — 0..1 (будильник нарастает)
export function playChime(kind: ChimeKind = 'listen', volume = 1): void {
  ctx ??= new AudioContext();
  const notes = kind === 'alarm' ? [880, 660, 880, 660] : kind === 'end' ? [990, 660] : [660, 990];
  const t0 = ctx.currentTime + 0.01;
  notes.forEach((freq, i) => {
    const osc = ctx!.createOscillator();
    const gain = ctx!.createGain();
    const t = t0 + i * 0.09;
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    const level = Math.max(0.05, Math.min(1, volume)) * (kind === 'alarm' ? 1 : quiet()) * (kind === 'end' ? 0.5 : 1);
    gain.gain.linearRampToValueAtTime(0.15 * level, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(gain).connect(ctx!.destination);
    osc.start(t);
    osc.stop(t + 0.13);
  });
}
