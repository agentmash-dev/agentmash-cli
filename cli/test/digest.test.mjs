// `npx agentmash digest`: the digest the package carries, run on the room the
// CLI finds. What these tests pin: a room key is read with this machine's
// sign-in beside it only on the server it signed in to; a checkout with
// nothing committed is read by the ref its GitHub repository's room has,
// with the sign-in; with neither there is no room to read, said before
// anything is sent; and nothing of the room is ever in a URL.
//
// The server is a stand-in on port 0; every run has a home of its own.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digestSourceDir } from '../digest.mjs';

const CLI_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(CLI_DIR, 'agentmash.mjs');
const KEY = 'mash_digestclidigestclidig';
const REF = 'rm_0a1b2c3d4e';
const SIGN_IN = 'amu_digestcliamudigestcliamu';
const NOW = Date.parse('2026-08-31T18:00:00Z');
const HOUR = 3_600_000;

// an empty global git config, so every git call stays inside the temporary repositories
const EMPTY_GITCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-digest-git-')), 'gitconfig');
fs.writeFileSync(EMPTY_GITCONFIG, '');
const baseEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTMASH_') && k !== 'NO_COLOR')),
  GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  NO_COLOR: '1',
  // the fixture week is fixed, so "--since 7d" is the same seven days on any date
  AGENTMASH_DIGEST_NOW: String(NOW),
};

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

let id = 1;
const edit = (developer, file, ts) => ({
  id: id++,
  developer,
  session_id: `${developer}-s`,
  event_type: 'edit',
  tool: 'Edit',
  file_path: file,
  dir_path: file.slice(0, file.lastIndexOf('/')),
  git_branch: 'main',
  task_hint: null,
  change_summary: null,
  ts,
});
const EVENTS = [
  edit('alice', 'src/billing.ts', NOW - 30 * HOUR),
  edit('bob', 'src/billing.ts', NOW - 29 * HOUR),
  edit('alice', 'src/billing.ts', NOW - 28 * HOUR),
  edit('bob', 'src/billing.ts', NOW - 27 * HOUR),
];

/**
 * The coordination server: /events for the room by its key or by its ref with
 * the sign-in, /api/lookup for acme/api, /rooms/self for the key. `seen` has
 * every request's URL with the room and sign-in headers it carried.
 */
function startServer({ connected = true } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const room = req.headers['x-agentmash-room'] || null;
    const user = req.headers['x-agentmash-user'] || null;
    seen.push({ url: req.url, room, user });
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/lookup') {
      if (user !== SIGN_IN) return send(401, { error: 'sign in', code: 'signed_out' });
      if (!connected || url.searchParams.get('repo') !== 'acme/api') return send(404, { error: 'not connected', code: 'not_connected' });
      return send(200, { repo: 'acme/api', room_ref: REF, label: 'acme-api', developer: 'alice' });
    }
    if (url.pathname === '/rooms/self' && room === KEY) return send(200, { room_ref: REF, label: 'from the key' });
    if (url.pathname === '/events' && (room === KEY || (room === REF && user === SIGN_IN))) {
      return send(200, { room_ref: REF, events: EVENTS, next_cursor: null });
    }
    send(401, { error: 'unknown, expired or missing room key', code: 'room_unauthorized' });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen }));
  });
}

/** A git repository, with a GitHub origin when `origin` is given, and a home that is signed in to `signedIn` when given. */
function setup({ origin, signedIn, config } = {}) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-digest-repo-')));
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore', env: baseEnv });
  if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: repo, stdio: 'ignore', env: baseEnv });
  if (config) {
    fs.mkdirSync(path.join(repo, '.claude', 'agentmash'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'agentmash', 'config.json'), JSON.stringify(config));
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-digest-home-'));
  if (signedIn) {
    fs.mkdirSync(path.join(home, '.agentmash'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agentmash', 'user.json'), JSON.stringify({ url: signedIn, token: SIGN_IN, login: 'alice' }));
  }
  return { repo, home };
}

function run(args, { cwd, home }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'digest', ...args], {
      cwd,
      env: { ...baseEnv, AGENTMASH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const nothingInUrls = (seen) => {
  for (const { url } of seen) {
    for (const secret of [KEY, REF, SIGN_IN]) assert.ok(!url.includes(secret), `nothing of the room in ${url}`);
  }
};

test('the digest runs from the checkout here, and from the copy the package carries', () => {
  assert.equal(digestSourceDir(), path.join(CLI_DIR, '..', 'digest'));
  for (const file of ['src/cli.mjs', 'src/aggregate.mjs', 'src/net.mjs', 'src/render.mjs']) {
    assert.ok(fs.existsSync(path.join(CLI_DIR, 'digest', file)), `sync-hooks.mjs copies digest/${file} into cli/digest/`);
  }
});

test("a committed room key is read with this machine's sign-in beside it, on its own server only", async () => {
  const server = await startServer();
  const config = { url: server.url, room: KEY, label: 'acme-api' };
  const here = setup({ config, signedIn: server.url });
  const result = await run(['--to', 'json'], { cwd: here.repo, home: here.home });
  assert.equal(result.code, 0, result.stderr);
  const model = JSON.parse(result.stdout);
  assert.equal(model.label, 'acme-api');
  assert.equal(model.totals.edits, EVENTS.length);
  const events = server.seen.filter((r) => r.url.startsWith('/events'));
  assert.ok(events.length > 0);
  for (const r of events) assert.deepEqual([r.room, r.user], [KEY, SIGN_IN]);
  nothingInUrls(server.seen);

  // signed in to another server: the sign-in goes nowhere
  server.seen.length = 0;
  const elsewhere = setup({ config, signedIn: 'http://127.0.0.1:1' });
  const alone = await run(['--to', 'json'], { cwd: elsewhere.repo, home: elsewhere.home });
  assert.equal(alone.code, 0, alone.stderr);
  for (const r of server.seen) assert.equal(r.user, null, `no sign-in to ${r.url}`);
});

test("a checkout with nothing committed is read by its repository's room ref, with the sign-in", async () => {
  const server = await startServer();
  const here = setup({ origin: 'https://github.com/acme/api.git', signedIn: server.url });
  const result = await run(['--to', 'json'], { cwd: here.repo, home: here.home });
  assert.equal(result.code, 0, result.stderr);
  const model = JSON.parse(result.stdout);
  assert.equal(model.room, REF);
  assert.equal(model.label, 'acme-api', 'the label the lookup gave');
  assert.equal(model.totals.edits, EVENTS.length);
  assert.ok(server.seen.some((r) => r.url === '/api/lookup?repo=acme%2Fapi' && r.user === SIGN_IN));
  for (const r of server.seen.filter((x) => x.url.startsWith('/events'))) assert.deepEqual([r.room, r.user], [REF, SIGN_IN]);
  nothingInUrls(server.seen);

  const text = await run(['--link'], { cwd: here.repo, home: here.home });
  assert.equal(text.code, 0, text.stderr);
  assert.ok(text.stdout.includes(`${server.url}/r/${REF}`), 'linked by the ref, which hands nobody a key');
});

test('with no room to read it says what would give it one, and exits 2', async () => {
  const server = await startServer({ connected: false });
  const signedOut = setup({ origin: 'https://github.com/acme/api.git' });
  const none = await run(['--to', 'json'], { cwd: signedOut.repo, home: signedOut.home });
  assert.equal(none.code, 2);
  assert.match(none.stderr, /^agentmash digest: no room to read — .*npx agentmash init.*npx agentmash login.*--server and --room/);
  assert.equal(none.stdout, '');

  const unconnected = setup({ origin: 'https://github.com/acme/other.git', signedIn: server.url });
  const notThere = await run(['--to', 'json'], { cwd: unconnected.repo, home: unconnected.home });
  assert.equal(notThere.code, 2);
  assert.match(notThere.stderr, /acme\/other is not connected to a room/);
  assert.ok(!server.seen.some((r) => r.url.startsWith('/events')), 'no events read without a room');

  const otherServer = await run(['--server', 'http://127.0.0.1:1', '--to', 'json'], { cwd: unconnected.repo, home: unconnected.home });
  assert.equal(otherServer.code, 2);
  assert.match(otherServer.stderr, /signed in to http:\/\/127\.0\.0\.1:\d+, not http:\/\/127\.0\.0\.1:1/);

  // a ref opens nothing on its own: signed out, or signed in to another server, it is not sent at all
  server.seen.length = 0;
  for (const home of [signedOut.home, setup({ signedIn: 'http://127.0.0.1:1' }).home]) {
    const byRef = await run(['--server', server.url, '--room', REF, '--to', 'json'], { cwd: signedOut.repo, home });
    assert.equal(byRef.code, 2);
    assert.match(byRef.stderr, new RegExp(`${REF} is a room's ref, which opens it only beside this machine's sign-in to ${server.url.replace(/\./g, '\\.')} — run: npx agentmash login --server`));
  }
  assert.deepEqual(server.seen, []);

  // a usage mistake is said before the room is looked up, so it sends nothing
  server.seen.length = 0;
  const signedIn = setup({ origin: 'https://github.com/acme/api.git', signedIn: server.url });
  const noWebhook = await run(['--to', 'slack'], { cwd: signedIn.repo, home: signedIn.home });
  assert.equal(noWebhook.code, 2);
  assert.match(noWebhook.stderr, /--to slack needs --webhook/);
  assert.deepEqual(server.seen, []);
});

test("--help is the digest's own, under the name it runs by", async () => {
  const here = setup();
  const help = await run(['--help'], { cwd: here.repo, home: here.home });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^  npx agentmash digest \[--since 7d\]/m);
  assert.match(help.stdout, /--include-hints/);
  assert.match(help.stdout, /the room this machine's sign-in finds/);
});
