// Голос: каким голосом и как быстро говорит ассистент
import { select, range, toggle, action } from '../rows.js';

const SPEAKERS = Array.from({ length: 10 }, (_, i) => [i, `Голос ${i + 1}`]);

export default {
  id: 'voice',
  group: 'assistant',
  title: 'Голос',
  icon: 'voice',
  description: 'Как звучат ответы.',
  sections: [
    {
      rows: [
        select('speech.ttsSpeaker', 'Голос', SPEAKERS, { number: true }),
        action('Прослушать', ({ api }) => api.previewVoice(), { button: 'Прослушать', hint: 'Прозвучит в окне разговора.' }),
        range('speech.ttsSpeed', 'Скорость речи', { min: 0.6, max: 1.6, step: 0.05, format: (v) => `×${v.toFixed(2)}` }),
        select(
          'speech.ttsSteps',
          'Качество звука',
          [
            [8, 'Быстро'],
            [12, 'Обычно'],
            [16, 'Чисто (медленнее)'],
          ],
          { number: true },
        ),
        toggle('speech.stress', 'Правильные ударения', { hint: '«Замок на двери», «всё готово».', keywords: 'ударение произношение' }),
      ],
    },
  ],
};
