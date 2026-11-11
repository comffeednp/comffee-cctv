import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REPO_REF,
  DEFAULT_REPO_URL,
  TemplateError,
  USER_DATA_MAX_BYTES,
  base32,
  isSafeRepoRef,
  isSafeRepoUrl,
  isSetupCode,
  newSetupCode,
  renderCloudInit,
  userDataBase64,
} from '../src/lib/cloud-init.ts';

const TEMPLATE = `#cloud-config
runcmd:
  - [ git, clone, --branch, "{{REPO_REF}}", "{{REPO_URL}}", /opt/comffee-cctv ]
  - [ bash, /opt/comffee-cctv/deploy/install.sh, --setup-code, "{{SETUP_CODE}}" ]
`;
const CODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const good = { repoUrl: DEFAULT_REPO_URL, repoRef: DEFAULT_REPO_REF, setupCode: CODE };

test('renders every placeholder and leaves none behind', () => {
  const out = renderCloudInit(TEMPLATE, good);
  assert.ok(out.includes(`"${DEFAULT_REPO_URL}"`));
  assert.ok(out.includes(`"${DEFAULT_REPO_REF}"`));
  assert.ok(out.includes(`"${CODE}"`));
  assert.doesNotMatch(out, /\{\{|\}\}/);
});

test('values that YAML or a shell would treat specially never get in', () => {
  const unsafeUrls = [
    'http://github.com/x/y.git',
    'https://github.com/x/y.git"; rm -rf / #',
    "https://github.com/x/y.git' && curl evil",
    'https://github.com/x/$(id).git',
    'https://github.com/x/`id`.git',
    'https://github.com/x/y.git\n  - evil',
    'https://github.com/x/y z.git',
    'https://user:pass@github.com/x/y.git',
    'https://github.com/x/y.git?a=1',
    'https://github.com/x/y.git#frag',
    'https://github.com/x/../y.git',
    'https://github.com/x/y.git;id',
    'git@github.com:x/y.git',
    '',
  ];
  for (const repoUrl of unsafeUrls) {
    assert.equal(isSafeRepoUrl(repoUrl), false, repoUrl);
    assert.throws(() => renderCloudInit(TEMPLATE, { ...good, repoUrl }), TemplateError, repoUrl);
  }
  const unsafeRefs = ['-x', '/main', 'main/', 'a..b', 'main;id', 'main$(id)', 'ma in', 'main\n', 'main"', "main'", 'x.lock', 'a//b', ''];
  for (const repoRef of unsafeRefs) {
    assert.equal(isSafeRepoRef(repoRef), false, JSON.stringify(repoRef));
    assert.throws(() => renderCloudInit(TEMPLATE, { ...good, repoRef }), TemplateError);
  }
  for (const setupCode of ['abc', CODE.toLowerCase(), `${CODE}A`, `${CODE.slice(0, 31)}1`, `${CODE.slice(0, 31)}"`]) {
    assert.throws(() => renderCloudInit(TEMPLATE, { ...good, setupCode }), TemplateError);
  }
});

test('ordinary values pass', () => {
  assert.ok(isSafeRepoUrl('https://github.com/comffeednp/comffee-cctv.git'));
  assert.ok(isSafeRepoUrl('https://git.example.com:8443/team/cctv'));
  assert.ok(isSafeRepoRef('main'));
  assert.ok(isSafeRepoRef('v1.2.3'));
  assert.ok(isSafeRepoRef('release/2026-11'));
  assert.ok(isSafeRepoRef('0a1b2c3d4e5f'));
});

test('unknown or broken placeholders are an error, and the setup code placeholder is required', () => {
  assert.throws(() => renderCloudInit(`${TEMPLATE}{{OTHER}}\n`, good), /unknown placeholder/);
  assert.throws(() => renderCloudInit(`${TEMPLATE}{{ SETUP_CODE }}\n`, good), /broken placeholder/);
  assert.throws(() => renderCloudInit('#cloud-config\n{{REPO_URL}}\n', good), /no setup code placeholder/);
});

test('a value is inserted literally, never treated as a replacement pattern', () => {
  // String.replace with a function: "$&" or "$1" in a value cannot expand (and are refused anyway).
  assert.equal(isSafeRepoRef('$&'), false);
  const out = renderCloudInit('{{SETUP_CODE}}{{SETUP_CODE}}', good);
  assert.equal(out, CODE + CODE);
});

test('setup codes: 20 random bytes as 32 base32 letters', () => {
  const a = newSetupCode();
  const b = newSetupCode();
  assert.ok(isSetupCode(a) && isSetupCode(b));
  assert.equal(a.length, 32);
  assert.notEqual(a, b);
  // RFC 4648 test vectors.
  assert.equal(base32(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32(Buffer.from('f')), 'MY');
});

test('user_data is base64 and refused over the Oracle limit', () => {
  const out = renderCloudInit(TEMPLATE, good);
  assert.equal(Buffer.from(userDataBase64(out), 'base64').toString('utf8'), out);
  assert.throws(() => userDataBase64('x'.repeat(USER_DATA_MAX_BYTES)), TemplateError);
});

const realTemplate = fileURLToPath(new URL('../../deploy/cloud-init.yaml.template', import.meta.url));
test('the real deploy/cloud-init.yaml.template renders cleanly', { skip: !existsSync(realTemplate) && 'template not in this checkout yet' }, () => {
  const out = renderCloudInit(readFileSync(realTemplate, 'utf8'), good);
  assert.doesNotMatch(out, /\{\{|\}\}/);
  assert.ok(out.includes(CODE));
  assert.ok(userDataBase64(out).length <= USER_DATA_MAX_BYTES);
});
