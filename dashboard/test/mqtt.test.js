import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MqttAdapter } from '../src/adapters/mqtt.js';
import { connectFeed } from '../src/connect-feed.js';
import { Store } from '../src/store.js';

class FakeClient extends EventEmitter {
  published = [];
  subscriptions = {};
  subscribe(topics) { this.subscriptions = topics; }
  publish(topic, body, options) { this.published.push({ topic, body: JSON.parse(body), options }); }
  end() {}
  to(topic) { return this.published.filter((message) => message.topic === topic); }
  receive(topic, body, { retain = false } = {}) {
    const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    this.emit('message', topic, payload, { retain });
  }
}

const quietLog = { log() {}, warn() {}, error() {} };
const sessionTopic = (id) => `playpulse/v1/devices/${id}/session`;
const NOW = 2_000_000;

function setup({ sessions = [], connected = true } = {}) {
  const client = new FakeClient();
  const adapter = new MqttAdapter({
    getSessions: () => sessions,
    url: 'mqtt://test',
    username: 'u',
    password: 'p',
    connect: () => client,
    now: () => NOW,
    log: quietLog,
  });
  adapter.start();
  if (connected) client.emit('connect');
  return { adapter, client };
}

// The adapter joined to a real store, through the same wiring as the server.
function setupWithStore() {
  const clock = { t: NOW };
  const file = join(mkdtempSync(join(tmpdir(), 'playpulse-')), 'data.json');
  const store = new Store({ file, now: () => clock.t });
  const client = new FakeClient();
  const adapter = new MqttAdapter({
    getSessions: () => store.sessions(),
    url: 'mqtt://test',
    username: 'u',
    password: 'p',
    connect: () => client,
    now: () => clock.t,
    log: quietLog,
  });
  connectFeed(store, adapter, quietLog);
  adapter.start();
  client.emit('connect');
  const device = (id) => store.snapshot().devices.find((candidate) => candidate.id === id);
  return { clock, store, client, adapter, device };
}

test('reports a real feed that can command devices', () => {
  const { adapter } = setup();
  const info = adapter.info();
  assert.equal(info.simulated, false);
  assert.equal(info.canCommandDevices, true);
  assert.equal(info.connected, true);
});

test('refuses to start without broker credentials', () => {
  assert.throws(() => new MqttAdapter({ url: 'mqtt://test', getSessions: () => [] }), /MQTT_USERNAME/);
});

test('on connect it subscribes and republishes the time and every session', () => {
  const session = { id: 'abc123', endsAt: 5000, warningMs: 1000, restarts: 0 };
  const { client } = setup({
    sessions: [{ deviceId: 'a', session }, { deviceId: 'b', session: null }],
  });
  assert.deepEqual(Object.keys(client.subscriptions).sort(), [
    'playpulse/v1/devices/+/event',
    'playpulse/v1/devices/+/session',
    'playpulse/v1/devices/+/status',
    'playpulse/v1/devices/+/telemetry',
  ]);
  assert.deepEqual(client.to('playpulse/v1/time'), [{
    topic: 'playpulse/v1/time',
    body: { now: NOW },
    options: { qos: 0, retain: true },
  }]);
  assert.deepEqual(client.to(sessionTopic('a'))[0].body, { sessionId: 'abc123', endsAt: 5000, warningMs: 1000 });
  assert.deepEqual(client.to(sessionTopic('b'))[0].body, { sessionId: null });
});

test('publishes the time every 10 s, retained', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { client } = setup();
  client.published.length = 0;
  t.mock.timers.tick(9999);
  assert.equal(client.to('playpulse/v1/time').length, 0);
  t.mock.timers.tick(1);
  assert.equal(client.to('playpulse/v1/time').length, 1);
  t.mock.timers.tick(10_000);
  assert.equal(client.to('playpulse/v1/time').length, 2);
});

test('session changes are published with the contract payload at QoS 1, retained', () => {
  const { store, client, device } = setupWithStore();
  const last = (id) => client.to(sessionTopic(id)).at(-1);

  store.register({ id: 'tag' });
  assert.deepEqual(last('tag').body, { sessionId: null });

  store.startSession('tag', { durationSeconds: 30 });
  const { id } = device('tag').session;
  assert.deepEqual(last('tag'), {
    topic: sessionTopic('tag'),
    body: { sessionId: id, endsAt: NOW + 30_000, warningMs: 10_000 },
    options: { qos: 1, retain: true },
  });

  store.extendSession('tag', { durationSeconds: 30 });
  assert.deepEqual(last('tag').body, { sessionId: id, endsAt: NOW + 60_000, warningMs: 10_000 });

  store.endSession('tag');
  assert.deepEqual(last('tag').body, { sessionId: null });

  store.startSession('tag', { durationSeconds: 30 });
  store.remove('tag', { force: true });
  assert.deepEqual(last('tag').body, { sessionId: null });
});

test('nothing is queued while disconnected; reconnecting publishes current state', () => {
  const { store, client, device } = setupWithStore();
  store.register({ id: 'tag' });
  client.emit('close');
  client.published.length = 0;
  store.startSession('tag', { durationSeconds: 30 });
  store.extendSession('tag', { durationSeconds: 30 });
  assert.equal(client.published.length, 0);

  client.emit('connect');
  const sent = client.to(sessionTopic('tag'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.sessionId, device('tag').session.id);
  assert.equal(sent[0].body.endsAt, NOW + 60_000);
});

test('telemetry sets last seen and RSSI and is kept as a report only', () => {
  const { store, client, device, clock } = setupWithStore();
  store.register({ id: 'tag' });
  store.startSession('tag', { durationSeconds: 30 });
  const before = structuredClone(device('tag').session);
  clock.t += 5000;
  client.receive('playpulse/v1/devices/tag/telemetry', {
    state: 'red', remainingMs: 0, sessionId: 'other', rssi: -58, uptimeMs: 90500,
  });
  const after = device('tag');
  assert.deepEqual(after.session, before);
  assert.equal(after.state, 'green');
  assert.equal(after.lastSeenAt, clock.t);
  assert.equal(after.rssi, -58);
  assert.equal(after.online, true);
  assert.equal(after.report.state, 'red');
  assert.equal(after.report.verdict, 'session');
});

test('invalid, malformed and retained telemetry are ignored', () => {
  const { store, client, device } = setupWithStore();
  store.register({ id: 'tag' });
  const topic = 'playpulse/v1/devices/tag/telemetry';
  client.receive(topic, 'not json');
  client.receive(topic, { state: 'purple', remainingMs: 0, sessionId: null });
  client.receive(topic, { state: 'idle', remainingMs: 'soon', sessionId: null });
  client.receive(topic, 'null');
  client.receive(topic, { state: 'idle', remainingMs: 0, sessionId: null }, { retain: true });
  client.receive('playpulse/v1/devices/a/b/telemetry', { state: 'idle', remainingMs: 0, sessionId: null });
  assert.equal(device('tag').lastSeenAt, null);
  assert.equal(device('tag').report, null);
});

test('status maps to online, with a retained message not counting as seen', () => {
  const { store, client, device, clock } = setupWithStore();
  store.register({ id: 'tag' });
  const topic = 'playpulse/v1/devices/tag/status';

  client.receive(topic, { online: true, firmware: '0.2.0' }, { retain: true });
  assert.equal(device('tag').lastSeenAt, null);
  assert.equal(device('tag').firmware, '0.2.0');
  assert.equal(device('tag').online, false);

  client.receive(topic, { online: true, firmware: '0.2.0' });
  assert.equal(device('tag').lastSeenAt, clock.t);
  assert.equal(device('tag').online, true);

  client.receive(topic, { online: false });
  assert.equal(device('tag').online, false);
  assert.equal(device('tag').lastSeenAt, clock.t);
});

test('restart_requested restarts the current session and republishes it', () => {
  const { store, client, device, clock } = setupWithStore();
  store.register({ id: 'tag' });
  store.startSession('tag', { durationSeconds: 30 });
  store.extendSession('tag', { durationSeconds: 60 });
  const { id } = device('tag').session;

  clock.t += 100_000;
  client.receive('playpulse/v1/devices/tag/event', { type: 'restart_requested', sessionId: id });

  const session = device('tag').session;
  assert.notEqual(session.id, id);
  assert.equal(session.endsAt, clock.t + 30_000);
  assert.equal(session.restarts, 1);
  assert.equal(session.lastRestartAt, clock.t);
  assert.deepEqual(client.to(sessionTopic('tag')).at(-1).body, {
    sessionId: session.id, endsAt: clock.t + 30_000, warningMs: 10_000,
  });
});

test('a stale restart event changes nothing and publishes nothing', () => {
  const { store, client, device } = setupWithStore();
  store.register({ id: 'tag' });
  store.startSession('tag', { durationSeconds: 30 });
  const before = structuredClone(device('tag').session);
  const published = client.published.length;
  const topic = 'playpulse/v1/devices/tag/event';

  client.receive(topic, { type: 'restart_requested', sessionId: 'old-session' });
  client.receive(topic, { type: 'restart_requested', sessionId: null });
  client.receive(topic, { type: 'restart_requested' });
  client.receive(topic, { type: 'something_else', sessionId: before.id });

  assert.deepEqual(device('tag').session, before);
  assert.equal(client.published.length, published);
});

test('a redelivered restart event only restarts once', () => {
  const { store, client, device, clock } = setupWithStore();
  store.register({ id: 'tag' });
  store.startSession('tag', { durationSeconds: 30 });
  const event = { type: 'restart_requested', sessionId: device('tag').session.id };
  client.receive('playpulse/v1/devices/tag/event', event);
  const { endsAt } = device('tag').session;
  clock.t += 5000;
  client.receive('playpulse/v1/devices/tag/event', event);
  assert.equal(device('tag').session.restarts, 1);
  assert.equal(device('tag').session.endsAt, endsAt);
});

test('a restart event for an idle or unknown wristband is ignored', () => {
  const { store, client } = setupWithStore();
  store.register({ id: 'tag' });
  const published = client.published.length;
  client.receive('playpulse/v1/devices/tag/event', { type: 'restart_requested', sessionId: 'x' });
  client.receive('playpulse/v1/devices/ghost/event', { type: 'restart_requested', sessionId: 'x' });
  assert.equal(client.published.length, published);
});

test('an unregistered wristband is listed as nearby from telemetry', () => {
  const { store, client } = setupWithStore();
  client.receive('playpulse/v1/devices/new/telemetry', {
    state: 'idle', remainingMs: 0, sessionId: null, rssi: -70,
  });
  assert.deepEqual(store.snapshot().nearby.map((entry) => entry.id), ['new']);
});

test('a leftover retained session for an unregistered wristband is cleared', () => {
  const { store, client } = setupWithStore();
  store.register({ id: 'known' });
  const payload = { sessionId: 'old', endsAt: 1, warningMs: 1 };
  client.published.length = 0;

  client.receive(sessionTopic('gone'), payload, { retain: true });
  client.receive(sessionTopic('gone'), { sessionId: null }, { retain: true });
  client.receive(sessionTopic('other'), payload);
  client.receive(sessionTopic('known'), payload, { retain: true });

  assert.equal(client.published.length, 1);
  assert.deepEqual(client.published[0].body, { sessionId: null });
  assert.equal(client.published[0].topic, sessionTopic('gone'));
});

test('losing the broker is reported, and errors do not throw', () => {
  const { adapter, client } = setup();
  let changes = 0;
  adapter.on('status', () => { changes += 1; });
  client.emit('close');
  assert.equal(adapter.info().connected, false);
  client.emit('error', new Error('Connection refused: Not authorized'));
  assert.match(adapter.info().detail, /Not authorized/);
  assert.equal(changes, 2);
});
