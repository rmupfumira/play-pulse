// Exercises the HTTP API with a stand-in feed, which also proves a non-simulator
// adapter can be plugged in through the adapter contract alone.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';

class FakeFeed extends EventEmitter {
  info() {
    return { id: 'fake', name: 'Fake', simulated: false, connected: true, canCommandDevices: false, detail: '' };
  }
}

const feed = new FakeFeed();
let server;
let base;

async function call(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'playpulse-')), 'data.json');
  const store = new Store({ file });
  feed.on('sighting', (sighting) => store.recordSighting(sighting));
  const publicDir = fileURLToPath(new URL('../public', import.meta.url));
  server = createApp({ store, adapter: feed, publicDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.shutdown());

test('register, start, extend, end and remove over HTTP', async () => {
  assert.equal((await call('POST', '/api/devices', { id: 'Tag_A', label: 'Visitor A' })).status, 201);
  assert.equal((await call('POST', '/api/devices', { id: 'Tag_A' })).body.error.code, 'already_registered');
  assert.equal((await call('PATCH', '/api/devices/Tag_A', { label: 'Visitor Z' })).body.label, 'Visitor Z');

  assert.equal((await call('POST', '/api/devices/Tag_A/session', { durationSeconds: 60 })).status, 201);
  const extended = await call('POST', '/api/devices/Tag_A/session/extend', { durationSeconds: 60 });
  assert.equal(extended.body.session.durationMs, 120_000);

  assert.equal((await call('DELETE', '/api/devices/Tag_A', {})).status, 409);
  assert.equal((await call('POST', '/api/devices/Tag_A/session/end', {})).status, 200);
  assert.equal((await call('DELETE', '/api/devices/Tag_A', {})).status, 200);
  assert.equal((await call('GET', '/api/state')).body.devices.length, 0);
});

test('sightings from a plugged-in feed reach the state', async () => {
  await call('POST', '/api/devices', { id: 'Tag_B' });
  feed.emit('sighting', { deviceId: 'Tag_B', at: Date.now(), rssi: -61 });
  const { body } = await call('GET', '/api/state');
  assert.equal(body.adapter.simulated, false);
  assert.equal(body.devices.find((device) => device.id === 'Tag_B').online, true);
});

test('writes that are not JSON are refused', async () => {
  const response = await fetch(`${base}/api/devices`, { method: 'POST', body: 'id=Tag_C' });
  assert.equal(response.status, 415);
});

test('bad requests get a JSON error, not a crash', async () => {
  assert.equal((await call('PATCH', '/api/devices/%E0%A4%A', {})).status, 400);
  assert.equal((await call('GET', '/api/nope')).status, 404);
  const response = await fetch(`${base}/api/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(response.status, 400);
});

test('only the known page files are served', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/server.js`)).status, 404);
});

test('the event stream sends state immediately', async () => {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /event: state\ndata: \{/);
  controller.abort();
});
