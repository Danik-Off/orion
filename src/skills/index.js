// Список навыков. Явный, а не «всё из папки»: навыки выполняются с правами пользователя,
// поэтому в приложение попадает только то, что перечислено здесь.
// Добавить навык: создать файл по контракту из core/skills.js и дописать его сюда.
// Порядок важен только для быстрых фраз без модели: первым проверяется то, что выше.
// Выученные голосом команды (scenarios) — первыми, чтобы пользователь мог переопределить любую фразу.
module.exports = [
  require('./scenarios'),
  require('./weather'),
  require('./rates'),
  require('./search'),
  require('./apps'),
  require('./music'),
  require('./sound'),
  require('./reminders'),
  require('./notes'),
  require('./memory'),
  require('./web'),
  require('./power'),
  require('./pc'),
  require('./network'),
  require('./screen'),
  require('./files'),
  require('./text'),
  require('./calc'),
  require('./dates'),
  require('./news'),
  require('./briefing'),
  require('./journal'),
  require('./updates'),
  require('./facts'),
  require('./steam'),
  require('./smarthome'),
  require('./delegate'),
];
