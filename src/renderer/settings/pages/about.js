// О программе: версия, обновления, перезапуск
import { toggle, action, custom } from '../rows.js';

const version = () => {
  const out = document.createElement('span');
  out.className = 'row-value';
  return { node: out, refresh: (state) => (out.textContent = state.version || '') };
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
