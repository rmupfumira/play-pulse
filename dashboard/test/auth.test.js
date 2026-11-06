import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { Logins } from '../src/auth.js';
import { Store } from '../src/store.js';

class FakeFeed extends EventEmitter {
  info() {
    return { id: 'fake', name: 'Fake', simulated: false, connected: true, canCommandDevices: false, detail: '' };
  }
}

const PASSWORD = 'correct horse';
let server;
let base;

const get = (path, headers = {}) => fetch(base + path, { headers, redirect: 'manual' });

function post(path, body, headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

async function signIn() {
  const response = await post('/api/login', { password: PASSWORD });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

before(async () => {
  const store = new Store({ file: join(mkdtempSync(join(tmpdir(), 'playpulse-')), 'data.json') });
  const publicDir = fileURLToPath(new URL('../public', import.meta.url));
  server = createApp({ store, adapter: new FakeFeed(), publicDir, logins: new Logins(PASSWORD) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.shutdown());

test('the page sends a signed-out browser to the login screen', async () => {
  const response = await get('/');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login');
});

test('the login screen and what it needs are public', async () => {
  for (const path of ['/login', '/login.js', '/styles.css', '/Outfit.ttf', '/icon.svg']) {
    assert.equal((await get(path)).status, 200, path);
  }
});

for (const path of ['/app.js', '/api/state', '/api/events']) {
  test(`${path} needs a sign-in`, async () => {
    assert.equal((await get(path)).status, 401);
  });
}

test('a write without a sign-in changes nothing', async () => {
  assert.equal((await post('/api/devices', { id: 'Tag_A' })).status, 401);
  const state = await get('/api/state', { Cookie: await signIn() });
  assert.equal((await state.json()).devices.length, 0);
});

test('a forged cookie is refused', async () => {
  assert.equal((await get('/api/state', { Cookie: 'playpulse_session=forged' })).status, 401);
});

test('signing in gives a cookie scripts cannot read', async () => {
  const response = await post('/api/login', { password: PASSWORD });
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
});

test('a signed-in browser reaches the page and skips the login screen', async () => {
  const Cookie = await signIn();
  assert.equal((await get('/', { Cookie })).status, 200);
  assert.equal((await get('/login', { Cookie })).headers.get('location'), '/');
  assert.equal((await (await get('/api/state', { Cookie })).json()).signInRequired, true);
});

test('signing out ends that sign-in', async () => {
  const Cookie = await signIn();
  assert.equal((await post('/api/logout', {}, { Cookie })).status, 200);
  assert.equal((await get('/api/state', { Cookie })).status, 401);
});

test('a login without JSON is refused', async () => {
  const response = await fetch(`${base}/api/login`, { method: 'POST', body: `password=${PASSWORD}` });
  assert.equal(response.status, 415);
});

test('repeated wrong passwords lock that address for a minute', () => {
  let time = 1000;
  const logins = new Logins('right', { now: () => time });
  for (let i = 0; i < 5; i++) assert.throws(() => logins.signIn('a', 'wrong'), { status: 401 });
  assert.throws(() => logins.signIn('a', 'right'), { status: 429 });
  assert.ok(logins.signIn('b', 'right'), 'another address is not locked');
  time += 61_000;
  assert.ok(logins.signIn('a', 'right'));
});

test('a sign-in expires after the shift', () => {
  let time = 1000;
  const logins = new Logins('right', { now: () => time });
  const cookie = logins.signIn('a', 'right').split(';')[0];
  assert.equal(logins.isSignedIn(cookie), true);
  time += 13 * 60 * 60 * 1000;
  assert.equal(logins.isSignedIn(cookie), false);
});
