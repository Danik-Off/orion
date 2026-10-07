// Навыки: что ассистент умеет; выключенные пропадут после перезапуска
import { toggle } from '../rows.js';

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export default {
  id: 'skills',
  group: 'brain',
  title: 'Навыки',
  icon: 'skills',
  description: 'Отключённые навыки пропадут после перезапуска.',
  sections: [
    {
      // Строки — из списка навыков: он приходит из ядра
      rows: (state) =>
        state.skills
          .filter((s) => s.id !== 'scenarios') // выученные команды отключать незачем — их можно просто не создавать
          .map((s) => toggle(`skills.${s.id}`, capital(s.title), { keywords: s.id, enabled: s.enabled })),
    },
  ],
};
