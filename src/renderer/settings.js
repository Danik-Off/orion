// Вкладка «Настройки» полного окна. Каждое поле сохраняется сразу после изменения.
// app.js подключает её через initSettings: прослушать голос и применить значения, которые живут в окне.
function initSettings({ previewVoice, onSaved }) {
  const q = (s) => document.querySelector(s);
  const root = q('#settings');
  const restartBar = q('#restart-bar');
  const errorBox = q('#settings-error');
  let values = {};

  // --- Вкладки ---
  const tabs = [...document.querySelectorAll('.tab')];
  function showView(view) {
    q('.app').classList.toggle('view-settings', view === 'settings'); // не на body: app.js перезаписывает его класс режима
    root.hidden = view !== 'settings';
    for (const t of tabs) {
      const on = t.dataset.view === view;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', String(on));
    }
    if (view === 'settings') load();
  }
  for (const t of tabs) t.addEventListener('click', () => showView(t.dataset.view));

  // --- Значения ---
  const fields = [...root.querySelectorAll('[data-key]')];
  const format = (key, v) => (key === 'speech.ttsSpeed' ? `×${Number(v).toFixed(2)}` : key === 'speech.vadThreshold' ? Number(v).toFixed(2) : String(v));
  const showOut = (key, v) => {
    const out = root.querySelector(`[data-out="${key}"]`);
    if (out) out.textContent = format(key, v);
  };

  const speakerSelect = q('#speaker-select');
  for (let i = 0; i < 10; i++) speakerSelect.append(new Option(`Голос ${i + 1}`, String(i)));

  function fillModels(models, current, backend) {
    const select = q('#model-select');
    const list = models.includes(current) ? models : [current, ...models];
    select.replaceChildren(...list.map((m) => new Option(m, m)));
    q('#model-hint').textContent =
      backend !== 'ollama'
        ? 'Свою модель можно положить файлом .gguf в папку models/llm. После перезапуска.'
        : models.length
          ? 'Модели, установленные в Ollama.'
          : 'Ollama не отвечает — список моделей недоступен.';
  }

  function fillSkills(skills) {
    const list = q('#skills-list');
    list.replaceChildren(
      ...skills
        .filter((s) => s.id !== 'scenarios') // выученные команды отключать незачем — их можно просто не создавать
        .map((s) => {
          const label = document.createElement('label');
          label.className = 'check';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = s.enabled;
          box.addEventListener('change', () => save({ [`skills.${s.id}`]: box.checked }, () => (box.checked = !box.checked)));
          const text = document.createElement('span');
          text.textContent = s.title.charAt(0).toUpperCase() + s.title.slice(1);
          label.append(box, text);
          return label;
        }),
    );
  }

  async function load() {
    const r = await window.jarvis.settingsGet();
    if (!r) return;
    values = r.values;
    q('#app-version').textContent = r.version || '';
    fillModels(r.models, values.model, values.backend);
    fillSkills(r.skills);
    for (const el of fields) {
      const v = values[el.dataset.key];
      if (el.type === 'checkbox') el.checked = v !== false;
      else if (el === hotkey) el.value = pretty(v);
      else el.value = v ?? '';
      showOut(el.dataset.key, el.value);
    }
  }

  function readField(el) {
    if (el.type === 'checkbox') return el.checked;
    return el.dataset.type === 'number' ? Number(el.value) : el.value.trim();
  }

  async function save(patch, revert) {
    errorBox.hidden = true;
    const r = await window.jarvis.settingsSave(patch);
    if (!r?.ok) {
      errorBox.textContent = r?.error || 'Не удалось сохранить.';
      errorBox.hidden = false;
      revert?.();
      return;
    }
    Object.assign(values, patch);
    if (r.restart) restartBar.hidden = false;
    for (const [key, v] of Object.entries(patch)) onSaved?.(key, v);
  }

  for (const el of fields) {
    if (el.id === 'hotkey-input') continue;
    const key = el.dataset.key;
    if (el.type === 'range') el.addEventListener('input', () => showOut(key, el.value));
    el.addEventListener('change', () => {
      const v = readField(el);
      if (v === '' || v === values[key]) return (el.value = values[key] ?? '');
      save({ [key]: v }, () => {
        if (el.type === 'checkbox') el.checked = values[key] !== false;
        else el.value = values[key];
        showOut(key, el.value);
      });
    });
  }

  // --- Горячая клавиша: запись сочетания ---
  const hotkey = q('#hotkey-input');
  const KEY_NAMES = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '+': 'Plus' };
  // Хранится запись Electron (CommandOrControl+Alt+J), показывается по-человечески: Ctrl + Alt + J
  const pretty = (accel) => String(accel || '').replace('CommandOrControl', 'Ctrl').replace('Super', 'Win').split('+').join(' + ');
  hotkey.addEventListener('focus', () => (hotkey.value = 'Нажмите сочетание…'));
  hotkey.addEventListener('blur', () => (hotkey.value = pretty(values.hotkey)));
  hotkey.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation(); // Esc здесь — отмена записи, а не «скрыть окно»
    if (e.key === 'Escape') return hotkey.blur();
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const mods = [e.ctrlKey && 'CommandOrControl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    const isF = /^F([1-9]|1[0-9]|2[0-4])$/.test(e.key);
    if (!mods.length && !isF) return (hotkey.value = 'Нужен Ctrl, Alt или Shift…');
    const key = KEY_NAMES[e.key] || (e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key);
    const accel = [...mods, key].join('+');
    hotkey.blur();
    hotkey.value = pretty(accel);
    if (accel !== values.hotkey) save({ hotkey: accel }, () => (hotkey.value = pretty(values.hotkey)));
  });

  q('#voice-test').addEventListener('click', (e) => {
    e.preventDefault();
    previewVoice();
  });
  q('#restart').addEventListener('click', () => window.jarvis.restart());
  // Результат проверки показывает полоска под реактором, а вопрос «обновить?» — разговор
  q('#update-check').addEventListener('click', () => {
    showView('chat');
    window.jarvis.updateCheck();
  });

  return { showView };
}
