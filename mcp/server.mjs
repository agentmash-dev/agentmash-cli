#!/usr/bin/env node
// AgentMash MCP server, as this workspace and the published package name it.
//
// The server itself is hooks/mcp_server.mjs. It needs nothing but Node, so it
// ships with the hooks: both installers commit it into .claude/agentmash/
// beside lib.mjs and the launcher that starts it. This file stays where a
// launcher committed before that looked for the server, in an AgentMash
// checkout and in node_modules/agentmash/mcp/, so those still start the real
// thing, and it is the entry point the tests in mcp/test drive through the MCP
// SDK's own client. cli/mcp/ sits beside cli/hooks/ exactly as mcp/ sits
// beside hooks/, so the import below resolves in the published package too.
//
// Nothing is ever written to stdout except JSON-RPC: that channel is the
// protocol. Diagnostics go to stderr.

import { pathToFileURL } from 'node:url';

import { start } from '../hooks/mcp_server.mjs';

export * from '../hooks/mcp_server.mjs';

// Only run when executed directly; imported, it waits to be started.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((err) => {
    process.stderr.write(`[agentmash-mcp] fatal: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
