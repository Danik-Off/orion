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
  ],
};
