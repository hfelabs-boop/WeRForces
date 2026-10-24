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

## Sign in with OpenID Connect

Instead of handing out keys, people can sign in with your organisation's
identity provider — Keycloak, Microsoft Entra ID, Okta, Auth0, Google or any
other OpenID Connect provider. Their role comes from a claim in their ID token,
usually a group.

1. Register a client (an "application") at the provider:
   - type: web application, *authorization code* flow; PKCE (S256) is always
     used, so a public client without a secret works too;
   - redirect URI: `https://sim.example.org/auth/callback` (your server's public
     URL plus `/auth/callback`);
   - post-logout redirect URI: `https://sim.example.org/`;
   - make the claim you want to map appear in the ID token. In Keycloak, add a
     *Group Membership* mapper (token claim name `groups`, *full group path*
     off); in Entra ID, set *groups claim* in the token configuration (the
     values are group object ids); in Okta, add a `groups` claim filter.
2. Start WeRForces with the issuer, the client and the role rules:

   ```bash
   export WERFORCES_OIDC_CLIENT_SECRET=...      # confidential clients only
   npm start -- -s calloway-crossroads --host 0.0.0.0 \
     --oidc-issuer https://login.example.org/realms/werforces \
     --oidc-client-id werforces --oidc-public-url https://sim.example.org \
     --oidc-role groups=sim-control:controller \
     --oidc-role groups=blue-cell:blue --oidc-role groups=red-cell:red
   ```

Rules are `claim=value:role` and the first match wins. The claim may be a string
or a list (like `groups`); any claim in the ID token works, e.g.
`email=jo@example.org:controller` or `roles=werforces-red:red`. Users that no
rule matches are refused, unless `--oidc-default-role` gives them one. Add
`--oidc-scope groups` if your provider only sends groups when asked.

What happens:

- A browser without a session is sent to `/auth/login`, then to the provider,
  and comes back to `/auth/callback`. WeRForces exchanges the code (with the PKCE
  verifier), checks the ID token's signature against the provider's published
  keys (RS256/384/512, PS256, ES256/384), its issuer, audience, expiry and nonce,
  and sets an `HttpOnly`, `SameSite=Lax` session cookie (`Secure` over HTTPS)
  that lasts 12 hours.
- The toolbar shows who is signed in; clicking the name signs out, here and
  at the provider.
- API keys keep working next to sign-in: `--api-key` for scripts and MCP
  clients, `--player` for anyone without an account.
- Sessions are kept in memory: restarting the server signs everyone out.

Behind a reverse proxy, set `--oidc-public-url` (or forward `X-Forwarded-Proto`
and `Host`) so the redirect URI matches the one registered.

## Several exercises on one server

Exercise control can run up to **8 sessions** side by side, each with its own
scenario, clock, recording and connected clients:

- **GUI:** File → **Sessions…** lists them, starts a new one (empty or from a
  stored scenario) and opens or ends them. The toolbar pill shows which session
  you are in.
- **REST:** `GET/POST /api/v1/sessions`, `DELETE /api/v1/sessions/{id}`
  ([REST API](reference/rest-api.md#sessions)).

The default session is `main`, at `/`. The others live under `/s/{id}/`: the
GUI at `/s/alpha/`, the API at `/s/alpha/api/v1/…`, the WebSocket at
`/s/alpha/ws` and MCP at `/s/alpha/mcp`. Keys and sign-in apply to all of them;
players see their own force in every session. DIS, Cursor-on-Target and
webhooks are connected to the main session only. Sessions other than `main`
are not kept across a restart: save their scenarios first.

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

Any other reverse proxy works too. It must forward WebSocket upgrades on `/ws` (and `/s/{id}/ws`)
and keep the `Host` header (the server compares a browser's `Origin` with it).
For nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

## DIS in containers

DIS uses UDP broadcast or multicast on the local network, which Docker's default
bridge network does not pass. Run the container with `--network host` (Linux)
and `--dis`, or run WeRForces directly on the host for DIS exercises.

## Sizing

Each session's simulation runs on one core, and each batch job in a worker
thread of its own. The simulation steps in slices of at most 15 ms, so the server keeps
answering requests and the WebSocket keeps streaming even when a big scenario
cannot keep up with its time scale. Then the clock simply runs slower than
asked: `GET /api/v1/simulation` reports `load` (the share of wall time spent
simulating; near 1 means flat out). `npm run bench -- 500 1000 2000` shows what a
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
