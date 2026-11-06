// End-to-end check against the real broker: a real dashboard process, a fake watch
// and an independent MQTT client. Needs the broker running. Uses its own port, data
// file and wristband IDs, and clears what it left on the broker.
//
//   npm run verify:mqtt
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mqtt from 'mqtt';
import { FakeWatch } from './fake-watch.js';

const PORT = 4399;
const API = `http://127.0.0.1:${PORT}/api`;
const { MQTT_URL: url, MQTT_USERNAME: username, MQTT_PASSWORD: password } = process.env;
const credentials = { url, username, password };
const dataFile = join(mkdtempSync(join(tmpdir(), 'playpulse-verify-')), 'data.json');
const WATCH = 'Verify_Watch_A';
const SKEWED = 'Verify_Watch_B';
const GHOST = 'Verify_Ghost';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, check, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await delay(100);
  }
}

async function call(method, path, body = {}) {
  const response = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${json.error.message}`);
  return json;
}

const state = async () => (await fetch(`${API}/state`)).json();
const device = async (id) => (await state()).devices.find((candidate) => candidate.id === id);

function startDashboard() {
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, ADAPTER: 'mqtt', PORT, HOST: '127.0.0.1', PLAYPULSE_DATA: dataFile, DASHBOARD_PASSWORD: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.output += chunk; });
  return child;
}

function connectOnce(options) {
  return new Promise((resolve) => {
    const client = mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: 4000, ...options });
    client.once('connect', () => { client.end(); resolve('connected'); });
    client.once('error', (err) => { client.end(true); resolve(err.message); });
  });
}

const steps = [];
async function step(name, run) {
  await run();
  steps.push(name);
  console.log(`PASS  ${name}`);
}

const observer = mqtt.connect(url, { username, password });
const retained = new Map();
observer.on('message', (topic, payload) => {
  retained.set(topic, payload.length ? JSON.parse(payload.toString('utf8')) : null);
});
await new Promise((resolve) => observer.once('connect', resolve));
await observer.subscribeAsync({ 'playpulse/v1/#': { qos: 1 } });

// A second dashboard would publish its own time and sessions over this one's.
const otherDashboard = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 11_000);
  observer.on('message', (topic, _payload, packet) => {
    if (topic !== 'playpulse/v1/time' || packet.retain) return;
    clearTimeout(timer);
    resolve(true);
  });
});
if (otherDashboard) {
  console.error('Another MQTT dashboard is using this broker. Stop it, then run this again.');
  process.exit(1);
}

const seenSession = (id) => retained.get(`playpulse/v1/devices/${id}/session`);
let dashboard = startDashboard();
const watch = new FakeWatch({ id: WATCH, ...credentials, telemetryMs: 1000, firmware: '0.2.0-fake' });
const skewed = new FakeWatch({ id: SKEWED, ...credentials, telemetryMs: 1000, countdownSkewMs: 20_000 });

try {
  await step('anonymous and wrong-password clients are refused', async () => {
    assert.match(await connectOnce({}), /Not authorized|Bad username/i);
    assert.match(await connectOnce({ username, password: 'wrong' }), /Not authorized|Bad username/i);
    assert.equal(await connectOnce({ username, password }), 'connected');
  });

  await step('the dashboard connects and reports a live, commandable feed', async () => {
    const { adapter } = await until('dashboard connected', async () => {
      const snapshot = await state();
      return snapshot.adapter.connected && snapshot;
    });
    assert.equal(adapter.simulated, false);
    assert.equal(adapter.canCommandDevices, true);
  });

  await step('time is retained and republished 10 s later', async () => {
    const topic = 'playpulse/v1/time';
    const first = await until('time', async () => retained.get(topic));
    const later = await until('next time', async () => {
      const value = retained.get(topic);
      return value.now > first.now && value;
    }, 12_000);
    assert.ok(Math.abs(later.now - first.now - 10_000) < 1000, `interval ${later.now - first.now}`);
  });

  await step('an unregistered watch appears under detected', async () => {
    watch.start();
    await until('nearby', async () => (await state()).nearby.some((entry) => entry.id === WATCH));
  });

  await step('registering publishes "no session" and maps status and telemetry', async () => {
    await call('POST', '/devices', { id: WATCH, label: 'Verify' });
    await until('retained null session', async () => seenSession(WATCH)?.sessionId === null);
    const seen = await until('online with firmware', async () => {
      const item = await device(WATCH);
      return item.online && item.firmware === '0.2.0-fake' && item.rssi === -58 && item;
    });
    assert.ok(Date.now() - seen.lastSeenAt < 3000);
    await until('idle report agrees', async () => (await device(WATCH)).report?.verdict === 'ok');
  });

  let firstId;
  await step('start publishes the exact session and the watch follows it', async () => {
    const { session } = await call('POST', `/devices/${WATCH}/session`, { durationSeconds: 60 });
    firstId = session.id;
    const sent = await until('retained session', async () => {
      const value = seenSession(WATCH);
      return value?.sessionId === firstId && value;
    });
    assert.deepEqual(sent, { sessionId: firstId, endsAt: session.endsAt, warningMs: 20_000 });
    await until('watch received it', async () => watch.session?.sessionId === firstId);
    await until('report agrees', async () => (await device(WATCH)).report?.verdict === 'ok');
    assert.equal((await device(WATCH)).report.state, 'green');
  });

  await step('extend keeps the session ID and moves the end time', async () => {
    const before = (await device(WATCH)).session.endsAt;
    await call('POST', `/devices/${WATCH}/session/extend`, { durationSeconds: 60 });
    await until('new end time', async () => seenSession(WATCH).endsAt === before + 60_000);
    assert.equal(seenSession(WATCH).sessionId, firstId);
  });

  await step('a stale restart event changes nothing', async () => {
    const before = await device(WATCH);
    watch.holdScreen('stale-session');
    await until('logged', async () => dashboard.output.includes('ignored restart for stale session stale-session'));
    const after = await device(WATCH);
    assert.deepEqual(after.session, before.session);
  });

  let secondId;
  await step('a restart from the watch uses the original duration and shows it happened', async () => {
    watch.holdScreen();
    const session = await until('restarted', async () => {
      const current = (await device(WATCH)).session;
      return current.restarts === 1 && current;
    });
    secondId = session.id;
    assert.notEqual(secondId, firstId);
    assert.equal(session.endsAt - session.startedAt, 60_000);
    assert.equal(session.durationMs, 60_000);
    assert.ok(session.lastRestartAt);
    await until('republished', async () => seenSession(WATCH).sessionId === secondId);
    await until('watch received it', async () => watch.session?.sessionId === secondId);
  });

  await step('replaying the old restart event is ignored', async () => {
    watch.holdScreen(firstId);
    await until('logged', async () => dashboard.output.includes(`stale session ${firstId}`));
    assert.equal((await device(WATCH)).session.restarts, 1);
  });

  await step('a watch whose countdown disagrees is flagged, without changing the session', async () => {
    await call('POST', '/devices', { id: SKEWED });
    skewed.start();
    const { session } = await call('POST', `/devices/${SKEWED}/session`, { durationSeconds: 120 });
    await until('mismatch', async () => (await device(SKEWED)).report?.verdict === 'time');
    assert.deepEqual((await device(SKEWED)).session, session);
    skewed.countdownSkewMs = 0;
    await until('mismatch clears', async () => (await device(SKEWED)).report?.verdict === 'ok');
  });

  await step('a watch on an old session is flagged', async () => {
    skewed.pretendSessionId = 'some-old-session';
    await until('mismatch', async () => (await device(SKEWED)).report?.verdict === 'session');
    skewed.pretendSessionId = undefined;
  });

  await step('a dropped watch goes offline through its Last Will', async () => {
    const started = Date.now();
    skewed.crash();
    await until('offline', async () => (await device(SKEWED)).online === false);
    assert.ok(Date.now() - started < 10_000, 'should beat the 15 s silence timeout');
    assert.deepEqual(retained.get(`playpulse/v1/devices/${SKEWED}/status`), { online: false });
    console.log(`      offline after ${Date.now() - started} ms`);
  });

  await step('after a dashboard restart the broker holds the right sessions', async () => {
    const before = await device(WATCH);
    dashboard.kill();
    await new Promise((resolve) => dashboard.once('exit', resolve));

    // While it is down, the broker picks up wrong and leftover state.
    await observer.publishAsync(`playpulse/v1/devices/${WATCH}/session`, '{"sessionId":"wrong"}', { qos: 1, retain: true });
    await observer.publishAsync(`playpulse/v1/devices/${GHOST}/session`, '{"sessionId":"left-over"}', { qos: 1, retain: true });
    await until('wrong state in place', async () => seenSession(GHOST)?.sessionId === 'left-over');

    dashboard = startDashboard();
    await until('session corrected', async () => seenSession(WATCH).sessionId === before.session.id);
    await until('leftover cleared', async () => seenSession(GHOST)?.sessionId === null);
    assert.equal(seenSession(WATCH).endsAt, before.session.endsAt);
    await until('state back', async () => (await device(WATCH))?.session.id === before.session.id);
    await until('report agrees again', async () => (await device(WATCH)).report?.verdict === 'ok');
  });

  await step('end publishes "no session" and the watch goes idle', async () => {
    await call('POST', `/devices/${WATCH}/session/end`);
    await until('null session', async () => seenSession(WATCH).sessionId === null);
    await until('watch idle', async () => watch.display().state === 'idle');
    await until('report agrees', async () => (await device(WATCH)).report?.state === 'idle');
  });

  await step('removing a wristband with a session publishes "no session"', async () => {
    await call('DELETE', `/devices/${SKEWED}`, { force: true });
    await until('null session', async () => seenSession(SKEWED).sessionId === null);
  });

  console.log(`\n${steps.length} steps passed.`);
} catch (err) {
  console.error(`\nFAIL  ${err.message}\n--- dashboard log ---\n${dashboard.output}`);
  process.exitCode = 1;
} finally {
  dashboard.kill();
  await watch.stop().catch(() => {});
  for (const id of [WATCH, SKEWED, GHOST]) {
    for (const kind of ['session', 'status']) {
      await observer.publishAsync(`playpulse/v1/devices/${id}/${kind}`, '', { qos: 1, retain: true });
    }
  }
  await observer.endAsync();
  process.exit();
}
