// `npx agentmash observe`: the switch for observing on one machine. `on` puts
// observing's hooks in the developer's own Claude Code settings (never a
// repository's), copies their scripts and turns the config on, and `off`
// takes out exactly what `on` put in. What these tests pin: what is written
// and where, that someone's own settings and a sign-in's hooks survive both,
// that turning it on twice writes nothing, what status, log, forget and
// doctor say of what a machine observed, and that a machine which never
// turned it on gets the scripts from a login and nothing else.
//
// And sharing: `observe share on|off` is a room's switch, sent with the key
// of the room a checkout carries and with nothing else, `observe local
// on|off` is one line of this machine's observe.json, and status and doctor
// read what the worker's sync and the hooks' outbox left on disk. Those
// files are written here by hand, as docs/plans/enrichment-step2-room.md
// and the scripts that own them say they are: no test syncs with anything.
//
// Every machine here is a home of its own (AGENTMASH_HOME, CLAUDE_CONFIG_DIR,
// HOME), and its `claude` is a stand-in that records being started: nothing
// reads the real ~/.agentmash or ~/.claude, and no test starts Claude Code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { CLI_DIR, json, run, standIns, startServer } from './fixtures/machine.mjs';
import { ROOM, startMockServer } from './mock-server.mjs';
import { tempDir } from './fixtures/tmp.mjs';

// what the hooks and the worker write a machine's observations with: the tests seed a home through it
const observe = await import(pathToFileURL(path.join(CLI_DIR, '..', 'hooks', 'observe.mjs')).href);
// what the hooks keep their outbox by: how many reports it may hold
const lib = await import(pathToFileURL(path.join(CLI_DIR, '..', 'hooks', 'lib.mjs')).href);
// preloaded into a command that must ask no server: the first use of the network ends it with exit code 97
const NO_NETWORK = pathToFileURL(path.join(CLI_DIR, 'test', 'fixtures', 'no-network.mjs')).href;
const offline = (env) => ({ ...env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${NO_NETWORK}`].filter(Boolean).join(' ') });

/** Someone's own settings, which must come through `on`, `off`, a login and a logout untouched. */
const THEIRS = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] } };
const THEIRS_TEXT = JSON.stringify(THEIRS, null, 2) + '\n';
/** The events a sign-in registers a hook for, and what each runs: [script, async, timeout]. */
const SIGN_IN = {
  SessionStart: [['session_start.mjs', undefined, 5]],
  UserPromptSubmit: [
    ['user_prompt_submit.mjs', true, 5],
    ['prompt_note.mjs', undefined, 3],
  ],
  PreToolUse: [['pre_tool_use.mjs', undefined, 5]],
  PostToolUse: [['post_tool_use.mjs', true, 5]],
  SessionEnd: [['session_end.mjs', undefined, 4]],
  Stop: [['stop.mjs', undefined, 5]],
};
const OBSERVE_SCRIPTS = ['observe.mjs', 'observe_spool.mjs', 'observe_worker.mjs', 'observe_recall.mjs', 'observe_sync.mjs'];
const PATH_KEY = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';

/**
 * A home with Claude Code's settings in it, and `claude` on the tool path
 * unless `claude` is false: a stand-in (fixtures/machine.mjs), first on the
 * PATH too, so nothing the CLI starts by that name is ever the real one.
 */
function machine({ claude = true } = {}) {
  const home = fs.realpathSync(tempDir('agentmash-obs-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), THEIRS_TEXT);
  const tools = standIns(home, claude ? ['claude'] : []);
  return {
    home,
    settings: path.join(home, '.claude', 'settings.json'),
    hooks: path.join(home, '.agentmash', 'hooks'),
    config: path.join(home, '.agentmash', 'observe.json'),
    calls: tools.calls,
    env: {
      AGENTMASH_HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      HOME: home,
      USERPROFILE: home,
      AGENTMASH_TOOL_PATH: tools.bin,
      [PATH_KEY]: `${tools.bin}${path.delimiter}${process.env[PATH_KEY] ?? ''}`,
      AGENTMASH_APPS_DIR: path.join(home, 'Applications'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    },
  };
}

/** A checkout of acme/app with settings of its own, which no observe command may write. */
function checkout(slug = 'acme/app') {
  const repo = fs.realpathSync(tempDir('agentmash-obs-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', `git@github.com:${slug}.git`], { cwd: repo, stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{ "permissions": { "allow": ["Bash(npm test)"] } }\n');
  return repo;
}

/** Whether `repo` is as checkout() left it: its own settings byte for byte, and nothing beside them. */
function untouched(repo) {
  assert.equal(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'), '{ "permissions": { "allow": ["Bash(npm test)"] } }\n');
  assert.deepEqual(fs.readdirSync(path.join(repo, '.claude')), ['settings.json'], 'nothing is put beside the repository\'s settings');
  assert.deepEqual(fs.readdirSync(repo).sort(), ['.claude', '.git'], 'and nothing in the repository');
}

/** The six entries `observe on` writes, by event, for a machine whose scripts are in `hooks`. */
function wanted(hooks) {
  const hook = (script, kind, extra) => ({ type: 'command', command: 'node', args: [path.join(hooks, script), kind], ...extra });
  return {
    PostToolUse: { matcher: '*', hooks: [hook('observe_spool.mjs', 'tool', { timeout: 2 })] },
    PostToolUseFailure: { matcher: '*', hooks: [hook('observe_spool.mjs', 'fail', { timeout: 2 })] },
    UserPromptSubmit: { hooks: [hook('observe_spool.mjs', 'prompt', { timeout: 2 })] },
    Stop: { hooks: [hook('observe_spool.mjs', 'stop', { timeout: 2 })] },
    SessionStart: { hooks: [hook('observe_recall.mjs', 'session_start', { timeout: 3 })] },
    PreToolUse: { matcher: '*', hooks: [hook('observe_recall.mjs', 'pre_tool', { timeout: 2 })] },
  };
}

const scriptOf = (hook) => path.basename(hook.args?.[0] ?? '');
/** Observing's entries among an event's, and a sign-in's: both run scripts from ~/.agentmash/hooks, told apart by the script. */
const observing = (entries) => (entries ?? []).filter((e) => e.hooks.some((h) => scriptOf(h).startsWith('observe_')));
const signedIn = (entries) => (entries ?? []).filter((e) => e.hooks.some((h) => h.args?.[1] === '--global'));

/** What a sign-in registered in `settings`, as SIGN_IN says it, each event's entry checked to be the only one. */
function signInOf(settings) {
  const said = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    const ours = signedIn(entries);
    if (ours.length === 0) continue;
    assert.equal(ours.length, 1, `${event}: one entry of a sign-in's`);
    said[event] = ours[0].hooks.map((h) => [scriptOf(h), h.async, h.timeout]);
  }
  return said;
}

/** Run `fn` with observe.mjs reading and writing `m`'s home, as the hooks and the worker do there. */
function inHome(m, fn) {
  const before = process.env.AGENTMASH_HOME;
  process.env.AGENTMASH_HOME = m.home;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.AGENTMASH_HOME;
    else process.env.AGENTMASH_HOME = before;
  }
}

/** An observation as the worker logs one, `minutes` old. */
const note = (id, minutes, fields = {}) => ({
  v: 1,
  id,
  ts: Date.now() - minutes * 60_000,
  session_id: 's1',
  agent: 'claude-code',
  repo: 'acme/app',
  branch: 'main',
  type: 'cause',
  title: `what ${id} found`,
  facts: ['a fact'],
  files: [],
  symbols: [],
  evidence: { kind: 'none', ref: '' },
  seen: 1,
  ...fields,
});

/** Log `notes` on `m` under `key`, the way the worker does. */
const seed = (m, key, notes) => inHome(m, () => notes.forEach((obs) => assert.ok(observe.addObservation(key, obs).added, obs.id)));

/** A checkout of acme/app that carries a room key, as one that ran `init` or pulled its config does. */
function roomCheckout(url) {
  const repo = checkout();
  fs.mkdirSync(path.join(repo, '.claude', 'agentmash'));
  fs.writeFileSync(path.join(repo, '.claude', 'agentmash', 'config.json'), JSON.stringify({ url, room: ROOM, room_ref: 'rm_abc123' }, null, 2) + '\n');
  return repo;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** What the worker's sync keeps of a repository on `m`, written by hand: observe/sync/<key>.json. */
function syncState(m, key, fields) {
  const dir = path.join(m.home, '.agentmash', 'observe', 'sync');
  fs.mkdirSync(dir, { recursive: true });
  const state = { v: 1, top: null, sent: 0, sharing: null, share_since: null, pulled_at: 0, pushed_at: 0, team: 0, error: null, ...fields };
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(state, null, 2) + '\n');
}

/** The team's observations as the worker's last pull left them on `m`, written by hand: observe/team/<key>.json. */
function teamCache(m, key, { share_since, observations }) {
  const dir = path.join(m.home, '.agentmash', 'observe', 'team');
  fs.mkdirSync(dir, { recursive: true });
  const cache = { v: 1, at: Date.now() - 2 * MINUTE, sharing: true, share_since, seq: observations.length, observations };
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(cache, null, 2) + '\n');
}

/** An observation as the room gives one back: a teammate's, with who found it. */
const teammates = (id, developer) => ({
  id,
  type: 'cause',
  title: `what ${id} found`,
  facts: ['a fact'],
  files: [],
  symbols: [],
  evidence: null,
  branch: 'main',
  head: null,
  developer,
  agent: 'claude-code',
  first_ts: Date.now() - 60 * MINUTE,
  last_ts: Date.now() - 60 * MINUTE,
  seen: 1,
  people: 1,
  commit: null,
});

/** `count` reports an outage kept on `m`, the first queued `oldest` ms ago and the rest just now, written by hand: outbox/<ms>-<pid>-<random>.json. */
function outbox(m, count, oldest) {
  const dir = path.join(m.home, '.agentmash', 'outbox');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const queued_at = Date.now() - (i === 0 ? oldest : i);
    const entry = {
      v: 1,
      report_id: `report${String(i).padStart(16, '0')}`,
      queued_at,
      tries: 1,
      next_at: queued_at + 30_000,
      project: m.home,
      url: 'http://127.0.0.1:9',
      room_ref: '',
      body: { developer: 'bob', session_id: 's1', event_type: 'edit', file_path: 'src/a.js', ts: queued_at },
    };
    fs.writeFileSync(path.join(dir, `${queued_at}-${process.pid}-${String(i).padStart(8, '0')}.json`), JSON.stringify(entry) + '\n');
  }
}

test('observe on with no claude on the PATH says so, exits 1 and changes nothing', async () => {
  const m = machine({ claude: false });
  const result = await run(['observe', 'on'], m.env, m.home);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /claude is not on your PATH/);
  assert.match(result.stderr, /nothing was changed/);
  assert.equal(fs.readFileSync(m.settings, 'utf8'), THEIRS_TEXT, 'the settings are as they were');
  assert.deepEqual(fs.readdirSync(path.join(m.home, '.claude')), ['settings.json'], 'with no copy kept beside them');
  assert.ok(!fs.existsSync(path.join(m.home, '.agentmash')), 'no script is copied and no config is written');
});

test('observe on puts its six entries in this machine\'s Claude Code settings, copies the scripts and turns the config on', async () => {
  const m = machine();
  const repo = checkout();
  // in a checkout: where it is run from changes nothing about where it writes
  const result = await run(['observe', 'on'], m.env, repo);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /✓ observing is on/);
  assert.match(result.stdout, /nothing leaves this machine/);
  assert.match(result.stdout, /restart any Claude Code session that is already open/);

  const settings = json(m.settings);
  assert.equal(settings.model, 'opus', 'the rest of the settings are left as they were');
  assert.deepEqual(settings.hooks.PreToolUse[0], THEIRS.hooks.PreToolUse[0], 'and so is their own hook, where it was');
  const want = wanted(m.hooks);
  assert.deepEqual(Object.keys(settings.hooks).sort(), Object.keys(want).sort(), 'six events, and no other');
  for (const [event, entry] of Object.entries(want)) {
    assert.deepEqual(observing(settings.hooks[event]), [entry], event);
    for (const hook of entry.hooks) assert.ok(fs.existsSync(hook.args[0]), `${event} runs a script that is there`);
  }
  assert.equal(settings.hooks.PreToolUse.length, 2, 'their hook and observing\'s, and nothing else');
  // every one is waited for, briefly: a background hook is not sure to run before a short headless session is gone
  for (const event of ['PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop']) {
    assert.deepEqual([want[event].hooks[0].async, want[event].hooks[0].timeout], [undefined, 2], event);
  }
  assert.equal(fs.readFileSync(`${m.settings}.before-agentmash`, 'utf8'), THEIRS_TEXT, 'what was there is kept, once');

  for (const file of [...OBSERVE_SCRIPTS, 'lib.mjs']) assert.ok(fs.existsSync(path.join(m.hooks, file)), file);
  assert.equal(json(m.config).enabled, true);
  untouched(repo);
  assert.deepEqual(m.calls(), [], 'claude is looked for, never started');

  // a second time: the same file, byte for byte
  const before = fs.readFileSync(m.settings);
  const again = await run(['observe', 'on'], m.env, repo);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /observing was already on/);
  assert.ok(fs.readFileSync(m.settings).equals(before), 'on twice changes nothing');
  assert.equal(json(m.config).enabled, true);
  untouched(repo);
});

test('observe off takes out exactly its entries and turns the config off', async () => {
  const m = machine();
  const repo = checkout();
  await run(['observe', 'on'], m.env, repo);
  const result = await run(['observe', 'off'], m.env, repo);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /✓ observing is off/);
  assert.deepEqual(json(m.settings), THEIRS, 'the settings are what they were before `on`');
  assert.equal(json(m.config).enabled, false);
  untouched(repo);

  const again = await run(['observe', 'off'], m.env, repo);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /observing was not on/);
  assert.deepEqual(json(m.settings), THEIRS);
});

test('a word observe does not take is refused before anything is done', async () => {
  const m = machine();
  const refused = [['on', 'now'], ['enable'], ['forget'], ['log', '-n'], ['log', '-n', '0'], ['log', 'all']];
  // share and local take on or off, and one of them
  refused.push(['share'], ['share', 'maybe'], ['share', 'on', 'now'], ['local'], ['local', 'yes'], ['local', 'off', 'now']);
  for (const words of refused) {
    // a refusal comes before any server is asked: one that asked would end with 97
    const result = await run(['observe', ...words], offline(m.env), m.home);
    assert.equal(result.code, 1, words.join(' '));
    assert.match(result.stderr, /usage: agentmash observe /, words.join(' '));
  }
  assert.equal(fs.readFileSync(m.settings, 'utf8'), THEIRS_TEXT);
  assert.ok(!fs.existsSync(m.config));
  const help = await run(['--help'], m.env, m.home);
  assert.match(help.stdout, /npx agentmash observe <on\|off\|status\|log\|forget <id>>/);
  assert.match(help.stdout, /npx agentmash observe share <on\|off> {2}whether this repo's room keeps what its team's agents find/);
  assert.match(help.stdout, /npx agentmash observe local <on\|off> {2}on: this machine keeps what it finds to itself/);
});

test('with observing never turned on, a login writes what it always did, and copies observing\'s scripts beside the rest', async () => {
  const server = await startServer();
  const m = machine();
  try {
    const result = await run(['login', '--server', server.url, '--no-open'], m.env, m.home);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /observ/);

    const settings = json(m.settings);
    assert.equal(settings.model, 'opus');
    assert.deepEqual(settings.hooks.PreToolUse[0], THEIRS.hooks.PreToolUse[0]);
    assert.deepEqual(Object.keys(settings.hooks).sort(), Object.keys(SIGN_IN).sort(), 'the sign-in\'s events, and no PostToolUseFailure');
    assert.deepEqual(signInOf(settings), SIGN_IN);
    for (const [event, entries] of Object.entries(settings.hooks)) assert.deepEqual(observing(entries), [], event);
    assert.doesNotMatch(fs.readFileSync(m.settings, 'utf8'), /observe/);

    for (const file of OBSERVE_SCRIPTS) assert.ok(fs.existsSync(path.join(m.hooks, file)), `${file} is copied, and runs nothing`);
    assert.ok(!fs.existsSync(m.config), 'no observe config');
    assert.ok(!fs.existsSync(path.join(m.home, '.agentmash', 'observe')), 'and nothing observed');

    const status = await run(['observe', 'status'], m.env, m.home);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /observing is off/);

    const out = await run(['logout'], m.env, m.home);
    assert.equal(out.code, 0, out.stderr);
    assert.doesNotMatch(out.stdout, /observ/);
    assert.deepEqual(json(m.settings), THEIRS);
    assert.ok(!fs.existsSync(m.hooks), 'the scripts go with the sign-in');
    assert.ok(!fs.existsSync(m.config), 'and a logout writes no observe config');
  } finally {
    await server.close();
  }
});

// Both run scripts from ~/.agentmash/hooks, in the same events of the same
// file: a login replaces a sign-in's entries and must leave observing's, and
// `observe off` the other way round.
test('a login keeps observing\'s entries, observe off keeps the sign-in\'s, and a logout takes both', async () => {
  const server = await startServer();
  const m = machine();
  try {
    await run(['observe', 'on'], m.env, m.home);
    const login = await run(['login', '--server', server.url, '--no-open'], m.env, m.home);
    assert.equal(login.code, 0, login.stderr);
    const want = wanted(m.hooks);
    let settings = json(m.settings);
    for (const [event, entry] of Object.entries(want)) assert.deepEqual(observing(settings.hooks[event]), [entry], `${event} after a login`);
    assert.deepEqual(signInOf(settings), SIGN_IN);

    // on again, after the login moved nothing of observing's: the same file
    const before = fs.readFileSync(m.settings);
    await run(['observe', 'on'], m.env, m.home);
    assert.ok(fs.readFileSync(m.settings).equals(before));
    // and a second login, with observing on, is the same file too
    await run(['login', '--server', server.url, '--no-open'], m.env, m.home);
    assert.ok(fs.readFileSync(m.settings).equals(before));

    const off = await run(['observe', 'off'], m.env, m.home);
    assert.equal(off.code, 0, off.stderr);
    settings = json(m.settings);
    assert.deepEqual(signInOf(settings), SIGN_IN, 'the sign-in\'s hooks are all still there');
    assert.deepEqual(Object.keys(settings.hooks).sort(), Object.keys(SIGN_IN).sort(), 'and PostToolUseFailure, which held only observing\'s, is gone');
    for (const [event, entries] of Object.entries(settings.hooks)) assert.deepEqual(observing(entries), [], event);
    assert.deepEqual(settings.hooks.PreToolUse[0], THEIRS.hooks.PreToolUse[0]);

    await run(['observe', 'on'], m.env, m.home);
    const out = await run(['logout'], m.env, m.home);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /✓ observing is off/);
    assert.deepEqual(json(m.settings), THEIRS, 'nothing of agentmash is left in the settings');
    assert.ok(!fs.existsSync(m.hooks), 'so the scripts could go');
    assert.equal(json(m.config).enabled, false);
  } finally {
    await server.close();
  }
});

// A worker runs the scripts it was started with. Turning observing on again
// copies the current ones, so a worker that is running goes, and the next
// event starts one from them.
test('observe on stops a worker that is running, so the next one starts from the scripts just copied', { skip: process.platform === 'win32' }, async () => {
  const m = machine();
  const scripts = tempDir('agentmash-obs-restart-');
  fs.writeFileSync(path.join(scripts, 'observe_worker.mjs'), 'setInterval(() => {}, 1000);\n');
  const worker = spawn(process.execPath, [path.join(scripts, 'observe_worker.mjs')], { stdio: 'ignore' });
  const lock = path.join(m.home, '.agentmash', 'observe', 'worker.lock');
  try {
    const first = await run(['observe', 'on'], m.env, m.home);
    assert.doesNotMatch(first.stdout, /stopped the observe worker/);
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'pid'), String(worker.pid));
    const ended = once(worker, 'exit');
    const again = await run(['observe', 'on'], m.env, m.home);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, new RegExp(`stopped the observe worker\\s+pid ${worker.pid}`));
    const [, signal] = await ended;
    assert.equal(signal, 'SIGTERM');
  } finally {
    worker.kill('SIGKILL');
  }
});

// The lock outlives a worker that was killed, and its pid is some other
// process's in time: only a process that is an observe worker is signalled.
test('observe off stops the worker its lock names, and no process that is not one', { skip: process.platform === 'win32' }, async () => {
  const m = machine();
  const scripts = tempDir('agentmash-obs-worker-');
  const idle = 'setInterval(() => {}, 1000);\n';
  fs.writeFileSync(path.join(scripts, 'observe_worker.mjs'), idle);
  fs.writeFileSync(path.join(scripts, 'something_else.mjs'), idle);
  const start = (script) => spawn(process.execPath, [path.join(scripts, script)], { stdio: 'ignore' });
  const worker = start('observe_worker.mjs');
  const other = start('something_else.mjs');
  const lock = path.join(m.home, '.agentmash', 'observe', 'worker.lock');
  const holds = (pid) => {
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'pid'), String(pid));
  };
  try {
    await run(['observe', 'on'], m.env, m.home);
    holds(other.pid);
    const stale = await run(['observe', 'status'], m.env, m.home);
    assert.match(stale.stdout, /the observe worker is not running/);
    const spared = await run(['observe', 'off'], m.env, m.home);
    assert.doesNotMatch(spared.stdout, /stopped the observe worker/);
    assert.equal(other.exitCode ?? other.signalCode, null, 'a process that is no worker is left running');

    await run(['observe', 'on'], m.env, m.home);
    holds(worker.pid);
    const running = await run(['observe', 'status'], m.env, m.home);
    assert.match(running.stdout, new RegExp(`the observe worker is running\\s+pid ${worker.pid}\\n`));
    const ended = once(worker, 'exit');
    const off = await run(['observe', 'off'], m.env, m.home);
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, new RegExp(`stopped the observe worker\\s+pid ${worker.pid}\\n`));
    const [, signal] = await ended;
    assert.equal(signal, 'SIGTERM');
    assert.equal(other.exitCode ?? other.signalCode, null);
  } finally {
    worker.kill('SIGKILL');
    other.kill('SIGKILL');
  }
});

test('observe status says whether it is on, what it needs, what waits, the day\'s counters and each repository\'s observations', async () => {
  const m = machine();
  const repo = checkout();

  const off = await run(['observe', 'status'], m.env, repo);
  assert.equal(off.code, 0, off.stderr);
  assert.match(off.stdout, /· observing is off — npx agentmash observe on/);
  assert.match(off.stdout, /no observations on this machine yet/);
  // nothing has synced with a room: what it said before, and the one command that turns sharing on
  assert.match(off.stdout, /· no observations on this machine yet\n {2}· no room shares what this machine finds — npx agentmash observe share on turns it on/);
  assert.doesNotMatch(off.stdout, /its room|keeps what it finds to itself/);

  await run(['observe', 'on'], m.env, repo);
  seed(m, 'acme__app', [note('o_first', 30), note('o_second', 5)]);
  seed(m, 'acme__other', [note('o_third', 9, { repo: 'acme/other' })]);
  inHome(m, () => {
    // three events of two sessions, waiting for a worker
    for (const session_id of ['s1', 's1', 's2']) {
      observe.writeSpool(observe.spoolEvent('tool', { session_id, cwd: repo, tool_name: 'Read', tool_input: { file_path: 'a.js' }, tool_response: {} }));
    }
    observe.writeDead({ session: 's0', events: [] }, 'the reply was not JSON');
    observe.updateState((s) => Object.assign(s, { runs: 14, skipped: 3, dead: 1, observations: 2, paused_until: Date.now() + 20 * 60_000 }));
  });

  const on = await run(['observe', 'status'], m.env, repo);
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /✓ observing is on/);
  assert.match(on.stdout, /✓ claude is on the PATH/);
  assert.match(on.stdout, /✓ observe hooks installed in Claude Code .* 6 events\n/);
  assert.match(on.stdout, /· the observe worker is not running/);
  assert.match(on.stdout, /· waiting to be observed: 3 events in 2 sessions\n/);
  assert.match(on.stdout, /! 1 dead batch, which the observer failed on twice/);
  assert.match(on.stdout, /· observer runs today: 14 of 300 · 3 batches skipped · 2 observations added\n/);
  assert.match(on.stdout, /! the observer is paused until \d\d:\d\d/);
  assert.match(on.stdout, /observations on this machine\n\s+acme\/app\s+2\n\s+acme\/other\s+1\n/);
  assert.match(on.stdout, /acme\/other\s+1\n\n {2}· no room shares what this machine finds — npx agentmash observe share on turns it on/);
  assert.doesNotMatch(on.stdout, /its room|keeps what it finds to itself/);
  assert.equal(inHome(m, () => observe.readSpool()).reduce((n, s) => n + s.entries.length, 0), 3, 'saying what waits takes nothing out of the spool');
  untouched(repo);

  // on, and what it needs is missing: each is a problem, and the command fails
  const empty = tempDir('agentmash-obs-empty-');
  const lost = await run(['observe', 'status'], { ...m.env, AGENTMASH_TOOL_PATH: empty }, repo);
  assert.equal(lost.code, 1);
  assert.match(lost.stdout, /✗ claude is not on the PATH/);
  fs.writeFileSync(m.settings, THEIRS_TEXT);
  const unhooked = await run(['observe', 'status'], m.env, repo);
  assert.equal(unhooked.code, 1);
  assert.match(unhooked.stdout, /✗ Claude Code has no observe hook for PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, SessionStart and PreToolUse .* — run: npx agentmash observe on/);
});

// A login copies this version's scripts and leaves observing's entries as they are (see above), so an install
// from before the briefing keeps recall's old matcher: its hook is there, and runs before an edit or a command only.
test('observe status says when an observe hook in the settings is not this version\'s, and observe on puts this version\'s in its place', async () => {
  const m = machine();
  await run(['observe', 'on'], m.env, m.home);
  const want = wanted(m.hooks);
  const settings = json(m.settings);
  const recall = observing(settings.hooks.PreToolUse)[0];
  assert.deepEqual(recall, want.PreToolUse);
  recall.matcher = 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell';
  fs.writeFileSync(m.settings, JSON.stringify(settings, null, 2) + '\n');

  const status = await run(['observe', 'status'], m.env, m.home);
  assert.equal(status.code, 1, 'a problem: the briefing waits for the session\'s first edit or command');
  assert.match(status.stdout, /✗ Claude Code's observe hook for PreToolUse is not this version's .* — run: npx agentmash observe on/);
  assert.doesNotMatch(status.stdout, /observe hooks installed|has no observe hook/);

  const on = await run(['observe', 'on'], m.env, m.home);
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /✓ observing is on/);
  const after = json(m.settings);
  for (const [event, entry] of Object.entries(want)) assert.deepEqual(observing(after.hooks[event]), [entry], event);
  assert.deepEqual(after.hooks.PreToolUse[0], THEIRS.hooks.PreToolUse[0], 'their own hook is where it was');
  const well = await run(['observe', 'status'], m.env, m.home);
  assert.equal(well.code, 0, well.stderr);
  assert.match(well.stdout, /✓ observe hooks installed in Claude Code .* 6 events\n/);

  // one event without its hook and one with an earlier version's: each is said, in a line of its own
  const both = json(m.settings);
  delete both.hooks.Stop;
  observing(both.hooks.SessionStart)[0].hooks[0].timeout = 1;
  fs.writeFileSync(m.settings, JSON.stringify(both, null, 2) + '\n');
  const said = await run(['observe', 'status'], m.env, m.home);
  assert.equal(said.code, 1);
  assert.match(said.stdout, /✗ Claude Code has no observe hook for Stop .* — run: npx agentmash observe on/);
  assert.match(said.stdout, /✗ Claude Code's observe hook for SessionStart is not this version's .* — run: npx agentmash observe on/);
});

test('observe status says, for each repository that synced, whether its room shares, what this machine sent and what it keeps of the team\'s', async () => {
  const m = machine();
  const repo = checkout();
  const other = checkout('acme/other');
  await run(['observe', 'on'], m.env, repo);
  seed(m, 'acme__app', [note('o_first', 30), note('o_second', 20), note('o_third', 5)]);
  seed(m, 'acme__other', [note('o_fourth', 9, { repo: 'acme/other' })]);
  const share_since = Date.now() - 2 * DAY;
  // the room has the first two lines of this machine's log, the third waits, and the last sync failed
  syncState(m, 'acme__app', {
    top: repo,
    sent: 2,
    sharing: true,
    share_since,
    pulled_at: Date.now() - 2 * MINUTE,
    pushed_at: Date.now() - 5 * MINUTE,
    team: 2,
    error: { at: Date.now() - 3 * 60 * MINUTE, what: 'no reply from the server\n(timeout)' },
  });
  teamCache(m, 'acme__app', { share_since, observations: [teammates('o_theirs1', 'alim'), teammates('o_theirs2', 'dana')] });
  syncState(m, 'acme__other', { top: other, sharing: false, pulled_at: Date.now() - 5 * MINUTE });

  // read from the files the sync left: a status that asked a server would end with 97
  const status = await run(['observe', 'status'], offline(m.env), repo);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /\n {2}acme\/app · its room\n {2}✓ the room shares what agents find {2}since 2 days ago\n/);
  assert.match(status.stdout, /\n {2}✓ this machine sends what it finds: 1 waiting to be sent · sent up to line 2 of its log\n/);
  assert.match(status.stdout, /\n {2}· the team's observations kept here: 2 · pulled 2 min ago · pushed 5 min ago\n/);
  assert.match(status.stdout, /\n {2}! the last sync failed 3 h ago: no reply from the server \(timeout\)\n/, 'on one line, whatever the file held');
  assert.match(status.stdout, /\n {2}acme\/other · its room\n {2}· the room does not share what agents find {2}asked 5 min ago\n/);
  assert.doesNotMatch(status.stdout, /no room shares/, 'one room shares, so the command that turns it on is not said');
  assert.doesNotMatch(status.stdout, /keeps what it finds to itself/);
  assert.match(status.stdout, /observations on this machine\n\s+acme\/app\s+3\n\s+acme\/other\s+1\n/, 'after what it said before');

  // this machine's veto: said once, and nothing of its own is counted as going
  await run(['observe', 'local', 'on'], m.env, repo);
  const kept = await run(['observe', 'status'], m.env, repo);
  assert.equal(kept.code, 0, kept.stderr);
  assert.match(kept.stdout, /\n {2}· this machine sends nothing of its own: 1 not sent · sent up to line 2 of its log\n/);
  assert.match(kept.stdout, /\n {2}· this machine keeps what it finds to itself \(observe local on\), whatever a room shares\n/);
  assert.doesNotMatch(kept.stdout, /this machine sends what it finds/);
  // and the variable that keeps it home the same way, read as the worker reads it (vetoesSharing in
  // hooks/observe.mjs): 0, false, off and no, in any letter case and with space around them
  await run(['observe', 'local', 'off'], m.env, repo);
  for (const word of ['0', 'false', 'off', 'no', 'OFF', 'False', ' No ']) {
    const variable = await run(['observe', 'status'], { ...m.env, AGENTMASH_OBSERVE_SHARE: word }, repo);
    assert.match(variable.stdout, /\n {2}· this machine sends nothing of its own: 1 not sent · sent up to line 2 of its log\n/, JSON.stringify(word));
    assert.ok(variable.stdout.includes(`keeps what it finds to itself (AGENTMASH_OBSERVE_SHARE=${word.trim()})`), JSON.stringify(word));
  }
  // any other word, an on word or none at all, is no veto
  for (const word of ['1', 'true', 'on', 'yes', 'maybe', 'offline', '']) {
    const variable = await run(['observe', 'status'], { ...m.env, AGENTMASH_OBSERVE_SHARE: word }, repo);
    assert.match(variable.stdout, /\n {2}✓ this machine sends what it finds: 1 waiting to be sent/, JSON.stringify(word));
    assert.doesNotMatch(variable.stdout, /keeps what it finds to itself/, JSON.stringify(word));
  }

  // the room turned sharing off again: no room shares, and the command that turns it on is said
  syncState(m, 'acme__app', { top: repo, sent: 2, sharing: false, share_since, pulled_at: Date.now() - MINUTE });
  const none = await run(['observe', 'status'], m.env, repo);
  assert.match(none.stdout, /\n {2}acme\/app · its room\n {2}· the room does not share what agents find {2}asked 1 min ago\n/);
  assert.match(none.stdout, /\n {2}· no room shares what this machine finds — npx agentmash observe share on turns it on/);
  untouched(repo);
});

test('observe share on sends the room\'s switch with the room key, says since when and what each teammate still does, and off sends it off', async () => {
  const mock = await startMockServer();
  const m = machine();
  const repo = roomCheckout(mock.url);
  const sent = () => mock.requests.map((r) => [r.method, r.path, r.room, r.body]);
  try {
    const on = await run(['observe', 'share', 'on'], m.env, repo);
    assert.equal(on.code, 0, on.stderr);
    assert.deepEqual(sent(), [['POST', '/rooms/settings', ROOM, { share_observations: true }]], 'one request: the room key and the switch, alone');
    assert.match(on.stdout, /Updated\. sharing what agents find on {2}since just now\n/);
    assert.match(on.stdout, /· the room keeps what agents find from now on, on machines that observe/);
    assert.match(on.stdout, /· each teammate still turns observing on for their own machine: npx agentmash observe on\n/);
    // a room's switch, and nothing of this machine's: no config, no script, no hook
    assert.ok(!fs.existsSync(path.join(m.home, '.agentmash')), 'nothing is written on this machine');
    assert.equal(fs.readFileSync(m.settings, 'utf8'), THEIRS_TEXT);

    // off, from a folder inside the checkout
    fs.mkdirSync(path.join(repo, 'src'));
    const off = await run(['observe', 'share', 'off'], m.env, path.join(repo, 'src'));
    assert.equal(off.code, 0, off.stderr);
    assert.deepEqual(sent().slice(1), [['POST', '/rooms/settings', ROOM, { share_observations: false }]]);
    assert.match(off.stdout, /Updated\. sharing what agents find off\n/);
    assert.doesNotMatch(off.stdout, /since/);
    assert.match(off.stdout, /· the room takes no more of what agents find and shows none; what it holds is kept/);
  } finally {
    await mock.close();
  }
});

test('observe share says what a refusal means, with what the server said, and exits 1', async () => {
  const m = machine();
  const refusals = [
    { status: 403, body: { error: 'signing in lets you work in this room; changing its settings takes its owner', code: 'room_key_required' } },
    { status: 401, body: { error: 'bob has to sign in again', code: 'reauth' } },
  ];
  for (const refusal of refusals) {
    const mock = await startMockServer({ settingsRefusal: refusal });
    try {
      const result = await run(['observe', 'share', 'on'], m.env, roomCheckout(mock.url));
      assert.equal(result.code, 1, refusal.body.code);
      assert.ok(result.stderr.includes(`sharing was not changed: the server turned the request away (HTTP ${refusal.status} ${refusal.body.code})`), result.stderr);
      assert.match(result.stderr, /it is the room's switch and takes the room's key/);
      assert.match(result.stderr, /a member's sign-in does not change a room's settings/);
      assert.ok(result.stderr.includes(refusal.body.error), 'and what the server said of it');
      assert.doesNotMatch(result.stdout, /Updated/);
    } finally {
      await mock.close();
    }
  }
  // a server from before a room could share answers with the settings it has, and none is this one
  const old = await startMockServer({ supportsSharing: false });
  try {
    const result = await run(['observe', 'share', 'on'], m.env, roomCheckout(old.url));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /this server is too old to share what agents find/);
    assert.doesNotMatch(result.stdout, /Updated/);
  } finally {
    await old.close();
  }
});

test('observe share in a checkout that carries no room key says so, exits 1 and asks no server', async () => {
  const m = machine();
  const repo = checkout();
  for (const want of ['on', 'off']) {
    // a request made would end the command with 97
    const result = await run(['observe', 'share', want], offline(m.env), repo);
    assert.equal(result.code, 1, want);
    assert.match(result.stderr, /this checkout carries no room key .*sharing is a room's switch, changed with the room's key/, want);
    assert.equal(result.stdout, '', want);
  }
  untouched(repo);
  const outside = await run(['observe', 'share', 'on'], offline(m.env), m.home);
  assert.equal(outside.code, 1);
  assert.match(outside.stderr, /carries no room key/);
  assert.ok(!fs.existsSync(path.join(m.home, '.agentmash')), 'and nothing is written');
});

test('observe local on writes this machine\'s veto to observe.json and off takes it back, changing nothing else and asking no server', async () => {
  const m = machine();
  await run(['observe', 'on'], m.env, m.home);
  // a cap of their own and a line observing knows nothing of: both are theirs to keep
  inHome(m, () => observe.writeConfig({ daily_cap: 40, theirs: 'kept' }));
  const before = json(m.config);
  const settings = fs.readFileSync(m.settings);

  const on = await run(['observe', 'local', 'on'], offline(m.env), m.home);
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /✓ this machine keeps what it finds to itself, whatever a room shares/);
  assert.deepEqual(json(m.config), { ...before, share: false }, 'share, and nothing else');
  const again = await run(['observe', 'local', 'on'], offline(m.env), m.home);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /· this machine was already keeping what it finds to itself/);
  assert.deepEqual(json(m.config), { ...before, share: false });

  const off = await run(['observe', 'local', 'off'], offline(m.env), m.home);
  assert.equal(off.code, 0, off.stderr);
  assert.match(off.stdout, /✓ what this machine finds goes to a room that shares/);
  assert.deepEqual(json(m.config), { ...before, share: true });
  const twice = await run(['observe', 'local', 'off'], { ...offline(m.env), AGENTMASH_OBSERVE_SHARE: '0' }, m.home);
  assert.match(twice.stdout, /· what this machine finds was already going to a room that shares/);
  assert.match(twice.stdout, /! AGENTMASH_OBSERVE_SHARE=0 is set here, and keeps it on this machine all the same/);
  assert.deepEqual(json(m.config), { ...before, share: true });

  assert.equal(json(m.config).enabled, true, 'observing stays on');
  assert.ok(fs.readFileSync(m.settings).equals(settings), 'and Claude Code\'s settings are as they were');

  // on a machine that never observed: its veto, and observing is not turned on by it
  const never = machine();
  const first = await run(['observe', 'local', 'on'], offline(never.env), never.home);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(json(never.config).share, false);
  assert.equal(json(never.config).enabled, false);
  assert.equal(fs.readFileSync(never.settings, 'utf8'), THEIRS_TEXT);
  assert.ok(!fs.existsSync(never.hooks), 'no script is copied');
});

test('observe log lists the repository\'s observations, newest first, and says so when there are none or no repository', async () => {
  const m = machine();
  const repo = checkout();
  seed(m, 'acme__app', [
    note('o_old', 3 * 60, { type: 'dead_end', files: ['src/a.js', 'src/b.js'] }),
    note('o_mid', 20, { type: 'command' }),
    note('o_new', 0, { type: 'rule', files: ['README.md'] }),
  ]);
  seed(m, 'acme__other', [note('o_elsewhere', 1, { repo: 'acme/other' })]);

  const all = await run(['observe', 'log'], m.env, repo);
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /acme\/app · 3 of 3 observations, newest first/);
  assert.match(all.stdout, /o_new\s+rule\s+what o_new found\n\s+just now · README\.md\n/);
  assert.match(all.stdout, /o_mid\s+command\s+what o_mid found\n\s+20 min ago · no file\n/);
  assert.match(all.stdout, /o_old\s+dead_end\s+what o_old found\n\s+3 h ago · src\/a\.js, src\/b\.js\n/);
  assert.ok(all.stdout.indexOf('o_new') < all.stdout.indexOf('o_mid') && all.stdout.indexOf('o_mid') < all.stdout.indexOf('o_old'), 'newest first');
  assert.doesNotMatch(all.stdout, /o_elsewhere/, 'another repository\'s are not this one\'s');

  // from a folder inside it, and only as many as asked for
  fs.mkdirSync(path.join(repo, 'src'));
  const two = await run(['observe', 'log', '-n', '2'], m.env, path.join(repo, 'src'));
  assert.equal(two.code, 0, two.stderr);
  assert.match(two.stdout, /2 of 3 observations/);
  assert.match(two.stdout, /o_new[\s\S]*o_mid/);
  assert.doesNotMatch(two.stdout, /o_old/);
  fs.rmSync(path.join(repo, 'src'), { recursive: true });

  const none = await run(['observe', 'log'], m.env, checkout('acme/quiet'));
  assert.equal(none.code, 0, none.stderr);
  assert.match(none.stdout, /no observations of acme\/quiet on this machine yet — observing is off: npx agentmash observe on/);

  const outside = await run(['observe', 'log'], m.env, m.home);
  assert.equal(outside.code, 1);
  assert.match(outside.stdout, /is not inside a git repository — observations are kept by repository/);
  untouched(repo);
});

test('observe forget removes one observation by its id, and says when there is none by it', async () => {
  const m = machine();
  const repo = checkout();
  seed(m, 'acme__app', [note('o_keep', 10), note('o_drop', 5)]);

  const found = await run(['observe', 'forget', 'o_drop'], m.env, m.home);
  assert.equal(found.code, 0, found.stderr);
  assert.match(found.stdout, /✓ forgot o_drop/);
  assert.deepEqual(inHome(m, () => observe.readObservations('acme__app')).map((o) => o.id), ['o_keep']);
  const log = await run(['observe', 'log'], m.env, repo);
  assert.match(log.stdout, /o_keep/);
  assert.doesNotMatch(log.stdout, /o_drop/);

  const missing = await run(['observe', 'forget', 'o_drop'], m.env, m.home);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /✗ no observation o_drop on this machine/);
  assert.deepEqual(inHome(m, () => observe.readObservations('acme__app')).map((o) => o.id), ['o_keep']);
});

test('doctor says how observing is doing on a machine where it is on, and nothing of it where it is off', async () => {
  const server = await startServer();
  const m = machine();
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env, m.home);
    const off = await run(['doctor'], m.env, m.home);
    assert.doesNotMatch(off.stdout, /observ/);

    await run(['observe', 'on'], m.env, m.home);
    inHome(m, () => {
      observe.writeSpool(observe.spoolEvent('prompt', { session_id: 's1', cwd: m.home, prompt: 'fix the build' }));
      observe.writeDead({ session: 's0', events: [] }, 'the reply was not JSON');
      observe.updateState((s) => Object.assign(s, { runs: 7, skipped: 2, dead: 1 }));
    });
    const on = await run(['doctor'], m.env, m.home);
    assert.equal(on.code, off.code, 'observing that works is no problem');
    assert.match(on.stdout, /✓ observing is on/);
    assert.match(on.stdout, /✓ claude is on the PATH/);
    assert.match(on.stdout, /✓ observe hooks installed in Claude Code/);
    assert.match(on.stdout, /· the observe worker is not running/);
    assert.match(on.stdout, /· waiting to be observed: 1 event in 1 session\n/);
    assert.match(on.stdout, /! 1 dead batch/);
    assert.match(on.stdout, /· observer runs today: 7 of 300\n/);

    const empty = tempDir('agentmash-obs-empty-');
    const lost = await run(['doctor'], { ...m.env, AGENTMASH_TOOL_PATH: empty }, m.home);
    assert.equal(lost.code, 1);
    assert.match(lost.stdout, /✗ claude is not on the PATH/);
    assert.match(lost.stdout, /problem\(s\) found/);
  } finally {
    await server.close();
  }
});

// The outbox is the hooks', whether a machine observes or not: a report a
// server outage would have lost waits there, and doctor is where a person
// finds out that some do.
test('doctor says how many reports wait in the outbox and how old the oldest is, warns once that is a day or the outbox is half full, and says nothing of an empty one', async () => {
  const server = await startServer();
  const m = machine();
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env, m.home);
    const empty = await run(['doctor'], m.env, m.home);
    assert.doesNotMatch(empty.stdout, /wait to be sent|waits to be sent|outbox/, 'an empty outbox is not spoken of');

    outbox(m, 3, 2 * DAY);
    const kept = await run(['doctor'], m.env, m.home);
    assert.equal(kept.code, empty.code, 'reports that wait are no problem');
    assert.match(kept.stdout, /· 3 reports from this machine wait to be sent to the room, the oldest from 2 days ago/);
    assert.match(kept.stdout, /! the oldest has waited over a day: .* is dropped after 7 days\n/);
    assert.doesNotMatch(kept.stdout, /over half full/);
    assert.doesNotMatch(kept.stdout, /observ/, 'and observing, which is off here, is still not spoken of');
    assert.equal(fs.readdirSync(path.join(m.home, '.agentmash', 'outbox')).length, 3, 'saying what waits sends and drops nothing');
  } finally {
    await server.close();
  }

  // one from a minute ago, in a checkout with no room on a machine that never signed in: counted, with no warning
  const fresh = machine();
  outbox(fresh, 1, MINUTE);
  const one = await run(['doctor'], fresh.env, checkout());
  assert.match(one.stdout, /· 1 report from this machine waits to be sent to the room, the oldest from 1 min ago/);
  assert.doesNotMatch(one.stdout, /the oldest has waited|over half full/);

  // over half of what it may hold
  const most = lib.OUTBOX_LIMITS?.entries ?? 2000;
  const full = machine();
  outbox(full, Math.floor(most / 2) + 1, MINUTE);
  const half = await run(['doctor'], full.env, checkout());
  assert.match(half.stdout, new RegExp(`! the outbox is over half full \\(${Math.floor(most / 2) + 1} of ${most} reports\\)`));
  assert.doesNotMatch(half.stdout, /the oldest has waited/);
});

/** The hooks' log of reports on `m`, written by hand: ~/.agentmash/log/reports.jsonl, a line each. */
function reportLog(m, lines) {
  const file = path.join(m.home, '.agentmash', 'log', 'reports.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

const SERVER_DOWN = 'http://127.0.0.1:9';
/** A line a hook logs for a report that did not arrive (failureLine in hooks/lib.mjs): `kept: true` when the outbox has it. */
const unheard = (repo, minutes, fields) => ({
  at: new Date(Date.now() - minutes * MINUTE).toISOString(),
  hook: 'post_tool_use',
  event_type: 'edit',
  tool: 'Edit',
  file_path: 'src/a.js',
  repo,
  room_ref: 'rm_abc123',
  url: SERVER_DOWN,
  ...fields,
  ms: 40,
});
/** A line the outbox logs for a kept report it gave up on (keptLine in hooks/lib.mjs). */
const givenUp = (repo, minutes, fields) => ({
  at: new Date(Date.now() - minutes * MINUTE).toISOString(),
  hook: 'outbox',
  event_type: 'edit',
  tool: 'Edit',
  file_path: 'src/a.js',
  repo,
  room_ref: 'rm_abc123',
  url: SERVER_DOWN,
  ...fields,
  tries: 4,
  kept_ms: 3 * 60 * MINUTE,
});

// A report the hooks kept to send again has a line in their log, as one that
// was lost has, and so has one the outbox later gave up on. Counted alike,
// an outage that lost nothing read as hundreds of lost reports, and a report
// kept and then dropped read as two.
test('doctor and status count a report the hooks kept as late, not lost, and one the outbox gave up on as lost, with why', async () => {
  const mock = await startMockServer();
  const m = machine();
  const repo = roomCheckout(mock.url);
  const kept = [
    unheard(repo, 50, { outcome: 'no_reply', error: 'ECONNREFUSED', kept: true }),
    unheard(repo, 49, { outcome: 'cut_off', kept: true }),
    unheard(repo, 48, { outcome: 'refused', status: 503, code: null, kept: true }),
  ];
  try {
    reportLog(m, [
      ...kept,
      // turned away by the room at once, which no later attempt would change: lost, as before there was an outbox
      unheard(repo, 40, { outcome: 'refused', status: 401, code: 'token_required' }),
      // and four the outbox gave up on: too old, too many, and one the room turned away when it was sent again
      givenUp(repo, 30, { outcome: 'expired' }),
      givenUp(repo, 29, { outcome: 'expired' }),
      givenUp(repo, 20, { outcome: 'overflow' }),
      givenUp(repo, 10, { outcome: 'refused', status: 401, code: 'token_required' }),
    ]);
    const doctor = await run(['doctor'], m.env, repo);
    assert.match(doctor.stdout, /! 5 reports from this machine never reached the room in the last 7 days/, 'eight lines, and three of them only late');
    assert.match(doctor.stdout, /\n {6}1× refused \(401 token_required\), last 40 min ago — this room wants a developer token from this machine: npx agentmash login --room\n/);
    assert.ok(
      doctor.stdout.includes(
        `\n      2× kept to send again, then given up on as too old, last 29 min ago — the server took none of them in the ${lib.OUTBOX_LIMITS.days} days a report is kept: check ${SERVER_DOWN} is up and this machine can get to it\n`
      ),
      doctor.stdout
    );
    assert.ok(
      doctor.stdout.includes(
        `\n      1× kept to send again, then dropped from a full outbox, last 20 min ago — more reports waited than the ${lib.OUTBOX_LIMITS.entries} the outbox holds, and the oldest edits and prompts go first: check ${SERVER_DOWN} is up`
      ),
      doctor.stdout
    );
    assert.match(doctor.stdout, /\n {6}1× kept to send again, then refused \(401 token_required\), last 10 min ago — this room wants a developer token from this machine: npx agentmash login --room\n/);
    assert.doesNotMatch(doctor.stdout, /no reply|cut off|503/, 'a kept report is in no line');

    const status = await run(['status'], m.env, repo);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /! 5 reports from this machine never reached the room in the last 24 hours/);

    // an outage and nothing else: every report was kept, none is lost, and neither command says one was
    reportLog(m, kept);
    outbox(m, 3, 50 * MINUTE);
    const late = await run(['doctor'], m.env, repo);
    assert.doesNotMatch(late.stdout, /never reached the room|reports\.jsonl/);
    assert.match(late.stdout, /· 3 reports from this machine wait to be sent to the room, the oldest from 50 min ago/, 'what waits is said where the outbox is');
    const quiet = await run(['status'], m.env, repo);
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.doesNotMatch(quiet.stdout, /never reached the room/);

    // a plan with no seat turns a kept report away when it is sent again: that is a problem now, as a first refusal is
    reportLog(m, [givenUp(repo, 5, { outcome: 'refused', status: 402, code: 'seat_limit' })]);
    const unpaid = await run(['doctor'], m.env, repo);
    assert.match(unpaid.stdout, /1× kept to send again, then refused \(402 seat_limit\), last 5 min ago — the team's plan has no seat left for this developer/);
    assert.match(unpaid.stdout, /✗ reports from this machine are being turned away: the team's plan has no seat left for this developer/);
  } finally {
    await mock.close();
  }
});

test('doctor says a sync with a room that failed in the last hour, in one line, where observing is on', async () => {
  const server = await startServer();
  const m = machine();
  const repo = checkout();
  const other = checkout('acme/other');
  const failed = (minutes, what) => ({ sharing: true, share_since: Date.now() - DAY, pulled_at: Date.now() - minutes * MINUTE, error: { at: Date.now() - minutes * MINUTE, what } });
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env, m.home);
    syncState(m, 'acme__app', { top: repo, ...failed(12, 'the server could not be reached') });
    const off = await run(['doctor'], m.env, m.home);
    assert.doesNotMatch(off.stdout, /observ|syncing/, 'observing is off: nothing of it is said');

    await run(['observe', 'on'], m.env, m.home);
    const on = await run(['doctor'], m.env, m.home);
    assert.equal(on.code, off.code, 'a sync that failed is no problem: what was found waits for the next');
    assert.match(on.stdout, /! syncing what agents found with the room failed for acme\/app, last 12 min ago: the server could not be reached\n/);

    // two repositories: one line, with the latest failure's words
    syncState(m, 'acme__other', { top: other, ...failed(3, 'HTTP 500') });
    const two = await run(['doctor'], m.env, m.home);
    assert.match(two.stdout, /! syncing what agents found with the room failed for acme\/other and acme\/app, last 3 min ago: HTTP 500\n/);
    assert.equal(two.stdout.match(/syncing what agents found/g).length, 1);

    // older than an hour, or none: `observe status` has it, and doctor says nothing
    syncState(m, 'acme__app', { top: repo, ...failed(61, 'the server could not be reached') });
    syncState(m, 'acme__other', { top: other, ...failed(3, null), error: null });
    const later = await run(['doctor'], m.env, m.home);
    assert.doesNotMatch(later.stdout, /syncing what agents found/);
    assert.match(later.stdout, /✓ observing is on/);
  } finally {
    await server.close();
  }
});
