# Getting started

## Requirements

- **Node.js 20 or newer** (22 recommended). Check with `node --version`.
- A current desktop browser. The 3D view needs WebGL, which every current
  browser supports.
- Optional: Python 3 for the Python example, and Google Earth or QGIS for the
  GIS feeds.

## Install and build

```bash
git clone https://github.com/hfelabs-boop/WeRForces.git
cd WeRForces
npm install
npm run build
```

`npm run build` compiles the server to `dist/server` and bundles the browser app
into `dist/web`.

## Run

```bash
npm start -- --scenario calloway-crossroads
```

The terminal prints the address:

```
WeRForces running at http://127.0.0.1:8080  (scenario: Calloway Crossroads)
  REST API docs http://127.0.0.1:8080/api/docs  ·  MCP endpoint http://127.0.0.1:8080/mcp
```

Open **http://127.0.0.1:8080** in your browser.

> The `--` after `npm start` passes the remaining options to WeRForces. You can
> also run `node dist/server/cli.js --scenario calloway-crossroads` directly.

## A first look

![The Calloway Crossroads scenario](images/screenshot-2d.png)

1. **Run the clock.** Press **Space** (or ▶ **Run**). Set the multiplier next to
   the clock to **8×**.
2. **Watch.** Blue forces leave the Eastwick area and head for the town of
   Calloway. Apache helicopters (*Gunslinger*) screen the advance and find the
   Russian supply convoy. The **event log** at the bottom reports detections,
   shots, hits and kills.
3. **Inspect.** Click a symbol. The panel on the right shows the selection's
   position, speed, damage, current task or plan, ammunition and what it can
   currently see.
4. **Go 3D.** Click **3D** in the toolbar. Drag to orbit, use the wheel to
   zoom, and double-click a vehicle to fly to it.
5. **Rewind.** ⏮ resets everything to the start of the scenario.

The other bundled scenario is **Lakeside Patrol** (File → Open scenario…).

## What next

- [Tutorial 1: Your first engagement](tutorials/01-first-engagement.md) builds a
  scenario from nothing.
- [User guide](user-guide.md) is a tour of the whole interface.
- [Concepts](concepts.md) explains how the simulation decides what happens.

## Development mode

```bash
npm run dev          # rebuild the web bundle and run the server straight from TypeScript
npm test             # run the test suite
npm run check        # typecheck + tests + build (what CI runs)
```

## Running on another machine or port

```bash
npm start -- --port 9000                          # a different port
npm start -- --host 0.0.0.0 --api-key "$(openssl rand -hex 16)"   # reachable from the LAN, with a key
```

The server only listens on 127.0.0.1 unless you pass `--host`. If you expose it,
always set an API key. See [Command line](reference/cli.md) and
[REST API → Security](reference/rest-api.md#security).

## Docker

```bash
docker build -t werforces .
docker run -p 8080:8080 -e WERFORCES_API_KEY=change-me werforces
```

For HTTPS, `docker compose up -d` puts Caddy in front with automatic
certificates. See [Deployment](deployment.md).
