// Past footage of one camera: pick a day (strip of the last 30 days, or the calendar for older ones), then tap or
// drag on the day's timeline to play from that exact time. The 5-minute part holding that moment is opened in
// this browser with the recovery key, playback seeks to the moment and runs on into the next part, which is
// opened ahead of time. At most 3 opened parts are kept. Every time is in the location's timezone.

import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  CameraSummary,
  LocationSummary,
  RecordingDaysResponse,
  RecordingItem,
  RecordingsPage,
  VaultKeysResponse,
} from '../../../../shared/api-types.ts';
import { RECORDINGS_PAGE_MAX } from '../../../../shared/api-types.ts';
import {
  Button,
  CalendarMonth,
  Icon,
  IconButton,
  SegmentedControl,
  Section,
  Spinner,
  TimelineTrack,
  useToast,
} from '../../components/index.ts';
import { saveBlob } from '../../app/download.ts';
import { ApiFailure, apiGet, describeError, isAbort } from '../../lib/api.ts';
import { getPrivateKey } from '../../lib/crypto/keystore.ts';
import { VaultDecryptError } from '../../lib/crypto/vault-decrypt.ts';
import { dayKey, formatDuration, isValidTimezone } from '../../lib/format.ts';
import { KeyImport } from '../recordings/KeyImport.tsx';
import { addDays, dayEndMs, dayLabel, dayStartMs, shiftMonth, todayIn } from '../recordings/time.ts';
import { clipFileName } from './camera-status.ts';
import { DayStrip } from './DayStrip.tsx';
import { useFullscreen } from './LiveVideo.tsx';
import { MissingKeyError, SegmentCache } from './segment-cache.ts';
import type { OpenedSegment } from './segment-cache.ts';

type Zoom = '24' | '6' | '1';
type Speed = '1' | '2' | '4';

const HOUR = 3_600_000;
const STRIP_DAYS = 30;
/** Safety cap on pages fetched for one day (500 each). */
const DAY_PAGES_MAX = 40;
/** Today's footage keeps growing; its timeline is refreshed this often. */
const TODAY_REFRESH_MS = 60_000;
const KEPT_SEGMENTS = 3;

interface Target {
  item: RecordingItem;
  /** Where to start inside the part, ms. */
  offsetMs: number;
  /** Changes on every pick, so picking inside the same part still seeks. */
  nonce: number;
}

type View =
  | { kind: 'idle' }
  | { kind: 'loading'; percent: number | null }
  | { kind: 'ready'; segment: OpenedSegment }
  | { kind: 'need-key'; keyId: string }
  | { kind: 'error'; message: string };

export interface PlaybackProps {
  camera: CameraSummary;
  location: LocationSummary;
  owner: boolean;
  /** Open this moment (from a link to /live?camera=..&at=..); a new nonce opens it again. */
  startAt: { time: number; nonce: number } | null;
  onBackToLive: () => void;
  /** Shown above the video (the Live / Playback switch). */
  toolbar?: ComponentChildren;
}

const startOf = (item: RecordingItem) => Date.parse(item.start);
const endOf = (item: RecordingItem) => Date.parse(item.end);

function openFailureText(error: unknown): string {
  if (error instanceof VaultDecryptError) return error.message;
  if (error instanceof ApiFailure) {
    return describeError(error, { not_found: 'This recording is gone. It may have passed the number of days kept.' });
  }
  return 'This recording could not be opened. Try again.';
}

function isStopped(error: unknown): boolean {
  return isAbort(error) || (error instanceof VaultDecryptError && error.reason === 'aborted');
}

/** The part before or after `item` for this camera, asked from the hub (for the ends of a day). */
async function adjacentPart(cameraId: number, item: RecordingItem, direction: 'next' | 'prev'): Promise<RecordingItem | null> {
  const query =
    direction === 'next'
      ? { cameraId, from: item.end, order: 'asc' as const, limit: 3 }
      : { cameraId, to: item.start, order: 'desc' as const, limit: 3 };
  const res = await apiGet<RecordingsPage>('/api/recordings', query);
  const at = startOf(item);
  return res.items.find((s) => s.id !== item.id && (direction === 'next' ? startOf(s) > at : startOf(s) < at)) ?? null;
}

export function Playback({ camera, location, owner, startAt, onBackToLive, toolbar }: PlaybackProps) {
  const toast = useToast();
  const tz = isValidTimezone(location.timezone) ? location.timezone : 'UTC';
  const today = todayIn(tz);
  const cameraId = camera.id;

  const [day, setDay] = useState(() => (startAt ? dayKey(startAt.time, tz) : today));
  const [items, setItems] = useState<RecordingItem[] | null>(null);
  const [itemsError, setItemsError] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);
  const [stripMarked, setStripMarked] = useState<ReadonlySet<string>>(new Set());
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calMonth, setCalMonth] = useState(() => day.slice(0, 7));
  const [calMarked, setCalMarked] = useState<string[]>([]);
  const [calLoading, setCalLoading] = useState(false);
  const [keys, setKeys] = useState<VaultKeysResponse | null>(null);
  const [missingKey, setMissingKey] = useState<string | null>(null);
  const [keyNote, setKeyNote] = useState<string | null>(null);

  const [zoom, setZoom] = useState<Zoom>('24');
  const [viewStart, setViewStart] = useState(0);
  const [target, setTarget] = useState<Target | null>(null);
  const [view, setView] = useState<View>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [paused, setPaused] = useState(true);
  const [speed, setSpeed] = useState<Speed>('1');

  const cacheRef = useRef<SegmentCache | null>(null);
  if (!cacheRef.current) cacheRef.current = new SegmentCache(KEPT_SEGMENTS);
  const cache = cacheRef.current;
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const nonce = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const pendingPick = useRef<number | null>(startAt ? startAt.time : null);
  const loadedKey = useRef('');
  /** The zoomed window follows playback until the person pans it themselves. */
  const follow = useRef(true);
  const [fullscreen, toggleFullscreen] = useFullscreen(frameRef, () => videoRef.current);

  const dayStart = dayStartMs(day, tz);
  const dayEnd = dayEndMs(day, tz);
  const span = zoom === '24' ? dayEnd - dayStart : Number(zoom) * HOUR;
  const clampView = (start: number) => Math.max(dayStart, Math.min(start, dayEnd - span));
  const shownStart = zoom === '24' ? dayStart : clampView(viewStart);

  const clock = useMemo(
    () => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: tz }),
    [tz],
  );

  // Everything opened is released when the panel closes.
  useEffect(() => () => cache.clear(), []);

  // The hub's key list says which recovery file a part needs.
  useEffect(() => {
    const controller = new AbortController();
    apiGet<VaultKeysResponse>('/api/keys/vault', undefined, { signal: controller.signal })
      .then(setKeys)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // A new link to a moment.
  const seenStart = useRef(startAt?.nonce ?? -1);
  useEffect(() => {
    if (!startAt || startAt.nonce === seenStart.current) return;
    seenStart.current = startAt.nonce;
    pendingPick.current = startAt.time;
    const linked = dayKey(startAt.time, tz);
    if (linked !== day) {
      setTarget(null);
      setDay(linked);
    } else if (items) {
      const time = pendingPick.current;
      pendingPick.current = null;
      playAt(time);
    }
  }, [startAt?.nonce]);

  // Every part of the day, oldest first. Today is refreshed every minute without blanking the timeline.
  useEffect(() => {
    const key = `${cameraId}|${day}`;
    const fresh = loadedKey.current !== key;
    loadedKey.current = key;
    const controller = new AbortController();
    if (fresh) {
      setItems(null);
      setItemsError(null);
    }
    (async () => {
      const all: RecordingItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < DAY_PAGES_MAX; page += 1) {
        const res = await apiGet<RecordingsPage>(
          '/api/recordings',
          {
            cameraId,
            from: new Date(dayStartMs(day, tz)).toISOString(),
            to: new Date(dayEndMs(day, tz)).toISOString(),
            order: 'asc',
            limit: RECORDINGS_PAGE_MAX,
            cursor,
          },
          { signal: controller.signal },
        );
        all.push(...res.items);
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }
      if (controller.signal.aborted) return;
      all.sort((a, b) => startOf(a) - startOf(b));
      setItems(all);
      setItemsError(null);
    })().catch((err) => {
      if (!isAbort(err) && fresh) setItemsError(err);
    });
    const timer = day === today ? setTimeout(() => setRefresh((n) => n + 1), TODAY_REFRESH_MS) : null;
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [cameraId, day, tz, refresh]);

  // Marks for the strip: the months the last 30 days cover.
  useEffect(() => {
    const controller = new AbortController();
    const months = [...new Set([addDays(today, -(STRIP_DAYS - 1)).slice(0, 7), today.slice(0, 7)])];
    Promise.all(
      months.map((month) =>
        apiGet<RecordingDaysResponse>('/api/recordings/days', { locationId: location.id, cameraId, month }, { signal: controller.signal }),
      ),
    )
      .then((pages) => {
        const set = new Set<string>();
        for (const page of pages) for (const d of page.days) if (d.segmentCount > 0) set.add(d.date);
        setStripMarked(set);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [cameraId, location.id, today, refresh]);

  // Marks for the calendar month on show.
  useEffect(() => {
    if (!calendarOpen) return;
    const controller = new AbortController();
    setCalLoading(true);
    apiGet<RecordingDaysResponse>('/api/recordings/days', { locationId: location.id, cameraId, month: calMonth }, { signal: controller.signal })
      .then((res) => setCalMarked(res.days.filter((d) => d.segmentCount > 0).map((d) => d.date)))
      .catch((err) => {
        if (!isAbort(err)) setCalMarked([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCalLoading(false);
      });
    return () => controller.abort();
  }, [calendarOpen, calMonth, cameraId, location.id]);

  // Say at once when this device cannot open the day's footage, instead of failing on the first tap.
  useEffect(() => {
    if (!items || items.length === 0) return;
    let cancelled = false;
    const keyId = items[items.length - 1].keyId;
    getPrivateKey(keyId)
      .then((key) => {
        if (!cancelled) setMissingKey(key ? null : keyId);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [items]);

  // A pick that waited for the day's parts (a link, or a tap while they loaded).
  useEffect(() => {
    if (!items || pendingPick.current === null) return;
    const time = pendingPick.current;
    pendingPick.current = null;
    playAt(time);
  }, [items]);

  // Open the wanted part (or take it from the cache).
  useEffect(() => {
    if (!target) {
      cache.setPlaying(null);
      cache.keepLoading([]);
      setView({ kind: 'idle' });
      return;
    }
    const item = target.item;
    cache.keepLoading([item.id]);
    const ready = cache.get(item.id);
    if (ready) {
      cache.setPlaying(item.id);
      setView({ kind: 'ready', segment: ready });
      return;
    }
    let cancelled = false;
    setView({ kind: 'loading', percent: null });
    cache
      .open(item, (percent) => {
        if (!cancelled) setView({ kind: 'loading', percent });
      })
      .then((segment) => {
        if (cancelled) return;
        cache.setPlaying(item.id);
        setView({ kind: 'ready', segment });
      })
      .catch((err) => {
        if (cancelled || isStopped(err)) return;
        if (err instanceof MissingKeyError) setView({ kind: 'need-key', keyId: err.keyId });
        else setView({ kind: 'error', message: openFailureText(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [target?.item.id, attempt]);

  // A new pick: remember where to seek; inside the part already on screen, seek now.
  useEffect(() => {
    if (!target) return;
    pendingSeek.current = target.offsetMs;
    const video = videoRef.current;
    if (video && view.kind === 'ready' && view.segment.item.id === target.item.id && video.readyState >= 1) {
      video.currentTime = Math.max(0, target.offsetMs / 1000);
      pendingSeek.current = null;
      video.play().catch(() => undefined);
    }
  }, [target?.nonce]);

  // Open the next part ahead of time, so playback runs on without waiting.
  const nextInDay = (item: RecordingItem): RecordingItem | null => items?.find((s) => startOf(s) > startOf(item)) ?? null;
  const prevInDay = (item: RecordingItem): RecordingItem | null => {
    if (!items) return null;
    for (let i = items.length - 1; i >= 0; i -= 1) if (startOf(items[i]) < startOf(item)) return items[i];
    return null;
  };
  const readyId = view.kind === 'ready' ? view.segment.item.id : null;
  useEffect(() => {
    if (view.kind !== 'ready') return;
    const next = nextInDay(view.segment.item);
    if (!next) return;
    cache.keepLoading([view.segment.item.id, next.id]);
    cache.open(next).catch(() => undefined);
  }, [readyId, items]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.defaultPlaybackRate = Number(speed);
    video.playbackRate = Number(speed);
  }, [speed, readyId]);

  // The zoomed window follows playback (unless the person moved it away to look around).
  useEffect(() => {
    if (zoom === '24' || playhead === null || !follow.current) return;
    if (playhead < shownStart || playhead >= shownStart + span) setViewStart(clampView(playhead - span * 0.1));
  }, [playhead, zoom, day]);

  const pan = (direction: -1 | 1) => {
    follow.current = false;
    setViewStart(clampView(shownStart + (direction * span) / 2));
  };

  const centreOn = (nextZoom: Zoom) => {
    const nextSpan = nextZoom === '24' ? dayEnd - dayStart : Number(nextZoom) * HOUR;
    const lastEnd = items && items.length ? Math.min(endOf(items[items.length - 1]), dayEnd) : null;
    const centre = playhead ?? lastEnd ?? dayStart + (dayEnd - dayStart) / 2;
    follow.current = true;
    setViewStart(Math.max(dayStart, Math.min(centre - nextSpan / 2, dayEnd - nextSpan)));
  };

  const goTo = (item: RecordingItem, offsetMs: number) => {
    const offset = Math.max(0, offsetMs);
    const at = startOf(item) + offset;
    nonce.current += 1;
    follow.current = true;
    setTarget({ item, offsetMs: offset, nonce: nonce.current });
    setPlayhead(at);
    // Playing on past midnight moves the timeline to the next day.
    if (at < dayStart || at >= dayEnd) setDay(dayKey(at, tz));
  };

  function playAt(time: number) {
    if (!items) {
      pendingPick.current = time;
      return;
    }
    const hit = items.find((s) => startOf(s) <= time && time < endOf(s));
    if (hit) {
      goTo(hit, time - startOf(hit));
      return;
    }
    const after = items.find((s) => startOf(s) > time);
    if (after) goTo(after, 0);
    else toast.show({ message: 'Nothing was recorded after that time on this day.' });
  }

  const step = async (direction: 'next' | 'prev', auto: boolean) => {
    const current = target?.item;
    if (!current) return;
    let found = direction === 'next' ? nextInDay(current) : prevInDay(current);
    if (!found) {
      try {
        found = await adjacentPart(cameraId, current, direction);
      } catch (err) {
        if (!auto) toast.show({ message: describeError(err), tone: 'error' });
        return;
      }
    }
    if (found) goTo(found, 0);
    else if (!auto) toast.show({ message: direction === 'next' ? 'This is the newest recording.' : 'This is the oldest recording.' });
    else setPaused(true);
  };

  const selectDay = (next: string) => {
    if (next === day) return;
    setTarget(null);
    setPlayhead(null);
    setScrub(null);
    pendingPick.current = null;
    setDay(next);
  };

  const onLoaded = () => {
    const video = videoRef.current;
    if (!video) return;
    video.defaultPlaybackRate = Number(speed);
    video.playbackRate = Number(speed);
    const offset = pendingSeek.current;
    pendingSeek.current = null;
    if (offset !== null && offset > 0) {
      const limit = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.5) : offset / 1000;
      video.currentTime = Math.min(offset / 1000, limit);
    }
    video.play().catch(() => setPaused(true));
  };

  const onTime = () => {
    const video = videoRef.current;
    if (video && view.kind === 'ready') setPlayhead(startOf(view.segment.item) + video.currentTime * 1000);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => undefined);
    else video.pause();
  };

  const stripDays = useMemo(() => Array.from({ length: STRIP_DAYS }, (_, i) => addDays(today, i - (STRIP_DAYS - 1))), [today]);
  const blocks = useMemo(() => (items ?? []).map((s) => ({ start: startOf(s), end: endOf(s) })), [items]);
  const recordedMs = useMemo(() => (items ?? []).reduce((sum, s) => sum + s.durationMs, 0), [items]);
  const shownTime = scrub ?? playhead;
  const playing = view.kind === 'ready' ? view.segment.item : null;
  const neededKey = view.kind === 'need-key' ? view.keyId : missingKey;
  const shownDay = day === today ? `Today, ${dayLabel(day)}` : dayLabel(day);

  let frameMessage: ComponentChildren = null;
  if (view.kind === 'loading') {
    frameMessage = (
      <div class="media-center">
        <Spinner size={24} decorative />
        <span class="k-body-s" role="status">
          {view.percent === null ? 'Opening recording' : `Opening recording, ${view.percent}%`}
        </span>
      </div>
    );
  } else if (view.kind === 'error') {
    frameMessage = (
      <div class="media-center" role="alert">
        <Icon name="warning" size={24} />
        <p class="k-body-s live-message">{view.message}</p>
        <Button icon="refresh" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  } else if (view.kind === 'need-key' || (view.kind === 'idle' && missingKey)) {
    frameMessage = (
      <div class="media-center">
        <Icon name="key" size={32} />
        <span class="k-body-s">Recovery key needed</span>
      </div>
    );
  } else if (view.kind === 'idle') {
    frameMessage = (
      <div class="media-center">
        {itemsError ? null : !items ? <Spinner size={24} label="Loading recordings" /> : <Icon name="timeline" size={32} />}
        <p class="k-body-s live-message">
          {itemsError
            ? 'The recordings of this day did not load.'
            : !items
              ? 'Loading this day'
              : items.length === 0
                ? 'Nothing was recorded on this day.'
                : 'Tap the timeline below to play from that time.'}
        </p>
      </div>
    );
  }

  return (
    <>
      <div class="stack">
        {toolbar}
        <div ref={frameRef} class="media-16x9 live-frame">
          {view.kind === 'ready' ? (
            <video
              ref={videoRef}
              src={view.segment.url}
              playsInline
              autoPlay
              muted
              disablePictureInPicture
              onLoadedMetadata={onLoaded}
              onTimeUpdate={onTime}
              onPlay={() => setPaused(false)}
              onPause={() => setPaused(true)}
              onEnded={() => void step('next', true)}
              onError={() => setView({ kind: 'error', message: 'This browser cannot play this recording. Try another browser, or download the clip.' })}
              onClick={togglePlay}
              aria-label={`Recording of ${camera.name}`}
            />
          ) : null}
          {frameMessage}
          <div class="live-tools">
            <IconButton
              icon={fullscreen ? 'exit-fullscreen' : 'fullscreen'}
              label={fullscreen ? 'Leave full screen' : 'Full screen'}
              variant="overlay"
              onClick={toggleFullscreen}
            />
          </div>
          <div class="media-overlay">
            <span class="truncate grow fw-semibold">{camera.name}</span>
            {shownTime !== null ? <span class="tnum shrink-0">{clock.format(shownTime)}</span> : null}
          </div>
        </div>

        <div class="play-controls">
          <div class="row">
            <IconButton icon="chevron-left" label="Previous part" variant="secondary" disabled={!target} onClick={() => void step('prev', false)} />
            <IconButton
              icon={paused ? 'play' : 'pause'}
              label={paused ? 'Play' : 'Pause'}
              variant="secondary"
              disabled={view.kind !== 'ready'}
              onClick={togglePlay}
            />
            <IconButton icon="chevron" label="Next part" variant="secondary" disabled={!target} onClick={() => void step('next', false)} />
          </div>
          <SegmentedControl<Speed>
            label="Speed"
            size="s"
            value={speed}
            onChange={setSpeed}
            options={[
              { value: '1', label: '1x' },
              { value: '2', label: '2x' },
              { value: '4', label: '4x' },
            ]}
          />
          <div class="row wrap play-controls-end">
            {owner ? (
              <Button
                icon="download"
                disabled={view.kind !== 'ready'}
                onClick={() => {
                  if (view.kind === 'ready') saveBlob(view.segment.blob, clipFileName(view.segment.item, tz));
                }}
              >
                Download clip
              </Button>
            ) : null}
            <Button icon="live" onClick={onBackToLive}>
              Back to live
            </Button>
          </div>
        </div>
        {playing ? (
          <p class="footnote">
            Part from {clock.format(startOf(playing))} to {clock.format(endOf(playing))}, {formatDuration(playing.durationMs)}.
          </p>
        ) : null}

        {neededKey ? (
          <div class="stack-8">
            {keyNote ? (
              <p class="k-body-s text-error" role="alert">
                {keyNote}
              </p>
            ) : null}
            <KeyImport
              keyId={neededKey}
              keys={keys?.keys ?? null}
              owner={owner}
              onImported={(matches) => {
                setKeyNote(matches ? null : 'That file holds a different key. It was kept for the recordings it opens; choose the file these recordings need.');
                if (!matches) return;
                setMissingKey(null);
                if (view.kind === 'need-key') setAttempt((n) => n + 1);
              }}
            />
          </div>
        ) : null}
      </div>

      <Section
        title="Day"
        lead="Days with footage have a mark."
        actions={
          <IconButton
            icon="calendar"
            label={calendarOpen ? 'Hide calendar' : 'Older days'}
            variant="secondary"
            pressed={calendarOpen}
            onClick={() => {
              if (!calendarOpen) setCalMonth(day.slice(0, 7));
              setCalendarOpen(!calendarOpen);
            }}
          />
        }
      >
        <DayStrip days={stripDays} marked={stripMarked} selected={day} today={today} onSelect={selectDay} />
        {calendarOpen ? (
          <CalendarMonth
            month={calMonth}
            selected={day}
            marked={calMarked}
            today={today}
            max={today}
            markedLabel="has footage"
            onSelect={selectDay}
            onPrev={() => setCalMonth((m) => shiftMonth(m, -1))}
            onNext={() => setCalMonth((m) => shiftMonth(m, 1))}
            nextDisabled={calMonth >= today.slice(0, 7)}
            loading={calLoading}
          />
        ) : null}
      </Section>

      <Section
        title={shownDay}
        lead={items && items.length ? `Tap or drag to play from that time. ${formatDuration(recordedMs)} recorded.` : 'Tap or drag to play from that time.'}
        actions={
          <SegmentedControl<Zoom>
            label="Zoom"
            size="s"
            value={zoom}
            onChange={(next) => {
              setZoom(next);
              centreOn(next);
            }}
            options={[
              { value: '24', label: '24 h' },
              { value: '6', label: '6 h' },
              { value: '1', label: '1 h' },
            ]}
          />
        }
      >
        {itemsError && !items ? (
          <div class="row wrap">
            <p class="k-body-s grow">{describeError(itemsError)}</p>
            <Button icon="refresh" onClick={() => setRefresh((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : null}
        <div class="play-timeline">
          {zoom !== '24' ? (
            <IconButton
              icon="chevron-left"
              label="Earlier"
              size="s"
              disabled={shownStart <= dayStart}
              onClick={() => pan(-1)}
            />
          ) : null}
          <TimelineTrack
            class="grow"
            label={`${camera.name}, ${shownDay}`}
            dayStart={dayStart}
            dayEnd={dayEnd}
            viewStart={shownStart}
            viewEnd={shownStart + span}
            timeZone={tz}
            blocks={blocks}
            cursor={playhead}
            disabled={!items}
            onScrub={setScrub}
            onPick={(time) => playAt(time)}
          />
          {zoom !== '24' ? (
            <IconButton
              icon="chevron"
              label="Later"
              size="s"
              disabled={shownStart + span >= dayEnd}
              onClick={() => pan(1)}
            />
          ) : null}
        </div>
        <p class="footnote">
          Times are in {location.name} time ({tz.replace(/_/g, ' ')}).
        </p>
      </Section>
    </>
  );
}
