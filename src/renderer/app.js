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
const ORB_LINGER_MS = 4000; // плашка в углу исчезает, когда всё сказано
let followUpMs = 7000; // после ответа можно продолжать разговор без ключевого слова

let name = 'Орион';
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
let talkingTo; // с кем сейчас разговор: id человека, null — гость, undefined — разговора нет
let ignoredInRow = 0; // фразы подряд, которые модель сочла обращёнными не к Ориону
let wizard = null; // мастер записи голоса: { step, phrases, stage: 'phrases'|'name'|'honorific', name, id }

const isListening = () => Date.now() < listenUntil || hearing;

function refreshState() {
  let s = mic.isOn() ? 'idle' : 'off';
  // Ждёт команду — 'listening'; человек говорит и текст распознаётся — 'hearing' (выглядят по-разному)
  if (isListening() || wizard) s = hearing ? 'hearing' : 'listening';
  if (busy) s = 'thinking';
  if (speaking) s = 'speaking';
  if (Date.now() < errorUntil) s = 'error';
  core.dataset.state = s;
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

function addMsg(kind, text, sources) {
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
  if (mode === 'hidden') window.jarvis.presence('orb');
  clearTimeout(hideTimer);
}

// Закрыть полное окно. Если диалог ещё идёт (думает, говорит, ждёт продолжения или ответа «да/нет»),
// окно сворачивается в плашку — иначе ответ пришёл бы в скрытое окно и его не было бы видно
const dialogActive = () => busy || speaking || isListening() || !!pendingConfirm;
function hideWindow() {
  if (mode === 'full' && dialogActive()) return window.jarvis.presence('collapse');
  window.jarvis.presence('hidden');
}

function scheduleOrbHide() {
  clearTimeout(hideTimer);
  if (mode !== 'orb') return;
  hideTimer = setTimeout(() => {
    if (mode !== 'orb' || dialogActive()) return;
    // Считаем плашку скрытой сразу, не дожидаясь ответа окна: иначе «Орион…», сказанное в этот момент,
    // не вызовет её снова (showOrbIfHidden видел бы ещё 'orb')
    mode = 'hidden';
    window.jarvis.presence('hidden');
  }, ORB_LINGER_MS);
}

// Плашка растёт вверх под весь текст: сообщаем окну нужную высоту (подложка + отступы сверху и снизу)
const captionsEl = $('.captions');
const ORB_TEXT_GAP = 38;
// Меряем полную высоту текста (scrollHeight), а не видимую: подложка ограничена высотой окна и иначе не вырастет
const reportOrbHeight = () =>
  mode === 'orb' && window.jarvis.orbHeight(captionsEl.scrollHeight + 2 /* рамка */ + ORB_TEXT_GAP);
const orbResize = new ResizeObserver(reportOrbHeight);
[captionsEl, caption, statusEl].forEach((el) => orbResize.observe(el));

window.jarvis.onMode((m) => {
  mode = m;
  document.body.className = `mode-${m}`;
  if (m === 'hidden') clearLog(); // окно скрыто — следующий раз начинаем с чистого экрана
  if (m === 'orb') {
    scheduleOrbHide();
    requestAnimationFrame(reportOrbHeight); // текст мог смениться, пока плашка была скрыта
  }
});

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

function stopListening({ expired = false } = {}) {
  if (expired && !busy) endDialog(); // перестал слушать, а новой фразы не было — контекст сбрасывается
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

// Кто говорит → id человека; null — голос чужой; undefined — не проверялось (нет записанных, слишком коротко)
// Два записанных голоса почти одинаково похожи: если один из них — текущий собеседник, это он
const voiceId = (voice) => {
  if (!voice) return undefined;
  if (voice.match) return voice.person.id;
  if (voice.ambiguous) return talkingTo && voice.candidates?.includes(talkingTo) ? talkingTo : undefined;
  return null;
};

// Фразу без имени от другого человека считаем разговором не с Орионом.
// Неоднозначность между записанными людьми — не «чужой» (так ошибочно отсекались свои фразы).
function isStranger(voice, source) {
  if (!voices.people.length || !voice || voice.ambiguous) return false;
  if (voices.require === 'always' && !voice.match) return true;
  if (source !== 'followup' || voices.require === 'off' || talkingTo === undefined) return false;
  // Продолжение без имени — только от того, кто начал разговор (гость — любой незнакомый голос)
  return talkingTo === null ? voice.match : !voice.match || voice.person.id !== talkingTo;
}

// (\b не работает с кириллицей — конец слова это пробел или конец строки)
const YES = /^(да|ага|подтверждаю|конечно|давай|выполняй|ок|окей)(\s|$)/;
const NO = /^(нет|отмена|отмени|не надо|стоп)(\s|$)/;

const STOP_WORDS = /^(стоп|хватит|замолчи|тихо|помолчи|достаточно|спасибо|всё|все)?$/;

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
    if (STOP_WORDS.test(command)) return listen(LISTEN_MS, 'wake');
  }
  const listening = isListening();

  if (partial) {
    if (!listening && command === null) return; // разговор не с Орионом
    if (!listening) listen(LISTEN_MS, 'wake');
    hearing = true;
    showOrbIfHidden();
    caption.textContent = command || partial;
    refreshState();
    return;
  }
  if (!final) return;
  hearing = false;
  refreshState(); // фраза договорена — реактор больше не в режиме распознавания

  if (pendingConfirm) {
    const answer = YES.test(final) ? true : NO.test(final) ? false : null;
    if (answer !== null && !isStranger(voice, 'followup')) return answerConfirm(answer);
  }

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
  if (/^(э+|а+|м+|ну|угу|хм+)$/.test(text)) return; // междометия — не команда
  listenUntil = 0;
  clearTimeout(listenTimer);
  window.jarvis.setListening(false); // фраза получена — снова экономный режим
  // Короткую фразу по голосу не проверить — в продолжении разговора считаем, что говорит тот же человек
  const personId = voice ? voiceId(voice) ?? (source === 'followup' ? talkingTo : undefined) : source === 'followup' ? talkingTo : undefined;
  // Продолжение, где голос подтверждён как тот же собеседник, — ядро не переспрашивает модель «это мне?»
  const sameVoice = source === 'followup' && voice && personId && personId === talkingTo;
  submit(text, sameVoice ? 'followup-voice' : source, personId);
});

// Пока модель думает над голосовой фразой, человек может:
//  • договорить её после паузы — запрос отменяется, модель получает фразу целиком;
//  • сказать «Орион, …» — новая команда вместо старой.
// Посторонние голоса и эхо не мешают: дополнением считается только голос того же человека.
function heardWhileThinking({ partial, final, command, voice }) {
  if (!pending || pending.source === 'text') return;
  const byName = command !== null && command !== undefined;
  if (partial) {
    hearing = true; // ответ, если придёт сейчас, подождёт конца фразы
    caption.textContent = byName ? command || '…' : `${pending.text} ${partial}`;
    return;
  }
  if (!final) return;
  hearing = false;
  // «Орион, стоп» — просто отменить
  if (byName && STOP_WORDS.test(command)) return cancelThinking();
  if (byName && command) return submit(command, 'wake', voiceId(voice), { replace: true });
  const id = voiceId(voice);
  const other = voices.people.length && voice && !voice.ambiguous && (pending.personId ? id !== pending.personId : voice.match);
  if (other || /^(э+|а+|м+|ну|угу|хм+)$/.test(final) || byName) {
    caption.textContent = pending.text;
    return releaseHeld();
  }
  submit(`${pending.text} ${final}`, pending.source, pending.personId, { replace: true });
}

// --- Озвучка ----------------------------------------------------------------------

let bargeIn = true; // можно ли перебить именем (нельзя, если Орион сам произносит своё имя)
let bargingIn = false;

const speakerHooks = {
  onStart: () => {
    speaking = true;
    showOrbIfHidden(); // окно могли скрыть, пока Орион думал, — ответ всё равно должен быть виден
    freshStart();
    syncMic();
    refreshState();
  },
  onEnd: () => {
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
      if (!pendingConfirm && !bargingIn && !interrupting && !previewing) endDialog();
      scheduleOrbHide();
    }
    followUp = false;
    previewing = false;
    refreshState();
  },
};
let speaker = createSpeaker({ ownVoice: false, ...speakerHooks });
let previewing = false; // «Прослушать» в настройках — это не ответ, разговор не заканчивается

// --- Вкладка «Настройки» ------------------------------------------------------------

const views = initSettings({
  previewVoice: () => {
    if (busy || speaking) return;
    previewing = true;
    followUp = false;
    speaker.speak(`Здравствуйте, я ${name}. Так звучит мой голос.`);
  },
  // Значения, которые окно держит у себя, — сразу; остальное читает ядро
  onSaved: (key, v) => {
    if (key === 'speech.followUpSeconds') followUpMs = v * 1000;
    if (key === 'speech.speaker.require') voices.require = v;
  },
});

function speak(text, { expectReply = false } = {}) {
  interim = false; // заготовку (если ещё звучит) сменяет настоящий ответ
  followUp = expectReply;
  bargeIn = !String(text).toLowerCase().includes(name.toLowerCase().slice(0, 4)); // «Меня зовут Орион» — не будить самого себя
  if (voiceOn && text) return speaker.speak(text);
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
  if (hearing || speaking || !voiceOn || wizard || pendingConfirm) return;
  bargeIn = true;
  interim = true;
  speaker.speak(text);
});

window.jarvis.onSayPart(({ id, text }) => {
  if (!live || id !== live.id || id !== askSeq || !busy || live.blocked || !text) return;
  if (!live.stream) {
    // Человек ещё договаривает, звук выключен, ждём «да/нет» или идёт запись голоса — не начинаем:
    // ответ прозвучит целиком в конце, как обычно
    if (hearing || !voiceOn || wizard || pendingConfirm) {
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
  pending = { text, source, personId, msg };
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
    const wait = () => (hearing && Date.now() - heldAt < 10000 ? (heldTimer = setTimeout(wait, 500)) : releaseHeld());
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
      addMsg(r.error ? 'error' : 'bot', r.say || '…', r.sources);
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
    return endDialog(), scheduleOrbHide();
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
  addMsg('muted', ok ? 'Подтверждено' : 'Отменено');
  stopListening();
}

window.jarvis.onConfirm(({ id, text }) => {
  views.showView('chat'); // подтверждение — в разговоре, а не за вкладкой настроек
  pendingConfirm = id;
  $('#confirm-text').textContent = text;
  $('#confirm').hidden = false;
  speak(`${text} Скажите «да» или «нет».`, { expectReply: true });
});
$('#confirm-yes').addEventListener('click', () => answerConfirm(true));
$('#confirm-no').addEventListener('click', () => answerConfirm(false));

// --- Люди: запись голоса, имя и обращение -------------------------------------------------

// Панель: текст, необязательное поле ввода и кнопки [подпись, действие, основная?].
// modal — посреди окна поверх всего (вопрос, без ответа на который дальше не пойти)
function showPanel(text, buttons, field, { modal = false } = {}) {
  panel.classList.toggle('modal', modal);
  $('#backdrop').hidden = !modal;
  $('#panel-text').textContent = text;
  const actions = $('#panel-actions');
  actions.replaceChildren();
  const box = $('#panel-field');
  box.replaceChildren();
  if (field) {
    const f = document.createElement('input');
    f.className = 'panel-input';
    f.placeholder = field.placeholder || '';
    f.value = field.value || '';
    f.maxLength = 40;
    f.addEventListener('keydown', (e) => e.key === 'Enter' && field.onEnter?.(f.value));
    box.append(f);
    setTimeout(() => f.focus(), 0);
  }
  for (const [label, fn, primary] of buttons) {
    const b = document.createElement('button');
    b.className = `btn${primary ? ' primary' : ''}`;
    b.textContent = label;
    b.addEventListener('click', () => fn($('#panel-field input')?.value));
    actions.append(b);
  }
  panel.hidden = false;
}
const hidePanel = () => {
  panel.hidden = true;
  $('#backdrop').hidden = true;
};

async function refreshPeople() {
  voices = (await window.jarvis.people()) || voices;
  peopleBtn.classList.toggle('on', voices.people.length > 0);
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
  const buttons = [[voices.people.length ? 'Добавить человека' : 'Начать', () => startWizard(), true]];
  buttons.push(['Настроить отклик на имя', () => startWakeTuning()]);
  for (const p of voices.people) buttons.push([`Изменить: ${p.name || 'без имени'}`, () => editPerson(p)]);
  buttons.push(['Закрыть', hidePanel]);
  showPanel(text, buttons);
}

function editPerson(p) {
  showPanel(
    `${p.name || 'Без имени'} — обращение «${p.honorific}».`,
    [
      ['Сэр', async () => (await window.jarvis.personUpdate(p.id, { honorific: 'сэр' }), refreshPeople().then(showPeople))],
      ['Мисс', async () => (await window.jarvis.personUpdate(p.id, { honorific: 'мисс' }), refreshPeople().then(showPeople))],
      ['Переименовать', async (value) => (await window.jarvis.personUpdate(p.id, { name: value }), refreshPeople().then(showPeople))],
      ['Перезаписать голос', () => startWizard(p)],
      [
        'Удалить',
        async () => {
          await window.jarvis.personRemove(p.id);
          if (talkingTo === p.id) talkingTo = undefined;
          await refreshPeople();
          showPeople();
        },
      ],
      ['Назад', showPeople],
    ],
    { placeholder: 'Новое имя', value: p.name },
  );
}

async function startWizard(existing) {
  if (!mic.isOn()) await toggleMic();
  if (!mic.isOn()) return;
  interrupt({ end: true });
  const { needed } = await window.jarvis.enrollStart();
  // Каждая фраза начинается с имени: заодно запоминаем, как распознаватель слышит ваше «Орион».
  // Распознанный текст сверяется с фразой — фон, телевизор или чужая речь в образцы голоса не попадут.
  wizard = {
    stage: 'phrases',
    step: 0,
    needed,
    id: existing?.id,
    heard: [],
    phrases: [
      `${name}, какая сегодня погода и что у меня в планах?`,
      `${name}, включи, пожалуйста, какую-нибудь спокойную музыку.`,
      `${name}, напомни мне через десять минут проверить почту.`,
      `${name}, расскажи что-нибудь интересное про космос.`,
    ],
  };
  window.jarvis.setListening(true);
  promptPhrase();
  refreshState();
}

function promptPhrase(note = '') {
  const { step, needed, phrases, heard } = wizard;
  const done = heard.length ? `\n\nЗаписано: ${heard.map((h) => `«${h}» ✓`).join(' · ')}` : '';
  const tip = step ? '' : '\nГоворите так, как обычно обращаетесь ко мне, — с того места, где обычно сидите.';
  showPanel(`${note}Фраза ${step + 1} из ${needed}. Скажите обычным голосом:\n«${phrases[step]}»${tip}${done}`, [['Отмена', cancelWizard]]);
}

function promptName() {
  wizard.stage = 'name';
  speak('Как к вам обращаться?');
  showPanel('Как к вам обращаться? Скажите имя или напишите его.', [
    ['Дальше', (value) => value?.trim() && promptHonorific(value.trim()), true],
    ['Отмена', cancelWizard],
  ], { placeholder: 'Имя', onEnter: (v) => v.trim() && promptHonorific(v.trim()) });
}

function promptHonorific(personName) {
  wizard.stage = 'honorific';
  wizard.name = personName;
  speak(`Приятно познакомиться, ${personName}. Обращаться к вам «сэр» или «мисс»?`);
  showPanel(`${personName}, обращаться к вам «сэр» или «мисс»?`, [
    ['Сэр', () => finishWizard('сэр'), true],
    ['Мисс', () => finishWizard('мисс'), true],
    ['Отмена', cancelWizard],
  ]);
}

async function finishWizard(honorific) {
  window.jarvis.setListening(false);
  const person = await window.jarvis.enrollFinish({ name: wizard.name, honorific, id: wizard.id });
  wizard = null;
  await refreshPeople();
  if (person?.id) talkingTo = person.id;
  // Что получилось: порог узнавания, громкость голоса относительно шума, усиление микрофона
  const details = [];
  if (person?.threshold) details.push(`порог узнавания ${person.threshold}`);
  if (typeof person?.level === 'number' && typeof person?.noise === 'number') {
    details.push(`голос громче фона на ${Math.round(person.level - person.noise)} дБ`);
  }
  if (person?.gain) details.push(`усиление микрофона +${Math.round(person.gain)} дБ`);
  const similar = person?.similar
    ? `\n\nВаш голос очень похож на записанный голос «${person.similar.name || 'без имени'}». Если это тоже вы — удалите лишнюю запись в «Люди», иначе я буду вас путать.`
    : '';
  showPanel(
    `Готово, ${honorific} ${person?.name || ''}. Теперь я узнаю вас по голосу.`.replace(/\s+\./, '.') +
      (details.length ? `\n${details.join(', ')}.` : '') +
      similar,
    [['Отлично', hidePanel, true]],
  );
  speak(`Готово, ${honorific}. Теперь я узнаю вас по голосу.`);
  playChime();
  refreshState();
}

// Настройка отклика на имя: человек трижды говорит только имя
async function startWakeTuning() {
  if (!mic.isOn()) await toggleMic();
  if (!mic.isOn()) return;
  interrupt();
  wizard = { stage: 'wake', step: 0, needed: 3, log: [] };
  window.jarvis.setListening(true);
  promptWake();
  refreshState();
}

function promptWake(note = '') {
  const { step, needed, log } = wizard;
  const heard = log.length ? `\n\nУслышал: ${log.join(' · ')}` : '';
  showPanel(`${note}Скажите «${name}» — только имя, обычным голосом (${step + 1} из ${needed}).${heard}`, [['Готово', finishWakeTuning], ['Отмена', cancelWizard]]);
}

function finishWakeTuning() {
  window.jarvis.setListening(false);
  const learned = wizard?.log.filter((x) => x.includes('запомнил')).length || 0;
  wizard = null;
  showPanel(
    learned ? `Готово: запомнил, как слышу ваше «${name}».` : `Ваше «${name}» я и так слышу хорошо.`,
    [['Отлично', hidePanel, true]],
  );
  refreshState();
}

// Во время мастера всё услышанное — это ответы мастеру
async function wizardHeard(text) {
  if (wizard.stage === 'wake') {
    const r = await window.jarvis.wakeLearn();
    if (!wizard) return;
    wizard.log.push(r.added.length ? `«${r.heard}» — запомнил` : r.recognized ? `«${r.heard}» — узнаю` : `«${r.heard}» — не похоже на имя`);
    wizard.step += 1;
    return wizard.step >= wizard.needed ? finishWakeTuning() : promptWake();
  }
  if (wizard.stage === 'phrases') {
    const r = await window.jarvis.enrollAdd(wizard.phrases[wizard.step]);
    if (!wizard) return;
    if (r.error) return promptPhrase(`${r.error}.\n\n`);
    wizard.heard.push(r.heard);
    wizard.step = r.count;
    return r.done ? promptName() : promptPhrase();
  }
  if (wizard.stage === 'name') {
    // «меня зовут Данил» → «Данил»
    const n = text.replace(/^(меня зовут|зови меня|называй меня|я)\s+/i, '').split(/\s+/).slice(0, 2).join(' ');
    return promptHonorific(n.charAt(0).toUpperCase() + n.slice(1));
  }
  if (wizard.stage === 'honorific') {
    if (/мисс|мэм|мадам|девуш|женщ/i.test(text)) return finishWizard('мисс');
    if (/сэр|сер|мужч|парен/i.test(text)) return finishWizard('сэр');
  }
}

function cancelWizard() {
  window.jarvis.setListening(false);
  wizard = null;
  window.jarvis.enrollCancel();
  hidePanel();
  refreshState();
}

peopleBtn.addEventListener('click', async () => {
  if (wizard) return cancelWizard();
  if (!panel.hidden) return hidePanel();
  await refreshPeople(); // свежая «последняя оценка»
  showPeople();
});

// --- Напоминания, горячая клавиша, кнопки --------------------------------------------

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
  hints.hidden = false;
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

// Клик по плашке в углу разворачивает полное окно.
document.body.addEventListener('click', () => mode === 'orb' && window.jarvis.presence('full'));

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
  hints.hidden = false;
  caption.textContent = '';
  setStatus('Начнём с чистого листа.', true);
});
$('#hide').addEventListener('click', hideWindow);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (busy) return cancelThinking(); // Esc, пока думает, — отменить запрос
  if (speaking) return interrupt({ end: true }); // первый Esc — замолчать
  if (!panel.hidden) return wizard ? cancelWizard() : hidePanel();
  hideWindow();
});

// --- Старт ------------------------------------------------------------------------

let installing = false;

// Настройки и доступные модули — при старте и каждый раз, когда установщик что-то подключил
async function applySettings() {
  const s = await window.jarvis.settings();
  if (!s) return;
  name = s.name;
  followUpMs = (s.followUpSeconds || 7) * 1000;
  echoCancellation = s.echoCancellation;
  voices = s.speaker;
  mode = s.mode;
  document.body.className = `mode-${mode}`;
  document.title = name;
  $('#name').textContent = name;
  $('#model').textContent = s.model;
  input.placeholder = `Напишите или скажите «${name}…»`;
  speaker = createSpeaker({ ownVoice: s.tts, ...speakerHooks });
  micBtn.hidden = !s.stt;
  peopleBtn.hidden = !s.stt || !voices.available;
  peopleBtn.classList.toggle('on', voices.people.length > 0);
  if (s.stt && s.listenOnStart && !mic.isOn()) await toggleMic();
  if (!installing) {
    setStatus(
      s.stt
        ? `Скажите «${name}…» или нажмите ${s.hotkey.replace('CommandOrControl', 'Ctrl')}`
        : 'Голосовой ввод пока не установлен.',
      true,
    );
  }
  refreshState();
  return s;
}

// --- Установка моделей при первом запуске ---

const setupBox = $('#setup');
window.jarvis.onSetup(async (r) => {
  if (r.finished) {
    installing = false;
    if (!setupBox.classList.contains('error')) setupBox.hidden = true;
    await applySettings();
    return speak(`Готов к работе. Скажите «${name}» — и я вас слушаю.`);
  }
  installing = true;
  setupBox.hidden = false;
  setupBox.classList.toggle('error', !!r.error);
  if (r.title) $('#setup-title').textContent = r.progress != null && !r.done ? `${r.title} — ${Math.round(r.progress * 100)}%` : r.title;
  $('#setup-fill').style.width = `${Math.round((r.progress ?? (r.done ? 1 : 0)) * 100)}%`;
  if (r.needOllama) {
    showPanel('Для работы мне нужен Ollama — программа, в которой живёт языковая модель. Установите её и перезапустите меня.', [
      ['Скачать Ollama', () => window.jarvis.openLink('https://ollama.com/download'), true],
      ['Позже', hidePanel],
    ]);
  }
  if (r.ready === 'voice') {
    await applySettings();
    speak(`Я ${name}, ваш голосовой ассистент. Сейчас готовлюсь к работе: устанавливаю слух и загружаю знания. Это займёт несколько минут.`);
  }
  if (r.ready === 'hearing') await applySettings(); // микрофон включится, как только появится распознавание
});

// Первый запуск: что нужно скачать и сколько это весит — до начала загрузки.
// «Позже» прячет вопрос, но под реактором остаётся строка, по которой его можно открыть снова.
let setupOffer = null;
function showSetupOffer() {
  const { parts = [], total, ollama } = setupOffer;
  const lines = parts.map((p) => `• ${p.title} — ${p.size}`);
  const text = [
    `Для работы мне нужно скачать компоненты — всего около ${total}:`,
    ...lines,
    ollama ? '' : '\nВ настройках выбран движок Ollama — его нужно установить отдельно с ollama.com (или выберите встроенный).',
    '\nВсё работает на этом компьютере, без облака. Скачать сейчас?',
  ].filter(Boolean);
  views.showView('chat');
  showPanel(text.join('\n'), [
    [`Скачать (${total})`, () => {
      hidePanel();
      setupOffer = null;
      setupBox.classList.remove('pending');
      window.jarvis.setupAnswer(true);
    }, true],
    ...(ollama ? [] : [['Скачать Ollama', () => window.jarvis.openLink('https://ollama.com/download')]]),
    ['Позже', () => {
      hidePanel();
      setupBox.hidden = false;
      setupBox.classList.add('pending');
      $('#setup-title').textContent = `Не установлено: ${total}. Нажмите, чтобы скачать`;
      $('#setup-fill').style.width = '0%';
    }],
  ], null, { modal: true });
}
window.jarvis.onSetupOffer((offer) => {
  installing = true;
  setupOffer = offer;
  setStatus('Нужно скачать компоненты', true);
  showSetupOffer();
});
setupBox.addEventListener('click', () => setupOffer && showSetupOffer());

// Загрузка обновления: та же полоска, что и при установке
window.jarvis.onUpdate((r) => {
  setupBox.hidden = false;
  setupBox.classList.remove('pending');
  setupBox.classList.toggle('error', !!r.error);
  $('#setup-title').textContent = r.progress != null && !r.done && !r.error ? `${r.title} — ${Math.round(r.progress * 100)}%` : r.title;
  $('#setup-fill').style.width = `${Math.round((r.progress ?? 0) * 100)}%`;
  if (r.done || r.error) setTimeout(() => !installing && (setupBox.hidden = true), 6000);
});

applySettings();
