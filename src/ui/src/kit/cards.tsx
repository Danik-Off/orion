// Карточки в ответах — проекции: погода (сейчас и по дням), таймер / напоминание / будильник с живым отсчётом,
// чип в полоске «Запланировано». Данные приходят от навыков; текст — только текстом, никакого HTML.
import { useEffect, useState } from 'react';
import type { CardData, TimerCardData, WeatherCardData } from '../bridge.ts';
import { degreesText, timeText, whenLabel } from '../lib/format.ts';
import { Icon, type IconName } from './Icon.tsx';
import { Button } from './controls.tsx';
import { Label } from './Holo.tsx';

const WEATHER_ICONS: Record<string, IconName> = {
  clear: 'clear',
  partly: 'partly',
  cloud: 'cloud',
  fog: 'fog',
  rain: 'rain',
  snow: 'snow',
  storm: 'storm',
};
const KIND_ICONS: Record<TimerCardData['kind'], IconName> = { timer: 'timer', reminder: 'bell', alarm: 'alarm' };

// Текущее время раз в секунду — пока карточке есть что отсчитывать
export function useNow(active = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function WeatherCard({ card, compact = false }: { card: WeatherCardData; compact?: boolean }) {
  const days = (card.days || []).slice(0, compact ? 3 : 4);
  return (
    <div className="card card-weather">
      <Label>◆ Погода · {card.city}</Label>
      {card.now && (
        <div className="w-now">
          <Icon name={WEATHER_ICONS[card.now.icon] || 'cloud'} size={compact ? 36 : 44} className="w-icon" />
          <span className="num-big">{degreesText(card.now.temp)}</span>
          <span className="w-meta">
            <b>{card.now.desc}</b>
            {card.now.feels != null && <span>ощущается {degreesText(card.now.feels)}</span>}
            {card.now.wind != null && <span>ветер {card.now.wind} м/с</span>}
          </span>
        </div>
      )}
      {days.length > 0 && (
        <div className="w-days">
          {days.map((d) => (
            <div key={d.label} className="w-day" title={d.desc || ''}>
              <span className="w-day-label">{d.label}</span>
              <Icon name={WEATHER_ICONS[d.icon] || 'cloud'} size={20} />
              <span className="w-day-temp">
                {degreesText(d.max)} <small>{degreesText(d.min)}</small>
              </span>
              {d.rain != null && d.rain >= 30 && <span className="w-day-rain">{d.rain}%</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TimerCard({
  card,
  onCancel,
  cancelled = false,
}: {
  card: TimerCardData;
  onCancel?: (id: string) => void;
  cancelled?: boolean;
}) {
  const now = useNow(!cancelled && card.at > Date.now());
  const done = card.at <= now;
  const left = cancelled ? 'отменено' : done ? 'сейчас' : timeText(card.at, now);
  return (
    <div className={`card card-timer${done ? ' done' : ''}${cancelled ? ' cancelled' : ''}`}>
      <Icon name={KIND_ICONS[card.kind] || 'timer'} size={22} className="t-icon" />
      <span className="t-body">
        <span className="t-label">{card.label}</span>
        <span className="t-when">{[whenLabel(card.at, now), card.repeat].filter(Boolean).join(' · ')}</span>
      </span>
      <span className="t-left">{left}</span>
      {onCancel && !done && !cancelled && (
        <Button variant="secondary" onClick={() => onCancel(card.id)}>
          Отменить
        </Button>
      )}
    </div>
  );
}

export function CardView({
  card,
  onCancel,
  cancelled,
  compact,
}: {
  card: CardData;
  onCancel?: (id: string) => void;
  cancelled?: boolean;
  compact?: boolean;
}) {
  if (card.type === 'weather') return <WeatherCard card={card} compact={compact} />;
  if (card.type === 'timer' && Number.isFinite(card.at)) return <TimerCard card={card} onCancel={onCancel} cancelled={cancelled} />;
  return null;
}

// Чип «Запланировано»: значок, сколько осталось (или когда), подпись, крестик
export function ScheduleChip({ item, onCancel }: { item: TimerCardData; onCancel: (id: string) => void }) {
  const now = useNow(item.at > Date.now());
  return (
    <span className="sched" title={[item.label, whenLabel(item.at, now), item.repeat].filter(Boolean).join(' · ')}>
      <Icon name={KIND_ICONS[item.kind] || 'timer'} size={14} />
      <span className="sched-left">{item.at <= now ? 'сейчас' : timeText(item.at, now).replace(' в ', ' ')}</span>
      <span className="sched-label">{item.label}</span>
      <button type="button" className="sched-x" aria-label={`Отменить: ${item.label}`} onClick={() => onCancel(item.id)}>
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}
