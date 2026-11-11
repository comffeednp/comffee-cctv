/**
 * Camera stream checks: ffprobe stream test (8 s, RTSP over TCP) and a light RTSP OPTIONS
 * reachability probe used for camera status while a camera is not being pulled.
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import type { StreamInfo } from '../../../shared/api-types.ts';

export const FFPROBE_TIMEOUT_MS = 8000;
const MAX_STDOUT = 64 * 1024;
const MAX_STDERR = 16 * 1024;

export type ProbeResult = Omit<StreamInfo, 'path'>;

function failed(error: string): ProbeResult {
  return { ok: false, codec: null, width: null, height: null, fps: null, error };
}

/** Plain-language reason from ffprobe's error output (never echoes the URL, which holds the password). */
export function describeProbeError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes('401') || s.includes('unauthorized')) return 'Wrong camera username or password';
  if (s.includes('403') || s.includes('forbidden')) return 'The camera refused this account';
  if (s.includes('404') || s.includes('not found')) return 'The stream path was not found on the camera';
  if (s.includes('connection refused')) return 'The camera refused the connection';
  if (s.includes('timed out') || s.includes('timeout')) return 'The camera did not answer in time';
  if (s.includes('no route') || s.includes('unreachable')) return 'The camera cannot be reached';
  if (s.includes('invalid data')) return 'The camera sent a stream the hub cannot read';
  return 'The stream could not be opened';
}

function parseRate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d+)\/(\d+)$/.exec(value);
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (den === 0 || num === 0) return null;
  return Math.round((num / den) * 100) / 100;
}

/** Parses ffprobe JSON output into a ProbeResult. */
export function parseProbeOutput(stdout: string): ProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return failed('The stream could not be read');
  }
  const streams = (parsed as { streams?: unknown }).streams;
  const first = Array.isArray(streams) ? (streams[0] as Record<string, unknown> | undefined) : undefined;
  if (!first) return failed('No video found in the stream');
  const width = typeof first.width === 'number' ? first.width : null;
  const height = typeof first.height === 'number' ? first.height : null;
  return {
    ok: true,
    codec: typeof first.codec_name === 'string' ? first.codec_name : null,
    width,
    height,
    fps: parseRate(first.avg_frame_rate) ?? parseRate(first.r_frame_rate),
    error: null,
  };
}

/** Runs ffprobe on an RTSP URL (TCP transport) with a hard timeout. Never throws. */
export function probeStream(ffprobePath: string, url: string, timeoutMs: number = FFPROBE_TIMEOUT_MS): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        ffprobePath,
        [
          '-hide_banner',
          '-v',
          'error',
          '-rtsp_transport',
          'tcp',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=codec_name,width,height,avg_frame_rate,r_frame_rate',
          '-of',
          'json',
          url,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
    } catch {
      resolve(failed('ffprobe is not installed on the hub'));
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(failed('The camera did not answer in time'));
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_STDOUT) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += d.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(failed(err.code === 'ENOENT' ? 'ffprobe is not installed on the hub' : 'The stream test could not run'));
    });
    child.on('close', (code) => {
      if (code === 0) finish(parseProbeOutput(stdout));
      else finish(failed(describeProbeError(stderr)));
    });
  });
}

/** True when host:port answers an RTSP OPTIONS request with an RTSP/1.0 reply. Never throws. */
export function rtspReachable(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let received = '';
    const sock = connect({ host, port });
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('connect', () => {
      sock.write(`OPTIONS rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: comffee-cctv\r\n\r\n`);
    });
    sock.on('data', (d: Buffer) => {
      received += d.toString('latin1');
      if (received.length >= 8) finish(received.startsWith('RTSP/1.0'));
    });
    sock.on('error', () => finish(false));
    sock.on('close', () => finish(false));
  });
}
