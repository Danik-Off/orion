// electron-builder afterPack: убрать нативные модули речи чужих ОС и процессоров.
// Сборка для macOS идёт сразу для arm64 и x64 из одной папки node_modules, где лежат оба модуля sherpa-onnx, —
// каждой копии нужен только свой (минус ~30 МБ). Модули вынесены из asar (asarUnpack), поэтому их можно просто удалить.
const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('builder-util');

const PLATFORM = { win32: 'win', darwin: 'darwin', linux: 'linux' };

exports.default = async function afterPack(context) {
  const keep = `sherpa-onnx-${PLATFORM[context.electronPlatformName]}-${Arch[context.arch]}`;
  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources');
  const modules = path.join(resources, 'app.asar.unpacked', 'node_modules');
  if (!fs.existsSync(modules)) return;
  for (const name of fs.readdirSync(modules)) {
    if (/^sherpa-onnx-(win|darwin|linux)-/.test(name) && name !== keep) {
      fs.rmSync(path.join(modules, name), { recursive: true, force: true });
      console.log(`  • убран модуль чужой платформы  name=${name}`);
    }
  }
};
