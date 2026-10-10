// Старт окна: настройки, первая установка компонентов, предложения докачать модель и полоска обновления.
/* exported applySettings */
/* global $, input, micBtn, peopleBtn, name:writable, mode:writable, voices:writable, mic, voiceOn, busy, speaking,
   configureVoice, toggleMic, setStatus, refreshState, showPinned, speak, showPanel, hidePanel */

let installing = false;

// Настройки и доступные модули — при старте и каждый раз, когда установщик что-то подключил
async function applySettings() {
  const s = await window.jarvis.settings();
  if (!s) return;
  name = s.name;
  voices = s.speaker;
  mode = s.mode;
  document.body.className = `mode-${mode}`;
  document.title = name;
  $('#name').textContent = name;
  $('#name').title = s.version || s.model; // версия — в подсказке у имени (целиком — в настройках, «О программе»)
  showPinned(s.pinned === true);
  input.placeholder = `Напишите или скажите «${name}…»`;
  configureVoice(s);
  micBtn.hidden = !s.stt;
  peopleBtn.hidden = !s.stt || !voices.available;
  peopleBtn.classList.toggle('on', voices.people.length > 0);
  if (s.stt && s.listenOnStart && !mic.isOn()) await toggleMic();
  if (!installing) {
    setStatus(
      s.stt ? `Скажите «${name}…» или нажмите ${s.hotkey.replace('CommandOrControl', 'Ctrl')}` : 'Голосовой ввод пока не установлен.',
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
    const failed = setupBox.classList.contains('error');
    if (!failed) setupBox.hidden = true;
    await applySettings();
    if (failed) return;
    // Докачали большую модель (из предложения или настроек)
    if (r.stages?.includes('brain')) {
      return speak(
        'Готово, я стал умнее. Если захотите, могу подстраховываться внешней моделью — включите это в настройках, раздел «Модели».',
      );
    }
    if (r.stages && !r.stages.includes('voice')) return; // докачали часть из настроек — без приветствия
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
    speak(
      `Я ${name}, ваш голосовой ассистент. Сейчас готовлюсь к работе: устанавливаю слух и загружаю знания. Это займёт несколько минут.`,
    );
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
  showPanel(
    text.join('\n'),
    [
      [
        `Скачать (${total})`,
        () => {
          hidePanel();
          setupOffer = null;
          setupBox.classList.remove('pending');
          window.jarvis.setupAnswer(true);
        },
        true,
      ],
      ...(ollama ? [] : [['Скачать Ollama', () => window.jarvis.openLink('https://ollama.com/download')]]),
      [
        'Позже',
        () => {
          hidePanel();
          setupBox.hidden = false;
          setupBox.classList.add('pending');
          $('#setup-title').textContent = `Не установлено: ${total}. Нажмите, чтобы скачать`;
          $('#setup-fill').style.width = '0%';
        },
      ],
    ],
    null,
    { modal: true },
  );
}
window.jarvis.onSetupOffer((offer) => {
  installing = true;
  setupOffer = offer;
  setStatus('Нужно скачать компоненты', true);
  showSetupOffer();
});
setupBox.addEventListener('click', () => setupOffer && showSetupOffer());

// «Я могу стать умнее»: большой модели нет — скачать Qwen, подключить внешнюю (Ollama или по API) или позже
window.jarvis.onBrainOffer(({ size }) => {
  const text =
    `Я могу стать умнее: для этого нужно докачать ещё ${size} — большую языковую модель Qwen. ` +
    'Вместо неё можно подключить внешнюю модель: в Ollama или стороннюю по API. ' +
    'А после установки Qwen я по вашему желанию могу комбинировать локальную и удалённую модели.';
  const answer = (choice) => () => {
    hidePanel();
    window.jarvis.brainAnswer(choice);
    if (choice === 'connect') window.jarvis.openSettings('models');
  };
  showPanel(text, [
    [`Скачать (${size})`, answer('download'), true],
    ['Подключить внешнюю', answer('connect')],
    ['Позже', answer('later')],
    ['Не предлагать', answer('never')],
  ]);
  if (voiceOn && !busy && !speaking) speak(text);
});

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
