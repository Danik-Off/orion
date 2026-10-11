// Модели на компьютере: какая используется, что скачано (использовать, удалить), каталог проверенных моделей
// (скачать с ходом и отменой; видно, поместится ли в видеокарту), своя модель — ссылкой или файлом,
// и движок llama.cpp: версия, обновление, откат. Ход загрузок приходит от ядра сам (onModelsChanged).
import { useEffect, useState } from 'react';
import type { Ctx, Page } from '../rows.ts';
import { Line, LoadState, Section, useActions } from '../Row.tsx';
import { Button, Progress, TextField } from '../../kit/controls.tsx';

interface Model {
  id: string;
  title: string;
  about?: string;
  score?: string;
  size?: string;
  fits?: 'gpu' | 'partial';
  license?: string;
  tags: string[];
  installed?: boolean;
  active?: boolean;
  custom?: boolean;
  downloading: number | null;
  error?: string;
}
interface Data {
  backend: string;
  models: Model[];
  vram?: { title: string; size: string };
  engine: {
    build: string;
    variant: string;
    updating?: { progress: number; tag: string };
    newer?: boolean;
    latest?: { tag: string; date: string };
    previous?: string;
    error?: string;
  };
}

const FITS = { gpu: 'поместится в видеокарту', partial: 'больше видеопамяти — часть посчитает процессор, ответы медленнее' };
const hintOf = (m: Model) =>
  [m.about, m.score, m.size, m.fits && FITS[m.fits], m.license && `лицензия ${m.license}`].filter(Boolean).join(' · ');

function Library({ ctx }: { ctx: Ctx }) {
  const { api } = ctx;
  const [data, setData] = useState<Data | null>(null);
  const [link, setLink] = useState('');
  const { button, error } = useActions<Data>((r) => r && 'models' in r && setData(r));

  const [failed, setFailed] = useState('');
  const load = () => {
    setFailed('');
    api.modelsList().then(setData, (err: unknown) => setFailed(String((err as Error)?.message || err)));
  };
  useEffect(() => {
    const off = api.onModelsChanged?.((r) => setData(r));
    load();
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- загрузка одна на открытие раздела
  }, [api]);
  if (!data) return <LoadState failed={failed} retry={load} />;

  const row = (m: Model) => {
    const err = m.error || error(`use:${m.id}`, `remove:${m.id}`, `get:${m.id}`);
    return (
      <Line
        key={m.id}
        label={
          <>
            {m.title}
            {m.tags.map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
          </>
        }
        hint={err || hintOf(m)}
        warn={!!err || m.fits === 'partial'}
      >
        {m.downloading !== null ? (
          <>
            <Progress value={m.downloading} />
            <span className="range-value">{m.downloading}%</span>
            <Button onClick={() => void api.modelsCancel(m.id)}>Отменить</Button>
          </>
        ) : m.active ? (
          <span className="status-ok">используется</span>
        ) : m.installed ? (
          <>
            {button(`use:${m.id}`, 'Использовать', 'Переключаю…', () => api.modelsUse(m.id), true)}
            {button(
              `remove:${m.id}`,
              'Удалить',
              'Удаляю…',
              () => api.modelsRemove(m.id),
              false,
              `Точно удалить${m.size ? ` (${m.size})` : ''}?`,
            )}
          </>
        ) : (
          button(`get:${m.id}`, 'Скачать', 'Начинаю…', () => api.modelsDownload(m.id), true)
        )}
        {m.error && <Button onClick={() => void api.modelsCancel(m.id)}>Убрать</Button>}
      </Line>
    );
  };

  const e = data.engine;
  const installed = data.models.filter((m) => m.installed || (m.custom && m.downloading !== null));
  const catalog = data.models.filter((m) => !m.installed && !m.custom);
  return (
    <>
      {data.backend !== 'llamacpp' && (
        <Section title="Обратите внимание">
          <Line
            label="Сейчас большая модель — не на этом компьютере"
            hint="Модели отсюда работают во встроенном llama.cpp. «Использовать» переключит большую модель на него."
          />
        </Section>
      )}
      {installed.length > 0 && <Section title="Скачано">{installed.map(row)}</Section>}
      <Section
        title="Каталог"
        note="«Понимает N% команд» — замер в Орионе на 108 командах (RTX 5070). Своя модель — ниже, по ссылке или файлом."
      >
        {catalog.map(row)}
      </Section>
      <Section title="Своя модель" note="Подойдёт любая модель GGUF с чат-шаблоном; Орион проверен на моделях из каталога.">
        <Line
          label="По ссылке"
          hint={error('link') || 'Страница файла .gguf на Hugging Face или ссылка «Download».'}
          warn={!!error('link')}
          wide
        >
          <TextField
            value={link}
            placeholder="https://huggingface.co/…/модель.gguf"
            aria-label="Ссылка на модель"
            onChange={(ev) => setLink(ev.target.value)}
          />
          {button('link', 'Скачать', 'Начинаю…', async () => {
            const r = await api.modelsLink(link);
            if (r?.ok) setLink('');
            return r;
          })}
        </Line>
        <Line
          label="Файл с диска"
          hint={error('file') || 'Уже скачанная модель .gguf — места заново не займёт, если она на том же диске.'}
          warn={!!error('file')}
        >
          {button('file', 'Выбрать файл…', 'Добавляю…', () => api.modelsImport())}
        </Line>
      </Section>
      <Section title="Движок llama.cpp" note="Новая сборка ставится рядом и пробно запускается; не запустилась — остаётся прежняя.">
        <Line
          label={`llama.cpp ${e.build}`}
          hint={
            e.error ||
            error('update', 'check') ||
            `Сборка для этой машины: ${e.variant}.${data.vram ? ` Видеокарта: ${data.vram.title}, ${data.vram.size}.` : ''}${
              e.latest && e.newer ? ` Новая сборка ${e.latest.tag} от ${new Date(e.latest.date).toLocaleDateString('ru-RU')}.` : ''
            }`
          }
          warn={!!(e.error || error('update', 'check'))}
        >
          {e.updating ? (
            <>
              <Progress value={e.updating.progress} />
              <span className="row-hint">ставлю {e.updating.tag}…</span>
            </>
          ) : e.newer && e.latest ? (
            button('update', `Обновить до ${e.latest.tag}`, 'Обновляю…', () => api.engineUpdate(), true)
          ) : (
            button('check', e.latest ? 'Последняя версия · проверить снова' : 'Проверить обновления', 'Проверяю…', () => api.engineCheck())
          )}
        </Line>
        {e.previous && (
          <Line
            label={`Вернуть ${e.previous}`}
            hint={error('rollback') || 'Если с новой сборкой что-то не так — прежняя хранится рядом.'}
            warn={!!error('rollback')}
          >
            {button('rollback', 'Вернуть', 'Возвращаю…', () => api.engineRollback())}
          </Line>
        )}
      </Section>
    </>
  );
}

export const library: Page = {
  id: 'library',
  group: 'brain',
  title: 'Модели на компьютере',
  icon: 'library',
  description: 'Скачать другую большую модель, переключиться, удалить лишние; обновить llama.cpp.',
  keywords: 'модель qwen gemma скачать удалить gguf hugging face llama.cpp обновить версия движок видеокарта',
  Render: Library,
};
