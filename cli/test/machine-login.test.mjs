// `npx agentmash login`: the one setup a developer does. It signs the machine
// in with GitHub, puts the hooks in the developer's own Claude Code settings
// (never a repository), and `npx agentmash logout` takes them out again. What
// these tests pin: what is written and where, that someone's own settings
// survive both, and that signing in twice leaves one set of hooks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLEARED } from './fixtures/machine.mjs';
import { startGitHub } from './fixtures/github.mjs';

const CLI_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(CLI_DIR, 'agentmash.mjs');
const TOKEN = 'amu_machinetokenmachinetokenxx';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'];
/** The room a checkout that ran `npx agentmash init` carries: its key, committed, and its ref. */
const KEY = 'mash_committedcommittedcommit';
const COMMITTED_REF = 'rm_aaaaaaaaaa';
/** The room the website connected acme/app to, which login and every lookup answer. */
const CONNECTED_REF = 'rm_0123456789';
/** The room `init` makes on this server. */
const NEW_KEY = 'mash_newroomnewroomnewroomnew';
const NEW_REF = 'rm_bbbbbbbbbb';

// init asks GitHub whether a checkout's repository is public before it
// commits a key: a stand-in, which says private, so no test asks the real one
const github = startGitHub();
await github.ready;

// every folder an agent reads from the environment (each module's `env`) is cleared, so login never reaches the developer's own
const baseEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTMASH_') && !CLEARED.includes(k))),
  AGENTMASH_GITHUB_API: github.url,
};

function run(args, { cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code, stdout: stdout.replace(/\x1b\[[0-9;]*m/g, ''), stderr: stderr.replace(/\x1b\[[0-9;]*m/g, '') })
    );
  });
}

/**
 * A server that signs the machine in on the second poll, as if the browser
 * were quick. What it says about the rooms is the test's to change while it
 * runs: `lookup` is which room a repository is connected to (/api/lookup;
 * `fork` on a 404 says GitHub lists it as one, and `can_push` whether the
 * sign-in listed it at all, when set), unless `lookups` says
 * otherwise for that one by name, `self` what the committed key opens
 * (/rooms/self; null for a server from before it), `connectRoom` the
 * answers /api/connect/room gives, in order, before it binds, `whoami`
 * the status /api/whoami answers this machine's token with, `signIn` the
 * answers /auth/cli/token gives, in order, before it signs the machine in,
 * `reauth` whether GitHub has to say again what the machine can push to,
 * `moved` the repositories a sign-in says GitHub knows by another name now,
 * `logout` the status /api/logout answers with, `logoutAll` how many machines
 * it says it signed out for --all (null: a server from before, which says no
 * count), and `signInRooms` whether the server knows rooms that ask for a
 * sign-in: POST /rooms says a new one does not, and POST /rooms/settings
 * turns it on (a server from before says nothing of it).
 */
function startServer() {
  const requests = [];
  let polls = 0;
  const state = {
    lookup: { status: 200, ref: CONNECTED_REF },
    lookups: {},
    self: { room_ref: COMMITTED_REF, label: 'app', token_mode: 'off', repo: null },
    connectRoom: [],
    whoami: 200,
    signIn: [],
    reauth: false,
    moved: null,
    logout: 200,
    start: null,
    signInRooms: false,
    logoutAll: null,
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({
        method: req.method,
        path: url.pathname,
        user: req.headers['x-agentmash-user'],
        room: req.headers['x-agentmash-room'],
        body: body ? JSON.parse(body) : null,
      });
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      const base = `http://127.0.0.1:${server.address().port}`;
      if (url.pathname === '/auth/cli/start') {
        if (state.start) return send(state.start.status, state.start.body);
        return send(201, { code: 'ABCD-EFGH', poll_token: 'poll', verify_url: `${base}/auth/github?cli=ABCD-EFGH`, expires_in: 600 });
      }
      if (url.pathname === '/auth/cli/token') {
        const answer = state.signIn.shift();
        if (answer) return send(answer.status, answer.body);
        polls += 1;
        if (polls < 2) return send(202, { status: 'pending' });
        return send(200, {
          status: 'ready',
          scope: 'user',
          token: TOKEN,
          developer: 'bob',
          source: 'github',
          connected: [{ repo: 'acme/app', room_ref: CONNECTED_REF, label: 'app' }],
          ...(state.moved ? { moved: state.moved } : {}),
        });
      }
      if (url.pathname === '/api/whoami') {
        if (state.whoami !== 200) return send(state.whoami, { error: 'sign in on this machine: npx agentmash login', code: 'signed_out' });
        if (state.reauth) return send(200, { login: 'bob', reauth: true, connected: [] });
        return send(200, { login: 'bob', connected: [{ repo: 'acme/app', room_ref: CONNECTED_REF }] });
      }
      if (url.pathname === '/api/lookup' && state.reauth) {
        return send(401, { error: 'GitHub has to say again what bob can push to: sign in again (npx agentmash login)', code: 'reauth' });
      }
      if (url.pathname === '/api/lookup') {
        const asked = url.searchParams.get('repo');
        const answer = state.lookups[asked] ?? state.lookup;
        if (answer.status !== 200) {
          return send(answer.status, {
            error: 'not connected',
            code: 'not_connected',
            ...(answer.fork ? { fork: true } : {}),
            ...(typeof answer.can_push === 'boolean' ? { can_push: answer.can_push } : {}),
          });
        }
        return send(200, { repo: asked, room_ref: answer.ref, developer: 'bob', dashboard_url: `${base}/r/${answer.ref}` });
      }
      if (url.pathname === '/api/logout') {
        if (state.logout !== 200) return send(state.logout, { error: 'failed' });
        const all = body ? JSON.parse(body).all === true : false;
        return send(200, all && typeof state.logoutAll === 'number' ? { ok: true, revoked: state.logoutAll } : { ok: true });
      }
      if (url.pathname === '/api/config') return send(200, { oauth: true, closed: false, github_client_id: 'cfgid' });
      if (url.pathname === '/healthz') return send(200, { ok: true });
      if (url.pathname === '/rooms/self') {
        if (state.self?.status) return send(state.self.status, state.self.body);
        return state.self ? send(200, state.self) : send(404, { error: 'not here' });
      }
      if (url.pathname === '/activity') return send(200, { sessions: [], hot_files: [] });
      if (url.pathname === '/rooms' && req.method === 'POST') {
        return send(201, {
          room: NEW_KEY,
          room_ref: NEW_REF,
          label: 'app',
          server_url: base,
          dashboard_url: `${base}/r/${NEW_KEY}`,
          ...(state.signInRooms ? { sign_in_required: false } : {}),
        });
      }
      if (url.pathname === '/rooms/settings' && req.method === 'POST') {
        const asked = body ? JSON.parse(body) : {};
        return send(200, { token_mode: 'off', ...(state.signInRooms ? { sign_in_required: asked.sign_in_required === true } : {}) });
      }
      if (url.pathname === '/api/connect/room') {
        const answer = state.connectRoom.shift();
        if (answer) return send(answer.status, answer.body);
        const ref = req.headers['x-agentmash-room'] === NEW_KEY ? NEW_REF : COMMITTED_REF;
        return send(200, { ok: true, repo: 'acme/app', room_ref: ref, label: 'app', already: false, dashboard_url: `${base}/r/${ref}` });
      }
      return send(404, { error: 'not here' });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, state, close: () => new Promise((r) => server.close(r)) })
    )
  );
}

function machine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-machine-'));
  const claude = path.join(home, 'claude');
  fs.mkdirSync(claude);
  // someone's own settings, which must come through untouched
  fs.writeFileSync(
    path.join(claude, 'settings.json'),
    JSON.stringify({
      model: 'opus',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
    })
  );
  // A home of its own for the other agents too, with none of their commands
  // on the tool path: login must never reach the real ~/.codex or ~/.cursor.
  return {
    home,
    claude,
    env: {
      AGENTMASH_HOME: home,
      CLAUDE_CONFIG_DIR: claude,
      HOME: home,
      USERPROFILE: home,
      AGENTMASH_TOOL_PATH: '',
      AGENTMASH_APPS_DIR: path.join(home, 'Applications'),
      // where Amp, OpenCode, Kilo Code, Crush and VS Code keep their settings off macOS: a CI runner sets its own
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
    },
  };
}

/** `m` signed in to `url`, as `npx agentmash login` leaves it, without the browser. */
function signIn(m, url, token = TOKEN) {
  fs.mkdirSync(path.join(m.home, '.agentmash'), { recursive: true });
  fs.writeFileSync(path.join(m.home, '.agentmash', 'user.json'), JSON.stringify({ url, token, login: 'bob' }));
}

/**
 * A checkout of acme/app, its origin plain GitHub unless `remotes` says what
 * they are. With `committed`, it ran `npx agentmash init` long ago, against
 * `committed`: the room's key is in .claude/agentmash/config.json.
 */
function checkout({ committed = null, remotes = [['origin', 'git@github.com:acme/app.git']] } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-machine-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  for (const [name, url] of remotes) execFileSync('git', ['remote', 'add', name, url], { cwd: repo, stdio: 'ignore' });
  if (committed) {
    fs.mkdirSync(path.join(repo, '.claude', 'agentmash'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.claude', 'agentmash', 'config.json'),
      JSON.stringify({ url: committed, room: KEY, room_ref: COMMITTED_REF, label: 'app' }, null, 2)
    );
  }
  return repo;
}

const settingsOf = (m) => JSON.parse(fs.readFileSync(path.join(m.claude, 'settings.json'), 'utf8'));
const ours = (entries) =>
  (entries ?? []).filter((e) => e.hooks.some((h) => (h.args ?? []).some((a) => /\.agentmash[\\/]hooks/.test(a))));

test('login signs the machine in and puts the hooks in Claude Code for every repository', async () => {
  const server = await startServer();
  const m = machine();
  try {
    // in no checkout: there is no repository to ask GitHub after
    const result = await run(['login', '--server', server.url, '--no-open'], { cwd: m.home, env: m.env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /sign in with GitHub/);
    assert.match(result.stdout, /auth\/github\?cli=ABCD-EFGH/);
    // the browser issues nothing until the code the terminal shows is typed there
    assert.match(result.stdout, /type this code in your browser: ABCD-EFGH/);
    assert.match(result.stdout, /signed in as bob/);
    assert.match(result.stdout, /acme\/app/);
    assert.match(result.stdout, /restart any Claude Code session/);
    // what leaves the machine, said to whoever signs in, whichever agents they use
    const { PROMPT_CHARS } = await import(pathToFileURL(path.join(CLI_DIR, '..', 'hooks', 'lib.mjs')).href);
    assert.match(
      result.stdout,
      new RegExp(
        `what your agents send to a connected repository's room: the first ${PROMPT_CHARS} characters of each prompt, and the names\\n\\s+` +
          'of the files and functions changed, which your teammates and their agents see\\. AGENTMASH_HINTS=0 keeps your prompts here\\.'
      )
    );
    assert.deepEqual(server.requests[0].body, { global: true, alias: os.userInfo().username });

    const login = JSON.parse(fs.readFileSync(path.join(m.home, '.agentmash', 'user.json'), 'utf8'));
    assert.equal(login.token, TOKEN);
    assert.equal(login.url, server.url);
    assert.equal(login.login, 'bob');

    for (const file of ['lib.mjs', 'user_prompt_submit.mjs', 'prompt_note.mjs', 'session_start.mjs', 'pre_tool_use.mjs', 'post_tool_use.mjs', 'stop.mjs', 'session_end.mjs']) {
      assert.ok(fs.existsSync(path.join(m.home, '.agentmash', 'hooks', file)), file);
    }
    // The MCP server too, registered nowhere: a repository's launcher starts
    // this copy when it is newer than the one committed beside it.
    for (const file of ['mcp_server.mjs', 'mcp_coordination.mjs', 'mcp_render.mjs']) {
      assert.ok(fs.existsSync(path.join(m.home, '.agentmash', 'hooks', file)), file);
    }
    assert.ok(!fs.existsSync(path.join(m.home, '.agentmash', 'hooks', 'mcp_launcher.mjs')), 'and no launcher: a login registers no server');

    const settings = settingsOf(m);
    assert.equal(settings.model, 'opus', 'the rest of the settings are left as they were');
    assert.deepEqual(settings.hooks.PreToolUse[0].hooks[0].command, 'echo mine', 'and so are their own hooks');
    for (const event of EVENTS) {
      const [entry] = ours(settings.hooks[event]);
      assert.ok(entry, event);
      for (const hook of entry.hooks) {
        assert.equal(hook.command, 'node');
        assert.equal(hook.args[1], '--global');
        assert.ok(fs.existsSync(hook.args[0]), `${event} runs a script that is there`);
      }
    }
    // Claude Code waits on every prompt hook that is not async: the report
    // runs in the background, and only the heads-up in line, and quickly
    const prompts = ours(settings.hooks.UserPromptSubmit)[0].hooks.map((h) => [path.basename(h.args[0]), h.async, h.timeout]);
    assert.deepEqual(prompts, [
      ['user_prompt_submit.mjs', true, 5],
      ['prompt_note.mjs', undefined, 3],
    ]);
    assert.equal(ours(settings.hooks.SessionStart)[0].hooks[0].async, undefined, 'the session start answers too');
    assert.equal(ours(settings.hooks.PostToolUse)[0].hooks[0].async, true);
    assert.equal(ours(settings.hooks.PreToolUse)[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit|write|edit|apply_patch|Bash|PowerShell');
    assert.equal(ours(settings.hooks.PostToolUse)[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit|write|edit|apply_patch|Bash|PowerShell');
    assert.ok(fs.existsSync(path.join(m.claude, 'settings.json.before-agentmash')), 'what was there is kept, once');

    // signing in again replaces the hooks rather than adding a second set
    const again = await run(['login', '--server', server.url, '--no-open'], { env: m.env });
    assert.equal(again.code, 0, again.stderr);
    for (const event of EVENTS) assert.equal(ours(settingsOf(m).hooks[event]).length, 1, event);
  } finally {
    await server.close();
  }
});

// POST /auth/cli/start answers 429 past its limits (too many from one
// address, or too many waiting), and login said the server might be older
// than the CLI, leaving out what the server said.
test('login turned away for too many sign-ins says what the server said, and nothing about its age', async () => {
  const server = await startServer();
  const m = machine();
  try {
    server.state.start = { status: 429, body: { error: 'too many sign-ins started from this address; try again in an hour', code: 'rate_limited' } };
    const result = await run(['login', '--server', server.url, '--no-open'], { cwd: m.home, env: m.env });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /too many sign-ins started from this address; try again in an hour/);
    assert.doesNotMatch(result.stderr + result.stdout, /older than this CLI/);
    assert.ok(!fs.existsSync(path.join(m.home, '.agentmash', 'user.json')), 'and signs nothing in');
  } finally {
    await server.close();
  }
});

test('status says who this machine is and whether this checkout is connected', async () => {
  const server = await startServer();
  const m = machine();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-machine-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: repo, stdio: 'ignore' });
  try {
    const before = await run(['status'], { cwd: repo, env: m.env });
    assert.match(before.stdout, /not signed in — run: npx agentmash login/);

    await run(['login', '--server', server.url, '--no-open'], { env: m.env });
    const after = await run(['status'], { cwd: repo, env: m.env });
    assert.equal(after.code, 0, after.stderr);
    assert.match(after.stdout, /signed in as bob/);
    assert.match(after.stdout, /✓ coding agents connected: Claude Code\n/);
    assert.match(after.stdout, /acme\/app is connected/);
    assert.doesNotMatch(after.stdout, /never reached the room/);

    // what the hooks log on this machine when a report does not arrive
    const log = path.join(m.home, '.agentmash', 'log', 'reports.jsonl');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(
      log,
      JSON.stringify({
        at: new Date(Date.now() - 5 * 60_000).toISOString(),
        hook: 'post_tool_use',
        event_type: 'edit',
        repo,
        url: server.url,
        outcome: 'refused',
        status: 401,
        code: 'room_unauthorized',
      }) + '\n'
    );
    const failing = await run(['status'], { cwd: repo, env: m.env });
    assert.match(failing.stdout, /1 report from this machine never reached the room in the last 24 hours/);
  } finally {
    await server.close();
  }
});

// A key committed to a public repository opens its room only beside the
// sign-in of someone who can push there (the server's room_key_public), so
// whatever the CLI asks with a committed key carries this machine's sign-in.

test('a committed key goes to its server with this machine\'s sign-in beside it, and to no other server', async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout({ committed: server.url });
  try {
    signIn(m, server.url);
    const status = await run(['status'], { cwd: repo, env: m.env });
    assert.equal(status.code, 0, status.stderr);
    const keyed = server.requests.filter((r) => r.room === KEY);
    assert.ok(keyed.length > 0, 'the committed key was used');
    for (const r of keyed) assert.equal(r.user, TOKEN, `${r.path}: the sign-in beside it`);

    signIn(m, 'https://agentmash.example');
    const before = server.requests.length;
    await run(['status'], { cwd: repo, env: m.env });
    const alone = server.requests.slice(before).filter((r) => r.room === KEY);
    assert.ok(alone.length > 0);
    for (const r of alone) assert.equal(r.user, undefined, `${r.path}: signed in elsewhere, the key goes alone`);
  } finally {
    await server.close();
  }
});

test('doctor says a key from a public repository needs a sign-in, and which', async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout({ committed: server.url });
  server.state.self = {
    status: 403,
    body: { error: 'acme/app is public on GitHub', code: 'room_key_public', repo: 'acme/app' },
  };
  try {
    const doctor = await run(['doctor'], { cwd: repo, env: m.env });
    assert.match(doctor.stdout, /the room key is in acme\/app, which is public on GitHub, so the key alone no longer opens the room/);
    assert.match(doctor.stdout, /npx agentmash login/);
    assert.doesNotMatch(doctor.stdout, /room check failed/);

    // signed in already, to another server than the one the checkout reports to: logging in again changes nothing
    signIn(m, 'https://agentmash.example');
    const elsewhere = await run(['doctor'], { cwd: repo, env: m.env });
    assert.ok(
      elsewhere.stdout.includes(`this machine is signed in to https://agentmash.example, and the room is on ${server.url}: npx agentmash login --server ${server.url}`),
      elsewhere.stdout
    );
    fs.rmSync(path.join(m.home, '.agentmash', 'user.json'));

    // beside a sign-in too old for the server to say who can push
    server.state.self = { status: 401, body: { error: 'GitHub has to say again what bob can push to', code: 'reauth' } };
    const stale = await run(['doctor'], { cwd: repo, env: m.env });
    assert.match(stale.stdout, /GitHub has to say again what this machine can push to: npx agentmash login/);
    assert.doesNotMatch(stale.stdout, /room check failed/);
  } finally {
    await server.close();
  }
});

// The git client in a checkout connected on the website reports nothing when
// its worker is from before it looked the room up, or when a linked worktree
// shares the hook and has no worker: doctor says so, and git-hook install,
// which fixes both.
test('doctor says when the git client in a checkout connected on the website reports nothing', async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout();
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=bob', '-c', 'user.email=bob@example.com', ...args], { cwd, stdio: 'ignore' });
  try {
    signIn(m, server.url);
    // what git-hook install left there before its worker looked a room up
    fs.mkdirSync(path.join(repo, '.claude', 'agentmash'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'agentmash', 'git_post_commit.mjs'), '// a worker that reads config.json alone\n');
    fs.writeFileSync(path.join(repo, '.claude', 'agentmash', 'lib.mjs'), '// its lib\n');
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# agentmash-git-hook — installed by `agentmash git-hook install`.\n');
    const stale = await run(['doctor'], { cwd: repo, env: m.env });
    assert.match(stale.stdout, /acme\/app is connected/);
    assert.match(stale.stdout, /the git client in this checkout is from an older agentmash, which reports nothing in a repository connected on the website — run: npx agentmash git-hook install/);

    const installed = await run(['git-hook', 'install'], { cwd: repo, env: m.env });
    assert.equal(installed.code, 0, installed.stderr);
    const fixed = await run(['doctor'], { cwd: repo, env: m.env });
    assert.doesNotMatch(fixed.stdout, /git client/);

    // a linked worktree: the hook is the repository's, the worker isn't there
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.claude/\n');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const tree = `${repo}-feature`;
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', tree);
    const shared = await run(['doctor'], { cwd: tree, env: m.env });
    assert.match(shared.stdout, /the git client's hook is installed in this repository, but its worker isn't in this checkout, so commits made here by hand reach no one — run: npx agentmash git-hook install/);
    assert.equal((await run(['git-hook', 'install'], { cwd: tree, env: m.env })).code, 0);
    assert.doesNotMatch((await run(['doctor'], { cwd: tree, env: m.env })).stdout, /git client/);
  } finally {
    await server.close();
  }
});

test('logout signs the machine out and takes only its own hooks back out', async () => {
  const server = await startServer();
  const m = machine();
  try {
    await run(['login', '--server', server.url, '--no-open'], { env: m.env });
    const out = await run(['logout'], { env: m.env });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /signed out bob/);
    assert.ok(server.requests.some((r) => r.path === '/api/logout' && r.user === TOKEN), 'the server forgets the token too');

    assert.ok(!fs.existsSync(path.join(m.home, '.agentmash', 'user.json')));
    assert.ok(!fs.existsSync(path.join(m.home, '.agentmash', 'hooks')));
    const settings = settingsOf(m);
    assert.equal(settings.model, 'opus');
    assert.deepEqual(Object.keys(settings.hooks), ['PreToolUse'], 'only their own hook is left');
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
  } finally {
    await server.close();
  }
});

// Every `npx agentmash login` is a machine signed in, and there was no way to
// end them all at once. --all asks the server to sign out every machine
// signed in as this login; a server from before signs out this one alone,
// and says no count, which logout says plainly rather than claiming the rest.
test('logout --all signs out every machine signed in as you, and says so; a server from before signs out this one alone', async () => {
  const server = await startServer();
  const m = machine();
  try {
    assert.equal((await run(['login', '--server', server.url, '--no-open'], { cwd: m.home, env: m.env })).code, 0);
    server.state.logoutAll = 3;
    const out = await run(['logout', '--all'], { cwd: m.home, env: m.env });
    assert.equal(out.code, 0, out.stderr);
    const asked = server.requests.filter((r) => r.path === '/api/logout');
    assert.deepEqual(asked.map((r) => [r.user, r.body]), [[TOKEN, { all: true }]]);
    assert.match(out.stdout, /signed out 3 machines signed in as bob, this one with them/);
    assert.ok(!fs.existsSync(path.join(m.home, '.agentmash', 'user.json')));

    // a bare logout asks for this machine alone, as it always did
    assert.equal((await run(['login', '--server', server.url, '--no-open'], { cwd: m.home, env: m.env })).code, 0);
    assert.equal((await run(['logout'], { cwd: m.home, env: m.env })).code, 0);
    assert.equal(server.requests.filter((r) => r.path === '/api/logout').at(-1).body, null);

    // a server from before --all
    server.state.logoutAll = null;
    assert.equal((await run(['login', '--server', server.url, '--no-open'], { cwd: m.home, env: m.env })).code, 0);
    const older = await run(['logout', '--all'], { cwd: m.home, env: m.env });
    assert.equal(older.code, 1, older.stdout);
    assert.match(older.stdout, /signed out bob/);
    assert.match(older.stdout, /signs out one machine at a time: every other machine signed in as bob still is, until npx agentmash logout runs on it/);
  } finally {
    await server.close();
  }
});

test('logout refuses a word it does not take, and signs nothing out', async () => {
  const server = await startServer();
  const m = machine();
  try {
    // run from a folder that is no repository: the one the tests run from carries a room of its own
    assert.equal((await run(['login', '--server', server.url, '--no-open'], { cwd: m.home, env: m.env })).code, 0);
    const before = fs.readFileSync(path.join(m.claude, 'settings.json'), 'utf8');
    const asked = server.requests.length;
    const refused = await run(['logout', 'everything'], { cwd: m.home, env: m.env });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /unexpected "everything" after logout, which takes no words: nothing was done/);
    assert.ok(fs.existsSync(path.join(m.home, '.agentmash', 'user.json')), 'still signed in');
    assert.equal(fs.readFileSync(path.join(m.claude, 'settings.json'), 'utf8'), before, 'the hooks are where login put them');
    assert.ok(!server.requests.slice(asked).some((r) => r.path === '/api/logout'), 'the sign-in is still live on the server');
  } finally {
    await server.close();
  }
});

// A machine's sign-in has no end date: the server forgetting it is what ends
// it. Signed out while the server could not be reached, it went on working
// there, and the one copy of it was gone from the machine, so nothing could
// end it any more.
test('logout the server does not confirm says the sign-in still works there, and keeps it for the next logout', async () => {
  const server = await startServer();
  const m = machine();
  const userFile = path.join(m.home, '.agentmash', 'user.json');
  try {
    assert.equal((await run(['login', '--server', server.url, '--no-open'], { env: m.env })).code, 0);
    await server.close();
    const offline = await run(['logout'], { env: m.env });
    assert.equal(offline.code, 1, offline.stdout + offline.stderr);
    assert.doesNotMatch(offline.stdout, /signed out bob/);
    assert.match(offline.stdout, /✓ took agentmash out of every agent on this machine/);
    assert.match(offline.stdout, /✗ could not reach http:\/\/127\.0\.0\.1:\d+ to sign bob out there, so the sign-in still works on that server/);
    assert.match(offline.stdout, /run npx agentmash logout again once it answers/);
    assert.ok(fs.existsSync(userFile), 'kept, so the next logout can end it');
    assert.ok(!fs.existsSync(path.join(m.home, '.agentmash', 'hooks')), 'and agentmash is out of every agent all the same');
    assert.deepEqual(ours(settingsOf(m).hooks?.PreToolUse), []);

    // a server that answers, and fails to forget it, has not ended it either
    const failing = await startServer();
    failing.state.logout = 500;
    signIn(m, failing.url);
    const refused = await run(['logout'], { env: m.env });
    assert.equal(refused.code, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /✗ http:\/\/127\.0\.0\.1:\d+ answered HTTP 500 when asked to sign bob out, so the sign-in may still work on that server/);
    assert.ok(fs.existsSync(userFile));
    await failing.close();

    // back: the next logout ends it there, and here
    const back = await startServer();
    signIn(m, back.url);
    const again = await run(['logout'], { env: m.env });
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /signed out bob/);
    assert.ok(back.requests.some((r) => r.path === '/api/logout' && r.user === TOKEN));
    assert.ok(!fs.existsSync(userFile));
    await back.close();
  } finally {
    await server.close().catch(() => {});
  }
});

// `login --room` keeps a developer token per room in credentials.json, and a
// committed install's hooks sign every edit in that room with it. Logout left
// it there, said "nothing was signed in", and the next edit was still signed
// as the person who had signed out.
test('logout takes the developer tokens login --room kept off the machine too', async () => {
  const m = machine();
  const file = path.join(m.home, '.agentmash', 'credentials.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      tokens: { 'http://127.0.0.1:9|rm_aaaaaaaaaa': { token: 'amt_roomtokenroomtokenroomtok', developer: 'bob', source: 'github' } },
    })
  );
  const out = await run(['logout'], { env: m.env });
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.doesNotMatch(out.stdout, /nothing was signed in/);
  assert.match(out.stdout, /✓ removed the developer token npx agentmash login --room kept for 1 room/);
  assert.ok(!fs.existsSync(file), 'the next edit is signed as nobody');

  // and with none kept, there is nothing to say about them
  const again = await run(['logout'], { env: m.env });
  assert.match(again.stdout, /nothing was signed in/);
  assert.doesNotMatch(again.stdout, /developer token/);
});

// The backup is what was in Claude Code's settings before agentmash, kept the
// first time it writes there. On a machine with no settings file, login made
// one, and the next write, logout's, kept that one: agentmash's own hooks,
// as what was there before agentmash.
test('the settings backup never holds agentmash: a machine that had no settings file keeps none', async () => {
  const server = await startServer();
  const m = machine();
  const file = path.join(m.claude, 'settings.json');
  const backup = `${file}.before-agentmash`;
  fs.rmSync(file);
  try {
    assert.equal((await run(['login', '--server', server.url, '--no-open'], { env: m.env })).code, 0);
    assert.ok(!fs.existsSync(backup), 'there was nothing before');
    // a setting of the person's own, added since, is in the file logout writes back
    fs.writeFileSync(file, JSON.stringify({ ...settingsOf(m), model: 'opus' }));
    const out = await run(['logout'], { env: m.env });
    assert.equal(out.code, 0, out.stdout + out.stderr);
    assert.deepEqual(settingsOf(m), { model: 'opus' });
    assert.ok(!fs.existsSync(backup), 'and logout keeps no copy of what login wrote');

    // with the person's settings there first, they are what is kept, once
    assert.equal((await run(['login', '--server', server.url, '--no-open'], { env: m.env })).code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')), { model: 'opus' });
  } finally {
    await server.close();
  }
});

test('a settings file that is not JSON is never overwritten', async () => {
  const server = await startServer();
  const m = machine();
  fs.writeFileSync(path.join(m.claude, 'settings.json'), '{ this is not json');
  try {
    const result = await run(['login', '--server', server.url, '--no-open'], { env: m.env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /is not valid JSON/);
    assert.equal(fs.readFileSync(path.join(m.claude, 'settings.json'), 'utf8'), '{ this is not json');
  } finally {
    await server.close();
  }
});

// A checkout that ran `npx agentmash init` reports to the room committed in
// its config.json, and a signed-in machine's own hooks step aside for it.
// Login, the website and every lookup find the room by the repository
// instead. When the repository was connected to another room, each side
// looked fine on its own, and the team's work went to one room while
// everyone looked at the other. These say so, and `connect` puts it right.

test('status says when the room this checkout reports to is not the room its repository is connected to', async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout({ committed: server.url });
  try {
    // not signed in, and the server has not connected the room to anything: nothing to compare
    const alone = await run(['status'], { cwd: repo, env: m.env });
    assert.equal(alone.code, 0, alone.stderr);
    assert.doesNotMatch(alone.stdout, /two rooms|not connected on the website/);

    signIn(m, server.url);
    const split = await run(['status'], { cwd: repo, env: m.env });
    assert.equal(split.code, 0, split.stderr);
    assert.match(split.stdout, /two rooms for acme\/app/);
    assert.match(split.stdout, new RegExp(`reports to ${COMMITTED_REF}.*committed`));
    assert.match(split.stdout, new RegExp(`website use ${CONNECTED_REF}`));
    assert.match(split.stdout, /fix: npx agentmash connect/);

    server.state.lookup = { status: 200, ref: COMMITTED_REF };
    const same = await run(['status'], { cwd: repo, env: m.env });
    assert.doesNotMatch(same.stdout, /two rooms|not connected on the website/, 'one room: nothing to say');

    server.state.lookup = { status: 404 };
    const unconnected = await run(['status'], { cwd: repo, env: m.env });
    assert.match(unconnected.stdout, /acme\/app is not connected on the website/);
    assert.match(unconnected.stdout, /fix: npx agentmash connect/);

    // signed in somewhere else altogether
    signIn(m, 'http://127.0.0.1:9');
    const servers = await run(['status'], { cwd: repo, env: m.env });
    assert.match(servers.stdout, new RegExp(`reports to ${server.url}.*signed in to http://127\\.0\\.0\\.1:9`));
    assert.match(servers.stdout, new RegExp(`npx agentmash login --server ${server.url}`));
    // a machine is signed in to one server: signing in to this one signs it out of the other, for every repository
    assert.match(servers.stdout, /hooks stop for every repository on http:\/\/127\.0\.0\.1:9/);

    // the room opens from some other repository: everyone who can push to it
    // reads it, whatever its key, and the key's holders are the ones to know
    fs.rmSync(path.join(m.home, '.agentmash', 'user.json'));
    server.state.self = { ...server.state.self, repo: 'mallory/own' };
    const elsewhere = await run(['status'], { cwd: repo, env: m.env });
    assert.match(elsewhere.stdout, /this room is connected to mallory\/own, not acme\/app/);
    assert.match(elsewhere.stdout, /npx agentmash disconnect/);

    // a server from before /rooms/self: there is nothing to compare, and
    // status asks nothing more, least of all with the key in a URL
    server.state.self = null;
    const old = await run(['status'], { cwd: repo, env: m.env });
    assert.equal(old.code, 0, old.stderr);
    assert.ok(!server.requests.some((r) => r.path.includes(KEY)), 'the key is never in a URL');
  } finally {
    await server.close();
  }
});

test('login and doctor say it too, from a checkout that carries a room of its own', async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout({ committed: server.url });
  try {
    const login = await run(['login', '--server', server.url, '--no-open'], { cwd: repo, env: m.env });
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, /two rooms for acme\/app/);
    assert.match(login.stdout, /fix: npx agentmash connect/);

    const doctor = await run(['doctor'], { cwd: repo, env: { ...m.env, AGENTMASH_DEV: 'bob' } });
    assert.match(doctor.stdout, /✗ two rooms for acme\/app/, 'counted as a problem');
    assert.match(doctor.stdout, /fix: npx agentmash connect/);
  } finally {
    await server.close();
  }
});

test('connect binds the repository to the room this checkout carries, by its key, as this machine\'s sign-in', async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout({ committed: server.url });
  try {
    const signedOut = await run(['connect'], { cwd: repo, env: m.env });
    assert.equal(signedOut.code, 1);
    assert.match(signedOut.stderr, /npx agentmash login/);

    signIn(m, server.url);
    // what the hooks looked up goes: the room they found may not be the room any more
    fs.writeFileSync(path.join(m.home, '.agentmash', 'rooms.json'), JSON.stringify({ [`${server.url}|acme/app`]: { ref: CONNECTED_REF, at: Date.now() } }));
    const result = await run(['connect'], { cwd: repo, env: m.env });
    assert.equal(result.code, 0, result.stderr);
    const asked = server.requests.filter((r) => r.path === '/api/connect/room');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].room, KEY, 'the key proves the room, never its ref');
    assert.equal(asked[0].user, TOKEN);
    assert.deepEqual(asked[0].body, { repo: 'acme/app' });
    assert.match(result.stdout, new RegExp(`acme/app → ${server.url}/r/${COMMITTED_REF}`));
    assert.ok(!fs.existsSync(path.join(m.home, '.agentmash', 'rooms.json')));
    assert.ok(!result.stdout.includes(KEY), 'and the key is never printed');
  } finally {
    await server.close();
  }
});

test('connect asks before it moves a repository away from a room with history, and --replace moves it', async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout({ committed: server.url });
  signIn(m, server.url);
  try {
    server.state.connectRoom.push({
      status: 409,
      body: { error: 'acme/app is connected to another room', code: 'repo_taken', has_history: true, committed_ref: COMMITTED_REF, connected_ref: CONNECTED_REF },
    });
    const asked = await run(['connect'], { cwd: repo, env: m.env });
    assert.equal(asked.code, 1);
    assert.match(asked.stdout, new RegExp(`${server.url}/r/${COMMITTED_REF}`));
    assert.match(asked.stdout, new RegExp(`${server.url}/r/${CONNECTED_REF}`));
    assert.match(asked.stdout, /npx agentmash connect --replace/);

    const moved = await run(['connect', '--replace'], { cwd: repo, env: m.env });
    assert.equal(moved.code, 0, moved.stderr);
    assert.deepEqual(server.requests.filter((r) => r.path === '/api/connect/room').at(-1).body, { repo: 'acme/app', replace: true });
  } finally {
    await server.close();
  }
});

test('connect signs the machine in again when the server wants GitHub to say afresh who can push', async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout({ committed: server.url });
  const STALE = 'amu_stalestalestalestalestalexx';
  signIn(m, server.url, STALE);
  try {
    server.state.connectRoom.push({ status: 401, body: { error: 'sign in again', code: 'reauth' } });
    const result = await run(['connect', '--no-open'], { cwd: repo, env: m.env });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      server.requests.map((r) => r.path).filter((p) => p.startsWith('/api/connect') || p.startsWith('/auth/cli')),
      ['/api/connect/room', '/auth/cli/start', '/auth/cli/token', '/auth/cli/token', '/api/connect/room']
    );
    assert.deepEqual(
      server.requests.filter((r) => r.path === '/api/connect/room').map((r) => r.user),
      [STALE, TOKEN],
      'asked again as the new sign-in'
    );
    assert.match(result.stdout, new RegExp(`acme/app → ${server.url}/r/${COMMITTED_REF}`));
    // the sign-in it replaced is this machine's, and nothing reads it any more: it goes, so they do not pile up
    assert.equal(JSON.parse(fs.readFileSync(path.join(m.home, '.agentmash', 'user.json'), 'utf8')).token, TOKEN);
    assert.deepEqual(
      server.requests.filter((r) => r.path === '/api/logout').map((r) => r.user),
      [STALE],
      'the old sign-in is signed out on the server'
    );
  } finally {
    await server.close();
  }
});

// What a machine can push to is what GitHub listed when it last signed in.
// Given push access since, or let in by an organization that granted
// agentmash access since, a developer was refused by connect on the old list
// until they thought to run login themselves.
test('connect refused on the list from the last sign-in asks GitHub again, once, before it gives up', async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout({ committed: server.url });
  const STALE = 'amu_stalestalestalestalestalexx';
  const noAccess = { status: 403, body: { error: 'bob could not push to acme/app at their last sign-in', code: 'no_access' } };
  const paths = () => server.requests.map((r) => r.path).filter((p) => p.startsWith('/api/connect') || p === '/auth/cli/start');
  try {
    signIn(m, server.url, STALE);
    server.state.connectRoom.push(noAccess);
    const result = await run(['connect', '--no-open'], { cwd: repo, env: m.env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /GitHub did not list acme\/app as one you can push to when this machine last signed in: signing it in once more/);
    assert.deepEqual(paths(), ['/api/connect/room', '/auth/cli/start', '/api/connect/room']);
    assert.deepEqual(server.requests.filter((r) => r.path === '/api/connect/room').map((r) => r.user), [STALE, TOKEN]);
    assert.match(result.stdout, new RegExp(`acme/app → ${server.url}/r/${COMMITTED_REF}`));

    // still refused by what GitHub says now: one sign-in, and the reason
    server.requests.length = 0;
    server.state.connectRoom.push(noAccess, noAccess);
    const refused = await run(['connect', '--no-open'], { cwd: repo, env: m.env });
    assert.equal(refused.code, 1);
    assert.deepEqual(paths(), ['/api/connect/room', '/auth/cli/start', '/api/connect/room'], 'signed in once, not again and again');
    assert.match(refused.stderr, /you could not push to acme\/app/);
  } finally {
    await server.close();
  }
});

// A repository renamed or transferred: GitHub lists it under its new name,
// and redirects the old one, but a checkout's remote still says the old name.
// connect compared that name with what the sign-in listed, and refused.
test('connect follows a repository GitHub moved, binds its new name, and says how to point the remote there', async () => {
  const server = await startServer();
  const m = machine();
  signIn(m, server.url);
  const noAccess = { status: 403, body: { error: 'bob could not push to bob/app at their last sign-in', code: 'no_access' } };
  const connects = () => server.requests.filter((r) => r.path === '/api/connect/room').map((r) => r.body.repo);
  try {
    // private: GitHub says where it went only to a sign-in, so connect signs in, naming it
    const stale = checkout({ committed: server.url, remotes: [['origin', 'git@github.com:Bob/App.git']] });
    server.state.connectRoom.push(noAccess);
    server.state.moved = { 'bob/app': 'acme/app' };
    const result = await run(['connect', '--no-open'], { cwd: stale, env: m.env });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(connects(), ['bob/app', 'acme/app'], 'the new name is the one bound');
    assert.deepEqual(server.requests.find((r) => r.path === '/auth/cli/start').body.repos, ['bob/app']);
    assert.match(result.stdout, /GitHub moved bob\/app to acme\/app, and origin still says bob\/app/);
    // git still pushes by the old name, so the line says what it costs: status and doctor go by the remotes
    assert.match(result.stdout, /still says bob\/app: status and doctor say its room is connected to another repository until a remote says acme\/app/);
    assert.match(result.stdout, /git remote set-url origin git@github\.com:acme\/app\.git/);
    assert.match(result.stdout, new RegExp(`acme/app → ${server.url}/r/${COMMITTED_REF}`));
    // named by its new name, which no remote has yet: the plain command is the one that follows it
    const named = await run(['connect', 'acme/app'], { cwd: stale, env: m.env });
    assert.equal(named.code, 1);
    assert.match(named.stderr, /if bob\/app moved to acme\/app on GitHub, a plain npx agentmash connect follows it there/);

    // public: GitHub says where it went to anyone, so nothing signs in
    server.requests.length = 0;
    server.state.moved = null;
    github.answers['bob/site'] = { status: 200, body: { private: false, full_name: 'acme/site' } };
    const open = checkout({ committed: server.url, remotes: [['origin', 'https://github.com/bob/site']] });
    server.state.connectRoom.push(noAccess);
    const followed = await run(['connect', '--no-open'], { cwd: open, env: m.env });
    assert.equal(followed.code, 0, followed.stderr);
    assert.deepEqual(connects(), ['bob/site', 'acme/site']);
    assert.ok(!server.requests.some((r) => r.path === '/auth/cli/start'), 'no sign-in to find it');
    assert.match(followed.stdout, /git remote set-url origin https:\/\/github\.com\/acme\/site/);
  } finally {
    delete github.answers['bob/site'];
    await server.close();
  }
});

test('login from a checkout whose remote names a moved repository says how to point it there', async () => {
  const server = await startServer();
  const m = machine();
  const stale = checkout({ remotes: [['origin', 'https://github.com/bob/app.git'], ['upstream', 'git@github.com:acme/app.git']] });
  try {
    server.state.moved = { 'bob/app': 'acme/app' };
    const result = await run(['login', '--server', server.url, '--no-open'], { cwd: stale, env: m.env });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(server.requests[0].body.repos, ['bob/app', 'acme/app'], "the checkout's repositories, asked after by name");
    assert.match(result.stdout, /GitHub moved bob\/app to acme\/app, and origin still says bob\/app/);
    // this machine's hooks look the room up by origin, which the server knows by the new name only
    assert.match(
      result.stdout,
      /still says bob\/app: this machine's hooks find the room by origin, so nothing from this checkout reaches it until origin says acme\/app/
    );
    assert.match(result.stdout, /git remote set-url origin https:\/\/github\.com\/acme\/app\.git/);

    // a moved upstream, beside an origin of the developer's own: the hooks go by origin, which is fine
    server.state.moved = { 'acme/app': 'acme/web' };
    const fork = checkout({ remotes: [['origin', 'https://github.com/bob/app.git'], ['upstream', 'git@github.com:acme/app.git']] });
    const upstream = await run(['login', '--server', server.url, '--no-open'], { cwd: fork, env: m.env });
    assert.equal(upstream.code, 0, upstream.stderr);
    assert.match(upstream.stdout, /GitHub moved acme\/app to acme\/web, and upstream still says acme\/app\n/);
    assert.match(upstream.stdout, /git remote set-url upstream git@github\.com:acme\/web\.git/);
  } finally {
    await server.close();
  }
});

// An organization that limits third-party apps leaves its private
// repositories out of everything GitHub lists for agentmash, so a member who
// can push to one was told only that they could not, and only someone who can
// connects it. connect says what is likely, and where an owner grants access.
test("connect refused a repository of an organization says an owner grants agentmash access, and where", async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout({ committed: server.url });
  const GRANT = 'https://github.com/settings/connections/applications/abc123';
  const noAccess = (extra = {}) => ({ status: 403, body: { error: 'bob could not push to acme/app', code: 'no_access', owner: 'acme', ...extra } });
  signIn(m, server.url);
  try {
    github.answers['users/acme'] = { status: 200, body: { login: 'acme', type: 'Organization' } };
    server.state.connectRoom.push(noAccess({ grant_url: GRANT }), noAccess({ grant_url: GRANT }));
    const asked = github.requests.length;
    const refused = await run(['connect', '--no-open'], { cwd: repo, env: m.env });
    assert.equal(refused.code, 1);
    // said before the sign-in too, so an owner can grant it while the browser is open
    assert.match(refused.stdout, /acme is an organization: if it limits third-party apps, GitHub hides its private repositories from agentmash until an owner of acme grants access/);
    // only an owner sees grant on that page: a member requests, and an owner approves it in the organization's settings
    const steps = `an owner grants it, anyone else requests it: ${GRANT} → organization access → grant, or request`;
    const approve = 'an owner approves a request at https://github.com/organizations/acme/settings/oauth_application_policy.';
    assert.ok(refused.stdout.includes(steps), refused.stdout);
    assert.ok(refused.stdout.includes(`${approve} granted before you finish signing in below, this sign-in sees it`), refused.stdout);
    assert.match(refused.stderr, /you could not push to acme\/app when you last signed in/);
    assert.match(refused.stderr, /acme is an organization: if it limits third-party apps/);
    assert.ok(refused.stderr.includes(steps), refused.stderr);
    assert.ok(refused.stderr.includes(`${approve} once it is granted, run: npx agentmash connect --no-open`), refused.stderr);
    assert.doesNotMatch(refused.stdout + refused.stderr, /grant it:/, 'nobody is told to grant what only an owner can');
    assert.equal(github.requests.slice(asked).filter((r) => r.path === '/users/acme').length, 1, 'GitHub is asked once a run');

    // a server from before the link was in the refusal: its /api/config names the app
    server.state.connectRoom.push(noAccess(), noAccess());
    const older = await run(['connect', '--no-open'], { cwd: repo, env: m.env });
    assert.ok(older.stderr.includes('anyone else requests it: https://github.com/settings/connections/applications/cfgid'), older.stderr);

    // a person's public repository, which GitHub shows anyone: nothing about organizations
    github.answers['users/acme'] = { status: 200, body: { login: 'acme', type: 'User' } };
    github.answers['acme/app'] = { status: 200, body: { private: false } };
    server.state.connectRoom.push(noAccess({ grant_url: GRANT }), noAccess({ grant_url: GRANT }));
    const personal = await run(['connect', '--no-open'], { cwd: repo, env: m.env });
    assert.equal(personal.code, 1);
    assert.doesNotMatch(personal.stdout + personal.stderr, /organization/);
  } finally {
    delete github.answers['users/acme'];
    delete github.answers['acme/app'];
    await server.close();
  }
});

// The end-to-end run's own setup: origin still named the repository under
// the developer's own account, and it had moved into an organization that
// limits third-party apps. GitHub's redirect from the old name reaches only a
// sign-in that can see the repository, which that organization's limit keeps
// agentmash's from, so nothing came back as moved; the owner was a person, so
// nothing was said of organizations either. connect signed in again and gave
// the refusal it gave before, with nothing to act on.
test('connect refused a private repository under a person says it may have moved, and how an organization grants access', async () => {
  const server = await startServer();
  const m = machine();
  const GRANT = 'https://github.com/settings/connections/applications/abc123';
  const noAccess = { status: 403, body: { error: 'bob could not push', code: 'no_access', grant_url: GRANT } };
  const steps = `an owner grants it, anyone else requests it: ${GRANT} → organization access → grant, or request`;
  const approve = "an owner approves a request in the organization's settings → third-party access → OAuth application policy.";
  signIn(m, server.url);
  try {
    github.answers['users/bob'] = { status: 200, body: { login: 'bob', type: 'User' } };
    github.answers['users/alice'] = { status: 200, body: { login: 'alice', type: 'User' } };

    // bob's own: he can push to everything under his account, so GitHub not listing it means it is gone from there
    const own = checkout({ committed: server.url, remotes: [['origin', 'git@github.com:bob/app.git']] });
    server.state.connectRoom.push(noAccess, noAccess);
    const refused = await run(['connect', '--no-open'], { cwd: own, env: m.env });
    assert.equal(refused.code, 1);
    assert.deepEqual(server.requests.find((r) => r.path === '/auth/cli/start').body.repos, ['bob/app'], 'it signed in, and nothing came back moved');
    assert.match(refused.stderr, /GitHub lists no bob\/app you can push to, and bob is your own account: it was renamed, transferred or deleted/);
    assert.doesNotMatch(refused.stderr, /only someone who can connects it/);
    assert.ok(
      refused.stderr.includes('if it moved, point origin at its new name: git remote set-url origin git@github.com:<owner>/<name>.git, then run: npx agentmash connect'),
      refused.stderr
    );
    assert.match(refused.stderr, /if it moved into an organization that limits third-party apps, GitHub hides it from agentmash until an owner of that organization grants access/);
    assert.ok(refused.stderr.includes(steps), refused.stderr);
    assert.ok(refused.stderr.includes(`${approve} once it is granted, run: npx agentmash connect --no-open`), refused.stderr);

    // someone else's: maybe never theirs to push to, so the moves are an if
    const theirs = checkout({ committed: server.url, remotes: [['origin', 'https://github.com/alice/app']] });
    server.state.connectRoom.push(noAccess, noAccess);
    const other = await run(['connect', '--no-open'], { cwd: theirs, env: m.env });
    assert.equal(other.code, 1);
    assert.match(other.stderr, /you could not push to alice\/app when you last signed in, and only someone who can connects it/);
    assert.ok(
      other.stderr.includes('if alice/app was renamed or transferred, point origin at its new name: git remote set-url origin https://github.com/<owner>/<name>, then run'),
      other.stderr
    );
    assert.ok(other.stderr.includes(steps), other.stderr);
  } finally {
    delete github.answers['users/bob'];
    delete github.answers['users/alice'];
    await server.close();
  }
});

// In a checkout with no room of its own, status and doctor said only to sign
// in again when the repository did not open to this machine. For a member of
// an organization that keeps its repositories from agentmash, a sign-in lists
// it no more than the last did, so that sent them round in a loop.
test('status and doctor say how an organization grants access when its repository does not open to this sign-in', async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout();
  const steps =
    'an owner grants it, anyone else requests it: https://github.com/settings/connections/applications/cfgid → organization access → grant, or request';
  try {
    assert.equal((await run(['login', '--server', server.url, '--no-open'], { env: m.env })).code, 0);
    github.answers['users/acme'] = { status: 200, body: { login: 'acme', type: 'Organization' } };
    server.state.lookup = { status: 404 };
    for (const command of ['status', 'doctor']) {
      const said = await run([command], { cwd: repo, env: m.env });
      assert.match(said.stdout, /npx agentmash login again/, command);
      assert.match(
        said.stdout,
        /acme is an organization: if it limits third-party apps, GitHub hides its private repositories from agentmash until an owner of acme grants access/,
        command
      );
      assert.ok(said.stdout.includes(steps), said.stdout);
      assert.ok(
        said.stdout.includes('https://github.com/organizations/acme/settings/oauth_application_policy. once it is granted, run: npx agentmash login'),
        said.stdout
      );
    }

    // a person's repository, or a fork they can push to: nothing an organization hides
    for (const [lookup, owner] of [[{ status: 404 }, 'User'], [{ status: 404, fork: true }, 'Organization']]) {
      server.state.lookup = lookup;
      github.answers['users/acme'] = { status: 200, body: { login: 'acme', type: owner } };
      for (const command of ['status', 'doctor']) {
        assert.doesNotMatch((await run([command], { cwd: repo, env: m.env })).stdout, /organization/, `${command}, ${owner}`);
      }
    }

    // one the sign-in listed, which the server says: simply not connected, and a sign-in changes nothing
    github.answers['users/acme'] = { status: 200, body: { login: 'acme', type: 'Organization' } };
    server.state.lookup = { status: 404, can_push: true };
    for (const command of ['status', 'doctor']) {
      const said = await run([command], { cwd: repo, env: m.env });
      assert.match(said.stdout, /acme\/app is not connected/, command);
      assert.doesNotMatch(said.stdout, /npx agentmash login again|organization/, command);
    }
  } finally {
    delete github.answers['users/acme'];
    await server.close();
  }
});

// The end-to-end run's setup, in a checkout with no room of its own: origin
// still names the repository under the developer's own account, and it moved
// into an organization that limits third-party apps. The hooks look the room
// up by origin, the owner is a person, so nothing was said of organizations,
// and status and doctor sent them to sign in again, which finds it no more
// than the last sign-in did, round and round.
test('status and doctor say a repository the sign-in did not list may have moved, and how an organization grants access', async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout({ remotes: [['origin', 'https://github.com/bob/app.git']] });
  const steps = 'an owner grants it, anyone else requests it: https://github.com/settings/connections/applications/cfgid → organization access → grant, or request';
  try {
    assert.equal((await run(['login', '--server', server.url, '--no-open'], { env: m.env })).code, 0);
    github.answers['users/bob'] = { status: 200, body: { login: 'bob', type: 'User' } };
    server.state.lookup = { status: 404, can_push: false };
    for (const command of ['status', 'doctor']) {
      const said = (await run([command], { cwd: repo, env: m.env })).stdout;
      const move = said.indexOf(
        'if bob/app was renamed or transferred, point origin at its new name: git remote set-url origin https://github.com/<owner>/<name>.git'
      );
      const hidden = said.indexOf(
        'if it moved into an organization that limits third-party apps, GitHub hides it from agentmash until an owner of that organization grants access'
      );
      assert.ok(move !== -1 && hidden > move, `${command}: the move, then the organization\n${said}`);
      assert.ok(said.includes(steps), said);
      assert.ok(
        said.includes("an owner approves a request in the organization's settings → third-party access → OAuth application policy. once it is granted, run: npx agentmash login"),
        said
      );
    }

    // public, so GitHub says where it went to anyone: that is all there is to say
    github.answers['bob/app'] = { status: 200, body: { private: false, full_name: 'acme/app' } };
    for (const command of ['status', 'doctor']) {
      const said = (await run([command], { cwd: repo, env: m.env })).stdout;
      assert.match(
        said,
        /GitHub moved bob\/app to acme\/app, and origin still says bob\/app: this machine's hooks find the room by origin, so nothing from this checkout reaches it until origin says acme\/app/,
        command
      );
      assert.match(said, /git remote set-url origin https:\/\/github\.com\/acme\/app\.git/, command);
      assert.doesNotMatch(said, /npx agentmash login again|organization/, command);
    }

    // a server from before it said whether the sign-in listed it: nothing is guessed at
    delete github.answers['bob/app'];
    server.state.lookup = { status: 404 };
    const older = (await run(['status'], { cwd: repo, env: m.env })).stdout;
    assert.match(older, /npx agentmash login again/);
    assert.doesNotMatch(older, /renamed or transferred|organization/);
  } finally {
    delete github.answers['users/bob'];
    delete github.answers['bob/app'];
    await server.close();
  }
});

// The code a sign-in shows works for ten minutes, and nothing said so: a
// person who got to the browser late was told the sign-in "has expired —
// run: npx agentmash login again", having run connect, and the command still
// ended with exit code 0 on Windows.
test('a sign-in code says how long it works, and one that expired names the command that was run', async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout({ committed: server.url });
  try {
    const login = await run(['login', '--server', server.url, '--no-open'], { env: m.env });
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, /this code works for 10 minutes/);

    const expired = { status: 404, body: { error: 'this sign-in has expired — run: npx agentmash login again', code: 'expired' } };
    server.state.signIn = [expired];
    server.state.connectRoom.push({ status: 401, body: { error: 'sign in again', code: 'reauth' } });
    const connect = await run(['connect', '--no-open'], { cwd: repo, env: m.env });
    assert.equal(connect.code, 1, 'an error ends the command with an exit code that says so');
    assert.match(connect.stderr, /this sign-in code expired: it works for 10 minutes — run: npx agentmash connect --no-open/);
    assert.doesNotMatch(connect.stderr, /npx agentmash login|HTTP 404/);

    // run from elsewhere, naming the checkout: the command given back works in
    // the shell it was run in, and cmd keeps a POSIX shell's single quotes as
    // part of a Windows path, so there it is in double quotes
    server.state.signIn = [expired];
    server.state.connectRoom.push({ status: 401, body: { error: 'sign in again', code: 'reauth' } });
    const elsewhere = await run(['connect', '--no-open', '--repo', repo], { cwd: m.home, env: m.env });
    assert.equal(elsewhere.code, 1);
    const named = process.platform === 'win32' ? `"${repo}"` : repo;
    assert.ok(elsewhere.stderr.includes(`run: npx agentmash connect --no-open --repo ${named}\n`), elsewhere.stderr);

    // one from a server that said only 404, as one from before the code did
    server.state.signIn = [{ status: 404, body: { error: 'this sign-in has expired — run: npx agentmash login again' } }];
    const again = await run(['login', '--server', server.url, '--no-open'], { env: m.env });
    assert.equal(again.code, 1);
    assert.match(again.stderr, new RegExp(`run: npx agentmash login --server ${server.url.replace(/[.]/g, '\\.')} --no-open`));
  } finally {
    await server.close();
  }
});

// The repository a team connects its room to is the team's, and a checkout
// can have a remote for it under any name. `gh repo fork` makes origin the
// developer's fork and the team's repository upstream; two GitHub accounts on
// one machine reach GitHub through an SSH host alias, which no URL says is
// GitHub. Going by origin alone, a room correctly connected to the team's
// repository was called a red ✗ in every such checkout, pointing at
// `disconnect`, and `connect` bound the team's room to the developer's fork.

test("a room connected to the team's repository is this checkout's when any remote names it: a fork's upstream, an SSH host alias", async () => {
  const server = await startServer();
  const m = machine();
  const problems = (out) => Number(/(\d+) problem\(s\) found/.exec(out)?.[1] ?? 0);
  const doctor = (repo) => run(['doctor'], { cwd: repo, env: { ...m.env, AGENTMASH_DEV: 'bob' } });
  try {
    server.state.self = { ...server.state.self, repo: 'acme/app' };
    // what doctor finds in a plain checkout of acme/app, whose room is acme/app's: the same everywhere below
    const plain = await doctor(checkout({ committed: server.url }));
    assert.doesNotMatch(plain.stdout, /connected to acme\/app/);

    for (const [layout, remotes] of Object.entries({
      'an SSH host alias': [['origin', 'git@github.com-work:acme/app.git']],
      "a fork's upstream": [
        ['origin', 'git@github.com:alice/app.git'],
        ['upstream', 'https://github.com/Acme/App.git'],
      ],
    })) {
      const repo = checkout({ committed: server.url, remotes });
      const status = await run(['status'], { cwd: repo, env: m.env });
      assert.equal(status.code, 0, status.stderr);
      assert.doesNotMatch(status.stdout, /connected to acme\/app|disconnect/, `${layout}: nothing to say`);
      const checked = await doctor(repo);
      assert.doesNotMatch(checked.stdout, /connected to acme\/app|disconnect/, layout);
      assert.equal(problems(checked.stdout), problems(plain.stdout), `${layout}: no problem counted`);
    }

    // no remote is GitHub for sure, and none is acme/app by its path: which
    // repository opens the room is said, and is nobody's problem
    const unknown = checkout({ committed: server.url, remotes: [['origin', 'git@git.example.com:team/app.git']] });
    const said = await run(['status'], { cwd: unknown, env: m.env });
    assert.match(said.stdout, /· this room is connected to acme\/app/);
    assert.doesNotMatch(said.stdout, /✗|disconnect/);
    const checked = await doctor(unknown);
    assert.doesNotMatch(checked.stdout, /✗ this room is connected/);
    assert.equal(problems(checked.stdout), problems(plain.stdout));

    // a checkout with GitHub remotes, none of them the one the room opens to, is still told
    server.state.self = { ...server.state.self, repo: 'mallory/own' };
    const fork = checkout({
      committed: server.url,
      remotes: [['origin', 'git@github.com:alice/app.git'], ['upstream', 'git@github.com:acme/app.git']],
    });
    const elsewhere = await run(['status'], { cwd: fork, env: m.env });
    assert.match(elsewhere.stdout, /✗ this room is connected to mallory\/own, not alice\/app or acme\/app/);
    assert.match(elsewhere.stdout, /npx agentmash disconnect/);
  } finally {
    await server.close();
  }
});

test('in a checkout with remotes for two repositories, connect and init bind only the one named, never a fork by its origin', async () => {
  const server = await startServer();
  const m = machine();
  signIn(m, server.url);
  const remotes = [['origin', 'git@github.com:alice/app.git'], ['upstream', 'git@github.com:acme/app.git']];
  const bindings = () => server.requests.filter((r) => r.path === '/api/connect/room').map((r) => r.body);
  try {
    const repo = checkout({ committed: server.url, remotes });

    // nothing connected yet: status names both, and asks which is the team's
    server.state.lookup = { status: 404 };
    const status = await run(['status'], { cwd: repo, env: m.env });
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /alice\/app/);
    assert.match(status.stdout, /acme\/app/);
    assert.match(status.stdout, /npx agentmash connect <owner\/name>/);
    assert.doesNotMatch(status.stdout, /fix: npx agentmash connect(?! <)/, 'never a connect that picks one by itself');

    const unnamed = await run(['connect'], { cwd: repo, env: m.env });
    assert.equal(unnamed.code, 1);
    assert.match(unnamed.stderr, /alice\/app \(origin\)/);
    assert.match(unnamed.stderr, /acme\/app \(upstream\)/);
    assert.match(unnamed.stderr, /npx agentmash connect <owner\/name>/);
    const stranger = await run(['connect', 'mallory/own'], { cwd: repo, env: m.env });
    assert.equal(stranger.code, 1);
    assert.match(stranger.stderr, /mallory\/own is not a remote of this checkout/);
    assert.deepEqual(bindings(), [], 'nothing was bound');

    const named = await run(['connect', 'Acme/App'], { cwd: repo, env: m.env });
    assert.equal(named.code, 0, named.stderr);
    assert.deepEqual(bindings(), [{ repo: 'acme/app' }], "the team's repository, as named");

    // the team's upstream through an SSH host alias, origin the fork on GitHub: still two repositories
    const aliased = checkout({
      committed: server.url,
      remotes: [['origin', 'git@github.com:alice/app.git'], ['upstream', 'git@github.com-work:acme/app.git']],
    });
    const unsure = await run(['connect'], { cwd: aliased, env: m.env });
    assert.equal(unsure.code, 1);
    assert.match(unsure.stderr, /acme\/app \(upstream\)/);
    assert.deepEqual(bindings(), [{ repo: 'acme/app' }], 'and nothing more was bound');
    const byPath = await run(['connect', 'acme/app'], { cwd: aliased, env: m.env });
    assert.equal(byPath.code, 0, byPath.stderr);
    assert.deepEqual(bindings().at(-1), { repo: 'acme/app' }, 'named, the alias is a remote of acme/app');

    // the team's repository was connected to another room: the two rooms are
    // acme/app's, and connect is still told which repository is the team's
    server.state.lookups = { 'acme/app': { status: 200, ref: CONNECTED_REF } };
    const split = await run(['status'], { cwd: repo, env: m.env });
    assert.match(split.stdout, /two rooms for acme\/app/);
    assert.match(split.stdout, /fix: npx agentmash connect <owner\/name>/);

    // a fresh checkout of the fork, whose upstream is connected: there is no room to make
    const fresh = checkout({ remotes });
    const before = server.requests.length;
    const stopped = await run(['init', '--server', server.url, '--no-open', '--no-git-hook'], { cwd: fresh, env: m.env });
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.match(stopped.stdout, /acme\/app is already connected/);
    assert.ok(!server.requests.slice(before).some((r) => r.path === '/rooms'), 'and no room was made');

    // init --force makes the room, and leaves which repository it is for to whoever knows
    server.state.lookups = {};
    const bound = bindings().length;
    const made = await run(['init', '--force', '--server', server.url, '--no-open', '--no-git-hook'], { cwd: repo, env: m.env });
    assert.equal(made.code, 0, made.stderr);
    assert.equal(bindings().length, bound, 'nothing more was bound');
    assert.match(made.stdout, /npx agentmash connect <owner\/name>/);
  } finally {
    await server.close();
  }
});

// A checkout of a fork alone has only origin, the fork, and nothing on the
// machine can tell it is one. The server can, from what GitHub said at
// sign-in, and connects no fork to the room a key names: the key a fork
// carries is its original's, copied with config.json, and connecting the
// team's room to the fork opened it to everyone who can push to the fork and
// turned the team away when it connected. So nothing here may send a fork's
// contributor to a connect the server refuses.

test('in a checkout of a fork, nothing says to connect it, and connect and init say why it is not', async () => {
  const server = await startServer();
  const m = machine();
  signIn(m, server.url);
  const repo = checkout({ committed: server.url, remotes: [['origin', 'git@github.com:alice/app.git']] });
  const env = { ...m.env, AGENTMASH_DEV: 'bob' };
  try {
    server.state.lookups = { 'alice/app': { status: 404, fork: true } };
    for (const command of [['status'], ['doctor'], ['login', '--server', server.url, '--no-open']]) {
      const said = await run(command, { cwd: repo, env });
      assert.match(said.stdout, /alice\/app is a fork on GitHub/, command[0]);
      assert.doesNotMatch(said.stdout, /fix: npx agentmash connect|not connected on the website/, `${command[0]}: no connect to be refused`);
    }

    const refusal = { status: 403, body: { error: 'alice/app is a fork on GitHub, so it is not connected to the room a key names', code: 'fork' } };
    server.state.connectRoom.push(refusal);
    const refused = await run(['connect'], { cwd: repo, env });
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /alice\/app is a fork on GitHub/);
    assert.match(refused.stdout, /reports to the room in its config\.json with the key it carries already/);
    assert.doesNotMatch(refused.stdout + refused.stderr, /HTTP 403/, 'said in words');

    // init --force gives the fork a room of its own, by its key; the website is not where it opens
    server.state.connectRoom.push(refusal);
    const made = await run(['init', '--force', '--server', server.url, '--no-open', '--no-git-hook'], { cwd: repo, env });
    assert.equal(made.code, 0, made.stderr);
    assert.match(made.stdout, /alice\/app is a fork on GitHub/);
    assert.doesNotMatch(made.stdout, /npx agentmash connect/, 'and no connect is offered: it would be refused');
  } finally {
    await server.close();
  }
});

test('init on a signed-in machine connects the new room on the website, and makes none for a repository connected already', async () => {
  const server = await startServer();
  const m = machine();
  signIn(m, server.url);
  try {
    server.state.lookup = { status: 404 };
    const fresh = checkout();
    const made = await run(['init', '--server', server.url, '--no-open', '--no-git-hook'], { cwd: fresh, env: m.env });
    assert.equal(made.code, 0, made.stderr);
    const bound = server.requests.filter((r) => r.path === '/api/connect/room');
    assert.deepEqual(
      bound.map((r) => [r.room, r.user, r.body]),
      [[NEW_KEY, TOKEN, { repo: 'acme/app' }]],
      'the new room, by its key, for this repository'
    );
    assert.match(made.stdout, new RegExp(`acme/app → ${server.url}/r/${NEW_REF}`));

    // signed in long enough ago that GitHub has to be asked again: connect does that, and that is all it says
    server.state.connectRoom.push({
      status: 401,
      body: { error: 'GitHub has to say again what bob can push to: sign in again (npx agentmash login)', code: 'reauth' },
    });
    const stale = await run(['init', '--server', server.url, '--no-open', '--no-git-hook'], { cwd: checkout(), env: m.env });
    assert.equal(stale.code, 0, stale.stderr);
    const line = stale.stdout.split('\n').find((l) => /not connected on the website/.test(l)) ?? '';
    assert.match(line, /run npx agentmash connect/);
    assert.doesNotMatch(line, /sign in again|agentmash login/);

    // connected on the website already: this machine reports there, and a second room is the bug
    server.state.lookup = { status: 200, ref: CONNECTED_REF };
    const before = server.requests.length;
    const connected = checkout();
    const stopped = await run(['init', '--server', server.url, '--no-open', '--no-git-hook'], { cwd: connected, env: m.env });
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.match(stopped.stdout, /acme\/app is already connected/);
    assert.match(stopped.stdout, new RegExp(`${server.url}/r/${CONNECTED_REF}`));
    assert.ok(!server.requests.slice(before).some((r) => r.path === '/rooms'), 'and no room was made');
    assert.ok(!fs.existsSync(path.join(connected, '.claude', 'agentmash', 'config.json')));
  } finally {
    await server.close();
  }
});

// A committed room key is anyone's who can read the repository: a read-only
// collaborator, a fork, a CI log. So the room init makes asks for a sign-in:
// its key opens it only beside the sign-in of someone who can push there.
// It asks once init has connected it, never before: a room connected to no
// repository opens to nobody's sign-in, so asking first would shut it to all.
test('init makes a room, connects it, then has its key open it only beside a sign-in, and says each teammate signs in once', async () => {
  const server = await startServer();
  const m = machine();
  signIn(m, server.url);
  try {
    server.state.lookup = { status: 404 };
    server.state.signInRooms = true;
    const made = await run(['init', '--server', server.url, '--no-open', '--no-git-hook'], { cwd: checkout(), env: m.env });
    assert.equal(made.code, 0, made.stderr);
    const asked = server.requests.find((r) => r.path === '/rooms' && r.method === 'POST');
    assert.equal(asked.body.sign_in_required, undefined, 'the room is made as every room is');
    const connect = server.requests.findIndex((r) => r.path === '/api/connect/room' && r.room === NEW_KEY);
    const gate = server.requests.findIndex((r) => r.path === '/rooms/settings');
    assert.ok(connect !== -1, 'connected it, so a sign-in opens it');
    assert.ok(gate > connect, 'and asked for a sign-in only once it was connected');
    assert.deepEqual(
      { room: server.requests[gate].room, user: server.requests[gate].user, body: server.requests[gate].body },
      { room: NEW_KEY, user: TOKEN, body: { sign_in_required: true } },
      "with the key and this machine's sign-in beside it"
    );
    assert.match(made.stdout, /Teammates pull, and sign in once on their machine: npx agentmash login\./);
    assert.match(made.stdout, /a copy of it anywhere else opens nothing/);
    assert.doesNotMatch(made.stdout, /Teammates just pull|opens to its key alone/);

    // --key-only: the key alone, as rooms made before this did
    const keyOnly = await run(['init', '--key-only', '--server', server.url, '--no-open', '--no-git-hook'], { cwd: checkout(), env: m.env });
    assert.equal(keyOnly.code, 0, keyOnly.stderr);
    assert.equal(server.requests.filter((r) => r.path === '/rooms/settings').length, 1, 'asks for nothing');
    assert.match(keyOnly.stdout, /Teammates just pull/);

    // a server from before rooms asked for a sign-in makes one its key alone opens, and init says so
    server.state.signInRooms = false;
    const older = await run(['init', '--server', server.url, '--no-open', '--no-git-hook'], { cwd: checkout(), env: m.env });
    assert.equal(older.code, 0, older.stderr);
    assert.equal(server.requests.filter((r) => r.path === '/rooms/settings').length, 1, 'asks for nothing');
    assert.match(older.stdout, /does not ask for a sign-in beside a room's key yet: this room opens to its key alone/);
    assert.match(older.stdout, /Teammates just pull/);
  } finally {
    await server.close();
  }
});

test('init on a machine not signed in asks it to sign in first, where a room could open by sign-in', async () => {
  const server = await startServer();
  const m = machine();
  try {
    server.state.signInRooms = true;
    const stopped = await run(['init', '--server', server.url, '--no-open', '--no-git-hook'], { cwd: checkout(), env: m.env });
    assert.equal(stopped.code, 1, stopped.stdout);
    assert.match(stopped.stderr, /sign this machine in first, then init again/);
    assert.ok(stopped.stderr.includes(`npx agentmash login --server ${server.url}`), stopped.stderr);
    assert.match(stopped.stderr, /npx agentmash init --key-only/);
    assert.ok(!server.requests.some((r) => r.path === '/rooms' && r.method === 'POST'), 'no room was made');

    const keyOnly = await run(['init', '--key-only', '--server', server.url, '--no-open', '--no-git-hook'], { cwd: checkout(), env: m.env });
    assert.equal(keyOnly.code, 0, keyOnly.stderr);
    assert.equal(server.requests.find((r) => r.path === '/rooms' && r.method === 'POST').body.sign_in_required, undefined);

    // no GitHub remote: no sign-in could open the room by it, so its key alone does, and init says so
    const gitlab = await run(['init', '--server', server.url, '--no-open', '--no-git-hook'], {
      cwd: checkout({ remotes: [['origin', 'git@gitlab.com:acme/app.git']] }),
      env: m.env,
    });
    assert.equal(gitlab.code, 0, gitlab.stderr);
    assert.match(gitlab.stdout, /no GitHub remote, so nobody's sign-in can open the room by it: its key alone opens it/);
    assert.equal(server.requests.filter((r) => r.path === '/rooms' && r.method === 'POST').at(-1).body.sign_in_required, undefined);
  } finally {
    await server.close();
  }
});

// Connecting a room takes a sign-in GitHub vouched for minutes ago, and a
// checkout whose remotes name one repository. Most machines signed in on an
// earlier day, so init often cannot connect its room. A room that asked for a
// sign-in then would open to nobody, its maker's own hooks included, and to
// whoever connected it first with a copy of its key. So it asks for nothing,
// opens to its key as rooms made before this did, and init says what to run.
test('a room init could not connect opens to its key, never to nobody, and init says to connect it, then ask for a sign-in', async () => {
  const server = await startServer();
  const m = machine();
  signIn(m, server.url);
  try {
    server.state.lookup = { status: 404 };
    server.state.signInRooms = true;
    // a sign-in from an earlier day: GitHub has to say again that it can push there
    server.state.connectRoom = [
      { status: 401, body: { error: 'GitHub has to say again what bob can push to: sign in again (npx agentmash login)', code: 'reauth' } },
    ];
    const stale = await run(['init', '--server', server.url, '--no-open', '--no-git-hook'], { cwd: checkout(), env: m.env });
    assert.equal(stale.code, 0, stale.stderr);
    assert.equal(server.requests.find((r) => r.path === '/rooms' && r.method === 'POST').body.sign_in_required, undefined);
    assert.ok(server.requests.some((r) => r.path === '/api/connect/room'), 'it tried');
    assert.ok(!server.requests.some((r) => r.path === '/rooms/settings'), 'and asked for no sign-in in a room nothing connected');
    assert.match(stale.stdout, /Teammates just pull/);
    assert.match(
      stale.stdout,
      /this room opens to its key alone, to anyone who holds it, until it is connected and asks for a sign-in beside it: npx agentmash connect, then npx agentmash secure sign-in/
    );
    assert.doesNotMatch(stale.stdout, /opens it to nobody|nobody's sign-in opens/);

    // remotes for two repositories: which one is the team's is for whoever connects it to say
    const repo = checkout({ remotes: [['origin', 'git@github.com:alice/app.git'], ['upstream', 'git@github.com:acme/app.git']] });
    const made = await run(['init', '--server', server.url, '--no-open', '--no-git-hook'], { cwd: repo, env: m.env });
    assert.equal(made.code, 0, made.stderr);
    assert.equal(server.requests.filter((r) => r.path === '/rooms' && r.method === 'POST').at(-1).body.sign_in_required, undefined);
    assert.ok(!server.requests.some((r) => r.path === '/rooms/settings'));
    assert.match(made.stdout, /npx agentmash connect <owner\/name>, then npx agentmash secure sign-in/);
    assert.doesNotMatch(made.stdout, /opens it to nobody|nobody's sign-in opens/);

    // a fork GitHub listed as one: the server connects no fork to a room a key names, so the key alone opens it
    server.state.lookups = { 'alice/app': { status: 404, fork: true } };
    const fork = await run(['init', '--server', server.url, '--no-open', '--no-git-hook'], {
      cwd: checkout({ remotes: [['origin', 'git@github.com:alice/app.git']] }),
      env: m.env,
    });
    assert.equal(fork.code, 0, fork.stderr);
    assert.match(fork.stdout, /alice\/app is a fork on GitHub, and the server connects no fork to a room a key names/);
    assert.equal(server.requests.filter((r) => r.path === '/rooms' && r.method === 'POST').at(-1).body.sign_in_required, undefined);
    assert.doesNotMatch(fork.stdout, /until it is connected/);
  } finally {
    await server.close();
  }
});

// A free plan covers one private repository. Connecting a second one is
// refused with 402 repo_limit, and init said only "(repo_limit)", beside a
// connect that would be refused the same way.
test('init whose plan has no room for another private repository says so in the plan’s words, and offers no connect', async () => {
  const server = await startServer();
  const m = machine();
  signIn(m, server.url);
  try {
    server.state.lookup = { status: 404 };
    const words =
      'acme is on the free plan, which covers 1 private repository, and has 1 connected already. ' +
      'upgrade to the team plan to connect acme/app: https://pay.example.test/upgrade';
    server.state.connectRoom.push({
      status: 402,
      body: { error: 'repo_limit', code: 'repo_limit', message: words, upgrade_url: 'https://pay.example.test/upgrade' },
    });
    const made = await run(['init', '--server', server.url, '--no-open', '--no-git-hook'], { cwd: checkout(), env: m.env });
    assert.equal(made.code, 0, made.stderr);
    const line = made.stdout.split('\n').find((l) => /not connected on the website/.test(l)) ?? '';
    assert.equal(line.trim(), `! not connected on the website: ${words}`);
    assert.doesNotMatch(made.stdout, /repo_limit|agentmash connect/);
    assert.match(made.stdout, /reports to the new room by the key in \.claude\/agentmash\/config\.json all the same/);
  } finally {
    await server.close();
  }
});

// The team connects its room to acme/app; a contributor cloned only their
// fork, so origin is alice/app and there is no upstream. The fork carries the
// team's config.json, so its committed room is the team's, connected to a
// repository no remote here names. That is the room working as it should,
// not a room open to strangers: only the server can tell the two apart.

test("a fork cloned with origin alone reports to the team's room, and that is no problem", async () => {
  const server = await startServer();
  const m = machine();
  const env = { ...m.env, AGENTMASH_DEV: 'bob' };
  const problems = (out) => Number(/(\d+) problem\(s\) found/.exec(out)?.[1] ?? 0);
  try {
    server.state.self = { ...server.state.self, repo: 'acme/app' };
    const plain = await run(['doctor'], { cwd: checkout({ committed: server.url }), env });
    const fork = checkout({ committed: server.url, remotes: [['origin', 'git@github.com:alice/app.git']] });

    // signed out, nothing here can tell a fork from a checkout pointed at
    // someone else's room: say both, call it nobody's problem yet
    for (const command of [['status'], ['doctor']]) {
      const said = await run(command, { cwd: fork, env });
      assert.doesNotMatch(said.stdout, /✗ this room is connected/, `${command[0]}: no red ✗ for the team's own room`);
      assert.match(said.stdout, /! this room is connected to acme\/app, not alice\/app/, command[0]);
      assert.match(said.stdout, /a fork of acme\/app/, command[0]);
      if (command[0] === 'doctor') assert.equal(problems(said.stdout), problems(plain.stdout), 'doctor counts nothing');
    }

    // signed in, the server says alice/app is a fork: it is, and that is all
    signIn(m, server.url);
    server.state.lookups = { 'alice/app': { status: 404, fork: true } };
    for (const command of [['status'], ['doctor']]) {
      const said = await run(command, { cwd: fork, env });
      assert.match(said.stdout, /alice\/app is a fork of acme\/app/, command[0]);
      assert.doesNotMatch(said.stdout, /✗ this room|disconnect/, command[0]);
      if (command[0] === 'doctor') assert.equal(problems(said.stdout), problems(plain.stdout), 'doctor counts nothing');
    }

    // and when the server says it is not a fork, the room really is someone else's
    server.state.lookups = { 'alice/app': { status: 404 } };
    const elsewhere = await run(['status'], { cwd: fork, env });
    assert.match(elsewhere.stdout, /✗ this room is connected to acme\/app, not alice\/app/);
    assert.match(elsewhere.stdout, /npx agentmash disconnect/);
    assert.match(elsewhere.stdout, /made since you signed in: npx agentmash login/, 'a fork made after the sign-in is news to the server');

    // a sign-in the server no longer takes, or a server that is down, says nothing about forks
    for (const status of [401, 503]) {
      server.state.lookups = { 'alice/app': { status } };
      const said = await run(['status'], { cwd: fork, env });
      assert.doesNotMatch(said.stdout, /✗ this room is connected/, `${status}: no red ✗`);
      assert.match(said.stdout, /! this room is connected to acme\/app, not alice\/app/, String(status));
    }
  } finally {
    await server.close();
  }
});

// A machine signed in with `npx agentmash login`, in a checkout with no room
// of its own, is the site's main flow: the hooks are in Claude Code's own
// settings and find the room by the repository. doctor used to look only for
// a per-repository install there, call it broken and send them to init, which
// would make the second room for a repository that has one already.

test('doctor on a signed-in machine checks the sign-in, its hooks, the server and this repository\'s room', async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout();
  try {
    assert.equal((await run(['login', '--server', server.url, '--no-open'], { env: m.env })).code, 0);
    server.requests.length = 0;
    const doctor = await run(['doctor'], { cwd: repo, env: m.env });
    assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
    assert.match(doctor.stdout, /✓ signed in as bob/);
    assert.match(doctor.stdout, /✓ hooks installed in Claude Code/);
    assert.match(doctor.stdout, /✓ server reachable/);
    assert.match(doctor.stdout, /✓ acme\/app is connected/);
    assert.match(doctor.stdout, /All good/);
    // none of a room-key install's files is a problem here, and init is not the fix
    assert.doesNotMatch(doctor.stdout, /✗/);
    assert.doesNotMatch(doctor.stdout, /config\.json|\.mcp\.json|agentmash init|Not connected/);
    assert.ok(server.requests.some((r) => r.path === '/api/whoami' && r.user === TOKEN), 'the sign-in is asked about, as the server sees it');
    assert.ok(server.requests.some((r) => r.path === '/api/lookup' && r.user === TOKEN));
  } finally {
    await server.close();
  }
});

test('doctor on a signed-in machine says what is wrong, and that login or the website fixes it', async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout();
  const env = m.env;
  try {
    // signed in, and no hooks in Claude Code or any other agent: nothing on this machine reports
    signIn(m, server.url);
    const unhooked = await run(['doctor'], { cwd: repo, env });
    assert.equal(unhooked.code, 1);
    assert.match(unhooked.stdout, /✗ no coding agent on this machine is connected, so nothing from it reaches a room — run: npx agentmash login/);
    assert.doesNotMatch(unhooked.stdout, /agentmash init/);

    assert.equal((await run(['login', '--server', server.url, '--no-open'], { env })).code, 0);

    // a repository nobody connected
    server.state.lookup = { status: 404 };
    const unconnected = await run(['doctor'], { cwd: repo, env });
    assert.equal(unconnected.code, 1);
    assert.match(unconnected.stdout, /✗ acme\/app is not connected/);
    assert.match(unconnected.stdout, new RegExp(`${server.url}/install`));
    assert.doesNotMatch(unconnected.stdout, /agentmash init/);
    server.state.lookup = { status: 200, ref: CONNECTED_REF };

    // a sign-in the server no longer takes
    server.state.whoami = 401;
    const expired = await run(['doctor'], { cwd: repo, env });
    assert.equal(expired.code, 1);
    assert.match(expired.stdout, /✗ this machine's sign-in has expired or was revoked — run: npx agentmash login/);
    server.state.whoami = 200;

    // a hook script gone from under the settings that run it
    fs.rmSync(path.join(m.home, '.agentmash', 'hooks', 'post_tool_use.mjs'));
    const broken = await run(['doctor'], { cwd: repo, env });
    assert.equal(broken.code, 1);
    assert.match(broken.stdout, /✗ .*post_tool_use\.mjs.*npx agentmash login/);

    // hooks left in Claude Code by a sign-in that is gone
    assert.equal((await run(['login', '--server', server.url, '--no-open'], { env })).code, 0);
    fs.rmSync(path.join(m.home, '.agentmash', 'user.json'));
    const signedOut = await run(['doctor'], { cwd: repo, env });
    assert.equal(signedOut.code, 1);
    assert.match(signedOut.stdout, /✗ this machine is not signed in — run: npx agentmash login/);
    assert.doesNotMatch(signedOut.stdout, /agentmash init/);

    // and a server it cannot reach
    signIn(m, server.url);
    await server.close();
    const down = await run(['doctor'], { cwd: repo, env });
    assert.equal(down.code, 1);
    assert.match(down.stdout, /✗ cannot reach/);
  } finally {
    await server.close().catch(() => {});
  }
});

// The browser asks for the code the terminal shows before it signs anything
// in, and the person can cancel there, or type a code that is not this one.
// The server's own words say which; "sign-in failed (HTTP 403)" said neither.
/**
 * A server that starts a sign-in whose code works for `seconds`, answers the
 * first poll "pending", and is gone after it, as when the network drops while
 * someone signs in.
 */
function startDroppingServer(seconds) {
  const server = http.createServer((req, res) => {
    const send = (status, json, then) => {
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(json), then);
    };
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/auth/cli/start') {
      return send(201, { code: 'ABCD-EFGH', poll_token: 'poll', verify_url: `${base}/auth/github?cli=ABCD-EFGH`, expires_in: seconds });
    }
    if (req.url === '/auth/cli/token') {
      return send(202, { status: 'pending' }, () => {
        server.close();
        server.closeAllConnections();
      });
    }
    send(404, { error: 'not here' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

// Every poll the network dropped was taken for "still pending": nothing was
// said while it lasted, and when the code ran out the code was blamed.
test('a network that drops while a sign-in waits is said as the network, in login and in login --room', async () => {
  const m = machine();
  const machineServer = await startDroppingServer(5);
  const machineLogin = await run(['login', '--server', machineServer, '--no-open'], { cwd: m.home, env: m.env });
  assert.equal(machineLogin.code, 1, machineLogin.stdout + machineLogin.stderr);
  assert.match(machineLogin.stdout, /! cannot reach http:\/\/127\.0\.0\.1:\d+ right now .*— still waiting, for as long as the code works/);
  assert.match(machineLogin.stderr, /could not reach http:\/\/127\.0\.0\.1:\d+ while waiting for the sign-in .*— check this machine's network, then run: npx agentmash login --server/);
  assert.doesNotMatch(machineLogin.stderr, /code expired/);
  assert.ok(!fs.existsSync(path.join(m.home, '.agentmash', 'user.json')));

  const roomServer = await startDroppingServer(5);
  const repo = checkout({ committed: roomServer });
  const roomLogin = await run(['login', '--room'], { cwd: repo, env: m.env });
  assert.equal(roomLogin.code, 1, roomLogin.stdout + roomLogin.stderr);
  assert.match(roomLogin.stdout, /! cannot reach http:\/\/127\.0\.0\.1:\d+ right now/);
  assert.match(roomLogin.stderr, /could not reach http:\/\/127\.0\.0\.1:\d+ while waiting for the sign-in .*then run: npx agentmash login --room/);
  assert.doesNotMatch(roomLogin.stderr, /code expired/);
  assert.ok(!fs.existsSync(path.join(m.home, '.agentmash', 'credentials.json')));
});

test('a sign-in cancelled or turned down in the browser fails with what the server said', async () => {
  const server = await startServer();
  const m = machine();
  try {
    for (const [code, error] of [
      ['cancelled', 'the sign-in was cancelled in the browser'],
      ['denied', 'the code typed in the browser was not the one this terminal showed'],
    ]) {
      server.state.signIn = [{ status: 403, body: { code, error } }];
      const result = await run(['login', '--server', server.url, '--no-open'], { env: m.env });
      assert.equal(result.code, 1, code);
      assert.ok(result.stderr.includes(error), `${code}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /sign-in failed|HTTP 403/, code);
      assert.ok(!fs.existsSync(path.join(m.home, '.agentmash', 'user.json')), `${code}: nothing is signed in`);
    }
  } finally {
    await server.close();
  }
});

// What a machine can push to is what GitHub said when it signed in, and the
// server stops trusting that after 30 days: every lookup and room request is
// turned away with `reauth` until the machine signs in again. Until then
// nothing from it reaches a room, and status, doctor and init say so.
test('status, doctor and init say AgentMash is paused until this machine signs in again', async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout();
  try {
    assert.equal((await run(['login', '--server', server.url, '--no-open'], { env: m.env })).code, 0);
    server.state.reauth = true;

    const status = await run(['status'], { cwd: repo, env: m.env });
    assert.match(status.stdout, /✗ .*paused.*npx agentmash login/);

    const doctor = await run(['doctor'], { cwd: repo, env: m.env });
    assert.equal(doctor.code, 1);
    assert.match(doctor.stdout, /✗ .*paused.*npx agentmash login/);
    assert.doesNotMatch(doctor.stdout, /All good|is not connected/);

    // whether acme/app has a room already is what the lookup cannot say now:
    // init does not make a second one on a guess
    const init = await run(['init', '--server', server.url, '--no-open', '--no-git-hook'], { cwd: repo, env: m.env });
    assert.equal(init.code, 1, init.stdout);
    assert.match(init.stderr, /npx agentmash login/);
    assert.ok(!server.requests.some((r) => r.path === '/rooms' && r.method === 'POST'), 'no room was made');
  } finally {
    await server.close();
  }
});
