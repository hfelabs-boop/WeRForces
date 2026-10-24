#!/usr/bin/env node
// stdio MCP bridge: lets MCP clients (Claude Desktop, Claude Code, ...) control a running
// WeRForces server.  Usage: werforces-mcp [--url http://127.0.0.1:8080] [--api-key KEY]

import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, httpCaller } from './tools.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.WERFORCES_URL ?? 'http://127.0.0.1:8080' },
    'api-key': { type: 'string', default: process.env.WERFORCES_API_KEY },
  },
});

const server = createMcpServer(httpCaller(values.url!, values['api-key']));
await server.connect(new StdioServerTransport());
// stdout carries the protocol, so diagnostics go to stderr.
console.error(`werforces-mcp connected to ${values.url}`);
