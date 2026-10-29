// Cline, as `npx agentmash login` connects it: three hook files of our own in
// ~/Documents/Cline/Hooks, among the person's, and our MCP server in Cline's
// shared ~/.cline/data/settings/cline_mcp_settings.json beside theirs, written
// under Cline's own lock; `logout` and `tools remove cline` take out exactly
// that. Every test runs in a home of its own (fixtures/machine.mjs), with the
// `cline` command replaced by a stand-in and CLINE_DIR, CLINE_DATA_DIR and
// CLINE_MCP_SETTINGS_PATH cleared unless a test sets one: nothing here may
// touch the real ~/Documents or ~/.cline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AGENTS, agentPlaces } from '../tools.mjs';
import { clineHooks, hooksDirs } from '../agents/cline.mjs';
import { CLI_DIR, command, json, machine, md5, run, startServer } from './fixtures/machine.mjs';
// a room that answers /check, and a checkout signed in to it: the hooks' own test machine
import { machine as checkout, session, startServer as startRoom } from '../../hooks/test/fixtures.mjs';

// The module is called in this process too: a developer's own Cline settings must not be what it reads.
for (const name of AGENTS.cline.env) delete process.env[name];

const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit'];
const POSIX = { skip: process.platform === 'win32' && 'POSIX modes, symlinks and sh' };

/** What is already in the person's Cline, which must come through login and logout untouched. */
const THEIRS = {
  // a hook of their own, in the folder ours go in
  hook: '#!/bin/bash\n# notify me when Cline finishes\nosascript -e \'display notification "Cline is done"\'\necho \'{"cancel":false}\'\n',
  mcp: { mcpServers: { github: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_theirs' }, disabled: false, timeout: 60 } } },
};

/** A machine with Cline on it: the CLI on the tool path, ~/.cline with the person's servers, and their own hook in ~/Documents/Cline/Hooks. */
function clineMachine({ cli = true, cline = true, documents = true } = {}) {
  const m = machine({
    with: cli ? ['cline'] : [],
    codex: false,
    cursor: false,
    copilot: false,
    scripts: { cline: `if (process.argv[2] === '--version') console.log('3.0.68');` },
  });
  const hooks = path.join(m.home, 'Documents', 'Cline', 'Hooks');
  const at = {
    hooks,
    theirs: path.join(hooks, 'TaskComplete'),
    mcp: path.join(m.home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
    ours: (name) => path.join(hooks, name),
  };
  fs.mkdirSync(path.join(m.home, 'Documents'));
  if (cline) {
    fs.mkdirSync(path.dirname(at.mcp), { recursive: true });
    // as Cline writes it: two spaces, a newline at the end
    fs.writeFileSync(at.mcp, `${JSON.stringify(THEIRS.mcp, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(at.mcp, 0o600);
  }
  if (cline && documents) {
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(at.theirs, THEIRS.hook, { mode: 0o755 });
    fs.chmodSync(at.theirs, 0o755);
  }
  return { ...m, at };
}

const login = (server, m, extra = []) => run(['login', '--server', server.url, '--no-open', ...extra], m.env);
const mode = (file) => fs.statSync(file).mode & 0o777;
const ourServer = (m) => ({ type: 'stdio', command: 'node', args: [path.join(m.hookDir, 'mcp_server.mjs')], disabled: false });
/** The places a CLI run in `m` would find, for calling the module itself. */
const placesOf = (m) => ({ ...agentPlaces(), home: m.home, toolPath: m.env.AGENTMASH_TOOL_PATH, vscodeUser: path.join(m.home, 'Code', 'User') });
/** Run a hook file as Cline would, without blocking this process (the room the hook asks lives in it): { status, stdout, stderr }. */
function runFile(command, args, { input, env, shell = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, shell, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    // a hook that exits before it reads, as one with no node to run does, closes the pipe under the write
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const tempsIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /tmp|\.lock|stale/.test(f)) : []);

test('login finds Cline and connects it: three hook files of our own beside theirs, our server after theirs', POSIX, async () => {
  const server = await startServer();
  const m = clineMachine();
  const before = md5(m.at.theirs);
  try {
    const out = await login(server, m);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /Cline\s+connected\s+~\/Documents\/Cline\/Hooks/);
    assert.match(out.stdout, /only after the edit it is about has run: it hears of a teammate in that file for its next step/);

    // ours: one executable file per event, each the generic hook for it, the same text every time
    const want = clineHooks(m.hookDir);
    assert.deepEqual(fs.readdirSync(m.at.hooks).sort(), ['PostToolUse', 'PreToolUse', 'TaskComplete', 'UserPromptSubmit']);
    for (const name of EVENTS) {
      const text = fs.readFileSync(m.at.ours(name), 'utf8');
      assert.equal(text, want[name], name);
      assert.equal(mode(m.at.ours(name)), 0o755, `${name}: Cline runs only an executable`);
      assert.ok(fs.lstatSync(m.at.ours(name)).isFile(), `${name}: a real file, which the CLI runs and a link it does not`);
      assert.match(text, /^#!\/bin\/sh\n# agentmash: /);
      assert.doesNotMatch(text, /\d+\.\d+\.\d+.*agent_hook|approve|trust|bypass|yolo/i, name);
    }
    assert.match(want.PreToolUse, new RegExp(`exec "\\$node" "${m.hookDir.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/agent_hook\\.mjs" pre_edit --global --client cline\\n$`));
    assert.match(want.PostToolUse, / post_edit --global --client cline\n$/);
    assert.match(want.UserPromptSubmit, / prompt --global --client cline\n$/);
    // what they run is there, with the dialect they answer in
    assert.ok(fs.readFileSync(path.join(m.hookDir, 'dialects', 'cline.mjs')).equals(fs.readFileSync(path.join(CLI_DIR, '..', 'hooks', 'dialects', 'cline.mjs'))));
    // not in ~/.cline/hooks as well: the CLI would run each one twice
    assert.ok(!fs.existsSync(path.join(m.home, '.cline', 'hooks')));

    // theirs: their hook byte for byte, their server first and as it was, ours after; the file still private
    assert.equal(md5(m.at.theirs), before);
    const mcp = json(m.at.mcp);
    assert.deepEqual(Object.keys(mcp.mcpServers), ['github', 'agentmash']);
    assert.deepEqual(mcp.mcpServers.github, THEIRS.mcp.mcpServers.github);
    assert.deepEqual(mcp.mcpServers.agentmash, ourServer(m), 'no autoApprove: approving is the person\'s');
    assert.equal(mode(m.at.mcp), 0o600);
    for (const dir of [m.at.hooks, path.dirname(m.at.mcp)]) assert.deepEqual(tempsIn(dir), [], `no lock or temporary file left in ${dir}`);
  } finally {
    await server.close();
  }
});

test('login again is already connected, and every file of Cline\'s is byte for byte as it was', POSIX, async () => {
  const server = await startServer();
  const m = clineMachine();
  try {
    await login(server, m);
    const files = [...EVENTS.map(m.at.ours), m.at.mcp, m.at.theirs];
    const before = files.map(md5);
    const again = await login(server, m);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Cline\s+already connected/);
    assert.deepEqual(files.map(md5), before);
  } finally {
    await server.close();
  }
});

test('logout takes out exactly what login wrote: their hook and their settings byte for byte, and folders it made', POSIX, async () => {
  const server = await startServer();
  try {
    const m = clineMachine();
    const before = { theirs: md5(m.at.theirs), mcp: md5(m.at.mcp) };
    await login(server, m);
    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /took agentmash out of every agent/);
    assert.deepEqual(fs.readdirSync(m.at.hooks), ['TaskComplete']);
    assert.equal(md5(m.at.theirs), before.theirs);
    assert.equal(md5(m.at.mcp), before.mcp);
    assert.equal(mode(m.at.mcp), 0o600);
    assert.ok(!fs.existsSync(m.hookDir));

    // a Cline with no hooks folder and no other server: nothing left behind
    const bare = clineMachine({ documents: false });
    fs.writeFileSync(bare.at.mcp, '{\n  "mcpServers": {}\n}\n');
    await login(server, bare);
    assert.ok(fs.existsSync(bare.at.ours('PreToolUse')));
    await run(['logout'], bare.env);
    assert.deepEqual(fs.readdirSync(path.join(bare.home, 'Documents')), [], 'the Cline and Hooks folders login made are gone');
    assert.ok(!fs.existsSync(bare.at.mcp), 'a settings file that held nothing but ours goes');
  } finally {
    await server.close();
  }
});

test('tools lists Cline, and adds or removes it on its own', POSIX, async () => {
  const m = clineMachine();
  const before = md5(m.at.mcp);
  const list = await run(['tools'], m.env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /cline\s+Cline\s+found · 3\.0\.68\s+not connected/);

  const add = await run(['tools', 'add', 'cline'], m.env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /Cline\s+connected/);
  assert.match((await run(['tools'], m.env)).stdout, /cline\s+Cline\s+found · 3\.0\.68\s+connected/);

  const remove = await run(['tools', 'remove', 'cline'], m.env);
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /Cline\s+disconnected/);
  assert.deepEqual(fs.readdirSync(m.at.hooks), ['TaskComplete']);
  assert.equal(md5(m.at.mcp), before);
  assert.match((await run(['tools'], m.env)).stdout, /cline\s+Cline\s+found · 3\.0\.68\s+not connected/);
});

test('doctor says where Cline\'s hooks are, and when what they run has gone', POSIX, async () => {
  const server = await startServer();
  const m = clineMachine();
  try {
    await login(server, m);
    const first = await run(['doctor'], m.env, m.home);
    assert.match(first.stdout, /Cline: hooks in ~\/Documents\/Cline\/Hooks \(3 events\) · MCP server registered/);

    fs.rmSync(path.join(m.hookDir, 'agent_hook.mjs'));
    const broken = await run(['doctor'], m.env, m.home);
    assert.match(broken.stdout, /✗ Cline: runs .*agent_hook\.mjs, which does not exist — every call fails — run: npx agentmash login/);
    assert.equal(broken.code, 1);
  } finally {
    await server.close();
  }
});

test('MCP settings that do not read are left as they are and named, by login and by logout', POSIX, async () => {
  const server = await startServer();
  try {
    const m = clineMachine();
    const broken = '{\n  "mcpServers": {\n    "github": { "command": "npx", }\n  }\n}\n';
    fs.writeFileSync(m.at.mcp, broken);
    const out = await login(server, m);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /Cline\s+connected/, 'the hooks do not need the server');
    assert.match(out.stdout, /~\/\.cline\/data\/settings\/cline_mcp_settings\.json is not valid JSON: the MCP server was not added/);
    assert.equal(fs.readFileSync(m.at.mcp, 'utf8'), broken);
    // nor one whose mcpServers Cline would not read
    fs.writeFileSync(m.at.mcp, '{ "mcpServers": [] }\n');
    assert.match((await login(server, m)).stdout, /is not valid JSON: the MCP server was not added/);
    assert.equal(fs.readFileSync(m.at.mcp, 'utf8'), '{ "mcpServers": [] }\n');

    // broken by hand after login: logout says which file, and keeps the scripts it still runs
    const later = clineMachine();
    await login(server, later);
    fs.writeFileSync(later.at.mcp, fs.readFileSync(later.at.mcp, 'utf8').replace(/\}\s*$/, ',}'));
    const left = await run(['logout'], later.env);
    assert.equal(left.code, 0, left.stderr);
    assert.match(left.stdout, /~\/\.cline\/data\/settings\/cline_mcp_settings\.json is not valid JSON: agentmash is still in it/);
    assert.match(left.stdout, /kept .*\.agentmash\/hooks/);
    assert.ok(fs.existsSync(path.join(later.hookDir, 'mcp_server.mjs')));
    assert.deepEqual(fs.readdirSync(later.at.hooks), ['TaskComplete'], 'our hooks are out all the same');
  } finally {
    await server.close();
  }
});

test("a hook file of the person's by our name is left alone, with its event, and so is a link", POSIX, async () => {
  const server = await startServer();
  const m = clineMachine();
  try {
    const mine = '#!/usr/bin/env python3\nimport sys, json\nprint(json.dumps({"cancel": False}))\n';
    fs.writeFileSync(m.at.ours('PreToolUse'), mine, { mode: 0o755 });
    const dotfiles = path.join(m.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    fs.writeFileSync(path.join(dotfiles, 'prompt-hook.sh'), '#!/bin/sh\necho \'{}\'\n', { mode: 0o755 });
    fs.symlinkSync(path.join(dotfiles, 'prompt-hook.sh'), m.at.ours('UserPromptSubmit'));

    const out = await login(server, m);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /~\/Documents\/Cline\/Hooks\/PreToolUse is a hook of your own: left as it is, and agentmash's PreToolUse with it/);
    assert.match(out.stdout, /UserPromptSubmit is a hook of your own/);
    assert.equal(fs.readFileSync(m.at.ours('PreToolUse'), 'utf8'), mine);
    assert.ok(fs.lstatSync(m.at.ours('UserPromptSubmit')).isSymbolicLink());
    assert.equal(fs.readFileSync(m.at.ours('PostToolUse'), 'utf8'), clineHooks(m.hookDir).PostToolUse);
    assert.deepEqual(AGENTS.cline.inspect(placesOf(m)).events, ['PostToolUse']);

    await run(['logout'], m.env);
    assert.equal(fs.readFileSync(m.at.ours('PreToolUse'), 'utf8'), mine);
    assert.ok(fs.lstatSync(m.at.ours('UserPromptSubmit')).isSymbolicLink());
    assert.ok(!fs.existsSync(m.at.ours('PostToolUse')));
  } finally {
    await server.close();
  }
});

test('the settings file keeps its link and its mode, and a hook the person switched off in Cline stays off', POSIX, async () => {
  const server = await startServer();
  try {
    const m = clineMachine();
    // cline_mcp_settings.json as stow or chezmoi leave it: a link into their dotfiles
    const dotfiles = path.join(m.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const target = path.join(dotfiles, 'cline_mcp_settings.json');
    fs.renameSync(m.at.mcp, target);
    fs.symlinkSync(target, m.at.mcp);
    const before = md5(target);

    await login(server, m);
    assert.ok(fs.lstatSync(m.at.mcp).isSymbolicLink(), 'still the link');
    assert.deepEqual(json(target).mcpServers.agentmash, ourServer(m), 'and ours went into what it points at');
    assert.equal(mode(target), 0o600);
    assert.deepEqual(tempsIn(dotfiles), []);

    // Cline's toggle takes the execute bit away; login again leaves it so, and says so
    fs.chmodSync(m.at.ours('PostToolUse'), 0o644);
    const again = await login(server, m);
    assert.match(again.stdout, /PostToolUse is switched off in Cline's hooks settings: left that way/);
    assert.equal(mode(m.at.ours('PostToolUse')), 0o644);
    // one of ours from an older login is brought up to date, its mode kept
    fs.writeFileSync(m.at.ours('PostToolUse'), fs.readFileSync(m.at.ours('PostToolUse'), 'utf8').replace(' --client cline', ' --client cline --detach'));
    await login(server, m);
    assert.equal(fs.readFileSync(m.at.ours('PostToolUse'), 'utf8'), clineHooks(m.hookDir).PostToolUse);
    assert.equal(mode(m.at.ours('PostToolUse')), 0o644);

    await run(['logout'], m.env);
    assert.ok(fs.lstatSync(m.at.mcp).isSymbolicLink());
    assert.equal(md5(target), before);

    // a settings file login makes is private from the start
    const fresh = clineMachine();
    fs.rmSync(fresh.at.mcp);
    await login(server, fresh);
    assert.equal(mode(fresh.at.mcp), 0o600);
    assert.deepEqual(json(fresh.at.mcp), { mcpServers: { agentmash: ourServer(fresh) } });
  } finally {
    await server.close();
  }
});

test("the settings are written under Cline's own lock: a held one is waited for and left, a dead one taken over", POSIX, async () => {
  const server = await startServer();
  try {
    const m = clineMachine();
    const lock = `${m.at.mcp}.lock`;
    // as Cline's writer holds it: a folder with its owner's file in it
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.4242.1.cline'), '4242.1.cline');
    const before = md5(m.at.mcp);
    const started = Date.now();
    const held = await login(server, m);
    assert.equal(held.code, 0, held.stderr);
    assert.ok(Date.now() - started >= 2000, 'it waited');
    assert.match(held.stdout, /Cline was writing ~\/\.cline\/data\/settings\/cline_mcp_settings\.json: the MCP server was not added — run login again/);
    assert.match(held.stdout, /Cline\s+connected/, 'the hooks all the same');
    assert.equal(md5(m.at.mcp), before);
    assert.deepEqual(fs.readdirSync(lock), ['owner.4242.1.cline'], 'their lock, as they left it');

    // ten seconds old: an owner that died with it, as Cline itself takes it over
    const old = new Date(Date.now() - 30_000);
    fs.utimesSync(lock, old, old);
    const taken = await login(server, m);
    assert.equal(taken.code, 0, taken.stderr);
    assert.doesNotMatch(taken.stdout, /Cline was writing/);
    assert.deepEqual(json(m.at.mcp).mcpServers.agentmash, ourServer(m));
    assert.deepEqual(tempsIn(path.dirname(m.at.mcp)), [], 'no lock left behind');
  } finally {
    await server.close();
  }
});

test("a server of ours Cline has rewritten, or from another hooks folder, is pointed here with the person's settings kept", POSIX, async () => {
  const server = await startServer();
  const m = clineMachine();
  try {
    const elsewhere = path.join(m.home, 'old', '.agentmash', 'hooks', 'mcp_server.mjs');
    fs.writeFileSync(
      m.at.mcp,
      `${JSON.stringify({ mcpServers: { ...THEIRS.mcp.mcpServers, agentmash: { transport: { type: 'stdio', command: 'node', args: [elsewhere] }, disabled: true, timeout: 120 } } }, null, 2)}\n`
    );
    await login(server, m);
    assert.deepEqual(json(m.at.mcp).mcpServers.agentmash, {
      transport: { type: 'stdio', command: 'node', args: [path.join(m.hookDir, 'mcp_server.mjs')] },
      disabled: true,
      timeout: 120,
    });
    assert.match((await run(['doctor'], m.env, m.home)).stdout, /Cline: hooks in .* · MCP server registered/);
    await run(['logout'], m.env);
    assert.deepEqual(json(m.at.mcp), THEIRS.mcp);
  } finally {
    await server.close();
  }
});

test('a hooks folder that cannot be written is said, the server goes in all the same, and logout keeps what still runs', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'POSIX permissions, not as root' }, async () => {
  const server = await startServer();
  const m = clineMachine();
  try {
    // what macOS does when the person said no to the terminal using ~/Documents, or a folder of theirs not writable
    fs.chmodSync(m.at.hooks, 0o555);
    const out = await login(server, m);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /Cline\s+connected/);
    assert.match(out.stdout, /~\/Documents\/Cline\/Hooks could not be written \(EACCES\): no hooks there/);
    if (process.platform === 'darwin') assert.match(out.stdout, /let your terminal use the Documents folder/);
    assert.deepEqual(json(m.at.mcp).mcpServers.agentmash, ourServer(m));
    fs.chmodSync(m.at.hooks, 0o755);

    // and the other way: ours are in, and the folder will not let them out
    await login(server, m);
    fs.chmodSync(m.at.hooks, 0o555);
    const left = await run(['logout'], m.env);
    assert.equal(left.code, 0, left.stderr);
    assert.match(left.stdout, /kept .*\.agentmash\/hooks: .*PreToolUse/);
    assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')), 'what Cline still runs is still there');
  } finally {
    fs.chmodSync(m.at.hooks, 0o755);
    await server.close();
  }
});

test('a machine with no sign of Cline is never looked at in ~/Documents, and --tools cline connects it all the same', POSIX, async () => {
  const server = await startServer();
  try {
    const m = clineMachine({ cli: false, cline: false });
    const places = placesOf(m);
    assert.equal(AGENTS.cline.detect(places).found, false);
    assert.deepEqual(Object.values(AGENTS.cline.files(places)), [m.at.mcp], 'nothing in ~/Documents for logout to read');
    assert.equal(AGENTS.cline.inspect(places).connected, false);
    const out = await login(server, m);
    assert.match(out.stdout, /Cline\s+skipped — not found on this machine/);
    assert.deepEqual(fs.readdirSync(path.join(m.home, 'Documents')), []);
    await run(['logout'], m.env);
    assert.deepEqual(fs.readdirSync(path.join(m.home, 'Documents')), []);

    const named = await login(server, m, ['--tools', 'claude,cline']);
    assert.match(named.stdout, /Cline\s+connected/);
    for (const name of EVENTS) assert.ok(fs.existsSync(m.at.ours(name)), name);
    assert.deepEqual(json(m.at.mcp), { mcpServers: { agentmash: ourServer(m) } });
    // and is found from then on, so logout takes it out
    assert.equal(AGENTS.cline.detect(places).found, true);
    await run(['logout'], m.env);
    assert.deepEqual(fs.readdirSync(path.join(m.home, 'Documents')), []);
  } finally {
    await server.close();
  }
});

test('CLINE_MCP_SETTINGS_PATH and CLINE_DIR say where the settings are, as they do for Cline', POSIX, async () => {
  const server = await startServer();
  try {
    const m = clineMachine();
    const own = path.join(m.home, 'elsewhere', 'mcp.json');
    await run(['tools', 'add', 'cline'], { ...m.env, CLINE_MCP_SETTINGS_PATH: own });
    assert.deepEqual(json(own).mcpServers.agentmash, ourServer(m));
    assert.equal(json(m.at.mcp).mcpServers.agentmash, undefined);

    const dir = path.join(m.home, 'cline-home');
    await run(['tools', 'add', 'cline'], { ...m.env, CLINE_DIR: dir });
    assert.deepEqual(json(path.join(dir, 'data', 'settings', 'cline_mcp_settings.json')).mcpServers.agentmash, ourServer(m));
  } finally {
    await server.close();
  }
});

test('the hook files run as Cline runs them, and say go on when there is no node to run', POSIX, async () => {
  const server = await startServer();
  const m = clineMachine();
  try {
    await login(server, m);
    // what VS Code sends before an edit (hooks/test/fixtures/cline): no room for this folder, so nothing to say
    const payload = JSON.stringify({
      clineVersion: '4.1.22',
      hookName: 'PreToolUse',
      timestamp: '1791158400123',
      taskId: 'task-1',
      workspaceRoots: [m.home],
      preToolUse: { toolName: 'editor', parameters: { path: path.join(m.home, 'a.ts'), old_text: 'a', new_text: 'b' } },
    });
    const env = { ...process.env, ...m.env };
    const vscode = await runFile(m.at.ours('PreToolUse'), [], { input: payload, env, shell: true });
    assert.deepEqual([vscode.status, vscode.stdout, vscode.stderr], [0, '{"cancel":false}\n', ''], 'as VS Code runs it: the file itself, through a shell');
    const cliRun = await runFile('sh', [m.at.ours('PostToolUse')], { input: payload.replace('PreToolUse', 'PostToolUse'), env });
    assert.deepEqual([cliRun.status, cliRun.stdout], [0, '{"cancel":false}\n'], 'as the CLI runs it: sh and the file');

    // and in a checkout of a connected repository, the advice comes back through it, in Cline's words
    const room = await startRoom();
    try {
      const repo = checkout(room.port);
      const before = JSON.stringify({
        clineVersion: '4.1.22',
        hookName: 'PreToolUse',
        timestamp: '1791158400123',
        // a session of its own: the advice is said once per session and file in ten minutes
        taskId: session(),
        workspaceRoots: [repo.project],
        preToolUse: { toolName: 'editor', parameters: { path: path.join(repo.project, 'src', 'models', 'user.ts'), old_text: 'id: string', new_text: 'id: number' } },
      });
      const advised = await runFile(m.at.ours('PreToolUse'), [], { input: before, env: { ...env, ...repo.env }, shell: true });
      assert.equal(advised.status, 0, advised.stderr);
      const answer = JSON.parse(advised.stdout);
      assert.equal(answer.cancel, false);
      assert.match(answer.contextModification, /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts[\s\S]*Cline passes a hook's note on only after the tool call/);
      assert.ok(room.requests.some((r) => r.path === '/check' && r.query.file_path === 'src/models/user.ts'));
    } finally {
      await room.close();
    }

    // the node login ran under is gone, and there is none on the PATH: Cline is told to go on
    const nodeless = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cline-nodeless-')), 'PreToolUse');
    fs.writeFileSync(nodeless, fs.readFileSync(m.at.ours('PreToolUse'), 'utf8').replace(/^node=".*"$/m, 'node="/nowhere/node"'), { mode: 0o755 });
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cline-path-'));
    const gone = await runFile('/bin/sh', [nodeless], { input: payload, env: { PATH: empty, HOME: m.home } });
    assert.deepEqual([gone.status, gone.stdout], [0, '{"cancel":false}\n']);
  } finally {
    await server.close();
  }
});

test('on Linux the hooks also go where VS Code takes Documents to be; on Windows none are written', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cline-dirs-')));
  fs.mkdirSync(path.join(home, '.cline'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cline-bin-'));
  const places = { ...agentPlaces(), home, toolPath: bin, vscodeUser: path.join(home, 'Code', 'User') };
  const env = { XDG_CONFIG_HOME: path.join(home, '.config') };
  const documents = path.join(home, 'Documents', 'Cline', 'Hooks');

  assert.deepEqual(hooksDirs(places, { platform: 'darwin', env }), [documents]);
  assert.deepEqual(hooksDirs(places, { platform: 'win32', env }), []);
  assert.deepEqual(hooksDirs(places, { platform: 'linux', env }), [documents], 'no xdg-user-dir: VS Code falls back to ~/Documents');

  // a command that is there is all it takes: it is never run
  command(bin, 'xdg-user-dir', '');
  assert.deepEqual(hooksDirs(places, { platform: 'linux', env }), [documents, path.join(home, 'Cline', 'Hooks')], 'nothing configured: xdg-user-dir says the home');
  fs.mkdirSync(env.XDG_CONFIG_HOME);
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, 'user-dirs.dirs'), '# written by xdg-user-dirs-update\nXDG_DESKTOP_DIR="$HOME/Рабочий стол"\nXDG_DOCUMENTS_DIR="$HOME/Документы"\n');
  assert.deepEqual(hooksDirs(places, { platform: 'linux', env }), [documents, path.join(home, 'Документы', 'Cline', 'Hooks')]);
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, 'user-dirs.dirs'), 'XDG_DOCUMENTS_DIR="$HOME/Documents"\n');
  assert.deepEqual(hooksDirs(places, { platform: 'linux', env }), [documents], 'the same folder once');
});
