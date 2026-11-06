// Stands in for the gateway: generates BLE-style sightings with packet loss,
// signal drift and wristbands wandering out of range. See ./index.js for the
// adapter contract. It only produces presence data; sessions belong to the store.
import { EventEmitter } from 'node:events';

const TICK_MS = 500;
const BEACON_MS = 2000;
const PACKET_LOSS = 0.05;
const DROPOUT_CHANCE = 0.002;
const DROPOUT_MIN_MS = 20_000;
const DROPOUT_MAX_MS = 50_000;
const RSSI_MIN = -90;
const RSSI_MAX = -40;

export class SimulatorAdapter extends EventEmitter {
  #timer = null;
  #beacons = new Map();

  constructor({
    getDeviceIds,
    unregisteredIds = ['PlayPark_Tag_07', 'PlayPark_Tag_08'], // in range, not yet registered
    silentIds = ['PlayPark_Tag_06'], // never heard, e.g. flat or in a drawer
    rng = Math.random,
    now = Date.now,
  }) {
    super();
    this.getDeviceIds = getDeviceIds;
    this.unregisteredIds = unregisteredIds;
    this.silentIds = new Set(silentIds);
    this.rng = rng;
    this.now = now;
  }

  info() {
    return {
      id: 'simulator',
      name: 'Simulator',
      simulated: true,
      connected: true,
      canCommandDevices: false,
      detail: 'Generated traffic. No gateway or wristband is connected.',
    };
  }

  start() {
    this.#timer = setInterval(() => this.tick(), TICK_MS);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
  }

  // Simulated wristbands cannot receive anything.
  publishSession() {}

  tick() {
    const now = this.now();
    const ids = new Set([...this.getDeviceIds(), ...this.unregisteredIds]);
    for (const id of ids) {
      if (!this.silentIds.has(id)) this.#beacon(id, now);
    }
  }

  #beacon(id, now) {
    let beacon = this.#beacons.get(id);
    if (!beacon) {
      beacon = { rssi: -55 - this.rng() * 20, nextAt: now + this.rng() * BEACON_MS, outUntil: 0 };
      this.#beacons.set(id, beacon);
    }
    if (now < beacon.outUntil || now < beacon.nextAt) return;

    beacon.nextAt = now + BEACON_MS * (0.8 + this.rng() * 0.4);
    if (this.rng() < DROPOUT_CHANCE) {
      beacon.outUntil = now + DROPOUT_MIN_MS + this.rng() * (DROPOUT_MAX_MS - DROPOUT_MIN_MS);
      return;
    }
    if (this.rng() < PACKET_LOSS) return;

    const drift = (this.rng() - 0.5) * 6;
    beacon.rssi = Math.min(RSSI_MAX, Math.max(RSSI_MIN, beacon.rssi + drift));
    // A made-up spread of levels, so the dashboard shows some low ones.
    const battery = { percent: (Number(id.slice(-1)) * 13) % 100, charging: false };
    this.emit('sighting', { deviceId: id, at: now, rssi: Math.round(beacon.rssi), battery });
  }
}
