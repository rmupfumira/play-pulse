import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { shortName, Store } from '../src/store.js';

const MINUTE = 60_000;
let clock;
let store;
let file;

function newStore() {
  return new Store({ file, now: () => clock.t });
}

beforeEach(() => {
  clock = { t: 1_000_000 };
  file = join(mkdtempSync(join(tmpdir(), 'playpulse-')), 'data.json');
  store = newStore();
  store.register({ id: 'Tag_1' });
  store.register({ id: 'Tag_2' });
});

const child = (id) => store.people().children.find((item) => item.id === id);

test('a child keeps one usage history across different tags', () => {
  const { id } = store.addChild({ name: 'Child A' });

  store.startSession('Tag_1', { durationSeconds: 1800, childId: id });
  clock.t += 20 * MINUTE;
  store.endSession('Tag_1');

  store.startSession('Tag_2', { durationSeconds: 900, childId: id });
  clock.t += 10 * MINUTE;
  store.endSession('Tag_2');

  assert.equal(child(id).visits, 2);
  assert.equal(child(id).totalMs, 30 * MINUTE);
  const { usage } = store.childDetail(id);
  assert.deepEqual(usage.map((row) => row.deviceId), ['Tag_2', 'Tag_1']);
  assert.deepEqual(usage.map((row) => row.allocatedMs), [15 * MINUTE, 30 * MINUTE]);
});

test('ending a session frees the tag for the next child', () => {
  const first = store.addChild({ name: 'Child A' });
  const second = store.addChild({ name: 'Child B' });
  store.startSession('Tag_1', { durationSeconds: 600, childId: first.id });
  store.endSession('Tag_1');
  store.startSession('Tag_1', { durationSeconds: 600, childId: second.id });
  clock.t += MINUTE;
  store.endSession('Tag_1');
  assert.equal(child(first.id).totalMs, 0);
  assert.equal(child(second.id).totalMs, MINUTE);
});

test('a session without a child records no usage', () => {
  store.startSession('Tag_1', { durationSeconds: 600 });
  clock.t += MINUTE;
  store.endSession('Tag_1');
  assert.equal(store.people().children.length, 0);
});

test('a child cannot be on two tags at once', () => {
  const { id } = store.addChild({ name: 'Child A' });
  store.startSession('Tag_1', { durationSeconds: 600, childId: id });
  assert.throws(
    () => store.startSession('Tag_2', { durationSeconds: 600, childId: id }),
    { status: 409, code: 'child_busy' },
  );
  assert.equal(store.snapshot().devices.find((d) => d.id === 'Tag_2').session, null);
});

test('an unknown child stops a session starting', () => {
  assert.throws(() => store.startSession('Tag_1', { durationSeconds: 600, childId: 'nope' }), { status: 404 });
});

test('the wristband list names the child, and the profile shows where they are', () => {
  const { id } = store.addChild({ name: 'Child A' });
  store.startSession('Tag_1', { durationSeconds: 600, childId: id });
  assert.deepEqual(store.snapshot().devices[0].child, { id, name: 'Child A' });
  assert.equal(child(id).activeDeviceId, 'Tag_1');
});

test('a child can be assigned to a running session, and time counts from its start', () => {
  const { id } = store.addChild({ name: 'Child A' });
  store.startSession('Tag_1', { durationSeconds: 600 });
  clock.t += 2 * MINUTE;
  store.assignChild('Tag_1', { childId: id });
  clock.t += MINUTE;
  store.endSession('Tag_1');
  assert.equal(child(id).totalMs, 3 * MINUTE);
});

test('assigning needs a running session', () => {
  const { id } = store.addChild({ name: 'Child A' });
  assert.throws(() => store.assignChild('Tag_1', { childId: id }), { status: 409, code: 'no_session' });
});

test('more time approved from the watch stays one session for the child', () => {
  const { id } = store.addChild({ name: 'Child A' });
  const { session } = store.startSession('Tag_1', { durationSeconds: 600, childId: id });
  store.requestExtension('Tag_1', session.id, 'r1');
  store.approveExtension('Tag_1', { durationSeconds: 300 });
  clock.t += 12 * MINUTE;
  store.endSession('Tag_1');
  assert.equal(child(id).visits, 1);
  assert.equal(store.childDetail(id).usage[0].allocatedMs, 15 * MINUTE);
});

test('removing a tag with a running session keeps the usage', () => {
  const { id } = store.addChild({ name: 'Child A' });
  store.startSession('Tag_1', { durationSeconds: 600, childId: id });
  clock.t += MINUTE;
  store.remove('Tag_1', { force: true });
  assert.equal(child(id).totalMs, MINUTE);
});

test('siblings can share a parent, and parents link both ways', () => {
  const parent = store.addParent({ name: 'Parent A', phone: '+27 82 000 0000' });
  const first = store.addChild({ name: 'Child A', parentIds: [parent.id] });
  const second = store.addChild({ name: 'Child B', parentIds: [parent.id] });
  assert.deepEqual(store.people().parents[0].childIds, [first.id, second.id]);
  assert.equal(store.childDetail(first.id).parents[0].name, 'Parent A');
});

test('removing a parent leaves the child', () => {
  const parent = store.addParent({ name: 'Parent A' });
  const { id } = store.addChild({ name: 'Child A', parentIds: [parent.id] });
  store.removeParent(parent.id);
  assert.deepEqual(child(id).parentIds, []);
});

test('removing a child erases their usage history', () => {
  const { id } = store.addChild({ name: 'Child A' });
  store.startSession('Tag_1', { durationSeconds: 600, childId: id });
  store.endSession('Tag_1');
  store.removeChild(id);
  assert.equal(store.people().children.length, 0);
  assert.equal(store.usageCount(), 0);
});

test('a child in a session cannot be removed', () => {
  const { id } = store.addChild({ name: 'Child A' });
  store.startSession('Tag_1', { durationSeconds: 600, childId: id });
  assert.throws(() => store.removeChild(id), { status: 409, code: 'child_busy' });
});

test('names are required and contact details are checked', () => {
  assert.throws(() => store.addChild({ name: '  ' }), { code: 'invalid_name' });
  assert.throws(() => store.addChild({ name: 'x'.repeat(61) }), { code: 'invalid_name' });
  assert.throws(() => store.addParent({ name: 'A', phone: 'call me' }), { code: 'invalid_phone' });
  assert.throws(() => store.addParent({ name: 'A', email: 'nope' }), { code: 'invalid_email' });
  assert.throws(() => store.addChild({ name: 'A', parentIds: ['nope'] }), { status: 404 });
});

test('children, parents and usage survive a restart', () => {
  const parent = store.addParent({ name: 'Parent A' });
  const { id } = store.addChild({ name: 'Child A', parentIds: [parent.id] });
  store.startSession('Tag_1', { durationSeconds: 600, childId: id });
  clock.t += MINUTE;
  store.endSession('Tag_1');
  store.startSession('Tag_2', { durationSeconds: 600, childId: id });

  const reloaded = newStore();
  assert.equal(reloaded.load(), false);
  store = reloaded;
  assert.equal(child(id).totalMs, MINUTE);
  assert.equal(child(id).activeDeviceId, 'Tag_2');
  assert.equal(store.people().parents[0].name, 'Parent A');
});

test('watches get a first name and surname initial, not the full name', () => {
  assert.equal(shortName('Amy'), 'Amy');
  assert.equal(shortName('Amy Botha'), 'Amy B');
  assert.equal(shortName('  Amy  van der Merwe '), 'Amy M');
});

test('the watch is told who is wearing it, and when that changes', () => {
  const sent = [];
  store.on('session', ({ session }) => sent.push(session?.wearer));
  const { id } = store.addChild({ name: 'Amy Botha' });
  store.startSession('Tag_1', { durationSeconds: 600, childId: id });
  store.updateChild(id, { name: 'Amy Smith' });
  store.assignChild('Tag_1', { childId: null });
  store.rename('Tag_1', { label: 'Walk-in 4' });
  store.endSession('Tag_1');
  assert.deepEqual(sent, ['Amy B', 'Amy S', '', 'Walk-in 4', undefined]);
});

test('pausing saves the time left for the child and frees the tag', () => {
  const { id } = store.addChild({ name: 'Child A' });
  store.startSession('Tag_1', { durationSeconds: 3600, childId: id });
  store.requestExtension('Tag_1', store.snapshot().devices[0].session.id, 'r1');
  clock.t += 40 * MINUTE;

  store.pauseSession('Tag_1');

  assert.equal(child(id).creditMs, 20 * MINUTE);
  assert.equal(child(id).activeDeviceId, null);
  assert.equal(child(id).totalMs, 40 * MINUTE);
  assert.equal(store.snapshot().devices[0].state, 'idle');
  const [row] = store.childDetail(id).usage;
  assert.equal(row.savedMs, 20 * MINUTE);
  assert.equal(row.allocatedMs, 60 * MINUTE);
});

test('saved time is used on any tag and can be paused again', () => {
  const { id } = store.addChild({ name: 'Child A' });
  store.startSession('Tag_1', { durationSeconds: 3600, childId: id });
  clock.t += 40 * MINUTE;
  store.pauseSession('Tag_1');
  clock.t += 24 * 60 * MINUTE;

  const device = store.startSession('Tag_2', { childId: id, useCredit: true });

  assert.equal(device.session.endsAt, clock.t + 20 * MINUTE);
  assert.equal(child(id).creditMs, 0);

  clock.t += 5 * MINUTE;
  store.pauseSession('Tag_2');
  assert.equal(child(id).creditMs, 15 * MINUTE);
  assert.equal(child(id).totalMs, 45 * MINUTE);
});

test('saved time stays when a child starts on newly paid time, and adds up', () => {
  const { id } = store.addChild({ name: 'Child A' });
  store.startSession('Tag_1', { durationSeconds: 1800, childId: id });
  store.pauseSession('Tag_1');
  store.startSession('Tag_1', { durationSeconds: 600, childId: id });
  assert.equal(child(id).creditMs, 30 * MINUTE);
  store.pauseSession('Tag_1');
  assert.equal(child(id).creditMs, 40 * MINUTE);
});

test('time cannot be saved for a walk-in or after it has run out', () => {
  const { id } = store.addChild({ name: 'Child A' });
  store.startSession('Tag_1', { durationSeconds: 600 });
  assert.throws(() => store.pauseSession('Tag_1'), { code: 'no_child' });

  store.startSession('Tag_2', { durationSeconds: 600, childId: id });
  clock.t += 10 * MINUTE;
  assert.throws(() => store.pauseSession('Tag_2'), { code: 'no_time_left' });
  assert.equal(child(id).creditMs, 0);
  assert.notEqual(store.snapshot().devices[1].state, 'idle');
});

test('saved time cannot be used by a child without any', () => {
  const { id } = store.addChild({ name: 'Child A' });
  assert.throws(() => store.startSession('Tag_1', { childId: id, useCredit: true }), { code: 'no_credit' });
  assert.throws(() => store.startSession('Tag_1', { useCredit: true }), { code: 'no_credit' });
});

test('saved time survives a restart', () => {
  const { id } = store.addChild({ name: 'Child A' });
  store.startSession('Tag_1', { durationSeconds: 600, childId: id });
  store.pauseSession('Tag_1');
  store = newStore();
  store.load();
  assert.equal(child(id).creditMs, 10 * MINUTE);
});

test('a data file from before profiles still loads', () => {
  writeFileSync(file, JSON.stringify({ version: 1, devices: [{ id: 'Old', label: '', session: null }] }));
  store = newStore();
  assert.equal(store.load(), false);
  assert.equal(store.snapshot().devices[0].id, 'Old');
  assert.equal(store.people().children.length, 0);
});
