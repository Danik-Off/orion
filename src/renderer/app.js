/* global createCapsule, lingerMs, tailText, createMic, createSpeaker, playChime, setQuiet, nightLevel, isStopForOrion, isContinuation, hintsFor, renderCards, mediaCommand, confirmAnswer, isInterjection, speakerOf,
   isStrangerVoice, createRadio, createAlarm,
   showPanel, hidePanel, wizardHeard, cancelWizard, applySettings */
/* exported peopleBtn, configureVoice, showPinned */
// Окно разговора: состояние, слушание, озвучка и запрос. Рядом: panel.js — панель с кнопками,
// people.js — запись голоса и люди, setup-ui.js — старт, установка и обновления (подключаются после этого файла).
// Общее состояние (name, voices, wizard, speaker…) объявлено здесь, а меняется и там.
const $ = (s) => document.querySelector(s);
const core = $('#core');
const log = $('#log');
const input = $('#input');
const statusEl = $('#status');
const caption = $('#caption');
const hints = $('#hints');
const micBtn = $('#mic');
const voiceBtn = $('#voice');
const peopleBtn = $('#owner');
const panel = $('#panel');

const LISTEN_MS = 8000; // сколько ждать НАЧАЛА фразы после «Орион» или горячей клавиши
let followUpMs = 7000; // после ответа можно продолжать разговор без ключевого слова

// eslint-disable-next-line prefer-const -- меняется в people.js / setup-ui.js
let name = 'Орион';
// eslint-disable-next-line prefer-const -- меняется в people.js / setup-ui.js
let voices = { available: false, people: [], require: 'off' }; // записанные голоса
let mode = 'full';
let voiceOn = true;
let busy = false;
let speaking = false;
let hearing = false; // пользователь сейчас говорит (идут промежуточные результаты)
let listenUntil = 0;
let listenSource = 'hotkey'; // как открылось окно слушания: 'wake' | 'hotkey' | 'followup'
let listenTimer = null;
let hideTimer = null;
let errorUntil = 0;
let followUp = false;
let pendingConfirm = null;
let pendingQuestion = null; // вопрос со свободным ответом (знакомство: «в каком вы городе?»)
const awaitingAnswer = () => !!pendingConfirm || !!pendingQuestion;
let talkingTo; // с кем сейчас разговор: id человека, null — гость, undefined — разговора нет
let ignoredInRow = 0; // фразы подряд, которые модель сочла обращёнными не к Ориону
// eslint-disable-next-line prefer-const -- меняется в people.js / setup-ui.js
let wizard = null; // мастер записи голоса: { step, phrases, stage: 'phrases'|'name'|'honorific', name, id }

const isListening = () => Date.now() < listenUntil || hearing;

// Радио — в этом окне (src/renderer/radio.js); ядро говорит, что включить, окно сообщает, что играет
const radio = createRadio({ report: (state) => window.jarvis.radioState(state) });
// Будильник (src/renderer/alarm.js): звенит, пока не выключат; выключить — кнопкой или голосом без имени
const alarm = createAlarm({
  radio,
  panel: $('#alarm'),
  label: $('#alarm-label'),
  snoozeButton: $('#alarm-snooze'),
  stopButton: $('#alarm-stop'),
  onSnooze: (payload, minutes) => {
    window.jarvis.alarmSnooze(payload, minutes);
    setStatus(`Разбужу через ${minutes} мин.`);
  },
  onChange: (ringing) => {
    if (ringing) {
      showOrbIfHidden();
      listen(60_000, 'followup'); // «стоп» и «ещё пять минут» — без имени
    }
    refreshState();
  },
});
window.jarvis.onAlarm((msg) => alarm.ring(msg));

window.jarvis.onRadio(({ action, station, volume } = {}) => {
  if (action === 'play' && station?.url) {
    if (volume != null) radio.setVolume(volume);
    radio.play(station);
  } else if (action === 'stop') radio.stop();
  else if (action === 'pause') radio.pause();
  else if (action === 'resume') radio.resume();
  else if (action === 'volume') radio.setVolume(volume);
});

function refreshState() {
  let s = mic.isOn() ? 'idle' : 'off';
  // Ждёт команду — 'listening'; человек говорит и текст распознаётся — 'hearing' (выглядят по-разному)
  if (isListening() || wizard) s = hearing ? 'hearing' : 'listening';
  if (busy) s = 'thinking';
  if (speaking) s = 'speaking';
  if (Date.now() < errorUntil) s = 'error';
  core.dataset.state = s;
  if (!isListening() || listenSource !== 'followup') delete core.dataset.follow;
  // Радио тише, пока Орион слушает команду или говорит
  radio.duck(s === 'listening' || s === 'hearing' || s === 'speaking');
}

// Подсказка «Скажите …» видна только в полном окне, в плашке она лишняя
function setStatus(text, hint = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('hint', hint);
}

function flashError() {
  errorUntil = Date.now() + 1500;
  refreshState();
  setTimeout(refreshState, 1600);
}

// Подсказки на пустом экране — по времени суток; обновляются, когда экран снова пуст
function showHints() {
  hints.replaceChildren(
    ...hintsFor(new Date().getHours()).map((t) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = t;
      return b;
    }),
  );
  hints.hidden = false;
}
showHints();

// cards — карточки ответа (погода, таймер): cards.js
function addMsg(kind, text, sources, cards) {
  hints.hidden = true;
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  if (kind === 'user') el.dataset.who = 'Вы';
  el.textContent = text; // только textContent — никакого HTML от модели
  if (sources?.length) {
    const box = document.createElement('div');
    box.className = 'sources';
    for (const s of sources) {
      const a = document.createElement('a');
      a.href = '#';
      const label = document.createElement('span'); // многоточие работает только на обычном блоке, не на тексте во flex
      label.textContent = s.title || s.url;
      a.append(label);
      a.title = s.url;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        window.jarvis.openLink(s.url);
      });
      box.append(a);
    }
    el.append(box);
  }
  const extra = cards && renderCards(cards);
  if (extra) el.append(extra);
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

// Лента держится у нижнего края, пока её плавно поджимает выезжающая панель или подтверждение.
// Свою же прокрутку не учитываем: к её событию лента успевает ужаться ещё на кадр и «уходит» от низа
let logAtBottom = true;
let pinnedTop = -1;
log.addEventListener('scroll', () => {
  if (log.scrollTop !== pinnedTop) logAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 4;
});
new ResizeObserver(() => {
  if (!logAtBottom) return;
  log.scrollTop = log.scrollHeight;
  pinnedTop = log.scrollTop;
}).observe(log);

// --- Присутствие: полное окно / плашка в углу / скрыто -----------------------------

function showOrbIfHidden() {
  capsule.cancelClose(); // капсула как раз сжималась — передумала
  if (mode === 'hidden') window.jarvis.presence('orb');
  clearTimeout(hideTimer);
}

// Закрыть полное окно. Если диалог ещё идёт (думает, говорит, ждёт продолжения или ответа «да/нет»),
// окно сворачивается в плашку — иначе ответ пришёл бы в скрытое окно и его не было бы видно
const dialogActive = () => busy || speaking || isListening() || awaitingAnswer();
function hideWindow() {
  if (mode === 'full' && dialogActive()) return window.jarvis.presence('collapse');
  window.jarvis.presence('hidden');
}

// Капсула в углу (capsule.js): висит, пока ответ читают (дольше — для длинного), под мышью — не уходит;
// уходя, сжимается в кружок, затем окно прячется
function scheduleOrbHide() {
  clearTimeout(hideTimer);
  if (mode !== 'orb') return;
  hideTimer = setTimeout(() => {
    if (mode !== 'orb' || dialogActive()) return;
    if (capsule.hovered()) return scheduleOrbHide(); // читают — ждём, пока мышь уйдёт
    capsule.close();
  }, lingerMs(caption.textContent));
}

const capsule = createCapsule({
  mode: () => mode,
  // Считаем капсулу скрытой сразу, не дожидаясь ответа окна: иначе «Орион…», сказанное в этот момент,
  // не вызовет её снова (showOrbIfHidden видел бы ещё 'orb')
  onHidden: () => {
    if (mode !== 'orb' || dialogActive()) return;
    mode = 'hidden';
    window.jarvis.presence('hidden');
  },
  onStop: () => stopAll(), // крестик посреди разговора — как «Орион, стоп»
});

window.jarvis.onMode((m) => {
  const was = mode;
  mode = m;
  document.body.className = `mode-${m}`;
  if (m === 'hidden') clearLog(); // окно скрыто — следующий раз начинаем с чистого экрана
  if (m === 'orb') {
    if (was !== 'orb') capsule.open(); // из кружка — в капсулу
    scheduleOrbHide();
    requestAnimationFrame(capsule.report); // текст мог смениться, пока капсула была скрыта
  }
});

// Распознаваемая фраза: в капсуле — её конец (две строки), в полном окне — целиком
const showHeard = (text) => (caption.textContent = mode === 'orb' ? tailText(text) : text);

// --- Микрофон и слушание ----------------------------------------------------------

let level = 0;
let echoCancellation = true;
const mic = createMic({
  echoCancellation: () => echoCancellation,
  onChange: (on) => {
    micBtn.classList.toggle('on', on);
    micBtn.setAttribute('aria-pressed', String(on));
    micBtn.querySelector('use').setAttribute('href', on ? '#i-mic' : '#i-mic-off');
    refreshState();
  },
  // Реактор «дышит» вместе с голосом, но только когда Орион действительно слушает
  onLevel: (rms) => {
    const target = (isListening() || wizard) && mode !== 'hidden' ? Math.min(1, rms * 12) : 0;
    level = level * 0.5 + target * 0.5;
    document.documentElement.style.setProperty('--lvl', level.toFixed(3));
  },
});
// Микрофон не ставится на паузу, пока Орион думает: человек может договаривать фразу после паузы —
// тогда запрос отменяется и уходит целиком (раньше обрывок уходил модели, а конец фразы терялся).
// Пока Орион говорит — слушает, но реагирует только на своё имя (перебивание).
const syncMic = () => mic.pause(false);
// Начать фразу с чистого листа: сказанное до нажатия клавиши или собственный голос Ориона не попадут в команду
const freshStart = () => window.jarvis.micReset();

function listen(ms, source) {
  if (!isListening()) window.jarvis.setListening(true); // ждём фразу — тихая речь не должна теряться
  listenUntil = Date.now() + ms;
  listenSource = source;
  // Кольцо «говорите без имени» тает за то время, что слушаем продолжение (заново с каждым продолжением)
  delete core.dataset.follow;
  if (source === 'followup') {
    core.style.setProperty('--follow-ms', `${ms}ms`);
    void core.offsetWidth; // перезапуск анимации
    core.dataset.follow = '';
  }
  clearTimeout(listenTimer);
  clearTimeout(hideTimer);
  listenTimer = setTimeout(checkListenEnd, ms);
  refreshState();
}

// Таймер ограничивает только ожидание начала фразы: пока человек говорит — ждём.
function checkListenEnd() {
  if (hearing) {
    listenTimer = setTimeout(checkListenEnd, 1000);
    return;
  }
  stopListening({ expired: true });
}

// Диалог закончился: ядро перенесёт полезное в память и забудет реплики — следующий разговор с чистого листа
function endDialog() {
  talkingTo = undefined;
  ignoredInRow = 0;
  window.jarvis.dialogEnd();
}

// «Орион, стоп»: замолчать, бросить запрос и перестать слушать — разговор окончен, снова ждём имени
function stopAll() {
  alarm.stop(); // «Орион, стоп» выключает и будильник
  followUp = false;
  if (busy) cancelThinking();
  interrupt({ end: true });
  endDialog();
  stopListening();
  setStatus('');
}

function stopListening({ expired = false } = {}) {
  if (expired && !busy) {
    endDialog(); // перестал слушать, а новой фразы не было — контекст сбрасывается
    if (mode === 'orb') playChime('end'); // разговор окончен — слышно, даже если на капсулу не смотрят
  }
  if (!wizard) window.jarvis.setListening(false);
  listenUntil = 0;
  hearing = false;
  clearTimeout(listenTimer);
  if (!busy && !speaking) caption.textContent = '';
  refreshState();
  scheduleOrbHide();
}

async function toggleMic() {
  if (mic.isOn()) return mic.stop();
  try {
    await mic.start();
    syncMic();
  } catch (err) {
    addMsg('error', `Микрофон недоступен: ${err.message}`);
  }
}

// Кто говорит и чужой ли голос — speakerOf и isStrangerVoice в commands.js (с текущим собеседником)
const voiceId = (voice) => speakerOf(voice, talkingTo);
const isStranger = (voice, source) => isStrangerVoice({ voice, source, talkingTo, voices });

// STOP_WORDS и isStopForOrion — в commands.js

window.jarvis.onHeard(({ partial, final, command, voice }) => {
  if (wizard) return final && wizardHeard(final);
  // Ответ уже звучит по предложениям, хотя модель ещё пишет: это речь, а не раздумье —
  // слышим только своё имя (иначе собственный голос Ориона принялся бы за продолжение фразы)
  if (busy && !speaking) return heardWhileThinking({ partial, final, command, voice });
  if (speaking) {
    // Перебивание: «Орион…» посреди ответа. Остальное (в т.ч. эхо собственного голоса) не слушаем.
    if (command === null || !bargeIn) return;
    bargingIn = true; // не сбрасывать распознавание — команда ещё договаривается
    interrupt();
    if (busy) cancelThinking(); // модель ещё дописывала этот ответ — он больше не нужен
    bargingIn = false;
    if (partial) return listen(LISTEN_MS, 'wake');
    if (isStopForOrion({ command, speaking: true })) return stopAll(); // «Орион, стоп» — замолчать и не слушать
    if (!command) return listen(LISTEN_MS, 'wake'); // одно имя — перебил и ждёт команду
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
  refreshState(); // фраза договорена — реактор больше не в режиме распознавания

  // Звенит будильник: «стоп», «встаю», «ещё пять минут» — ему, без имени и от любого голоса
  if (alarm.ringing() && alarm.heard(final)) return refreshState();
  // Ждём ответ на вопрос («в каком вы городе?») — фраза и есть ответ (с именем — без него)
  if (pendingQuestion && !isStranger(voice, 'followup')) return answerQuestion(command || final);
  if (pendingConfirm) {
    const answer = confirmAnswer(final);
    if (answer !== null && !isStranger(voice, 'followup')) return answerConfirm(answer);
  }
  // «Стоп», пока ждёт продолжения разговора (с именем или без) — закончить разговор и не слушать
  if (isStopForOrion({ command, final, listening, dialogOpen: talkingTo !== undefined }) && !isStranger(voice, 'followup'))
    return stopAll();

  // Играет радио или звук для сна — «пауза», «стоп», «дальше», «громче» без имени (mediaCommand в commands.js)
  if (command === null && !listening && radio.active() && !isStranger(voice, 'wake') && mediaWithoutName(final, voice)) return;
  if (command === null && !listening) return;
  const source = command !== null ? 'wake' : listenSource;
  if (isStranger(voice, source)) {
    // Чужой голос: молча продолжаем ждать своего собеседника
    caption.textContent = '';
    return refreshState();
  }
  if (command === '') {
    playChime();
    showOrbIfHidden();
    return listen(LISTEN_MS, 'wake');
  }
  const text = command ?? final;
  if (isInterjection(text)) return; // междометия — не команда
  listenUntil = 0;
  clearTimeout(listenTimer);
  window.jarvis.setListening(false); // фраза получена — снова экономный режим
  // Короткую фразу по голосу не проверить — в продолжении разговора считаем, что говорит тот же человек
  const personId = voice
    ? (voiceId(voice) ?? (source === 'followup' ? talkingTo : undefined))
    : source === 'followup'
      ? talkingTo
      : undefined;
  // Продолжение, где голос подтверждён как тот же собеседник, — ядро не переспрашивает модель «это мне?»
  const sameVoice = source === 'followup' && voice && personId && personId === talkingTo;
  submit(text, sameVoice ? 'followup-voice' : source, personId);
});

// Команда проигрывателю без имени. Чужой записанный голос (кто-то другой в комнате) — не командует.
function mediaWithoutName(final, voice) {
  const what = mediaCommand(final);
  if (!what || (what === 'next' && radio.sound())) return false; // у шума дождя «следующего» нет
  if (voices.people.length && voice && !voice.match && !voice.ambiguous) return false;
  playChime();
  if (what === 'stop') radio.stop();
  else if (what === 'pause') radio.pause();
  else if (what === 'resume') radio.resume();
  else {
    const said = { next: 'включи другое радио', louder: 'сделай громче', quieter: 'сделай тише' }[what];
    submit(said, 'wake', voiceId(voice));
  }
  refreshState();
  return true;
}

// Пока модель думает над голосовой фразой, человек может:
//  • договорить её после короткой паузы — запрос отменяется, модель получает фразу целиком;
//  • сказать «Орион, …» — новая команда вместо старой.
// Посторонние голоса и эхо не мешают: дополнением считается только голос того же человека, начавший почти сразу
// и коротко (isContinuation) — долгий разговор в комнате не приклеивается к запросу и не задерживает ответ.
function heardWhileThinking({ partial, final, command, voice }) {
  if (!pending || pending.source === 'text') return;
  const byName = command !== null && command !== undefined;
  pending.speechAt ??= Date.now(); // когда зазвучала новая речь
  const continuing = () => isContinuation({ askedAt: pending.at, startedAt: pending.speechAt, text: partial || final });
  if (partial) {
    if (!byName && !continuing()) {
      hearing = false;
      if (held) releaseHeld(); // ждали договаривания — это не оно
      return;
    }
    hearing = true; // ответ, если придёт сейчас, подождёт конца фразы
    showHeard(byName ? command || '…' : `${pending.text} ${partial}`);
    return;
  }
  if (!final) return;
  hearing = false;
  const wasContinuation = continuing();
  pending.speechAt = null; // следующая речь — снова с отсчёта
  // «Орион, стоп» — бросить запрос, замолчать и не слушать
  if (isStopForOrion({ command, busy: true })) return stopAll();
  if (byName && command) return submit(command, 'wake', voiceId(voice), { replace: true });
  const id = voiceId(voice);
  const other = voices.people.length && voice && !voice.ambiguous && (pending.personId ? id !== pending.personId : voice.match);
  if (other || !wasContinuation || isInterjection(final) || byName) {
    caption.textContent = pending.text;
    return releaseHeld();
  }
  submit(`${pending.text} ${final}`, pending.source, pending.personId, { replace: true });
}

// --- Озвучка ----------------------------------------------------------------------

let bargeIn = true; // можно ли перебить именем (нельзя, если Орион сам произносит своё имя)
let bargingIn = false;

// Страховка: озвучка не сообщила, что закончила (сбой синтеза, звуковое устройство пропало), — не висеть
// в «Отвечаю» вечно (известная беда голосовых помощников). Срок — по длине сказанного: 15 с + 0,12 с на символ
let spoken = 0; // символов в текущем ответе
let speakWatch = null;
function watchSpeech(text = '') {
  spoken += String(text).length;
  clearTimeout(speakWatch);
  speakWatch = setTimeout(
    () => {
      if (!speaking) return;
      speaker.stop();
      speakerHooks.onEnd();
    },
    15_000 + spoken * 120,
  );
}

const speakerHooks = {
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
    // Отзвучала заготовка («Сейчас поищу.»), а ответ ещё готовится — это не конец ответа и не конец диалога
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
    if (!bargingIn) freshStart(); // собственный голос Ориона не должен попасть в следующую фразу
    syncMic();
    // Диалог: после ответа слушаем продолжение без ключевого слова
    if (followUp && mic.isOn()) listen(followUpMs, 'followup');
    else {
      // Ответ не ждёт продолжения — диалог окончен. Но если Ориона перебили (клавишей, именем, набранным
      // текстом), разговор продолжается: сброс контекста здесь терял смысл следующей фразы
      if (!awaitingAnswer() && !bargingIn && !interrupting && !previewing) endDialog();
      scheduleOrbHide();
    }
    followUp = false;
    previewing = false;
    refreshState();
  },
};
// Ночной режим (настройки → «Голос» → «Ночью»): тише голос и сигнал «слушаю»
let night = null;
setQuiet(() => nightLevel(night));
let speaker = createSpeaker({ ownVoice: false, ...speakerHooks });
// Настройки голоса из ядра (при старте и после установки): продолжение без имени, эхоподавление, свой голос
function configureVoice(s) {
  night = s.night || null;
  followUpMs = (s.followUpSeconds || 7) * 1000;
  echoCancellation = s.echoCancellation;
  speaker = createSpeaker({ ownVoice: s.tts, ...speakerHooks });
}
let previewing = false; // «Прослушать» в настройках — это не ответ, разговор не заканчивается

// --- Настройки — отдельное окно (settings/). Отсюда: открыть его, прослушать голос, применить изменения ---

$('#settings-btn').addEventListener('click', () => window.jarvis.openSettings());
// «Прослушать» в окне настроек: голос звучит здесь, где живёт синтез
window.jarvis.onPreviewVoice(() => {
  if (busy || speaking) return;
  previewing = true;
  followUp = false;
  speaker.speak(`Здравствуйте, я ${name}. Так звучит мой голос.`);
});
// Значения, которые окно держит у себя, — сразу; остальное читает ядро
window.jarvis.onSettingsChanged((patch) => {
  for (const key of ['enabled', 'from', 'to', 'volume'])
    if (`speech.night.${key}` in patch) night = { ...night, [key]: patch[`speech.night.${key}`] };
  if ('speech.followUpSeconds' in patch) followUpMs = patch['speech.followUpSeconds'] * 1000;
  if ('speech.speaker.require' in patch) voices.require = patch['speech.speaker.require'];
  if ('speech.ttsSpeaker' in patch || 'speech.ttsSpeed' in patch) applySettings();
});

function speak(text, { expectReply = false } = {}) {
  interim = false; // заготовку (если ещё звучит) сменяет настоящий ответ
  followUp = expectReply;
  bargeIn = !String(text).toLowerCase().includes(name.toLowerCase().slice(0, 4)); // «Меня зовут Орион» — не будить самого себя
  spoken = 0;
  if (voiceOn && text) return (watchSpeech(text), speaker.speak(text));
  speakerHooks.onEnd();
}

// Замолчать. end — закончить и разговор (Esc, выключение звука); иначе он продолжается
let interrupting = false;
function interrupt({ end = false } = {}) {
  followUp = false;
  speaker.stop();
  interrupting = !end;
  if (speaking) speakerHooks.onEnd();
  interrupting = false;
}

// --- Запрос -----------------------------------------------------------------------

// Запрос в работе: { text, source, personId, msg } — чтобы дополнить его, если человек договаривает
let pending = null;
let askSeq = 0;
let held = null; // готовый ответ, который ждёт, пока человек договорит
let heldTimer = null;
const HOLD_MS = 2500;
// Разговорный ответ, который звучит по предложениям, пока модель его дописывает: { id, stream, text, blocked }
let live = null;
let interim = false; // звучит заготовка «Сейчас поищу.», а сам ответ ещё готовится

// Медленный навык: сразу короткая фраза голосом. Не поверх речи человека и не вместо уже звучащего ответа
window.jarvis.onFiller(({ id, text }) => {
  if (!live || id !== live.id || id !== askSeq || !busy || live.stream || !text) return;
  if (hearing || speaking || !voiceOn || wizard || awaitingAnswer()) return;
  bargeIn = true;
  interim = true;
  speaker.speak(text);
});

window.jarvis.onSayPart(({ id, text }) => {
  if (!live || id !== live.id || id !== askSeq || !busy || live.blocked || !text) return;
  if (!live.stream) {
    // Человек ещё договаривает, звук выключен, ждём «да/нет» или идёт запись голоса — не начинаем:
    // ответ прозвучит целиком в конце, как обычно
    if (hearing || !voiceOn || wizard || awaitingAnswer()) {
      live.blocked = true;
      return;
    }
    followUp = false; // ждать ли продолжения — решится, когда ответ будет готов целиком
    bargeIn = true;
    interim = false; // заготовку сменяет сам ответ
    live.stream = speaker.stream();
    setStatus('');
  }
  if (text.toLowerCase().includes(name.toLowerCase().slice(0, 4))) bargeIn = false; // «я Орион» — не будить себя
  live.text = live.text ? `${live.text} ${text}` : text;
  caption.textContent = live.text;
  watchSpeech(text);
  live.stream.push(text);
});

// replace — дополненная или новая фраза вместо запроса, над которым модель ещё думает
async function submit(text, source = 'text', personId, { replace = false } = {}) {
  text = text.trim();
  if (!text || (busy && !replace)) return;
  const my = ++askSeq;
  clearTimeout(heldTimer);
  held = null;
  busy = true;
  interrupt();
  syncMic();
  showOrbIfHidden();
  input.disabled = true;
  // Фразу без обращения показываем, только если модель сочтёт её адресованной Ориону
  let msg = replace && pending?.msg && !source.startsWith('followup') ? pending.msg : null;
  if (msg) msg.textContent = text;
  else if (!source.startsWith('followup')) msg = addMsg('user', text);
  pending = { text, source, personId, msg, at: Date.now(), speechAt: null };
  capsule.clear(); // карточки прошлого ответа — не к этому вопросу
  caption.textContent = text;
  setStatus('Думаю…');
  refreshState();

  let r = null;
  live = { id: my, stream: null, text: '', blocked: false };
  try {
    r = await window.jarvis.ask(text, source, personId, my);
  } catch (err) {
    r = { say: String(err), error: true };
  }
  if (my !== askSeq) return; // фразу дополнили или перебили — этот ответ уже не нужен
  // Человек ещё говорит (договаривает после паузы) — ответ ждёт: сперва дослушать
  // (если ответ уже зазвучал по предложениям, ждать нечего)
  if (hearing && source !== 'text' && !r.cancelled && !live?.stream) {
    held = r;
    const heldAt = Date.now();
    const wait = () => (hearing && Date.now() - heldAt < 5000 ? (heldTimer = setTimeout(wait, 500)) : releaseHeld());
    heldTimer = setTimeout(wait, HOLD_MS);
    return;
  }
  finishAsk(r, text, source);
}

// Бросить запрос, над которым думает модель (клавиша, клик, «Орион, стоп», Esc)
function cancelThinking() {
  if (!busy) return;
  askSeq += 1;
  clearTimeout(heldTimer);
  held = null;
  window.jarvis.cancel();
  finishAsk({ cancelled: true }, pending?.text || '', pending?.source || 'text');
}

// Отложенный ответ: дослушали, но это было не дополнение (или человек замолчал)
function releaseHeld() {
  clearTimeout(heldTimer);
  if (!held || !pending) return;
  const r = held;
  held = null;
  finishAsk(r, pending.text, pending.source);
}

function finishAsk(r, text, source) {
  const asked = pending?.msg;
  pending = null;
  const flow = live?.stream ? live : null;
  live = null;
  // Ответ звучал по предложениям, но оказался не нужен (отмена, «не мне», ошибка) — замолчать
  if (flow && (r.cancelled || r.ignored || r.error || !r.streamed)) interrupt();
  else if (interim && (r.cancelled || r.error)) interrupt(); // заготовка «Сейчас поищу» к отменённому запросу
  try {
    if (r.cancelled) {
      caption.textContent = '';
    } else if (r.ignored) {
      caption.textContent = '';
    } else {
      talkingTo = r.person ?? null;
      const mine = source.startsWith('followup') ? addMsg('user', text) : asked;
      if (mine && r.speakerLabel) mine.dataset.who = r.speakerLabel; // кто говорил — по голосу
      addMsg(r.error ? 'error' : 'bot', r.say || '…', r.sources, r.cards);
      capsule.showCards(r.cards);
      caption.textContent = r.say || '';
      if (r.error) flashError();
    }
  } catch (err) {
    addMsg('error', String(err));
    flashError();
  } finally {
    busy = false;
    setStatus('');
    input.disabled = false;
    if (mode === 'full') input.focus();
    syncMic();
    refreshState();
  }
  if (r.cancelled) return scheduleOrbHide();
  if (r?.ignored) {
    // Фраза была не Ориону (разговор рядом) — это не конец диалога: дослушиваем, вдруг продолжат с ним.
    // Две такие фразы подряд — значит, разговор ушёл в сторону
    ignoredInRow += 1;
    if (ignoredInRow < 2 && mic.isOn() && talkingTo !== undefined) return listen(followUpMs, 'followup');
    return (endDialog(), scheduleOrbHide());
  }
  ignoredInRow = 0;
  if (flow && r.streamed) {
    // Ответ уже звучит: закрываем поток — после последнего предложения, как обычно, слушаем продолжение
    followUp = !r.error && !r.noFollowUp;
    caption.textContent = r.say || flow.text;
    flow.stream.end();
  } else if (r && !r.silent) speak(r.say, { expectReply: !r.error && !r.noFollowUp });
  else scheduleOrbHide();
}

$('#form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = '';
  if (pendingQuestion) return answerQuestion(text); // набранный ответ на вопрос Ориона
  submit(text, 'text');
});

hints.addEventListener('click', (e) => {
  if (e.target.classList.contains('chip')) submit(e.target.textContent, 'text');
});

window.jarvis.onStatus((text) => setStatus(text));

// --- Подтверждение: голосом или кнопками -----------------------------------------------

function answerConfirm(ok) {
  if (!pendingConfirm) return;
  window.jarvis.replyConfirm(pendingConfirm, ok);
  pendingConfirm = null;
  $('#confirm').hidden = true;
  capsule.clear();
  addMsg('muted', ok ? 'Подтверждено' : 'Отменено');
  stopListening();
}

window.jarvis.onConfirm(({ id, text }) => {
  pendingConfirm = id;
  $('#confirm-text').textContent = text;
  $('#confirm').hidden = false;
  capsule.ask(answerConfirm); // в капсуле — свои «Да / Нет»
  speak(`${text} Скажите «да» или «нет».`, { expectReply: true });
});
$('#confirm-yes').addEventListener('click', () => answerConfirm(true));
$('#confirm-no').addEventListener('click', () => answerConfirm(false));

// --- Вопрос со свободным ответом: голосом (следующая фраза без имени) или текстом ------------------

function answerQuestion(text) {
  if (!pendingQuestion) return;
  const t = typeof text === 'string' ? text.trim() : '';
  window.jarvis.replyQuestion(pendingQuestion, t || null);
  pendingQuestion = null;
  hidePanel();
  if (t) addMsg('user', t);
  stopListening();
}

window.jarvis.onQuestion(({ id, text }) => {
  pendingQuestion = id;
  showPanel(
    text,
    [
      ['Ответить', (v) => answerQuestion(v), true],
      ['Пропустить', () => answerQuestion(null)],
    ],
    { placeholder: 'Ответ голосом или здесь', onEnter: (v) => answerQuestion(v) },
  );
  speak(text, { expectReply: true });
});

// --- Напоминания, горячая клавиша, кнопки --------------------------------------------

// Орион говорит сам (например, что нового после обновления)
window.jarvis.onAnnounce((text) => {
  addMsg('bot', text);
  caption.textContent = text;
  speak(text);
});

window.jarvis.onRemind((text) => {
  addMsg('bot', `⏰ ${text}`);
  caption.textContent = `⏰ ${text}`;
  playChime('alarm');
  setTimeout(() => speak(`Напоминаю: ${text}.`), 500);
});

// Разговор закончился (перестал слушать, тишина, другой собеседник): ядро уже забыло реплики,
// полезное перенесено в память. На экране прошлый разговор остаётся — приглушённым, чтобы было видно,
// что Орион его уже не помнит. Фраза, с которой начался новый разговор (запрос ещё в работе), не приглушается.
// Стирается всё, когда окно скрыли (в том числе когда плашка в углу исчезла сама) или приложение перезапустили.
window.jarvis.onSessionEnd(() => {
  const keep = busy ? pending?.msg : null;
  for (const el of log.children) if (el !== keep) el.classList.add('past');
});

function clearLog() {
  log.replaceChildren();
  showHints();
}

// Горячая клавиша: перебить речь и сразу слушать — без ключевого слова.
window.jarvis.onFocus(() => {
  cancelThinking(); // клавиша — новая команда, а не дополнение прежней
  interrupt();
  input.focus();
  if (mic.isOn() && !wizard) {
    freshStart(); // сказанное до нажатия в команду не попадёт
    playChime();
    listen(LISTEN_MS, 'hotkey');
  }
});

window.jarvis.onToggleMic(toggleMic);

// Клик по реактору — «говорите».
core.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (mode === 'orb') return window.jarvis.presence('full');
  if (wizard) return;
  cancelThinking();
  interrupt();
  if (!mic.isOn()) await toggleMic();
  if (mic.isOn()) {
    freshStart();
    playChime();
    listen(LISTEN_MS, 'hotkey');
  }
});

// Клик по капсуле (не по её кнопкам и карточкам) разворачивает полное окно
document.body.addEventListener(
  'click',
  (e) => mode === 'orb' && e.target.closest('.stage') && !e.target.closest('button, .orb-extra') && window.jarvis.presence('full'),
);

micBtn.addEventListener('click', toggleMic);
voiceBtn.addEventListener('click', () => {
  voiceOn = !voiceOn;
  voiceBtn.classList.toggle('on', voiceOn);
  voiceBtn.setAttribute('aria-pressed', String(voiceOn));
  voiceBtn.querySelector('use').setAttribute('href', voiceOn ? '#i-sound' : '#i-sound-off');
  if (!voiceOn) interrupt({ end: true });
});
$('#reset').addEventListener('click', () => {
  window.jarvis.reset(); // разговор закрывается, полезное уходит в память
  talkingTo = undefined;
  log.replaceChildren();
  showHints();
  caption.textContent = '';
  setStatus('Начнём с чистого листа.', true);
});
$('#hide').addEventListener('click', hideWindow);
$('#minimize').addEventListener('click', () => window.jarvis.minimize());
// Закрепить поверх остальных окон (по умолчанию — обычное окно)
const pinBtn = $('#pin');
function showPinned(on) {
  pinBtn.classList.toggle('on', on);
  pinBtn.setAttribute('aria-pressed', String(on));
}
pinBtn.addEventListener('click', () => {
  const on = pinBtn.getAttribute('aria-pressed') !== 'true';
  showPinned(on);
  window.jarvis.pin(on);
});
// Меню «⋯»: редкие действия. Закрывается выбором пункта, щелчком мимо и Esc
const menu = $('#menu');
const moreBtn = $('#more');
function toggleMenu(open = menu.hidden) {
  menu.hidden = !open;
  moreBtn.setAttribute('aria-expanded', String(open));
  moreBtn.classList.toggle('on', open);
}
moreBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu();
});
menu.addEventListener('click', (e) => e.target.closest('.menu-item') && toggleMenu(false));
document.addEventListener('click', (e) => !menu.hidden && !menu.contains(e.target) && toggleMenu(false));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!menu.hidden) return toggleMenu(false);
  if (busy) return cancelThinking(); // Esc, пока думает, — отменить запрос
  if (speaking) return interrupt({ end: true }); // первый Esc — замолчать
  if (!panel.hidden) return wizard ? cancelWizard() : hidePanel();
  hideWindow();
});
