import type { TargetedKeyboardEvent, TargetedPointerEvent } from 'preact';
import { useMemo, useRef, useState } from 'preact/hooks';
import { cx } from './cx.ts';

export interface TimelineBlock {
  /** Unix milliseconds. */
  start: number;
  end: number;
  /** default = amber (recorded); muted = mocha (for example another camera). */
  tone?: 'default' | 'muted';
}

export interface TimelineTrackProps {
  /** Unix ms of the day's first instant in the location's timezone. */
  dayStart: number;
  /** Unix ms of the next day's first instant; defaults to dayStart + 24 h (pass it on daylight-saving days). */
  dayEnd?: number;
  /**
   * The part of the day on screen (zoom), unix ms. Defaults to the whole day. Ticks and labels follow the span:
   * hours for a long window, quarter hours for a short one.
   */
  viewStart?: number;
  viewEnd?: number;
  /** Recorded spans; anything outside the day is clipped, touching spans are merged. */
  blocks: readonly TimelineBlock[];
  /** Playback position (unix ms), drawn as a cream line. */
  cursor?: number | null;
  /** IANA timezone of the location, for the hour labels. */
  timeZone?: string;
  /** BCP 47 locale for the hour labels; defaults to the browser's. */
  locale?: string;
  /** Called with the unix ms under a click or where a drag was let go, or the new position after a key press. */
  onPick: (time: number) => void;
  /** Called while the mouse or a finger drags along the track (the cursor follows it); null when the drag ends. */
  onScrub?: (time: number | null) => void;
  /** Accessible name ("Front door, 12 November"). */
  label: string;
  disabled?: boolean;
  class?: string;
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

interface Scale {
  tick: number;
  label: number;
  /** Labels on this step stay on phones; the others hide below 640 px. */
  major: number;
  /** Labels with minutes ("3:15 PM") instead of whole hours ("3 PM"). */
  minutes: boolean;
}

function scaleFor(span: number): Scale {
  if (span > 12 * HOUR) return { tick: HOUR, label: 3 * HOUR, major: 6 * HOUR, minutes: false };
  if (span > 2 * HOUR) return { tick: HOUR, label: HOUR, major: 2 * HOUR, minutes: false };
  return { tick: 5 * MINUTE, label: 15 * MINUTE, major: 30 * MINUTE, minutes: true };
}

/** Instants from `from` (inclusive) to `to` (exclusive) that sit a whole number of `step`s after `origin`. */
function steps(origin: number, from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let t = origin + Math.ceil((from - origin) / step) * step; t < to; t += step) out.push(t);
  return out;
}

/**
 * A 24 hour track (presentational): recorded blocks, ticks with labels and the playback cursor, optionally
 * zoomed to part of the day. Click or drag picks a time. It is a slider for the keyboard: arrows move 1 minute
 * (Shift: 10), Page Up and Page Down 1 hour, Home and End the day's ends.
 */
export function TimelineTrack(props: TimelineTrackProps) {
  const { dayStart, blocks, cursor = null, timeZone, locale, onPick, onScrub, label, disabled = false, class: className } = props;
  const dayEnd = props.dayEnd ?? dayStart + 24 * HOUR;
  const viewStart = Math.max(dayStart, Math.min(props.viewStart ?? dayStart, dayEnd - MINUTE));
  const viewEnd = Math.min(dayEnd, Math.max(props.viewEnd ?? dayEnd, viewStart + MINUTE));
  const span = viewEnd - viewStart;
  const pct = (t: number) => `${(((t - viewStart) / span) * 100).toFixed(4)}%`;
  const [scrub, setScrub] = useState<number | null>(null);
  const drag = useRef<number | null>(null);

  const merged = useMemo(() => {
    const minGap = (dayEnd - dayStart) / 1000;
    const clipped = blocks
      .map((b) => ({ start: Math.max(b.start, dayStart), end: Math.min(b.end, dayEnd), tone: b.tone ?? 'default' }))
      .filter((b) => b.end > b.start)
      .sort((a, b) => a.start - b.start);
    const out: Array<{ start: number; end: number; tone: 'default' | 'muted' }> = [];
    for (const b of clipped) {
      const last = out[out.length - 1];
      if (last && last.tone === b.tone && b.start - last.end <= minGap) last.end = Math.max(last.end, b.end);
      else out.push({ ...b });
    }
    return out;
  }, [blocks, dayStart, dayEnd]);

  const shown = merged
    .map((b) => ({ ...b, start: Math.max(b.start, viewStart), end: Math.min(b.end, viewEnd) }))
    .filter((b) => b.end > b.start);

  const hourFormat = useMemo(() => new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone }), [locale, timeZone]);
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }), [locale, timeZone]);
  const scale = scaleFor(span);
  const ticks = steps(dayStart, viewStart, viewEnd, scale.tick).filter((t) => t > viewStart);
  // Labels sit centred on their instant, so none goes so close to an edge that it would stick out.
  const labels = steps(dayStart, viewStart, viewEnd, scale.label).filter((t) => {
    const at = (t - viewStart) / span;
    return t === viewStart || (at >= 0.06 && at <= 0.9);
  });

  const clamp = (t: number) => Math.min(dayEnd - 1000, Math.max(dayStart, t));
  const position = scrub ?? cursor;
  const current = position === null ? viewStart : clamp(position);
  const cursorShown = position !== null && current >= viewStart && current <= viewEnd;

  const timeAt = (clientX: number, element: HTMLElement): number | null => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return clamp(Math.round((viewStart + ratio * span) / 1000) * 1000);
  };

  function onPointerDown(event: TargetedPointerEvent<HTMLDivElement>): void {
    if (disabled || event.button !== 0) return;
    const time = timeAt(event.clientX, event.currentTarget);
    if (time === null) return;
    drag.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a nicety; the drag still works while the pointer stays on the track.
    }
    setScrub(time);
    onScrub?.(time);
  }

  function onPointerMove(event: TargetedPointerEvent<HTMLDivElement>): void {
    if (drag.current !== event.pointerId) return;
    const time = timeAt(event.clientX, event.currentTarget);
    if (time === null) return;
    setScrub(time);
    onScrub?.(time);
  }

  function endDrag(event: TargetedPointerEvent<HTMLDivElement>, pick: boolean): void {
    if (drag.current !== event.pointerId) return;
    drag.current = null;
    const time = timeAt(event.clientX, event.currentTarget) ?? scrub;
    setScrub(null);
    onScrub?.(null);
    if (pick && time !== null) onPick(time);
  }

  function onKeyDown(event: TargetedKeyboardEvent<HTMLDivElement>): void {
    if (disabled) return;
    let next: number | null = null;
    const step = event.shiftKey ? 10 * MINUTE : MINUTE;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current + step;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current - step;
    else if (event.key === 'PageUp') next = current + HOUR;
    else if (event.key === 'PageDown') next = current - HOUR;
    else if (event.key === 'Home') next = dayStart;
    else if (event.key === 'End') next = dayEnd - 1000;
    if (next === null) return;
    event.preventDefault();
    onPick(clamp(next));
  }

  return (
    <div class={cx('timeline', className)}>
      <div
        class="timeline-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={dayStart}
        aria-valuemax={dayEnd}
        aria-valuenow={current}
        aria-valuetext={timeFormat.format(current)}
        aria-disabled={disabled ? 'true' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endDrag(event, true)}
        onPointerCancel={(event) => endDrag(event, false)}
        onKeyDown={onKeyDown}
      >
        {ticks.map((t) => (
          <span key={t} class="timeline-hour" style={{ left: pct(t) }} />
        ))}
        {shown.map((b) => (
          <span
            key={b.start}
            class={cx('timeline-block', b.tone === 'muted' && 'timeline-block-muted')}
            style={{ left: pct(b.start), width: `${(((b.end - b.start) / span) * 100).toFixed(4)}%` }}
          />
        ))}
        {cursorShown && <span class="timeline-cursor" style={{ left: pct(current) }} />}
      </div>
      <div class="timeline-labels" aria-hidden="true">
        {labels.map((t) => (
          <span
            key={t}
            class={cx('timeline-label', t === viewStart && 'timeline-label-first', (t - dayStart) % scale.major !== 0 && 'timeline-label-minor')}
            style={{ left: pct(t) }}
          >
            {scale.minutes ? timeFormat.format(t) : hourFormat.format(t)}
          </span>
        ))}
      </div>
    </div>
  );
}
