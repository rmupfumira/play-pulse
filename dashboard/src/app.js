// HTTP API, live event stream and static files.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { StoreError } from './store.js';

const PUSH_INTERVAL_MS = 1000;
const MAX_BODY_BYTES = 16 * 1024;

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'",
};

function sendJson(res, status, body) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Requiring JSON makes a browser preflight cross-site writes, which this server
// never approves, so other websites cannot drive the API from a staff browser.
async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new StoreError(415, 'json_required', 'Send application/json.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new StoreError(413, 'too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw new StoreError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
}

const sha256 = (text) => createHash('sha256').update(text).digest();

// HTTP Basic, so the browser handles the prompt and sends it on every request,
// including the event stream. Only the password is checked; any username works.
function hasPassword(req, password) {
  const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const given = decoded.slice(decoded.indexOf(':') + 1);
  return timingSafeEqual(sha256(given), sha256(password));
}

// With no password every request is allowed, which server.js permits only on
// a loopback address.
export function createApp({ store, adapter, publicDir, password }) {
  const clients = new Set();
  const snapshot = () => ({ ...store.snapshot(), adapter: adapter.info() });

  const broadcast = () => {
    if (clients.size === 0) return;
    const frame = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const client of clients) client.write(frame);
  };

  const routes = [
    ['GET', /^\/api\/state$/, () => [200, snapshot()]],
    ['POST', /^\/api\/devices$/, (_id, body) => [201, store.register(body)]],
    ['PATCH', /^\/api\/devices\/([^/]+)$/, (id, body) => [200, store.rename(id, body)]],
    ['DELETE', /^\/api\/devices\/([^/]+)$/, (id, body) => {
      store.remove(id, { force: body.force === true });
      return [200, { removed: id }];
    }],
    ['POST', /^\/api\/devices\/([^/]+)\/session$/, (id, body) => [201, store.startSession(id, body)]],
    ['POST', /^\/api\/devices\/([^/]+)\/session\/extend$/, (id, body) => [200, store.extendSession(id, body)]],
    ['POST', /^\/api\/devices\/([^/]+)\/session\/end$/, (id) => [200, store.endSession(id)]],
  ];

  async function handleApi(req, res, path) {
    for (const [method, pattern, handler] of routes) {
      const match = method === req.method && pattern.exec(path);
      if (!match) continue;
      const body = method === 'GET' ? {} : await readJson(req);
      const id = match[1] === undefined ? undefined : decodeURIComponent(match[1]);
      const [status, result] = handler(id, body);
      return sendJson(res, status, result);
    }
    throw new StoreError(404, 'not_found', 'No such endpoint.');
  }

  function openEventStream(req, res) {
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
    });
    res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  async function handle(req, res) {
    if (password && !hasPassword(req, password)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="PlayPulse", charset="UTF-8"');
      throw new StoreError(401, 'password_required', 'Enter the dashboard password.');
    }
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/api/events') return openEventStream(req, res);
    if (path.startsWith('/api/')) return handleApi(req, res, path);

    const file = STATIC_FILES[path];
    if (req.method !== 'GET' || !file) throw new StoreError(404, 'not_found', 'Not found.');
    const content = await readFile(join(publicDir, file[0]));
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': file[1] });
    res.end(content);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof URIError) err = new StoreError(400, 'invalid_id', 'Malformed wristband ID.');
      if (!(err instanceof StoreError)) console.error(err);
      const status = err instanceof StoreError ? err.status : 500;
      const code = err instanceof StoreError ? err.code : 'server_error';
      const message = err instanceof StoreError ? err.message : 'The server could not complete that.';
      sendJson(res, status, { error: { code, message } });
    });
  });

  const pushTimer = setInterval(broadcast, PUSH_INTERVAL_MS);
  pushTimer.unref();
  store.on('change', broadcast);
  adapter.on('status', broadcast);

  server.shutdown = () => {
    clearInterval(pushTimer);
    for (const client of clients) client.end();
    return new Promise((resolve) => server.close(resolve));
  };
  return server;
}
