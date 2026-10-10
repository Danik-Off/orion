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
    {
      title: 'Ночью',
      rows: [
        toggle('speech.night.enabled', 'Говорить тише ночью', {
          hint: 'Голос и сигнал «слушаю» тише в эти часы. Будильник звенит как обычно.',
          keywords: 'ночь ночной режим тихо громкость шёпот',
        }),
        range('speech.night.from', 'С', { min: 0, max: 23, step: 1, format: (v) => `${v}:00` }),
        range('speech.night.to', 'До', { min: 0, max: 23, step: 1, format: (v) => `${v}:00` }),
        range('speech.night.volume', 'Громкость ночью', { min: 0.1, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` }),
      ],
    },
  ],
};
