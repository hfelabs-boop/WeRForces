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
| `--api-key <key>` | `$WERFORCES_API_KEY` | Require a key on `/api/*`, `/ws` and `/mcp` |
| `--cors <origin>` | none | Allow browser access from another origin (`*` for any). Repeatable |
| `--cot <url>` | off | Stream Cursor-on-Target to `udp://host:port` or `tcp://host:port` |
| `--cot-interval <s>` | `2` | Seconds between CoT reports |
| `--webhook <url>` | none | POST events to a URL. `hooks.slack.com` and `discord.com/api/webhooks` URLs are formatted for chat. Repeatable |
| `--headless` | off | No web server. Runs in real time and prints events to the terminal |
| `--duration <s>` | – | With `--headless`: simulate this many seconds as fast as possible, print a summary and exit |
| `-h, --help` | | Show help |

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `WERFORCES_API_KEY` | server, MCP bridge, examples | API key |
| `WERFORCES_URL` | MCP bridge, examples | Server URL (default `http://127.0.0.1:8080`) |

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

# Batch: simulate 50 minutes and print the result
npm start -- -s calloway-crossroads --headless --duration 3000
```

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
