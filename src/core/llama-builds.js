// Версии llama.cpp: какая стоит, какая новее на GitHub, какие лежат в папке моделей.
// Сборки выходят несколько раз в час (теги b11500, b11501…) и помечены «prerelease»; «последний релиз»
// репозитория — не сборка. Поэтому берём самую новую b-сборку, где файл для этой машины уже загружен
// целиком: свежая сборка несколько минут докачивает файлы, и брать её рано.
const fs = require('node:fs');
const path = require('node:path');

const RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30';
const BUILD = /^b(\d+)$/;

const buildNumber = (tag) => Number(String(tag).match(BUILD)?.[1] || 0);
const assetName = (tag, variant) => `llama-${tag}-bin-${variant}.${variant.startsWith('win') ? 'zip' : 'tar.gz'}`;

// Ответ GitHub (список релизов) → самая новая полная сборка для variant: { tag, url, size, date } или null
function newestBuild(releases, variant) {
  const builds = (releases || [])
    .filter((r) => BUILD.test(r.tag_name) && !r.draft)
    .sort((a, b) => buildNumber(b.tag_name) - buildNumber(a.tag_name));
  for (const r of builds) {
    const a = (r.assets || []).find((x) => x.name === assetName(r.tag_name, variant) && (x.state ?? 'uploaded') === 'uploaded');
    if (a) return { tag: r.tag_name, url: a.browser_download_url, size: a.size, date: r.published_at };
  }
  return null;
}

async function checkLatest(variant, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'orion-assistant' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub: ${res.status}`);
  return newestBuild(await res.json(), variant);
}

// Сборки в папке моделей: [{ tag, dir }] — новые первыми
function installedBuilds(modelsDir, variant) {
  const root = path.join(modelsDir, 'llama.cpp');
  try {
    return fs
      .readdirSync(root)
      .map((d) => ({ d, tag: d.endsWith(`-${variant}`) ? d.slice(0, -variant.length - 1) : null }))
      .filter((x) => x.tag && BUILD.test(x.tag) && fs.statSync(path.join(root, x.d)).isDirectory())
      .sort((a, b) => buildNumber(b.tag) - buildNumber(a.tag))
      .map((x) => ({ tag: x.tag, dir: path.join(root, x.d) }));
  } catch {
    return [];
  }
}

module.exports = { newestBuild, checkLatest, installedBuilds, buildNumber, assetName };
