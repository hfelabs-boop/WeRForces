# Command line reference

```bash
npm start -- [options]            # after npm run build
node dist/server/cli.js [options] # equivalent
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `-s, --scenario <file\|name>` | empty scenario | A scenario JSON file, or the name of one in `./scenarios` (with or without `.json`) |
| `--catalog <file>` | none | JSON catalog extension: entries replace defaults with the same id, new ids are added. Validated at startup ([Tutorial 9](../tutorials/09-extending-the-catalog.md)) |
| `-p, --port <n>` | `8080` | HTTP/WebSocket port |
| `--host <addr>` | `127.0.0.1` | Interface to listen on. Use `0.0.0.0` for all interfaces (and set `--api-key`) |
| `--run` | off | Start the clock immediately |
| `--time-scale <x>` | `1` | Real-time multiplier, from more than 0 up to 64 |
| `--dis` | off | Enable DIS over UDP |
| `--dis-port <n>` | `3000` | DIS UDP port |
| `--dis-address <addr>` | `255.255.255.255` | Where PDUs are sent: broadcast, a multicast group (224–239.x.x.x, joined automatically) or a unicast host |
| `--exercise <n>` | `1` | DIS exercise id. Only PDUs with this id are accepted |
| `--site <n>`, `--application <n>` | `1`, `3001` | This simulation's DIS address. Each federate needs its own pair |
| `--dis-announce` | off | Act as simulation manager: send Start/Resume and Stop/Freeze PDUs when the clock runs or pauses ([DIS](dis.md#simulation-management)) |
| `--dis-ignore-siman` | off | Ignore other simulation managers' Start/Resume and Stop/Freeze PDUs. By default WeRForces runs and pauses on them |
| `--api-key <key>` | `$WERFORCES_API_KEY` | Require a key on `/api/*`, `/ws` and `/mcp`. Its holder is exercise control: sees and controls everything |
| `--player <force:key>` | none | A player key for a force (`blue`, `red`, `neutral`): fog of war and orders for that force only ([Concepts](../concepts.md#fog-of-war-and-roles)). Needs `--api-key`; keys must differ. Repeatable |
| `--cors <origin>` | none | Allow browser access from another origin (`*` for any). Repeatable |
| `--oidc-issuer <url>` | off | Sign in with OpenID Connect (Keycloak, Entra ID, Okta, Auth0, Google…). Needs `--oidc-client-id` and at least one `--oidc-role` or `--oidc-default-role` ([Deployment](../deployment.md#sign-in-with-openid-connect)) |
| `--oidc-client-id <id>` | – | The client registered at the provider. Its redirect URI is `<public url>/auth/callback` |
| `--oidc-client-secret <s>` | `$WERFORCES_OIDC_CLIENT_SECRET` | For confidential clients. Public clients use PKCE alone |
| `--oidc-public-url <url>` | from the `Host` header | This server's public URL, e.g. `https://sim.example.org`. Set it behind a proxy |
| `--oidc-scope <scope>` | none | Extra scope to request besides `openid profile email`, e.g. `groups`. Repeatable |
| `--oidc-role <rule>` | none | `claim=value:role`: a user whose claim (a string or a list) contains the value gets the role (`controller`, `blue`, `red`, `neutral`). Repeatable; first match wins |
| `--oidc-default-role <role>` | none | Role for signed-in users no rule matches. Without it they are refused |
| `--cot <url>` | off | Stream Cursor-on-Target to `udp://host:port` or `tcp://host:port` |
| `--cot-interval <s>` | `2` | Seconds between CoT reports |
| `--webhook <url>` | none | POST events to a URL. `hooks.slack.com` and `discord.com/api/webhooks` URLs are formatted for chat. Repeatable |
| `--record-interval <s>` | `1` | Simulated seconds between recorded frames for the after-action review. `0` turns recording off |
| `--terrains <dir>` | `./terrains` | Folder of imported terrain datasets ([Terrain import](../terrain-import.md)) |
| `--headless` | off | No web server. Runs in real time and prints events to the terminal |
| `--duration <s>` | – | With `--headless`: simulate this many seconds as fast as possible, print a summary and exit |
| `-h, --help` | | Show help |

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `WERFORCES_API_KEY` | server, MCP bridge, examples | API key |
| `WERFORCES_URL` | MCP bridge, examples | Server URL (default `http://127.0.0.1:8080`) |
| `WERFORCES_OIDC_CLIENT_SECRET` | server | OIDC client secret, instead of `--oidc-client-secret` (keeps it out of the process list) |

## Examples

```bash
# Open a scenario and start it at 4x
npm start -- -s calloway-crossroads --run --time-scale 4

# Join a DIS exercise on the LAN as site 7
npm start -- -s lakeside-patrol --dis --dis-address 192.168.1.255 --exercise 3 --site 7

# Feed ATAK devices on the LAN and post kills to Slack
npm start -- -s calloway-crossroads --cot udp://239.2.3.1:6969 --webhook https://hooks.slack.com/services/XXX/YYY/ZZZ

# Serve to the network with a key
npm start -- --host 0.0.0.0 --api-key "$(openssl rand -hex 16)"

# A two-sided exercise: control plus one key per side
npm start -- -s calloway-crossroads --host 0.0.0.0 --api-key CONTROL --player blue:BLUEKEY --player red:REDKEY

# Sign in with Keycloak: the sim-control group runs the exercise, red-cell plays Red
WERFORCES_OIDC_CLIENT_SECRET=... npm start -- --host 0.0.0.0 \
  --oidc-issuer https://login.example.org/realms/werforces --oidc-client-id werforces \
  --oidc-public-url https://sim.example.org \
  --oidc-role groups=sim-control:controller --oidc-role groups=red-cell:red --oidc-role groups=blue-cell:blue

# Run and pause with the DIS exercise's simulation manager, and announce our own run/pause
npm start -- -s calloway-crossroads --dis --dis-announce

# Batch: simulate 50 minutes and print the result
npm start -- -s calloway-crossroads --headless --duration 3000
```

## Terrain import

```bash
npm run terrain:import -- --dem area.tif [--features area.geojson] --name myarea [options]
node dist/terrain/cli.js ...   # the same, after npm run build (bin: werforces-terrain)
```

| Option | Description |
| --- | --- |
| `--dem <file>` | GeoTIFF elevation model: EPSG:4326 (or NAD83/ETRS89), UTM WGS-84 (EPSG:326xx/327xx) or Web Mercator |
| `--features <file>` | GeoJSON in WGS-84: roads, water, rivers, forest, towns, buildings (OpenStreetMap tags or a `kind` property) |
| `--osm <file.osm>` | OpenStreetMap XML (Export on openstreetmap.org, or JOSM): the same features |
| `--overpass` | Fetch OpenStreetMap features for the extent from the Overpass API |
| `--overpass-url <url>` | Overpass server (default `https://overpass-api.de/api/interpreter`) |
| `--landcover <file>` | Land cover GeoTIFF with ESA WorldCover class codes (EPSG:4326) |
| `--worldcover` | Read land cover for the extent from the public ESA WorldCover 2021 tiles |
| `--name <name>` | Dataset name; scenarios use `"terrain": {"dataset": "<name>"}` |
| `--title <text>` | Display title |
| `--center <lat,lon>` | Centre of the extent (default: the DEM's centre) |
| `--size <m>` | Extent (default: largest square in the DEM, at most 40 km) |
| `--cell <m>` | Grid spacing (default: about the DEM's resolution, at least 20 m; at most 1201 posts a side) |
| `--attribution <text>` | Data credit stored in the dataset |
| `--out <dir>` | Output folder (default `./terrains`) |

See [Terrain import](../terrain-import.md).

## MCP stdio bridge

```bash
node dist/mcp/stdio.js [--url http://127.0.0.1:8080] [--api-key KEY]
```

This speaks MCP over stdin/stdout and forwards to a running server's REST API.
See [Tutorial 5](../tutorials/05-ai-agents-with-mcp.md).

## npm scripts

| Script | Does |
| --- | --- |
| `npm run build` | Compile the server and bundle the web app |
| `npm start` | Run the built server |
| `npm run dev` | Bundle the web app and run the server from TypeScript sources |
| `npm test` | Run the tests |
| `npm run check` | Typecheck + tests + build |
| `npm run scenarios` | Regenerate the sample scenarios |
| `npm run docs:gen` | Regenerate the generated reference pages |
| `npm run mcp` | Run the MCP stdio bridge |
| `npm run e2e` | Browser end-to-end tests (Playwright; build first) |
| `npm run bench -- [n…]` | Wall-clock cost per simulated second for *n* entities (default 100 500 1000) |
| `npm run terrain:import` | Import a real terrain (see above) |
| `npm run golden:update` | Re-record the golden runs after an intended model change ([Testing](../architecture.md#testing)) |
| `npm run hla:build` | Download OHLA and build the HLA bridge ([HLA](../hla.md)) |
