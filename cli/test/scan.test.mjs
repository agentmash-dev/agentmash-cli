// `npx agentmash scan` hands every word after `scan` to agentmash-scan as it
// is, through npm's own exec and no shell, and gives back the scanner's exit
// code (cli/scan.mjs). AGENTMASH_SCAN_BIN stands a fake scanner in for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { npmCli, SCAN_PACKAGE, scanCommand } from '../scan.mjs';

const CLI = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'agentmash.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-scan-'));
// a scanner that says what it was given, and exits as it was asked to
const fake = path.join(dir, 'fake-scan.mjs');
fs.writeFileSync(fake, 'console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = Number(process.env.FAKE_EXIT ?? 0);\n');
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTMASH_'))),
  AGENTMASH_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-scan-home-')),
  AGENTMASH_SCAN_BIN: fake,
};
const scan = (args, extra = {}) => spawnSync(process.execPath, [CLI, 'scan', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });

test('every word after scan reaches the scanner as it was typed, flags the shared parser does not know among them', () => {
  const words = ['../repo', '--days', '30', '--window=6h', '--agent-bot', 'example-bot[bot]', '--card', '--json'];
  const out = scan(words);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), words);
});

test("the scanner's exit code is the command's", () => {
  assert.equal(scan(['--frobnicate'], { FAKE_EXIT: '2' }).status, 2);
  assert.equal(scan([], { FAKE_EXIT: '1' }).status, 1);
});

test('without a copy of its own it runs the pinned scanner through npm exec, never a shell', () => {
  const npm = path.join(dir, 'npm-cli.js');
  fs.writeFileSync(npm, '');
  const [file, args] = scanCommand(['.', '--card'], { npm_execpath: npm });
  assert.equal(file, process.execPath);
  assert.deepEqual(args, [npm, 'exec', '--yes', `--package=${SCAN_PACKAGE}`, '--', 'agentmash-scan', '.', '--card']);
  assert.match(SCAN_PACKAGE, /^agentmash-scan@\^\d+\.\d+\.\d+$/);
});

test("npm is found beside node when npx didn't start this", () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-node-'));
  const node = path.join(prefix, 'bin', 'node');
  const cli = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, '');
  // a pnpm or yarn npm_execpath is not npm's, so it is passed over
  assert.equal(npmCli({ npm_execpath: '/somewhere/pnpm.cjs' }, node), path.join(prefix, 'bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  assert.equal(npmCli({}, path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-bare-')), 'node')), null);
});

test('--help lists scan', () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], { env, encoding: 'utf8' });
  assert.match(help.stdout, /npx agentmash scan.*\[path\]/);
});
