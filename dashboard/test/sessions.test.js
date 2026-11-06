import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareReport, Store } from '../src/store.js';

function setup() {
  const clock = { t: 1_000_000 };
  const file = join(mkdtempSync(join(tmpdir(), 'playpulse-')), 'data.json');
  const store = new Store({ file, now: () => clock.t });
  const device = (id) => store.snapshot().devices.find((candidate) => candidate.id === id);
  return { clock, file, store, device };
}

const session = { id: 's1', endsAt: 100_000, warningMs: 10_000 };
const report = (at, state, remainingMs, sessionId = 's1') => ({ at, state, remainingMs, sessionId });
const CHANGED = 0;

test('a report that agrees with the server is ok', () => {
  assert.equal(compareReport(report(50_000, 'green', 50_000), session, CHANGED), 'ok');
  assert.equal(compareReport(report(95_000, 'yellow', 5000), session, CHANGED), 'ok');
  assert.equal(compareReport(report(120_000, 'red', 0), session, CHANGED), 'ok');
  assert.equal(compareReport(report(50_000, 'idle', 0, null), null, CHANGED), 'ok');
});

test('small delays around a state boundary are not flagged', () => {
  assert.equal(compareReport(report(89_000, 'yellow', 9000), session, CHANGED), 'ok');
  assert.equal(compareReport(report(91_000, 'green', 11_000), session, CHANGED), 'ok');
  assert.equal(compareReport(report(99_000, 'red', 0), session, CHANGED), 'ok');
});

test('a different session, countdown or state is flagged', () => {
  assert.equal(compareReport(report(50_000, 'green', 50_000, 'old'), session, CHANGED), 'session');
  assert.equal(compareReport(report(50_000, 'idle', 0, null), session, CHANGED), 'session');
  assert.equal(compareReport(report(50_000, 'green', 50_000), null, CHANGED), 'session');
  assert.equal(compareReport(report(50_000, 'green', 40_000), session, CHANGED), 'time');
  assert.equal(compareReport(report(50_000, 'yellow', 50_000), session, CHANGED), 'state');
  assert.equal(compareReport(report(50_000, 'green', 0, null), null, CHANGED), 'state');
});

test('a report arriving just after a session change is not judged', () => {
  assert.equal(compareReport(report(1000, 'idle', 0, null), session, 0), 'pending');
});

test('a report from a silent watch is marked stale, not as a mismatch', () => {
  const { store, clock, device } = setup();
  store.register({ id: 'tag' });
  clock.t += 5000;
  store.recordSighting({ deviceId: 'tag', report: { state: 'green', remainingMs: 1, sessionId: 'x' } });
  assert.equal(device('tag').report.verdict, 'session');
  clock.t += store.offlineAfterMs + 1;
  assert.equal(device('tag').report.verdict, 'stale');
});

test('a sighting without RSSI keeps the last value', () => {
  const { store, device } = setup();
  store.register({ id: 'tag' });
  store.recordSighting({ deviceId: 'tag', rssi: -60 });
  store.recordSighting({ deviceId: 'tag' });
  assert.equal(device('tag').rssi, -60);
});

test('status heard before registration is kept for it', () => {
  const { store, device } = setup();
  store.recordPresence({ deviceId: 'early', online: true, firmware: '0.2.0', live: true });
  store.recordPresence({ deviceId: 'gone', online: false, live: false });
  store.register({ id: 'early' });
  store.register({ id: 'gone' });
  assert.equal(device('early').firmware, '0.2.0');
  assert.equal(device('early').online, true);
  assert.equal(device('gone').reportedOffline, true);
});

test('session change events carry the device and its session', () => {
  const { store, device } = setup();
  const events = [];
  store.on('session', (event) => events.push(event));
  store.register({ id: 'tag' });
  store.startSession('tag', { durationSeconds: 30 });
  store.endSession('tag');
  store.remove('tag');
  assert.deepEqual(events.map((event) => [event.deviceId, Boolean(event.session)]), [
    ['tag', false], ['tag', true], ['tag', false], ['tag', false],
  ]);
  assert.equal(device('tag'), undefined);
});

test('a session started before IDs existed gets one on load', () => {
  const { file, clock } = setup();
  const legacy = { id: 'tag', label: '', session: { startedAt: 1, endsAt: 2, durationMs: 1, warningMs: 1 } };
  writeFileSync(file, JSON.stringify({ version: 1, devices: [legacy] }));
  const store = new Store({ file, now: () => clock.t });
  store.load();
  const [{ session: loaded }] = store.sessions();
  assert.ok(loaded.id);
  assert.equal(loaded.originalDurationMs, 1);
  assert.equal(loaded.restarts, 0);
});
