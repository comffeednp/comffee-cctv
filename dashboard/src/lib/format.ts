// Date, size and duration formatting. Times from the API are ISO 8601 UTC; screens show them in the
// location's IANA timezone (or the browser's, for things that belong to no location).

export type TimeInput = string | number | Date;

/** The browser's IANA timezone, or "UTC" when the browser does not say. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** True when the runtime knows this IANA timezone. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function toDate(value: TimeInput): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(kind: string, tz: string | undefined, options: Intl.DateTimeFormatOptions, locale?: string): Intl.DateTimeFormat {
  const zone = tz && isValidTimezone(tz) ? tz : undefined;
  const key = `${kind}|${zone ?? ''}|${locale ?? ''}`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone });
    formatters.set(key, found);
  }
  return found;
}

/** "3:05 PM" (or the local equivalent) in the given timezone. Empty string for a missing or bad time. */
export function formatTime(iso: TimeInput | null | undefined, tz?: string): string {
  if (iso === null || iso === undefined) return '';
  const date = toDate(iso);
  return date ? formatter('time', tz, { hour: 'numeric', minute: '2-digit' }).format(date) : '';
}

/** "12 Nov 2026" (or the local equivalent) in the given timezone. */
export function formatDate(iso: TimeInput | null | undefined, tz?: string): string {
  if (iso === null || iso === undefined) return '';
  const date = toDate(iso);
  return date ? formatter('date', tz, { day: 'numeric', month: 'short', year: 'numeric' }).format(date) : '';
}

/** "12 Nov 2026, 3:05 PM" (or the local equivalent) in the given timezone. */
export function formatDateTime(iso: TimeInput | null | undefined, tz?: string): string {
  if (iso === null || iso === undefined) return '';
  const date = toDate(iso);
  if (!date) return '';
  return formatter('datetime', tz, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

/** "YYYY-MM-DD" of the instant in the given timezone (matches RecordingDay.date). */
export function dayKey(iso: TimeInput, tz?: string): string {
  const date = toDate(iso);
  if (!date) return '';
  const parts = formatter('daykey', tz, { year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA').formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** "1.4 GB". Binary units (1 KB = 1024 bytes), one decimal from KB up. */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[unit]}`;
}

/** "45 s", "5 min", "1 h 5 min", "2 d 3 h". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours} h ${restMinutes} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} d ${restHours} h` : `${days} d`;
}

/** "3 cameras", "1 camera". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
