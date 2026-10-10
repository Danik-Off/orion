// Микрофон: куски по 100 мс (16 кГц) → распознавание в main. Звук дальше этого окна и main никуда не уходит.
import { api } from '../bridge.ts';

export interface Mic {
  start(): Promise<void>;
  stop(): void;
  pause(value: boolean): void;
  isOn(): boolean;
}

export function createMic({
  onChange,
  onLevel,
  echoCancellation = () => true,
}: {
  onChange: (on: boolean) => void;
  onLevel?: (rms: number) => void;
  echoCancellation?: () => boolean;
}): Mic {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let paused = false;

  async function start() {
    if (ctx) return;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: echoCancellation(), noiseSuppression: true, autoGainControl: true },
    });
    ctx = new AudioContext({ sampleRate: 16000 }); // Chromium сам пересэмплирует микрофон
    await ctx.audioWorklet.addModule('./mic-worklet.js');
    const node = new AudioWorkletNode(ctx, 'mic-chunker');
    node.port.onmessage = ({ data }) => {
      onLevel?.(data.rms);
      if (!paused) api().sendAudio(data.samples);
    };
    ctx.createMediaStreamSource(stream).connect(node);
    api().micReset();
    onChange(true);
  }

  function stop() {
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close();
    ctx = null;
    stream = null;
    onChange(false);
  }

  function pause(value: boolean) {
    if (paused === value) return;
    paused = value;
    if (!value) api().micReset();
  }

  return { start, stop, pause, isOn: () => !!ctx };
}
