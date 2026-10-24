# Deployment

How to run WeRForces for more than one person: on a server, in Docker, behind
HTTPS, with separate access for exercise control and each side.

## Access roles

| Key | Option | Sees | Can do |
| --- | --- | --- | --- |
| Exercise control | `--api-key KEY` (or `WERFORCES_API_KEY`) | everything | everything: time, scenarios, creating and moving objects, AAR, integrations |
| Player | `--player blue:KEY` (also `red`, `neutral`; repeatable) | own force, plus its current contacts | order and rename its own entities and units, draw its own graphics |

Without any key, everyone is exercise control, which is right for one person on
their own machine (the server only listens on 127.0.0.1 by default). With
player keys, `--api-key` is required and every request must carry a key. See
[Concepts → Fog of war and roles](concepts.md#fog-of-war-and-roles).

```bash
npm start -- -s calloway-crossroads --host 0.0.0.0 \
  --api-key "$CONTROL_KEY" --player blue:"$BLUE_KEY" --player red:"$RED_KEY"
```

Players open `https://host/?api_key=BLUE_KEY`. MCP clients and REST scripts
use their key the same way (`Authorization: Bearer …`), and get the same
limited view.

## Docker

The image runs the server as an unprivileged user on port 8080, listening on
all interfaces, with the sample scenarios, the sample terrain and the docs:

```bash
docker build -t werforces .
docker run -d -p 8080:8080 -e WERFORCES_API_KEY=change-me werforces
docker run -d -p 8080:8080 -e WERFORCES_API_KEY=change-me werforces \
  --scenario calloway-crossroads --player blue:bk --player red:rk     # extra options go after the image
```

Mount volumes on `/app/scenarios` and `/app/recordings` to keep saved scenarios
and recordings, and on `/app/terrains` to add terrain datasets.

## HTTPS with Docker Compose

`docker-compose.yml` runs the simulator behind [Caddy](https://caddyserver.com),
which terminates TLS (including the WebSocket) and redirects HTTP to HTTPS:

```bash
# A public host name: Caddy gets a Let's Encrypt certificate automatically.
WERFORCES_DOMAIN=sim.example.org WERFORCES_API_KEY=$(openssl rand -hex 16) docker compose up -d

# Just this machine: https://localhost with Caddy's own local certificate authority.
WERFORCES_API_KEY=$(openssl rand -hex 16) docker compose up -d
```

For a public name, point its DNS at the host and open ports 80 and 443. The
proxy configuration is `deploy/Caddyfile`. To pass options such as player keys,
uncomment `command:` in `docker-compose.yml`.

Any other reverse proxy works too. It must forward WebSocket upgrades on `/ws`
and keep the `Host` header (the server compares a browser's `Origin` with it).
For nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}
```

## DIS in containers

DIS uses UDP broadcast or multicast on the local network, which Docker's default
bridge network does not pass. Run the container with `--network host` (Linux)
and `--dis`, or run WeRForces directly on the host for DIS exercises.

## Sizing

The simulation runs on one core. `npm run bench -- 500 1000 2000` shows what a
machine can do; on a typical laptop core:

| Entities | Real-time factor |
| --- | --- |
| 100 | ~300× |
| 500 | ~50× |
| 1000 | ~20× |
| 2000 | ~6× |

Memory is dominated by the recording: about 32 bytes per entity per recorded
second, capped at 256 MB (the frame rate halves when the cap is reached).
`--record-interval 5` records every 5 s instead; `0` turns it off.
