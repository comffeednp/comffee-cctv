// A strip of the last 30 days (the location's calendar), days with footage marked. Scrolls inside itself;
// arrow keys move between days.

import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { TargetedKeyboardEvent } from 'preact';

export interface DayStripProps {
  /** "YYYY-MM-DD", oldest first. */
  days: readonly string[];
  marked: ReadonlySet<string>;
  selected: string;
  today: string;
  onSelect: (day: string) => void;
}

function noonOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 12);
}

export function DayStrip({ days, marked, selected, today, onSelect }: DayStripProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const weekday = useMemo(() => new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }), []);
  const fullDate = useMemo(() => new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }), []);
  const focusDay = days.includes(selected) ? selected : days[days.length - 1];

  // Keep the chosen day in sight (the newest days sit at the right end).
  useEffect(() => {
    const list = listRef.current;
    const button = list?.querySelector<HTMLButtonElement>(`button[data-day="${focusDay}"]`);
    if (!list || !button) return;
    const left = button.offsetLeft - list.clientWidth / 2 + button.offsetWidth / 2;
    list.scrollLeft = Math.max(0, left);
  }, [focusDay, days.length]);

  const onKeyDown = (event: TargetedKeyboardEvent<HTMLDivElement>) => {
    const index = days.indexOf((event.target as HTMLElement).dataset?.day ?? '');
    if (index < 0) return;
    let next = index;
    if (event.key === 'ArrowLeft') next = index - 1;
    else if (event.key === 'ArrowRight') next = index + 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = days.length - 1;
    else return;
    event.preventDefault();
    next = Math.max(0, Math.min(days.length - 1, next));
    listRef.current?.querySelector<HTMLButtonElement>(`button[data-day="${days[next]}"]`)?.focus();
  };

  return (
    <div ref={listRef} class="day-strip" role="group" aria-label="Last 30 days" onKeyDown={onKeyDown}>
      {days.map((day) => {
        const has = marked.has(day);
        const ms = noonOf(day);
        return (
          <button
            key={day}
            type="button"
            class="cal-day day-chip"
            data-day={day}
            tabIndex={day === focusDay ? 0 : -1}
            aria-pressed={day === selected ? 'true' : 'false'}
            aria-current={day === today ? 'date' : undefined}
            aria-label={`${day === today ? 'Today, ' : ''}${fullDate.format(ms)}${has ? ', has footage' : ''}`}
            onClick={() => onSelect(day)}
          >
            <span class="k-xs day-chip-weekday">{weekday.format(ms)}</span>
            <span class="tnum">{Number(day.slice(8))}</span>
            {has && <span class="cal-day-mark" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}
