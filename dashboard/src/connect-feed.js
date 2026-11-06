// Joins a feed adapter to the store, in both directions.
export function connectFeed(store, adapter, log = console) {
  adapter.on('sighting', (sighting) => store.recordSighting(sighting));
  adapter.on('presence', (presence) => store.recordPresence(presence));
  adapter.on('extensionRequested', ({ deviceId, sessionId, requestId }) => {
    if (store.requestExtension(deviceId, sessionId, requestId)) {
      log.log(`${deviceId}: asked for more time`);
    } else {
      log.log(`${deviceId}: ignored request for more time on session ${sessionId}`);
    }
  });
  store.on('session', ({ deviceId, session }) => adapter.publishSession(deviceId, session));
}
