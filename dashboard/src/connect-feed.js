// Joins a feed adapter to the store, in both directions.
export function connectFeed(store, adapter, log = console) {
  adapter.on('sighting', (sighting) => store.recordSighting(sighting));
  adapter.on('presence', (presence) => store.recordPresence(presence));
  adapter.on('restartRequested', ({ deviceId, sessionId }) => {
    if (store.restartFromWatch(deviceId, sessionId)) {
      log.log(`${deviceId}: session restarted from the watch`);
    } else {
      log.log(`${deviceId}: ignored restart for stale session ${sessionId}`);
    }
  });
  store.on('session', ({ deviceId, session }) => adapter.publishSession(deviceId, session));
}
