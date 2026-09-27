// Файлы и папки: открыть «Загрузки», «Документы»…, найти файл по названию, показать последний скачанный.
// Найденное показывается в Проводнике; сам файл открывается, только если это документ, картинка или медиа —
// программы и скрипты голосом не запускаются.
const fs = require('node:fs');
const path = require('node:path');
const { powershell } = require('../lib/windows');
const { score } = require('../lib/app-catalog');

// Папки пользователя из реестра: учитывает перенос в OneDrive (Документы → OneDrive\Documents)
const FOLDER_KEYS = {
  desktop: 'Desktop',
  documents: 'Personal',
  pictures: 'My Pictures',
  music: 'My Music',
  videos: 'My Video',
  downloads: '{374DE290-123F-4565-9164-39C4925E467B}',
};
const NAMES = [
  [/загруз|скачан|download/, 'downloads'],
  [/документ|document/, 'documents'],
  [/рабоч|desktop/, 'desktop'],
  [/изображ|картин|фото|pictur/, 'pictures'],
  [/скрин|screenshot/, 'screenshots'],
  [/музык|music/, 'music'],
  [/видео|video|фильм/, 'videos'],
];
const SAFE_TO_OPEN = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|rtf|txt|md|csv|jpe?g|png|gif|webp|bmp|heic|mp3|flac|wav|ogg|m4a|mp4|mkv|avi|mov|webm|epub|fb2|djvu)$/i;

let folders = null;
async function userFolders() {
  if (folders) return folders;
  const out = await powershell(
    "$k = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'; " +
      `@{ ${Object.entries(FOLDER_KEYS).map(([n, k]) => `${n} = [Environment]::ExpandEnvironmentVariables($k.'${k}')`).join('; ')} } | ConvertTo-Json -Compress`,
  ).catch(() => '{}');
  const home = require('node:os').homedir();
  const found = JSON.parse(out.trim() || '{}');
  folders = {
    desktop: found.desktop || path.join(home, 'Desktop'),
    documents: found.documents || path.join(home, 'Documents'),
    pictures: found.pictures || path.join(home, 'Pictures'),
    music: found.music || path.join(home, 'Music'),
    videos: found.videos || path.join(home, 'Videos'),
    downloads: found.downloads || path.join(home, 'Downloads'),
  };
  folders.screenshots = path.join(folders.pictures, 'Screenshots');
  return folders;
}

async function openFolder(arg, ctx) {
  const t = String(arg).toLowerCase();
  const key = NAMES.find(([re]) => re.test(t))?.[1];
  if (!key) return { ok: false, message: 'Могу открыть загрузки, документы, рабочий стол, изображения, скриншоты, музыку или видео, сэр.' };
  const dir = (await userFolders())[key];
  const err = await ctx.openPath(dir);
  return err ? { ok: false, message: 'Не получилось открыть папку, сэр.' } : { ok: true };
}

// Файлы в папке (без подпапок) — от новых к старым
function newest(dir, n = 1) {
  let list = [];
  try {
    list = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !/\.(crdownload|part|tmp)$|^desktop\.ini$/i.test(e.name));
  } catch {
    return [];
  }
  return list
    .map((e) => ({ file: path.join(dir, e.name), time: fs.statSync(path.join(dir, e.name)).mtimeMs }))
    .sort((a, b) => b.time - a.time)
    .slice(0, n);
}

async function reveal(file, ctx, open) {
  const name = path.basename(file);
  if (open && SAFE_TO_OPEN.test(name)) {
    const err = await ctx.openPath(file);
    if (!err) return { ok: true, speak: `Открываю «${name}».` };
  }
  ctx.showItemInFolder(file);
  return { ok: true, speak: `Нашёл «${name}», показываю в папке.` };
}

async function latestDownload(arg, ctx) {
  const [last] = newest((await userFolders()).downloads);
  if (!last) return { ok: false, message: 'В загрузках пусто, сэр.' };
  return reveal(last.file, ctx, /open|откр/i.test(arg));
}

// Поиск по названию в рабочем столе, документах и загрузках (до 4 уровней вглубь)
async function findFile(query, ctx) {
  const q = String(query).replace(/^(open|откр\S*)\s+/i, '').trim();
  if (!q) return { ok: false, message: 'Какой файл найти, сэр?' };
  const f = await userFolders();
  let best = null;
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > 4 || seen > 30_000) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      seen++;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else {
        const s = score(q, e.name.replace(/\.[^.]+$/, ''));
        if (s > 0 && (!best || s > best.s)) best = { s, file: full };
      }
    }
  };
  for (const dir of [f.desktop, f.documents, f.downloads]) walk(dir, 0);
  if (!best) return { ok: false, message: `Не нашёл файл «${q}», сэр.` };
  return reveal(best.file, ctx, /^(open|откр)/i.test(String(query)));
}

module.exports = {
  id: 'files',
  platforms: ['win32'], // PowerShell и программы Windows
  title: 'открыть папку (загрузки, документы, рабочий стол…), найти файл, последний скачанный файл',
  keywords: ['папк', 'загрузк', 'скача', 'документ', 'рабочий стол', 'файл', 'проводник', 'найди файл', 'скриншоты'],
  rules: ['«Что я скачал», «последний скачанный файл» — latest_download (это файлы на компьютере, не поиск в интернете).'],
  tools: [
    {
      name: 'open_folder',
      use: 'открыть папку пользователя',
      arg: 'папка',
      argEnum: ['загрузки', 'документы', 'рабочий стол', 'изображения', 'скриншоты', 'музыка', 'видео'],
      run: openFolder,
    },
    {
      name: 'latest_download',
      use: 'последний скачанный файл',
      arg: 'пусто — показать в папке; "open" — открыть (только документы и медиа)',
      argEnum: ['', 'open'],
      examples: [['открой последний скачанный файл', { addressed: true, say: '', actions: [{ tool: 'latest_download', arg: 'open' }] }]],
      run: latestDownload,
    },
    {
      name: 'find_file',
      use: 'найти файл по названию на компьютере',
      arg: 'часть названия; "open название" — ещё и открыть',
      run: findFile,
    },
  ],
};
