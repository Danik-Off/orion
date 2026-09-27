// Подставной мост для скриншотов: интерфейс настоящий, а ядра нет — данные приходят из scripts/screenshots.js.
const { contextBridge, ipcRenderer } = require('electron');

const data = ipcRenderer.sendSync('demo:data');
const handlers = {};
const on = (name) => (cb) => (handlers[name] = cb);
const none = async () => null;

contextBridge.exposeInMainWorld('jarvis', {
  ask: () => new Promise(() => {}),
  onSayPart: on('sayPart'),
  onFiller: on('filler'),
  openLink: none,
  settings: async () => data.settings,
  settingsGet: async () => data.settingsGet,
  settingsSave: async () => ({ ok: true }),
  restart: () => {},
  replyConfirm: () => {},
  reset: () => {},
  cancel: () => {},
  dialogEnd: () => {},
  presence: () => {},
  orbHeight: () => {},
  onConfirm: on('confirm'),
  onStatus: on('status'),
  onFocus: on('focus'),
  onMode: on('mode'),
  onSetup: on('setup'),
  onSetupOffer: on('setupOffer'),
  setupAnswer: () => {},
  onUpdate: on('update'),
  updateCheck: none,
  sendAudio: () => {},
  micReset: () => {},
  setListening: () => {},
  synth: none,
  onRemind: on('remind'),
  onSessionEnd: on('sessionEnd'),
  onToggleMic: on('toggleMic'),
  onHeard: on('heard'),
  people: async () => data.settings.speaker,
  enrollStart: async () => ({ needed: 4 }),
  enrollAdd: none,
  enrollCancel: none,
  enrollFinish: none,
  personUpdate: none,
  personRemove: none,
  wakeLearn: none,
});

// Сцены вызывают события окна так же, как их вызвало бы ядро
contextBridge.exposeInMainWorld('demo', { emit: (name, payload) => handlers[name]?.(payload) });
