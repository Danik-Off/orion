// Поведение окна разговора (src/ui/src/main/controller.ts) без браузера: ядро, микрофон, озвучка и радио —
// подставные. Проверяются потоки, которые раньше было видно только вживую.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConversation } = require('../src/ui/src/main/controller.ts');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const all = [];
test.afterEach(() => all.splice(0).forEach((c) => c.dispose()));

// Ядро: каждый on…(cb) запоминает обработчик (emit вызывает его), остальные методы записываются в calls
function fakeApi(answers = {}) {
  const handlers = {};
  const calls = [];
  const api = new Proxy(
    {},
    {
      get(_t, name) {
        if (name === 'then') return undefined;
        if (/^on[A-Z]/.test(name)) return (cb) => ((handlers[name] = cb), () => {});
        return (...args) => {
          calls.push([name, ...args]);
          if (name === 'ask') return Promise.resolve(answers.ask?.(...args) ?? { say: 'Готово.' });
          if (name === 'settings') return Promise.resolve(answers.settings ?? null);
          if (name === 'schedule') return Promise.resolve([]);
          if (name === 'people') return Promise.resolve(null);
          return undefined;
        };
      },
    },
  );
  return { api, calls, emit: (name, ...args) => handlers[name]?.(...args), called: (name) => calls.filter((c) => c[0] === name) };
}

function setup(answers) {
  const core = fakeApi(answers);
  const spoken = [];
  let hooks = null;
  let micOn = false;
  const conversation = createConversation({
    api: core.api,
    createMic: ({ onChange }) => ({
      start: async () => ((micOn = true), onChange(true)),
      stop: () => ((micOn = false), onChange(false)),
      pause: () => {},
      isOn: () => micOn,
    }),
    createSpeaker: (h) => {
      hooks = h;
      return {
        speak: (text) => (spoken.push(text), h.onStart()),
        stream: () => ({ push: (t) => spoken.push(t), end: () => {} }),
        stop: () => {},
      };
    },
    createRadio: () => ({
      play: async () => true,
      stop() {},
      pause() {},
      resume() {},
      duck() {},
      setVolume() {},
      playing: () => false,
      active: () => false,
      sound: () => false,
    }),
    playChime: () => {},
    setQuiet: () => {},
    hour: () => 14,
  });
  conversation.connect();
  all.push(conversation);
  return {
    ...core,
    c: conversation,
    s: () => conversation.getState(),
    spoken,
    endSpeech: () => hooks.onEnd(),
    micOn: async () => {
      micOn = true;
      await conversation.actions.toggleMic(); // уже включён — выключит; включаем через start ниже
    },
    enableMic: () => {
      micOn = true;
    },
  };
}

test('запрос текстом: реплика и ответ с карточкой в ленте, ответ звучит, после ответа без микрофона — разговор окончен', async () => {
  const w = setup({ ask: () => ({ say: 'Сейчас +11°.', cards: [{ type: 'weather', city: 'Москва', days: [] }] }) });
  w.c.actions.submitText('какая погода');
  assert.equal(w.s().core, 'thinking');
  assert.equal(w.s().status, 'Думаю…');
  await tick();
  assert.deepEqual(w.called('ask')[0].slice(1, 3), ['какая погода', 'text']);
  assert.deepEqual(
    w.s().messages.map((m) => [m.kind, m.text]),
    [
      ['user', 'какая погода'],
      ['bot', 'Сейчас +11°.'],
    ],
  );
  assert.equal(w.s().messages[1].cards[0].type, 'weather');
  assert.deepEqual(w.s().holoCards, [{ type: 'weather', city: 'Москва', days: [] }], 'карточка — и в голограмме');
  assert.deepEqual(w.spoken, ['Сейчас +11°.']);
  assert.equal(w.s().core, 'speaking');
  w.endSpeech();
  assert.equal(w.called('dialogEnd').length, 1, 'микрофон выключен — продолжения не ждём');
  assert.equal(w.s().core, 'off');
});

test('«Орион, …» голосом: фраза после имени уходит ядру как wake; после ответа — «можно без имени»', async () => {
  const w = setup();
  w.enableMic();
  w.emit('onHeard', { partial: 'орион какая', command: 'какая', voice: null });
  assert.equal(w.s().core, 'hearing');
  w.emit('onHeard', { final: 'орион какая погода', command: 'какая погода', voice: null });
  await tick();
  assert.deepEqual(w.called('ask')[0].slice(1, 3), ['какая погода', 'wake']);
  w.endSpeech();
  assert.equal(w.s().core, 'listening');
  assert.ok(w.s().follow, 'полоска «без имени» видна');
  // продолжение без имени
  w.emit('onHeard', { final: 'а завтра', command: null, voice: null });
  await tick();
  assert.deepEqual(w.called('ask')[1].slice(1, 3), ['а завтра', 'followup']);
});

test('без имени и без ожидания — разговор в комнате не слушается', async () => {
  const w = setup();
  w.enableMic();
  w.emit('onHeard', { final: 'передай соль', command: null, voice: null });
  await tick();
  assert.equal(w.called('ask').length, 0);
  assert.equal(w.s().messages.length, 0);
});

test('«Орион, стоп» посреди ответа: замолчать и закончить разговор', async () => {
  const w = setup();
  w.enableMic();
  w.c.actions.submitText('расскажи историю');
  await tick();
  assert.equal(w.s().core, 'speaking');
  w.emit('onHeard', { final: 'орион стоп', command: 'стоп', voice: null });
  assert.notEqual(w.s().core, 'speaking');
  assert.ok(w.called('dialogEnd').length >= 1);
  assert.equal(w.called('ask').length, 1, '«стоп» не уходит ядру как запрос');
});

test('подтверждение: «да» голосом — ответ ядру, отметка в ленте; кнопки — то же', async () => {
  const w = setup();
  w.enableMic();
  w.emit('onConfirm', { id: 'q1', text: 'Выключить компьютер?' });
  assert.deepEqual(w.s().confirm, { text: 'Выключить компьютер?' });
  assert.match(w.spoken[0], /Скажите «да» или «нет»/);
  w.endSpeech();
  assert.equal(w.s().core, 'ask', 'ждёт ответа — янтарный шар');
  w.emit('onHeard', { final: 'да', command: null, voice: null });
  assert.deepEqual(w.called('replyConfirm')[0], ['replyConfirm', 'q1', true]);
  assert.equal(w.s().confirm, null);
  assert.equal(w.s().messages.at(-1).text, 'Подтверждено');

  w.emit('onConfirm', { id: 'q2', text: 'Удалить?' });
  w.c.actions.confirm(false);
  assert.deepEqual(w.called('replyConfirm')[1], ['replyConfirm', 'q2', false]);
});

test('голограмма: появляется из шара, уходит обратно и прячет окно; позвали во время ухода — остаётся', async () => {
  const w = setup();
  w.emit('onMode', 'orb');
  assert.equal(w.s().holo, 'seed');
  await tick(90);
  assert.equal(w.s().holo, 'open');
  w.c.actions.closeHolo();
  assert.equal(w.s().holo, 'closing');
  await tick(480);
  assert.equal(w.s().mode, 'hidden');
  assert.deepEqual(w.called('presence').at(-1), ['presence', 'hidden']);

  w.emit('onMode', 'orb');
  await tick(90);
  w.c.actions.closeHolo();
  w.enableMic();
  w.emit('onHeard', { partial: 'орион', command: '', voice: null }); // «Орион…» во время ухода
  await tick(480);
  assert.equal(w.s().mode, 'orb', 'передумала уходить');
  assert.equal(w.s().holo, 'open');
  w.emit('onHeard', { final: 'орион', command: '', voice: null }); // фраза закончилась — таймеры слушания штатные
  w.c.actions.escape();
});

test('скрытое окно и шар: всё забыто, следующий раз — с чистого экрана', async () => {
  const w = setup();
  w.c.actions.submitText('привет');
  await tick();
  assert.ok(w.s().messages.length);
  w.emit('onMode', 'cube');
  assert.equal(w.s().messages.length, 0);
  assert.equal(w.s().showHints, true);
});

test('Esc: сначала отменить раздумье, затем замолчать, затем скрыть окно', async () => {
  let resolve;
  const w = setup({ ask: () => new Promise((r) => (resolve = r)) });
  w.c.actions.submitText('долгий вопрос');
  w.c.actions.escape();
  assert.equal(w.called('cancel').length, 1);
  resolve({ say: 'поздно' });
  await tick();
  assert.equal(w.s().core, 'off');
  w.c.actions.escape();
  assert.deepEqual(w.called('presence').at(-1), ['presence', 'hidden']);
});

test('вопросы не зависают: «стоп» и отмена отвечают ядру «нет»; набранное «да» — ответ; пустой Enter не пропускает вопрос', async () => {
  const w = setup();
  w.enableMic();
  w.emit('onConfirm', { id: 'c1', text: 'Выключить компьютер?' });
  w.emit('onHeard', { final: 'орион стоп', command: 'стоп', voice: null });
  assert.deepEqual(w.called('replyConfirm')[0], ['replyConfirm', 'c1', false], '«стоп» — ядро перестаёт ждать');
  assert.equal(w.s().confirm, null);

  w.emit('onConfirm', { id: 'c2', text: 'Удалить?' });
  w.c.actions.submitText('да');
  assert.deepEqual(w.called('replyConfirm')[1], ['replyConfirm', 'c2', true]);
  assert.equal(w.called('ask').length, 0, '«да» не ушло новым запросом');

  w.emit('onQuestion', { id: 'q1', text: 'В каком вы городе?' });
  w.c.actions.submitText('   ');
  assert.equal(w.called('replyQuestion').length, 0, 'пустой Enter — не «пропустить»');
  w.emit('onHeard', { final: 'орион стоп', command: 'стоп', voice: null });
  assert.deepEqual(w.called('replyQuestion')[0], ['replyQuestion', 'q1', null]);
  assert.equal(w.s().panel, null);
});

test('смена голоса в настройках не включает выключенный микрофон; старый голос замолкает', async () => {
  let created = 0;
  let disposed = 0;
  const core = fakeApi({
    settings: { name: 'Орион', stt: true, tts: true, listenOnStart: true, hotkey: 'Ctrl+Alt+J', speaker: { available: false, people: [] } },
  });
  let micOn = false;
  const c = createConversation({
    api: core.api,
    createMic: ({ onChange }) => ({
      start: async () => ((micOn = true), onChange(true)),
      stop: () => ((micOn = false), onChange(false)),
      pause() {},
      isOn: () => micOn,
    }),
    createSpeaker: (h) => (
      created++,
      { speak: () => h.onStart(), stream: () => ({ push() {}, end() {} }), stop() {}, dispose: () => disposed++ }
    ),
    createRadio: () => ({
      play: async () => true,
      stop() {},
      pause() {},
      resume() {},
      duck() {},
      setVolume() {},
      playing: () => false,
      active: () => false,
      sound: () => false,
    }),
    playChime() {},
    setQuiet() {},
    hour: () => 14,
  });
  all.push(c);
  c.connect();
  await tick(10);
  assert.equal(micOn, true, 'при запуске микрофон включается сам');
  await c.actions.toggleMic();
  assert.equal(micOn, false);
  const before = created;
  core.emit('onSettingsChanged', { 'speech.ttsSpeed': 1.2 });
  await tick(10);
  assert.equal(micOn, false, 'выключенный микрофон остался выключенным');
  assert.equal(created, before + 1, 'новый голос');
  assert.ok(disposed >= 1, 'старый голос освобождён');
});

test('напоминание во время ответа ждёт его конца, а не обрывает', async () => {
  const w = setup();
  w.c.actions.submitText('расскажи историю');
  await tick();
  assert.equal(w.s().core, 'speaking');
  const said = w.spoken.length;
  w.emit('onAnnounce', 'Обновление скачано.');
  assert.equal(w.spoken.length, said, 'пока говорит — не перебивает');
  w.endSpeech();
  await tick(450);
  assert.ok(w.spoken.includes('Обновление скачано.'));
});

test('панели: Esc у предложения — как «Позже»: ядро не ждёт вечно, полоска «скачать» остаётся', async () => {
  const w = setup();
  w.emit('onBrainOffer', { size: '2,7 ГБ' });
  w.c.actions.escape(); // первый Esc — замолчать (предложение зачитывается вслух)
  w.endSpeech();
  w.c.actions.escape();
  assert.deepEqual(w.called('brainAnswer')[0], ['brainAnswer', 'later'], 'ядро не ждёт ответа вечно');
  assert.equal(w.s().panel, null);

  w.emit('onSetupOffer', { parts: [{ title: 'Голос', size: '100 МБ' }], total: '100 МБ', backend: 'llamacpp' });
  w.c.actions.escape();
  assert.equal(w.s().panel, null);
  assert.equal(w.s().setup?.pending, true, 'остаётся полоска «Не установлено… нажмите, чтобы скачать»');
});

test('«Что я умею»: нажатый в настройках пример выполняется в окне разговора как набранный', async () => {
  const w = setup();
  w.emit('onTry', 'Подбрось монетку');
  await tick();
  assert.deepEqual(w.called('ask')[0].slice(1, 3), ['Подбрось монетку', 'text']);
});

test('свёрнутый шар: перебили речь одним «Орион» — голограмма «Слушаю» открывается, а не только слушает молча', async () => {
  const w = setup();
  w.enableMic();
  w.emit('onMode', 'cube');
  w.c.actions.submitText('расскажи историю');
  await tick();
  assert.equal(w.s().core, 'speaking');
  w.emit('onHeard', { final: 'орион', command: '', voice: null });
  assert.deepEqual(w.called('presence').at(-1), ['presence', 'orb']);
  assert.equal(w.s().core, 'listening');
});
