// Calendar maths in a location's IANA timezone: "YYYY-MM-DD" day keys, wall-clock times to unix ms, and
// labels. Works across daylight-saving changes (a day can be 23 or 25 hours long).

import { dayKey, isValidTimezone } from '../../lib/format.ts';

const MINUTE = 60_000;
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function zone(tz: string): string {
  return tz && isValidTimezone(tz) ? tz : 'UTC';
}

function offsetFormatter(tz: string): Intl.DateTimeFormat {
  let found = offsetFormatters.get(tz);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    offsetFormatters.set(tz, found);
  }
  return found;
}

/** How far the zone's wall clock is ahead of UTC at instant `ms`, in ms. */
function zoneOffset(ms: number, tz: string): number {
  const parts = offsetFormatter(tz).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const hour = get('hour') % 24;
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return wall - (ms - (((ms % 1000) + 1000) % 1000));
}

function parseDay(day: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return [1970, 1, 1];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Unix ms of `minutes` after midnight (wall clock) on `day` in `tz`. 1440 = the next midnight. */
export function zonedTime(day: string, minutes: number, tz: string): number {
  const z = zone(tz);
  const [y, m, d] = parseDay(day);
  const wall = Date.UTC(y, m - 1, d, 0, minutes, 0);
  let guess = wall - zoneOffset(wall, z);
  guess = wall - zoneOffset(guess, z);
  return guess;
}

/** First instant of `day` in `tz`. */
export function dayStartMs(day: string, tz: string): number {
  return zonedTime(day, 0, tz);
}

/** First instant of the day after `day` in `tz`. */
export function dayEndMs(day: string, tz: string): number {
  return zonedTime(addDays(day, 1), 0, tz);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = parseDay(day);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** "YYYY-MM" moved by n months. */
export function shiftMonth(month: string, n: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const y = match ? Number(match[1]) : 1970;
  const m = match ? Number(match[2]) : 1;
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

export function todayIn(tz: string): string {
  return dayKey(Date.now(), zone(tz));
}

/** "Thursday 12 November" style label of a day key (the day itself, no timezone shift). */
export function dayLabel(day: string): string {
  const [y, m, d] = parseDay(day);
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d, 12)),
  );
}

/** "3:00 PM" style label for a whole hour of the wall clock. */
export function hourLabel(hour: number): string {
  if (hour >= 24) return 'End of day';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, 0, 1, hour)));
}

/** "HH-MM" (24 h) wall-clock time of an instant in `tz`, for file names. */
export function fileClock(ms: number, tz: string): string {
  const parts = offsetFormatter(zone(tz)).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${String(Number(get('hour')) % 24).padStart(2, '0')}-${get('minute')}`;
}

export { MINUTE };
