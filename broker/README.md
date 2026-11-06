# PlayPulse broker

Mosquitto in Docker, carrying the topics in
[`docs/mqtt-contract.md`](../docs/mqtt-contract.md). It requires a username and
password and publishes port 1883 on the LAN so watches can reach it over Wi-Fi.

This is for development. A deployment uses an existing broker. See the
[project README](../README.md).

## Set the password

Credentials live in `broker/.env`, which must stay out of version control. Create
it once and generate a password:

```bash
cd broker
```

```bash
cp .env.example .env
```

```bash
sed -i "s/^MQTT_PASSWORD=.*/MQTT_PASSWORD=$(openssl rand -hex 16)/" .env
```

To change the password, edit `MQTT_PASSWORD` in `.env` and recreate the container.
The password file inside it is rebuilt from `.env` on each start. Then update
`wristband/secrets.h` to match and reflash the watches, and restart the dashboard.

## Run it

```bash
docker compose up -d --force-recreate
```

```bash
docker compose logs -f
```

```bash
docker compose down
```

Retained messages live in the `broker_mosquitto-data` volume, so they survive a
restart. `docker compose down -v` deletes them.

The container restarts with Docker. Use `docker compose down` to keep it off.

## Check it

With the broker running, this starts its own dashboard and fake watches and runs
through the contract. It uses separate data and clears up after itself:

```bash
cd ../dashboard && npm run verify:mqtt
```

## On the watch

Point the watch at this computer's LAN address, port 1883, using the username and
password from `.env`. The address can change, so a DHCP reservation helps.

## Security

- Traffic and the password are not encrypted, so use this on a trusted network only.
- Every watch and the server share one account, and any client can publish to any
  topic. Per-device accounts and topic rules are needed before real use.
- Docker publishes port 1883 on all interfaces, on any network this computer joins.
  Stop the broker when it isn't needed on an untrusted network.
