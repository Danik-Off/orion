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
  mcpRemove: (name) => ipcRenderer.invoke('jarvis:mcp-remove', String(name)),
  mcpTrust: (name, trust) => ipcRenderer.invoke('jarvis:mcp-trust', String(name), trust === true),
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
