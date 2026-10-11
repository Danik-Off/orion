// Зрение: снимок экрана и вопрос к модели по картинке. Снимок не уходит из компьютера — его видит только
// встроенный llama.cpp (Qwen 3.5 с проектором изображений, core/llama.js → vision). Навык — skills/vision.js.
const { download } = require('../core/setup');

// Длинная сторона снимка: на 4K-экране, ужатом до 1280, мелкий текст уже не читается (модель начинает выдумывать);
// 1920 — читается, картинка — ~2,5–3 тыс. токенов, ответ — 3–6 с
const MAX_SIDE = 1920;

function createVision({ electron, config, llama, llm, audit }) {
  let installing = null; // идёт скачивание проектора — второй запрос не начинает его заново

  // Где можно смотреть: только встроенный llama.cpp — у внешней модели по API снимок ушёл бы в сеть
  function status() {
    const v = llama.vision();
    return { ...v, local: (config.backend || 'llamacpp') === 'llamacpp', installing: !!installing };
  }

  // Скачать проектор; сервер с моделью перезапустится уже с ним (при следующем запросе)
  function install(onProgress = () => {}) {
    const v = llama.vision();
    if (!v.supported) return Promise.reject(new Error('У этой модели нет зрения'));
    installing ||= download(v.url, v.file, onProgress)
      .then(() => {
        audit({ vision: 'проектор скачан', file: v.file });
        llama.stop(); // следующий запрос поднимет сервер уже с проектором
      })
      .finally(() => (installing = null));
    return installing;
  }

  // Снимок экрана, на котором сейчас мышь: JPEG data:URL, длинная сторона — не больше MAX_SIDE
  async function capture() {
    const { desktopCapturer, screen } = electron;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const w = display.size.width * display.scaleFactor;
    const h = display.size.height * display.scaleFactor;
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(w * k), height: Math.round(h * k) },
    });
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('Не получилось сделать снимок экрана');
    return `data:image/jpeg;base64,${source.thumbnail.toJPEG(85).toString('base64')}`;
  }

  // Вопрос по картинке: system — роль и правила ответа, question — что спросил человек
  async function ask(image, question, system) {
    if (!llama.vision().loaded) await llama.restart(); // сервер поднят без проектора (скачали только что)
    return llm.chat(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: image } },
            { type: 'text', text: question },
          ],
        },
      ],
      undefined,
      // Короткий ответ и штраф за повторы: зрительная модель на мелком тексте склонна зацикливаться
      { temperature: 0.2, num_predict: 220, repeat_penalty: 1.15, presence_penalty: 0.5 },
    );
  }

  return { status, install, capture, ask };
}

module.exports = { createVision, MAX_SIDE };
