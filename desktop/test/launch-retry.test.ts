import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OciClient } from '../src/lib/oci-client.ts';
import { OciError } from '../src/lib/oci-client.ts';
import { NetworkError } from '../src/lib/https-transport.ts';
import type { Instance, RunInput } from '../src/lib/provision.ts';
import { launchWithRetry } from '../src/lib/provision.ts';

interface Launch {
  ad: string;
  ocpus: number;
  token: string;
}

/** A fake Oracle that answers launches from a script and records every launch request. */
function fakeOracle(answers: Array<'ok' | 'capacity' | 'busy' | 'network'>, instanceAfterLaunch = false) {
  const launches: Launch[] = [];
  let listed: Instance[] = [];
  const client = {
    async get(_service: string, path: string) {
      if (path.endsWith('/images')) return [{ id: 'image-1', displayName: 'Canonical-Ubuntu-24.04-aarch64-2026.10.01-0' }];
      throw new Error(`unexpected get ${path}`);
    },
    async list(_service: string, path: string) {
      if (path.endsWith('/instances')) return listed;
      throw new Error(`unexpected list ${path}`);
    },
    async post(_service: string, path: string, body: Record<string, unknown>, headers?: Record<string, string>) {
      assert.ok(path.endsWith('/instances'));
      const shapeConfig = body.shapeConfig as { ocpus: number };
      launches.push({ ad: String(body.availabilityDomain), ocpus: shapeConfig.ocpus, token: headers?.['opc-retry-token'] ?? '' });
      const answer = answers.shift() ?? 'ok';
      if (instanceAfterLaunch) listed = [{ id: 'made-earlier', displayName: 'comffee-cctv-hub', lifecycleState: 'PROVISIONING' }];
      if (answer === 'capacity') throw new OciError(500, 'InternalError', 'Out of host capacity.', null);
      if (answer === 'busy') throw new OciError(429, 'TooManyRequests', 'Too many requests.', null);
      if (answer === 'network') throw new NetworkError('The connection was reset.');
      return { id: 'new-server', displayName: 'comffee-cctv-hub', lifecycleState: 'PROVISIONING' };
    },
  };
  const input: RunInput = {
    client: client as unknown as OciClient,
    tenancyId: 'tenancy',
    sshPublicKey: 'ssh-ed25519 AAAA test',
    userData: 'dXNlcg==',
    hooks: {
      signal: new AbortController().signal,
      sleep: async () => undefined,
      onStep: () => undefined,
      onCapacity: () => undefined,
      onInstance: () => undefined,
    },
  };
  return { input, launches };
}

const full = { start: 'full' as const, canFallBack: true, blocked: null };

test('a launch repeated after a lost answer reuses its retry token', async () => {
  const { input, launches } = fakeOracle(['network', 'ok']);
  const instance = await launchWithRetry(input, 'subnet', ['AD-1'], full);
  assert.equal(instance.id, 'new-server');
  assert.equal(launches.length, 2);
  assert.ok(launches[0]!.token.length >= 32);
  assert.equal(launches[1]!.token, launches[0]!.token);
});

test('a launch repeated after throttling reuses its retry token', async () => {
  const { input, launches } = fakeOracle(['busy', 'busy', 'ok']);
  await launchWithRetry(input, 'subnet', ['AD-1', 'AD-2'], full);
  assert.equal(launches.length, 3);
  assert.deepEqual(new Set(launches.map((l) => l.ad)), new Set(['AD-1']));
  assert.equal(new Set(launches.map((l) => l.token)).size, 1);
});

test('out of capacity moves on with a new retry token', async () => {
  const { input, launches } = fakeOracle(['capacity', 'ok']);
  await launchWithRetry(input, 'subnet', ['AD-1', 'AD-2'], full);
  assert.deepEqual(launches.map((l) => l.ad), ['AD-1', 'AD-2']);
  assert.notEqual(launches[1]!.token, launches[0]!.token);
});

test('out of capacity in the only domain retries later with a new retry token', async () => {
  const { input, launches } = fakeOracle(['capacity', 'ok']);
  await launchWithRetry(input, 'subnet', ['AD-1'], full);
  assert.deepEqual(launches.map((l) => l.ad), ['AD-1', 'AD-1']);
  assert.notEqual(launches[1]!.token, launches[0]!.token);
});

test('a network error after out of capacity keeps the newer token', async () => {
  const { input, launches } = fakeOracle(['capacity', 'network', 'ok']);
  await launchWithRetry(input, 'subnet', ['AD-1'], full);
  assert.equal(launches.length, 3);
  assert.notEqual(launches[1]!.token, launches[0]!.token);
  assert.equal(launches[2]!.token, launches[1]!.token);
});

test('a smaller size after repeated capacity errors gets its own token', async () => {
  const { input, launches } = fakeOracle(['capacity', 'capacity', 'capacity', 'ok']);
  await launchWithRetry(input, 'subnet', ['AD-1'], full);
  assert.deepEqual(launches.map((l) => l.ocpus), [4, 4, 4, 2]);
  assert.equal(new Set(launches.map((l) => l.token)).size, 4);
});

test('a server made by a launch whose answer was lost is found, not launched again', async () => {
  const { input, launches } = fakeOracle(['network'], true);
  const instance = await launchWithRetry(input, 'subnet', ['AD-1'], full);
  assert.equal(instance.id, 'made-earlier');
  assert.equal(launches.length, 1);
});
