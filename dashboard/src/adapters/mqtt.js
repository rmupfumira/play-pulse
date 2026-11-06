// Live feed over MQTT, implementing docs/mqtt-contract.md. See ./index.js for the
// adapter contract. The store stays the authority on sessions: telemetry is kept
// as a report to compare against and never changes a session.
import { EventEmitter } from 'node:events';
import mqtt from 'mqtt';

const TIME_TOPIC = 'playpulse/v1/time';
const TIME_INTERVAL_MS = 10_000;
const RECONNECT_MS = 2000;
const DEVICE_TOPIC = /^playpulse\/v1\/devices\/([^/]+)\/(status|telemetry|event|session)$/;
const WATCH_STATES = new Set(['idle', 'green', 'yellow', 'red']);

const SUBSCRIPTIONS = {
  'playpulse/v1/devices/+/status': { qos: 1 },
  'playpulse/v1/devices/+/telemetry': { qos: 0 },
  'playpulse/v1/devices/+/event': { qos: 1 },
  'playpulse/v1/devices/+/session': { qos: 1 },
};

const sessionTopic = (deviceId) => `playpulse/v1/devices/${deviceId}/session`;

function sessionPayload(session) {
  if (!session) return { sessionId: null };
  return { sessionId: session.id, endsAt: session.endsAt, warningMs: session.warningMs, durationMs: session.durationMs };
}

function validTelemetry(body) {
  return WATCH_STATES.has(body.state)
    && Number.isFinite(body.remainingMs)
    && (typeof body.sessionId === 'string' || body.sessionId === null);
}

export class MqttAdapter extends EventEmitter {
  #client = null;
  #timer = null;
  #connected = false;
  #problem = 'Connecting to the broker.';

  constructor({ getSessions, url, username, password, connect = mqtt.connect, now = Date.now, log = console }) {
    super();
    if (!url || !username || !password) {
      throw new Error('ADAPTER=mqtt needs MQTT_URL, MQTT_USERNAME and MQTT_PASSWORD. See broker/README.md.');
    }
    Object.assign(this, { getSessions, url, username, password, connect, now, log });
  }

  info() {
    return {
      id: 'mqtt',
      name: 'MQTT',
      simulated: false,
      connected: this.#connected,
      canCommandDevices: true,
      detail: this.#connected ? `Connected to ${this.url}.` : this.#problem,
    };
  }

  start() {
    this.#client = this.connect(this.url, {
      username: this.username,
      password: this.password,
      clientId: `playpulse-dashboard-${process.pid}`,
      reconnectPeriod: RECONNECT_MS,
      connectTimeout: 5000,
    });
    this.#client.on('connect', () => this.#onConnect());
    this.#client.on('close', () => this.#onDisconnect());
    this.#client.on('error', (err) => this.#onError(err));
    this.#client.on('message', (topic, payload, packet) => this.#onMessage(topic, payload, packet));
    this.#timer = setInterval(() => this.#publishTime(), TIME_INTERVAL_MS);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
    this.#client?.end();
  }

  // Skipped while disconnected: the broker gets the current state on reconnect,
  // and queuing would replay outdated sessions after it.
  publishSession(deviceId, session) {
    if (!this.#connected) return;
    const body = JSON.stringify(sessionPayload(session));
    this.#client.publish(sessionTopic(deviceId), body, { qos: 1, retain: true });
  }

  #publishTime() {
    if (!this.#connected) return;
    this.#client.publish(TIME_TOPIC, JSON.stringify({ now: this.now() }), { qos: 0, retain: true });
  }

  #onConnect() {
    this.#connected = true;
    this.#client.subscribe(SUBSCRIPTIONS);
    this.#publishTime();
    for (const { deviceId, session } of this.getSessions()) this.publishSession(deviceId, session);
    this.emit('status');
  }

  #onDisconnect() {
    if (!this.#connected) return;
    this.#connected = false;
    this.#problem = 'Lost connection to the broker. Reconnecting.';
    this.log.error(this.#problem);
    this.emit('status');
  }

  #onError(err) {
    const problem = `Broker: ${err.message}`;
    if (problem === this.#problem) return;
    this.#problem = problem;
    this.log.error(problem);
    this.emit('status');
  }

  #onMessage(topic, payload, packet) {
    const match = DEVICE_TOPIC.exec(topic);
    if (!match) return;
    const [, deviceId, kind] = match;
    let body;
    try {
      body = JSON.parse(payload.toString('utf8'));
    } catch {
      body = null;
    }
    if (typeof body !== 'object' || body === null) {
      if (payload.length > 0) this.log.warn(`Ignoring malformed message on ${topic}`);
      return;
    }
    const live = !packet.retain;
    if (kind === 'status') this.#onStatus(deviceId, body, live);
    if (kind === 'session') this.#onRetainedSession(deviceId, body, live);
    // Both are live-only topics, so a retained copy is a publisher's mistake.
    if (kind === 'telemetry' && live) this.#onTelemetry(deviceId, body, topic);
    if (kind === 'event' && live) this.#onEvent(deviceId, body);
  }

  #onStatus(deviceId, body, live) {
    if (typeof body.online !== 'boolean') return;
    this.emit('presence', { deviceId, online: body.online, firmware: body.firmware, live });
  }

  #onTelemetry(deviceId, body, topic) {
    if (!validTelemetry(body)) {
      this.log.warn(`Ignoring invalid telemetry on ${topic}`);
      return;
    }
    const { state, remainingMs, sessionId, rssi } = body;
    this.emit('sighting', {
      deviceId,
      at: this.now(),
      rssi: Number.isFinite(rssi) ? rssi : undefined,
      report: { state, remainingMs, sessionId },
    });
  }

  #onEvent(deviceId, body) {
    this.emit('sighting', { deviceId, at: this.now() });
    if (body.type === 'restart_requested') {
      this.emit('restartRequested', { deviceId, sessionId: body.sessionId });
    }
  }

  // The dashboard's own topic, read only to clear a session left on the broker for
  // a wristband that is no longer registered, for example one removed while
  // disconnected. A registered device was already republished on connect.
  #onRetainedSession(deviceId, body, live) {
    if (live || !body.sessionId) return;
    if (this.getSessions().some((entry) => entry.deviceId === deviceId)) return;
    this.log.warn(`Clearing leftover session for unregistered wristband ${deviceId}`);
    this.publishSession(deviceId, null);
  }
}
