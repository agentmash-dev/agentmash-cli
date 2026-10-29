// `npx agentmash scan`: how often this repository's AI coding agents changed
// the same files, read from its git history on this machine. The scan is its
// own package, agentmash-scan (github.com/agentmash-dev/agentmash-scan); this
// command hands it every word after `scan`, untouched, and gives back its
// exit code:
//
//   npx agentmash scan [path] [--days 90] [--window 24h] [--card] [--share] …
//
// It is not a dependency of this package: agentmash-scan carries a 2.4 MB
// card renderer, and every `npx agentmash login` would download it for a
// command most never run. npx fetches it the first time someone scans,
// pinned to SCAN_PACKAGE's range. A copy this package can resolve (an
// install beside it, or a checkout's node_modules) is run straight away.
//
// npx sets npm_execpath to npm's own npm-cli.js, so the hand-off runs that
// with this node and needs no shell: on Windows npx is npx.cmd, which only a
// shell runs, and a shell would split an argument like
// --agent-bot "example-bot[bot]" by its own rules. Started some other way, the
// npm beside this node is used. AGENTMASH_SCAN_BIN, a path to the scanner's
// cli.js, runs that one instead, for this package's tests.
//
// The scan reads git history only and opens no connection; its card and the
// counts it can offer for the monthly report open in the person's browser.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** The scanner's versions this CLI hands off to. */
export const SCAN_PACKAGE = 'agentmash-scan@^0.1.0';
const MIN_NODE = 20;

/** npm's own command-line entry: the one npx is running under, else the one installed beside this node. */
export function npmCli(env = process.env, execPath = process.execPath) {
  if (env.npm_execpath && /npm-cli\.js$/.test(env.npm_execpath) && fs.existsSync(env.npm_execpath)) return env.npm_execpath;
  const bin = path.dirname(execPath);
  for (const candidate of [
    path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** agentmash-scan's cli.js when this package can resolve it, else null. */
export function localScanner() {
  try {
    const entry = createRequire(import.meta.url).resolve('agentmash-scan');
    const cli = path.join(path.dirname(entry), 'cli.js');
    return fs.existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

/** What to run for these words: [the command, its arguments]. */
export function scanCommand(words, env = process.env) {
  const own = env.AGENTMASH_SCAN_BIN || localScanner();
  if (own) return [process.execPath, [own, ...words]];
  const npm = npmCli(env);
  if (!npm) return null;
  return [process.execPath, [npm, 'exec', '--yes', `--package=${SCAN_PACKAGE}`, '--', 'agentmash-scan', ...words]];
}

export async function cmdScan(words) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE) {
    console.error(`npx agentmash scan needs Node ${MIN_NODE} or newer; this is ${process.versions.node}`);
    process.exitCode = 1;
    return;
  }
  const command = scanCommand(words);
  if (!command) {
    console.error('npm could not be found next to this node, so the scanner cannot be fetched: run npx agentmash-scan instead');
    process.exitCode = 1;
    return;
  }
  const [file, args] = command;
  const code = await new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`could not start the scan: ${err.message}`);
      resolve(1);
    });
    // a scan stopped by Ctrl+C ends this command the same way, as a shell reports it
    child.on('exit', (status, signal) => resolve(status ?? (signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : 1)));
  });
  process.exitCode = code;
}
