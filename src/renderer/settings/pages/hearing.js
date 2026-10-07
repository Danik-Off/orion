// Слух: как долго ждать продолжения, насколько чувствительно слушать, кого слушать
import { select, range, toggle } from '../rows.js';

export default {
  id: 'hearing',
  group: 'assistant',
  title: 'Слух',
  icon: 'hearing',
  description: 'Микрофон, продолжение разговора и знакомые голоса.',
  sections: [
    {
      title: 'Разговор',
      rows: [
        range('speech.followUpSeconds', 'Ждать продолжения', {
          min: 3,
          max: 20,
          step: 1,
          format: (v) => `${v} с`,
          hint: 'Сколько после ответа можно говорить без имени.',
        }),
        select(
          'speech.speaker.require',
          'Слушать только знакомые голоса',
          [
            ['off', 'Нет, слушать всех'],
            ['followup', 'В продолжении разговора'],
            ['always', 'Всегда'],
          ],
          { hint: 'Голоса записываются в окне разговора: кнопка «Люди».' },
        ),
      ],
    },
    {
      title: 'Микрофон',
      rows: [
        toggle('speech.listenOnStart', 'Включать микрофон при запуске'),
        range('speech.vadThreshold', 'Чувствительность к тихой речи', {
          min: 0.15,
          max: 0.6,
          step: 0.05,
          format: (v) => v.toFixed(2),
          hint: 'Меньше — слышит тише, но чаще реагирует на шум. После перезапуска.',
        }),
        toggle('speech.echoCancellation', 'Подавлять свой голос из колонок', {
          hint: 'Чтобы можно было перебивать голосом. После перезапуска.',
          keywords: 'эхо',
        }),
      ],
    },
  ],
};
