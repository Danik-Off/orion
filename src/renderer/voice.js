// Голос: микрофон → распознавание в main, и озвучка ответов (Piper или системный голос).

// Микрофон. Звук дальше этого окна и main-процесса никуда не уходит.
function createMic({ onChange, onLevel, echoCancellation = () => true }) {
  let ctx = null;
  let stream = null;
  let paused = false;

  async function start() {
    if (ctx) return;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: echoCancellation(), noiseSuppression: true, autoGainControl: true },
    });
    ctx = new AudioContext({ sampleRate: 16000 }); // Chromium сам пересэмплирует микрофон
    await ctx.audioWorklet.addModule('mic-worklet.js');
    const node = new AudioWorkletNode(ctx, 'mic-chunker');
    node.port.onmessage = ({ data }) => {
      onLevel?.(data.rms);
      if (!paused) window.jarvis.sendAudio(data.samples);
    };
    ctx.createMediaStreamSource(stream).connect(node);
    window.jarvis.micReset();
    onChange(true);
  }

  function stop() {
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close();
    ctx = stream = null;
    onChange(false);
  }

  // Пока ассистент говорит или думает — не слушаем, чтобы он не услышал сам себя.
  function pause(value) {
    if (paused === value) return;
    paused = value;
    if (!value) window.jarvis.micReset();
  }

  return { start, stop, pause, isOn: () => !!ctx };
}

// Озвучка: предложения синтезируются по одному и ставятся в очередь — первое звучит почти сразу.
function createSpeaker({ usePiper, onStart, onEnd }) {
  let ctx = null;
  let generation = 0;
  let sources = [];

  const sentences = (text) =>
    (text.match(/[^.!?…]+[.!?…]*/g) || [text]).map((s) => s.trim()).filter(Boolean);

  // Первое предложение — до первой запятой: время синтеза растёт с длиной фразы (5,6 с речи — 1,3 с ожидания,
  // 2 с речи — 0,4 с), а остаток синтезируется, пока звучит начало
  const FIRST_CHUNK_MIN = 40;
  function splitFirst(sentence) {
    if (sentence.length < FIRST_CHUNK_MIN) return [sentence];
    const at = sentence.slice(12, -12).search(/[,;:—–]\s/);
    if (at < 0) return [sentence];
    const cut = 12 + at + 1;
    return [sentence.slice(0, cut).trim(), sentence.slice(cut).trim()];
  }

  // Синтез отдаёт звук уже без тишины по краям — паузы между кусками ставим сами:
  // после конца предложения — как в живой речи, после запятой — короткую
  const pauseAfter = (text) => (/[.!?…]["»)]*$/.test(text) ? 0.3 : 0.08);

  let endAt = 0; // когда закончится уже поставленный в очередь звук

  function stop() {
    generation++;
    endAt = 0;
    sources.forEach((s) => {
      try {
        s.stop();
      } catch {}
    });
    sources = [];
    speechSynthesis.cancel();
  }

  function speak(text) {
    const s = stream();
    s.push(text);
    s.end();
  }

  // Поток речи: предложения дописываются по мере готовности (модель ещё пишет ответ), звучат подряд.
  // onEnd — только когда поток закрыт (end) и отзвучало последнее предложение; пауза между
  // предложениями, пока модель пишет следующее, концом речи не считается.
  function stream() {
    stop();
    const my = generation;
    const queue = [];
    let closed = false;
    let wake = null;
    let started = false;
    let playing = 0; // сколько кусков сейчас звучит или ждёт своей очереди
    let working = false; // синтезируется очередное предложение
    let finished = false;
    let pushed = false; // первое предложение уже пришло (короткий первый кусок — только у него)
    const done = () => {
      if (finished || my !== generation || !closed || queue.length || playing || working) return;
      finished = true;
      onEnd();
    };
    const began = () => {
      if (!started) (started = true), onStart();
    };

    (async () => {
      for (;;) {
        if (my !== generation) return;
        if (!queue.length) {
          if (closed) break;
          await new Promise((r) => (wake = r));
          continue;
        }
        const sentence = queue.shift();
        working = true;
        if (!usePiper) {
          const u = new SpeechSynthesisUtterance(sentence);
          u.lang = 'ru-RU';
          const ru = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('ru'));
          u.voice = ru.find((v) => /pavel|dmitry/i.test(v.name)) || ru[0] || null;
          playing++;
          u.onstart = began;
          u.onend = u.onerror = () => (playing--, done());
          speechSynthesis.speak(u); // системный голос сам ставит фразы в очередь
          working = false;
          continue;
        }
        ctx ??= new AudioContext();
        const audio = await window.jarvis.synth(sentence);
        working = false;
        if (my !== generation) return;
        if (!audio?.samples?.length) continue;
        const buf = ctx.createBuffer(1, audio.samples.length, audio.sampleRate);
        buf.copyToChannel(audio.samples, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        began();
        endAt = Math.max(endAt, ctx.currentTime + 0.02);
        src.start(endAt);
        endAt += buf.duration + pauseAfter(sentence);
        sources.push(src);
        playing++;
        src.onended = () => (playing--, done());
      }
      done();
    })();

    return {
      push(text) {
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
  return { speak, stream, stop };
}

// Короткий сигнал: «слушаю» (два тона вверх) или «напоминание» (четыре тона).
let chimeCtx = null;
function playChime(kind = 'listen') {
  chimeCtx ??= new AudioContext();
  const notes = kind === 'alarm' ? [880, 660, 880, 660] : [660, 990];
  const t0 = chimeCtx.currentTime + 0.01;
  notes.forEach((freq, i) => {
    const osc = chimeCtx.createOscillator();
    const gain = chimeCtx.createGain();
    const t = t0 + i * 0.09;
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.15, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(gain).connect(chimeCtx.destination);
    osc.start(t);
    osc.stop(t + 0.13);
  });
}
