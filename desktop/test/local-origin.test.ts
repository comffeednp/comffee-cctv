import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_ORIGIN, isLocalFrame, isLocalUrl } from '../src/lib/local-origin.ts';

test('the local origin is app://local', () => {
  assert.equal(LOCAL_ORIGIN, 'app://local');
});

test("Node's URL gives app: an opaque origin, so the checks must not rely on it", () => {
  // This is why the checks below compare protocol and host instead.
  assert.equal(new URL('app://local/index.html').origin, 'null');
});

test('local screen URLs are local', () => {
  assert.equal(isLocalUrl('app://local/index.html'), true);
  assert.equal(isLocalUrl('app://local/index.html#/settings/server/abc?x=y'), true);
  assert.equal(isLocalUrl('app://local/'), true);
  assert.equal(isLocalUrl(`${LOCAL_ORIGIN}/index.html`), true);
});

test('anything else is not local', () => {
  for (const target of [
    'https://local/index.html',
    'http://local/',
    'app://other/index.html',
    'app://local.evil/index.html',
    'app://local:8080/index.html',
    'app://user@local/index.html',
    'app://user:pass@local/index.html',
    'app:local/index.html',
    'file:///C:/index.html',
    'about:blank',
    'null',
    '',
    'not a url',
  ]) {
    assert.equal(isLocalUrl(target), false, target);
  }
});

test('a frame is local only when its origin and its URL both are', () => {
  // What Electron 45 reports for the app's own window.
  assert.equal(isLocalFrame({ origin: 'app://local', url: 'app://local/index.html' }), true);
  assert.equal(isLocalFrame({ origin: 'null', url: 'app://local/index.html' }), false);
  assert.equal(isLocalFrame({ origin: 'https://hub.example.com', url: 'https://hub.example.com/' }), false);
  assert.equal(isLocalFrame({ origin: 'app://local', url: '' }), false);
  assert.equal(isLocalFrame({ origin: 'app://local', url: 'https://hub.example.com/' }), false);
});
