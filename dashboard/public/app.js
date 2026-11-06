// Renders the server's state and sends staff actions back. The server is the
// authority on time, so this page does no countdown arithmetic of its own: each
// update carries the current remaining time.
const STALE_AFTER_MS = 4000;
const TOAST_MS = 4000;
const STATE_TEXT = { idle: 'No session', green: 'Active', yellow: 'Ending soon', red: 'Expired' };
const START_PRESETS = [
  { seconds: 30, text: '30 sec (bench)' },
  { seconds: 900, text: '15 min' },
  { seconds: 1800, text: '30 min', preselected: true },
  { seconds: 3600, text: '60 min' },
  { seconds: 5400, text: '90 min' },
];
const EXTEND_PRESETS = [
  { seconds: 30, text: '+30 sec (bench)' },
  { seconds: 300, text: '+5 min' },
  { seconds: 900, text: '+15 min', preselected: true },
  { seconds: 1800, text: '+30 min' },
];

const el = (id) => document.getElementById(id);
const field = (root, name) => root.querySelector(`[data-f="${name}"]`);

let snap = null;
let lastUpdateAt = 0;
let toastTimer = null;
const knownRestarts = new Map();

function displayName(device) {
  return device.label || 'Unassigned';
}

function device(id) {
  return snap?.devices.find((candidate) => candidate.id === id);
}

function clock(ms) {
  const total = Math.ceil(Math.abs(ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

function timeText(item) {
  if (item.state === 'idle') return '-';
  return item.state === 'red' ? `Over by ${clock(item.remainingMs)}` : clock(item.remainingMs);
}

function agoText(at) {
  if (at === null) return 'Never';
  const seconds = Math.max(0, Math.round((snap.serverTime - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
}

function timeOfDay(at) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function restartText(item) {
  const restarts = item.session?.restarts;
  if (!restarts) return '';
  const times = restarts > 1 ? ` (${restarts} times)` : '';
  return `Restarted on the watch at ${timeOfDay(item.session.lastRestartAt)}${times}`;
}

// What the watch says it is showing, and whether that agrees with the server.
function watchNote(item) {
  const report = item.report;
  if (!report) return { text: 'No report from the watch yet' };
  const shown = report.state === 'idle'
    ? STATE_TEXT.idle
    : `${STATE_TEXT[report.state]} ${clock(report.remainingMs)}`;
  switch (report.verdict) {
    case 'ok': return { text: `Watch shows ${shown}` };
    case 'pending': return { text: 'Watch updating' };
    case 'stale': return { text: `Watch last showed ${shown}` };
    case 'session': return { text: 'Mismatch: watch is on a different session', alert: true };
    default: return { text: `Mismatch: watch shows ${shown}`, alert: true };
  }
}

const isMismatch = (item) => ['session', 'time', 'state'].includes(item.report?.verdict);

function setNote(element, note) {
  element.hidden = !note.text;
  element.textContent = note.text;
  element.dataset.alert = Boolean(note.alert);
}

// Keeps one element per key and updates it in place, so the once-a-second refresh
// does not lose keyboard focus or hover on the buttons inside.
function syncList(container, items, templateId, update) {
  const elements = (container.elements ??= new Map());
  const keep = new Set(items.map((item) => item.id));
  for (const [key, element] of elements) {
    if (!keep.has(key)) {
      element.remove();
      elements.delete(key);
    }
  }
  items.forEach((item, index) => {
    let element = elements.get(item.id);
    if (!element) {
      element = el(templateId).content.firstElementChild.cloneNode(true);
      element.dataset.device = item.id;
      elements.set(item.id, element);
    }
    update(element, item);
    if (container.children[index] !== element) container.insertBefore(element, container.children[index] ?? null);
  });
}

function updateRow(row, item) {
  const label = field(row, 'label');
  label.textContent = displayName(item);
  label.classList.toggle('unassigned', !item.label);
  field(row, 'id').textContent = item.id;
  const state = field(row, 'state');
  state.textContent = STATE_TEXT[item.state];
  state.dataset.state = item.state;
  field(row, 'time').textContent = timeText(item);
  const seen = field(row, 'seen');
  seen.textContent = item.rssi === null ? agoText(item.lastSeenAt) : `${agoText(item.lastSeenAt)} · ${item.rssi} dBm`;
  seen.title = item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : '';
  const link = field(row, 'link');
  link.textContent = item.online ? 'Online' : 'Offline';
  link.dataset.online = item.online;
  link.title = item.firmware ? `Firmware ${item.firmware}` : '';
  setNote(field(row, 'restart'), { text: restartText(item) });
  setNote(field(row, 'watch'), snap.adapter.canCommandDevices ? watchNote(item) : { text: '' });
  const hasSession = item.state !== 'idle';
  row.querySelector('[data-action="start"]').hidden = hasSession;
  row.querySelector('[data-action="extend"]').hidden = !hasSession;
  row.querySelector('[data-action="end"]').hidden = !hasSession;
}

function updateCard(card, item) {
  card.dataset.state = item.state;
  field(card, 'state').textContent = STATE_TEXT[item.state];
  field(card, 'offline').hidden = item.online;
  field(card, 'label').textContent = displayName(item);
  field(card, 'id').textContent = item.id;
  field(card, 'time').textContent = timeText(item);
  setNote(field(card, 'watch'), isMismatch(item) ? watchNote(item) : { text: '' });
  setNote(field(card, 'restart'), { text: restartText(item) });
}

function updateNearby(row, item) {
  field(row, 'id').textContent = item.id;
  field(row, 'seen').textContent = `Heard ${agoText(item.lastSeenAt)}`;
}

// The page must make a restart from the watch visible, because anyone can do it.
function announceRestarts(devices) {
  for (const item of devices) {
    const at = item.session?.lastRestartAt ?? null;
    const known = knownRestarts.get(item.id);
    if (known !== undefined && at !== null && at !== known) {
      toast(`${displayName(item)} (${item.id}) was restarted on the watch.`);
    }
    knownRestarts.set(item.id, at);
  }
}

function render() {
  const { adapter, devices, nearby } = snap;

  el('feed-banner').hidden = !adapter.simulated && adapter.connected && adapter.canCommandDevices;
  el('feed-title').textContent = adapter.simulated
    ? 'Simulated data'
    : `${adapter.name} ${adapter.connected ? 'connected' : 'disconnected'}`;
  const presence = adapter.simulated
    ? 'No real wristbands are connected, so online status and last seen are generated.'
    : adapter.detail;
  const commands = adapter.canCommandDevices ? '' : ' Session times are not sent to the watches.';
  el('feed-detail').textContent = presence + commands;

  const count = (state) => devices.filter((item) => item.state === state).length;
  const expired = count('red');
  const ending = count('yellow');
  el('count-green').textContent = count('green');
  el('count-yellow').textContent = ending;
  el('count-red').textContent = expired;
  el('count-offline').textContent = devices.filter((item) => !item.online).length;
  const mismatches = devices.filter(isMismatch).length;
  el('count-mismatch').textContent = mismatches;
  el('mismatch-count').hidden = mismatches === 0;
  announceRestarts(devices);
  document.title = expired + ending > 0 ? `(${expired + ending}) PlayPulse Wristbands` : 'PlayPulse Wristbands';

  // Most overrun first, then whichever runs out next.
  const urgent = devices
    .filter((item) => item.state === 'red' || item.state === 'yellow')
    .sort((a, b) => a.remainingMs - b.remainingMs);
  syncList(el('attention'), urgent, 'attention-card', updateCard);
  el('attention-empty').hidden = urgent.length > 0;

  syncList(el('devices'), devices, 'device-row', updateRow);
  el('devices-empty').hidden = devices.length > 0;
  el('devices-table').hidden = devices.length === 0;

  syncList(el('nearby'), nearby, 'nearby-item', updateNearby);
  el('nearby-section').hidden = nearby.length === 0;
}

function connect() {
  const stream = new EventSource('/api/events');
  stream.addEventListener('state', (event) => {
    snap = JSON.parse(event.data);
    lastUpdateAt = Date.now();
    render();
  });
}

function watchConnection() {
  const lost = Date.now() - lastUpdateAt > STALE_AFTER_MS;
  el('lost-banner').hidden = !lost;
  el('main').classList.toggle('stale', lost);
}

async function api(method, path, body = {}) {
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.ok) return response.json();
  const failure = await response.json().catch(() => null);
  throw new Error(failure?.error?.message ?? `Request failed (${response.status}).`);
}

const devicePath = (id) => `/api/devices/${encodeURIComponent(id)}`;

function toast(message) {
  const box = el('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, TOAST_MS);
}

// Opens a dialog whose submit runs `action`. It stays open and shows the error if
// the action fails, for example when another staff member got there first.
function openDialog(dialog, action) {
  const error = dialog.querySelector('.form-error');
  error.hidden = true;
  dialog.pendingAction = action;
  dialog.showModal();
}

async function submitDialog(event) {
  event.preventDefault();
  const form = event.target;
  const dialog = form.closest('dialog');
  const error = dialog.querySelector('.form-error');
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const message = await dialog.pendingAction(new FormData(form));
    dialog.close();
    toast(message);
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    submit.disabled = false;
  }
}

function openRegister(presetId = '') {
  const dialog = el('device-dialog');
  const form = dialog.querySelector('form');
  form.reset();
  field(dialog, 'title').textContent = 'Register wristband';
  field(dialog, 'submit').textContent = 'Register';
  form.elements.id.readOnly = false;
  form.elements.id.value = presetId;
  openDialog(dialog, async (data) => {
    const id = data.get('id').trim();
    await api('POST', '/api/devices', { id, label: data.get('label') });
    return `${id} registered.`;
  });
}

function openRename(item) {
  const dialog = el('device-dialog');
  const form = dialog.querySelector('form');
  form.reset();
  field(dialog, 'title').textContent = 'Rename wristband';
  field(dialog, 'submit').textContent = 'Save';
  form.elements.id.readOnly = true;
  form.elements.id.value = item.id;
  form.elements.label.value = item.label;
  openDialog(dialog, async (data) => {
    await api('PATCH', devicePath(item.id), { label: data.get('label') });
    return `${item.id} renamed.`;
  });
}

function setPresets(dialog, presets) {
  const box = field(dialog, 'presets');
  box.replaceChildren();
  for (const preset of [...presets, { seconds: 'custom', text: 'Custom' }]) {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'preset';
    radio.value = preset.seconds;
    radio.checked = Boolean(preset.preselected);
    label.append(radio, preset.text);
    box.append(label);
  }
  syncCustomField(dialog);
}

function syncCustomField(dialog) {
  const form = dialog.querySelector('form');
  const custom = form.elements.preset.value === 'custom';
  form.elements.minutes.disabled = !custom;
  form.elements.minutes.required = custom;
}

function chosenSeconds(data) {
  const preset = data.get('preset');
  return preset === 'custom' ? Math.round(Number(data.get('minutes')) * 60) : Number(preset);
}

function openSessionDialog(item, { title, submit, presets, showLabel, action }) {
  const dialog = el('session-dialog');
  const form = dialog.querySelector('form');
  form.reset();
  field(dialog, 'title').textContent = title;
  field(dialog, 'device').textContent = `${displayName(item)} · ${item.id}`;
  field(dialog, 'submit').textContent = submit;
  field(dialog, 'label-field').hidden = !showLabel;
  form.elements.label.value = item.label;
  setPresets(dialog, presets);
  openDialog(dialog, action);
}

function openStart(item) {
  openSessionDialog(item, {
    title: 'Start session',
    submit: 'Start session',
    presets: START_PRESETS,
    showLabel: true,
    action: async (data) => {
      const body = { durationSeconds: chosenSeconds(data), label: data.get('label') };
      await api('POST', `${devicePath(item.id)}/session`, body);
      return `Session started on ${item.id}.`;
    },
  });
}

function openExtend(item) {
  const note = item.state === 'red' ? 'Extend from now' : 'Extend session';
  openSessionDialog(item, {
    title: note,
    submit: 'Extend',
    presets: EXTEND_PRESETS,
    showLabel: false,
    action: async (data) => {
      await api('POST', `${devicePath(item.id)}/session/extend`, { durationSeconds: chosenSeconds(data) });
      return `Session extended on ${item.id}.`;
    },
  });
}

function openConfirm({ title, body, submit, action }) {
  const dialog = el('confirm-dialog');
  field(dialog, 'title').textContent = title;
  field(dialog, 'body').textContent = body;
  field(dialog, 'submit').textContent = submit;
  openDialog(dialog, action);
}

async function endSession(item) {
  await api('POST', `${devicePath(item.id)}/session/end`);
  return `Session ended on ${item.id}.`;
}

function askEnd(item) {
  // Ending an expired session is routine; ending one with time left loses that time.
  if (item.state === 'red') {
    endSession(item).then(toast, (err) => toast(err.message));
    return;
  }
  openConfirm({
    title: 'End session early?',
    body: `${displayName(item)} (${item.id}) still has ${clock(item.remainingMs)} left. This cannot be undone.`,
    submit: 'End session',
    action: () => endSession(item),
  });
}

function askRemove(item) {
  const session = item.state === 'idle' ? '' : ' Its session will end too.';
  openConfirm({
    title: 'Remove wristband?',
    body: `${displayName(item)} (${item.id}) will be removed from the dashboard.${session}`,
    submit: 'Remove',
    action: async () => {
      await api('DELETE', devicePath(item.id), { force: item.state !== 'idle' });
      return `${item.id} removed.`;
    },
  });
}

const actions = {
  register: () => openRegister(),
  'register-nearby': (_item, id) => openRegister(id),
  start: openStart,
  extend: openExtend,
  end: askEnd,
  rename: openRename,
  remove: askRemove,
};

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) {
    event.target.closest('dialog').close();
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const id = button.closest('[data-device]')?.dataset.device;
  actions[button.dataset.action](device(id), id);
});

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.querySelector('form').addEventListener('submit', submitDialog);
}
el('session-dialog').addEventListener('change', (event) => {
  if (event.target.name === 'preset') syncCustomField(el('session-dialog'));
});

connect();
setInterval(watchConnection, 1000);
