// First-run demo data for the simulator. Labels are deliberately generic: never
// put real children's names here.
const MINUTE = 60_000;

export function seedDemoData(store) {
  const devices = [
    { n: 1, label: 'Visitor A', minutes: 30 },
    { n: 2, label: 'Visitor B', minutes: 1 },
    { n: 3, label: 'Visitor C', minutes: 0.5, expired: true },
    { n: 4, label: 'Visitor D', minutes: 60 },
    { n: 5, label: '' },
    { n: 6, label: '' },
  ];
  for (const { n, label, minutes, expired } of devices) {
    const id = `PlayPark_Tag_${String(n).padStart(2, '0')}`;
    store.register({ id, label });
    if (minutes) store.startSession(id, { durationSeconds: minutes * 60 });
    if (expired) store.backdateSession(id, 2 * MINUTE);
  }

  const parent = store.addParent({ name: 'Parent A', phone: '+27 82 000 0000' });
  store.addChild({ name: 'Child A', parentIds: [parent.id] });
  store.addChild({ name: 'Child B', parentIds: [parent.id] });
}
