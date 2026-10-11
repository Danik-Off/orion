// Общие куски окна разговора: реплика ленты, панель с кнопками, полоска «можно без имени»
import { memo, useEffect, useRef, useState } from 'react';
import type { Message, PanelState } from './controller.ts';
import { Button } from '../kit/controls.tsx';
import { CardView } from '../kit/cards.tsx';

// memo: каждое распознанное слово меняет состояние окна — старые реплики при этом не перерисовываются
export const MessageView = memo(function MessageView({
  m,
  onCancel,
  onLink,
  cancelledIds,
}: {
  m: Message;
  onCancel: (id: string) => void;
  onLink: (url: string) => void;
  cancelledIds: Set<string>;
}) {
  if (m.kind === 'muted') return <div className={`msg msg-muted${m.past ? ' past' : ''}`}>{m.text}</div>;
  return (
    <div className={`msg msg-${m.kind}${m.past ? ' past' : ''}`}>
      {m.kind === 'user' && <span className="msg-who">{m.who && m.who !== 'Вы' ? m.who : 'Вы'} ·</span>}
      {m.kind === 'error' && <span className="msg-who">! Ошибка ·</span>}
      <span className="msg-text">{m.text}</span>
      {m.sources?.length ? (
        <span className="msg-sources">
          {m.sources.map((s) => (
            <a
              key={s.url}
              href="#"
              title={s.url}
              onClick={(e) => {
                e.preventDefault();
                onLink(s.url);
              }}
            >
              <span>{s.title || s.url}</span>
            </a>
          ))}
        </span>
      ) : null}
      {m.cards?.map((c, i) => (
        <CardView key={i} card={c} onCancel={onCancel} cancelled={c.type === 'timer' && cancelledIds.has(c.id)} />
      ))}
    </div>
  );
});

export function PanelView({ panel }: { panel: PanelState }) {
  const [value, setValue] = useState(panel.field?.value || '');
  const input = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setValue(panel.field?.value || '');
    // Фокус — в поле, а у модальной панели без поля — на главную кнопку: Enter сразу отвечает
    if (panel.field) setTimeout(() => input.current?.focus(), 0);
    else if (panel.modal) setTimeout(() => body.current?.querySelector<HTMLButtonElement>('button')?.focus(), 0);
  }, [panel]);
  // Модальная панель держит Tab у себя: за ней — шапка и строка ввода, до них сейчас нельзя
  const trap = (e: React.KeyboardEvent) => {
    if (!panel.modal || e.key !== 'Tab') return;
    const items = [...(body.current?.querySelectorAll<HTMLElement>('button, input') || [])];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
    e.preventDefault();
    items[next].focus();
  };
  return (
    <div className="panel-body" ref={body} onKeyDown={trap}>
      <div className="panel-text">{panel.text}</div>
      {panel.field && (
        <input
          ref={input}
          className="field panel-field"
          maxLength={40}
          placeholder={panel.field.placeholder}
          value={value}
          aria-label={panel.field.placeholder || 'Ответ'}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && panel.field?.onEnter?.(value)}
        />
      )}
      <div className={`panel-actions${panel.buttons.length > 2 ? ' many' : ''}`}>
        {panel.buttons.map((b, i) => (
          <Button key={`${i}-${b.label}`} variant={b.primary ? 'primary' : 'secondary'} onClick={() => b.run(value)}>
            {b.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

// Тающая полоска: столько ещё можно говорить без имени. key перезапускает анимацию на каждом продолжении
export function FollowBar({ follow }: { follow: { key: number; ms: number } | null }) {
  if (!follow) return null;
  return (
    <span className="follow-bar" key={follow.key}>
      <span style={{ animationDuration: `${follow.ms}ms` }} />
    </span>
  );
}
