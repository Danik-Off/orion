// Компоненты: что скачано и что можно докачать (большую модель — тоже), и обновления частей Ориона —
// llama.cpp, быстрая модель, распознавание, голос, пакеты MCP: «Проверить всё», «Обновить», «Вернуть».
// Ход установки и обновлений приходит от ядра сам (onSetup, onUpdatesChanged).
import { useEffect, useState } from 'react';
import type { Ctx, Page } from '../rows.ts';
import { Line, Section, useActions } from '../Row.tsx';
import { Button, Progress } from '../../kit/controls.tsx';

interface Stage {
  stage: string;
  title: string;
  installed: boolean;
  size?: string;
}
interface Part {
  id: string;
  title: string;
  version?: string;
  latest?: string;
  newer?: boolean;
  previous?: string;
  busy?: { progress: number };
  error?: string;
}
interface Updates {
  checking?: boolean;
  checkedAt?: number;
  updates?: number;
  parts: Part[];
}

function Components({ ctx }: { ctx: Ctx }) {
  const { api } = ctx;
  const [stages, setStages] = useState<Stage[]>([]);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<Record<string, { value: number; title: string }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [updates, setUpdates] = useState<Updates | null>(null);
  const [version, setVersion] = useState('');
  const { button, error } = useActions<Updates>((r) => r && 'parts' in r && setUpdates(r));

  useEffect(() => {
    let current = '';
    const loadParts = async () => {
      const r = await api.components();
      if (!r) return;
      setStages(r.stages);
      setInstalling(!!r.installing);
    };
    void loadParts();
    const offSetup = api.onSetup((r) => {
      if (r.stage) current = r.stage;
      if (current && r.progress != null && !r.done)
        setProgress((p) => ({ ...p, [current]: { value: Math.round((r.progress || 0) * 100), title: r.title || '' } }));
      if (r.done || r.finished) {
        setProgress({});
        void loadParts();
      }
    });
    const offUpdates = api.onUpdatesChanged?.((r) => setUpdates(r));
    void Promise.all([api.updatesList(), api.settingsGet()]).then(([u, s]) => {
      setUpdates(u);
      setVersion(s?.version || '');
    });
    return () => {
      offSetup?.();
      offUpdates?.();
    };
  }, [api]);

  return (
    <>
      <Section title="Установлено">
        {stages.map((c) => (
          <Line
            key={c.stage}
            label={c.title}
            hint={errors[c.stage] || progress[c.stage]?.title || (c.installed ? '' : `Не установлено · ${c.size}`)}
            warn={!!errors[c.stage]}
          >
            {progress[c.stage] && <Progress value={progress[c.stage].value} />}
            {c.installed ? (
              <span className="status-ok">установлено</span>
            ) : (
              <Button
                variant="primary"
                disabled={installing}
                onClick={async () => {
                  setInstalling(true);
                  const res = await api.installComponent(c.stage);
                  if (!res?.ok) {
                    setErrors((e) => ({ ...e, [c.stage]: res?.error || 'Не удалось начать установку.' }));
                    setInstalling(false);
                  }
                }}
              >
                {installing ? 'Скачиваю…' : 'Скачать'}
              </Button>
            )}
          </Line>
        ))}
      </Section>
      {updates && (
        <Section title="Обновления">
          <Line
            label={updates.checking ? 'Проверяю…' : updates.updates ? `Есть обновления: ${updates.updates}` : 'Обновления'}
            hint={
              error('check') ||
              (updates.checkedAt
                ? `Проверено ${new Date(updates.checkedAt).toLocaleString('ru-RU')}.`
                : 'Новая версия ставится рядом и включается, только если запустилась.')
            }
            warn={!!error('check')}
          >
            {button('check', 'Проверить всё', 'Проверяю…', () => api.updatesCheck(), !updates.updates)}
          </Line>
          <Line
            label={`Орион ${version}`}
            hint="Сама программа: о новой версии спрошу голосом при запуске. Итог проверки — в окне разговора."
          >
            <Button onClick={() => void api.updateCheck()}>Проверить</Button>
          </Line>
          {updates.parts.map((p) => {
            const err = p.error || error(`apply:${p.id}`, `back:${p.id}`);
            return (
              <Line
                key={p.id}
                label={p.title}
                dot={p.newer ? 'ok' : undefined}
                hint={err || [p.version, p.newer && p.latest && `доступна ${p.latest}`].filter(Boolean).join(' · ')}
                warn={!!err}
              >
                {p.busy ? (
                  <>
                    <Progress value={p.busy.progress} />
                    <span className="range-value">{p.busy.progress}%</span>
                  </>
                ) : (
                  p.newer && button(`apply:${p.id}`, 'Обновить', 'Обновляю…', () => api.updatesApply(p.id), true)
                )}
                {p.previous && !p.busy && button(`back:${p.id}`, 'Вернуть прежнюю', 'Возвращаю…', () => api.updatesRollback(p.id))}
              </Line>
            );
          })}
        </Section>
      )}
    </>
  );
}

export const components: Page = {
  id: 'components',
  group: 'system',
  title: 'Компоненты',
  icon: 'components',
  description: 'Части ассистента на этом компьютере: докачать недостающее и обновить установленное.',
  keywords: 'скачать установить qwen модель голос слух загрузка обновить обновление версия llama.cpp распознавание',
  Render: Components,
};
