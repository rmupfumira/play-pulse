// Entry point: wires the store, the feed adapter and the web server together.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapter } from './src/adapters/index.js';
import { createApp } from './src/app.js';
import { connectFeed } from './src/connect-feed.js';
import { seedDemoData } from './src/seed.js';
import { Store } from './src/store.js';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4310);
const host = process.env.HOST ?? '127.0.0.1';
const file = resolve(root, process.env.PLAYPULSE_DATA ?? 'data/playpulse.json');
const password = process.env.DASHBOARD_PASSWORD || undefined;

if (!password && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
  console.error(`Refusing to serve on ${host} without a login. Set DASHBOARD_PASSWORD.`);
  process.exit(1);
}

const store = new Store({ file });
const isFirstRun = store.load();
const adapter = createAdapter(process.env.ADAPTER ?? 'simulator', {
  getDeviceIds: () => store.snapshot().devices.map((device) => device.id),
  getSessions: () => store.sessions(),
});

if (isFirstRun && adapter.info().simulated) seedDemoData(store);

connectFeed(store, adapter);
adapter.start();
store.startFlushing();

const server = createApp({ store, adapter, publicDir: join(root, 'public'), password });
server.listen(port, host, () => {
  console.log(`PlayPulse dashboard: http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`);
  console.log(`Feed: ${adapter.info().name}. Data: ${file}`);
});

async function stop() {
  adapter.stop();
  store.close();
  await server.shutdown();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
