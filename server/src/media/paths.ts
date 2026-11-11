/**
 * Desired MediaMTX path configuration for each camera (pure functions, no I/O).
 *
 * - "c<id>" is the viewed and recorded path. 360p pulls the camera sub stream, 1080p the main stream.
 * - 720p: "c<id>_src" pulls the main stream and an ffmpeg job transcodes it to 720p H.264
 *   (about 300 kbps, 15 fps, no audio) and publishes it to "c<id>" with the internal credentials.
 * - Recording on: record yes, source always on (720p: ffmpeg runs from runOnInit, restarted on exit).
 *   Recording off: record no, source on demand (720p: ffmpeg runs from runOnDemand while someone watches).
 */

import type { Quality } from '../../../shared/api-types.ts';
import { cameraPathName, cameraSourcePathName } from '../contracts.ts';

/** The subset of a MediaMTX path configuration the hub sets. */
export type PathConf = Record<string, string | boolean>;

/** Path names the hub owns: c<id> and c<id>_src. Other paths in MediaMTX are left alone. */
export const MANAGED_PATH_RE = /^c([1-9]\d{0,15})(_src)?$/;

/** How long a viewer waits for the 720p transcoder to start publishing. */
export const TRANSCODE_START_TIMEOUT = '20s';

export interface CameraPathInput {
  id: number;
  quality: Quality;
  /** Stream path on the camera for this quality ("/stream1", or the sub path for 360p). */
  streamPath: string;
  username: string;
  password: string;
  /** Effective recording: camera on, location not paused, active vault key. */
  record: boolean;
}

/** Where the hub reaches the camera's RTSP port (from ConnectorService.resolveCameraAddress). */
export interface PathTarget {
  host: string;
  port: number;
}

export interface PathEnv {
  /** MediaMTX RTSP listener, for example "rtsp://127.0.0.1:8554". */
  mediamtxRtsp: string;
  internalUser: string;
  internalPassword: string;
  ffmpegPath: string;
}

/** Camera id of a managed path name, or null. */
export function managedCameraId(name: string): number | null {
  const m = MANAGED_PATH_RE.exec(name);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Percent-encodes everything except unreserved characters, so credentials are safe both inside a URL
 * and inside a MediaMTX command line (which is split with shell quoting rules and expands "$VAR").
 */
export function strictEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function userInfo(username: string, password: string): string {
  if (username === '' && password === '') return '';
  return `${strictEncode(username)}:${strictEncode(password)}@`;
}

/** rtsp://user:pass@host:port/path for a camera stream (credentials URL-encoded). */
export function cameraRtspUrl(target: PathTarget, streamPath: string, username: string, password: string): string {
  const p = streamPath.startsWith('/') ? streamPath : `/${streamPath}`;
  return `rtsp://${userInfo(username, password)}${target.host}:${target.port}${p}`;
}

/** rtsp://<internal user>:<pass>@<mediamtx host:port>/<pathName> */
export function internalRtspUrl(env: PathEnv, pathName: string): string {
  const base = new URL(env.mediamtxRtsp);
  return `rtsp://${userInfo(env.internalUser, env.internalPassword)}${base.host}/${pathName}`;
}

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_\/.:@%=,+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** ffmpeg command line that turns c<id>_src into a 720p H.264 stream on c<id>. */
export function transcodeCommand(cameraId: number, env: PathEnv): string {
  const args = [
    env.ffmpegPath,
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-rtsp_transport',
    'tcp',
    '-i',
    internalRtspUrl(env, cameraSourcePathName(cameraId)),
    '-an',
    '-vf',
    'scale=-2:720,fps=15',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'zerolatency',
    '-profile:v',
    'baseline',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    '300k',
    '-maxrate',
    '300k',
    '-bufsize',
    '600k',
    '-g',
    '30',
    '-keyint_min',
    '30',
    '-sc_threshold',
    '0',
    '-f',
    'rtsp',
    '-rtsp_transport',
    'tcp',
    internalRtspUrl(env, cameraPathName(cameraId)),
  ];
  return args.map(quoteArg).join(' ');
}

/** Hook and source keys reset on every managed path, so a quality or recording change leaves nothing behind. */
function baseConf(): PathConf {
  return {
    rtspTransport: 'tcp',
    runOnInit: '',
    runOnInitRestart: false,
    runOnDemand: '',
    runOnDemandRestart: false,
  };
}

/** Desired path configurations for one camera, keyed by path name. */
export function buildCameraPathConfs(cam: CameraPathInput, target: PathTarget, env: PathEnv): Map<string, PathConf> {
  const out = new Map<string, PathConf>();
  const sourceUrl = cameraRtspUrl(target, cam.streamPath, cam.username, cam.password);
  if (cam.quality === '720p') {
    out.set(cameraSourcePathName(cam.id), {
      ...baseConf(),
      source: sourceUrl,
      sourceOnDemand: !cam.record,
      record: false,
    });
    const cmd = transcodeCommand(cam.id, env);
    out.set(cameraPathName(cam.id), {
      ...baseConf(),
      source: 'publisher',
      sourceOnDemand: false,
      record: cam.record,
      runOnInit: cam.record ? cmd : '',
      runOnInitRestart: cam.record,
      runOnDemand: cam.record ? '' : cmd,
      runOnDemandRestart: !cam.record,
      runOnDemandStartTimeout: TRANSCODE_START_TIMEOUT,
    });
  } else {
    out.set(cameraPathName(cam.id), {
      ...baseConf(),
      source: sourceUrl,
      sourceOnDemand: !cam.record,
      record: cam.record,
    });
  }
  return out;
}

const DURATION_UNITS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  'µs': 1e-3,
  'μs': 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** Parses a Go duration string ("20s", "1m0s", "1.5h") into milliseconds; null if invalid. */
export function parseGoDuration(value: string): number | null {
  if (value === '0') return 0;
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/gy;
  let total = 0;
  let consumed = 0;
  for (let m = re.exec(value); m !== null; m = re.exec(value)) {
    total += Number(m[1]) * (DURATION_UNITS[m[2] as string] as number);
    consumed = re.lastIndex;
  }
  return consumed === value.length && consumed > 0 ? total : null;
}

function sameValue(current: unknown, desired: string | boolean, key: string): boolean {
  if (typeof desired === 'boolean') return current === desired;
  const cur = current === null || current === undefined ? '' : current;
  if (typeof cur !== 'string') return false;
  if (key.endsWith('Timeout') || key.endsWith('CloseAfter') || key.endsWith('Duration')) {
    const a = parseGoDuration(cur);
    const b = parseGoDuration(desired);
    return a !== null && a === b;
  }
  return cur === desired;
}

/** True when every key the hub sets already has the desired value in MediaMTX. */
export function pathConfMatches(current: Record<string, unknown>, desired: PathConf): boolean {
  for (const [key, value] of Object.entries(desired)) {
    if (!sameValue(current[key], value, key)) return false;
  }
  return true;
}

/** Hides credentials in URLs before text reaches a log. */
export function redactUrls(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s\/@]*@/gi, '$1***@');
}
