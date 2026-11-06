// Renders the server's state and sends staff actions back. The server is the
// authority on time, so this page does no countdown arithmetic of its own: each
// update carries the current remaining time.
const STALE_AFTER_MS = 4000;
const TOAST_MS = 4000;
const LOW_BATTERY_PERCENT = 20;
const STATE_TEXT = { idle: 'No session', green: 'Active', yellow: 'Ending soon', red: 'Time up' };
const STATE_ORDER = { red: 0, yellow: 1, green: 2, idle: 3 };
const FILTERS = {
  green: (item) => item.state === 'green',
  yellow: (item) => item.state === 'yellow',
  red: (item) => item.state === 'red',
  offline: (item) => !item.online,
  mismatch: (item) => isMismatch(item),
  request: (item) => hasRequest(item),
  battery: (item) => isLowBattery(item),
};
const START_PRESETS = [
  { seconds: 30, text: '30 sec' },
  { seconds: 900, text: '15 min' },
  { seconds: 1800, text: '30 min', preselected: true },
  { seconds: 3600, text: '60 min' },
  { seconds: 5400, text: '90 min' },
];
const EXTEND_PRESETS = [
  { seconds: 30, text: '+30 sec' },
  { seconds: 300, text: '+5 min' },
  { seconds: 900, text: '+15 min', preselected: true },
  { seconds: 1800, text: '+30 min' },
];

const el = (id) => document.getElementById(id);
const field = (root, name) => root.querySelector(`[data-f="${name}"]`);

let snap = null;
let lastUpdateAt = 0;
let toastTimer = null;
let filter = null;
let moreDeviceId = null;
let view = 'bands';
let people = { parents: [], children: [] };
let peopleRevision = null;
const knownRequests = new Map();

function displayName(device) {
  return device.child?.name || device.label || 'Unassigned';
}

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase();
}

// Reads as "1h 25m", which is easier to scan in a history than a clock.
function spanText(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return ms > 0 ? 'Under 1m' : '0m';
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function dateText(at) {
  return new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
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

function dialText(item) {
  if (item.state === 'idle') return 'Ready';
  return item.state === 'red' ? `+${clock(item.remainingMs)}` : clock(item.remainingMs);
}

function stateText(item) {
  return item.state === 'red' ? `Time up, over by ${clock(item.remainingMs)}` : STATE_TEXT[item.state];
}

// How much of the session is left, for the ring.
function dialPercent(item) {
  if (item.state === 'idle') return 0;
  if (item.state === 'red') return 100;
  return Math.max(0, Math.min(100, (item.remainingMs / item.session.durationMs) * 100));
}

function signalText(rssi) {
  if (rssi === null) return '';
  if (rssi >= -60) return 'strong signal';
  if (rssi >= -72) return 'good signal';
  if (rssi >= -82) return 'weak signal';
  return 'poor signal';
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

const hasRequest = (item) => Boolean(item.session?.extensionRequest);

// A watch that has gone quiet shows as offline, so its old level isn't shown.
const showsBattery = (item) => item.online && item.battery !== null;
const isLowBattery = (item) => showsBattery(item)
  && !item.battery.charging
  && item.battery.percent <= LOW_BATTERY_PERCENT;

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

function updateCard(card, item) {
  card.dataset.state = item.state;
  const label = field(card, 'label');
  label.textContent = displayName(item);
  label.toggleAttribute('data-unassigned', !item.child && !item.label);
  field(card, 'id').textContent = item.id;

  const time = dialText(item);
  field(card, 'time').textContent = time;
  card.toggleAttribute('data-long', time.length > 5);
  field(card, 'dial').setAttribute('stroke-dasharray', `${dialPercent(item)} 100`);

  const state = field(card, 'state');
  state.textContent = stateText(item);
  state.dataset.state = item.state;

  const link = field(card, 'link');
  const signal = item.online ? signalText(item.rssi) : '';
  const heard = item.online ? 'Online' : `Offline, seen ${agoText(item.lastSeenAt).toLowerCase()}`;
  link.textContent = signal ? `${heard}, ${signal}` : heard;
  link.dataset.online = item.online;
  link.title = [item.firmware && `Firmware ${item.firmware}`, item.rssi !== null && `${item.rssi} dBm`]
    .filter(Boolean).join(', ');

  const battery = field(card, 'battery');
  battery.hidden = !showsBattery(item);
  battery.dataset.low = isLowBattery(item);
  if (showsBattery(item)) {
    battery.textContent = `Battery ${item.battery.percent}%${item.battery.charging ? ', charging' : ''}`;
  }

  field(card, 'request').hidden = !hasRequest(item);
  card.toggleAttribute('data-request', hasRequest(item));
  // Only a problem is worth a line on the card.
  setNote(field(card, 'watch'), snap.adapter.canCommandDevices && isMismatch(item) ? watchNote(item) : { text: '' });

  const hasSession = item.state !== 'idle';
  card.querySelector('[data-action="start"]').hidden = hasSession;
  card.querySelector('[data-action="extend"]').hidden = !hasSession;
  card.querySelector('[data-action="pause"]').hidden = !hasSession || item.state === 'red';
  card.querySelector('[data-action="end"]').hidden = !hasSession;
}

function updateNearby(row, item) {
  field(row, 'id').textContent = item.id;
  field(row, 'seen').textContent = `Heard ${agoText(item.lastSeenAt)}`;
}

// A request has to be noticed from wherever staff are in the page.
function announceRequests(devices) {
  for (const item of devices) {
    const at = item.session?.extensionRequest?.requestedAt ?? null;
    const known = knownRequests.get(item.id);
    if (at !== null && at !== known) toast(`${displayName(item)} is asking for more time.`);
    knownRequests.set(item.id, at);
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
  el('sign-out').hidden = !snap.signInRequired;
  if (snap.revision !== peopleRevision) refreshPeople();

  const count = (name) => devices.filter(FILTERS[name]).length;
  const expired = count('red');
  const ending = count('yellow');
  for (const name of Object.keys(FILTERS)) el(`count-${name}`).textContent = count(name);
  el('mismatch-tile').hidden = count('mismatch') === 0;
  el('request-tile').hidden = count('request') === 0;
  el('battery-tile').hidden = count('battery') === 0;
  if (['mismatch', 'request', 'battery'].includes(filter) && count(filter) === 0) setFilter(null);
  announceRequests(devices);
  const waiting = expired + ending + count('request');
  document.title = waiting > 0 ? `(${waiting}) PlayPulse` : 'PlayPulse';

  // Whatever needs staff comes first, most overrun at the top.
  const shown = devices
    .filter(filter ? FILTERS[filter] : () => true)
    .sort((a, b) => hasRequest(b) - hasRequest(a)
      || STATE_ORDER[a.state] - STATE_ORDER[b.state]
      || (a.state === 'idle' ? 0 : a.remainingMs - b.remainingMs));
  syncList(el('devices'), shown, 'band-card', updateCard);
  el('devices-empty').hidden = devices.length > 0;
  el('filter-empty').hidden = devices.length === 0 || shown.length > 0;

  syncList(el('nearby'), nearby, 'nearby-item', updateNearby);
  el('nearby-section').hidden = nearby.length === 0;
}

async function refreshPeople() {
  peopleRevision = snap.revision;
  people = await api('GET', '/api/people').catch(() => people);
  renderPeople();
}

function syncPeople(container, items, update) {
  syncList(container, items, 'person-card', update);
  for (const item of items) container.elements.get(item.id).dataset.person = item.id;
}

function matches(item, query) {
  return item.name.toLowerCase().includes(query.trim().toLowerCase());
}

function renderPeople() {
  const parentNames = (child) => child.parentIds
    .map((id) => people.parents.find((parent) => parent.id === id)?.name)
    .filter(Boolean).join(', ');

  const children = people.children.filter((child) => matches(child, el('child-search').value));
  syncPeople(el('children'), children, (card, child) => {
    field(card, 'initials').textContent = initials(child.name);
    field(card, 'name').textContent = child.name;
    field(card, 'line').textContent = parentNames(child) || 'No parent added';
    field(card, 'detail').textContent = child.visits
      ? `${spanText(child.totalMs)} over ${child.visits} session${child.visits === 1 ? '' : 's'}`
      : 'No sessions yet';
    const live = field(card, 'live');
    live.hidden = !child.activeDeviceId && !child.creditMs;
    live.textContent = child.activeDeviceId ? 'Playing' : `${spanText(child.creditMs)} saved`;
  });
  el('children-empty').hidden = people.children.length > 0;

  const parents = people.parents.filter((parent) => matches(parent, el('parent-search').value));
  syncPeople(el('parents'), parents, (card, parent) => {
    field(card, 'initials').textContent = initials(parent.name);
    field(card, 'name').textContent = parent.name;
    field(card, 'line').textContent = parent.phone || parent.email || 'No contact details';
    field(card, 'detail').textContent = parent.childIds
      .map((id) => people.children.find((child) => child.id === id)?.name)
      .filter(Boolean).join(', ') || 'No children linked';
  });
  el('parents-empty').hidden = people.parents.length > 0;
}

const ADD_TEXT = { bands: 'Add wristband', children: 'Add child', parents: 'Add parent' };

function setView(name) {
  view = name;
  for (const tab of document.querySelectorAll('[data-view]')) {
    if (tab.dataset.view === name) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  for (const key of Object.keys(ADD_TEXT)) el(`view-${key}`).hidden = key !== name;
  el('top-add-text').textContent = ADD_TEXT[name];
  el('fab').setAttribute('aria-label', ADD_TEXT[name]);
  scrollTo(0, 0);
}

function setFilter(name) {
  filter = name;
  for (const tile of document.querySelectorAll('[data-filter]')) {
    tile.setAttribute('aria-pressed', tile.dataset.filter === name);
  }
  el('clear-filter').hidden = name === null;
}

function connect() {
  const stream = new EventSource('/api/events');
  stream.addEventListener('state', (event) => {
    snap = JSON.parse(event.data);
    lastUpdateAt = Date.now();
    render();
  });
  // The stream can't report a 401 itself, so check whether the sign-in has expired.
  stream.addEventListener('error', async () => {
    const response = await fetch('/api/state').catch(() => null);
    if (response?.status === 401) location.replace('/login');
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
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  if (response.ok) return response.json();
  if (response.status === 401) location.replace('/login');
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
  field(dialog, 'child-field').hidden = !showLabel;
  fillChildChoices(form.elements.childId, null);
  syncLabelField(dialog);
  form.elements.label.value = item.label;
  setPresets(dialog, presets);
  openDialog(dialog, action);
}

// Children already on a tag are left out, as the server would refuse them.
function fillChildChoices(select, currentId) {
  const none = new Option('Walk-in, no profile', '');
  const free = people.children.filter((child) => !child.activeDeviceId || child.id === currentId);
  select.replaceChildren(none, ...free.map((child) => new Option(child.name, child.id)));
  select.value = currentId ?? '';
}

function syncLabelField(dialog) {
  const form = dialog.querySelector('form');
  field(dialog, 'label-field').hidden = field(dialog, 'child-field').hidden || form.elements.childId.value !== '';
}

function openAssign(item) {
  const dialog = el('assign-dialog');
  field(dialog, 'device').textContent = item.id;
  const select = dialog.querySelector('select');
  fillChildChoices(select, item.child?.id ?? null);
  openDialog(dialog, async (data) => {
    await api('POST', `${devicePath(item.id)}/child`, { childId: data.get('childId') || null });
    return `${item.id} updated.`;
  });
}

function openChild(child = null) {
  const dialog = el('child-dialog');
  const form = dialog.querySelector('form');
  form.reset();
  field(dialog, 'title').textContent = child ? 'Edit child' : 'Add child';
  field(dialog, 'submit').textContent = child ? 'Save' : 'Add child';
  form.elements.name.value = child?.name ?? '';

  const box = field(dialog, 'parents');
  box.replaceChildren(...people.parents.map((parent) => {
    const label = document.createElement('label');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.name = 'parentIds';
    check.value = parent.id;
    check.checked = child?.parentIds.includes(parent.id) ?? false;
    label.append(check, parent.name);
    return label;
  }));
  field(dialog, 'parents-field').hidden = people.parents.length === 0;

  openDialog(dialog, async (data) => {
    const parentIds = data.getAll('parentIds');
    const newParent = data.get('parentName').trim();
    if (newParent) {
      const parent = await api('POST', '/api/parents', { name: newParent, phone: data.get('parentPhone') });
      parentIds.push(parent.id);
    }
    const body = { name: data.get('name'), parentIds };
    if (child) await api('PATCH', `/api/children/${child.id}`, body);
    else await api('POST', '/api/children', body);
    return child ? 'Child updated.' : `${body.name.trim()} added.`;
  });
}

function openParent(parent = null) {
  const dialog = el('parent-dialog');
  const form = dialog.querySelector('form');
  form.reset();
  field(dialog, 'title').textContent = parent ? 'Edit parent' : 'Add parent';
  field(dialog, 'submit').textContent = parent ? 'Save' : 'Add parent';
  form.elements.name.value = parent?.name ?? '';
  form.elements.phone.value = parent?.phone ?? '';
  form.elements.email.value = parent?.email ?? '';
  const names = (parent?.childIds ?? []).map((id) => people.children.find((child) => child.id === id)?.name);
  field(dialog, 'children').textContent = names.length ? `Children: ${names.join(', ')}` : '';
  const remove = field(dialog, 'remove');
  remove.hidden = !parent;
  remove.onclick = () => {
    dialog.close();
    openConfirm({
      title: 'Remove parent?',
      body: `${parent.name} will be removed. Their children stay on the system.`,
      submit: 'Remove',
      action: async () => {
        await api('DELETE', `/api/parents/${parent.id}`);
        return `${parent.name} removed.`;
      },
    });
  };
  openDialog(dialog, async (data) => {
    const body = { name: data.get('name'), phone: data.get('phone'), email: data.get('email') };
    if (parent) await api('PATCH', `/api/parents/${parent.id}`, body);
    else await api('POST', '/api/parents', body);
    return parent ? 'Parent updated.' : `${body.name.trim()} added.`;
  });
}

function contactItem(parent) {
  const row = document.createElement('li');
  const name = document.createElement('span');
  name.textContent = parent.name;
  row.append(name);
  if (parent.phone) {
    const call = document.createElement('a');
    call.href = `tel:${parent.phone.replace(/[^+0-9]/g, '')}`;
    call.textContent = parent.phone;
    row.append(call);
  }
  return row;
}

function usageItem(row) {
  const item = el('usage-row').content.firstElementChild.cloneNode(true);
  field(item, 'date').textContent = dateText(row.startedAt);
  field(item, 'tag').textContent = `${timeOfDay(row.startedAt)} on ${row.deviceId}`;
  field(item, 'used').textContent = spanText(row.endedAt - row.startedAt);
  const saved = row.savedMs ? `, ${spanText(row.savedMs)} saved` : '';
  field(item, 'allocated').textContent = `of ${spanText(row.allocatedMs)}${saved}`;
  return item;
}

async function openProfile(id) {
  const child = await api('GET', `/api/children/${id}`).catch((err) => toast(err.message));
  if (!child) return;
  const dialog = el('profile-dialog');
  field(dialog, 'initials').textContent = initials(child.name);
  field(dialog, 'name').textContent = child.name;
  field(dialog, 'live').textContent = child.activeDeviceId ? `Playing now on ${child.activeDeviceId}` : 'Not playing now';
  field(dialog, 'total').textContent = spanText(child.totalMs);
  field(dialog, 'visits').textContent = child.visits;
  field(dialog, 'credit').textContent = spanText(child.creditMs);
  field(dialog, 'parents').replaceChildren(...child.parents.map(contactItem));
  field(dialog, 'usage').replaceChildren(...child.usage.map(usageItem));
  field(dialog, 'usage-empty').hidden = child.usage.length > 0;
  field(dialog, 'edit').onclick = () => {
    dialog.close();
    openChild(child);
  };
  field(dialog, 'remove').onclick = () => {
    dialog.close();
    openConfirm({
      title: 'Delete child and history?',
      body: `${child.name}, all their usage history and any saved time will be deleted. This cannot be undone.`,
      submit: 'Delete',
      action: async () => {
        await api('DELETE', `/api/children/${child.id}`);
        return `${child.name} deleted.`;
      },
    });
  };
  dialog.showModal();
}

// A returning child's saved time is what they most likely came to use.
function startPresets(childId) {
  const credit = people.children.find((child) => child.id === childId)?.creditMs;
  if (!credit) return START_PRESETS;
  return [
    { seconds: 'credit', text: `Saved ${spanText(credit)}`, preselected: true },
    ...START_PRESETS.map((preset) => ({ ...preset, preselected: false })),
  ];
}

function openStart(item) {
  openSessionDialog(item, {
    title: 'Start session',
    submit: 'Start session',
    presets: START_PRESETS,
    showLabel: true,
    action: async (data) => {
      const childId = data.get('childId') || null;
      const body = data.get('preset') === 'credit'
        ? { useCredit: true, label: data.get('label'), childId }
        : { durationSeconds: chosenSeconds(data), label: data.get('label'), childId };
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

function openMore(item) {
  const dialog = el('more-dialog');
  moreDeviceId = item.id;
  field(dialog, 'title').textContent = displayName(item);
  field(dialog, 'device').textContent = item.firmware ? `${item.id}, firmware ${item.firmware}` : item.id;
  dialog.querySelector('[data-more="assign"]').hidden = item.state === 'idle';
  dialog.querySelector('[data-more="profile"]').hidden = !item.child;
  dialog.showModal();
}

function openApprove(item) {
  openSessionDialog(item, {
    title: 'Approve more time',
    submit: 'Approve',
    presets: EXTEND_PRESETS,
    showLabel: false,
    action: async (data) => {
      await api('POST', `${devicePath(item.id)}/extension/approve`, { durationSeconds: chosenSeconds(data) });
      return `More time approved on ${item.id}.`;
    },
  });
}

async function decline(item) {
  await api('POST', `${devicePath(item.id)}/extension/decline`);
  return `Request declined on ${item.id}.`;
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

function askPause(item) {
  if (!item.child) {
    toast('Assign a child first, so the time has someone to be saved for.');
    return;
  }
  openConfirm({
    title: 'Pause session?',
    body: `${clock(item.remainingMs)} will be saved for ${item.child.name}, to use on any wristband. This one will be free.`,
    submit: 'Pause session',
    action: async () => {
      await api('POST', `${devicePath(item.id)}/session/pause`);
      return `Time saved for ${item.child.name}.`;
    },
  });
}

function askEnd(item) {
  // Ending an expired session is routine; ending one with time left loses that time.
  if (item.state === 'red') {
    endSession(item).then(toast, (err) => toast(err.message));
    return;
  }
  openConfirm({
    title: 'End session early?',
    body: `${displayName(item)} (${item.id}) still has ${clock(item.remainingMs)} left, which will be lost. Pause keeps it for a child with a profile.`,
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
  add: () => ({ bands: openRegister, children: openChild, parents: openParent })[view](),
  'register-nearby': (_item, id) => openRegister(id),
  start: openStart,
  extend: openExtend,
  pause: askPause,
  end: askEnd,
  more: openMore,
  approve: openApprove,
  decline: (item) => decline(item).then(toast, (err) => toast(err.message)),
  'clear-filter': () => { setFilter(null); render(); },
  'sign-out': async () => {
    await api('POST', '/api/logout');
    location.replace('/login');
  },
};
const moreActions = {
  assign: openAssign,
  profile: (item) => openProfile(item.child.id),
  rename: openRename,
  remove: askRemove,
};

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) {
    event.target.closest('dialog').close();
    return;
  }
  const more = event.target.closest('[data-more]');
  if (more) {
    el('more-dialog').close();
    const item = device(moreDeviceId);
    if (item) moreActions[more.dataset.more](item);
    return;
  }
  const tile = event.target.closest('[data-filter]');
  if (tile) {
    setFilter(filter === tile.dataset.filter ? null : tile.dataset.filter);
    render();
    return;
  }
  const tab = event.target.closest('[data-view]');
  if (tab) {
    setView(tab.dataset.view);
    return;
  }
  const person = event.target.closest('[data-person]');
  if (person) {
    if (view === 'children') openProfile(person.dataset.person);
    else openParent(people.parents.find((parent) => parent.id === person.dataset.person));
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const id = button.closest('[data-device]')?.dataset.device;
  actions[button.dataset.action](device(id), id);
});

for (const dialog of document.querySelectorAll('dialog')) {
  if (!['more-dialog', 'profile-dialog'].includes(dialog.id)) {
    dialog.querySelector('form').addEventListener('submit', submitDialog);
  }
  // Tapping outside a sheet closes it, as people expect on a phone.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}
el('session-dialog').addEventListener('change', (event) => {
  if (event.target.name === 'preset') syncCustomField(el('session-dialog'));
  if (event.target.name === 'childId') {
    syncLabelField(el('session-dialog'));
    setPresets(el('session-dialog'), startPresets(event.target.value));
  }
});
el('child-search').addEventListener('input', renderPeople);
el('parent-search').addEventListener('input', renderPeople);

connect();
setInterval(watchConnection, 1000);
