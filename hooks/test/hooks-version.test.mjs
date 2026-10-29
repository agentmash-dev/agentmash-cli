// Which hooks a repository runs, and whether anyone is told they are old. A
// repository's committed install always runs, beside a newer one a login put
// on the machine, so lib.mjs says what version it is (HOOKS_VERSION, stamped
// at pack time like the MCP server's), every request it makes says so too,
// and a login's newer hooks tell the person, as the session starts, when the
// committed ones are older than they are.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as lib from '../lib.mjs';
import { HOOKS_DIR, machine, runHook, session } from './fixtures.mjs';

const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, '..', 'cli', 'package.json'), 'utf8')).version;
const STAMP = /^export const HOOKS_VERSION = '([^']*)'; \/\/ agentmash:hooks-version$/m;

/** A committed lib.mjs as a version of the hooks wrote it: `version` stamped, or none (from before the stamp). */
function committedLib(project, version) {
  const dir = path.join(project, '.claude', 'agentmash');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = version ? `export const HOOKS_VERSION = '${version}'; // agentmash:hooks-version\n` : '';
  fs.writeFileSync(path.join(dir, 'lib.mjs'), `${stamp}export function writePrompt() {}\n`);
}

test('lib.mjs says which version of the hooks it is: the CLI package’s own, in this checkout', () => {
  const source = fs.readFileSync(path.join(HOOKS_DIR, 'lib.mjs'), 'utf8');
  assert.equal(STAMP.exec(source)?.[1], PACKAGE_VERSION, 'the line cli/sync-hooks.mjs stamps');
  assert.equal(lib.HOOKS_VERSION, PACKAGE_VERSION);
});

test('every request the hooks make says which version they are', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers['x-agentmash-hooks']);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await lib.httpJson('GET', `${url}/team`, { room: 'mash_x', timeoutMs: 2000 });
    await lib.httpJson('POST', `${url}/events`, { room: 'mash_x', timeoutMs: 2000, body: { event_type: 'prompt' } });
    await lib.httpStatus('GET', `${url}/check`, { room: 'mash_x', timeoutMs: 2000 });
    // and the MCP server's, which asks the room on its own
    const { fetchJson } = await import('../mcp_coordination.mjs');
    await fetchJson({ url, room: 'mash_x', timeoutMs: 2000 }, '/activity');
    assert.deepEqual(seen, [PACKAGE_VERSION, PACKAGE_VERSION, PACKAGE_VERSION, PACKAGE_VERSION]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('beside committed hooks older than these, the session is told to bring them up to date; not beside the same or newer', () => {
  const { project } = machine(9, { committed: true });
  const [major, minor, patch] = PACKAGE_VERSION.split('.').map((n) => Number.parseInt(n, 10));
  const older = patch > 0 ? `${major}.${minor}.${patch - 1}` : minor > 0 ? `${major}.${minor - 1}.9` : `${major - 1}.9.9`;
  const newer = `${major}.${minor}.${patch + 1}`;

  committedLib(project, older);
  const note = lib.staleInstallNote(project);
  assert.match(note, new RegExp(`committed hooks are ${older.replace(/\./g, '\\.')}, older than this machine's \\(${PACKAGE_VERSION.replace(/\./g, '\\.')}\\)`));
  assert.match(note, /`npx agentmash init`, then commit \.claude/);

  committedLib(project, null);
  assert.match(lib.staleInstallNote(project), /committed hooks are from before they said their version, older than this machine's/, 'no stamp is older');

  committedLib(project, PACKAGE_VERSION);
  assert.equal(lib.staleInstallNote(project), null);
  committedLib(project, newer);
  assert.equal(lib.staleInstallNote(project), null, 'newer committed hooks are the ones to run');
  committedLib(project, `${PACKAGE_VERSION}-beta.1`);
  assert.equal(lib.staleInstallNote(project), null, 'a prerelease of the same version is not older');
});

test('a login’s session_start says so as the session starts beside older committed hooks, and not after a compaction', async () => {
  const { env, project } = machine(9, { committed: true });
  committedLib(project, '0.1.0');
  const start = (source) =>
    runHook('session_start.mjs', { session_id: session(), cwd: project, hook_event_name: 'SessionStart', source }, env, ['--global']);
  const started = await start('startup');
  assert.equal(started.code, 0, started.stderr);
  assert.match(JSON.parse(started.stdout).systemMessage, /committed hooks are 0\.1\.0, older than this machine's/);
  const compacted = await start('compact');
  assert.equal(compacted.stdout, '', 'said once, as the session starts');
});
