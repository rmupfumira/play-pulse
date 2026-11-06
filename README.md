# PlayPulse

Time tracking for a play park. Each visitor wears a wristband that counts down
their session. Staff register wristbands and run sessions from a web dashboard.

- [`dashboard/`](dashboard/README.md): the staff web page and API
- [`broker/`](broker/README.md): the Mosquitto MQTT broker the watches connect to
- [`docs/mqtt-contract.md`](docs/mqtt-contract.md): what the watches and server send each other

## Deploy on a server

The server needs Docker with Compose. Run these once:

```bash
git clone https://github.com/rmupfumira/play-pulse.git
```

```bash
cd play-pulse
```

```bash
cp broker/.env.example broker/.env
```

```bash
sed -i "s/^MQTT_PASSWORD=.*/MQTT_PASSWORD=$(openssl rand -hex 16)/" broker/.env
```

```bash
sed -i "s/^DASHBOARD_PASSWORD=.*/DASHBOARD_PASSWORD=$(openssl rand -hex 16)/" broker/.env
```

Start it:

```bash
docker compose up -d --build
```

The dashboard is at `http://<server-address>:4311`. The browser asks for a login:
any username, and `DASHBOARD_PASSWORD` from `broker/.env`. To read it:

```bash
grep DASHBOARD_PASSWORD broker/.env
```

Both containers restart with Docker. Registered wristbands and sessions are kept in
Docker volumes, so they survive restarts and updates.

### Point the watches at it

Each watch needs the server's address and the broker login in `wristband/secrets.h`,
then a reflash:

- `MQTT_URI`: `mqtt://<server-address>:1883`
- `MQTT_USERNAME` and `MQTT_PASSWORD`: the same values as `broker/.env`

Give the server a fixed address, with a DHCP reservation for example, or the
watches lose it when the address changes. Open TCP 1883 and 4311 if the server runs
a firewall.

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

If `playpulse-dashboard` keeps restarting, check that `DASHBOARD_PASSWORD` is set in
`broker/.env`. It refuses to start on the network without one.

## Security

For a trusted network only.

- The dashboard password and the broker password both cross the network unencrypted.
  Do not forward either port to the internet.
- All staff share one dashboard password, and all watches share one broker account.
