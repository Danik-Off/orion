// Полное окно: шапка (шар, имя, микрофон, звук, настройки, меню «⋯», свернуть, скрыть), шар с табло,
// лента разговора с карточками, подсказки по времени суток, панель (вопросы, люди, установка), «Да / Нет»,
// будильник, «Запланировано» и строка ввода.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Conversation, State } from './controller.ts';
import { Sphere } from '../kit/Sphere.tsx';
import { Holo, Label } from '../kit/Holo.tsx';
import { Button, Chip, IconButton, Progress } from '../kit/controls.tsx';
import { Icon } from '../kit/Icon.tsx';
import { ScheduleChip } from '../kit/cards.tsx';
import { FollowBar, MessageView, PanelView } from './parts.tsx';
import { spinOf, tagOf, toneOf } from './look.ts';

export function FullWindow({ s, c }: { s: State; c: Conversation }) {
  const a = c.actions;
  const tone = toneOf(s.core);
  const talking = s.messages.length > 0;
  const [menu, setMenu] = useState(false);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    if (s.focusInput) input.current?.focus();
  }, [s.focusInput]);

  // Лента держится у нижнего края, пока её не прокрутили вверх
  useLayoutEffect(() => {
    const el = log.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    const el = log.current;
    if (!el) return;
    const ro = new ResizeObserver(() => atBottom.current && (el.scrollTop = el.scrollHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [talking]);

  // Меню закрывается щелчком мимо; открылось — фокус на первом пункте (клавиатурой — сразу стрелками)
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    document.addEventListener('click', close);
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => document.removeEventListener('click', close);
  }, [menu]);
  // Стрелки — по пунктам, Esc — закрыть меню (а не спрятать окно), Tab — уйти из меню
  const menuKeys = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') || [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // окно-обработчик Esc спрятал бы всё окно
      e.nativeEvent.stopImmediatePropagation();
      setMenu(false);
    } else if (e.key === 'Tab') setMenu(false);
  };

  // Отменённые таймеры в ленте приглушаются: их больше нет в «Запланировано», а время ещё не пришло
  const scheduled = useMemo(() => new Set(s.schedule.map((x) => x.id)), [s.schedule]);
  const cancelled = useMemo(() => {
    const out = new Set<string>();
    for (const m of s.messages)
      for (const card of m.cards || [])
        if (card.type === 'timer' && !scheduled.has(card.id) && card.at > Date.now() + 1000) out.add(card.id);
    return out;
  }, [s.messages, scheduled]);

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text;
    setText('');
    a.submitText(t);
  };

  return (
    <div className={`full tone-${tone}${s.calm ? ' calm' : ''}`}>
      <span className="full-scan" aria-hidden="true" />
      <header className="bar">
        <div className="drag" title={s.version}>
          <Sphere size={14} tone={tone} spin={spinOf(s.core)} />
          <span className="bar-name">{s.name}</span>
        </div>
        <div className="tools">
          {s.stt && (
            <IconButton icon={s.micOn ? 'mic' : 'micOff'} label="Микрофон" on={s.micOn} aria-pressed={s.micOn} onClick={a.toggleMic} />
          )}
          <IconButton
            icon={s.voiceOn ? 'sound' : 'soundOff'}
            label="Озвучка ответов"
            on={s.voiceOn}
            aria-pressed={s.voiceOn}
            onClick={a.toggleVoice}
          />
          <IconButton icon="gear" label="Настройки" onClick={() => a.openSettings()} />
          <IconButton
            icon="more"
            label="Ещё"
            on={menu}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={(e) => {
              e.stopPropagation();
              setMenu(!menu);
            }}
          />
          <span className="tools-gap" aria-hidden="true" />
          <IconButton icon="min" label="Свернуть" onClick={a.minimize} />
          <IconButton icon="close" label="Скрыть (Esc)" danger onClick={a.hide} />
        </div>
        {menu && (
          <div className="menu" role="menu" ref={menuRef} onKeyDown={menuKeys}>
            <button type="button" role="menuitem" className="menu-item" onClick={a.reset}>
              <Icon name="new" /> Новый разговор
            </button>
            {s.peopleAvailable && (
              <button type="button" role="menuitem" className="menu-item" onClick={() => void a.people()}>
                <Icon name="owner" /> Люди и голоса
              </button>
            )}
            <button type="button" role="menuitemcheckbox" aria-checked={s.pinned} className="menu-item" onClick={() => a.pin(!s.pinned)}>
              <Icon name="pin" /> Поверх остальных окон
              {s.pinned && <Icon name="check" className="menu-check" />}
            </button>
          </div>
        )}
      </header>

      <section className={`stage${talking ? ' stage-row' : ''}${s.panel && !s.panel.modal ? ' stage-small' : ''}`}>
        <button type="button" className="stage-sphere" aria-label="Говорите" title="Нажмите и говорите" onClick={() => void a.core()}>
          <Sphere
            size={talking ? 36 : s.panel && !s.panel.modal ? 64 : 108}
            tone={tone}
            spin={spinOf(s.core)}
            voice
            dim={s.core === 'off'}
          />
        </button>
        {/* Табло переезжает из-под шара вбок — проявляется на новом месте (key), шар сжимается плавно (Sphere) */}
        <div className="stage-text swap" key={talking ? 'row' : 'column'}>
          {(talking || s.core !== 'idle' || !s.statusHint) && (
            <Label key={tagOf(s.core, !!s.follow)} className="swap">
              {tagOf(s.core, !!s.follow)}
            </Label>
          )}
          {s.status && !(talking && s.statusHint) && <span className={s.statusHint ? 'stage-hint' : 'stage-status'}>{s.status}</span>}
          {s.caption && (
            <span
              key={s.core === 'hearing' ? 'heard' : s.caption}
              className={`stage-caption swap${s.core === 'hearing' ? ' hearing' : ''}`}
            >
              {s.caption}
            </span>
          )}
          <FollowBar follow={s.follow} />
          {s.setup && (
            <button
              type="button"
              className={`setup${s.setup.error ? ' error' : ''}${s.setup.pending ? ' pending' : ''}`}
              onClick={a.setupClick}
            >
              <span className="setup-title">{s.setup.title}</span>
              <Progress value={s.setup.progress * 100} />
            </button>
          )}
        </div>
      </section>

      {talking && (
        <div
          className="log"
          ref={log}
          aria-live="polite"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 6;
          }}
        >
          {s.messages.map((m) => (
            <MessageView key={m.id} m={m} onCancel={a.cancelSchedule} onLink={a.openLink} cancelledIds={cancelled} />
          ))}
        </div>
      )}
      {!talking && <div className="spacer" />}

      {s.showHints && !talking && !s.panel && (
        <div className="hints">
          <Label>Быстрые команды</Label>
          <div className="hints-grid">
            {s.hints.map((h) => (
              <Chip key={h} onClick={() => a.hint(h)}>
                {h}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {s.panel && !s.panel.modal && (
        <Holo className="panel" glass="solid" tone={tone} flicker={false}>
          <PanelView panel={s.panel} />
        </Holo>
      )}

      {s.alarm && (
        <Holo className="alarm" glass="solid" tone="amber">
          <Label>Будильник</Label>
          <span className="alarm-label">{s.alarm.label}</span>
          <div className="row-actions">
            <Button variant="danger" wide onClick={a.alarmStop}>
              Выключить
            </Button>
            <Button wide onClick={a.alarmSnooze}>
              Ещё 10 минут
            </Button>
          </div>
        </Holo>
      )}

      {s.confirm && (
        <Holo className="confirm" glass="solid" tone="amber" flicker={false}>
          <span className="confirm-text">{s.confirm.text}</span>
          <div className="row-actions">
            <Button variant="danger" onClick={() => a.confirm(true)}>
              Да
            </Button>
            <Button onClick={() => a.confirm(false)}>Нет</Button>
          </div>
        </Holo>
      )}

      {s.schedule.length > 0 && (
        <div className="schedule" aria-label="Запланировано">
          {s.schedule.map((item) => (
            <ScheduleChip key={item.id} item={item} onCancel={a.cancelSchedule} />
          ))}
        </div>
      )}

      <form className="composer" onSubmit={send}>
        <span className="composer-prompt" aria-hidden="true">
          &gt;
        </span>
        <input
          ref={input}
          value={text}
          maxLength={1000}
          disabled={s.inputBusy}
          placeholder={`Напишите или скажите «${s.name}…»`}
          aria-label="Сообщение"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="composer-send" aria-label="Отправить">
          <Icon name="send" />
        </button>
      </form>

      {s.panel?.modal && (
        <div className="backdrop">
          <Holo className="panel modal" glass="solid" tone={tone} flicker={false}>
            <PanelView panel={s.panel} />
          </Holo>
        </div>
      )}
    </div>
  );
}
