import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, warningFor } from '../src/store.js';

function setup() {
  const clock = { t: 1_000_000 };
  const file = join(mkdtempSync(join(tmpdir(), 'playpulse-')), 'data.json');
  const make = () => new Store({ file, now: () => clock.t });
  return { clock, file, store: make(), make };
}

const view = (store, id) => store.snapshot().devices.find((device) => device.id === id);

test('state follows the firmware bench timing: 30 s session, 10 s warning', () => {
  const { store, clock } = setup();
  store.register({ id: 'tag' });
  store.startSession('tag', { durationSeconds: 30 });
  const started = clock.t;
  const stateAt = (seconds) => {
    clock.t = started + seconds * 1000;
    return view(store, 'tag').state;
  };
  assert.equal(stateAt(0), 'green');
  assert.equal(stateAt(19.999), 'green');
  assert.equal(stateAt(20), 'yellow');
  assert.equal(stateAt(29.999), 'yellow');
  assert.equal(stateAt(30), 'red');
  assert.equal(stateAt(90), 'red');
  assert.equal(view(store, 'tag').remainingMs, -60_000);
});

test('warning is a third of the session, capped at five minutes', () => {
  assert.equal(warningFor(30_000), 10_000);
  assert.equal(warningFor(3 * 60_000), 60_000);
  assert.equal(warningFor(60 * 60_000), 5 * 60_000);
});

test('extending a running session adds to its end time', () => {
  const { store, clock } = setup();
  store.register({ id: 'tag' });
  store.startSession('tag', { durationSeconds: 60 });
  clock.t += 50_000;
  store.extendSession('tag', { durationSeconds: 60 });
  assert.equal(view(store, 'tag').remainingMs, 70_000);
  assert.equal(view(store, 'tag').state, 'green');
});

test('extending an expired session counts from now', () => {
  const { store, clock } = setup();
  store.register({ id: 'tag' });
  store.startSession('tag', { durationSeconds: 30 });
  clock.t += 120_000;
  store.extendSession('tag', { durationSeconds: 60 });
  assert.equal(view(store, 'tag').remainingMs, 60_000);
  assert.equal(view(store, 'tag').state, 'green');
});

test('rejects bad input and conflicting actions', () => {
  const { store } = setup();
  const fails = (fn, code) => assert.throws(fn, { code });
  fails(() => store.register({ id: 'bad id!' }), 'invalid_id');
  store.register({ id: 'tag' });
  fails(() => store.register({ id: 'tag' }), 'already_registered');
  fails(() => store.register({ id: 'other', label: 'x'.repeat(41) }), 'invalid_label');
  fails(() => store.startSession('nope', { durationSeconds: 30 }), 'unknown_device');
  fails(() => store.startSession('tag', { durationSeconds: 5 }), 'invalid_duration');
  fails(() => store.startSession('tag', { durationSeconds: 30.5 }), 'invalid_duration');
  fails(() => store.extendSession('tag', { durationSeconds: 30 }), 'no_session');
  fails(() => store.endSession('tag'), 'no_session');
  store.startSession('tag', { durationSeconds: 30 });
  fails(() => store.startSession('tag', { durationSeconds: 30 }), 'session_open');
  fails(() => store.remove('tag'), 'session_open');
  store.remove('tag', { force: true });
  assert.equal(view(store, 'tag'), undefined);
});

test('a failed start does not change the label', () => {
  const { store } = setup();
  store.register({ id: 'tag', label: 'Visitor A' });
  assert.throws(() => store.startSession('tag', { durationSeconds: 1, label: 'Visitor B' }));
  assert.equal(view(store, 'tag').label, 'Visitor A');
});

test('online is judged by how recently the wristband was heard', () => {
  const { store, clock } = setup();
  store.register({ id: 'tag' });
  assert.equal(view(store, 'tag').online, false);
  store.recordSighting({ deviceId: 'tag', at: clock.t, rssi: -60 });
  clock.t += store.offlineAfterMs;
  assert.equal(view(store, 'tag').online, true);
  clock.t += 1;
  assert.equal(view(store, 'tag').online, false);
});

test('an old or future-dated sighting cannot distort last seen', () => {
  const { store, clock } = setup();
  store.register({ id: 'tag' });
  store.recordSighting({ deviceId: 'tag', at: clock.t, rssi: -60 });
  store.recordSighting({ deviceId: 'tag', at: clock.t - 5000, rssi: -80 });
  assert.equal(view(store, 'tag').lastSeenAt, clock.t);
  assert.equal(view(store, 'tag').rssi, -60);
  store.recordSighting({ deviceId: 'tag', at: clock.t + 999_999, rssi: -50 });
  assert.equal(view(store, 'tag').lastSeenAt, clock.t);
});

test('unregistered wristbands are listed until registered or stale', () => {
  const { store, clock } = setup();
  store.recordSighting({ deviceId: 'new', at: clock.t, rssi: -70 });
  assert.deepEqual(store.snapshot().nearby.map((entry) => entry.id), ['new']);
  store.register({ id: 'new' });
  assert.equal(store.snapshot().nearby.length, 0);
  assert.equal(view(store, 'new').lastSeenAt, clock.t);

  store.recordSighting({ deviceId: 'other', at: clock.t, rssi: -70 });
  clock.t += 61_000;
  assert.equal(store.snapshot().nearby.length, 0);
});

test('devices and sessions survive a restart, and session time keeps running', () => {
  const { store, clock, make } = setup();
  store.register({ id: 'tag', label: 'Visitor A' });
  store.startSession('tag', { durationSeconds: 60 });
  store.recordSighting({ deviceId: 'tag', at: clock.t, rssi: -60 });
  store.close();

  clock.t += 45_000;
  const restarted = make();
  assert.equal(restarted.load(), false);
  const device = view(restarted, 'tag');
  assert.equal(device.label, 'Visitor A');
  assert.equal(device.remainingMs, 15_000);
  assert.equal(device.state, 'yellow');
  assert.equal(device.lastSeenAt, clock.t - 45_000);
});

test('a damaged data file stops startup and is left untouched', () => {
  const { file, make, store } = setup();
  store.register({ id: 'tag' });
  writeFileSync(file, '{ not json');
  assert.throws(() => make().load(), /Cannot read/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
});
