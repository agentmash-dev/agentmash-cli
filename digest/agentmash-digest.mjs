#!/usr/bin/env node
// AgentMash digest, from a checkout: node digest/agentmash-digest.mjs, or npm
// run digest. Customers run the same digest as npx agentmash digest, from the
// copy the CLI package carries; the command line is src/cli.mjs, which says
// how it reads the room and posts to a webhook.

import { runDigest } from './src/cli.mjs';

runDigest(process.argv.slice(2));
