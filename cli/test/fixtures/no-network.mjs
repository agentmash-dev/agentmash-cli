// Preloaded into the CLI by team.test.mjs (node --import). The first attempt to
// reach the network ends the process with exit code 97, so a `crew` command
// that talked to anything, even through a helper that swallows its errors the
// way api() does, fails its test instead of passing quietly.

import net from 'node:net';

function refuse(what) {
  process.stderr.write(`agentmash crew tried to use the network (${what})\n`);
  process.exit(97);
}

globalThis.fetch = () => refuse('fetch');
net.Socket.prototype.connect = () => refuse('socket connect');
