// Factory Droid, as `npx agentmash login` connects it: our hooks in the
// person's own ~/.factory/hooks.json, after theirs, and our MCP server in
// ~/.factory/mcp.json, beside theirs; out again by logout, `tools remove` or
// nothing at all, leaving each file byte for byte as it was. Every test runs in
// a home of its own (fixtures/machine.mjs), with a stand-in for the `droid`
// command: no test reads or writes a real ~/.factory. Droid itself is not run
// here (it is closed source, and runs hooks only in a signed-in model turn);
// what it does with these entries is from Factory's docs, and the commands
// are run the way it runs them, through a shell.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import droid, { droidHooks, plainJson, readJsonc } from '../agents/droid.mjs';
import { agentPlaces } from '../tools.mjs';
import { CLI_DIR, baseEnv, command, json, machine, md5, run, runsOurs, shownHere, startServer } from './fixtures/machine.mjs';

const POSIX = process.platform !== 'win32';
const STAND_IN = { droid: `if (process.argv[2] === '--version' || process.argv[2] === '-v') console.log('0.233.0');` };
const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop'];

/** The person's own hooks.json: an audit of git commands, and a formatter after edits (the docs' own kinds of hook). */
const THEIRS = {
  PreToolUse: [{ matcher: 'Execute', commandRegex: '^git ', hooks: [{ type: 'command', command: '/usr/local/bin/audit-git-command.sh', timeout: 30 }] }],
  PostToolUse: [{ matcher: 'Create|Edit', hooks: [{ type: 'command', command: 'prettier --write "$FACTORY_PROJECT_DIR"', timeout: 30 }] }],
};
/** The person's own MCP servers. */
const THEIR_MCP = { mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } };

/** A machine with Droid on it and nothing else, and its files as the person left them (a value, or the text itself). */
function droidMachine({ hooks = null, mcp = null, settings = null, binary = true } = {}) {
  const m = machine({ with: binary ? ['droid'] : [], codex: false, cursor: false, copilot: false, scripts: STAND_IN });
  const dir = path.join(m.home, '.factory');
  fs.mkdirSync(dir, { recursive: true });
  const at = { hooks: path.join(dir, 'hooks.json'), mcp: path.join(dir, 'mcp.json'), settings: path.join(dir, 'settings.json') };
  for (const [key, value] of Object.entries({ hooks, mcp, settings })) {
    if (value !== null) fs.writeFileSync(at[key], typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  }
  return { ...m, dir, ...at };
}

const login = (server, m, extra = []) => run(['login', '--server', server.url, '--no-open', ...extra], m.env);
const ours = (map) => Object.values(map).flat().filter(runsOurs);
const placesOf = (m) => ({ ...agentPlaces(), home: m.home, toolPath: m.env.AGENTMASH_TOOL_PATH });

/** Run a command as Droid runs a hook: through a shell, the payload on stdin, in `cwd`. */
function asDroid(command, payload, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, cwd, env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

test("login connects Droid in its own hooks.json, after the person's hooks, and its MCP server beside theirs", async () => {
  const server = await startServer();
  const m = droidMachine({ hooks: THEIRS, mcp: THEIR_MCP });
  try {
    const out = await login(server, m);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/Factory Droid\s+connected\s+~\/\.factory\/hooks\.json/));
    assert.match(out.stdout, /refused once, with the warning as the reason, and the same edit again goes through/);
    assert.match(out.stdout, /restart any droid already open/);

    const hooks = json(m.hooks);
    assert.deepEqual(Object.keys(hooks), EVENTS, 'the event map itself: no "hooks" wrapper, which Droid ignores in this file');
    assert.deepEqual(hooks.PreToolUse[0], THEIRS.PreToolUse[0], 'their hook first, as it was');
    assert.deepEqual(hooks.PostToolUse[0], THEIRS.PostToolUse[0]);
    assert.equal(hooks.PreToolUse[1].matcher, 'Create|Edit|ApplyPatch');
    assert.equal(hooks.PostToolUse[1].matcher, 'Create|Edit|ApplyPatch|Execute');
    for (const event of ['UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop']) assert.equal(hooks[event][0].matcher, undefined, event);

    const named = { PreToolUse: 'pre_edit', PostToolUse: 'post_edit', UserPromptSubmit: 'prompt', SessionStart: 'session_start', SessionEnd: 'session_end', Stop: 'stop' };
    for (const event of EVENTS) {
      const group = hooks[event].at(-1);
      assert.equal(group.hooks.length, 1, event);
      const [hook] = group.hooks;
      assert.equal(hook.type, 'command');
      assert.equal(hook.command, `node "${path.join(m.hookDir, 'agent_hook.mjs')}" ${named[event]} --global --client droid`, event);
      assert.ok(Number.isInteger(hook.timeout) && hook.timeout >= 3 && hook.timeout <= 6, `${event}: ${hook.timeout} s`);
      assert.doesNotMatch(hook.command, /\d+\.\d+\.\d+/, 'no version of ours: the same command from one release to the next');
    }
    assert.equal(ours(hooks).length, EVENTS.length);

    const mcp = json(m.mcp);
    assert.deepEqual(mcp.mcpServers.linear, THEIR_MCP.mcpServers.linear);
    assert.deepEqual(mcp.mcpServers.agentmash, { type: 'stdio', command: 'node', args: [path.join(m.hookDir, 'mcp_server.mjs')] });

    // the scripts every entry runs, and the dialect the generic hook answers in
    assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')));
    assert.ok(fs.readFileSync(path.join(m.hookDir, 'dialects', 'droid.mjs')).equals(fs.readFileSync(path.join(CLI_DIR, '..', 'hooks', 'dialects', 'droid.mjs'))));
  } finally {
    await server.close();
  }
});

test('the command login registers runs as Droid runs it, through a shell, and says nothing when there is nothing to say', { skip: !POSIX && 'sh' }, async () => {
  const server = await startServer();
  const m = droidMachine({ hooks: THEIRS });
  try {
    await login(server, m);
    const hooks = json(m.hooks);
    const payload = {
      session_id: 'agentmash-test-session',
      transcript_path: path.join(m.home, '.factory', 'projects', 'x', 'agentmash-test-session.jsonl'),
      cwd: m.home,
      permission_mode: 'off',
      hook_event_name: 'PreToolUse',
      tool_name: 'Create',
      tool_input: { file_path: path.join(m.home, 'notes.md'), content: 'hello\n' },
    };
    for (const [event, group] of [['PreToolUse', hooks.PreToolUse[1]], ['PostToolUse', hooks.PostToolUse[1]]]) {
      const ran = await asDroid(group.hooks[0].command, { ...payload, hook_event_name: event }, m.env, m.home);
      assert.deepEqual([ran.code, ran.stdout, ran.stderr], [0, '', ''], event);
    }
  } finally {
    await server.close();
  }
});

test('login again is already connected and leaves both files byte for byte; logout gives them back byte for byte, in their own layout', async () => {
  const server = await startServer();
  // four spaces and no newline at the end: not how JSON.stringify would write it
  const hooksText = JSON.stringify(THEIRS, null, 4);
  const mcpText = JSON.stringify(THEIR_MCP, null, '\t').replace(/\n/g, '\r\n') + '\r\n';
  const m = droidMachine({ hooks: hooksText, mcp: mcpText });
  try {
    await login(server, m);
    const connected = fs.readFileSync(m.hooks, 'utf8');
    assert.match(connected, /\n {4}"PreToolUse": \[/, 'still four spaces');
    assert.ok(!connected.endsWith('\n'));
    assert.match(fs.readFileSync(m.mcp, 'utf8'), /\r\n\t"mcpServers"/, 'still tabs and CRLF');
    const [hooksSum, mcpSum] = [md5(m.hooks), md5(m.mcp)];
    const again = await login(server, m);
    assert.match(again.stdout, /Factory Droid\s+already connected/);
    assert.deepEqual([md5(m.hooks), md5(m.mcp)], [hooksSum, mcpSum]);

    // a hook the person adds after ours (in /hooks, say) leaves ours where it is
    const edited = json(m.hooks);
    edited.PreToolUse.push({ matcher: 'FetchUrl', hooks: [{ type: 'command', command: 'echo later' }] });
    fs.writeFileSync(m.hooks, JSON.stringify(edited, null, 4));
    const before = md5(m.hooks);
    assert.match((await login(server, m)).stdout, /Factory Droid\s+already connected/);
    assert.equal(md5(m.hooks), before);
    edited.PreToolUse.pop();
    fs.writeFileSync(m.hooks, JSON.stringify(edited, null, 4));

    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(fs.readFileSync(m.hooks, 'utf8'), hooksText, 'byte for byte');
    assert.equal(fs.readFileSync(m.mcp, 'utf8'), mcpText, 'byte for byte');
    assert.ok(!fs.existsSync(m.hookDir), 'nothing runs the scripts any more');
  } finally {
    await server.close();
  }
});

test('files login made are taken away again; the MCP file it made is private', async () => {
  const server = await startServer();
  const m = droidMachine();
  try {
    await login(server, m);
    assert.deepEqual(Object.keys(json(m.hooks)), EVENTS);
    assert.deepEqual(Object.keys(json(m.mcp)), ['mcpServers']);
    if (POSIX) assert.equal(fs.statSync(m.mcp).mode & 0o777, 0o600, 'it holds an MCP server');
    await run(['logout'], m.env);
    assert.ok(!fs.existsSync(m.hooks));
    assert.ok(!fs.existsSync(m.mcp));
    assert.ok(fs.existsSync(m.dir), 'the ~/.factory Droid keeps its own things in stays');
  } finally {
    await server.close();
  }
});

test("a hooks.json login makes starts as a copy of settings.json's hooks, which it would shadow, and settings.json is never written", async () => {
  const server = await startServer();
  // Droid reads its settings as JSON with comments: read, never written
  const settings = '{\n  // my model\n  "model": "claude-sonnet-5-5",\n  "hooks": {\n    "SessionStart": [{ "hooks": [{ "type": "command", "command": "~/bin/greet.sh" }] }],\n  },\n}\n';
  try {
    const m = droidMachine({ settings });
    const out = await login(server, m);
    assert.match(out.stdout, /Factory Droid\s+connected/);
    assert.match(out.stdout, shownHere(/your hooks in ~\/\.factory\/settings\.json are in ~\/\.factory\/hooks\.json too now, which Droid reads in their place; settings\.json is as it was/));
    const hooks = json(m.hooks);
    assert.deepEqual(hooks.SessionStart[0], { hooks: [{ type: 'command', command: '~/bin/greet.sh' }] }, 'theirs first, as settings.json has it');
    assert.equal(ours(hooks).length, EVENTS.length);
    assert.equal(fs.readFileSync(m.settings, 'utf8'), settings);
    if (POSIX) assert.equal(fs.statSync(m.hooks).mode & 0o777, 0o644, 'no wider than settings.json, 0644 as written');

    // their hook commands can carry a token: the copy is as private as what it was copied from
    const secret = droidMachine({ settings: settings.replace('~/bin/greet.sh', 'curl -H \\"Authorization: Bearer sk-secret\\" https://example.test') });
    fs.chmodSync(secret.settings, 0o600);
    await login(server, secret);
    assert.match(fs.readFileSync(secret.hooks, 'utf8'), /sk-secret/);
    if (POSIX) assert.equal(fs.statSync(secret.hooks).mode & 0o777, 0o600);
    assert.match((await login(server, m)).stdout, /Factory Droid\s+already connected/);

    await run(['logout'], m.env);
    assert.ok(!fs.existsSync(m.hooks), 'gone: Droid reads settings.json again');
    assert.equal(fs.readFileSync(m.settings, 'utf8'), settings);

    // a hook the person added to hooks.json since is theirs: the file stays, with it and the copy, without ours
    const kept = droidMachine({ settings });
    await login(server, kept);
    const edited = json(kept.hooks);
    edited.Notification = [{ hooks: [{ type: 'command', command: 'say done' }] }];
    fs.writeFileSync(kept.hooks, JSON.stringify(edited, null, 2) + '\n');
    await run(['logout'], kept.env);
    assert.deepEqual(json(kept.hooks), {
      SessionStart: [{ hooks: [{ type: 'command', command: '~/bin/greet.sh' }] }],
      Notification: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    });

    // a settings.json that does not read: its hooks cannot be copied, so nothing is made that would shadow them
    const broken = droidMachine({ settings: '{ "hooks": ' });
    const said = await login(server, broken);
    assert.match(said.stdout, shownHere(/Factory Droid\s+skipped — ~\/\.factory\/settings\.json could not be read, and Droid takes its hooks from there/));
    assert.ok(!fs.existsSync(broken.hooks));
  } finally {
    await server.close();
  }
});

test('hooks kept where Droid kept them before 0.136.0 are not guessed at: login says to let Droid move them', async () => {
  const server = await startServer();
  const m = droidMachine();
  try {
    fs.mkdirSync(path.join(m.dir, 'hooks'));
    const legacy = path.join(m.dir, 'hooks', 'hooks.json');
    fs.writeFileSync(legacy, JSON.stringify(THEIRS));
    const out = await login(server, m);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/Factory Droid\s+skipped — Droid keeps its hooks in ~\/\.factory\/hooks\/hooks\.json, where it did before 0\.136\.0 — open droid, type \/hooks and save/));
    assert.ok(!fs.existsSync(m.hooks));
    assert.ok(!fs.existsSync(m.mcp));
    assert.equal(fs.readFileSync(legacy, 'utf8'), JSON.stringify(THEIRS));
  } finally {
    await server.close();
  }
});

test('tools lists Factory Droid, and adds or removes it on its own; found by its command, its installer\'s folder or ~/.factory', async () => {
  const m = droidMachine({ hooks: THEIRS });
  const before = fs.readFileSync(m.hooks, 'utf8');
  const list = await run(['tools'], m.env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /droid\s+Factory Droid\s+found · 0\.233\.0\s+not connected/);

  const add = await run(['tools', 'add', 'droid'], m.env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /Factory Droid\s+connected/);
  assert.deepEqual(json(path.join(m.home, '.claude', 'settings.json')), { model: 'opus' }, 'one at a time: not even Claude Code');
  assert.match((await run(['tools'], m.env)).stdout, /droid\s+Factory Droid\s+found · 0\.233\.0\s+connected/);

  const remove = await run(['tools', 'remove', 'droid'], m.env);
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /Factory Droid\s+disconnected/);
  assert.equal(fs.readFileSync(m.hooks, 'utf8'), before);
  assert.match((await run(['tools', 'remove', 'droid'], m.env)).stdout, /Factory Droid\s+was not connected/);

  // the installer's own folder, not on PATH yet: the curl installer's ~/.local/bin, and ~\bin on Windows
  const installed = droidMachine({ binary: false });
  fs.rmSync(installed.dir, { recursive: true });
  const bin = POSIX ? path.join(installed.home, '.local', 'bin') : path.join(installed.home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  command(bin, 'droid', STAND_IN.droid);
  assert.match((await run(['tools'], installed.env)).stdout, /droid\s+Factory Droid\s+found · 0\.233\.0/);

  // ~/.factory alone, which droid makes on its first run
  const folder = droidMachine({ binary: false });
  assert.match((await run(['tools'], folder.env)).stdout, /droid\s+Factory Droid\s+found\s+not connected/);

  // neither: not on this machine, and login leaves it alone
  const server = await startServer();
  try {
    const none = droidMachine({ binary: false });
    fs.rmSync(none.dir, { recursive: true });
    assert.match((await run(['tools'], none.env)).stdout, /droid\s+Factory Droid\s+not found/);
    const out = await login(server, none);
    assert.match(out.stdout, /Factory Droid\s+skipped — not found on this machine/);
    assert.ok(!fs.existsSync(none.dir));
  } finally {
    await server.close();
  }
});

test('doctor says where Droid runs our hooks, and names a script that is not there', async () => {
  const server = await startServer();
  const m = droidMachine({ hooks: THEIRS, mcp: THEIR_MCP });
  try {
    await login(server, m);
    const first = await run(['doctor'], m.env, m.home);
    assert.match(first.stdout, shownHere(/Factory Droid: hooks in ~\/\.factory\/hooks\.json \(6 events\) · MCP server registered/));

    fs.rmSync(path.join(m.hookDir, 'agent_hook.mjs'));
    const broken = await run(['doctor'], m.env, m.home);
    assert.match(broken.stdout, /✗ Factory Droid: runs .*agent_hook\.mjs, which does not exist — every call fails — run: npx agentmash login/);
    assert.equal(broken.code, 1);
  } finally {
    await server.close();
  }
});

test("a hooks.json login cannot write cleanly is left as it is, and said; logout names one that still holds ours, and keeps the scripts", async () => {
  const server = await startServer();
  try {
    const cases = [
      ['{ "PreToolUse": ', /is not valid JSON — fix it, then run login again/],
      ['{\n  // audit git\n  "PreToolUse": []\n}\n', /has comments in it, which writing it back would lose — take them out, then run login again/],
      ['{\n  "PreToolUse": { "matcher": "Edit" }\n}\n', /has a PreToolUse that is not a list — fix it, then run login again/],
      ['[]', /is not valid JSON/],
    ];
    for (const [text, why] of cases) {
      const m = droidMachine({ hooks: text });
      const out = await login(server, m);
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, shownHere(new RegExp(`Factory Droid\\s+skipped — ~/\\.factory/hooks\\.json ${why.source}`)));
      assert.equal(fs.readFileSync(m.hooks, 'utf8'), text, 'not a byte changed');
      assert.ok(!fs.existsSync(m.mcp), 'nothing else written either');
    }

    // ours in it, then a comment added by hand, or the file broken: ours cannot come out without theirs
    for (const spoil of [(t) => t.replace('{', '{\n  // mine'), (t) => t.replace(/\}\s*$/, '')]) {
      const m = droidMachine({ hooks: THEIRS });
      await login(server, m);
      fs.writeFileSync(m.hooks, spoil(fs.readFileSync(m.hooks, 'utf8')));
      const spoiled = fs.readFileSync(m.hooks, 'utf8');
      const out = await run(['logout'], m.env);
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, shownHere(/~\/\.factory\/hooks\.json is not valid JSON: agentmash is still in it/));
      assert.match(out.stdout, shownHere(/kept .*\.agentmash\/hooks/));
      assert.equal(fs.readFileSync(m.hooks, 'utf8'), spoiled);
      assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')), 'what Droid still runs is still there');
    }

    // a trailing comma Droid reads is read too, and a broken file that never held ours is not ours to name
    const comma = droidMachine({ hooks: '{\n  "PreToolUse": [],\n}\n' });
    assert.match((await login(server, comma)).stdout, /Factory Droid\s+connected/);
    const clean = droidMachine({ hooks: '{ nope' });
    assert.doesNotMatch((await run(['logout'], clean.env)).stdout, /hooks\.json is not valid JSON/);
  } finally {
    await server.close();
  }
});

test('a symlinked file stays a link, and a private one stays private', { skip: !POSIX && 'POSIX modes and symlinks' }, async () => {
  const server = await startServer();
  try {
    const m = droidMachine();
    const dotfiles = path.join(m.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const targets = { hooks: path.join(dotfiles, 'droid-hooks.json'), mcp: path.join(dotfiles, 'droid-mcp.json') };
    const texts = { hooks: JSON.stringify(THEIRS, null, 2) + '\n', mcp: JSON.stringify(THEIR_MCP, null, 2) + '\n' };
    for (const key of ['hooks', 'mcp']) {
      fs.writeFileSync(targets[key], texts[key]);
      fs.chmodSync(targets[key], 0o600);
      fs.symlinkSync(targets[key], m[key]);
    }

    await login(server, m);
    for (const key of ['hooks', 'mcp']) {
      assert.ok(fs.lstatSync(m[key]).isSymbolicLink(), `${key}: still the link`);
      assert.equal(fs.statSync(targets[key]).mode & 0o777, 0o600, key);
    }
    assert.equal(ours(json(targets.hooks)).length, EVENTS.length, 'ours went into what it points at');
    assert.ok(json(targets.mcp).mcpServers.agentmash);
    for (const dir of [m.dir, dotfiles]) {
      assert.deepEqual(fs.readdirSync(dir).filter((f) => /tmp/.test(f)), [], `no temporary file left in ${dir}`);
    }

    await run(['logout'], m.env);
    for (const key of ['hooks', 'mcp']) {
      assert.ok(fs.lstatSync(m[key]).isSymbolicLink(), key);
      assert.equal(fs.readFileSync(targets[key], 'utf8'), texts[key], key);
      assert.equal(fs.statSync(targets[key]).mode & 0o777, 0o600, key);
    }
  } finally {
    await server.close();
  }
});

test("a server called agentmash of the person's own is left alone, and what they set on ours stays theirs", async () => {
  const server = await startServer();
  try {
    const mine = { mcpServers: { agentmash: { type: 'stdio', command: 'docker', args: ['run', 'my/agentmash'] } } };
    const m = droidMachine({ hooks: THEIRS, mcp: mine });
    const out = await login(server, m);
    assert.match(out.stdout, shownHere(/a server called agentmash is in ~\/\.factory\/mcp\.json already, and not ours: left as it is/));
    assert.deepEqual(json(m.mcp), mine);
    assert.equal(ours(json(m.hooks)).length, EVENTS.length, 'the hooks went in all the same');
    await run(['logout'], m.env);
    assert.deepEqual(json(m.mcp), mine);

    // switched off in Droid's /mcp, with a tool left out: login again does not switch it back on
    const off = droidMachine({ mcp: THEIR_MCP });
    await login(server, off);
    const config = json(off.mcp);
    Object.assign(config.mcpServers.agentmash, { disabled: true, disabledTools: ['agentmash_claim'] });
    fs.writeFileSync(off.mcp, JSON.stringify(config, null, 2) + '\n');
    const sum = md5(off.mcp);
    assert.match((await login(server, off)).stdout, /Factory Droid\s+already connected/);
    assert.equal(md5(off.mcp), sum);
    await run(['logout'], off.env);
    assert.deepEqual(json(off.mcp), THEIR_MCP, 'ours out, switched off or not');
  } finally {
    await server.close();
  }
});

test("AgentMash's Claude Code hooks imported into Droid are replaced by Droid's own, and a hook of the person's beside one of ours stays", async () => {
  const server = await startServer();
  try {
    const m = droidMachine();
    const claudeCommand = `node "${path.join(m.hookDir, 'pre_tool_use.mjs')}" --global`;
    fs.writeFileSync(
      m.hooks,
      JSON.stringify(
        {
          PreToolUse: [
            { matcher: 'Edit|Create', hooks: [{ type: 'command', command: '~/bin/lint.sh' }, { type: 'command', command: claudeCommand, timeout: 5 }] },
          ],
          PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: `node "${path.join(m.hookDir, 'post_tool_use.mjs')}" --global` }] }],
        },
        null,
        2
      ) + '\n'
    );
    const state = droid.inspect(placesOf(m));
    assert.equal(state.connected, false, 'not Droid\'s own: doctor says to connect it');
    assert.ok(state.warnings.some((w) => /runs AgentMash hooks that are not Droid's \(imported from Claude Code\?\)/.test(w)), state.warnings.join('\n'));

    await login(server, m);
    const hooks = json(m.hooks);
    assert.deepEqual(hooks.PreToolUse[0], { matcher: 'Edit|Create', hooks: [{ type: 'command', command: '~/bin/lint.sh' }] }, 'theirs kept, ours taken out of it');
    assert.ok(!JSON.stringify(hooks).includes('pre_tool_use.mjs') && !JSON.stringify(hooks).includes('post_tool_use.mjs'));
    assert.equal(ours(hooks).length, EVENTS.length);
    assert.deepEqual([droid.inspect(placesOf(m)).connected, droid.inspect(placesOf(m)).warnings], [true, []]);

    await run(['logout'], m.env);
    assert.deepEqual(json(m.hooks), { PreToolUse: [{ matcher: 'Edit|Create', hooks: [{ type: 'command', command: '~/bin/lint.sh' }] }] });
  } finally {
    await server.close();
  }
});

test("connect and inspect say what in Droid's own settings stops our hooks or the room being reached", () => {
  const m = droidMachine({ hooks: { ...THEIRS, hooksDisabled: true }, settings: { sandbox: { enabled: true } } });
  const places = placesOf(m);
  const said = droid.connect(places, m.hookDir);
  assert.equal(said.status, 'connected');
  assert.ok(said.notes.some((n) => shownHere(/hooks are switched off in ~\/\.factory\/hooks\.json \(hooksDisabled is true\)/).test(n)), said.notes.join('\n'));
  assert.ok(said.notes.some((n) => /sandbox is on .* allowed domains/.test(n)), said.notes.join('\n'));
  assert.equal(json(m.hooks).hooksDisabled, true, 'never switched back on for them');
  const state = droid.inspect(places);
  assert.deepEqual([state.connected, state.invalid, state.mcp, state.events], [true, false, true, EVENTS]);
  assert.equal(state.warnings.length, 2);
  assert.match(state.notes[0], /refused once/);
  assert.deepEqual(droid.files(places), { hooks: m.hooks, mcp: m.mcp });
  assert.equal(droid.disconnect(places, m.hookDir).status, 'removed');
  assert.deepEqual(json(m.hooks), { ...THEIRS, hooksDisabled: true });
});

test('what login registers is the same every time, and a hooks folder a shell would misread is never written', async () => {
  const dir = POSIX ? '/home/someone/.agentmash/hooks' : 'C:\\Users\\someone\\.agentmash\\hooks';
  assert.deepEqual(droidHooks(dir), droidHooks(dir));
  assert.deepEqual(droid.hooks(dir), droidHooks(dir));
  if (POSIX) assert.equal(droidHooks(dir).PreToolUse[0].hooks[0].command, 'node "/home/someone/.agentmash/hooks/agent_hook.mjs" pre_edit --global --client droid');
  assert.ok(!JSON.stringify(droidHooks(dir)).includes('"hooks":{"'), 'no wrapper');

  if (POSIX) {
    const server = await startServer();
    try {
      // ~/.agentmash under a folder with a $ in its name: Droid's shell would expand it in the command
      const m = droidMachine({ hooks: THEIRS });
      const env = { ...m.env, AGENTMASH_HOME: path.join(m.home, 'cost$HOME') };
      const said = await run(['login', '--server', server.url, '--no-open'], env);
      assert.match(said.stdout, /Factory Droid\s+skipped — .* has a \$, a quote or a backslash in its path/);
      assert.deepEqual(json(m.hooks), THEIRS);
    } finally {
      await server.close();
    }
  }

  // JSON with comments and trailing commas, as Droid reads it: a // in a string is text
  assert.deepEqual(plainJson('{"u": "http://x"}'), { text: '{"u": "http://x"}', comments: false });
  const commented = plainJson('{\n  // a\n  "u": "a\\"//b", /* c */ "v": [1, 2,],\n  "w": ", }",\n}');
  assert.equal(commented.comments, true);
  assert.deepEqual(JSON.parse(commented.text), { u: 'a"//b', v: [1, 2], w: ', }' });
  const m = droidMachine();
  const file = path.join(m.home, 'x.json');
  fs.writeFileSync(file, '\uFEFF{"a": 1}');
  assert.deepEqual(readJsonc(file).value, { a: 1 });
  fs.writeFileSync(file, '');
  assert.deepEqual(readJsonc(file).value, {});
  assert.equal(readJsonc(path.join(m.home, 'none.json')).existed, false);
});
