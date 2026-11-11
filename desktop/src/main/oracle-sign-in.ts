/**
 * "Sign in with Oracle": the browser flow of the OCI CLI's `oci session authenticate`
 * (oci_cli/cli_setup_bootstrap.py create_user_session):
 *
 * 1. A local listener on port 8181 (127.0.0.1, plus ::1 when free).
 * 2. A fresh RSA 2048 key pair; its public JWK goes to Oracle in the sign-in link.
 * 3. The system browser opens https://login.<region>.oraclecloud.com/v1/oauth2/authorize with
 *    action=login, client_id=iaas_console, response_type="token id_token", nonce, scope=openid,
 *    public_key and redirect_uri=http://localhost:8181.
 * 4. Oracle sends the browser back to http://localhost:8181/#security_token=...; the page there hands the
 *    fragment to /token, where the app takes the token.
 *
 * The token (about 1 hour) is bound to the key pair: requests are signed with keyId "ST$<token>".
 * No file is written here and no Electron API is used (the caller opens the browser).
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { serviceEndpoint } from '../lib/oci-regions.ts';
import { Cancelled, UserError } from '../lib/errors.ts';

export const SIGN_IN_PORT = 8181;
export const REDIRECT_URI = `http://localhost:${SIGN_IN_PORT}`;
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

const ALLOWED_HOSTS = new Set([`localhost:${SIGN_IN_PORT}`, `127.0.0.1:${SIGN_IN_PORT}`, `[::1]:${SIGN_IN_PORT}`]);

export function buildAuthorizeUrl(region: string, publicKeyParam: string, nonce: string): string {
  const query = new URLSearchParams({
    action: 'login',
    client_id: 'iaas_console',
    response_type: 'token id_token',
    nonce,
    scope: 'openid',
    public_key: publicKeyParam,
    redirect_uri: REDIRECT_URI,
  });
  return `${serviceEndpoint('login', region)}/v1/oauth2/authorize?${query.toString()}`;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Comffee CCTV</title>
<link rel="stylesheet" href="/page.css">
</head>
<body>
<main>
<h1>Comffee CCTV</h1>
<p id="msg">Finishing sign-in...</p>
<noscript><p>Turn on JavaScript in this browser, then sign in again from the app.</p></noscript>
</main>
<script src="/callback.js"></script>
</body>
</html>`;

const STYLE = `body{margin:0;background:#0a0807;color:#f4ecdf;font:16px/1.5 system-ui,sans-serif}
main{max-width:440px;margin:15vh auto;padding:0 16px}h1{font-size:24px;line-height:1.25}#msg{color:#e9e1d3}`;

// Hands the URL fragment (where Oracle puts the token) to /token, then clears it from the address bar.
const SCRIPT = `(function () {
  var hash = window.location.hash;
  if (hash.charAt(0) === '#') hash = hash.slice(1);
  try { history.replaceState(null, '', '/'); } catch (e) {}
  var msg = document.getElementById('msg');
  var req = new XMLHttpRequest();
  req.onload = function () {
    msg.textContent = req.status === 200
      ? 'You are signed in. Go back to Comffee CCTV.'
      : 'Sign-in did not finish. Go back to Comffee CCTV and try again.';
  };
  req.onerror = function () { msg.textContent = 'Sign-in did not finish. Go back to Comffee CCTV and try again.'; };
  req.open('GET', '/token?' + hash);
  req.send();
})();`;

const HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export interface SignInListener {
  /** Resolves with the security token. */
  token: Promise<string>;
  cancel(): void;
}

function listen(server: Server, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(SIGN_IN_PORT, host);
  });
}

/** Starts the local listener. Fails at once when port 8181 is taken, before any browser opens. */
export async function startSignInListener(timeoutMs = SIGN_IN_TIMEOUT_MS): Promise<SignInListener> {
  let settle: { resolve(token: string): void; reject(err: Error): void } | null = null;
  const token = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Callers always attach a handler; this keeps an early failure from being reported as unhandled.
  token.catch(() => undefined);

  const servers: Server[] = [];
  let done = false;
  const finish = (err: Error | null, value?: string) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    // Let the last answer reach the browser before the listener goes away.
    setTimeout(() => {
      for (const s of servers) s.close();
    }, 500).unref();
    if (err) settle!.reject(err);
    else settle!.resolve(value!);
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { ...HEADERS, 'Content-Type': type });
      res.end(body);
    };
    if (req.method !== 'GET' || !ALLOWED_HOSTS.has(req.headers.host ?? '')) {
      send(400, 'text/plain; charset=utf-8', 'Bad request');
      return;
    }
    const url = new URL(req.url ?? '/', REDIRECT_URI);
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', PAGE);
    if (url.pathname === '/callback.js') return send(200, 'text/javascript; charset=utf-8', SCRIPT);
    if (url.pathname === '/page.css') return send(200, 'text/css; charset=utf-8', STYLE);
    if (url.pathname === '/token') {
      if (done) return send(409, 'text/plain; charset=utf-8', 'Already finished');
      const securityToken = url.searchParams.get('security_token');
      if (securityToken) {
        send(200, 'text/plain; charset=utf-8', 'ok');
        finish(null, securityToken);
        return;
      }
      if (url.searchParams.has('error')) {
        send(200, 'text/plain; charset=utf-8', 'error');
        finish(new UserError('Oracle did not finish the sign-in. Try again.'));
        return;
      }
      return send(400, 'text/plain; charset=utf-8', 'Bad request');
    }
    send(404, 'text/plain; charset=utf-8', 'Not found');
  };

  const v4 = createServer(handler);
  try {
    await listen(v4, '127.0.0.1');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new UserError('Another program on this computer is using port 8181. Close it, then try again.');
    }
    throw err;
  }
  servers.push(v4);
  // Browsers may try ::1 first for "localhost"; listen there too when possible.
  const v6 = createServer(handler);
  try {
    await listen(v6, '::1');
    servers.push(v6);
  } catch {
    // No IPv6 loopback, or taken: 127.0.0.1 is enough.
  }

  const timer = setTimeout(() => finish(new UserError('Sign-in took too long. Try again.')), timeoutMs);
  return { token, cancel: () => finish(new Cancelled()) };
}
