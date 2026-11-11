/**
 * The hub's Fastify instance: security headers, CSRF guard, JSON error mapping, WebSocket support
 * and the static dashboard with SPA fallback. Route modules are registered by main.ts.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../shared/api-types.ts';
import type { ApiErrorBody, ApiErrorCode } from '../../shared/api-types.ts';
import { BRIDGE_DATA_HEADER_BYTES, BRIDGE_MAX_PAYLOAD_BYTES } from '../../shared/bridge-protocol.ts';
import { HttpError } from './contracts.ts';
import type { HubConfig } from './contracts.ts';

export const BODY_LIMIT = 64 * 1024;

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
  "connect-src 'self'; font-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; " +
  "base-uri 'none'; form-action 'self'";

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

const CSRF_HEADER_LOWER = CSRF_HEADER.toLowerCase();

/** Path part of a request URL, without the query string. */
export function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}

function under(p: string, prefix: string): boolean {
  return p === prefix || p.startsWith(prefix + '/');
}

/** The percent-decoded path of a request URL, or null when its encoding is malformed. */
export function decodedPathOf(url: string): string | null {
  try {
    return decodeURIComponent(pathOf(url));
  } catch {
    return null;
  }
}

/**
 * True when a request is for a path under prefix. The router decodes the URL before matching, so
 * "/%61pi/..." reaches /api routes: this checks the matched route, the decoded path and the raw path.
 * A malformed encoding counts as under every prefix (fail closed).
 */
export function requestUnder(req: FastifyRequest, prefix: string): boolean {
  const route = req.routeOptions.url;
  if (route !== undefined && under(route, prefix)) return true;
  const decoded = decodedPathOf(req.url);
  return decoded === null || under(decoded, prefix) || under(pathOf(req.url), prefix);
}

/** WHEP endpoints that Caddy sends to MediaMTX in production: /live/<path>/whep and /live/<path>/whep/<session>. */
const WHEP_RE = /^\/live\/[^/]+\/whep(\/|$)/;

/** Paths the hub never answers with the dashboard page. */
export function isBackendPath(p: string): boolean {
  return under(p, '/api') || under(p, '/internal') || under(p, '/bridge') || WHEP_RE.test(p);
}

function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** True when the request came straight from this machine, not through the reverse proxy. */
export function isDirectLocalRequest(req: FastifyRequest): boolean {
  const h = req.headers;
  return (
    isLoopback(req.socket.remoteAddress) &&
    h['x-forwarded-for'] === undefined &&
    h['forwarded'] === undefined &&
    h['x-real-ip'] === undefined
  );
}

function mediaType(header: string | undefined): string {
  if (!header) return '';
  return header.split(';')[0].trim().toLowerCase();
}

/**
 * CSRF rule for non-GET/HEAD requests under /api: header "X-CCTV: 1", Origin (when sent) equal to
 * config.publicOrigin, and any body must be JSON. Returns the reason when the request fails.
 */
export function csrfProblem(req: FastifyRequest, config: HubConfig): string | null {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  if (!requestUnder(req, '/api')) return null;
  if (req.headers[CSRF_HEADER_LOWER] !== CSRF_HEADER_VALUE) return `Missing ${CSRF_HEADER} header`;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== config.publicOrigin) return 'Request from another site';
  const length = req.headers['content-length'];
  const hasBody = (length !== undefined && length !== '0') || req.headers['transfer-encoding'] !== undefined;
  const type = mediaType(req.headers['content-type']);
  if ((hasBody || type !== '') && type !== 'application/json') return 'Requests must send JSON';
  return null;
}

export function sendError(reply: FastifyReply, status: number, code: ApiErrorCode, message: string): FastifyReply {
  const body: ApiErrorBody = { error: { code, message } };
  return reply.code(status).type('application/json; charset=utf-8').send(body);
}

/* -------------------------------------------------- input helpers for route modules */

export function invalidInput(message: string): HttpError {
  return new HttpError(422, 'invalid_input', message);
}

export function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'Not found');
}

/** The JSON body as an object ({} when there is none). Throws 422 for arrays and other values. */
export function bodyObject(req: FastifyRequest): Record<string, unknown> {
  const body = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw invalidInput('Request body must be a JSON object');
  return body as Record<string, unknown>;
}

/** A positive integer id from a route parameter; anything else is 404. */
export function idParam(value: unknown): number {
  const s = typeof value === 'string' ? value : '';
  if (!/^[1-9]\d{0,15}$/.test(s)) throw notFound();
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw notFound();
  return n;
}

/* -------------------------------------------------------------------- the app */

export interface HttpAppOptions {
  logger?: FastifyServerOptions['logger'];
}

function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError || (err instanceof Error && err.name === 'HttpError' && 'status' in err && 'code' in err);
}

export async function createHttpApp(config: HubConfig, opts: HttpAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: '127.0.0.1',
    bodyLimit: BODY_LIMIT,
    requestTimeout: 30_000,
    return503OnClosing: true,
  });

  // JSON bodies only. An empty JSON body counts as {} so clients may send POST with no body.
  const defaultJson = app.getDefaultJsonParser('error', 'error');
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: BODY_LIMIT }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, {});
      return;
    }
    defaultJson(req, text, done);
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.headers(SECURITY_HEADERS);
    if (decodedPathOf(req.url) === null) return sendError(reply, 400, 'invalid_input', 'Invalid request');
    if (requestUnder(req, '/api') || requestUnder(req, '/internal') || requestUnder(req, '/bridge')) {
      reply.header('cache-control', 'no-store');
    }

    // /internal/* answers only MediaMTX on this machine, never anything coming through the reverse proxy.
    if (requestUnder(req, '/internal') && !isDirectLocalRequest(req)) {
      return sendError(reply, 404, 'not_found', 'Not found');
    }
    const problem = csrfProblem(req, config);
    if (problem) return sendError(reply, 403, 'csrf', problem);
    return undefined;
  });

  app.setErrorHandler((err: FastifyError | HttpError | Error, req, reply) => {
    if (isHttpError(err)) {
      if (err.status >= 500) req.log.warn({ code: err.code }, err.message);
      return sendError(reply, err.status, err.code as ApiErrorCode, err.message);
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status === 413) return sendError(reply, 413, 'invalid_input', 'Request is too large');
    if (status === 415) return sendError(reply, 403, 'csrf', 'Requests must send JSON');
    if (status === 404) return sendError(reply, 404, 'not_found', 'Not found');
    if (status === 429) return sendError(reply, 429, 'throttled', 'Too many requests. Please wait and try again.');
    if (status >= 400 && status < 500) return sendError(reply, 422, 'invalid_input', 'Invalid request');
    req.log.error(err);
    return sendError(reply, 500, 'internal', 'Something went wrong. Please try again.');
  });

  const indexFile = path.join(config.dashboardDir, 'index.html');
  const hasDashboard = existsSync(indexFile);

  app.setNotFoundHandler((req, reply) => {
    const p = decodedPathOf(req.url) ?? pathOf(req.url);
    const lastSegment = p.slice(p.lastIndexOf('/') + 1);
    if (isBackendPath(p) || (req.method !== 'GET' && req.method !== 'HEAD') || lastSegment.includes('.')) {
      return sendError(reply, 404, 'not_found', 'Not found');
    }
    if (!hasDashboard) {
      return sendError(reply, 404, 'not_found', 'The dashboard is not built yet (npm run build:dashboard)');
    }
    reply.header('cache-control', 'no-cache');
    return reply.sendFile('index.html');
  });

  await app.register(fastifyWebsocket, {
    options: { maxPayload: BRIDGE_MAX_PAYLOAD_BYTES + BRIDGE_DATA_HEADER_BYTES },
  });

  if (hasDashboard) {
    await app.register(fastifyStatic, {
      root: config.dashboardDir,
      prefix: '/',
      wildcard: true,
      index: ['index.html'],
      dotfiles: 'ignore',
      setHeaders(reply, filePath) {
        const name = path.basename(filePath);
        if (name === 'index.html' || name.endsWith('.webmanifest') || name === 'sw.js') {
          reply.header('cache-control', 'no-cache');
        } else if (filePath.split(path.sep).includes('assets')) {
          reply.header('cache-control', 'public, max-age=31536000, immutable');
        }
      },
    });
  } else {
    app.log.warn(`Dashboard not found at ${config.dashboardDir}; only the API is served`);
  }

  return app;
}
