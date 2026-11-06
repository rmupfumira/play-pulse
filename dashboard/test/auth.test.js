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

const basic = (password) => `Basic ${Buffer.from(`staff:${password}`).toString('base64')}`;
let server;
let base;

before(async () => {
  const store = new Store({ file: join(mkdtempSync(join(tmpdir(), 'playpulse-')), 'data.json') });
  const publicDir = fileURLToPath(new URL('../public', import.meta.url));
  server = createApp({ store, adapter: new FakeFeed(), publicDir, password: 'p:ss word' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.shutdown());

for (const path of ['/', '/app.js', '/api/state', '/api/events']) {
  test(`${path} needs the password`, async () => {
    const response = await fetch(base + path);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /^Basic /);
  });
}

test('a write without the password changes nothing', async () => {
  const response = await fetch(`${base}/api/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'Tag_A' }),
  });
  assert.equal(response.status, 401);
  const state = await fetch(`${base}/api/state`, { headers: { Authorization: basic('p:ss word') } });
  assert.equal((await state.json()).devices.length, 0);
});

test('the wrong password is refused', async () => {
  const response = await fetch(`${base}/api/state`, { headers: { Authorization: basic('nope') } });
  assert.equal(response.status, 401);
});

test('the right password works, including one with a colon', async () => {
  const response = await fetch(`${base}/api/state`, { headers: { Authorization: basic('p:ss word') } });
  assert.equal(response.status, 200);
});

test('a malformed header is refused', async () => {
  const response = await fetch(`${base}/api/state`, { headers: { Authorization: 'Basic' } });
  assert.equal(response.status, 401);
});
