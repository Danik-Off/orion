// Каталог программ: псевдонимы из config.json + всё, что есть в меню «Пуск» (включая Microsoft Store).
// Запускаются только ярлыки, которые Windows сама показывает пользователю, — никаких произвольных путей.
const { powershell, asJsonList } = require('./windows');

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

// «телеграм» и «Telegram», «дискорд» и «Discord», «стим» и «Steam» приводятся к одному виду.
function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[а-яё]/g, (c) => TRANSLIT[c])
    .replace(/chr/g, 'hr')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/c(?!h)/g, 'k')
    .replace(/ea|ee/g, 'i')
    .replace(/w/g, 'v')
    .replace(/x/g, 'ks')
    .replace(/y/g, 'i')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function score(query, name) {
  const q = normalize(query);
  const n = normalize(name);
  if (!q || !n) return 0;
  if (n === q) return 100;
  const qc = q.replace(/ /g, '');
  const nc = n.replace(/ /g, '');
  if (nc === qc) return 95;
  if (nc.startsWith(qc)) return 85;
  const words = n.split(' ');
  if (words.includes(q)) return 80;
  if (qc.length >= 4 && nc.includes(qc)) return 70;
  const dist = Math.min(levenshtein(qc, nc), ...words.map((w) => levenshtein(q, w)));
  const tolerance = qc.length >= 8 ? 2 : qc.length >= 5 ? 1 : 0;
  return dist <= tolerance ? 60 - dist * 5 : 0;
}

// Справка, деинсталляторы, ссылки на сайты и служебные пункты в каталог не попадают.
const JUNK_NAME = /uninstall|удал|readme|help|справк|documentation|документац|license|лиценз|website|web site|release notes|virtual network adapter|manual|руководств/i;
const JUNK_TARGET = /^https?:|\.(chm|txt|pdf|html?|url|ini|log|rtf)$/i;

// Список «Пуск» загружается один раз на всё приложение, сколько бы навыков ни создали каталог
let startAppsPromise = null;
const loadStartApps = () => (startAppsPromise ??= fetchStartApps());

async function fetchStartApps() {
  if (process.platform !== 'win32') return [];
  try {
    const list = asJsonList(await powershell('Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress'));
    return list.filter((a) => a?.Name && a?.AppID && !JUNK_NAME.test(a.Name) && !JUNK_TARGET.test(a.AppID));
  } catch {
    return [];
  }
}

function createAppCatalog({ aliases = {}, discover = true }) {
  let startApps = [];
  const ready = discover ? loadStartApps().then((list) => (startApps = list)) : Promise.resolve();

  // Возвращает { name, target } или null. Псевдонимы из config.json важнее найденных программ.
  async function find(query) {
    await ready;
    let best = null;
    const consider = (name, target, bonus) => {
      const s = score(query, name);
      if (s && (!best || s + bonus > best.score || (s + bonus === best.score && name.length < best.name.length))) {
        best = { name, target, score: s + bonus };
      }
    };
    for (const [name, target] of Object.entries(aliases)) consider(name, target, 10);
    for (const app of startApps) consider(app.Name, `shell:AppsFolder\\${app.AppID}`, 0);
    return best;
  }

  return { find, ready, count: () => startApps.length };
}

module.exports = { createAppCatalog, normalize, score, levenshtein };
