import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdapter } from '../src/adapters/index.js';
import { SimulatorAdapter } from '../src/adapters/simulator.js';

// Small repeatable generator, so the test does not depend on Math.random.
function seeded(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function run(ids, options, minutes) {
  const clock = { t: 0 };
  const heard = new Map();
  const simulator = new SimulatorAdapter({
    getDeviceIds: () => ids,
    rng: seeded(42),
    now: () => clock.t,
    ...options,
  });
  simulator.on('sighting', ({ deviceId, at, rssi }) => {
    if (!heard.has(deviceId)) heard.set(deviceId, []);
    heard.get(deviceId).push({ at, rssi });
  });
  for (; clock.t < minutes * 60_000; clock.t += 500) simulator.tick();
  return heard;
}

test('beacons roughly every two seconds with some loss', () => {
  const heard = run(['a'], { unregisteredIds: [], silentIds: [] }, 10);
  const count = heard.get('a').length;
  assert.ok(count > 200 && count <= 300, `heard ${count}`);
});

test('signal stays within a plausible BLE range', () => {
  const heard = run(['a'], { unregisteredIds: [], silentIds: [] }, 10);
  for (const { rssi } of heard.get('a')) assert.ok(rssi >= -90 && rssi <= -40, `rssi ${rssi}`);
});

test('wristbands sometimes drop out long enough to look offline', () => {
  const ids = Array.from({ length: 8 }, (_, n) => `tag${n}`);
  const heard = run(ids, { unregisteredIds: [], silentIds: [] }, 60);
  const longestGap = (times) => Math.max(...times.slice(1).map((entry, n) => entry.at - times[n].at));
  assert.ok([...heard.values()].some((times) => longestGap(times) > 15_000));
});

test('silent wristbands are never heard; unregistered ones are', () => {
  const heard = run(['a', 'quiet'], { unregisteredIds: ['stray'], silentIds: ['quiet'] }, 2);
  assert.ok(heard.has('a'));
  assert.ok(heard.has('stray'));
  assert.equal(heard.has('quiet'), false);
});

test('reports itself as simulated and unable to command watches', () => {
  const info = new SimulatorAdapter({ getDeviceIds: () => [] }).info();
  assert.equal(info.simulated, true);
  assert.equal(info.canCommandDevices, false);
});

test('an unknown adapter name is refused', () => {
  assert.throws(() => createAdapter('carrier-pigeon', {}), /Unknown ADAPTER/);
});
