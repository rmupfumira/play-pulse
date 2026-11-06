// The dashboard's only link to wristband traffic.
//
// An adapter is an EventEmitter with:
//   start()  begin receiving traffic
//   stop()   release timers and connections
//   info()   { id, name, simulated, connected, canCommandDevices, detail }
//   publishSession(deviceId, session)  tell the wristband its session, or null
//                                      for none. A no-op if canCommandDevices is false.
// and emits:
//   'sighting' { deviceId, at, rssi?, report?, battery? }  a wristband was heard; `at` is
//                                      epoch ms, and `report` is what the watch
//                                      says it shows: { state, remainingMs, sessionId }
//   'presence' { deviceId, online, firmware?, live }  connection status; `live`
//                                      is false for a retained, older message
//   'extensionRequested' { deviceId, sessionId, requestId }  the screen was held,
//                                      asking staff for more time
//   'status'                           info() changed
import { MqttAdapter } from './mqtt.js';
import { SimulatorAdapter } from './simulator.js';

const adapters = {
  simulator: (context) => new SimulatorAdapter(context),
  mqtt: (context) => new MqttAdapter({
    ...context,
    url: process.env.MQTT_URL,
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
  }),
};

export function createAdapter(name, context) {
  const create = adapters[name];
  if (!create) {
    throw new Error(`Unknown ADAPTER "${name}". Available: ${Object.keys(adapters).join(', ')}.`);
  }
  return create(context);
}
