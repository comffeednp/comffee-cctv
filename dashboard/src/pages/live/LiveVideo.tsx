// Live video for one camera with two stacked <video> elements. When the hub's viewing session is renewed (about
// every 10 minutes) or the stream comes back after a drop, the new stream plays in the hidden element and the two
// swap only once its first picture is ready, so the video never goes blank in between.

import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CameraSummary, LiveTokenResponse } from '../../../../shared/api-types.ts';
import { Button, Icon, Spinner, cx } from '../../components/index.ts';
import { ApiFailure, apiSend, describeError } from '../../lib/api.ts';
import { WhepError, connectLive } from '../../lib/whep.ts';
import type { LiveConnection, LiveState } from '../../lib/whep.ts';

type VideoWithExtras = HTMLVideoElement & {
  webkitDisplayingFullscreen?: boolean;
  requestVideoFrameCallback?: (callback: () => void) => number;
};

/** How long the hidden element may take to show its first picture before the swap happens anyway. */
const FIRST_FRAME_WAIT_MS = 7000;

export function liveFailureText(error: unknown, camera: CameraSummary): string {
  if (error instanceof WhepError) {
    if (error.kind === 'not-found') {
      return camera.online ? 'The camera is not sending video yet. Try again in a moment.' : 'The camera is offline. Check that it has power and network.';
    }
    if (error.kind === 'unsupported' || error.kind === 'protocol') return error.message;
    if (error.kind === 'unauthorized') return 'The live pass was refused. Try again.';
    return 'The live video could not reach this device. Check your internet connection and try again.';
  }
  if (error instanceof ApiFailure) {
    return describeError(error, { not_found: 'This camera is no longer available.', unavailable: 'The hub cannot reach this camera right now.' });
  }
  return 'The live video stopped. Try again.';
}

function stopVideo(video: HTMLVideoElement | null): void {
  if (!video) return;
  video.pause();
  video.srcObject = null;
}

export interface LiveVideoState {
  state: LiveState | 'idle';
  failure: unknown;
  retry: () => void;
  /** The element that is showing the picture now (for iPhone full screen). */
  frontVideo: () => HTMLVideoElement | null;
  /** The two stacked video elements; put them first inside a `media-16x9` frame. */
  videos: JSX.Element;
}

/**
 * Plays one camera live while `active` is true (on screen, tab visible). Fresh live pass for every session,
 * reconnects on its own, and swaps sessions without a gap.
 */
export function useLiveVideo(camera: CameraSummary, active: boolean, label: string): LiveVideoState {
  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const front = useRef(0);
  const [frontIndex, setFrontIndex] = useState(0);
  const connRef = useRef<LiveConnection | null>(null);
  const [state, setState] = useState<LiveState | 'idle'>('idle');
  const [failure, setFailure] = useState<unknown>(null);
  const cameraId = camera.id;

  useEffect(() => {
    if (!active) return;
    let closed = false;
    const elements = () => [videoA.current, videoB.current] as const;

    const show = (stream: MediaStream): Promise<void> => {
      const pair = elements();
      const shown = pair[front.current] as VideoWithExtras | null;
      const hidden = pair[1 - front.current] as VideoWithExtras | null;
      if (!shown || !hidden || closed) return Promise.resolve();
      // First picture, or iPhone's own full screen (it is bound to one element): play in the shown element.
      if (!shown.srcObject || shown.webkitDisplayingFullscreen) {
        shown.srcObject = stream;
        shown.play().catch(() => undefined);
        return Promise.resolve();
      }
      hidden.srcObject = stream;
      hidden.play().catch(() => undefined);
      return new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          hidden.removeEventListener('playing', onPlaying);
          if (closed) {
            resolve();
            return;
          }
          front.current = 1 - front.current;
          setFrontIndex(front.current);
          // Two frames later the new picture is on screen; then the old element lets go of its stream.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (!closed) stopVideo(shown);
              resolve();
            }),
          );
        };
        const onPlaying = () => {
          if (typeof hidden.requestVideoFrameCallback !== 'function') {
            requestAnimationFrame(finish);
            return;
          }
          hidden.requestVideoFrameCallback(() => finish());
          // Some browsers skip frame callbacks for a see-through element; playing is then close enough.
          setTimeout(finish, 1500);
        };
        const timer = setTimeout(finish, FIRST_FRAME_WAIT_MS);
        hidden.addEventListener('playing', onPlaying);
        if (!hidden.paused && hidden.readyState >= 2) onPlaying();
      });
    };

    const conn = connectLive({
      getTicket: async (signal) => {
        const ticket = await apiSend<LiveTokenResponse>('POST', `/api/live/${cameraId}/token`, {}, { signal });
        return { url: ticket.whepUrl, token: ticket.token };
      },
      onStream: show,
      onState: (next, error) => {
        setState(next);
        setFailure(error ?? null);
      },
      // Lost access or a removed camera will not come back by retrying.
      isFatal: (error) => error instanceof ApiFailure && (error.status === 401 || error.status === 403 || error.status === 404),
    });
    connRef.current = conn;
    return () => {
      closed = true;
      conn.close();
      connRef.current = null;
      const [a, b] = elements();
      stopVideo(a);
      stopVideo(b);
      setState('idle');
    };
  }, [active, cameraId]);

  const videos = (
    <>
      <video
        ref={videoA}
        class={cx('live-video', frontIndex !== 0 && 'live-video-back')}
        muted
        playsInline
        autoPlay
        disablePictureInPicture
        aria-hidden={frontIndex !== 0 ? 'true' : undefined}
        aria-label={frontIndex === 0 ? label : undefined}
      />
      <video
        ref={videoB}
        class={cx('live-video', frontIndex !== 1 && 'live-video-back')}
        muted
        playsInline
        autoPlay
        disablePictureInPicture
        aria-hidden={frontIndex !== 1 ? 'true' : undefined}
        aria-label={frontIndex === 1 ? label : undefined}
      />
    </>
  );

  return {
    state,
    failure,
    retry: () => connRef.current?.retry(),
    frontVideo: () => (front.current === 0 ? videoA.current : videoB.current),
    videos,
  };
}

/** Spinner, "Reconnecting" or the failure with Try again, centred over the video. */
export function LiveStateOverlay({ live, camera, size = 24 }: { live: LiveVideoState; camera: CameraSummary; size?: 24 | 32 }) {
  if (live.state === 'idle' || live.state === 'connecting') {
    return (
      <div class="media-center">
        <Spinner size={size} label={`Connecting to ${camera.name}`} />
      </div>
    );
  }
  if (live.state === 'retrying') {
    return (
      <div class="media-center">
        <Spinner size={size} decorative />
        <span class="k-body-s">Reconnecting</span>
      </div>
    );
  }
  if (live.state === 'failed') {
    return (
      <div class="media-center" role="status">
        <Icon name="warning" size={size} />
        <p class="k-body-s live-message">{liveFailureText(live.failure, camera)}</p>
        <Button icon="refresh" onClick={live.retry}>
          Try again
        </Button>
      </div>
    );
  }
  return null;
}

type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

/** Full screen for a video frame; iPhone Safari only lets a video element itself go full screen. */
export function useFullscreen(frameRef: { current: HTMLElement | null }, video: () => HTMLVideoElement | null): [boolean, () => void] {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(frameRef.current !== null && document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggle = () => {
    const frame = frameRef.current;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (frame && typeof frame.requestFullscreen === 'function') {
      frame.requestFullscreen().catch(() => undefined);
      return;
    }
    const element = video() as FullscreenVideo | null;
    element?.webkitEnterFullscreen?.();
  };
  return [fullscreen, toggle];
}

/** True while the element is (nearly) on screen and the tab is visible; turns false only after a grace period. */
export function useOnScreen(ref: { current: HTMLElement | null }, graceMs = 20_000): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let inView = typeof IntersectionObserver === 'undefined';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      const want = inView && document.visibilityState === 'visible';
      if (want) {
        if (timer) clearTimeout(timer);
        timer = null;
        setActive(true);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          setActive(false);
        }, graceMs);
      }
    };
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              inView = entries.some((entry) => entry.isIntersecting);
              update();
            },
            { rootMargin: '200px' },
          );
    observer?.observe(el);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', update);
      if (timer) clearTimeout(timer);
    };
  }, []);
  return active;
}
