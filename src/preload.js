const { contextBridge, ipcRenderer } = require('electron');

// Единственный мост между UI и системой. Никакого Node.js в окне.
contextBridge.exposeInMainWorld('jarvis', {
  // source: 'text' | 'wake' | 'hotkey' | 'followup' — как была получена фраза
  // personId: кто говорит (по голосу); null — чужой голос; undefined — не проверялось
  // streamId: номер запроса — предложения разговорного ответа приходят заранее через onSayPart
  ask: (text, source, personId, streamId) =>
    ipcRenderer.invoke(
      'jarvis:ask',
      String(text),
      String(source || 'text'),
      personId === null ? null : personId ? String(personId) : undefined,
      Number.isInteger(streamId) ? streamId : undefined,
    ),
  onSayPart: (cb) => ipcRenderer.on('jarvis:say-part', (_e, p) => cb({ id: Number(p?.id), text: String(p?.text || '') })),
  // «Сейчас поищу.» — сказать сразу, пока работает медленный навык (ответ придёт позже)
  onFiller: (cb) => ipcRenderer.on('jarvis:filler', (_e, p) => cb({ id: Number(p?.id), text: String(p?.text || '') })),
  openLink: (url) => ipcRenderer.invoke('jarvis:open-link', String(url)),
  settings: () => ipcRenderer.invoke('jarvis:settings'),
  // Вкладка «Настройки»: значения, навыки, модели движка и версия; сохранение изменённых полей; перезапуск приложения
  settingsGet: () => ipcRenderer.invoke('jarvis:settings-get'),
  settingsSave: (patch) => ipcRenderer.invoke('jarvis:settings-save', patch && typeof patch === 'object' ? { ...patch } : {}),
  restart: () => ipcRenderer.send('jarvis:restart'),
  // Окно настроек — отдельное: открыть (page — раздел: models, voice…), перейти к разделу, прослушать голос
  openSettings: (page) => ipcRenderer.send('jarvis:open-settings', page ? String(page) : ''),
  onSettingsPage: (cb) => ipcRenderer.on('jarvis:settings-page', (_e, page) => cb(String(page || ''))),
  previewVoice: () => ipcRenderer.send('jarvis:preview-voice'),
  onPreviewVoice: (cb) => ipcRenderer.on('jarvis:preview-voice', () => cb()),
  // Окно разговора узнаёт о сохранённых настройках: { ключ: значение }
  onSettingsChanged: (cb) => ipcRenderer.on('jarvis:settings-changed', (_e, patch) => cb(patch || {})),
  replyConfirm: (id, ok) => ipcRenderer.send('jarvis:confirm-reply', { id: String(id), ok: ok === true }),
  reset: () => ipcRenderer.send('jarvis:reset'),
  cancel: () => ipcRenderer.send('jarvis:cancel'), // оборвать запрос, над которым думает модель
  dialogEnd: () => ipcRenderer.send('jarvis:dialog-end'), // окно продолжения закрылось — диалог окончен
  minimize: () => ipcRenderer.send('jarvis:minimize'),
  pin: (on) => ipcRenderer.send('jarvis:pin', on === true),
  presence: (mode) => ipcRenderer.send('jarvis:presence', String(mode)), // 'full' | 'orb' | 'hidden' | 'collapse' (полное окно → плашка)
  orbHeight: (h) => ipcRenderer.send('jarvis:orb-height', Number(h) || 0), // сколько высоты нужно тексту в плашке
  // Вопрос со свободным ответом (знакомство) и мастер записи голоса по просьбе ядра
  onQuestion: (cb) => ipcRenderer.on('jarvis:question', (_e, msg) => cb(msg && typeof msg === 'object' ? msg : {})),
  replyQuestion: (id, text) =>
    ipcRenderer.send('jarvis:question-reply', { id: String(id), text: text == null ? null : String(text).slice(0, 200) }),
  onEnrollOffer: (cb) => ipcRenderer.on('jarvis:enroll-offer', () => cb()),
  onConfirm: (cb) => ipcRenderer.on('jarvis:confirm', (_e, data) => cb(data)),
  onStatus: (cb) => ipcRenderer.on('jarvis:status', (_e, text) => cb(String(text))),
  onFocus: (cb) => ipcRenderer.on('jarvis:focus', () => cb()),
  onMode: (cb) => ipcRenderer.on('jarvis:mode', (_e, mode) => cb(String(mode))),
  // Установка моделей: этапы и прогресс; возвращает отписку (окно настроек снимает её, уходя со страницы)
  onSetup: (cb) => {
    const listener = (_e, r) => cb(r || {});
    ipcRenderer.on('jarvis:setup', listener);
    return () => ipcRenderer.removeListener('jarvis:setup', listener);
  },
  // Первый запуск: что нужно скачать и сколько весит ({ parts: [{ title, size }], total, ollama }); ответ — да/нет
  onSetupOffer: (cb) => ipcRenderer.on('jarvis:setup-offer', (_e, r) => cb(r || {})),
  setupAnswer: (ok) => ipcRenderer.send('jarvis:setup-answer', ok === true),
  // «Я могу стать умнее»: { size } — сколько весит большая модель; ответ — download | connect | later | never
  onBrainOffer: (cb) => ipcRenderer.on('jarvis:brain-offer', (_e, r) => cb(r || {})),
  brainAnswer: (answer) => ipcRenderer.send('jarvis:brain-answer', String(answer)),
  // Части ассистента для настроек ({ stages: [{ stage, title, installed, size }], installing, brainReady }) и их докачка
  components: () => ipcRenderer.invoke('jarvis:components'),
  // Подключения MCP: каталог и установленные; установка из каталога (inputs — ключ, папки), свой сервер, удаление
  mcpList: () => ipcRenderer.invoke('jarvis:mcp-list'),
  mcpInstall: (id, inputs) =>
    ipcRenderer.invoke('jarvis:mcp-install', String(id), inputs && typeof inputs === 'object' ? { ...inputs } : {}),
  mcpAdd: (name, target) => ipcRenderer.invoke('jarvis:mcp-add', String(name || ''), String(target || '')),
  mcpImport: (text, name) => ipcRenderer.invoke('jarvis:mcp-import', String(text || ''), String(name || '')),
  mcpRemove: (name) => ipcRenderer.invoke('jarvis:mcp-remove', String(name)),
  mcpEnable: (name, on) => ipcRenderer.invoke('jarvis:mcp-enable', String(name), on === true),
  mcpTrust: (name, trust) => ipcRenderer.invoke('jarvis:mcp-trust', String(name), trust === true),
  mcpTool: (name, tool, on) => ipcRenderer.invoke('jarvis:mcp-tool', String(name), String(tool), on === true),
  mcpCheck: (name) => ipcRenderer.invoke('jarvis:mcp-check', String(name)),
  mcpUpdate: (name) => ipcRenderer.invoke('jarvis:mcp-update', String(name)),
  // Модели на компьютере и llama.cpp: список, скачать (из каталога или по ссылке), свой файл, отменить, удалить,
  // использовать; проверить, обновить и откатить llama.cpp. Ход загрузки и состояние — onModelsChanged
  modelsList: () => ipcRenderer.invoke('jarvis:models-list'),
  modelsDownload: (id) => ipcRenderer.invoke('jarvis:models-download', String(id)),
  modelsLink: (link) => ipcRenderer.invoke('jarvis:models-link', String(link || '')),
  modelsImport: () => ipcRenderer.invoke('jarvis:models-import'),
  modelsCancel: (id) => ipcRenderer.invoke('jarvis:models-cancel', String(id)),
  modelsRemove: (id) => ipcRenderer.invoke('jarvis:models-remove', String(id)),
  modelsUse: (id) => ipcRenderer.invoke('jarvis:models-use', String(id)),
  engineCheck: () => ipcRenderer.invoke('jarvis:engine-check'),
  engineUpdate: () => ipcRenderer.invoke('jarvis:engine-update'),
  engineRollback: () => ipcRenderer.invoke('jarvis:engine-rollback'),
  onModelsChanged: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('jarvis:models-changed', handler);
    return () => ipcRenderer.removeListener('jarvis:models-changed', handler);
  },
  // Обновления частей (llama.cpp, быстрая модель, речь, голос, MCP): список, проверить всё, обновить, вернуть
  updatesList: () => ipcRenderer.invoke('jarvis:updates-list'),
  updatesCheck: () => ipcRenderer.invoke('jarvis:updates-check'),
  updatesApply: (id) => ipcRenderer.invoke('jarvis:updates-apply', String(id)),
  updatesRollback: (id) => ipcRenderer.invoke('jarvis:updates-rollback', String(id)),
  onUpdatesChanged: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('jarvis:updates-changed', handler);
    return () => ipcRenderer.removeListener('jarvis:updates-changed', handler);
  },
  // Состояние серверов поменялось (подключился, уснул, ошибка) — окно настроек перерисовывает список
  onMcpChanged: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('jarvis:mcp-changed', handler);
    return () => ipcRenderer.removeListener('jarvis:mcp-changed', handler);
  },
  installComponent: (stage) => ipcRenderer.invoke('jarvis:install-component', String(stage)),
  // Обновления: ход загрузки ({ title, progress, done?, error? }) и проверка по кнопке
  onUpdate: (cb) => ipcRenderer.on('jarvis:update', (_e, r) => cb(r || {})),
  updateCheck: () => ipcRenderer.invoke('jarvis:update-check'),
  // Речь
  sendAudio: (samples) => samples instanceof Float32Array && ipcRenderer.send('jarvis:audio', samples),
  micReset: () => ipcRenderer.send('jarvis:mic-reset'),
  setListening: (on) => ipcRenderer.send('jarvis:listening', on === true), // «жду вас»: слушать без детектора речи
  synth: (text) => ipcRenderer.invoke('jarvis:synth', String(text)),
  onAnnounce: (cb) => ipcRenderer.on('jarvis:announce', (_e, text) => cb(String(text))),
  // Радио в окне разговора: команды из ядра и что сейчас играет
  // Будильник: звонок из ядра и «отложить»
  onAlarm: (cb) => ipcRenderer.on('jarvis:alarm', (_e, msg) => cb(msg && typeof msg === 'object' ? msg : {})),
  alarmSnooze: (payload, minutes) =>
    ipcRenderer.send('jarvis:alarm-snooze', {
      payload: {
        id: Number(payload?.id) || 0,
        label: String(payload?.label || '').slice(0, 80),
        radio: String(payload?.radio || '').slice(0, 80),
      },
      minutes: Number(minutes) || 10,
    }),
  onRadio: (cb) => ipcRenderer.on('jarvis:radio', (_e, msg) => cb(msg && typeof msg === 'object' ? msg : {})),
  radioState: (state) =>
    ipcRenderer.send('jarvis:radio-state', {
      playing: state?.playing === true,
      active: state?.active === true,
      name: String(state?.name || '').slice(0, 120),
    }),
  // Мини-плеер радио: что играет ({ playing, active, name, song, volume, corner }) и кнопки
  onRadioPlayer: (cb) => ipcRenderer.on('jarvis:radio-player', (_e, s) => cb(s && typeof s === 'object' ? s : {})),
  radioControl: (action, value) =>
    ipcRenderer.send('jarvis:radio-control', { action: String(action || '').slice(0, 20), value: Number(value) || 0 }),
  onRemind: (cb) => ipcRenderer.on('jarvis:remind', (_e, text) => cb(String(text))),
  onSessionEnd: (cb) => ipcRenderer.on('jarvis:session-end', (_e, reason) => cb(String(reason || ''))), // разговор забыт — стереть реплики
  onToggleMic: (cb) => ipcRenderer.on('jarvis:toggle-mic', () => cb()),
  // command: текст после имени ассистента; '' — только имя; null — обращения нет
  onHeard: (cb) =>
    ipcRenderer.on('jarvis:heard', (_e, r) =>
      cb({ partial: r?.partial, final: r?.final, command: r?.command ?? null, voice: r?.voice ?? null }),
    ),
  // Люди: запись голоса, имя и обращение
  people: () => ipcRenderer.invoke('jarvis:people'),
  enrollStart: () => ipcRenderer.invoke('jarvis:enroll-start'),
  enrollAdd: (expected) => ipcRenderer.invoke('jarvis:enroll-add', String(expected || '')),
  enrollCancel: () => ipcRenderer.invoke('jarvis:enroll-cancel'),
  enrollFinish: (data) =>
    ipcRenderer.invoke('jarvis:enroll-finish', {
      name: String(data?.name || ''),
      honorific: String(data?.honorific || ''),
      id: data?.id ? String(data.id) : undefined,
    }),
  personUpdate: (id, patch) => ipcRenderer.invoke('jarvis:person-update', String(id), { name: patch?.name, honorific: patch?.honorific }),
  personRemove: (id) => ipcRenderer.invoke('jarvis:person-remove', String(id)),
  wakeLearn: () => ipcRenderer.invoke('jarvis:wake-learn'), // запомнить, как распознаватель слышит имя
});
