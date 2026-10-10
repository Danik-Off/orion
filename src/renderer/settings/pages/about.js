// О программе: версия, обновления, перезапуск, резервная копия
import { toggle, action, custom } from '../rows.js';

const version = () => {
  const out = document.createElement('span');
  out.className = 'row-value';
  return { node: out, refresh: (state) => (out.textContent = state.version || '') };
};

// Резервная копия: сохранить в файл или восстановить из файла; итог — подписью рядом с кнопками
const backup = ({ api }) => {
  const box = document.createElement('div');
  box.className = 'backup-row';
  const status = document.createElement('span');
  status.className = 'row-hint';
  const button = (label, run) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = label;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await run();
        if (!r?.cancelled) status.textContent = r?.ok ? r.message : r?.error || 'Не получилось.';
      } catch (err) {
        status.textContent = String(err?.message || err);
      } finally {
        b.disabled = false;
      }
    });
    return b;
  };
  box.append(
    button('Сохранить', async () => {
      const r = await api.backupExport();
      return r?.ok ? { ok: true, message: `Сохранено: ${r.file}` } : r;
    }),
    button('Восстановить', () => api.backupImport()),
    status,
  );
  return { node: box, refresh: () => {} };
};

export default {
  id: 'about',
  group: 'system',
  title: 'О программе',
  icon: 'about',
  description: 'Версия и обновления.',
  sections: [
    {
      rows: [
        custom('Версия', version),
        toggle('updates.notify', 'Сообщать о новой версии при запуске', { hint: 'Спрошу голосом, обновлять ли.' }),
        action('Проверить обновления', ({ api }) => api.updateCheck(), { button: 'Проверить', hint: 'Результат — в окне разговора.' }),
        action('Перезапустить', ({ api }) => api.restart(), { button: 'Перезапустить' }),
      ],
    },
    {
      title: 'Резервная копия',
      rows: [
        custom('Настройки, память и голоса — одним файлом', backup, {
          hint: 'Для переезда на другой компьютер. Модели скачаются заново, ключи API там нужно будет ввести снова.',
          keywords: 'резервная копия бэкап перенос экспорт импорт',
        }),
      ],
    },
    {
      title: 'Модели',
      rows: [
        // Условия Gemma (раздел 3.1): получатель модели должен знать об условиях и ограничениях использования
        action('Быстрая модель основана на Gemma', ({ api }) => api.openLink('https://ai.google.dev/gemma/terms'), {
          button: 'Условия',
          hint: 'FunctionGemma 270M от Google, дообученная для Ориона. Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms.',
        }),
        action('Запрещённые способы использования', ({ api }) => api.openLink('https://ai.google.dev/gemma/prohibited_use_policy'), {
          button: 'Открыть',
          hint: 'Пользуясь быстрой моделью, вы соглашаетесь их соблюдать.',
        }),
      ],
    },
  ],
};
