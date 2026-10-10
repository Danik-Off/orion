// Разговор: всё поведение окна Ориона без DOM — слушание после имени и клавиши, перебивание, договаривание
// фразы, пока модель думает, продолжение без имени, подтверждения и вопросы, будильник, радио без имени,
// голограмма в углу (появиться, повисеть, пока читают, уйти), запись голоса, установка компонентов.
// Экран рисует React по состоянию (getState/subscribe); звук и ядро приходят снаружи (deps) — в тестах заглушки.
import type {
  AskResult,
  AppSettings,
  CardData,
  Heard,
  Jarvis,
  LinkSource,
  Mode,
  SetupEvent,
  Source,
  TimerCardData,
  VoiceMatch,
  Voices,
} from '../bridge.ts';
import {
  confirmAnswer,
  hintsFor,
  isContinuation,
  isInterjection,
  isStopForOrion,
  isStrangerVoice,
  mediaCommand,
  nightLevel,
  speakerOf,
  type Night,
} from '../lib/commands.ts';
import { lingerMs, tailText } from '../lib/format.ts';
import { createAlarm, type Alarm } from '../lib/alarm.ts';
import type { Mic } from '../audio/mic.ts';
import type { Speaker, SpeechStream } from '../audio/speaker.ts';
import type { Radio } from '../audio/radio.ts';
import type { ChimeKind } from '../audio/chime.ts';

export type CoreState = 'off' | 'idle' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'error' | 'ask';
export type MsgKind = 'user' | 'bot' | 'error' | 'muted';
export interface Message {
  id: number;
  kind: MsgKind;
  text: string;
  who?: string;
  sources?: LinkSource[];
  cards?: CardData[];
  past?: boolean;
}
export interface PanelButton {
  label: string;
  primary?: boolean;
  run: (value: string) => void;
}
export interface PanelState {
  text: string;
  buttons: PanelButton[];
  field: { placeholder?: string; value?: string; onEnter?: (v: string) => void } | null;
  modal: boolean;
}
export interface SetupBar {
  title: string;
  progress: number;
  error: boolean;
  pending: boolean; // «Не установлено… нажмите, чтобы скачать»
}
export type HoloPhase = 'seed' | 'open' | 'closing';

export interface State {
  mode: Mode;
  core: CoreState;
  follow: { key: number; ms: number } | null; // «говорите без имени» — тающая полоска
  name: string;
  version: string;
  hotkey: string;
  stt: boolean;
  peopleAvailable: boolean;
  hasPeople: boolean;
  micOn: boolean;
  voiceOn: boolean;
  pinned: boolean;
  status: string;
  statusHint: boolean;
  caption: string;
  messages: Message[];
  hints: string[];
  showHints: boolean;
  panel: PanelState | null;
  confirm: { text: string } | null;
  holoCards: CardData[] | null;
  alarm: { label: string } | null;
  setup: SetupBar | null;
  schedule: TimerCardData[];
  inputBusy: boolean;
  focusInput: number; // увеличивается — поле ввода берёт фокус
  holo: HoloPhase;
  calm: boolean;
}

export interface Deps {
  api: Jarvis;
  createMic: (o: { onChange: (on: boolean) => void; onLevel?: (rms: number) => void; echoCancellation?: () => boolean }) => Mic;
  createSpeaker: (o: { ownVoice: boolean; onStart: () => void; onEnd: () => void }) => Speaker;
  createRadio: (o: { report: (s: { playing: boolean; active: boolean; name: string }) => void }) => Radio;
  playChime: (kind?: ChimeKind, volume?: number) => void;
  setQuiet: (fn: () => number) => void;
  setLevel?: (level: number) => void; // громкость голоса 0..1 — куб «дышит» (CSS-переменная, мимо React)
  hour?: () => number;
}

const LISTEN_MS = 8000; // сколько ждать НАЧАЛА фразы после «Орион» или горячей клавиши
const HOLD_MS = 2500;
const HOLO_OPEN_MS = 30;
const HOLO_CLOSE_MS = 320;
const tucked = (m: Mode) => m === 'hidden' || m === 'cube';

export function createConversation(deps: Deps) {
  const { api } = deps;
  const hour = deps.hour || (() => new Date().getHours());
  let msgSeq = 0;

  let state: State = {
    mode: 'full',
    core: 'off',
    follow: null,
    name: 'Орион',
    version: '',
    hotkey: '',
    stt: false,
    peopleAvailable: false,
    hasPeople: false,
    micOn: false,
    voiceOn: true,
    pinned: false,
    status: '',
    statusHint: false,
    caption: '',
    messages: [],
    hints: hintsFor(hour()),
    showHints: true,
    panel: null,
    confirm: null,
    holoCards: null,
    alarm: null,
    setup: null,
    schedule: [],
    inputBusy: false,
    focusInput: 0,
    holo: 'open',
    calm: false,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };

  // --- внутреннее состояние разговора (на экран не попадает) ---
  let followUpMs = 7000;
  let voices: Voices = { available: false, people: [], require: 'off' };
  let busy = false;
  let speaking = false;
  let hearing = false; // человек сейчас говорит (идут промежуточные результаты)
  let listenUntil = 0;
  let listenSource: Source = 'hotkey';
  let listenTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let holoTimer: ReturnType<typeof setTimeout> | undefined;
  let errorUntil = 0;
  let followUp = false;
  let pendingConfirm: string | null = null;
  let pendingQuestion: string | null = null;
  let talkingTo: string | null | undefined; // id человека, null — гость, undefined — разговора нет
  let ignoredInRow = 0;
  let wizard: Wizard | null = null;
  let installing = false;
  let setupOffer: { parts?: { title: string; size: string }[]; total?: string; ollama?: boolean } | null = null;
  let night: Night | null = null;
  let echoCancellation = true;
  let hovered = false;
  let level = 0;

  const awaitingAnswer = () => !!pendingConfirm || !!pendingQuestion;
  const isListening = () => Date.now() < listenUntil || hearing;
  const dialogActive = () => busy || speaking || isListening() || awaitingAnswer();

  const radio = deps.createRadio({ report: (s) => api.radioState(s) });
  const alarm: Alarm = createAlarm({
    radio,
    chime: (v) => deps.playChime('alarm', v),
    onSnooze: (payload, minutes) => {
      api.alarmSnooze(payload, minutes);
      setStatus(`Разбужу через ${minutes} мин.`);
    },
    onChange: (ringing) => {
      set({ alarm: ringing ? { label: alarm.label() } : null });
      if (ringing) {
        showOrbIfHidden();
        listen(60_000, 'followup'); // «стоп» и «ещё пять минут» — без имени
      }
      refreshState();
    },
  });

  // --- экранное состояние ---
  function refreshState() {
    let s: CoreState = mic.isOn() ? 'idle' : 'off';
    if (isListening() || wizard) s = hearing ? 'hearing' : 'listening';
    if (busy) s = 'thinking';
    if (speaking) s = 'speaking';
    if (pendingConfirm && !speaking) s = 'ask';
    if (Date.now() < errorUntil) s = 'error';
    const follow = isListening() && listenSource === 'followup' ? state.follow : null;
    set({ core: s, follow });
    radio.duck(s === 'listening' || s === 'hearing' || s === 'speaking');
  }
  const setStatus = (text: string, hint = false) => set({ status: text, statusHint: hint });
  const setCaption = (caption: string) => set({ caption });
  function flashError() {
    errorUntil = Date.now() + 1500;
    refreshState();
    setTimeout(refreshState, 1600);
  }

  function addMsg(kind: MsgKind, text: string, sources?: LinkSource[], cards?: CardData[]): number {
    const id = ++msgSeq;
    set({ messages: [...state.messages, { id, kind, text, sources, cards }], showHints: false });
    return id;
  }
  const updateMsg = (id: number, patch: Partial<Message>) =>
    set({ messages: state.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  function clearLog() {
    set({ messages: [], showHints: true, hints: hintsFor(hour()), holoCards: null });
  }

  // --- голограмма в углу: появиться из куба, повисеть, пока читают, уйти обратно ---
  function showOrbIfHidden() {
    cancelHoloClose();
    if (tucked(state.mode)) api.presence('orb');
    clearTimeout(hideTimer);
  }
  function hideWindow() {
    if (state.mode === 'full' && dialogActive()) return api.presence('collapse');
    api.presence('hidden');
  }
  function scheduleOrbHide() {
    clearTimeout(hideTimer);
    if (state.mode !== 'orb') return;
    hideTimer = setTimeout(() => {
      if (state.mode !== 'orb' || dialogActive()) return;
      if (hovered) return scheduleOrbHide(); // читают — ждём, пока мышь уйдёт
      closeHolo();
    }, lingerMs(state.caption));
  }
  function openHolo() {
    cancelHoloClose();
    set({ holo: 'seed' });
    holoTimer = setTimeout(() => set({ holo: 'open' }), HOLO_OPEN_MS);
  }
  function closeHolo() {
    if (state.holo === 'closing') return;
    set({ holo: 'closing' });
    clearTimeout(holoTimer);
    holoTimer = setTimeout(() => {
      // Считаем окно скрытым сразу, не дожидаясь ответа: иначе «Орион…», сказанное в этот момент, его не вызовет
      if (state.mode !== 'orb' || dialogActive()) return set({ holo: 'open' });
      set({ mode: 'hidden', holo: 'open' });
      api.presence('hidden');
    }, HOLO_CLOSE_MS);
  }
  function cancelHoloClose() {
    if (state.holo !== 'closing') return;
    clearTimeout(holoTimer);
    set({ holo: 'open' });
  }

  function onMode(m: Mode) {
    const was = state.mode;
    set({ mode: m });
    if (tucked(m)) clearLog(); // окно скрыто — в следующий раз с чистого экрана
    if (m === 'orb') {
      if (was !== 'orb') openHolo();
      scheduleOrbHide();
    }
  }

  // Распознаваемая фраза: в голограмме — её конец, в полном окне — целиком
  const showHeard = (text: string) => setCaption(state.mode === 'orb' ? tailText(text) : text);

  // --- микрофон и слушание ---
  const mic = deps.createMic({
    echoCancellation: () => echoCancellation,
    onChange: (on) => {
      set({ micOn: on });
      refreshState();
    },
    // Куб «дышит» вместе с голосом, но только когда Орион действительно слушает
    onLevel: (rms) => {
      const target = (isListening() || wizard) && !tucked(state.mode) ? Math.min(1, rms * 12) : 0;
      level = level * 0.5 + target * 0.5;
      deps.setLevel?.(level);
    },
  });
  // Микрофон не на паузе, пока Орион думает: человек может договаривать фразу. Пока говорит — слышит только имя
  const syncMic = () => mic.pause(false);
  const freshStart = () => api.micReset();

  function listen(ms: number, source: Source) {
    if (!isListening()) api.setListening(true); // ждём фразу — тихая речь не должна теряться
    listenUntil = Date.now() + ms;
    listenSource = source;
    if (source === 'followup') set({ follow: { key: (state.follow?.key || 0) + 1, ms } });
    clearTimeout(listenTimer);
    clearTimeout(hideTimer);
    listenTimer = setTimeout(checkListenEnd, ms);
    refreshState();
  }
  // Таймер ограничивает только ожидание начала фразы: пока человек говорит — ждём
  function checkListenEnd() {
    if (hearing) {
      listenTimer = setTimeout(checkListenEnd, 1000);
      return;
    }
    stopListening({ expired: true });
  }
  function endDialog() {
    talkingTo = undefined;
    ignoredInRow = 0;
    api.dialogEnd();
  }
  // «Орион, стоп»: замолчать, бросить запрос и перестать слушать
  function stopAll() {
    alarm.stop();
    followUp = false;
    if (busy) cancelThinking();
    interrupt({ end: true });
    endDialog();
    stopListening();
    setStatus('');
  }
  function stopListening({ expired = false } = {}) {
    if (expired && !busy) {
      endDialog();
      if (state.mode === 'orb') deps.playChime('end'); // разговор окончен — слышно, даже если не смотрят
    }
    if (!wizard) api.setListening(false);
    listenUntil = 0;
    hearing = false;
    clearTimeout(listenTimer);
    if (!busy && !speaking) setCaption('');
    refreshState();
    scheduleOrbHide();
  }
  async function toggleMic() {
    if (mic.isOn()) return mic.stop();
    try {
      await mic.start();
      syncMic();
    } catch (err) {
      addMsg('error', `Микрофон недоступен: ${(err as Error).message}`);
    }
  }

  const voiceId = (voice: VoiceMatch | null) => speakerOf(voice, talkingTo);
  const isStranger = (voice: VoiceMatch | null, source: string) => isStrangerVoice({ voice, source, talkingTo, voices });

  function onHeard({ partial, final, command, voice }: Heard) {
    if (wizard) {
      if (final) void wizardHeard(final);
      return;
    }
    // Ответ уже звучит по предложениям, а модель ещё пишет: слышим только своё имя
    if (busy && !speaking) return heardWhileThinking({ partial, final, command, voice });
    if (speaking) {
      // Перебивание: «Орион…» посреди ответа. Остальное (в т.ч. эхо собственного голоса) не слушаем
      if (command === null || !bargeIn) return;
      bargingIn = true;
      interrupt();
      if (busy) cancelThinking();
      bargingIn = false;
      if (partial) return listen(LISTEN_MS, 'wake');
      if (isStopForOrion({ command, speaking: true })) return stopAll();
      if (!command) return listen(LISTEN_MS, 'wake');
    }
    const listening = isListening();

    if (partial) {
      if (!listening && command === null) return; // разговор не с Орионом
      if (!listening) listen(LISTEN_MS, 'wake');
      hearing = true;
      showOrbIfHidden();
      showHeard(command || partial);
      refreshState();
      return;
    }
    if (!final) return;
    hearing = false;
    refreshState();

    // Звенит будильник: «стоп», «встаю», «ещё пять минут» — ему, без имени и от любого голоса
    if (alarm.ringing() && alarm.heard(final)) return refreshState();
    if (pendingQuestion && !isStranger(voice, 'followup')) return answerQuestion(command || final);
    if (pendingConfirm) {
      const answer = confirmAnswer(final);
      if (answer !== null && !isStranger(voice, 'followup')) return answerConfirm(answer);
    }
    if (isStopForOrion({ command, final, listening, dialogOpen: talkingTo !== undefined }) && !isStranger(voice, 'followup'))
      return stopAll();

    // Играет радио или звук для сна — «пауза», «стоп», «дальше», «громче» без имени
    if (command === null && !listening && radio.active() && !isStranger(voice, 'wake') && mediaWithoutName(final, voice)) return;
    if (command === null && !listening) return;
    const source: Source = command !== null ? 'wake' : listenSource;
    if (isStranger(voice, source)) {
      setCaption('');
      return refreshState();
    }
    if (command === '') {
      deps.playChime();
      showOrbIfHidden();
      return listen(LISTEN_MS, 'wake');
    }
    const text = command ?? final;
    if (isInterjection(text)) return;
    listenUntil = 0;
    clearTimeout(listenTimer);
    api.setListening(false);
    // Короткую фразу по голосу не проверить — в продолжении разговора считаем, что говорит тот же человек
    const personId = voice
      ? (voiceId(voice) ?? (source === 'followup' ? talkingTo : undefined))
      : source === 'followup'
        ? talkingTo
        : undefined;
    const sameVoice = source === 'followup' && voice && personId && personId === talkingTo;
    void submit(text, sameVoice ? 'followup-voice' : source, personId);
  }

  // Команда проигрывателю без имени. Чужой записанный голос — не командует
  function mediaWithoutName(final: string, voice: VoiceMatch | null) {
    const what = mediaCommand(final);
    if (!what || (what === 'next' && radio.sound())) return false;
    if (voices.people.length && voice && !voice.match && !voice.ambiguous) return false;
    deps.playChime();
    if (what === 'stop') radio.stop();
    else if (what === 'pause') radio.pause();
    else if (what === 'resume') radio.resume();
    else {
      const said = { next: 'включи другое радио', louder: 'сделай громче', quieter: 'сделай тише' }[what];
      void submit(said, 'wake', voiceId(voice));
    }
    refreshState();
    return true;
  }

  // Пока модель думает: договаривание той же фразы (сразу и коротко) или «Орион, …» — новая команда
  function heardWhileThinking({ partial, final, command, voice }: Heard) {
    if (!pending || pending.source === 'text') return;
    const p = pending;
    const byName = command !== null && command !== undefined;
    p.speechAt ??= Date.now();
    const continuing = () => isContinuation({ askedAt: p.at, startedAt: p.speechAt, text: partial || final });
    if (partial) {
      if (!byName && !continuing()) {
        hearing = false;
        if (held) releaseHeld();
        return;
      }
      hearing = true;
      showHeard(byName ? command || '…' : `${p.text} ${partial}`);
      return;
    }
    if (!final) return;
    hearing = false;
    const wasContinuation = continuing();
    p.speechAt = null;
    if (isStopForOrion({ command, busy: true })) return stopAll();
    if (byName && command) return void submit(command, 'wake', voiceId(voice), { replace: true });
    const id = voiceId(voice);
    const other = voices.people.length && voice && !voice.ambiguous && (p.personId ? id !== p.personId : voice.match);
    if (other || !wasContinuation || isInterjection(final) || byName) {
      setCaption(p.text);
      return releaseHeld();
    }
    void submit(`${p.text} ${final}`, p.source, p.personId, { replace: true });
  }

  // --- озвучка ---
  let bargeIn = true; // можно ли перебить именем (нельзя, если Орион сам произносит своё имя)
  let bargingIn = false;
  let interrupting = false;
  let previewing = false;
  let interim = false; // звучит заготовка «Сейчас поищу.», а ответ ещё готовится
  // Страховка: озвучка не сообщила, что закончила, — не висеть в «Отвечаю» вечно (15 с + 0,12 с на символ)
  let spoken = 0;
  let speakWatch: ReturnType<typeof setTimeout> | undefined;
  function watchSpeech(text = '') {
    spoken += String(text).length;
    clearTimeout(speakWatch);
    speakWatch = setTimeout(
      () => {
        if (!speaking) return;
        speaker.stop();
        hooks.onEnd();
      },
      15_000 + spoken * 120,
    );
  }
  const hooks = {
    onStart: () => {
      speaking = true;
      watchSpeech();
      showOrbIfHidden(); // окно могли скрыть, пока Орион думал, — ответ всё равно должен быть виден
      freshStart();
      syncMic();
      refreshState();
    },
    onEnd: () => {
      clearTimeout(speakWatch);
      spoken = 0;
      // Отзвучала заготовка, а ответ ещё готовится — не конец ответа и не конец диалога
      if (interim) {
        interim = false;
        if (busy) {
          speaking = false;
          freshStart();
          syncMic();
          return refreshState();
        }
      }
      speaking = false;
      if (!bargingIn) freshStart();
      syncMic();
      if (followUp && mic.isOn()) listen(followUpMs, 'followup');
      else {
        // Не ждёт продолжения — диалог окончен. Но если Ориона перебили, разговор продолжается
        if (!awaitingAnswer() && !bargingIn && !interrupting && !previewing) endDialog();
        scheduleOrbHide();
      }
      followUp = false;
      previewing = false;
      refreshState();
    },
  };
  let speaker = deps.createSpeaker({ ownVoice: false, ...hooks });
  deps.setQuiet(() => nightLevel(night));

  function speak(text: string, { expectReply = false } = {}) {
    interim = false;
    followUp = expectReply;
    bargeIn = !String(text).toLowerCase().includes(state.name.toLowerCase().slice(0, 4));
    spoken = 0;
    if (state.voiceOn && text) {
      watchSpeech(text);
      return speaker.speak(text);
    }
    hooks.onEnd();
  }
  // Замолчать. end — закончить и разговор (Esc, выключение звука); иначе он продолжается
  function interrupt({ end = false } = {}) {
    followUp = false;
    speaker.stop();
    interrupting = !end;
    if (speaking) hooks.onEnd();
    interrupting = false;
  }

  // --- запрос ---
  interface Pending {
    text: string;
    source: Source;
    personId?: string | null;
    msg: number | null;
    at: number;
    speechAt: number | null;
  }
  let pending: Pending | null = null;
  let askSeq = 0;
  let held: AskResult | null = null;
  let heldTimer: ReturnType<typeof setTimeout> | undefined;
  let live: { id: number; stream: SpeechStream | null; text: string; blocked: boolean } | null = null;

  function onFiller({ id, text }: { id: number; text: string }) {
    if (!live || id !== live.id || id !== askSeq || !busy || live.stream || !text) return;
    if (hearing || speaking || !state.voiceOn || wizard || awaitingAnswer()) return;
    bargeIn = true;
    interim = true;
    speaker.speak(text);
  }
  function onSayPart({ id, text }: { id: number; text: string }) {
    if (!live || id !== live.id || id !== askSeq || !busy || live.blocked || !text) return;
    if (!live.stream) {
      // Человек договаривает, звук выключен, ждём «да/нет» или идёт запись голоса — ответ прозвучит целиком в конце
      if (hearing || !state.voiceOn || wizard || awaitingAnswer()) {
        live.blocked = true;
        return;
      }
      followUp = false;
      bargeIn = true;
      interim = false;
      live.stream = speaker.stream();
      setStatus('');
    }
    if (text.toLowerCase().includes(state.name.toLowerCase().slice(0, 4))) bargeIn = false;
    live.text = live.text ? `${live.text} ${text}` : text;
    setCaption(live.text);
    watchSpeech(text);
    live.stream.push(text);
  }

  // replace — дополненная или новая фраза вместо запроса, над которым модель ещё думает
  async function submit(raw: string, source: Source = 'text', personId?: string | null, { replace = false } = {}) {
    const text = raw.trim();
    if (!text || (busy && !replace)) return;
    const my = ++askSeq;
    clearTimeout(heldTimer);
    held = null;
    busy = true;
    interrupt();
    syncMic();
    showOrbIfHidden();
    // Фразу без обращения показываем, только если модель сочтёт её адресованной Ориону
    let msg = replace && pending?.msg && !source.startsWith('followup') ? pending.msg : null;
    if (msg) updateMsg(msg, { text });
    else if (!source.startsWith('followup')) msg = addMsg('user', text);
    pending = { text, source, personId, msg, at: Date.now(), speechAt: null };
    set({ holoCards: null, caption: text, status: 'Думаю…', statusHint: false, inputBusy: true });
    refreshState();

    let r: AskResult;
    live = { id: my, stream: null, text: '', blocked: false };
    try {
      r = await api.ask(text, source, personId, my);
    } catch (err) {
      r = { say: String(err), error: true };
    }
    if (my !== askSeq) return; // фразу дополнили или перебили — этот ответ уже не нужен
    // Человек ещё договаривает — ответ ждёт (если уже зазвучал по предложениям, ждать нечего)
    if (hearing && source !== 'text' && !r.cancelled && !live?.stream) {
      held = r;
      const heldAt = Date.now();
      const wait = () => {
        if (hearing && Date.now() - heldAt < 5000) heldTimer = setTimeout(wait, 500);
        else releaseHeld();
      };
      heldTimer = setTimeout(wait, HOLD_MS);
      return;
    }
    finishAsk(r, text, source);
  }
  function cancelThinking() {
    if (!busy) return;
    askSeq += 1;
    clearTimeout(heldTimer);
    held = null;
    api.cancel();
    finishAsk({ cancelled: true }, pending?.text || '', pending?.source || 'text');
  }
  function releaseHeld() {
    clearTimeout(heldTimer);
    if (!held || !pending) return;
    const r = held;
    held = null;
    finishAsk(r, pending.text, pending.source);
  }
  function finishAsk(r: AskResult, text: string, source: Source) {
    const asked = pending?.msg ?? null;
    pending = null;
    const flow = live?.stream ? live : null;
    live = null;
    if (flow && (r.cancelled || r.ignored || r.error || !r.streamed)) interrupt();
    else if (interim && (r.cancelled || r.error)) interrupt();
    try {
      if (r.cancelled || r.ignored) setCaption('');
      else {
        talkingTo = r.person ?? null;
        const mine = source.startsWith('followup') ? addMsg('user', text) : asked;
        if (mine && r.speakerLabel) updateMsg(mine, { who: r.speakerLabel });
        addMsg(r.error ? 'error' : 'bot', r.say || '…', r.sources, r.cards);
        set({ holoCards: r.cards?.length ? r.cards : null, caption: r.say || '' });
        if (r.error) flashError();
      }
    } catch (err) {
      addMsg('error', String(err));
      flashError();
    } finally {
      busy = false;
      set({ status: '', inputBusy: false, focusInput: state.mode === 'full' ? state.focusInput + 1 : state.focusInput });
      syncMic();
      refreshState();
    }
    if (r.cancelled) return scheduleOrbHide();
    if (r.ignored) {
      // Фраза была не Ориону — дослушиваем, вдруг продолжат с ним; две подряд — разговор ушёл в сторону
      ignoredInRow += 1;
      if (ignoredInRow < 2 && mic.isOn() && talkingTo !== undefined) return listen(followUpMs, 'followup');
      endDialog();
      return scheduleOrbHide();
    }
    ignoredInRow = 0;
    if (flow && r.streamed) {
      followUp = !r.error && !r.noFollowUp;
      setCaption(r.say || flow.text);
      flow.stream!.end();
    } else if (!r.silent) speak(r.say || '', { expectReply: !r.error && !r.noFollowUp });
    else scheduleOrbHide();
  }

  // --- подтверждение и вопрос ---
  function answerConfirm(ok: boolean) {
    if (!pendingConfirm) return;
    api.replyConfirm(pendingConfirm, ok);
    pendingConfirm = null;
    set({ confirm: null });
    addMsg('muted', ok ? 'Подтверждено' : 'Отменено');
    stopListening();
  }
  function onConfirm({ id, text }: { id: string; text: string }) {
    pendingConfirm = id;
    set({ confirm: { text }, caption: text });
    speak(`${text} Скажите «да» или «нет».`, { expectReply: true });
  }
  function answerQuestion(text: string | null) {
    if (!pendingQuestion) return;
    const t = typeof text === 'string' ? text.trim() : '';
    api.replyQuestion(pendingQuestion, t || null);
    pendingQuestion = null;
    hidePanel();
    if (t) addMsg('user', t);
    stopListening();
  }
  function onQuestion({ id, text }: { id?: string; text?: string }) {
    if (!id) return;
    pendingQuestion = id;
    showPanel(
      text || '',
      [
        { label: 'Ответить', primary: true, run: (v) => answerQuestion(v) },
        { label: 'Пропустить', run: () => answerQuestion(null) },
      ],
      { placeholder: 'Ответ голосом или здесь', onEnter: (v) => answerQuestion(v) },
    );
    speak(text || '', { expectReply: true });
  }

  // --- панель ---
  function showPanel(text: string, buttons: PanelButton[], field: PanelState['field'] = null, { modal = false } = {}) {
    set({ panel: { text, buttons, field, modal } });
  }
  const hidePanel = () => set({ panel: null });

  // --- люди: запись голоса по четырём фразам, имя и обращение, настройка отклика на имя ---
  type Wizard =
    | {
        stage: 'phrases' | 'name' | 'honorific';
        step: number;
        needed: number;
        id?: string;
        heard: string[];
        phrases: string[];
        name?: string;
      }
    | { stage: 'wake'; step: number; needed: number; log: string[] };

  async function refreshPeople() {
    voices = (await api.people()) || voices;
    set({ hasPeople: voices.people.length > 0 });
  }
  function showPeople() {
    const list = voices.people
      .map((p) => `• ${p.name || 'без имени'} — «${p.honorific}», порог ${p.threshold}, образцов ${p.samples}`)
      .join('\n');
    const last = voices.last
      ? `\nПоследняя фраза: сходство ${voices.last.score} с «${voices.last.name || 'без имени'}» — ${voices.last.match ? 'узнан' : 'не узнан'}.`
      : '';
    const text = voices.people.length
      ? `Я узнаю по голосу:\n${list}${last}\n\nБез обращения по имени я продолжаю разговор только с тем, кто его начал. ` +
        'Если узнаю плохо — перезапишите голос: порог подстроится под ваш микрофон.'
      : 'Запишу ваш голос по четырём фразам и спрошу, как к вам обращаться. После этого я буду узнавать вас, ' +
        'обращаться «сэр» или «мисс», помнить именно ваше и не реагировать на чужие разговоры.';
    const buttons: PanelButton[] = [
      { label: voices.people.length ? 'Добавить человека' : 'Начать', primary: true, run: () => void startWizard() },
    ];
    buttons.push({ label: 'Настроить отклик на имя', run: () => void startWakeTuning() });
    for (const p of voices.people) buttons.push({ label: `Изменить: ${p.name || 'без имени'}`, run: () => editPerson(p) });
    buttons.push({ label: 'Закрыть', run: hidePanel });
    showPanel(text, buttons);
  }
  function editPerson(p: Voices['people'][number]) {
    const after = async (work: Promise<unknown>) => {
      await work;
      await refreshPeople();
      showPeople();
    };
    showPanel(
      `${p.name || 'Без имени'} — обращение «${p.honorific}».`,
      [
        { label: 'Сэр', run: () => void after(api.personUpdate(p.id, { honorific: 'сэр' })) },
        { label: 'Мисс', run: () => void after(api.personUpdate(p.id, { honorific: 'мисс' })) },
        { label: 'Переименовать', run: (value) => void after(api.personUpdate(p.id, { name: value })) },
        { label: 'Перезаписать голос', run: () => void startWizard(p) },
        {
          label: 'Удалить',
          run: () =>
            void after(
              api.personRemove(p.id).then(() => {
                if (talkingTo === p.id) talkingTo = undefined;
              }),
            ),
        },
        { label: 'Назад', run: showPeople },
      ],
      { placeholder: 'Новое имя', value: p.name },
    );
  }
  async function startWizard(existing?: { id: string }) {
    if (!mic.isOn()) await toggleMic();
    if (!mic.isOn()) return;
    interrupt({ end: true });
    const { needed } = await api.enrollStart();
    // Каждая фраза начинается с имени: заодно запоминаем, как распознаватель слышит ваше «Орион».
    // Распознанный текст сверяется с фразой — фон и чужая речь в образцы голоса не попадут
    const n = state.name;
    wizard = {
      stage: 'phrases',
      step: 0,
      needed,
      id: existing?.id,
      heard: [],
      phrases: [
        `${n}, какая сегодня погода и что у меня в планах?`,
        `${n}, включи, пожалуйста, какую-нибудь спокойную музыку.`,
        `${n}, напомни мне через десять минут проверить почту.`,
        `${n}, расскажи что-нибудь интересное про космос.`,
      ],
    };
    api.setListening(true);
    promptPhrase();
    refreshState();
  }
  function promptPhrase(note = '') {
    if (!wizard || wizard.stage === 'wake') return;
    const { step, needed, phrases, heard } = wizard;
    const done = heard.length ? `\n\nЗаписано: ${heard.map((h) => `«${h}» ✓`).join(' · ')}` : '';
    const tip = step ? '' : '\nГоворите так, как обычно обращаетесь ко мне, — с того места, где обычно сидите.';
    showPanel(`${note}Фраза ${step + 1} из ${needed}. Скажите обычным голосом:\n«${phrases[step]}»${tip}${done}`, [
      { label: 'Отмена', run: cancelWizard },
    ]);
  }
  function promptName() {
    if (!wizard || wizard.stage === 'wake') return;
    wizard.stage = 'name';
    speak('Как к вам обращаться?');
    showPanel(
      'Как к вам обращаться? Скажите имя или напишите его.',
      [
        { label: 'Дальше', primary: true, run: (value) => value?.trim() && promptHonorific(value.trim()) },
        { label: 'Отмена', run: cancelWizard },
      ],
      { placeholder: 'Имя', onEnter: (v) => v.trim() && promptHonorific(v.trim()) },
    );
  }
  function promptHonorific(personName: string) {
    if (!wizard || wizard.stage === 'wake') return;
    wizard.stage = 'honorific';
    wizard.name = personName;
    speak(`Приятно познакомиться, ${personName}. Обращаться к вам «сэр» или «мисс»?`);
    showPanel(`${personName}, обращаться к вам «сэр» или «мисс»?`, [
      { label: 'Сэр', primary: true, run: () => void finishWizard('сэр') },
      { label: 'Мисс', primary: true, run: () => void finishWizard('мисс') },
      { label: 'Отмена', run: cancelWizard },
    ]);
  }
  async function finishWizard(honorific: string) {
    if (!wizard || wizard.stage === 'wake') return;
    api.setListening(false);
    const person = await api.enrollFinish({ name: wizard.name || '', honorific, id: wizard.id });
    wizard = null;
    await refreshPeople();
    if (person?.id) talkingTo = person.id;
    const details: string[] = [];
    if (person?.threshold) details.push(`порог узнавания ${person.threshold}`);
    if (typeof person?.level === 'number' && typeof person?.noise === 'number')
      details.push(`голос громче фона на ${Math.round(person.level - person.noise)} дБ`);
    if (person?.gain) details.push(`усиление микрофона +${Math.round(person.gain)} дБ`);
    const similar = person?.similar
      ? `\n\nВаш голос очень похож на записанный голос «${person.similar.name || 'без имени'}». Если это тоже вы — удалите лишнюю запись в «Люди», иначе я буду вас путать.`
      : '';
    showPanel(
      `Готово, ${honorific} ${person?.name || ''}. Теперь я узнаю вас по голосу.`.replace(/\s+\./, '.') +
        (details.length ? `\n${details.join(', ')}.` : '') +
        similar,
      [{ label: 'Отлично', primary: true, run: hidePanel }],
    );
    speak(`Готово, ${honorific}. Теперь я узнаю вас по голосу.`);
    deps.playChime();
    refreshState();
  }
  async function startWakeTuning() {
    if (!mic.isOn()) await toggleMic();
    if (!mic.isOn()) return;
    interrupt();
    wizard = { stage: 'wake', step: 0, needed: 3, log: [] };
    api.setListening(true);
    promptWake();
    refreshState();
  }
  function promptWake(note = '') {
    if (!wizard || wizard.stage !== 'wake') return;
    const heard = wizard.log.length ? `\n\nУслышал: ${wizard.log.join(' · ')}` : '';
    showPanel(`${note}Скажите «${state.name}» — только имя, обычным голосом (${wizard.step + 1} из ${wizard.needed}).${heard}`, [
      { label: 'Готово', run: finishWakeTuning },
      { label: 'Отмена', run: cancelWizard },
    ]);
  }
  function finishWakeTuning() {
    api.setListening(false);
    const learned = wizard && wizard.stage === 'wake' ? wizard.log.filter((x) => x.includes('запомнил')).length : 0;
    wizard = null;
    showPanel(learned ? `Готово: запомнил, как слышу ваше «${state.name}».` : `Ваше «${state.name}» я и так слышу хорошо.`, [
      { label: 'Отлично', primary: true, run: hidePanel },
    ]);
    refreshState();
  }
  // Во время мастера всё услышанное — ответы мастеру
  async function wizardHeard(text: string) {
    const w = wizard;
    if (!w) return;
    if (w.stage === 'wake') {
      const r = await api.wakeLearn();
      if (wizard !== w) return;
      w.log.push(r.added.length ? `«${r.heard}» — запомнил` : r.recognized ? `«${r.heard}» — узнаю` : `«${r.heard}» — не похоже на имя`);
      w.step += 1;
      return w.step >= w.needed ? finishWakeTuning() : promptWake();
    }
    if (w.stage === 'phrases') {
      const r = await api.enrollAdd(w.phrases[w.step]);
      if (wizard !== w) return;
      if (r.error) return promptPhrase(`${r.error}.\n\n`);
      w.heard.push(r.heard);
      w.step = r.count;
      return r.done ? promptName() : promptPhrase();
    }
    if (w.stage === 'name') {
      // «меня зовут Саша» → «Саша»
      const n = text
        .replace(/^(меня зовут|зови меня|называй меня|я)\s+/i, '')
        .split(/\s+/)
        .slice(0, 2)
        .join(' ');
      return promptHonorific(n.charAt(0).toUpperCase() + n.slice(1));
    }
    if (w.stage === 'honorific') {
      if (/мисс|мэм|мадам|девуш|женщ/i.test(text)) return finishWizard('мисс');
      if (/сэр|сер|мужч|парен/i.test(text)) return finishWizard('сэр');
    }
  }
  function cancelWizard() {
    api.setListening(false);
    wizard = null;
    void api.enrollCancel();
    hidePanel();
    refreshState();
  }

  // --- настройки и установка ---
  function configureVoice(s: AppSettings) {
    night = s.night || null;
    followUpMs = (s.followUpSeconds || 7) * 1000;
    echoCancellation = s.echoCancellation;
    speaker = deps.createSpeaker({ ownVoice: s.tts, ...hooks });
  }
  async function applySettings() {
    const s = await api.settings();
    if (!s) return;
    voices = s.speaker;
    configureVoice(s);
    set({
      name: s.name,
      version: s.version || s.model,
      hotkey: s.hotkey,
      mode: s.mode,
      pinned: s.pinned === true,
      stt: s.stt,
      peopleAvailable: s.stt && voices.available,
      hasPeople: voices.people.length > 0,
      calm: s.ui?.calm === true,
    });
    if (s.stt && s.listenOnStart && !mic.isOn()) await toggleMic();
    if (!installing) {
      setStatus(
        s.stt ? `Скажите «${s.name}…» или нажмите ${s.hotkey.replace('CommandOrControl', 'Ctrl')}` : 'Голосовой ввод пока не установлен.',
        true,
      );
    }
    refreshState();
    return s;
  }
  async function onSetup(r: SetupEvent) {
    if (r.finished) {
      installing = false;
      const failed = !!state.setup?.error;
      if (!failed) set({ setup: null });
      await applySettings();
      if (failed) return;
      if (r.stages?.includes('brain'))
        return speak(
          'Готово, я стал умнее. Если захотите, могу подстраховываться внешней моделью — включите это в настройках, раздел «Модели».',
        );
      if (r.stages && !r.stages.includes('voice')) return;
      return speak(`Готов к работе. Скажите «${state.name}» — и я вас слушаю.`);
    }
    installing = true;
    const title = r.title
      ? r.progress != null && !r.done
        ? `${r.title} — ${Math.round(r.progress * 100)}%`
        : r.title
      : state.setup?.title || '';
    set({ setup: { title, progress: r.progress ?? (r.done ? 1 : 0), error: !!r.error, pending: false } });
    if (r.needOllama) {
      showPanel('Для работы мне нужен Ollama — программа, в которой живёт языковая модель. Установите её и перезапустите меня.', [
        { label: 'Скачать Ollama', primary: true, run: () => void api.openLink('https://ollama.com/download') },
        { label: 'Позже', run: hidePanel },
      ]);
    }
    if (r.ready === 'voice') {
      await applySettings();
      speak(
        `Я ${state.name}, ваш голосовой ассистент. Сейчас готовлюсь к работе: устанавливаю слух и загружаю знания. Это займёт несколько минут.`,
      );
    }
    if (r.ready === 'hearing') await applySettings();
  }
  function showSetupOffer() {
    if (!setupOffer) return;
    const { parts = [], total, ollama } = setupOffer;
    const text = [
      `Для работы мне нужно скачать компоненты — всего около ${total}:`,
      ...parts.map((p) => `• ${p.title} — ${p.size}`),
      ollama ? '' : '\nВ настройках выбран движок Ollama — его нужно установить отдельно с ollama.com (или выберите встроенный).',
      '\nВсё работает на этом компьютере, без облака. Скачать сейчас?',
    ].filter(Boolean);
    const buttons: PanelButton[] = [
      {
        label: `Скачать (${total})`,
        primary: true,
        run: () => {
          hidePanel();
          setupOffer = null;
          api.setupAnswer(true);
        },
      },
    ];
    if (!ollama) buttons.push({ label: 'Скачать Ollama', run: () => void api.openLink('https://ollama.com/download') });
    buttons.push({
      label: 'Позже',
      run: () => {
        hidePanel();
        set({ setup: { title: `Не установлено: ${total}. Нажмите, чтобы скачать`, progress: 0, error: false, pending: true } });
      },
    });
    showPanel(text.join('\n'), buttons, null, { modal: true });
  }
  function onBrainOffer({ size }: { size?: string }) {
    const text =
      `Я могу стать умнее: для этого нужно докачать ещё ${size} — большую языковую модель Qwen. ` +
      'Вместо неё можно подключить внешнюю модель: в Ollama или стороннюю по API. ' +
      'А после установки Qwen я по вашему желанию могу комбинировать локальную и удалённую модели.';
    const answer = (choice: string) => () => {
      hidePanel();
      api.brainAnswer(choice);
      if (choice === 'connect') api.openSettings('models');
    };
    showPanel(text, [
      { label: `Скачать (${size})`, primary: true, run: answer('download') },
      { label: 'Подключить внешнюю', run: answer('connect') },
      { label: 'Позже', run: answer('later') },
      { label: 'Не предлагать', run: answer('never') },
    ]);
    if (state.voiceOn && !busy && !speaking) speak(text);
  }
  function onUpdate(r: SetupEvent) {
    const title = r.progress != null && !r.done && !r.error ? `${r.title} — ${Math.round(r.progress * 100)}%` : r.title || '';
    set({ setup: { title, progress: r.progress ?? 0, error: !!r.error, pending: false } });
    if (r.done || r.error) setTimeout(() => !installing && set({ setup: null }), 6000);
  }

  // --- подписка на ядро ---
  function connect() {
    api.onAlarm((msg) => alarm.ring(msg));
    api.onRadio(({ action, station, volume }) => {
      if (action === 'play' && station?.url) {
        if (volume != null) radio.setVolume(volume);
        void radio.play(station);
      } else if (action === 'stop') radio.stop();
      else if (action === 'pause') radio.pause();
      else if (action === 'resume') radio.resume();
      else if (action === 'volume' && volume != null) radio.setVolume(volume);
    });
    api.onMode(onMode);
    api.onHeard(onHeard);
    api.onFiller(onFiller);
    api.onSayPart(onSayPart);
    api.onStatus((text) => setStatus(text));
    api.onConfirm(onConfirm);
    api.onQuestion(onQuestion);
    api.onEnrollOffer(() => !wizard && void startWizard());
    api.onAnnounce((text) => {
      addMsg('bot', text);
      setCaption(text);
      speak(text);
    });
    api.onRemind((text) => {
      addMsg('bot', `Напоминание: ${text}`);
      setCaption(`Напоминание: ${text}`);
      deps.playChime('alarm');
      setTimeout(() => speak(`Напоминаю: ${text}.`), 500);
    });
    // Разговор забыт (тишина, другой собеседник): на экране остаётся приглушённым. Фраза нового запроса — нет
    api.onSessionEnd(() => {
      const keep = busy ? pending?.msg : null;
      set({ messages: state.messages.map((m) => (m.id === keep ? m : { ...m, past: true })) });
    });
    api.onFocus(() => {
      cancelThinking();
      interrupt();
      set({ focusInput: state.focusInput + 1 });
      if (mic.isOn() && !wizard) {
        freshStart();
        deps.playChime();
        listen(LISTEN_MS, 'hotkey');
      }
    });
    api.onToggleMic(() => void toggleMic());
    api.onPreviewVoice(() => {
      if (busy || speaking) return;
      previewing = true;
      followUp = false;
      speaker.speak(`Здравствуйте, я ${state.name}. Так звучит мой голос.`);
    });
    api.onSettingsChanged((patch) => {
      for (const key of ['enabled', 'from', 'to', 'volume'] as const)
        if (`speech.night.${key}` in patch) night = { ...night, [key]: patch[`speech.night.${key}`] };
      if ('speech.followUpSeconds' in patch) followUpMs = patch['speech.followUpSeconds'] * 1000;
      if ('speech.speaker.require' in patch) voices = { ...voices, require: patch['speech.speaker.require'] };
      if ('ui.calm' in patch) set({ calm: patch['ui.calm'] === true });
      if ('speech.ttsSpeaker' in patch || 'speech.ttsSpeed' in patch) void applySettings();
    });
    api.onSetup((r) => void onSetup(r));
    api.onSetupOffer((offer) => {
      installing = true;
      setupOffer = offer;
      setStatus('Нужно скачать компоненты', true);
      showSetupOffer();
    });
    api.onBrainOffer(onBrainOffer);
    api.onUpdate(onUpdate);
    api.onSchedule((list) => set({ schedule: list }));
    api.schedule().then(
      (list) => set({ schedule: Array.isArray(list) ? list : [] }),
      () => {},
    );
    void applySettings();
  }

  // --- действия окна (кнопки, поле ввода, клавиши) ---
  const actions = {
    submitText(text: string) {
      if (pendingQuestion) return answerQuestion(text);
      void submit(text, 'text');
    },
    hint: (text: string) => void submit(text, 'text'),
    toggleMic: () => void toggleMic(),
    toggleVoice() {
      const on = !state.voiceOn;
      set({ voiceOn: on });
      if (!on) interrupt({ end: true });
    },
    reset() {
      api.reset();
      talkingTo = undefined;
      clearLog();
      setCaption('');
      setStatus('Начнём с чистого листа.', true);
    },
    pin(on: boolean) {
      set({ pinned: on });
      api.pin(on);
    },
    hide: hideWindow,
    minimize: () => api.minimize(),
    openSettings: (page?: string) => api.openSettings(page),
    async people() {
      if (wizard) return cancelWizard();
      if (state.panel) return hidePanel();
      await refreshPeople();
      showPeople();
    },
    // Клик по кубу — «говорите»; в голограмме — развернуть окно
    async core() {
      if (state.mode === 'orb') return api.presence('full');
      if (wizard) return;
      cancelThinking();
      interrupt();
      if (!mic.isOn()) await toggleMic();
      if (mic.isOn()) {
        freshStart();
        deps.playChime();
        listen(LISTEN_MS, 'hotkey');
      }
    },
    expand: () => api.presence('full'),
    closeHolo() {
      stopAll();
      closeHolo();
    },
    confirm: (ok: boolean) => answerConfirm(ok),
    alarmStop: () => alarm.stop(),
    alarmSnooze: () => alarm.snooze(10),
    setupClick: () => setupOffer && showSetupOffer(),
    cancelSchedule: (id: string) => api.scheduleCancel(id),
    openLink: (url: string) => void api.openLink(url),
    hover(on: boolean) {
      hovered = on;
    },
    // Esc: отменить раздумье → замолчать → закрыть панель → скрыть окно
    escape() {
      if (busy) return cancelThinking();
      if (speaking) return interrupt({ end: true });
      if (state.panel) return wizard ? cancelWizard() : hidePanel();
      hideWindow();
    },
  };

  return {
    getState: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    connect,
    actions,
    // Погасить все таймеры (окно закрывается; тесты)
    dispose() {
      for (const t of [listenTimer, hideTimer, holoTimer, heldTimer, speakWatch]) clearTimeout(t);
      alarm.stop({ silent: true });
      listeners.clear();
    },
    // Для тестов и скриншотов: подставить состояние экрана напрямую
    debugSet: set,
    debug: {
      addMsg,
      onHeard,
      onConfirm,
      busy: () => busy,
      speaking: () => speaking,
      listening: isListening,
    },
  };
}

export type Conversation = ReturnType<typeof createConversation>;
