# PlayPulse MQTT contract (v1)

The one agreement between the wristband firmware (`wristband/`) and the dashboard
(`dashboard/`). Change this file first if either side needs something different.

Proof-of-concept transport: each watch connects to the broker over 2.4 GHz Wi-Fi.
BLE gateways come later to save power. They should publish these same topics for
the watch, so the dashboard does not change.

## Rules

- **The server owns the session.** It decides the end time. The watch only displays it.
- **The server owns the clock.** Watches take their time from `playpulse/v1/time`, so
  the system needs no internet or NTP.
- **A watch that loses contact keeps counting down** to the last end time it received.
- All payloads are JSON. All times are Unix epoch **milliseconds**. All durations are
  milliseconds.
- `{id}` is the wristband ID, e.g. `PlayPark_Tag_01`. It must not contain `/`, `+` or `#`.

## Topics

| Topic | Direction | QoS | Retained | Purpose |
|---|---|---|---|---|
| `playpulse/v1/time` | server to watch | 0 | yes | Server clock, every 10 s |
| `playpulse/v1/devices/{id}/session` | server to watch | 1 | yes | Current session |
| `playpulse/v1/devices/{id}/status` | watch to server | 1 | yes | Online or offline, including Last Will |
| `playpulse/v1/devices/{id}/telemetry` | watch to server | 0 | no | Live state, every 5 s |
| `playpulse/v1/devices/{id}/event` | watch to server | 1 | no | Staff action on the watch |

## Payloads

### `playpulse/v1/time`

```json
{ "now": 1793940000000 }
```

The retained copy a watch gets on connect is up to 10 s old, or much older if the server
is down. Treat it as a first estimate and replace it with the next message, which arrives
live within 10 s. Until then a watch's countdown runs high by the age of the message.

### `.../session`

Active session:

```json
{
  "sessionId": "abc123",
  "endsAt": 1793940030000,
  "warningMs": 10000,
  "durationMs": 30000,
  "extensionPending": false,
  "wearer": "Amy B"
}
```

`durationMs` is the session's length including any extensions. The watch uses it to
show how much of the session is left. If it is missing, the watch treats the time
left when it first saw the session as the full length.

`wearer` is who the watch belongs to for this session, so a lost watch can be returned.
It is the child's first name and surname initial, or the walk-in label, and is left out
if there is neither. It is the only personal data sent to a watch, and it stays on the
broker until the session ends.

`extensionPending` is true while a request for more time from the watch is waiting for
staff. The watch shows that it has asked.

No session. Publish this rather than clearing the retained message, so a watch can tell
"no session" from "not heard yet":

```json
{ "sessionId": null }
```

Pausing a session looks the same to a watch as ending it. The time left is saved on the
child's profile on the server, and using it later is a new session with a new `sessionId`.

The server republishes this whenever a session starts, is extended, is paused or ends, when a request for more time or the wearer changes,
when a device is registered or removed, and for every device each time it connects to the
broker. A retained message lets a rebooted watch recover its session.

Every message replaces whatever the watch held. `sessionId` stays the same when a session
is extended, so always use the latest one.

A watch that is not registered yet receives no session message. It should report `idle`
and keep listening.

### `.../status`

On connect, retained:

```json
{ "online": true, "firmware": "0.2.0" }
```

Last Will, retained, published by the broker when the watch drops:

```json
{ "online": false }
```

The server shows a watch as online when its last status was online and it was heard in
the last 15 s. A retained status does not count as heard.

### `.../telemetry`

```json
{ "state": "green", "remainingMs": 18000, "sessionId": "abc123", "rssi": -58, "uptimeMs": 90500, "battery": 80, "charging": false }
```

`state` is `idle`, `green`, `yellow` or `red`. `remainingMs` is 0 for `idle` and `red`.
`sessionId` is `null` when idle. `rssi` is Wi-Fi signal strength in dBm. `battery` is the
charge from 0 to 100, and `charging` says if it is charging. Both are left out when the
watch can't read its battery.

The watch works out its state from the server's end time, using `warningMs`:

- `green` until `endsAt - warningMs`
- `yellow` until `endsAt`
- `red` from `endsAt` on

Telemetry is a report. The dashboard must not take session state from it. It compares
the report with its own session and flags a different `sessionId`, a state that does not
fit, or a `remainingMs` more than 3 s out.

### `.../event`

The watch screen was held for 3 seconds, asking for more time:

```json
{ "type": "extension_requested", "sessionId": "abc123", "requestId": "90500" }
```

This changes no time by itself. The server records the request, republishes `.../session`
with `extensionPending: true` and shows it to staff, who approve it with an amount of time
or decline it. Either way the server republishes `.../session` with `extensionPending:
false`, and an approval also carries the new `endsAt`. This works on an expired session too.

`requestId` is different for each hold. The server ignores an event if `sessionId` is not
the current session, if a request is already waiting, or if it has seen that `requestId`,
so a copy redelivered by QoS 1 can't raise a request again. An event sent while the server
is down is lost.

## Broker

Port 1883, no TLS. The broker requires a username and password. They are stored outside
version control, in `wristband/secrets.h` on the watch and in `broker/.env` on the server.
See `broker/README.md`.
