// Модели на компьютере: какая используется, что скачано (использовать, удалить), каталог проверенных моделей
// (скачать с ходом и отменой; видно, поместится ли в видеокарту), своя модель — ссылкой или файлом,
// и движок llama.cpp: версия, обновление, откат. Ход загрузок приходит от ядра сам (onModelsChanged).
import { el, button, row, section, actions, redrawSafely } from '../ui.js';

export default {
  id: 'library',
  group: 'brain',
  title: 'Модели на компьютере',
  icon: 'library',
  description: 'Скачать другую большую модель, переключиться, удалить лишние; обновить llama.cpp.',
  keywords: 'модель qwen gemma скачать удалить gguf hugging face llama.cpp обновить версия движок видеокарта',
  render,
};

const FITS = {
  gpu: 'поместится в видеокарту',
  partial: 'больше видеопамяти — часть посчитает процессор, ответы медленнее',
};

function render({ api }) {
  const body = el('div');
  let data = null;
  let link = '';
  const { busyButton, showError } = actions(
    () => draw(),
    (r) => r.models && (data = r),
  );

  // Пояснение модели: о чём она, размер, поместится ли
  const hintOf = (m) =>
    [m.about, m.score, m.size, m.fits && FITS[m.fits], m.license && `лицензия ${m.license}`].filter(Boolean).join(' · ');

  const progress = (m) => {
    const bar = el('div', 'progress');
    const fill = el('span');
    fill.style.width = `${m.downloading}%`;
    bar.append(fill);
    return [bar, el('span', 'row-value', `${m.downloading}%`)];
  };

  function modelRow(m) {
    const r = row(m.title, hintOf(m));
    for (const tag of m.tags) r.text.querySelector('.row-label').append(el('span', 'model-tag', tag));
    if (m.fits === 'partial') r.hint.classList.add('warn');
    if (m.downloading !== null) {
      r.box.append(
        ...progress(m),
        button('Отменить', () => api.modelsCancel(m.id)),
      );
    } else if (m.active) {
      r.box.append(el('span', 'status-ok', 'используется'));
    } else if (m.installed) {
      r.box.append(
        busyButton(`use:${m.id}`, 'Использовать', 'Переключаю…', () => api.modelsUse(m.id), { primary: true }),
        busyButton(`remove:${m.id}`, 'Удалить', 'Удаляю…', () => api.modelsRemove(m.id)),
      );
    } else {
      r.box.append(busyButton(`get:${m.id}`, 'Скачать', 'Начинаю…', () => api.modelsDownload(m.id), { primary: true }));
    }
    if (m.error) {
      r.hint.textContent = m.error;
      r.hint.classList.add('warn');
      r.box.append(button('Убрать', () => api.modelsCancel(m.id)));
    }
    showError(r, `use:${m.id}`, `remove:${m.id}`, `get:${m.id}`);
    return r.node;
  }

  function engine() {
    const e = data.engine;
    const rows = [];
    const current = row(
      `llama.cpp ${e.build}`,
      `Сборка для этой машины: ${e.variant}.${data.vram ? ` Видеокарта: ${data.vram.title}, ${data.vram.size}.` : ''}`,
    );
    if (e.updating)
      current.box.append(...progress({ downloading: e.updating.progress }), el('span', 'row-hint', `ставлю ${e.updating.tag}…`));
    else if (e.newer)
      current.box.append(busyButton('update', `Обновить до ${e.latest.tag}`, 'Обновляю…', () => api.engineUpdate(), { primary: true }));
    else
      current.box.append(
        busyButton('check', e.latest ? 'Последняя версия · проверить снова' : 'Проверить обновления', 'Проверяю…', () => api.engineCheck()),
      );
    if (e.latest && e.newer)
      current.hint.textContent += ` Новая сборка ${e.latest.tag} от ${new Date(e.latest.date).toLocaleDateString('ru-RU')}.`;
    if (e.error) {
      current.hint.textContent = e.error;
      current.hint.classList.add('warn');
    }
    showError(current, 'update', 'check');
    rows.push(current.node);
    if (e.previous) {
      const back = row(`Вернуть ${e.previous}`, 'Если с новой сборкой что-то не так — прежняя хранится рядом.');
      back.box.append(busyButton('rollback', 'Вернуть', 'Возвращаю…', () => api.engineRollback()));
      showError(back, 'rollback');
      rows.push(back.node);
    }
    return section('Движок llama.cpp', 'Новая сборка ставится рядом и пробно запускается; не запустилась — остаётся прежняя.', rows);
  }

  function custom() {
    const input = el('input', 'input');
    Object.assign(input, { placeholder: 'https://huggingface.co/…/модель.gguf', spellcheck: false, value: link });
    input.addEventListener('input', () => (link = input.value));
    const byLink = row('По ссылке', 'Страница файла .gguf на Hugging Face или ссылка «Download».', [input], true);
    byLink.box.append(
      busyButton('link', 'Скачать', 'Начинаю…', async () => {
        const r = await api.modelsLink(link);
        if (r?.ok) link = '';
        return r;
      }),
    );
    showError(byLink, 'link');
    const byFile = row('Файл с диска', 'Уже скачанная модель .gguf — места заново не займёт, если она на том же диске.');
    byFile.box.append(busyButton('file', 'Выбрать файл…', 'Добавляю…', () => api.modelsImport()));
    showError(byFile, 'file');
    return section('Своя модель', 'Подойдёт любая модель GGUF с чат-шаблоном; Орион проверен на моделях из каталога.', [
      byLink.node,
      byFile.node,
    ]);
  }

  function draw() {
    if (!data) return;
    const parts = [];
    if (data.backend !== 'llamacpp') {
      const r = row(
        'Сейчас большая модель — не на этом компьютере',
        'Модели отсюда работают во встроенном llama.cpp. «Использовать» переключит большую модель на него.',
      );
      parts.push(section('Обратите внимание', null, [r.node]));
    }
    const installed = data.models.filter((m) => m.installed || (m.custom && m.downloading !== null));
    const catalog = data.models.filter((m) => !m.installed && !m.custom);
    if (installed.length) parts.push(section('Скачано', null, installed.map(modelRow)));
    parts.push(
      section(
        'Каталог',
        '«Понимает N% команд» — замер в Орионе на 108 командах (RTX 5070). Своя модель — ниже, по ссылке или файлом.',
        catalog.map(modelRow),
      ),
    );
    parts.push(custom(), engine());
    body.replaceChildren(...parts);
  }

  const off = api.onModelsChanged?.((r) => {
    data = r;
    redrawSafely(body, draw);
  });
  api.modelsList().then((r) => {
    data = r;
    draw();
  });
  return { node: body, refresh: () => {}, dispose: () => off?.() };
}
