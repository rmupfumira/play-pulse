// Owns wristbands, sessions, children, parents and usage history, and persists them
// to a JSON file. Names and contact details stay here: they are never sent to watches.
//
// The server is the authority on session time: a session is stored as absolute
// wall-clock timestamps and its state is derived on read. Nothing here assumes
// the watch can be commanded or that it reports its own countdown.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const FILE_VERSION = 2;
const READABLE_VERSIONS = [1, 2];
const LAST_SEEN_FLUSH_MS = 5000;
const NEARBY_TTL_MS = 60_000;
const NEARBY_MAX = 200;
const MAX_WARNING_MS = 5 * 60_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const LABEL_MAX = 40;
const NAME_MAX = 60;
const EMAIL_MAX = 120;
const PHONE_PATTERN = /^\+?[0-9 ()-]{5,24}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USAGE_SHOWN = 200;
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

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > NAME_MAX) {
    throw new StoreError(400, 'invalid_name', `Enter a name of up to ${NAME_MAX} characters.`);
  }
  return name;
}

function cleanPhone(value) {
  const phone = typeof value === 'string' ? value.trim() : '';
  if (phone && !PHONE_PATTERN.test(phone)) {
    throw new StoreError(400, 'invalid_phone', 'Enter a phone number using digits only.');
  }
  return phone;
}

function cleanEmail(value) {
  const email = typeof value === 'string' ? value.trim() : '';
  if (email && (email.length > EMAIL_MAX || !EMAIL_PATTERN.test(email))) {
    throw new StoreError(400, 'invalid_email', 'Enter a valid email address.');
  }
  return email;
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
  #children = new Map();
  #parents = new Map();
  #usage = [];
  #revision = 0; // Moves on each saved change, so the page knows to reload people.
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
    if (!READABLE_VERSIONS.includes(data.version) || !Array.isArray(data.devices)) {
      throw new Error(`${this.file} is not a PlayPulse data file this version can read.`);
    }
    for (const child of data.children ?? []) this.#children.set(child.id, child);
    for (const parent of data.parents ?? []) this.#parents.set(parent.id, parent);
    this.#usage = data.usage ?? [];
    for (const device of data.devices) {
      // Files saved before sessions had IDs.
      if (device.session) {
        device.session.id ??= newSessionId();
        device.session.extensionRequest ??= null;
        device.session.childId ??= null;
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
    const body = JSON.stringify({
      version: FILE_VERSION,
      devices: [...this.#devices.values()],
      children: [...this.#children.values()],
      parents: [...this.#parents.values()],
      usage: this.#usage,
    }, null, 2);
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, body);
    renameSync(temp, this.file);
    this.#dirty = false;
  }

  #commit() {
    this.#revision += 1;
    this.#dirty = true;
    this.#save();
    this.emit('change');
  }

  // Something changed what the watch should be showing.
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

  #child(id) {
    const child = this.#children.get(id);
    if (!child) throw new StoreError(404, 'unknown_child', 'That child is not on the system.');
    return child;
  }

  #parent(id) {
    const parent = this.#parents.get(id);
    if (!parent) throw new StoreError(404, 'unknown_parent', 'That parent is not on the system.');
    return parent;
  }

  #deviceWithChild(childId) {
    return [...this.#devices.values()].find((device) => device.session?.childId === childId);
  }

  // A child wears one tag at a time, so a second tag points to a mistake.
  #requireFree(childId, exceptDeviceId) {
    const device = this.#deviceWithChild(childId);
    if (device && device.id !== exceptDeviceId) {
      throw new StoreError(409, 'child_busy', `${this.#child(childId).name} is already on ${device.id}.`);
    }
  }

  // Usage belongs to the child, so it follows them whichever tag they wear.
  #recordUsage(device) {
    const { session } = device;
    if (!session?.childId) return;
    this.#usage.push({
      id: newSessionId(),
      childId: session.childId,
      deviceId: device.id,
      startedAt: session.startedAt,
      endedAt: this.now(),
      allocatedMs: session.durationMs,
    });
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
    this.#recordUsage(device);
    this.#devices.delete(id);
    this.#commit();
    this.emit('session', { deviceId: id, session: null });
  }

  startSession(id, { durationSeconds, label, childId = null } = {}) {
    const device = this.#device(id);
    if (device.session) throw new StoreError(409, 'session_open', `${id} already has a session.`);
    const duration = durationMs(durationSeconds);
    if (childId !== null) {
      this.#child(childId);
      this.#requireFree(childId);
    }
    const startedAt = this.now();
    if (label !== undefined) device.label = cleanLabel(label);
    device.session = {
      id: newSessionId(),
      childId,
      startedAt,
      endsAt: startedAt + duration,
      durationMs: duration,
      warningMs: warningFor(duration),
      extensionRequest: null,
      lastRequestId: null,
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
    device.session.extensionRequest = null;
    this.#sessionChanged(device);
    return device;
  }

  endSession(id) {
    const device = this.#openSession(id);
    this.#recordUsage(device);
    device.session = null;
    this.#sessionChanged(device);
    return device;
  }

  // Corrects who is wearing a tag during a session. The watch is not told, because
  // nothing it shows depends on the child.
  assignChild(id, { childId = null } = {}) {
    const device = this.#openSession(id);
    if (childId !== null) {
      this.#child(childId);
      this.#requireFree(childId, id);
    }
    device.session.childId = childId;
    this.#commit();
    return device;
  }

  addParent({ name, phone, email } = {}) {
    const parent = {
      id: newSessionId(),
      name: cleanName(name),
      phone: cleanPhone(phone),
      email: cleanEmail(email),
      createdAt: this.now(),
    };
    this.#parents.set(parent.id, parent);
    this.#commit();
    return parent;
  }

  updateParent(id, { name, phone, email } = {}) {
    const parent = this.#parent(id);
    Object.assign(parent, { name: cleanName(name), phone: cleanPhone(phone), email: cleanEmail(email) });
    this.#commit();
    return parent;
  }

  removeParent(id) {
    this.#parent(id);
    this.#parents.delete(id);
    for (const child of this.#children.values()) {
      child.parentIds = child.parentIds.filter((parentId) => parentId !== id);
    }
    this.#commit();
  }

  #parentIds(value = []) {
    if (!Array.isArray(value)) throw new StoreError(400, 'invalid_parents', 'Parents must be a list.');
    for (const id of value) this.#parent(id);
    return [...new Set(value)];
  }

  addChild({ name, parentIds } = {}) {
    const child = {
      id: newSessionId(),
      name: cleanName(name),
      parentIds: this.#parentIds(parentIds),
      createdAt: this.now(),
    };
    this.#children.set(child.id, child);
    this.#commit();
    return child;
  }

  updateChild(id, { name, parentIds } = {}) {
    const child = this.#child(id);
    Object.assign(child, { name: cleanName(name), parentIds: this.#parentIds(parentIds) });
    this.#commit();
    return child;
  }

  // Removes the whole record, so a family can ask for their data to be deleted.
  removeChild(id) {
    const child = this.#child(id);
    this.#requireFree(id);
    this.#children.delete(child.id);
    this.#usage = this.#usage.filter((row) => row.childId !== id);
    this.#commit();
  }

  usageCount() {
    return this.#usage.length;
  }

  people() {
    const totals = new Map();
    for (const row of this.#usage) {
      const total = totals.get(row.childId) ?? { visits: 0, totalMs: 0, lastVisitAt: null };
      total.visits += 1;
      total.totalMs += row.endedAt - row.startedAt;
      total.lastVisitAt = Math.max(total.lastVisitAt ?? 0, row.startedAt);
      totals.set(row.childId, total);
    }
    const byName = (a, b) => a.name.localeCompare(b.name);
    const children = [...this.#children.values()].sort(byName).map((child) => ({
      ...child,
      ...(totals.get(child.id) ?? { visits: 0, totalMs: 0, lastVisitAt: null }),
      activeDeviceId: this.#deviceWithChild(child.id)?.id ?? null,
    }));
    const parents = [...this.#parents.values()].sort(byName).map((parent) => ({
      ...parent,
      childIds: children.filter((child) => child.parentIds.includes(parent.id)).map((child) => child.id),
    }));
    return { parents, children };
  }

  childDetail(id) {
    const child = this.people().children.find((item) => item.id === id);
    if (!child) this.#child(id);
    return {
      ...child,
      parents: child.parentIds.map((parentId) => this.#parents.get(parentId)),
      usage: this.#usage
        .filter((row) => row.childId === id)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, USAGE_SHOWN),
    };
  }

  // Demo seeding only: shows an expired wristband on first run.
  backdateSession(id, byMs) {
    const device = this.#openSession(id);
    device.session.startedAt -= byMs;
    device.session.endsAt -= byMs;
    this.#commit();
  }

  // The watch screen was held, asking for more time. Anyone can do that, so it only
  // raises a request for staff. A repeated requestId is a redelivered copy.
  requestExtension(id, sessionId, requestId = null) {
    const device = this.#devices.get(id);
    const session = device?.session;
    if (!session || session.id !== sessionId) return false;
    if (session.extensionRequest || (requestId !== null && requestId === session.lastRequestId)) return false;
    session.extensionRequest = { requestedAt: this.now() };
    session.lastRequestId = requestId;
    this.#sessionChanged(device);
    return true;
  }

  #requested(id) {
    const device = this.#openSession(id);
    if (!device.session.extensionRequest) {
      throw new StoreError(409, 'no_request', `${id} has no request waiting.`);
    }
    return device;
  }

  approveExtension(id, body) {
    this.#requested(id);
    return this.extendSession(id, body);
  }

  declineExtension(id) {
    const device = this.#requested(id);
    device.session.extensionRequest = null;
    this.#sessionChanged(device);
    return device;
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

  #childSummary(childId) {
    const child = this.#children.get(childId);
    return child ? { id: child.id, name: child.name } : null;
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
          child: this.#childSummary(device.session?.childId),
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
    return {
      serverTime: now,
      offlineAfterMs: this.offlineAfterMs,
      revision: this.#revision,
      devices,
      nearby: [...this.#nearby.values()],
    };
  }
}
