// The git client, exercised against real throwaway repositories: a real commit
// runs a real .git/hooks/post-commit, and the assertions are on what a mock
// coordination server actually received.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const CLI = path.join(ROOT, 'cli', 'agentmash.mjs');
const WORKER = path.join(ROOT, 'clients', 'git', 'post_commit.mjs');
const ROOM = 'mash_gittestgittestgitt';

// Git reads the global config of whoever runs the tests, and a global
// core.hooksPath (a ~/.githooks every repository shares) is where `git-hook
// install` would put the client and where a commit in a temporary repository
// would look for hooks. An empty global config keeps every git call, the CLI's
// and git()'s below, inside the temporary repositories. Set on process.env so
// both inherit it.
const EMPTY_GITCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-githook-git-')), 'gitconfig');
fs.writeFileSync(EMPTY_GITCONFIG, '');
process.env.GIT_CONFIG_GLOBAL = EMPTY_GITCONFIG;
process.env.GIT_CONFIG_NOSYSTEM = '1';
// And a home of its own, for the same reason: a real commit runs the
// installed hook with this process's environment, and the worker it starts
// keeps the key for its checkout ids under ~/.agentmash.
process.env.AGENTMASH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-githook-commit-home-'));

// A home and Claude Code settings of their own, too: on a developer's machine
// signed in with `npx agentmash login`, doctor in a repository with no room
// of its own checks that sign-in, against the real server, instead of the
// install these tests are about.
const baseEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTMASH_') && k !== 'CLAUDE_PROJECT_DIR')
  ),
  AGENTMASH_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-githook-home-')),
  CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-githook-claude-')),
};

/**
 * Two POSIX facts these tests depend on that Windows does not provide:
 * an executable bit, and unprivileged symlink creation. Probed rather than
 * assumed, so a Windows box with Developer Mode on still runs the symlink set.
 */
const HAS_FILE_MODES = process.platform !== 'win32';
const CAN_SYMLINK = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-symlink-probe-'));
  try {
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// `lookup` is what /api/lookup answers a signed-in machine, as { status, body }:
// the room a repository connected on the website is in.
function startMockServer({ delayMs = 0, lookup = null } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        room: req.headers['x-agentmash-room'],
        token: req.headers['x-agentmash-token'],
        user: req.headers['x-agentmash-user'],
        body: body ? JSON.parse(body) : null,
      });
      if (url.pathname === '/api/lookup' && lookup) {
        res.writeHead(lookup.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(lookup.body));
        return;
      }
      const respond = () => {
        res.writeHead(url.pathname === '/events' ? 201 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: requests.length }));
      };
      if (delayMs > 0) setTimeout(respond, delayMs);
      else respond();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      })
    );
  });
}

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** A repo with the client installed by hand — no room yet, callers write config. */
function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-git-test-')));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'alice@example.com']);
  git(dir, ['config', 'user.name', 'Alice']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

function writeConfig(repo, url, extra = {}) {
  fs.mkdirSync(path.join(repo, '.claude', 'agentmash'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.claude', 'agentmash', 'config.json'),
    JSON.stringify({ url, room: ROOM, label: 'test', ...extra })
  );
}

function runCli(args, { cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...baseEnv, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code,
        stdout: stdout.replace(/\[[0-9;]*m/g, ''),
        stderr: stderr.replace(/\[[0-9;]*m/g, ''),
      })
    );
  });
}

/** Run the worker the way the shim does, but in the foreground so we can await it. */
function runWorker(repo, env = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, [WORKER, repo], {
      cwd: repo,
      env: { ...baseEnv, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, elapsed: Date.now() - start }));
  });
}

/** The real hook backgrounds itself, so a real commit reports asynchronously. */
async function waitForEvents(mock, count, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (mock.requests.filter((r) => r.path === '/events').length >= count) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const commit = (repo, message) => git(repo, ['commit', '-q', '-m', message]);

/** Each call in `source` to one of `names`, from the name to its closing parenthesis. */
function callsOf(source, names) {
  const calls = [];
  for (const m of source.matchAll(new RegExp(`\\b(?:${names.join('|')})\\(`, 'g'))) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    calls.push(source.slice(m.index, end + 1));
  }
  return calls;
}

// ---------------------------------------------------------------------------
// End to end: a real commit in a real repo
// ---------------------------------------------------------------------------

test('a real commit reports one edit event per file, plus a session_end', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await runCli(['git-hook', 'install'], { cwd: repo });
    writeConfig(repo, mock.url);

    fs.mkdirSync(path.join(repo, 'src', 'models'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'models', 'user.ts'), 'export interface User {\n  id: string;\n}\n');
    fs.writeFileSync(path.join(repo, 'src', 'models', 'index.ts'), 'export * from "./user";\n');
    git(repo, ['add', 'src']);
    commit(repo, 'Add soft deletes to the user model');

    assert.ok(await waitForEvents(mock, 3), `only got ${mock.requests.length} requests`);
    await new Promise((r) => setTimeout(r, 200)); // let any stragglers land
    const events = mock.requests.filter((r) => r.path === '/events').map((r) => r.body);
    const edits = events.filter((e) => e.event_type === 'edit');
    const ends = events.filter((e) => e.event_type === 'session_end');

    assert.equal(edits.length, 2);
    assert.equal(ends.length, 1);
    assert.deepEqual(
      edits.map((e) => e.file_path).sort(),
      ['src/models/index.ts', 'src/models/user.ts'],
      'paths must be repo-relative with forward slashes'
    );
    for (const e of edits) {
      assert.equal(e.developer, 'alice@example.com', 'identity comes from git config, like every other client');
      assert.equal(e.tool, 'git-commit', 'tool is what carries client provenance');
      assert.equal(e.git_branch, 'main');
      assert.equal(e.task_hint, 'Add soft deletes to the user model', 'the commit subject is the task hint');
      assert.match(e.change_summary, /^commit [0-9a-f]{7} · \+\d+\/-\d+ lines$/);
      assert.match(e.session_id, /^commit-[0-9a-f]{7}$/);
      assert.ok(Date.parse(e.timestamp), 'timestamp is the commit time, parseable');
    }
    // Every event of one commit belongs to one session, and that session is over.
    assert.equal(new Set(events.map((e) => e.session_id)).size, 1);
    assert.equal(ends[0].session_id, edits[0].session_id);
    assert.equal(mock.requests[0].room, ROOM);
  } finally {
    await mock.close();
  }
});

test('the same commit is never reported twice', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    writeConfig(repo, mock.url);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);
    commit(repo, 'Add a');

    await runWorker(repo);
    const afterFirst = mock.requests.length;
    assert.ok(afterFirst >= 2);

    // post-commit fires again for the same sha on a cherry-pick, or on a
    // reset-then-recommit that reproduces it. The protocol does not dedupe.
    await runWorker(repo);
    assert.equal(mock.requests.length, afterFirst, 'a second run of the same commit must send nothing');

    // A new commit still gets through.
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    git(repo, ['add', 'b.txt']);
    commit(repo, 'Add b');
    await runWorker(repo);
    assert.ok(mock.requests.length > afterFirst, 'a new commit must still be reported');
  } finally {
    await mock.close();
  }
});

// A commit's subject is what its author says they did, and the git client
// sends it as the task hint the hooks send a prompt as: AGENTMASH_HINTS=0
// keeps it on the machine the way it keeps a prompt there.
test('AGENTMASH_HINTS=0 keeps the commit subject on this machine', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    writeConfig(repo, mock.url);
    fs.writeFileSync(path.join(repo, 'billing.ts'), 'export const key = 1;\n');
    git(repo, ['add', 'billing.ts']);
    commit(repo, 'Rotate the STRIPE_KEY in billing');

    const result = await runWorker(repo, { AGENTMASH_HINTS: '0' });
    assert.equal(result.code, 0);
    const events = mock.requests.filter((r) => r.path === '/events');
    assert.deepEqual(events.map((r) => r.body.event_type).sort(), ['edit', 'session_end'], 'the commit is still reported');
    for (const req of events) {
      assert.ok(!JSON.stringify(req).includes('STRIPE_KEY'), 'the subject is in no request');
      assert.equal(req.body.task_hint, null);
    }
    assert.equal(events.find((r) => r.body.event_type === 'edit').body.file_path, 'billing.ts');
  } finally {
    await mock.close();
  }
});

// A key pasted into a commit message goes no further than the commit: the
// subject reaches the room with it masked, as a prompt's would (redactSecrets
// in hooks/lib.mjs). Put together from parts, so no scanner takes it for a key.
test('a secret in the commit subject reaches the room masked', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  const key = ['sk', '_live_', '51H', 'q'.repeat(30)].join('');
  const token = ['glpat', '-', 'abcdefghij0123456789'].join('');
  try {
    writeConfig(repo, mock.url);
    fs.writeFileSync(path.join(repo, 'billing.ts'), 'export const key = 1;\n');
    git(repo, ['add', 'billing.ts']);
    commit(repo, `Rotate ${key} and ${token} in billing`);

    const result = await runWorker(repo);
    assert.equal(result.code, 0);
    const events = mock.requests.filter((r) => r.path === '/events');
    assert.deepEqual(events.map((r) => r.body.event_type).sort(), ['edit', 'session_end']);
    for (const req of events) {
      assert.equal(req.body.task_hint, 'Rotate [hidden] and [hidden] in billing');
      assert.ok(!JSON.stringify(req).includes(key) && !JSON.stringify(req).includes(token), 'the secret is in no request');
    }
  } finally {
    await mock.close();
  }
});

test('a room that wants a developer token gets the one this machine holds for it', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-githook-home-'));
  fs.mkdirSync(path.join(home, '.agentmash'));
  fs.writeFileSync(
    path.join(home, '.agentmash', 'credentials.json'),
    JSON.stringify({ version: 1, tokens: { [`${mock.url}|rm_gitroom0001`]: { token: 'amt_gittokengittokengittokeng', developer: 'alice' } } })
  );
  try {
    writeConfig(repo, mock.url, { room_ref: 'rm_gitroom0001' });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);
    commit(repo, 'Add a');

    await runWorker(repo, { AGENTMASH_HOME: home });
    const events = mock.requests.filter((r) => r.path === '/events');
    assert.equal(events.length, 2);
    for (const req of events) {
      assert.equal(req.room, ROOM);
      assert.equal(req.token, 'amt_gittokengittokengittokeng', req.body.event_type);
      assert.equal(req.user, undefined);
    }
  } finally {
    await mock.close();
  }
});

// A key committed to a public repository opens its room only beside the
// sign-in of someone who can push there (the server's room_key_public), so the
// client sends this machine's `npx agentmash login` beside the key, as the
// hooks do, to the server it signed in to and no other.
test("a signed-in machine's commit reports carry its sign-in beside the key, to that server only", async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-githook-home-'));
  fs.mkdirSync(path.join(home, '.agentmash'));
  const signIn = (url) =>
    fs.writeFileSync(
      path.join(home, '.agentmash', 'user.json'),
      JSON.stringify({ url, token: 'amu_gitsignin0gitsignin0gitsig', login: 'alice' })
    );
  try {
    writeConfig(repo, mock.url);
    signIn(mock.url);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);
    commit(repo, 'Add a');
    await runWorker(repo, { AGENTMASH_HOME: home });
    const events = mock.requests.filter((r) => r.path === '/events');
    assert.equal(events.length, 2);
    for (const req of events) {
      assert.equal(req.room, ROOM);
      assert.equal(req.user, 'amu_gitsignin0gitsignin0gitsig', req.body.event_type);
    }

    // signed in to another server: the key goes alone
    signIn('https://agentmash.example');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    git(repo, ['add', 'b.txt']);
    commit(repo, 'Add b');
    await runWorker(repo, { AGENTMASH_HOME: home });
    const alone = mock.requests.filter((r) => r.path === '/events').slice(2);
    assert.equal(alone.length, 2);
    for (const req of alone) assert.equal(req.user, undefined, req.body.event_type);
  } finally {
    await mock.close();
  }
});

// The main flow: someone connects the repository on the website, each developer
// runs `npx agentmash login`, and nothing is committed, so there is no
// config.json to read a room from. The worker finds the room the way the
// login's hooks do (lib.resolveConfig): it asks the server which room this
// checkout's GitHub repository is connected to, under the machine's sign-in.
test("in a repository connected on the website, a signed-in machine's commits reach the room it is connected to", async () => {
  const signedIn = 'amu_gitlookup0gitlookup0gitloo';
  const mock = await startMockServer({ lookup: { status: 200, body: { room_ref: 'rm_gitlookup0001', developer: 'alice' } } });
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-githook-home-'));
  fs.mkdirSync(path.join(home, '.agentmash'));
  fs.writeFileSync(path.join(home, '.agentmash', 'user.json'), JSON.stringify({ url: mock.url, token: signedIn, login: 'alice' }));
  try {
    git(repo, ['remote', 'add', 'origin', 'git@github.com:Acme/Widgets.git']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);
    commit(repo, 'Add a');
    await runWorker(repo, { AGENTMASH_HOME: home });

    const lookups = mock.requests.filter((r) => r.path === '/api/lookup');
    assert.equal(lookups.length, 1);
    assert.equal(lookups[0].query.repo, 'acme/widgets');
    assert.equal(lookups[0].user, signedIn);
    const events = mock.requests.filter((r) => r.path === '/events');
    assert.deepEqual(events.map((r) => r.body.event_type), ['edit', 'session_end']);
    for (const req of events) {
      assert.equal(req.room, 'rm_gitlookup0001', req.body.event_type);
      assert.equal(req.user, signedIn, req.body.event_type);
      assert.equal(req.token, undefined, req.body.event_type);
      assert.equal(req.body.developer, 'alice');
    }
    assert.equal(events[0].body.file_path, 'a.txt');

    // the room a repository carries is its own, and is never looked up or swapped
    writeConfig(repo, mock.url);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    git(repo, ['add', 'b.txt']);
    commit(repo, 'Add b');
    await runWorker(repo, { AGENTMASH_HOME: home });
    assert.equal(mock.requests.filter((r) => r.path === '/api/lookup').length, 1);
    const own = mock.requests.filter((r) => r.path === '/events').slice(2);
    assert.equal(own.length, 2);
    for (const req of own) assert.equal(req.room, ROOM, req.body.event_type);
  } finally {
    await mock.close();
  }
});

test('a signed-in machine reports nothing for a repository that is not connected, or with no GitHub remote', async () => {
  const mock = await startMockServer({ lookup: { status: 404, body: { error: 'not connected', code: 'not_connected' } } });
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-githook-home-'));
  fs.mkdirSync(path.join(home, '.agentmash'));
  fs.writeFileSync(path.join(home, '.agentmash', 'user.json'), JSON.stringify({ url: mock.url, token: 'amu_gitnone0gitnone0gitnone0gi', login: 'alice' }));
  try {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);
    commit(repo, 'Add a');
    // no GitHub remote: nothing to look a room up by
    assert.equal((await runWorker(repo, { AGENTMASH_HOME: home })).code, 0);
    assert.equal(mock.requests.length, 0);

    git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    git(repo, ['add', 'b.txt']);
    commit(repo, 'Add b');
    assert.equal((await runWorker(repo, { AGENTMASH_HOME: home })).code, 0);
    assert.deepEqual(mock.requests.map((r) => r.path), ['/api/lookup']);
  } finally {
    await mock.close();
  }
});

test('merge commits are skipped rather than claiming the whole branch', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    writeConfig(repo, mock.url);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    git(repo, ['add', 'base.txt']);
    commit(repo, 'Base');

    git(repo, ['checkout', '-q', '-b', 'side']);
    fs.writeFileSync(path.join(repo, 'side.txt'), 'side\n');
    git(repo, ['add', 'side.txt']);
    commit(repo, 'Side work');

    git(repo, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(repo, 'main.txt'), 'main\n');
    git(repo, ['add', 'main.txt']);
    commit(repo, 'Main work');

    mock.requests.length = 0;
    git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge side', 'side']);
    await runWorker(repo);
    assert.equal(mock.requests.length, 0, 'a merge commit must report nothing');
  } finally {
    await mock.close();
  }
});

test("agentmash's own install is not a teammate's work: its files are never reported, nor a commit of only them", async () => {
  // The e2e run that found this: the commit that added .claude/agentmash/
  // reported sixteen edits of its scripts, a hot zone nobody was working in.
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    writeConfig(repo, mock.url);
    for (const file of ['lib.mjs', 'pre_tool_use.mjs', 'mcp_server.mjs']) {
      fs.writeFileSync(path.join(repo, '.claude', 'agentmash', file), `// ${file}\n`);
    }
    git(repo, ['add', '-f', '.claude/agentmash']);
    commit(repo, 'add agentmash');
    await runWorker(repo);
    assert.equal(mock.requests.length, 0, 'a commit of only the install reports nothing, not even a session');

    // a commit with work in it reports the work, and not the install beside it
    fs.writeFileSync(path.join(repo, '.claude', 'agentmash', 'lib.mjs'), '// a newer lib\n');
    fs.mkdirSync(path.join(repo, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'agents', 'reviewer.md'), 'a team agent\n');
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const app = 1;\n');
    git(repo, ['add', '-f', '-A']);
    commit(repo, 'app, and agentmash brought up to date');
    await runWorker(repo);
    const edits = mock.requests.map((r) => r.body).filter((b) => b.event_type === 'edit');
    assert.deepEqual(edits.map((e) => e.file_path).sort(), ['.claude/agents/reviewer.md', 'app.ts']);
    assert.equal(mock.requests.filter((r) => r.body?.event_type === 'session_end').length, 1);
  } finally {
    await mock.close();
  }
});

test('a binary file is reported honestly rather than as a line count', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    writeConfig(repo, mock.url);
    fs.writeFileSync(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    git(repo, ['add', 'logo.png']);
    commit(repo, 'Add the logo');
    await runWorker(repo);
    const edit = mock.requests.map((r) => r.body).find((b) => b.event_type === 'edit');
    assert.equal(edit.file_path, 'logo.png');
    assert.match(edit.change_summary, /binary file/);
  } finally {
    await mock.close();
  }
});

// A teammate about to edit a file this commit removed is told it is gone,
// not that lines in it changed (removalOf in hooks/lib.mjs reads the word).
test('a deleted file is reported as deleted rather than as lines taken out', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    writeConfig(repo, mock.url);
    fs.writeFileSync(path.join(repo, 'old.ts'), 'export function oldThing() {\n  return 2;\n}\n');
    fs.writeFileSync(path.join(repo, 'keep.ts'), 'export const k = 1;\n');
    git(repo, ['add', '-A']);
    commit(repo, 'Add both');
    await runWorker(repo);
    mock.requests.length = 0;

    git(repo, ['rm', '-q', 'old.ts']);
    fs.appendFileSync(path.join(repo, 'keep.ts'), 'export const j = 2;\n');
    git(repo, ['add', '-A']);
    commit(repo, 'Remove the old helper');
    await runWorker(repo);
    const edits = Object.fromEntries(
      mock.requests.map((r) => r.body).filter((b) => b.event_type === 'edit').map((b) => [b.file_path, b.change_summary])
    );
    assert.match(edits['old.ts'], /^commit [0-9a-f]{7} · deleted$/);
    assert.match(edits['keep.ts'], /^commit [0-9a-f]{7} · \+1\/-0 lines$/);
  } finally {
    await mock.close();
  }
});

// git quotes a name with a byte past ASCII in it ("\320\277\321\200....md" for
// привет.md) unless it is asked not to, and a quoted name is a file nobody has:
// no teammate's edit of привет.md would ever meet it in the room.
test('a file named past ASCII is reported by its own name, added or deleted', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    writeConfig(repo, mock.url);
    fs.mkdirSync(path.join(repo, 'заметки'));
    fs.writeFileSync(path.join(repo, 'заметки', 'старое.md'), 'one\n');
    git(repo, ['add', '-A']);
    commit(repo, 'Add the notes');
    await runWorker(repo);
    assert.deepEqual(
      mock.requests.map((r) => r.body).filter((b) => b.event_type === 'edit').map((b) => b.file_path),
      ['заметки/старое.md']
    );
    mock.requests.length = 0;

    git(repo, ['rm', '-q', 'заметки/старое.md']);
    fs.writeFileSync(path.join(repo, 'привет мир.md'), 'hello\nworld\n');
    git(repo, ['add', '-A']);
    commit(repo, 'Swap the notes');
    await runWorker(repo);
    const edits = Object.fromEntries(
      mock.requests.map((r) => r.body).filter((b) => b.event_type === 'edit').map((b) => [b.file_path, b.change_summary])
    );
    assert.deepEqual(Object.keys(edits).sort(), ['заметки/старое.md', 'привет мир.md']);
    assert.match(edits['заметки/старое.md'], /^commit [0-9a-f]{7} · deleted$/);
    assert.match(edits['привет мир.md'], /^commit [0-9a-f]{7} · \+2\/-0 lines$/);
  } finally {
    await mock.close();
  }
});

// A console program started from a process with no console of its own (the
// worker, backgrounded by a GUI git client) opens a console window on Windows
// unless it is told not to: one flashing up for every git it runs, every commit.
test('the worker starts every git without a console window', () => {
  const source = fs.readFileSync(WORKER, 'utf8');
  const calls = callsOf(source, ['execFileSync', 'execFile', 'spawnSync', 'spawn']);
  assert.ok(calls.length >= 1, 'the worker runs git');
  for (const call of calls) assert.match(call, /windowsHide: true/, call);
});

// ---------------------------------------------------------------------------
// Coexistence with a hook the team already has
// ---------------------------------------------------------------------------

test('installing alongside an existing post-commit hook keeps it running', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    const hooks = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const witness = path.join(repo, 'existing-hook-ran.txt');
    fs.writeFileSync(
      path.join(hooks, 'post-commit'),
      `#!/bin/sh\necho "the team's own hook" >> "${witness}"\n`
    );
    fs.chmodSync(path.join(hooks, 'post-commit'), 0o755);

    const install = await runCli(['git-hook', 'install'], { cwd: repo });
    assert.equal(install.code, 0, install.stderr);
    assert.match(install.stdout, /alongside the one already there/);

    // Theirs was preserved byte-for-byte, ours is in front of it.
    assert.match(fs.readFileSync(path.join(hooks, 'post-commit.local'), 'utf8'), /the team's own hook/);
    assert.match(fs.readFileSync(path.join(hooks, 'post-commit'), 'utf8'), /agentmash-git-hook/);

    writeConfig(repo, mock.url);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);
    commit(repo, 'Add a');

    assert.ok(fs.existsSync(witness), "the team's existing hook must still run");
    assert.ok(await waitForEvents(mock, 2), 'and ours must still report');

    // Uninstall puts their hook back exactly where it was.
    const removed = await runCli(['git-hook', 'uninstall'], { cwd: repo });
    assert.equal(removed.code, 0, removed.stderr);
    assert.ok(!fs.existsSync(path.join(hooks, 'post-commit.local')));
    assert.match(fs.readFileSync(path.join(hooks, 'post-commit'), 'utf8'), /the team's own hook/);

    fs.rmSync(witness);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    git(repo, ['add', 'b.txt']);
    commit(repo, 'Add b');
    assert.ok(fs.existsSync(witness), "their hook must keep working after we're gone");
  } finally {
    await mock.close();
  }
});

test("an existing hook's file mode is preserved, not quietly enabled", { skip: HAS_FILE_MODES ? false : "no POSIX file modes on this platform" }, async () => {
  const repo = makeRepo();
  const hooks = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  // git ignores a non-executable hook. Chmodding it on the way to
  // post-commit.local would start running something that was inert.
  fs.writeFileSync(path.join(hooks, 'post-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });

  await runCli(['git-hook', 'install'], { cwd: repo });
  assert.equal(fs.statSync(path.join(hooks, 'post-commit.local')).mode & 0o111, 0, 'must stay non-executable');
  assert.notEqual(fs.statSync(path.join(hooks, 'post-commit')).mode & 0o100, 0, 'ours must be executable');

  await runCli(['git-hook', 'uninstall'], { cwd: repo });
  assert.equal(fs.statSync(path.join(hooks, 'post-commit')).mode & 0o111, 0, 'restored with its original mode');
});

test('a foreign post-commit hook is never removed by uninstall', async () => {
  const repo = makeRepo();
  const hooks = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'post-commit'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(hooks, 'post-commit'), 0o755);

  const result = await runCli(['git-hook', 'uninstall'], { cwd: repo });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /not ours/);
  assert.equal(fs.readFileSync(path.join(hooks, 'post-commit'), 'utf8'), '#!/bin/sh\nexit 0\n');
});

test('reinstalling is idempotent and does not chain the hook to itself', async () => {
  const repo = makeRepo();
  const hooks = path.join(repo, '.git', 'hooks');
  await runCli(['git-hook', 'install'], { cwd: repo });
  await runCli(['git-hook', 'install'], { cwd: repo });
  assert.ok(!fs.existsSync(path.join(hooks, 'post-commit.local')), 'must not chain our own hook');
  assert.match(fs.readFileSync(path.join(hooks, 'post-commit'), 'utf8'), /agentmash-git-hook/);
});

// ---------------------------------------------------------------------------
// The fail-open contract
// ---------------------------------------------------------------------------

test('a commit is unaffected when the server is down', async () => {
  const mock = await startMockServer();
  const deadUrl = mock.url;
  await mock.close();

  const repo = makeRepo();
  await runCli(['git-hook', 'install'], { cwd: repo });
  writeConfig(repo, deadUrl);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', 'a.txt']);

  const started = Date.now();
  const output = git(repo, ['commit', '-m', 'Add a']);
  const elapsed = Date.now() - started;

  assert.ok(!/agentmash/i.test(output), `the commit must not mention us: ${output}`);
  assert.ok(elapsed < 3000, `commit took ${elapsed}ms with the server down`);
  assert.equal(git(repo, ['log', '-1', '--format=%s']).trim(), 'Add a');

  const worker = await runWorker(repo, { AGENTMASH_URL: deadUrl, AGENTMASH_ROOM: ROOM });
  assert.equal(worker.code, 0, 'the worker must exit 0 with the server down');
  assert.equal(worker.stdout, '');
  assert.equal(worker.stderr, '');
  assert.ok(worker.elapsed < 3000, `worker took ${worker.elapsed}ms with the server down`);
});

test('a commit is unaffected when the server hangs', async () => {
  const mock = await startMockServer({ delayMs: 30_000 });
  const repo = makeRepo();
  try {
    await runCli(['git-hook', 'install'], { cwd: repo });
    writeConfig(repo, mock.url);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);

    const started = Date.now();
    git(repo, ['commit', '-m', 'Add a']);
    const elapsed = Date.now() - started;
    // The whole point of backgrounding: git never waits on the network at all.
    assert.ok(elapsed < 3000, `commit took ${elapsed}ms against a hung server`);
  } finally {
    await mock.close();
  }
});

test('the worker does nothing without a room, and honours the kill switch', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);
    commit(repo, 'Add a');

    const unconfigured = await runWorker(repo);
    assert.equal(unconfigured.code, 0);
    assert.equal(mock.requests.length, 0, 'an unconfigured repo must send nothing');

    writeConfig(repo, mock.url);
    const disabled = await runWorker(repo, { AGENTMASH_DISABLE: '1' });
    assert.equal(disabled.code, 0);
    assert.equal(mock.requests.length, 0, 'AGENTMASH_DISABLE=1 must silence the client');
  } finally {
    await mock.close();
  }
});

test('the hook is inert in a repo that never installed the worker', async () => {
  const repo = makeRepo();
  await runCli(['git-hook', 'install'], { cwd: repo });
  fs.rmSync(path.join(repo, '.claude'), { recursive: true, force: true });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', 'a.txt']);
  const output = git(repo, ['commit', '-m', 'Add a']);
  assert.ok(!/error|not found|No such file/i.test(output), output);
  assert.equal(git(repo, ['log', '-1', '--format=%s']).trim(), 'Add a');
});

// ---------------------------------------------------------------------------
// Install / uninstall through the CLI
// ---------------------------------------------------------------------------

test('init installs the git client by default and uninstall removes it', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    // `init` wants a real /rooms response; the git-hook path is what matters here.
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      res.writeHead(url.pathname === '/rooms' ? 201 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, room: ROOM, label: 'test', server_url: `http://127.0.0.1:${server.address().port}` }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;

    const init = await runCli(['init', '--server', url], { cwd: repo });
    assert.equal(init.code, 0, init.stderr);
    assert.match(init.stdout, /git post-commit hook installed/);
    assert.ok(isOurs(repo), 'the hook should be installed');
    assert.ok(
      fs.existsSync(path.join(repo, '.claude', 'agentmash', 'git_post_commit.mjs')),
      'the worker travels with the repo'
    );

    const removed = await runCli(['uninstall'], { cwd: repo });
    assert.equal(removed.code, 0, removed.stderr);
    assert.ok(!fs.existsSync(path.join(repo, '.git', 'hooks', 'post-commit')), 'the hook should be gone');

    await new Promise((r) => server.close(r));
  } finally {
    await mock.close();
  }
});

test('--no-git-hook opts out', async () => {
  const repo = makeRepo();
  const server = http.createServer((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ room: ROOM, label: 'test', server_url: `http://127.0.0.1:${server.address().port}` }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  const init = await runCli(['init', '--server', url, '--no-git-hook'], { cwd: repo });
  assert.equal(init.code, 0, init.stderr);
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'hooks', 'post-commit')));
  // The flag must not have been eaten as a value for --server.
  assert.match(init.stdout, /AgentMash is wired up/);
  await new Promise((r) => server.close(r));
});

// In a repository connected on the website there is no config.json, and
// "no room yet, run init" is not true of it on a machine signed in with
// `npx agentmash login`: the worker reports to the room the repository is
// connected to. git-hook install says that, from the same lookup, brings up
// to date a worker an earlier install left, and a real commit then lands there.
test('git-hook install in a repository connected on the website says where its commits go, and they go there', async () => {
  const signedIn = 'amu_githookroom0githookroom0gi';
  const mock = await startMockServer({ lookup: { status: 200, body: { room_ref: 'rm_githookroom001', developer: 'alice' } } });
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-githook-home-'));
  fs.mkdirSync(path.join(home, '.agentmash'));
  fs.writeFileSync(path.join(home, '.agentmash', 'user.json'), JSON.stringify({ url: mock.url, token: signedIn, login: 'alice' }));
  try {
    git(repo, ['remote', 'add', 'origin', 'https://github.com/Acme/Widgets.git']);
    // a worker from an earlier install, from before it looked a room up
    fs.mkdirSync(path.join(repo, '.claude', 'agentmash'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'agentmash', 'git_post_commit.mjs'), '// an older worker\n');

    const installed = await runCli(['git-hook', 'install'], { cwd: repo, env: { AGENTMASH_HOME: home } });
    assert.equal(installed.code, 0, installed.stderr);
    assert.match(installed.stdout, /this repo's commits go to the room acme\/widgets is connected to, under this machine's sign-in/);
    assert.doesNotMatch(installed.stdout, /no room yet/);
    assert.equal(
      fs.readFileSync(path.join(repo, '.claude', 'agentmash', 'git_post_commit.mjs'), 'utf8').replace(/\r\n/g, '\n'),
      fs.readFileSync(WORKER, 'utf8').replace(/\r\n/g, '\n'),
      'the worker is brought up to date'
    );

    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);
    execFileSync('git', ['commit', '-q', '-m', 'Add a'], { cwd: repo, env: { ...baseEnv, AGENTMASH_HOME: home }, stdio: 'ignore' });
    assert.ok(await waitForEvents(mock, 2), `only got ${mock.requests.map((r) => r.path).join(', ')}`);
    const events = mock.requests.filter((r) => r.path === '/events');
    assert.deepEqual(events.map((r) => r.body.event_type).sort(), ['edit', 'session_end']);
    for (const req of events) {
      assert.equal(req.room, 'rm_githookroom001', req.body.event_type);
      assert.equal(req.user, signedIn, req.body.event_type);
    }
  } finally {
    await mock.close();
  }
});

// A room in AGENTMASH_ROOM, from the environment or a .env, is the one the
// worker reports to with its key (loadConfig), and it never looks one up.
test('git-hook install with AGENTMASH_ROOM set says its commits go to that room, not one looked up', async () => {
  const mock = await startMockServer({ lookup: { status: 200, body: { room_ref: 'rm_githookenv0001', developer: 'alice' } } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-githook-home-'));
  fs.mkdirSync(path.join(home, '.agentmash'));
  fs.writeFileSync(path.join(home, '.agentmash', 'user.json'), JSON.stringify({ url: mock.url, token: 'amu_githookenv0githookenv0githo', login: 'alice' }));
  try {
    const dotEnv = makeRepo();
    git(dotEnv, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
    fs.writeFileSync(path.join(dotEnv, '.env'), `AGENTMASH_ROOM=${ROOM}\nAGENTMASH_URL=${mock.url}\n`);
    const fromFile = await runCli(['git-hook', 'install'], { cwd: dotEnv, env: { AGENTMASH_HOME: home } });
    assert.equal(fromFile.code, 0, fromFile.stderr);
    assert.match(fromFile.stdout, /this repo's commits go to the room AGENTMASH_ROOM names \(in a \.env here\), not one looked up by its GitHub repository/);
    assert.doesNotMatch(fromFile.stdout, /is connected to|reach no one/);

    const shell = makeRepo();
    git(shell, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
    const fromEnv = await runCli(['git-hook', 'install'], { cwd: shell, env: { AGENTMASH_HOME: home, AGENTMASH_ROOM: ROOM } });
    assert.equal(fromEnv.code, 0, fromEnv.stderr);
    assert.match(fromEnv.stdout, /the room AGENTMASH_ROOM names \(in your environment\)/);
    assert.equal(mock.requests.filter((r) => r.path === '/api/lookup').length, 0, 'nothing looked up');

    // and the worker does report there, with the key
    fs.writeFileSync(path.join(dotEnv, 'a.txt'), 'one\n');
    git(dotEnv, ['add', 'a.txt']);
    commit(dotEnv, 'Add a');
    await runWorker(dotEnv, { AGENTMASH_HOME: home });
    // the commit's own hook reports in the background too, so how many reports have landed depends on the
    // machine: what holds is that each one went to the room AGENTMASH_ROOM names. the hook's worker notes the
    // commit before it sends, so the one run here may skip it while the hook's report is still on its way: wait for it
    assert.ok(await waitForEvents(mock, 1), 'the commit was reported');
    const events = mock.requests.filter((r) => r.path === '/events');
    assert.deepEqual([...new Set(events.map((r) => r.room))], [ROOM]);
    assert.equal(mock.requests.filter((r) => r.path === '/api/lookup').length, 0);
  } finally {
    await mock.close();
  }
});

// The files an install put in .claude/agentmash are the team's once someone
// commits them, with config.json or without it (a room in .env, a
// config.json left out): bringing them up to date is init's, which says to
// commit them. git-hook install leaves them as they are.
test('git-hook install leaves the install files git tracks as they are, with no config.json beside them', async () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, '.claude', 'agentmash'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'agentmash', 'git_post_commit.mjs'), '// a worker from an older install\n');
  fs.writeFileSync(path.join(repo, '.claude', 'agentmash', 'lib.mjs'), '// a lib from an older install\n');
  git(repo, ['add', '.claude']);
  commit(repo, 'Add agentmash');

  const installed = await runCli(['git-hook', 'install'], { cwd: repo });
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal(git(repo, ['status', '--porcelain', '--untracked-files=all']), '', 'nothing in the working tree changed');
  assert.ok(fs.readFileSync(path.join(repo, '.git', 'hooks', 'post-commit'), 'utf8').includes('agentmash-git-hook'), 'the hook is installed');
});

test('git-hook install with no room to report to says so, and what gives it one', async () => {
  // can_push: this sign-in listed the repository, so it is simply not connected
  const mock = await startMockServer({ lookup: { status: 404, body: { error: 'not connected', code: 'not_connected', can_push: true } } });
  try {
    // not signed in: a login finds the room of a repository connected on the website, init makes one
    const repo = makeRepo();
    const alone = await runCli(['git-hook', 'install'], { cwd: repo });
    assert.equal(alone.code, 0, alone.stderr);
    assert.match(alone.stdout, /this repo has no room of its own, and this machine is not signed in, so its commits reach no one yet/);
    assert.match(alone.stdout, /run npx agentmash login if the repository is connected on the website, or npx agentmash init to give it a room/);

    // signed in, for a repository nobody connected
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-githook-home-'));
    fs.mkdirSync(path.join(home, '.agentmash'));
    fs.writeFileSync(path.join(home, '.agentmash', 'user.json'), JSON.stringify({ url: mock.url, token: 'amu_githooknone0githooknone0gi', login: 'alice' }));
    const unconnected = makeRepo();
    git(unconnected, ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
    const none = await runCli(['git-hook', 'install'], { cwd: unconnected, env: { AGENTMASH_HOME: home } });
    assert.equal(none.code, 0, none.stderr);
    assert.match(none.stdout, new RegExp(`acme/widgets is not connected to a room, so its commits reach no one yet — connect it at ${mock.url}/install`));

    assert.doesNotMatch(none.stdout, /already connected\?/, 'a sign-in again changes nothing');

    // signed in, with no GitHub remote to look a room up by
    const local = await runCli(['git-hook', 'install'], { cwd: makeRepo(), env: { AGENTMASH_HOME: home } });
    assert.match(local.stdout, /no GitHub remote to look one up by, so its commits reach no one yet/);
    assert.equal(mock.requests.filter((r) => r.path === '/api/lookup').length, 1);
  } finally {
    await mock.close();
  }
});

// The server answers not_connected for a connected repository too, when this
// sign-in couldn't push to it when it last signed in (can_push: false), as in
// an organization that limits third-party apps. git-hook install says what
// may hide it, as status and doctor do (sayLookupMiss).
test("git-hook install says what may hide a repository this sign-in couldn't push to", async () => {
  const mock = await startMockServer({ lookup: { status: 404, body: { error: 'not connected', code: 'not_connected', can_push: false } } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-githook-home-'));
  fs.mkdirSync(path.join(home, '.agentmash'));
  fs.writeFileSync(path.join(home, '.agentmash', 'user.json'), JSON.stringify({ url: mock.url, token: 'amu_githookhide0githookhide0gi', login: 'alice' }));
  try {
    const repo = makeRepo();
    git(repo, ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
    // GitHub is the mock too, which says nothing of who acme is
    const hidden = await runCli(['git-hook', 'install'], { cwd: repo, env: { AGENTMASH_HOME: home, AGENTMASH_GITHUB_API: mock.url } });
    assert.equal(hidden.code, 0, hidden.stderr);
    assert.match(hidden.stdout, /acme\/widgets is not connected to a room, so its commits reach no one yet/);
    assert.match(hidden.stdout, /already connected\? you may not have been able to push to it when you signed in: run npx agentmash login again/);
    assert.match(hidden.stdout, /if acme is an organization: if it limits third-party apps/);
  } finally {
    await mock.close();
  }
});

test('doctor says so when the git client is missing, without failing', async () => {
  const repo = makeRepo();
  const result = await runCli(['doctor'], { cwd: repo });
  assert.match(result.stdout, /no git post-commit client/);
  assert.match(result.stdout, /agentmash git-hook install/);
});

function isOurs(repo) {
  try {
    return fs.readFileSync(path.join(repo, '.git', 'hooks', 'post-commit'), 'utf8').includes('agentmash-git-hook');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// What is already at the hook path
//
// The installer writes an executable file to a path it does not control. Every
// one of these is about refusing to do that when the path is not a plain file
// we may replace. (A path we cannot even stat — a hooks dir with the read bit
// off — is handled in installGitHook but not tested here: these tests run as
// root in CI, where the permission bits do not apply.)
// ---------------------------------------------------------------------------

/** A directory outside any repo, standing in for "somewhere on your filesystem". */
function elsewhere() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-victim-')));
}

test('a dangling post-commit symlink is refused, not written through', { skip: CAN_SYMLINK ? false : 'symlink creation not permitted on this platform' }, async () => {
  const repo = makeRepo();
  const victim = path.join(elsewhere(), 'VICTIM_FILE');
  const hooks = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.symlinkSync(victim, path.join(hooks, 'post-commit'));

  const result = await runCli(['git-hook', 'install'], { cwd: repo });

  assert.equal(fs.existsSync(victim), false, 'nothing may be created at the link target');
  assert.equal(fs.readlinkSync(path.join(hooks, 'post-commit')), victim, 'the link itself is left alone');
  assert.ok(!fs.existsSync(path.join(hooks, 'post-commit.local')), 'and nothing is moved aside');
  assert.match(result.stdout + result.stderr, /symlink/i, 'and the refusal says why');
  assert.equal(result.code, 0, 'refusing is not a crash');
});

test('a post-commit symlink to a real file is refused, target untouched', { skip: CAN_SYMLINK ? false : 'symlink creation not permitted on this platform' }, async () => {
  const repo = makeRepo();
  const target = path.join(elsewhere(), 'their-hook.sh');
  fs.writeFileSync(target, '#!/bin/sh\necho theirs\n', { mode: 0o644 });
  const hooks = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.symlinkSync(target, path.join(hooks, 'post-commit'));

  const result = await runCli(['git-hook', 'install'], { cwd: repo });

  assert.equal(fs.readFileSync(target, 'utf8'), '#!/bin/sh\necho theirs\n', 'their file is not rewritten');
  assert.equal(fs.statSync(target).mode & 0o111, 0, 'and is not made executable');
  assert.match(result.stdout + result.stderr, /symlink/i);
});

test('a dangling post-commit.local symlink is refused before anything is moved', { skip: CAN_SYMLINK ? false : 'symlink creation not permitted on this platform' }, async () => {
  const repo = makeRepo();
  const victim = path.join(elsewhere(), 'VICTIM_LOCAL');
  const hooks = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'post-commit'), '#!/bin/sh\necho theirs\n', { mode: 0o755 });
  fs.symlinkSync(victim, path.join(hooks, 'post-commit.local'));

  const result = await runCli(['git-hook', 'install'], { cwd: repo });

  assert.equal(fs.existsSync(victim), false, 'their hook is not moved through the link');
  assert.equal(fs.readFileSync(path.join(hooks, 'post-commit'), 'utf8'), '#!/bin/sh\necho theirs\n');
  assert.match(result.stdout + result.stderr, /post-commit\.local/);
});

test('a directory at the hook path is refused rather than crashed on', async () => {
  const repo = makeRepo();
  const hooks = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(path.join(hooks, 'post-commit'), { recursive: true });

  const result = await runCli(['git-hook', 'install'], { cwd: repo });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(fs.statSync(path.join(hooks, 'post-commit')).isDirectory(), 'still a directory');
  assert.match(result.stdout + result.stderr, /director/i);
});

test('uninstall never follows a symlink at the hook path', { skip: CAN_SYMLINK ? false : 'symlink creation not permitted on this platform' }, async () => {
  const repo = makeRepo();
  const target = path.join(elsewhere(), 'looks-like-ours');
  fs.writeFileSync(target, '#!/bin/sh\n# agentmash-git-hook — not really\n');
  const hooks = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.symlinkSync(target, path.join(hooks, 'post-commit'));

  const result = await runCli(['git-hook', 'uninstall'], { cwd: repo });
  assert.equal(result.code, 0);
  assert.ok(fs.existsSync(target), 'the link target survives');
  assert.ok(fs.lstatSync(path.join(hooks, 'post-commit')).isSymbolicLink(), 'and so does the link');
  assert.match(result.stdout + result.stderr, /symlink|not ours/i);
});

test('init still wires up everything else when the hook path is refused', { skip: CAN_SYMLINK ? false : 'symlink creation not permitted on this platform' }, async () => {
  const repo = makeRepo();
  const victim = path.join(elsewhere(), 'VICTIM_INIT');
  const hooks = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.symlinkSync(victim, path.join(hooks, 'post-commit'));

  const server = http.createServer((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ room: ROOM, label: 'test', server_url: `http://127.0.0.1:${server.address().port}` }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const init = await runCli(['init', '--server', `http://127.0.0.1:${server.address().port}`], { cwd: repo });
    assert.equal(init.code, 0, init.stderr);
    assert.equal(fs.existsSync(victim), false, 'npx agentmash init must not write outside the repo');
    assert.match(init.stdout, /AgentMash is wired up/);
    assert.ok(fs.existsSync(path.join(repo, '.claude', 'agentmash', 'config.json')));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------
// core.hooksPath
//
// Honouring core.hooksPath is right — git will not run a hook anywhere else.
// Writing into it unasked is not, when it points into the working tree: that
// is a tracked file modified and an untracked sibling created by a command
// whose safety argument is "nothing here is committed".
// ---------------------------------------------------------------------------

test('install refuses a core.hooksPath inside the working tree', async () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, '.githooks'));
  fs.writeFileSync(path.join(repo, '.githooks', '.keep'), '');
  git(repo, ['config', 'core.hooksPath', '.githooks']);
  git(repo, ['add', '-A']);
  commit(repo, 'Add the team hooks directory');

  const result = await runCli(['git-hook', 'install'], { cwd: repo });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(!fs.existsSync(path.join(repo, '.githooks', 'post-commit')), 'nothing written into the tree');
  assert.equal(git(repo, ['status', '--porcelain', '--', '.githooks']).trim(), '', 'the tracked hooks dir is untouched');
  const said = result.stdout + result.stderr;
  assert.match(said, /\.githooks/, 'the refusal names the directory');
  assert.match(said, /--force-hooks-path/, 'and the way to override it');
});

test('--force-hooks-path installs into a hooks dir inside the tree', async () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, '.githooks'));
  git(repo, ['config', 'core.hooksPath', '.githooks']);

  const result = await runCli(['git-hook', 'install', '--force-hooks-path'], { cwd: repo });
  assert.equal(result.code, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(repo, '.githooks', 'post-commit'), 'utf8'), /agentmash-git-hook/);
});

test('init warns instead of committing us to the team, and finishes', async () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, '.husky', '_'), { recursive: true });
  git(repo, ['config', 'core.hooksPath', '.husky/_']);

  const server = http.createServer((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ room: ROOM, label: 'test', server_url: `http://127.0.0.1:${server.address().port}` }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const init = await runCli(['init', '--server', `http://127.0.0.1:${server.address().port}`], { cwd: repo });
    assert.equal(init.code, 0, init.stderr);
    assert.ok(!fs.existsSync(path.join(repo, '.husky', '_', 'post-commit')), 'no tracked file touched');
    assert.match(init.stdout, /AgentMash is wired up/, 'the rest of the install still happened');
    assert.match(init.stdout, /--force-hooks-path/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a hooks dir outside the working tree installs, and says it is shared', async () => {
  const repo = makeRepo();
  const shared = elsewhere();
  git(repo, ['config', 'core.hooksPath', shared]);

  const result = await runCli(['git-hook', 'install'], { cwd: repo });
  assert.equal(result.code, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(shared, 'post-commit'), 'utf8'), /agentmash-git-hook/);
  assert.match(result.stdout, /every repository|shared/i, 'a hook outside this repo is worth saying out loud');
});

/**
 * A machine whose global git config points core.hooksPath at one folder every
 * repository runs its hooks from (~/.githooks), holding a post-commit of its
 * owner's. Returns the env that makes git, and the CLI, read that config.
 */
function globalHooksPath() {
  const shared = elsewhere();
  const own = '#!/bin/sh\necho "my own post-commit, for every repository"\n';
  fs.writeFileSync(path.join(shared, 'post-commit'), own, { mode: 0o755 });
  const gitconfig = path.join(elsewhere(), 'gitconfig');
  fs.writeFileSync(gitconfig, `[core]\n\thooksPath = ${shared.replace(/\\/g, '/')}\n`);
  return { shared, own, env: { GIT_CONFIG_GLOBAL: gitconfig } };
}

test('a core.hooksPath from the global git config is not written to unasked, and says what it found', async () => {
  // The e2e run that found this: init renamed the owner's ~/.githooks/post-commit
  // to post-commit.local and put ours there, for every repository on the machine.
  const { shared, own, env } = globalHooksPath();
  const repo = makeRepo();
  const result = await runCli(['git-hook', 'install'], { cwd: repo, env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(shared, 'post-commit'), 'utf8'), own, 'their hook is where it was, as it was');
  assert.ok(!fs.existsSync(path.join(shared, 'post-commit.local')), 'nothing moved aside');
  const said = result.stdout.replace(/\s+/g, ' ');
  assert.ok(said.includes(shared), `names the folder: ${said}`);
  assert.match(said, /global git config/);
  assert.match(said, /every repository/);
  assert.match(said, /--force-hooks-path/);
  assert.doesNotMatch(said, /installed alongside/);

  // init says the same and finishes the rest of the install
  const server = http.createServer((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ room: ROOM, label: 'test', server_url: `http://127.0.0.1:${server.address().port}` }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const init = await runCli(['init', '--server', `http://127.0.0.1:${server.address().port}`, '--no-open'], { cwd: makeRepo(), env });
    assert.equal(init.code, 0, init.stderr);
    assert.match(init.stdout, /AgentMash is wired up/);
    assert.match(init.stdout, /--force-hooks-path/);
    assert.equal(fs.readFileSync(path.join(shared, 'post-commit'), 'utf8'), own);
  } finally {
    await new Promise((r) => server.close(r));
  }

  const doctor = await runCli(['doctor'], { cwd: repo, env });
  assert.match(doctor.stdout.replace(/\s+/g, ' '), /global git config.*--force-hooks-path/);
});

test('--force-hooks-path opts into a global core.hooksPath, and only the repository that did can take it out', async () => {
  const { shared, own, env } = globalHooksPath();
  const opted = makeRepo();
  const other = makeRepo();
  const forced = await runCli(['git-hook', 'install', '--force-hooks-path'], { cwd: opted, env });
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(fs.readFileSync(path.join(shared, 'post-commit'), 'utf8'), /agentmash-git-hook/);
  assert.equal(fs.readFileSync(path.join(shared, 'post-commit.local'), 'utf8'), own, 'theirs still runs, first');
  assert.match(forced.stdout, /every repository/);

  // another repository's uninstall, of the hook or of agentmash, leaves the shared folder alone
  for (const args of [['git-hook', 'uninstall'], ['uninstall']]) {
    const refused = await runCli(args, { cwd: other, env });
    assert.equal(refused.code, 0, refused.stderr);
    assert.match(refused.stdout.replace(/\s+/g, ' '), /not installed there for this repository/, args.join(' '));
    assert.match(fs.readFileSync(path.join(shared, 'post-commit'), 'utf8'), /agentmash-git-hook/, args.join(' '));
  }

  // the repository that opted in takes it out, and puts theirs back
  const removed = await runCli(['git-hook', 'uninstall'], { cwd: opted, env });
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(fs.readFileSync(path.join(shared, 'post-commit'), 'utf8'), own);
  assert.ok(!fs.existsSync(path.join(shared, 'post-commit.local')));
});

test('ours already in a global core.hooksPath, from before the opt-in was noted, is said as installed, and --force-hooks-path takes it out', async () => {
  const { shared, own, env } = globalHooksPath();
  // installed for one repository, and its note of that gone: an install from before notes
  const first = makeRepo();
  await runCli(['git-hook', 'install', '--force-hooks-path'], { cwd: first, env });
  fs.rmSync(path.join(first, '.git', 'agentmash-shared-hook.json'));

  const repo = makeRepo();
  const install = await runCli(['git-hook', 'install'], { cwd: repo, env });
  assert.equal(install.code, 0, install.stderr);
  assert.match(install.stdout.replace(/\s+/g, ' '), /already installed .*shared by every repository/);
  assert.doesNotMatch(install.stdout, /not installed/);

  const refused = await runCli(['git-hook', 'uninstall'], { cwd: repo, env });
  assert.match(refused.stdout.replace(/\s+/g, ' '), /left alone.*git-hook uninstall --force-hooks-path/);
  assert.match(fs.readFileSync(path.join(shared, 'post-commit'), 'utf8'), /agentmash-git-hook/);

  const removed = await runCli(['git-hook', 'uninstall', '--force-hooks-path'], { cwd: repo, env });
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(fs.readFileSync(path.join(shared, 'post-commit'), 'utf8'), own, 'theirs is back');
  assert.ok(!fs.existsSync(path.join(shared, 'post-commit.local')));
});

test('doctor reports the refusal rather than calling the client installed', async () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, '.githooks'));
  git(repo, ['config', 'core.hooksPath', '.githooks']);
  const result = await runCli(['doctor'], { cwd: repo });
  assert.match(result.stdout, /core\.hooksPath/, result.stdout);
});

// ---------------------------------------------------------------------------
// The slow server
//
// "Down" and "hung for 30s" are tested above and were always fine. The case
// that corrupts a room is the ordinary one: a server that answers in a few
// hundred milliseconds, from a laptop on hotel wifi, with one fresh connection
// per event. Sequentially, the session_end is the first thing to fall off the
// end of the budget — and a commit with no session_end is a session the
// dashboard shows as active for the next hour.
// ---------------------------------------------------------------------------

/** A commit of `count` files, so the reporting loop has real work to do. */
function bigCommit(repo, count, message) {
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(repo, `file-${i}.txt`), `${i}\n`);
  git(repo, ['add', '-A']);
  commit(repo, message);
}

test('a slow-but-reachable server still gets every event, session_end included', async () => {
  const mock = await startMockServer({ delayMs: 300 });
  const repo = makeRepo();
  try {
    writeConfig(repo, mock.url);
    bigCommit(repo, 50, 'Rename the storage layer');

    const worker = await runWorker(repo);
    assert.equal(worker.code, 0);
    const events = mock.requests.map((r) => r.body);
    assert.equal(events.filter((e) => e.event_type === 'edit').length, 50, 'all 50 files reported');
    assert.equal(events.filter((e) => e.event_type === 'session_end').length, 1, 'and the session is closed');
    assert.ok(worker.elapsed < 10_000, `worker took ${worker.elapsed}ms against a 300ms server`);
  } finally {
    await mock.close();
  }
});

test('when the budget runs out the session_end is still sent', async () => {
  const mock = await startMockServer({ delayMs: 1200 });
  const repo = makeRepo();
  try {
    writeConfig(repo, mock.url);
    bigCommit(repo, 50, 'Reformat everything');

    const worker = await runWorker(repo);
    assert.equal(worker.code, 0);
    const events = mock.requests.map((r) => r.body);
    const edits = events.filter((e) => e.event_type === 'edit');
    const ends = events.filter((e) => e.event_type === 'session_end');
    assert.ok(edits.length < 50, `the budget should have cut the edits short, got ${edits.length}`);
    assert.equal(ends.length, 1, 'the session_end is the one event that must survive the budget');
    assert.equal(ends[0].session_id, edits[0].session_id);
    assert.ok(worker.elapsed < 16_000, `worker took ${worker.elapsed}ms`);
  } finally {
    await mock.close();
  }
});

test('a thousand-file commit reports MAX_FILES of them and says how many there were', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    writeConfig(repo, mock.url);
    bigCommit(repo, 1200, 'Vendor the dependency');

    const worker = await runWorker(repo);
    assert.equal(worker.code, 0);
    const events = mock.requests.map((r) => r.body);
    const edits = events.filter((e) => e.event_type === 'edit');
    assert.equal(edits.length, 50, 'the room is not buried');
    assert.equal(events.filter((e) => e.event_type === 'session_end').length, 1);
    const stated = edits[0].change_summary.match(/(\d+) files in this commit/);
    assert.ok(stated && Number(stated[1]) > 1000, `the truncation must be stated: ${edits[0].change_summary}`);
    assert.ok(worker.elapsed < 10_000, `worker took ${worker.elapsed}ms on a 1200-file commit`);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Rewritten history, detached HEAD, squash merges
//
// post-commit fires for all of it. What the client owes the room is that one
// piece of work shows up once, and that what it says about the work is true.
// ---------------------------------------------------------------------------

test('an amend that only rewords is not reported a second time', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    writeConfig(repo, mock.url);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);
    commit(repo, 'Add a');
    await runWorker(repo);
    const afterFirst = mock.requests.length;
    assert.ok(afterFirst >= 2);

    // A new sha for work that is already in the room. The dedupe file keys on
    // sha, so only the tree can catch this.
    git(repo, ['commit', '-q', '--amend', '-m', 'Add a, with a better subject']);
    await runWorker(repo);
    assert.equal(mock.requests.length, afterFirst, 'the same tree is the same work');

    // An amend that actually changes something is new work and is reported.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-q', '--amend', '--no-edit']);
    await runWorker(repo);
    assert.ok(mock.requests.length > afterFirst, 'a changed tree is new work');
  } finally {
    await mock.close();
  }
});

test('a commit on a detached HEAD reports the short sha as the branch', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    writeConfig(repo, mock.url);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);
    commit(repo, 'Add a');
    git(repo, ['checkout', '-q', '--detach']);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    git(repo, ['add', 'b.txt']);
    commit(repo, 'Add b while detached');

    await runWorker(repo);
    const edit = mock.requests.map((r) => r.body).find((e) => e.event_type === 'edit');
    assert.equal(edit.file_path, 'b.txt');
    assert.match(edit.git_branch, /^[0-9a-f]{7}$/, `PROTOCOL §4: detached HEAD reports the short sha, got ${edit.git_branch}`);
  } finally {
    await mock.close();
  }
});

test('commits made back to back, and a checkout right after, are each reported as they were made', async () => {
  // The hook starts its worker in the background, and the worker read HEAD
  // and the branch once it got going: by then a second commit, or a checkout,
  // had moved them. Of two commits made in a row, as a script or an agent
  // makes them, the first was never reported, and the second came in on the
  // branch checked out after it. Each worker here starts 1.5 s late, as one
  // on a busy machine does, and the commits and the checkout are all done by
  // then.
  const mock = await startMockServer();
  const repo = makeRepo();
  const late = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-late-worker-')), 'late.cjs');
  fs.writeFileSync(late, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);\n');
  const slow = { ...process.env, NODE_OPTIONS: `--require "${late.split(path.sep).join('/')}"` };
  const commitSlowly = (message) => execFileSync('git', ['commit', '-q', '-m', message], { cwd: repo, env: slow, stdio: 'ignore' });
  try {
    await runCli(['git-hook', 'install'], { cwd: repo });
    writeConfig(repo, mock.url);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, ['add', 'a.txt']);
    commitSlowly('first of two');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(repo, ['add', 'b.txt']);
    commitSlowly('second of two');
    git(repo, ['checkout', '-q', '-b', 'elsewhere']);
    const [second, first] = git(repo, ['log', '-2', '--format=%h']).trim().split('\n');

    // two edits and two session_ends, or whatever came instead
    await waitForEvents(mock, 4, 15_000);
    await new Promise((r) => setTimeout(r, 300)); // let any stragglers land
    const edits = mock.requests.map((r) => r.body).filter((e) => e.event_type === 'edit');
    assert.deepEqual(
      edits.map((e) => [e.file_path, e.session_id, e.git_branch, e.task_hint]).sort(),
      [
        ['a.txt', `commit-${first}`, 'main', 'first of two'],
        ['b.txt', `commit-${second}`, 'main', 'second of two'],
      ]
    );
  } finally {
    await mock.close();
  }
});

test('a commit a rebase replays is reported on the branch being rebased, while the rebase is still stopped', async () => {
  // git runs post-commit for each commit a rebase replays, on a detached
  // HEAD, and a rebase that stops on a conflict leaves it detached until it
  // goes on. The replayed commit was reported on "branch <sha>".
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await runCli(['git-hook', 'install'], { cwd: repo });
    writeConfig(repo, mock.url);
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
    git(repo, ['add', '-A']);
    commit(repo, 'Base');
    git(repo, ['checkout', '-q', '-b', 'feature/soft-delete']);
    fs.writeFileSync(path.join(repo, 'clean.txt'), 'feature\n');
    git(repo, ['add', '-A']);
    commit(repo, 'Feature work that replays cleanly');
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'feature\n');
    git(repo, ['add', '-A']);
    commit(repo, 'Feature work that conflicts');
    git(repo, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'main\n');
    git(repo, ['add', '-A']);
    commit(repo, 'Main moves');
    git(repo, ['checkout', '-q', 'feature/soft-delete']);
    assert.ok(await waitForEvents(mock, 8), `only got ${mock.requests.length} requests`);
    mock.requests.length = 0;

    assert.throws(() => git(repo, ['rebase', 'main']), 'the second commit stops the rebase');
    assert.doesNotMatch(fs.readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8'), /^ref:/, 'HEAD is detached meanwhile');
    assert.ok(await waitForEvents(mock, 2), `only got ${mock.requests.length} requests`);
    const edits = mock.requests.map((r) => r.body).filter((e) => e.event_type === 'edit');
    assert.deepEqual(
      edits.map((e) => [e.file_path, e.git_branch]),
      [['clean.txt', 'feature/soft-delete']]
    );
    git(repo, ['rebase', '--abort']);
  } finally {
    await mock.close();
  }
});

test('a rebased commit is reported once on its new base', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    writeConfig(repo, mock.url);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    git(repo, ['add', '-A']);
    commit(repo, 'Base');
    git(repo, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'feature\n');
    git(repo, ['add', '-A']);
    commit(repo, 'Feature work');
    await runWorker(repo);
    mock.requests.length = 0;

    git(repo, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(repo, 'other.txt'), 'other\n');
    git(repo, ['add', '-A']);
    commit(repo, 'Other work');
    git(repo, ['checkout', '-q', 'feature']);
    git(repo, ['rebase', '-q', 'main']);

    await runWorker(repo);
    const edits = mock.requests.map((r) => r.body).filter((e) => e.event_type === 'edit');
    assert.deepEqual(edits.map((e) => e.file_path), ['feature.txt'], 'the replayed commit reports its own file, not the base');
    assert.equal(edits[0].git_branch, 'feature');
  } finally {
    await mock.close();
  }
});

// `git merge --squash` is the documented gap: the commit has one parent, so the
// merge guard cannot see it, and it claims the squasher touched the whole
// branch. This test pins what actually happens (it is reported, with the file
// count stated) so the limitation in docs/ADAPTERS.md stays true. The signals
// that would let us detect it — MERGE_HEAD, SQUASH_MSG — are gone by the time
// post-commit runs; verified against git 2.x, not assumed.
test('a squash merge is reported as one persons work — the known gap', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    writeConfig(repo, mock.url);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    git(repo, ['add', '-A']);
    commit(repo, 'Base');
    git(repo, ['checkout', '-q', '-b', 'side']);
    for (const name of ['s1.txt', 's2.txt']) fs.writeFileSync(path.join(repo, name), 'side\n');
    git(repo, ['add', '-A']);
    commit(repo, 'Side work');
    git(repo, ['checkout', '-q', 'main']);
    mock.requests.length = 0;

    git(repo, ['merge', '--squash', '-q', 'side']);
    commit(repo, 'Squash side');
    assert.ok(!fs.existsSync(path.join(repo, '.git', 'SQUASH_MSG')), 'git removes SQUASH_MSG before post-commit runs');

    await runWorker(repo);
    const edits = mock.requests.map((r) => r.body).filter((e) => e.event_type === 'edit');
    assert.deepEqual(edits.map((e) => e.file_path).sort(), ['s1.txt', 's2.txt']);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Finding node
//
// Hooks run under a non-login shell that never reads a profile, so a node
// installed by nvm/volta/fnm is not on PATH when git is driven from SourceTree,
// VS Code, JetBrains or Tower. The shim used to report nothing at all in that
// case — silently, while `agentmash doctor` called the client installed.
// ---------------------------------------------------------------------------

test('the hook finds node where a version manager put it, not only on PATH', { skip: HAS_FILE_MODES ? false : 'POSIX shell shims and PATH layout only' }, async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  const home = elsewhere();
  try {
    fs.mkdirSync(path.join(home, '.volta', 'bin'), { recursive: true });
    const witness = path.join(home, 'version-manager-node-was-used');
    fs.writeFileSync(
      path.join(home, '.volta', 'bin', 'node'),
      `#!/bin/sh\ntouch "${witness}"\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 }
    );

    await runCli(['git-hook', 'install'], { cwd: repo });
    writeConfig(repo, mock.url);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);

    // A PATH with git and no node: what the hook sees under a GUI client.
    // /usr/bin and /bin themselves won't do where a package put node there
    // (our CI runner's Ubuntu has one): a folder of links to what they hold,
    // node aside.
    const bare = path.join(elsewhere(), 'bin');
    fs.mkdirSync(bare);
    const linked = new Set(['node', 'nodejs']);
    for (const dir of ['/usr/bin', '/bin']) {
      for (const name of fs.readdirSync(dir)) {
        if (linked.has(name)) continue;
        linked.add(name);
        fs.symlinkSync(path.join(dir, name), path.join(bare, name));
      }
    }
    const started = Date.now();
    execFileSync('git', ['commit', '-q', '-m', 'Add a'], {
      cwd: repo,
      env: { PATH: bare, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.ok(Date.now() - started < 3000, 'and looking for it costs the commit nothing');

    assert.ok(await waitForEvents(mock, 2), 'the commit must still be reported');
    assert.ok(fs.existsSync(witness), 'and through the version manager node, not one on PATH');
  } finally {
    await mock.close();
  }
});

test('the worker notes a commit as reported before it sends it, so the hooks never report it as well', async () => {
  // The hooks report a commit made in a session from the reflog, and leave
  // alone one in .git/agentmash-reported.json: noted only after its posts, a
  // commit could be reported by both while the worker was still sending.
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', 'a.txt']);
  commit(repo, 'Add a');
  const sha = git(repo, ['rev-parse', 'HEAD']).trim();
  const noted = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let list = [];
      try {
        list = JSON.parse(fs.readFileSync(path.join(repo, '.git', 'agentmash-reported.json'), 'utf8'));
      } catch {
        // not written yet
      }
      noted.push(list.some((e) => e.sha === sha));
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    writeConfig(repo, `http://127.0.0.1:${server.address().port}`);
    const worker = await runWorker(repo);
    assert.equal(worker.code, 0);
    assert.ok(noted.length >= 2, 'an edit and the session end were sent');
    assert.ok(noted.every(Boolean), 'the commit was noted before the first of them');
  } finally {
    server.closeAllConnections?.();
    await new Promise((done) => server.close(done));
  }
});
