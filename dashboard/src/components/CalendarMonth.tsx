import type { TargetedKeyboardEvent } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { cx } from './cx.ts';
import { IconButton } from './IconButton.tsx';

export interface CalendarMonthProps {
  /** The month shown, "YYYY-MM" (the location's calendar). */
  month: string;
  /** The chosen day, "YYYY-MM-DD". */
  selected?: string | null;
  /** Days that have something (recordings), "YYYY-MM-DD"; each gets a small amber mark. */
  marked?: readonly string[];
  /** Today in the location's timezone, "YYYY-MM-DD"; gets a thin ring. */
  today?: string;
  /** Days before `min` or after `max` ("YYYY-MM-DD") cannot be chosen. */
  min?: string;
  max?: string;
  onSelect: (day: string) => void;
  onPrev: () => void;
  onNext: () => void;
  prevDisabled?: boolean;
  nextDisabled?: boolean;
  /** 0 = Sunday (default), 1 = Monday, 6 = Saturday. */
  weekStartsOn?: 0 | 1 | 6;
  /** BCP 47 locale for month and weekday names; defaults to the browser's. */
  locale?: string;
  /** Dims the grid while the marks load. */
  loading?: boolean;
  /** Accessible name of the grid; defaults to the month title. */
  label?: string;
  /** Word added to the accessible name of marked days. Defaults to "has recordings". */
  markedLabel?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

function parseMonth(month: string): { year: number; monthIndex: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) {
    const now = new Date();
    return { year: now.getFullYear(), monthIndex: now.getMonth() };
  }
  return { year: Number(match[1]), monthIndex: Number(match[2]) - 1 };
}

/**
 * A month grid (presentational): the caller owns the month, the marks and the selection. Arrow keys
 * move by day and week inside the month, Home and End go to the week's ends, Enter or Space picks.
 */
export function CalendarMonth(props: CalendarMonthProps) {
  const { month, selected = null, marked, today, min, max, onSelect, onPrev, onNext, weekStartsOn = 0, locale, loading = false } = props;
  const { year, monthIndex } = parseMonth(month);
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const leading = (firstWeekday - weekStartsOn + 7) % 7;
  const markedSet = useMemo(() => new Set(marked ?? []), [marked]);
  const dayKey = (day: number) => `${year}-${pad(monthIndex + 1)}-${pad(day)}`;
  const isDisabled = (key: string) => (min !== undefined && key < min) || (max !== undefined && key > max);

  const title = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(year, monthIndex, 1));
  const weekdayShort = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const weekdayLong = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
  const fullDate = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  // 2023-01-01 was a Sunday: offset from it to name each column.
  const columns = Array.from({ length: 7 }, (_, i) => Date.UTC(2023, 0, 1 + ((weekStartsOn + i) % 7)));

  const initialFocus = (): number => {
    const pick = (key: string | null | undefined) => (key && key.startsWith(`${month}-`) ? Number(key.slice(8)) : 0);
    return pick(selected) || pick(today) || 1;
  };
  const [focusDay, setFocusDay] = useState(initialFocus);
  const gridRef = useRef<HTMLTableElement>(null);
  const moved = useRef(false);

  useEffect(() => {
    setFocusDay(initialFocus());
  }, [month, selected]);

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`button[data-day="${focusDay}"]`)?.focus();
  }, [focusDay]);

  function onKeyDown(event: TargetedKeyboardEvent<HTMLTableElement>): void {
    const deltas: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next = focusDay;
    if (event.key in deltas) next = focusDay + deltas[event.key];
    else if (event.key === 'Home') next = focusDay - ((leading + focusDay - 1) % 7);
    else if (event.key === 'End') next = focusDay + (6 - ((leading + focusDay - 1) % 7));
    else return;
    event.preventDefault();
    next = Math.min(daysInMonth, Math.max(1, next));
    moved.current = true;
    setFocusDay(next);
  }

  const cells: Array<number | null> = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<number | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const markedWord = props.markedLabel ?? 'has recordings';

  return (
    <div class="cal">
      <div class="cal-head">
        <IconButton icon="chevron-left" label="Previous month" disabled={props.prevDisabled} onClick={onPrev} />
        <p class="cal-title" aria-live="polite">
          {title}
        </p>
        <IconButton icon="chevron" label="Next month" disabled={props.nextDisabled} onClick={onNext} />
      </div>
      <table
        ref={gridRef}
        class={cx('cal-grid', loading && 'cal-busy')}
        aria-label={props.label ?? title}
        aria-busy={loading ? 'true' : undefined}
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr>
            {columns.map((ms) => (
              <th key={ms} scope="col" abbr={weekdayLong.format(ms)}>
                {weekdayShort.format(ms)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, w) => (
            <tr key={w}>
              {week.map((day, d) => {
                if (day === null) return <td key={`e${d}`} />;
                const key = dayKey(day);
                const isMarked = markedSet.has(key);
                const disabled = isDisabled(key);
                return (
                  <td key={key}>
                    <button
                      type="button"
                      class="cal-day"
                      data-day={day}
                      tabIndex={day === focusDay ? 0 : -1}
                      aria-pressed={selected === key ? 'true' : 'false'}
                      aria-current={today === key ? 'date' : undefined}
                      aria-label={`${fullDate.format(Date.UTC(year, monthIndex, day))}${isMarked ? `, ${markedWord}` : ''}`}
                      disabled={disabled}
                      onClick={() => {
                        setFocusDay(day);
                        onSelect(key);
                      }}
                    >
                      <span>{day}</span>
                      {isMarked && <span class="cal-day-mark" aria-hidden="true" />}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
