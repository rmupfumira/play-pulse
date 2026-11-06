// Owns wristbands and their sessions, and persists them to a JSON file.
//
// The server is the authority on session time: a session is stored as absolute
// wall-clock timestamps and its state is derived on read. Nothing here assumes
// the watch can be commanded or that it reports its own countdown.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const FILE_VERSION = 1;
const LAST_SEEN_FLUSH_MS = 5000;
const NEARBY_TTL_MS = 60_000;
const NEARBY_MAX = 200;
const MAX_WARNING_MS = 5 * 60_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const LABEL_MAX = 40;
// A report received this soon after a session change may predate the change.
const REPORT_SETTLE_MS = 2000;
// How far a watch's countdown may differ from the server's before it is flagged.
const REPORT_TOLERANCE_MS = 3000;

export const MIN_DURATION_S = 10;
export const MAX_DURATION_S = 12 * 60 * 60;
export const OFFLINE_AFTER_MS = 15_000;

export class StoreError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// A third of the session, capped at five minutes. This reproduces the firmware's
// bench values (30 s session, 10 s warning) and stays sensible for paid sessions.
export function warningFor(durationMs) {
  return Math.min(MAX_WARNING_MS, Math.round(durationMs / 3));
}

// Same boundaries as stateForElapsed() in wristband/wristband.ino.
export function sessionState(session, now) {
  if (!session) return 'idle';
  const remaining = session.endsAt - now;
  if (remaining <= 0) return 'red';
  return remaining <= session.warningMs ? 'yellow' : 'green';
}

// Compares what a watch reported with the session the server holds, as of the
// moment the report arrived. Returns ok, pending, session, time or state.
export function compareReport(report, session, sessionChangedAt) {
  if (report.at - sessionChangedAt < REPORT_SETTLE_MS) return 'pending';
  if (report.sessionId !== (session?.id ?? null)) return 'session';
  if (!session) return report.state === 'idle' ? 'ok' : 'state';
  const expected = Math.max(0, session.endsAt - report.at);
  if (Math.abs(expected - report.remainingMs) > REPORT_TOLERANCE_MS) return 'time';
  const plausible = [-REPORT_TOLERANCE_MS, 0, REPORT_TOLERANCE_MS].map((offset) =>
    sessionState(session, report.at + offset));
  return plausible.includes(report.state) ? 'ok' : 'state';
}

function newSessionId() {
  return randomBytes(6).toString('hex');
}

function cleanLabel(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new StoreError(400, 'invalid_label', 'Label must be text.');
  const label = value.trim();
  if (label.length > LABEL_MAX) {
    throw new StoreError(400, 'invalid_label', `Label must be ${LABEL_MAX} characters or fewer.`);
  }
  return label;
}

function durationMs(seconds) {
  if (!Number.isInteger(seconds) || seconds < MIN_DURATION_S || seconds > MAX_DURATION_S) {
    throw new StoreError(
      400,
      'invalid_duration',
      `Duration must be between ${MIN_DURATION_S} seconds and ${MAX_DURATION_S / 3600} hours.`,
    );
  }
  return seconds * 1000;
}

export class Store extends EventEmitter {
  #devices = new Map();
  #nearby = new Map();
  #presence = new Map(); // status heard from wristbands not registered yet
  #dirty = false;
  #flushTimer = null;

  constructor({ file, now = Date.now, offlineAfterMs = OFFLINE_AFTER_MS }) {
    super();
    this.file = file;
    this.now = now;
    this.offlineAfterMs = offlineAfterMs;
  }

  // Returns true when no data file existed. A file that cannot be read stops the
  // server rather than being overwritten, so staff data is never silently lost.
  load() {
    if (!existsSync(this.file)) return true;
    let data;
    try {
      data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      throw new Error(`Cannot read ${this.file}: ${err.message}. Fix or move the file, then restart.`);
    }
    if (data.version !== FILE_VERSION || !Array.isArray(data.devices)) {
      throw new Error(`${this.file} is not a version ${FILE_VERSION} PlayPulse data file.`);
    }
    for (const device of data.devices) {
      // Files saved before sessions had IDs.
      if (device.session) {
        device.session.id ??= newSessionId();
        device.session.originalDurationMs ??= device.session.durationMs;
        device.session.restarts ??= 0;
      }
      device.sessionChangedAt ??= 0;
      device.report ??= null;
      this.#devices.set(device.id, device);
    }
    return false;
  }

  startFlushing() {
    this.#flushTimer = setInterval(() => this.flush(), LAST_SEEN_FLUSH_MS);
    this.#flushTimer.unref();
  }

  // Last-seen updates arrive constantly, so they are written on a timer. Staff
  // actions call #commit(), which writes before the request is answered.
  flush() {
    if (!this.#dirty) return;
    try {
      this.#save();
    } catch (err) {
      console.error(`Could not save ${this.file}: ${err.message}`);
    }
  }

  close() {
    clearInterval(this.#flushTimer);
    this.flush();
  }

  #save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const body = JSON.stringify({ version: FILE_VERSION, devices: [...this.#devices.values()] }, null, 2);
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, body);
    renameSync(temp, this.file);
    this.#dirty = false;
  }

  #commit() {
    this.#dirty = true;
    this.#save();
    this.emit('change');
  }

  // A staff action or watch restart changed what the watch should be showing.
  #sessionChanged(device) {
    device.sessionChangedAt = this.now();
    this.#commit();
    this.emit('session', { deviceId: device.id, session: device.session });
  }

  // Current session per device, for an adapter republishing after it connects.
  sessions() {
    return [...this.#devices.values()].map((device) => ({ deviceId: device.id, session: device.session }));
  }

  #device(id) {
    const device = this.#devices.get(id);
    if (!device) throw new StoreError(404, 'unknown_device', `No wristband ${id} is registered.`);
    return device;
  }

  #openSession(id) {
    const device = this.#device(id);
    if (!device.session) throw new StoreError(409, 'no_session', `${id} has no session.`);
    return device;
  }

  register({ id, label } = {}) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new StoreError(400, 'invalid_id', 'ID must be 1-32 letters, digits, "_" or "-".');
    }
    if (this.#devices.has(id)) {
      throw new StoreError(409, 'already_registered', `${id} is already registered.`);
    }
    const seen = this.#nearby.get(id);
    const presence = this.#presence.get(id);
    const device = {
      id,
      label: cleanLabel(label),
      registeredAt: this.now(),
      lastSeenAt: seen?.lastSeenAt ?? null,
      rssi: seen?.rssi ?? null,
      session: null,
      sessionChangedAt: this.now(),
      firmware: presence?.firmware ?? null,
      reportedOffline: presence ? !presence.online : false,
      report: null,
    };
    this.#devices.set(id, device);
    this.#nearby.delete(id);
    this.#presence.delete(id);
    this.#sessionChanged(device);
    return device;
  }

  rename(id, { label } = {}) {
    const device = this.#device(id);
    device.label = cleanLabel(label);
    this.#commit();
    return device;
  }

  remove(id, { force = false } = {}) {
    const device = this.#device(id);
    if (device.session && !force) {
      throw new StoreError(409, 'session_open', `${id} has a session. End it before removing.`);
    }
    this.#devices.delete(id);
    this.#commit();
    this.emit('session', { deviceId: id, session: null });
  }

  startSession(id, { durationSeconds, label } = {}) {
    const device = this.#device(id);
    if (device.session) throw new StoreError(409, 'session_open', `${id} already has a session.`);
    const duration = durationMs(durationSeconds);
    const startedAt = this.now();
    if (label !== undefined) device.label = cleanLabel(label);
    device.session = {
      id: newSessionId(),
      startedAt,
      endsAt: startedAt + duration,
      durationMs: duration,
      originalDurationMs: duration,
      warningMs: warningFor(duration),
      restarts: 0,
      lastRestartAt: null,
    };
    this.#sessionChanged(device);
    return device;
  }

  // An expired session is extended from now, so the visitor receives all the time
  // staff grant rather than losing the part already overrun.
  extendSession(id, { durationSeconds } = {}) {
    const device = this.#openSession(id);
    const extra = durationMs(durationSeconds);
    device.session.endsAt = Math.max(device.session.endsAt, this.now()) + extra;
    device.session.durationMs += extra;
    this.#sessionChanged(device);
    return device;
  }

  endSession(id) {
    const device = this.#openSession(id);
    device.session = null;
    this.#sessionChanged(device);
    return device;
  }

  // Demo seeding only: shows an expired wristband on first run.
  backdateSession(id, byMs) {
    const device = this.#openSession(id);
    device.session.startedAt -= byMs;
    device.session.endsAt -= byMs;
    this.#commit();
  }

  // Staff held the watch screen. Only the current session can be restarted: the
  // new ID makes a redelivered copy of the same event stale, so it cannot restart
  // the session twice. Extensions are dropped, as the original duration applies.
  restartFromWatch(id, sessionId) {
    const device = this.#devices.get(id);
    if (!device?.session || device.session.id !== sessionId) return false;
    const session = device.session;
    const now = this.now();
    device.session = {
      ...session,
      id: newSessionId(),
      startedAt: now,
      endsAt: now + session.originalDurationMs,
      durationMs: session.originalDurationMs,
      restarts: session.restarts + 1,
      lastRestartAt: now,
    };
    this.#sessionChanged(device);
    return true;
  }

  // Input from the feed adapter. Timestamps only move forward, because a broker
  // can redeliver old messages and that must not make a wristband look older.
  // `rssi` and `report` are optional; a sighting without them keeps the last values.
  recordSighting({ deviceId, at, rssi, report } = {}) {
    if (typeof deviceId !== 'string' || !ID_PATTERN.test(deviceId)) return;
    const now = this.now();
    const seenAt = Number.isFinite(at) ? Math.min(at, now) : now;
    const target = this.#devices.get(deviceId);
    if (target) {
      if (seenAt >= (target.lastSeenAt ?? 0)) {
        target.lastSeenAt = seenAt;
        target.rssi = rssi ?? target.rssi;
        target.reportedOffline = false;
        if (report) target.report = { ...report, at: seenAt };
        this.#dirty = true;
      }
      return;
    }
    if (this.#nearby.size >= NEARBY_MAX && !this.#nearby.has(deviceId)) return;
    this.#nearby.set(deviceId, { id: deviceId, lastSeenAt: seenAt, rssi: rssi ?? null });
  }

  // Connection status from the feed. `live` is false for a retained message,
  // which says what was last true, not that the wristband was just heard.
  recordPresence({ deviceId, online, firmware, live }) {
    const device = this.#devices.get(deviceId);
    if (device) {
      device.reportedOffline = !online;
      device.firmware = firmware ?? device.firmware;
      this.#dirty = true;
    } else if (this.#presence.size < NEARBY_MAX || this.#presence.has(deviceId)) {
      // A retained status is only delivered once, so keep it for registration.
      this.#presence.set(deviceId, { online, firmware });
    }
    if (online && live) this.recordSighting({ deviceId });
  }

  snapshot() {
    const now = this.now();
    for (const [id, entry] of this.#nearby) {
      if (now - entry.lastSeenAt > NEARBY_TTL_MS) this.#nearby.delete(id);
    }
    const devices = [...this.#devices.values()]
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .map((device) => {
        const recent = device.lastSeenAt !== null && now - device.lastSeenAt <= this.offlineAfterMs;
        return {
          ...device,
          state: sessionState(device.session, now),
          // Negative once expired: the amount of overrun.
          remainingMs: device.session ? device.session.endsAt - now : null,
          online: recent && !device.reportedOffline,
          report: device.report && {
            ...device.report,
            verdict: now - device.report.at > this.offlineAfterMs
              ? 'stale'
              : compareReport(device.report, device.session, device.sessionChangedAt),
          },
        };
      });
    return { serverTime: now, offlineAfterMs: this.offlineAfterMs, devices, nearby: [...this.#nearby.values()] };
  }
}
