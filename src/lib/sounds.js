// Звуки для сна и фона: дождь, море, белый и «тёплый» шум. Их синтезирует само окно (renderer/noise.js) —
// без интернета и без каталога: потоков со звуками природы в каталогах радио мало, и они часто пропадают.
// Играют через тот же проигрыватель, что и радио: «стоп», пауза, громкость, мини-плеер и таймер сна работают так же.
// Станция звука — { name, url: 'sound:<id>' }.
const SOUNDS = [
  { id: 'rain', name: 'Шум дождя', words: /дожд|ливн|ливень|капел/ },
  { id: 'sea', name: 'Шум моря', words: /мор[еяю]|морск|волн|прибо|океан/ },
  { id: 'white', name: 'Белый шум', words: /бел\S* шум/ },
  { id: 'brown', name: 'Тихий шум', words: /коричнев\S* шум|розов\S* шум|тих\S* шум|мягк\S* шум|шум для сна|ровн\S* шум/ },
];
// «звуки природы», «что-нибудь чтобы уснуть под шум» — без уточнения: дождь (его выбирают чаще всего)
const DEFAULT = 'rain';

const norm = (t) =>
  String(t || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .trim();

// Звук по фразе или аргументу: id ('rain'), название или слова («шум моря», «звуки дождя»); null — не звук
function soundOf(text) {
  const t = norm(text);
  if (!t) return null;
  const byId = SOUNDS.find((s) => s.id === t.split('|')[0].trim());
  if (byId) return byId;
  const found = SOUNDS.find((s) => s.words.test(t));
  if (found) return found;
  if (/звук\S* природы|природн\S* звук|шум\S* природы|^шум$|^звуки$/.test(t)) return SOUNDS.find((s) => s.id === DEFAULT);
  return null;
}

const stationOf = (sound) => ({ id: `sound:${sound.id}`, name: sound.name, url: `sound:${sound.id}` });
const isSoundUrl = (url) => /^sound:[a-z]+$/.test(String(url || ''));

module.exports = { SOUNDS, soundOf, stationOf, isSoundUrl };
