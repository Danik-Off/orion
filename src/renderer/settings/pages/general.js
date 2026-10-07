// Основное: как зовут ассистента, где он находится, как его позвать
import { text, hotkey } from '../rows.js';

export default {
  id: 'general',
  group: 'assistant',
  title: 'Основное',
  icon: 'general',
  description: 'Имя, город и горячая клавиша.',
  sections: [
    {
      rows: [
        text('name', 'Имя ассистента', { hint: 'На него же откликается голосом. После перезапуска.', maxLength: 20 }),
        text('city', 'Город', { hint: 'Для погоды и местного времени.', maxLength: 60 }),
        hotkey('hotkey', 'Горячая клавиша', { hint: 'Нажмите на поле, затем нужное сочетание.', keywords: 'сочетание клавиш вызов' }),
      ],
    },
  ],
};
