// Обычные разделы настроек — только описания строк: Основное, Голос, Слух, Модели, Навыки, Тонкая настройка,
// О программе. Разделы со своим видом — в соседних файлах.
import { useState, useSyncExternalStore } from 'react';
import type { Ctx, Page, Row, Values } from '../rows.ts';
import { action, custom, hotkey, range, secret, select, text, toggle } from '../rows.ts';
import { Button } from '../../kit/controls.tsx';

export const general: Page = {
  id: 'general',
  group: 'assistant',
  title: 'Основное',
  icon: 'general',
  description: 'Имя, город, горячая клавиша, вид и мини-плеер радио.',
  sections: [
    {
      rows: [
        text('name', 'Имя ассистента', { hint: 'На него же откликается голосом. После перезапуска.', maxLength: 20 }),
        text('city', 'Город', { hint: 'Для погоды и местного времени.', maxLength: 60 }),
        hotkey('hotkey', 'Горячая клавиша', { hint: 'Нажмите на поле, затем нужное сочетание.', keywords: 'сочетание клавиш вызов' }),
      ],
    },
    {
      title: 'Вид',
      rows: [
        toggle('ui.cube', 'Куб в углу, когда окно скрыто', {
          hint: 'Маленький светящийся куб: цвет — что я делаю, щелчок — открыть окно.',
          keywords: 'куб значок угол свернуть призма',
        }),
        toggle('ui.calm', 'Спокойный режим', {
          hint: 'Без мерцания и развёртки голограммы, куб вращается медленно. Для чувствительных глаз и слабых компьютеров.',
          keywords: 'анимация мерцание движение глаза доступность',
        }),
      ],
    },
    {
      title: 'Радио',
      rows: [
        toggle('radio.player.show', 'Мини-плеер, пока играет радио', {
          hint: 'Маленькое окно в углу экрана. Перетащите его в любой угол или на другой экран — запомнится.',
          keywords: 'радио плеер окно угол',
        }),
      ],
    },
  ],
};

const SPEAKERS = Array.from({ length: 10 }, (_, i) => [i, `Голос ${i + 1}`] as [number, string]);
export const voice: Page = {
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

export const hearing: Page = {
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
          { hint: 'Голоса записываются в окне разговора: меню «⋯» → «Люди и голоса».' },
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

// Модели — цепочка: первой отвечает быстрая; не уверена — большой (локально или глобально); не справилась — запасной
const escalates = (v: Values) => v.escalate !== false;
const local = (v: Values) => escalates(v) && (v.backend === 'llamacpp' || v.backend === 'ollama');
const global = (v: Values) => escalates(v) && v.backend === 'remote';
const backup = (v: Values) => local(v) && v['cloud.enabled'] === true;
const remoteRows = (): Row[] => [
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
  secret('remote.apiKey', 'Ключ API', { hint: 'Хранится зашифрованным на этом компьютере. Пустое поле — ключ не меняется.' }),
];
const REMOTE_NOTE = 'Любой OpenAI-совместимый сервис (OpenRouter, DeepSeek, YandexGPT, LM Studio…) или Anthropic.';
export const models: Page = {
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
        select('model', 'Модель', (s) => s.models.map((m) => [m, m] as [string, string]), {
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

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const skills: Page = {
  id: 'skills',
  group: 'brain',
  title: 'Навыки',
  icon: 'skills',
  description: 'Отключённые навыки пропадут после перезапуска.',
  sections: [
    {
      // Строки — из списка навыков, он приходит из ядра. Выученные команды отключать незачем
      rows: (s) => s.skills.filter((x) => x.id !== 'scenarios').map((x) => toggle(`skills.${x.id}`, capital(x.title), { keywords: x.id })),
    },
  ],
};

export const advanced: Page = {
  id: 'advanced',
  group: 'brain',
  title: 'Тонкая настройка',
  icon: 'advanced',
  description: 'Для тех, кто хочет подкрутить скорость и память.',
  sections: [
    {
      rows: [
        select(
          'planner',
          'Разбор фразы большой моделью',
          [
            ['single', 'Один запрос — точнее и быстрее'],
            ['two-step', 'Два шага: понять задачу, затем инструмент'],
          ],
          { keywords: 'планировщик диспетчер' },
        ),
        range('llmIdleMinutes', 'Выгружать большую модель после простоя', {
          min: 0,
          max: 60,
          step: 1,
          format: (v) => (v ? `${v} мин` : 'никогда'),
          hint: 'Освобождает видеопамять, пока я молчу. После перезапуска.',
          keywords: 'видеопамять память',
        }),
        toggle('brainOffer', 'Предлагать скачать большую модель'),
      ],
    },
  ],
};

function Version({ ctx }: { ctx: Ctx }) {
  const s = useSyncExternalStore(ctx.store.subscribe, ctx.store.getState);
  return <span className="range-value">{s.version}</span>;
}
// Резервная копия: сохранить в файл или восстановить из файла; итог — подписью у кнопок
function Backup({ ctx }: { ctx: Ctx }) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (
    fn: () => Promise<{ ok?: boolean; cancelled?: boolean; error?: string; file?: string }>,
    done: (r: { file?: string }) => string,
  ) => {
    setBusy(true);
    try {
      const r = await fn();
      if (!r?.cancelled) setStatus(r?.ok ? done(r) : r?.error || 'Не получилось.');
    } catch (err) {
      setStatus(String((err as Error)?.message || err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="backup">
      <Button
        disabled={busy}
        onClick={() =>
          void run(
            () => ctx.api.backupExport(),
            (r) => `Сохранено: ${r.file}`,
          )
        }
      >
        Сохранить
      </Button>
      <Button
        disabled={busy}
        onClick={() =>
          void run(
            () => ctx.api.backupImport(),
            () => 'Восстановлено',
          )
        }
      >
        Восстановить
      </Button>
      {status && <span className="row-hint">{status}</span>}
    </span>
  );
}

export const about: Page = {
  id: 'about',
  group: 'system',
  title: 'О программе',
  icon: 'about',
  description: 'Версия, обновления и резервная копия.',
  sections: [
    {
      rows: [
        custom('Версия', Version),
        toggle('updates.notify', 'Сообщать о новой версии при запуске', { hint: 'Спрошу голосом, обновлять ли.' }),
        action('Проверить обновления', ({ api }) => void api.updateCheck(), { button: 'Проверить', hint: 'Результат — в окне разговора.' }),
        action('Перезапустить', ({ api }) => api.restart(), { button: 'Перезапустить' }),
      ],
    },
    {
      title: 'Резервная копия',
      rows: [
        custom('Настройки, память и голоса — одним файлом', Backup, {
          hint: 'Для переезда на другой компьютер. Модели скачаются заново, ключи API там нужно будет ввести снова.',
          keywords: 'резервная копия бэкап перенос экспорт импорт',
        }),
      ],
    },
    {
      title: 'Модели',
      rows: [
        // Условия Gemma (раздел 3.1): получатель модели должен знать об условиях и ограничениях использования
        action('Быстрая модель основана на Gemma', ({ api }) => void api.openLink('https://ai.google.dev/gemma/terms'), {
          button: 'Условия',
          hint: 'FunctionGemma 270M от Google, дообученная для Ориона. Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms.',
        }),
        action('Запрещённые способы использования', ({ api }) => void api.openLink('https://ai.google.dev/gemma/prohibited_use_policy'), {
          button: 'Открыть',
          hint: 'Пользуясь быстрой моделью, вы соглашаетесь их соблюдать.',
        }),
      ],
    },
  ],
};
