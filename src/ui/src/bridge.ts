// Мост к ядру (src/preload.js → window.jarvis) с типами. Единственный путь окон к системе: Node.js в окнах нет.

export type Mode = 'full' | 'orb' | 'cube' | 'hidden';
export type Source = 'text' | 'wake' | 'hotkey' | 'followup' | 'followup-voice';

export interface Person {
  id: string;
  name: string;
  honorific: string;
  threshold?: number;
  samples?: number;
}
export interface Voices {
  available: boolean;
  people: Person[];
  require: 'off' | 'followup' | 'always';
  last?: { score: number; name?: string; match: boolean } | null;
}
export interface VoiceMatch {
  match?: boolean;
  ambiguous?: boolean;
  candidates?: string[];
  person?: { id: string };
}
export interface Heard {
  partial?: string;
  final?: string;
  command: string | null;
  voice: VoiceMatch | null;
}

export interface WeatherDay {
  label: string;
  min: number;
  max: number;
  icon: string;
  desc?: string;
  rain?: number | null;
}
export interface WeatherCardData {
  type: 'weather';
  city: string;
  now?: { temp: number; feels: number | null; desc: string; icon: string; wind: number | null };
  days?: WeatherDay[];
}
export interface TimerCardData {
  type: 'timer';
  id: string;
  kind: 'timer' | 'reminder' | 'alarm';
  at: number;
  label: string;
  repeat?: string;
}
export type CardData = WeatherCardData | TimerCardData;
export interface LinkSource {
  title?: string;
  url: string;
}

export interface AskResult {
  say?: string;
  error?: boolean;
  cancelled?: boolean;
  ignored?: boolean;
  silent?: boolean;
  streamed?: boolean;
  noFollowUp?: boolean;
  sources?: LinkSource[];
  cards?: CardData[];
  person?: string | null;
  speakerLabel?: string;
}

export interface AppSettings {
  name: string;
  model: string;
  version: string;
  hotkey: string;
  stt: boolean;
  tts: boolean;
  listenOnStart: boolean;
  followUpSeconds: number;
  echoCancellation: boolean;
  night: { enabled: boolean; from: number; to: number; volume: number } | null;
  ui?: { cube?: boolean; calm?: boolean };
  speaker: Voices;
  mode: Mode;
  pinned: boolean;
}

export interface SetupEvent {
  stage?: string;
  title?: string;
  progress?: number;
  done?: boolean;
  error?: boolean | string;
  finished?: boolean;
  ready?: string;
  stages?: string[];
  needOllama?: boolean;
}
export interface Station {
  name: string;
  url: string;
}
export interface RadioMsg {
  action?: 'play' | 'stop' | 'pause' | 'resume' | 'volume';
  station?: Station;
  volume?: number;
}
export interface AlarmMsg {
  id?: number;
  label?: string;
  radio?: string;
  station?: Station | null;
}
export interface PlayerState {
  playing?: boolean;
  active?: boolean;
  name?: string;
  song?: string;
  volume?: number;
}

// Окна получают только то, что им нужно; остальные методы — any, как пришли из ядра
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Jarvis {
  ask(text: string, source: Source, personId?: string | null, streamId?: number): Promise<AskResult>;
  onSayPart(cb: (p: { id: number; text: string }) => void): void;
  onFiller(cb: (p: { id: number; text: string }) => void): void;
  openLink(url: string): Promise<unknown>;
  settings(): Promise<AppSettings | null>;
  settingsGet(): Promise<any>;
  settingsSave(patch: Record<string, unknown>): Promise<{ ok: boolean; restart?: boolean; error?: string }>;
  restart(): void;
  backupExport(): Promise<any>;
  backupImport(): Promise<any>;
  openSettings(page?: string): void;
  onSettingsPage(cb: (page: string) => void): void;
  previewVoice(): void;
  onPreviewVoice(cb: () => void): void;
  onSettingsChanged(cb: (patch: Record<string, any>) => void): void;
  replyConfirm(id: string, ok: boolean): void;
  reset(): void;
  cancel(): void;
  dialogEnd(): void;
  minimize(): void;
  pin(on: boolean): void;
  orbPassthrough(on: boolean): void;
  presence(mode: Mode | 'collapse'): void;
  orbHeight(h: number): void;
  onQuestion(cb: (msg: { id?: string; text?: string }) => void): void;
  replyQuestion(id: string, text: string | null): void;
  onEnrollOffer(cb: () => void): void;
  onConfirm(cb: (msg: { id: string; text: string }) => void): void;
  onStatus(cb: (text: string) => void): void;
  onFocus(cb: () => void): void;
  onMode(cb: (mode: Mode) => void): void;
  onSetup(cb: (r: SetupEvent) => void): () => void;
  onSetupOffer(cb: (r: { parts?: { title: string; size: string }[]; total?: string; ollama?: boolean }) => void): void;
  setupAnswer(ok: boolean): void;
  onBrainOffer(cb: (r: { size?: string }) => void): void;
  brainAnswer(answer: string): void;
  components(): Promise<any>;
  mcpList(): Promise<any>;
  mcpInstall(id: string, inputs: Record<string, string>): Promise<any>;
  mcpAdd(name: string, target: string): Promise<any>;
  mcpImport(text: string, name?: string): Promise<any>;
  mcpRemove(name: string): Promise<any>;
  mcpEnable(name: string, on: boolean): Promise<any>;
  mcpTrust(name: string, trust: boolean): Promise<any>;
  mcpTool(name: string, tool: string, on: boolean): Promise<any>;
  mcpCheck(name: string): Promise<any>;
  mcpUpdate(name: string): Promise<any>;
  modelsList(): Promise<any>;
  modelsDownload(id: string): Promise<any>;
  modelsLink(link: string): Promise<any>;
  modelsImport(): Promise<any>;
  modelsCancel(id: string): Promise<any>;
  modelsRemove(id: string): Promise<any>;
  modelsUse(id: string): Promise<any>;
  engineCheck(): Promise<any>;
  engineUpdate(): Promise<any>;
  engineRollback(): Promise<any>;
  onModelsChanged(cb: (data: any) => void): () => void;
  updatesList(): Promise<any>;
  updatesCheck(): Promise<any>;
  updatesApply(id: string): Promise<any>;
  updatesRollback(id: string): Promise<any>;
  onUpdatesChanged(cb: (data: any) => void): () => void;
  onMcpChanged(cb: (data: any) => void): () => void;
  installComponent(stage: string): Promise<any>;
  onUpdate(cb: (r: SetupEvent) => void): void;
  updateCheck(): Promise<any>;
  sendAudio(samples: Float32Array): void;
  micReset(): void;
  setListening(on: boolean): void;
  synth(text: string): Promise<{ samples: Float32Array; sampleRate: number } | null>;
  onAnnounce(cb: (text: string) => void): void;
  onAlarm(cb: (msg: AlarmMsg) => void): void;
  alarmSnooze(payload: { id?: number; label?: string; radio?: string }, minutes: number): void;
  onRadio(cb: (msg: RadioMsg) => void): void;
  radioState(state: { playing: boolean; active: boolean; name: string }): void;
  onRadioPlayer(cb: (s: PlayerState) => void): void;
  radioControl(action: string, value?: number): void;
  schedule(): Promise<TimerCardData[]>;
  scheduleCancel(id: string): void;
  onSchedule(cb: (list: TimerCardData[]) => void): void;
  onRemind(cb: (text: string) => void): void;
  onSessionEnd(cb: (reason: string) => void): void;
  onToggleMic(cb: () => void): void;
  onHeard(cb: (h: Heard) => void): void;
  people(): Promise<Voices | null>;
  enrollStart(): Promise<{ needed: number }>;
  enrollAdd(expected: string): Promise<{ error?: string; heard: string; count: number; done: boolean }>;
  enrollCancel(): Promise<unknown>;
  enrollFinish(data: { name: string; honorific: string; id?: string }): Promise<any>;
  personUpdate(id: string, patch: { name?: string; honorific?: string }): Promise<unknown>;
  personRemove(id: string): Promise<unknown>;
  wakeLearn(): Promise<{ added: string[]; heard: string; recognized: boolean }>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

declare global {
  interface Window {
    jarvis: Jarvis;
  }
}

export const api = (): Jarvis => window.jarvis;
