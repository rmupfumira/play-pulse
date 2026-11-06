# PlayPulse dashboard

Local staff dashboard for PlayPulse wristbands. Staff register wristbands, run
sessions, and see which ones are expired or ending soon.

It runs in one of two modes:

- **Simulator** (default): generated traffic, with a banner on the page saying so.
- **MQTT**: real watches over the [broker](../broker/README.md), implementing
  [`docs/mqtt-contract.md`](../docs/mqtt-contract.md).

To deploy it on a server, see the [project README](../README.md). The rest of this
page is for working on it directly.

## Run it

Needs Node.js 20.6 or newer.

```bash
cd dashboard
```

```bash
npm install
```

Simulator, at <http://localhost:4310>:

```bash
npm start
```

MQTT, at <http://localhost:4311>. Start the broker first. This reads its settings
from `broker/.env`:

```bash
npm run start:mqtt
```

The modes keep separate data files, so simulated wristbands never mix with real
ones, and they can run side by side. In the Claude desktop app, `dashboard` and
`dashboard-mqtt` in `.claude/launch.json` start the same two servers.

```bash
npm test
```

With the broker running, this checks the whole contract with a real dashboard and
fake watches, using its own port and data. Stop any MQTT dashboard first, because
only one can use a broker at a time:

```bash
npm run verify:mqtt
```

To try the MQTT mode without hardware, run a fake watch. It appears under
"Detected, not registered":

```bash
node --env-file=../broker/.env tools/fake-watch.js PlayPark_Tag_99
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4310` | Web port |
| `HOST` | `127.0.0.1` | Bind address. Any address other than loopback needs `DASHBOARD_PASSWORD`. |
| `DASHBOARD_PASSWORD` | none | Staff password for the page and the API. The browser asks for it; any username works. |
| `ADAPTER` | `simulator` | `simulator` or `mqtt` |
| `PLAYPULSE_DATA` | `data/playpulse.json` | Data file, relative to `dashboard/` |
| `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD` | none | Broker connection, required for `mqtt` |

If the data file is damaged the server refuses to start rather than overwrite it.
Delete `data/playpulse.json` while the server is stopped to get the demo data back.

## Why this stack

Node.js, a JSON file, Server-Sent Events and vanilla JavaScript. There is no
build step or native SQLite build on Windows, a handful of wristbands is very
little state, and the page only needs updates from the server. The one runtime
dependency is the `mqtt` package, because MQTT has to handle reconnection, QoS and
Last Will correctly and hand-writing that would be the riskiest code here. Move
to SQLite if ended sessions need keeping for reporting.

## How it behaves

- **The server owns session time.** A session is stored as start and end
  timestamps, and its state is worked out on each read, so it keeps running
  through a restart. The watch displays what the server tells it.
- **States:** Green is active, Yellow is ending soon, Red is expired. Red stays
  until staff extend or end the session.
- **Warning window:** a third of the session, capped at 5 minutes. A 30 second
  session warns at 10 seconds, matching the firmware's bench values.
- **Extending** adds to the end time. An expired session is extended from now,
  so the visitor gets all the time granted.
- **Online** means the last status was online and the wristband was heard in the
  last 15 seconds. A Last Will takes it offline straight away.
- **Ended sessions are not kept.** Only the current session of each wristband is
  stored.

With MQTT, each wristband also shows what the watch reports. A different session,
a state that doesn't fit, or a countdown more than 3 seconds out is flagged as a
mismatch. Telemetry never changes a session. A restart from the watch screen shows
as a notice and on the row, because anyone can hold the screen.

If the broker is unreachable a banner says so, wristbands show offline, and
sessions keep running. The broker is brought up to date on reconnect.

## Adapters

All wristband traffic goes through one adapter. The contract is at the top of
[`src/adapters/index.js`](src/adapters/index.js), and
[`src/connect-feed.js`](src/connect-feed.js) joins an adapter to the store. Gateways
need no new adapter if they publish the same topics.

## Layout

```text
server.js              wiring and startup
src/store.js           devices, sessions, state rules, persistence
src/app.js             HTTP API, live events, static files
src/connect-feed.js    joins an adapter to the store
src/seed.js            first-run demo data (simulator only, generic labels)
src/adapters/          adapter contract, simulator and MQTT
public/                the staff page
test/                  node:test suites
tools/                 fake watch and the end-to-end broker check
```
