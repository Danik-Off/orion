// Поиск видео на YouTube без ключа API: страница выдачи содержит данные о видео в JSON (ytInitialData).

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.6',
};

// Разбор выдачи: [{ id, title, channel, seconds }] — только обычные видео (не шортсы, не трансляции)
function parseResults(html) {
  const start = html.indexOf('var ytInitialData = ');
  if (start < 0) return [];
  const end = html.indexOf(';</script>', start);
  let data;
  try {
    data = JSON.parse(html.slice(start + 'var ytInitialData = '.length, end));
  } catch {
    return [];
  }
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object' || out.length >= 10) return;
    if (node.videoRenderer?.videoId) {
      const v = node.videoRenderer;
      const length = v.lengthText?.simpleText; // нет длины — прямая трансляция
      if (length) {
        const seconds = length.split(':').reduce((s, x) => s * 60 + Number(x), 0);
        out.push({
          id: v.videoId,
          title: v.title?.runs?.map((r) => r.text).join('') || '',
          channel: v.ownerText?.runs?.[0]?.text || '',
          seconds,
        });
      }
      return;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(data);
  return out;
}

// Поиск; сбой сети или пустая выдача (YouTube иногда отдаёт страницу без данных) — ещё одна попытка
async function searchVideos(query, { attempts = 2 } = {}) {
  // sp=EgIQAQ%3D%3D — фильтр «только видео»
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`;
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
      const found = res.ok ? parseResults(await res.text()) : [];
      if (found.length || i >= attempts) return found;
    } catch (err) {
      if (i >= attempts) throw err;
    }
  }
}

// Лучшее видео для прослушивания: без шортсов (< 60 с) и без многочасовых записей, если есть выбор
function pickForListening(videos, { mix = false } = {}) {
  const normal = videos.filter((v) => v.seconds >= 60 && (mix || v.seconds <= 15 * 60));
  return normal[0] || videos.find((v) => v.seconds >= 60) || videos[0] || null;
}

// similar — открыть в режиме микса (list=RD…): после этой песни YouTube сам играет похожие
const watchUrl = (id, { similar = false } = {}) => `https://www.youtube.com/watch?v=${id}${similar ? `&list=RD${id}` : ''}`;

module.exports = { searchVideos, pickForListening, watchUrl };
