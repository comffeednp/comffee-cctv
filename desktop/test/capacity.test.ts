import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CapacityEvent, CapacityOptions, CapacityState } from '../src/lib/capacity.ts';
import { RETRY_DELAY_MS, SIZES, capacityMessage, initialCapacityState, isFinished, nextCapacityState } from '../src/lib/capacity.ts';
import { chooseSize, BOOT_VOLUME_GBS, FREE_ALLOWANCE } from '../src/lib/provision.ts';

function run(events: CapacityEvent['type'][], options: CapacityOptions, start = initialCapacityState()): CapacityState {
  let state = start;
  for (const type of events) state = nextCapacityState(state, type === 'fatal' ? { type, message: 'no' } : ({ type } as CapacityEvent), options);
  return state;
}

test('sizes stay inside the Always Free shapes', () => {
  assert.deepEqual(SIZES.full, { ocpus: 4, memoryInGBs: 24 });
  assert.deepEqual(SIZES.half, { ocpus: 2, memoryInGBs: 12 });
  assert.equal(RETRY_DELAY_MS, 60_000);
});

test('one domain: a capacity error waits, then retries as the next try', () => {
  const options = { adCount: 1, canFallBack: true };
  let s = initialCapacityState();
  assert.equal(s.status, 'trying');
  assert.equal(s.tries, 1);
  assert.equal(capacityMessage(s), null);
  s = nextCapacityState(s, { type: 'capacity' }, options);
  assert.equal(s.status, 'waiting');
  assert.equal(capacityMessage(s), 'Oracle is busy, still trying (try 1)');
  s = nextCapacityState(s, { type: 'retry' }, options);
  assert.equal(s.status, 'trying');
  assert.equal(s.tries, 2);
  assert.equal(capacityMessage(s), 'Oracle is busy, still trying (try 2)');
});

test('three domains: tries each at once, waits only after the last one', () => {
  const options = { adCount: 3, canFallBack: true };
  let s = initialCapacityState();
  s = nextCapacityState(s, { type: 'capacity' }, options);
  assert.equal(s.status, 'trying');
  assert.equal(s.adIndex, 1);
  s = nextCapacityState(s, { type: 'capacity' }, options);
  assert.equal(s.status, 'trying');
  assert.equal(s.adIndex, 2);
  s = nextCapacityState(s, { type: 'capacity' }, options);
  assert.equal(s.status, 'waiting');
  assert.equal(s.adIndex, 0);
  assert.equal(s.tries, 3);
});

test('falls back to 2 cores / 12 GB after three rounds of capacity errors', () => {
  const options = { adCount: 1, canFallBack: true };
  let s = run(['capacity', 'retry', 'capacity', 'retry'], options);
  assert.equal(s.size, 'full');
  s = run(['capacity'], options, s);
  assert.equal(s.size, 'half');
  assert.equal(s.capacityErrors, 0);
  // It keeps trying at the smaller size; it never drops further.
  s = run(['retry', 'capacity', 'retry', 'capacity', 'retry', 'capacity', 'retry', 'capacity'], options, s);
  assert.equal(s.size, 'half');
  assert.equal(s.status, 'waiting');
});

test('no fallback when only one size fits the free allowance', () => {
  const options = { adCount: 1, canFallBack: false };
  const s = run(['capacity', 'retry', 'capacity', 'retry', 'capacity', 'retry', 'capacity'], options);
  assert.equal(s.size, 'full');
});

test('throttling waits and retries the same domain without counting toward the fallback', () => {
  const options = { adCount: 2, canFallBack: true };
  let s = nextCapacityState(initialCapacityState(), { type: 'busy' }, options);
  assert.equal(s.status, 'waiting');
  assert.equal(s.reason, 'busy');
  assert.equal(s.adIndex, 0);
  assert.equal(s.capacityErrors, 0);
  s = nextCapacityState(s, { type: 'retry' }, options);
  assert.equal(s.status, 'trying');
  assert.equal(s.tries, 2);
});

test('success, fatal and cancel end it; finished states ignore later events', () => {
  const options = { adCount: 1, canFallBack: true };
  const done = run(['capacity', 'retry', 'success'], options);
  assert.equal(done.status, 'done');
  assert.ok(isFinished(done));
  assert.equal(capacityMessage(done), null);
  assert.equal(nextCapacityState(done, { type: 'capacity' }, options), done);

  const failed = run(['fatal'], options);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'no');

  const cancelled = run(['capacity', 'cancel'], options);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(nextCapacityState(cancelled, { type: 'retry' }, options), cancelled);
});

test('events in the wrong phase change nothing', () => {
  const options = { adCount: 1, canFallBack: true };
  const trying = initialCapacityState();
  assert.equal(nextCapacityState(trying, { type: 'retry' }, options), trying, 'retry only after waiting');
  const waiting = nextCapacityState(trying, { type: 'capacity' }, options);
  assert.equal(nextCapacityState(waiting, { type: 'capacity' }, options), waiting, 'no launch is running while waiting');
  assert.equal(nextCapacityState(waiting, { type: 'success' }, options), waiting);
});

test('free allowance: the size is chosen from what the account already uses', () => {
  assert.deepEqual(chooseSize({ ocpus: 0, memoryInGBs: 0, storageGBs: 0 }), { start: 'full', canFallBack: true, blocked: null });
  assert.equal(chooseSize({ ocpus: 2, memoryInGBs: 12, storageGBs: 0 }).start, 'half');
  assert.equal(chooseSize({ ocpus: 2, memoryInGBs: 12, storageGBs: 0 }).canFallBack, false);
  assert.equal(chooseSize({ ocpus: 4, memoryInGBs: 24, storageGBs: 0 }).start, null);
  assert.ok(chooseSize({ ocpus: 4, memoryInGBs: 24, storageGBs: 0 }).blocked);
  const disk = chooseSize({ ocpus: 0, memoryInGBs: 0, storageGBs: FREE_ALLOWANCE.storageGBs - BOOT_VOLUME_GBS + 1 });
  assert.equal(disk.start, null);
  assert.match(disk.blocked ?? '', /disk/);
  assert.equal(chooseSize({ ocpus: 0, memoryInGBs: 0, storageGBs: FREE_ALLOWANCE.storageGBs - BOOT_VOLUME_GBS }).start, 'full');
});
