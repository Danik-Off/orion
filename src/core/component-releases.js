// Новые версии частей Ориона, которые скачиваются отдельно от программы:
//   - модели речи sherpa-onnx (распознавание, голос): версия — дата в имени
//     «sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16»; та же модель новее — то же имя без даты
//     и более поздняя дата. Другая модель (например, supertonic-3 вместо supertonic) — другое семейство, не «новее»;
//   - быстрая модель orion-router: релизы models-router-v<N> этого проекта, проверка по SHA256SUMS релиза.
// Только разбор ответов GitHub — сеть и установка в app/updates.js.

const DATE = /-(\d{4}-\d{2}-\d{2})(?=\.tar\.bz2$|$)/;
const ARCHIVE = /\.tar\.bz2$/;

const familyOf = (name) => String(name).replace(ARCHIVE, '').replace(DATE, '');
const dateOf = (name) => String(name).match(DATE)?.[1] || '';

// Файлы релиза sherpa-onnx → самая новая модель того же семейства, что current: { name, url, size, date } или null
function newestInFamily(assets, current) {
  const family = familyOf(current);
  const now = dateOf(current);
  if (!now) return null; // версия без даты — сравнивать не с чем
  return (
    (assets || [])
      .filter((a) => ARCHIVE.test(a.name) && familyOf(a.name) === family && dateOf(a.name) > now)
      .map((a) => ({ name: a.name.replace(ARCHIVE, ''), url: a.browser_download_url, size: a.size, date: dateOf(a.name) }))
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0] || null
  );
}

const ROUTER_TAG = /^models-router-v(\d+)$/;
const routerVersion = (tag) => Number(String(tag).match(ROUTER_TAG)?.[1] || 0);
// Без отметки router.release модель ставилась до того, как отметку начали писать, — это v1
const LEGACY_ROUTER_TAG = 'models-router-v1';

// Версия маленькой модели, которая сейчас стоит: router.version (свой файл, замер) или номер из тега её релиза.
// От неё зависит, какие навыки она знает (router: N в навыке) и нужна ли ей строка FunctionGemma в запросе
function installedRouterVersion(config) {
  const r = config?.router || {};
  if (Number.isFinite(r.version)) return r.version;
  return routerVersion(r.release || LEGACY_ROUTER_TAG) || 1;
}

// Релизы проекта → самая новая модель orion-router новее current: { tag, url, sumsUrl, size } или null
function newestRouter(releases, current, file = 'orion-router-q8_0.gguf') {
  return (
    (releases || [])
      .filter((r) => !r.draft && routerVersion(r.tag_name) > routerVersion(current))
      .sort((a, b) => routerVersion(b.tag_name) - routerVersion(a.tag_name))
      .map((r) => {
        const model = (r.assets || []).find((a) => a.name === file);
        const sums = (r.assets || []).find((a) => a.name === 'SHA256SUMS');
        return model && sums
          ? { tag: r.tag_name, url: model.browser_download_url, sumsUrl: sums.browser_download_url, size: model.size }
          : null;
      })
      .find(Boolean) || null
  );
}

// Строка «<sha256>  <файл>» из SHA256SUMS
const shaFor = (sums, file) =>
  String(sums)
    .split('\n')
    .map((l) => l.trim().split(/\s+\*?/))
    .find(([, name]) => name === file)?.[0] || null;

module.exports = { familyOf, dateOf, newestInFamily, newestRouter, routerVersion, installedRouterVersion, LEGACY_ROUTER_TAG, shaFor };
