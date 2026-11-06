// A stand-in wristband that follows docs/mqtt-contract.md over a real broker.
//
//   node --env-file=../broker/.env tools/fake-watch.js PlayPark_Tag_99
//
// verify-mqtt.js also uses it, with options to misbehave on purpose.
import { pathToFileURL } from 'node:url';
import mqtt from 'mqtt';

export class FakeWatch {
  serverOffsetMs = null;
  session = undefined; // undefined until the first retained message arrives
  #client = null;
  #timer = null;

  constructor({
    id, url, username, password, firmware = '0.0.0-fake', telemetryMs = 5000, rssi = -58,
    countdownSkewMs = 0, pretendSessionId,
  }) {
    Object.assign(this, { id, url, username, password, firmware, telemetryMs, rssi });
    this.countdownSkewMs = countdownSkewMs;
    this.pretendSessionId = pretendSessionId;
    this.base = `playpulse/v1/devices/${id}`;
  }

  start() {
    this.#client = mqtt.connect(this.url, {
      username: this.username,
      password: this.password,
      clientId: `fake-watch-${this.id}`,
      keepalive: 5,
      will: { topic: `${this.base}/status`, payload: '{"online":false}', qos: 1, retain: true },
    });
    this.#client.on('error', (err) => console.error(`${this.id}: ${err.message}`));
    this.#client.on('connect', () => {
      this.#client.publish(
        `${this.base}/status`,
        JSON.stringify({ online: true, firmware: this.firmware }),
        { qos: 1, retain: true },
      );
      this.#client.subscribe({ 'playpulse/v1/time': { qos: 0 }, [`${this.base}/session`]: { qos: 1 } });
    });
    this.#client.on('message', (topic, payload) => this.#onMessage(topic, payload));
    this.#timer = setInterval(() => this.#publishTelemetry(), this.telemetryMs);
  }

  #onMessage(topic, payload) {
    if (payload.length === 0) return;
    const body = JSON.parse(payload.toString('utf8'));
    if (topic === 'playpulse/v1/time') this.serverOffsetMs = body.now - Date.now();
    else this.session = body;
  }

  now() {
    return Date.now() + (this.serverOffsetMs ?? 0);
  }

  // Implements the state rules in the contract.
  display() {
    const session = this.session;
    if (!session?.sessionId) return { state: 'idle', remainingMs: 0, sessionId: null };
    const remaining = session.endsAt - this.now();
    const sessionId = this.pretendSessionId ?? session.sessionId;
    if (remaining <= 0) return { state: 'red', remainingMs: 0, sessionId };
    const state = remaining <= session.warningMs ? 'yellow' : 'green';
    return { state, remainingMs: Math.max(0, remaining + this.countdownSkewMs), sessionId };
  }

  #publishTelemetry() {
    if (!this.#client?.connected) return;
    const body = { ...this.display(), rssi: this.rssi, uptimeMs: Math.round(performance.now()) };
    this.#client.publish(`${this.base}/telemetry`, JSON.stringify(body), { qos: 0 });
  }

  // The 3 second screen hold. Pass an ID to send a stale event.
  holdScreen(sessionId = this.session?.sessionId) {
    const body = JSON.stringify({ type: 'extension_requested', sessionId, requestId: String(performance.now()) });
    this.#client.publish(`${this.base}/event`, body, { qos: 1 });
  }

  // Drops the connection without saying goodbye, so the broker sends the Last Will.
  crash() {
    clearInterval(this.#timer);
    this.#client.options.reconnectPeriod = 0;
    this.#client.stream.destroy();
  }

  stop() {
    clearInterval(this.#timer);
    return this.#client.endAsync();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const id = process.argv[2] ?? 'PlayPark_Tag_99';
  const watch = new FakeWatch({
    id,
    url: process.env.MQTT_URL,
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
  });
  watch.start();
  console.log(`${id} running. Ctrl+C to stop, which triggers the Last Will.`);
  setInterval(() => console.log(JSON.stringify(watch.display())), 5000);
}
