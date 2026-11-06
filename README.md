# PlayPulse

Time tracking for a play park. Each visitor wears a wristband that counts down
their session. Staff register wristbands and run sessions from a web dashboard.

- [`dashboard/`](dashboard/README.md): the staff web page and API
- [`broker/`](broker/README.md): a local Mosquitto broker for development
- [`docs/mqtt-contract.md`](docs/mqtt-contract.md): what the watches and server send each other

## Deploy on a server

The server needs Docker with Compose, and an MQTT broker it can reach. See
[Broker requirements](#broker-requirements). Run these once:

```bash
git clone https://github.com/rmupfumira/play-pulse.git
```

```bash
cd play-pulse
```

```bash
cp .env.example .env
```

Edit `.env` and set the broker address, the broker login and a dashboard password.
This generates a password you can use:

```bash
openssl rand -hex 16
```

Start it:

```bash
docker compose up -d --build
```

The dashboard is at `http://<server-address>:4311`. Sign in with `DASHBOARD_PASSWORD`
from `.env`. A sign-in lasts 12 hours, or until the container restarts. A banner on the page says if it
cannot reach the broker.

The container restarts with Docker. Registered wristbands and sessions are kept in a
Docker volume, so they survive restarts and updates.

### Broker requirements

- **Login:** an account that can publish and subscribe under `playpulse/v1/#`. If the
  broker uses an ACL file, add that topic for the account.
- **Persistence:** set `persistence true`, so retained sessions survive a broker
  restart and a rebooted watch can recover its session.
- **Reachable:** the watches and this server both need to reach it, on port 1883 by
  default.
- **One dashboard:** run only one PlayPulse dashboard against a broker at a time.

### Point the watches at it

Each watch needs the broker's address and login in `wristband/secrets.h`, then a
reflash:

- `MQTT_URI`: `mqtt://<broker-address>:1883`
- `MQTT_USERNAME` and `MQTT_PASSWORD`: a broker account

Give the broker a fixed address, with a DHCP reservation for example, or the watches
lose it when the address changes. Open TCP 4311 if the dashboard's server runs a
firewall.

### Update

```bash
git pull
```

```bash
docker compose up -d --build
```

### Check on it

```bash
docker compose ps
```

```bash
docker compose logs -f
```

If `docker compose` says a variable is missing, set it in `.env`.

## Security

For a trusted network only.

- The dashboard password and the broker password both cross the network unencrypted.
  Do not forward either port to the internet.
- All staff share one dashboard password, and all watches share one broker account.

## Children's data

The dashboard stores children's names, parents' contact details and when each child
played. Names and contact details stay on the dashboard server and are never sent to
the watches or the broker.

- The data is in the `dashboard-data` Docker volume, unencrypted, so back it up and
  protect it like any other personal data.
- Get a parent's consent before adding a child, and check what your local privacy law
  requires. POPIA applies in South Africa.
- Add TLS before real use, because this data crosses the network unencrypted.
- Never put real names in this repository, including in test data.
