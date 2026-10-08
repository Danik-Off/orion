// Модели — цепочка: первой всегда отвечает быстрая модель; не уверена — передаёт большой (локально или
// глобально); локальная большая не справилась — запасной внешней.
import { select, text, secret, toggle, range } from '../rows.js';

const escalates = (v) => v.escalate !== false;
const local = (v) => escalates(v) && (v.backend === 'llamacpp' || v.backend === 'ollama');
const global = (v) => escalates(v) && v.backend === 'remote';
const backup = (v) => local(v) && v['cloud.enabled'] === true;

// Поля внешней модели — одни и те же для «глобальной» большой и для запасной
const remoteRows = () => [
  select('remote.type', 'Тип API', [
    ['openai', 'OpenAI-совместимый'],
    ['anthropic', 'Anthropic (Claude)'],
  ]),
  text('remote.baseUrl', 'Адрес API', {
    when: (v) => v['remote.type'] !== 'anthropic',
    placeholder: 'https://openrouter.ai/api/v1',
    allowEmpty: true,
  }),
  text('remote.model', 'Модель', { placeholder: 'например, deepseek-chat или claude-opus-5-5', allowEmpty: true }),
  secret('remote.apiKey', 'Ключ API', { hint: 'Хранится в config.json на этом компьютере. Пустое поле — ключ не меняется.' }),
];
const REMOTE_NOTE = 'Любой OpenAI-совместимый сервис (OpenRouter, DeepSeek, YandexGPT, LM Studio…) или Anthropic.';

export default {
  id: 'models',
  group: 'brain',
  title: 'Модели',
  icon: 'models',
  description: 'Первой всегда отвечает быстрая модель. Не уверена — передаёт задачу дальше по цепочке.',
  keywords: 'gemma qwen ollama большая быстрая запасная подстраховка',
  sections: [
    {
      title: 'Быстрая модель — отвечает первой',
      note: 'Работает всегда: простые команды выполняет сама за десятки миллисекунд.',
      rows: [
        range('router.minConfidence', 'Уверенность, чтобы выполнять без большой модели', {
          min: 0.5,
          max: 0.99,
          step: 0.01,
          format: (v) => v.toFixed(2),
          hint: 'Выше — реже ошибается, чаще передаёт дальше.',
        }),
        toggle('router.collect', 'Записывать примеры для дообучения', { hint: 'Только на этом компьютере.' }),
      ],
    },
    {
      title: 'Если не знаю',
      rows: [
        toggle('escalate', 'Передавать задачу большой модели', {
          hint: (v) => (escalates(v) ? '' : 'Выключено: на сложное я честно скажу, что не умею.'),
          keywords: 'делегировать передавать',
        }),
        select(
          'backend',
          'Большая модель',
          [
            ['llamacpp', 'Локально — Qwen'],
            ['ollama', 'Локально — Ollama'],
            ['remote', 'Глобально — по API'],
          ],
          {
            when: escalates,
            hint: (v) =>
              v.backend === 'remote'
                ? 'Ей уходит весь запрос: фраза, история разговора и то, что я помню о собеседнике.'
                : 'Работает на этом компьютере, без интернета.',
            keywords: 'локально глобально движок',
          },
        ),
        select('model', 'Модель', (state) => state.models.map((m) => [m, m]), {
          when: local,
          hint: (v) =>
            v.backend === 'ollama' ? 'Модели, установленные в Ollama.' : 'Скачанные. Другие — в разделе «Модели на компьютере».',
        }),
        text('ollamaUrl', 'Адрес Ollama', { when: (v) => local(v) && v.backend === 'ollama', placeholder: 'http://127.0.0.1:11434' }),
      ],
    },
    { title: 'Внешняя модель', note: REMOTE_NOTE, when: global, rows: remoteRows() },
    {
      title: 'Подстраховка',
      when: local,
      rows: [
        toggle('cloud.enabled', 'Если и большая модель не справится — передавать запасной', {
          hint: 'Запасная — внешняя модель; её настройки появятся ниже.',
          keywords: 'облако комбинировать удалённая запасная',
        }),
        toggle('cloud.ask', 'Спрашивать разрешение каждый раз', {
          when: backup,
          hint: 'Запасной уходит только сама фраза — без памяти и истории.',
        }),
      ],
    },
    { title: 'Запасная модель', note: REMOTE_NOTE, when: backup, rows: remoteRows() },
  ],
};
