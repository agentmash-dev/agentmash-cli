// Gemini CLI, as `npx agentmash login` connects it: our hooks and our MCP
// server in the person's own ~/.gemini/settings.json, after theirs, and out
// again by logout, `tools remove` or nothing at all, leaving the file byte for
// byte as it was. Every test runs in a home of its own (fixtures/machine.mjs),
// with a stand-in for the `gemini` command, and GEMINI_CLI_HOME cleared: no
// test reads or writes a real ~/.gemini. Gemini CLI itself is not run here;
// what it does with these entries is from its source (v0.62.0), and the
// commands are run the way it runs them, with `bash -c`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import gemini, { geminiCommand, geminiHooks, nodeFor, readSettings, withoutComments } from '../agents/gemini.mjs';
import { agentPlaces } from '../tools.mjs';
import { CLI_DIR, baseEnv, json, machine, md5, run, runsOurs, shownHere, startServer } from './fixtures/machine.mjs';

const POSIX = process.platform !== 'win32';
const STAND_IN = { gemini: `if (process.argv[2] === '--version') console.log('0.62.0');` };
const EVENTS = ['BeforeTool', 'AfterTool', 'BeforeAgent', 'SessionStart', 'SessionEnd'];

/** A machine with Gemini CLI on it and nothing else, and its settings as the person left them (`theirs`, a value or the text itself). */
function geminiMachine(theirs = null, { binary = true } = {}) {
  const m = machine({ with: binary ? ['gemini'] : [], codex: false, cursor: false, copilot: false, scripts: STAND_IN });
  const file = path.join(m.home, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (theirs !== null) fs.writeFileSync(file, typeof theirs === 'string' ? theirs : JSON.stringify(theirs, null, 2) + '\n');
  return { ...m, file };
}

/** The person's settings: their own hook on the shell, their own MCP server, and settings of theirs either side. */
const THEIRS = {
  general: { preferredEditor: 'vim' },
  hooks: { BeforeTool: [{ matcher: '^run_shell_command$', hooks: [{ name: 'my-guard', type: 'command', command: '~/bin/guard.sh', timeout: 2000 }] }] },
  mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] } },
  security: { auth: { selectedType: 'gemini-api-key' } },
};

const login = (server, m, extra = []) => run(['login', '--server', server.url, '--no-open', ...extra], m.env);
const ours = (settings) => Object.values(settings.hooks).flat().filter(runsOurs);

/** Run a command as Gemini CLI runs a hook: `bash -c`, the payload on stdin, in `cwd`. */
function asGemini(command, payload, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { cwd, env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
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

test("login connects Gemini CLI in its own settings.json, after the person's hooks and servers, and says what Gemini CLI does with them", async () => {
  const server = await startServer();
  const m = geminiMachine(THEIRS);
  try {
    const out = await login(server, m);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/Gemini CLI\s+connected\s+~\/\.gemini\/settings\.json/));
    assert.match(out.stdout, /only in a folder it trusts: in one you told it not to trust, it runs none of them/);
    assert.match(out.stdout, /refused once, with the warning as the reason, and the same edit again goes through/);

    const settings = json(m.file);
    assert.deepEqual(Object.keys(settings), ['general', 'hooks', 'mcpServers', 'security'], 'their keys where they were');
    assert.deepEqual(settings.general, THEIRS.general);
    assert.deepEqual(settings.security, THEIRS.security);
    assert.deepEqual(Object.keys(settings.hooks), EVENTS);
    assert.deepEqual(settings.hooks.BeforeTool[0], THEIRS.hooks.BeforeTool[0], 'their hook first, as it was');
    assert.equal(settings.hooks.BeforeTool[1].matcher, '^(write_file|replace)$');
    assert.equal(settings.hooks.AfterTool[0].matcher, '^(write_file|replace|run_shell_command)$');
    for (const event of ['BeforeAgent', 'SessionStart', 'SessionEnd']) assert.equal(settings.hooks[event][0].matcher, undefined, event);

    const node = POSIX ? process.execPath : 'node';
    const named = { BeforeTool: ['agentmash-pre-edit', 'pre_edit'], AfterTool: ['agentmash-post-edit', 'post_edit'], BeforeAgent: ['agentmash-prompt', 'prompt'], SessionStart: ['agentmash-session-start', 'session_start'], SessionEnd: ['agentmash-session-end', 'session_end'] };
    for (const group of ours(settings)) {
      assert.equal(group.hooks.length, 1);
      const [hook] = group.hooks;
      const event = Object.keys(settings.hooks).find((e) => settings.hooks[e].includes(group));
      assert.equal(hook.name, named[event][0]);
      assert.equal(hook.type, 'command');
      assert.equal(hook.command, geminiCommand(m.hookDir, named[event][1], node));
      if (POSIX) assert.equal(hook.command, `"${process.execPath}" "${path.join(m.hookDir, 'agent_hook.mjs')}" ${named[event][1]} --global --client gemini 2>/dev/null`);
      assert.ok(Number.isInteger(hook.timeout) && hook.timeout >= 3000 && hook.timeout <= 6000, `${event}: ${hook.timeout} ms`);
      assert.doesNotMatch(hook.command, /\$/, 'nothing Gemini CLI would read as a variable');
      assert.doesNotMatch(hook.command.replace(node, ''), /\d+\.\d+\.\d+/, 'no version of ours: the same command from one release to the next');
    }
    assert.deepEqual(settings.mcpServers.github, THEIRS.mcpServers.github);
    assert.deepEqual(settings.mcpServers.agentmash, { command: node, args: [path.join(m.hookDir, 'mcp_server.mjs')] });
    assert.equal('trust' in settings.mcpServers.agentmash, false, 'each call of our tools is the person\'s to approve');
    assert.ok(!JSON.stringify(settings).includes('hooksConfig'), "the person's switches are theirs");

    // the scripts every entry runs, and the dialect the generic hook answers in
    assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')));
    assert.ok(fs.readFileSync(path.join(m.hookDir, 'dialects', 'gemini.mjs')).equals(fs.readFileSync(path.join(CLI_DIR, '..', 'hooks', 'dialects', 'gemini.mjs'))));
  } finally {
    await server.close();
  }
});

test('the command login registers runs as Gemini CLI runs it, answers {}, and with its node gone says nothing at all', { skip: !POSIX && 'bash' }, async () => {
  const server = await startServer();
  const m = geminiMachine(THEIRS);
  try {
    await login(server, m);
    const command = json(m.file).hooks.BeforeTool[1].hooks[0].command;
    const payload = {
      session_id: 'agentmash-test-session',
      transcript_path: '',
      cwd: m.home,
      hook_event_name: 'BeforeTool',
      timestamp: '2026-10-05T09:14:03.512Z',
      tool_name: 'write_file',
      tool_input: { file_path: 'notes.md', content: 'hello\n' },
    };
    const ran = await asGemini(command, payload, m.env, m.home);
    assert.deepEqual([ran.code, ran.stdout, ran.stderr], [0, '{}\n', '']);

    // Gemini CLI reads text on stderr with exit 127 as a refusal: a node that has moved must make a failed hook, never that
    const moved = command.replace(process.execPath, path.join(m.home, 'gone', 'bin', 'node'));
    const failed = await asGemini(moved, payload, m.env, m.home);
    assert.deepEqual([failed.code, failed.stdout, failed.stderr], [127, '', '']);
  } finally {
    await server.close();
  }
});

test('login again is already connected and leaves the file byte for byte; logout gives it back byte for byte, in its own layout', async () => {
  const server = await startServer();
  // four spaces and no newline at the end: not how JSON.stringify would write it
  const text = JSON.stringify(THEIRS, null, 4);
  const m = geminiMachine(text);
  try {
    await login(server, m);
    const connected = fs.readFileSync(m.file, 'utf8');
    assert.match(connected, /\n {4}"hooks": \{/, 'still four spaces');
    assert.ok(!connected.endsWith('\n'));
    const again = await login(server, m);
    assert.match(again.stdout, /Gemini CLI\s+already connected/);
    assert.equal(fs.readFileSync(m.file, 'utf8'), connected);

    // a hook the person adds after ours leaves ours where it is
    const edited = json(m.file);
    edited.hooks.BeforeTool.push({ matcher: 'web_fetch', hooks: [{ type: 'command', command: 'echo later' }] });
    fs.writeFileSync(m.file, JSON.stringify(edited, null, 4));
    const before = md5(m.file);
    assert.match((await login(server, m)).stdout, /Gemini CLI\s+already connected/);
    assert.equal(md5(m.file), before);
    edited.hooks.BeforeTool.pop();
    fs.writeFileSync(m.file, JSON.stringify(edited, null, 4));

    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(fs.readFileSync(m.file, 'utf8'), text, 'byte for byte');
    assert.ok(!fs.existsSync(m.hookDir), 'nothing runs the scripts any more');
  } finally {
    await server.close();
  }
});

test('a settings file login made is private, and logout takes it away again', { skip: !POSIX && 'POSIX modes' }, async () => {
  const server = await startServer();
  const m = geminiMachine(null);
  try {
    await login(server, m);
    assert.equal(fs.statSync(m.file).mode & 0o777, 0o600, 'it holds an MCP server');
    assert.deepEqual(Object.keys(json(m.file)), ['hooks', 'mcpServers']);
    await run(['logout'], m.env);
    assert.ok(!fs.existsSync(m.file));
    assert.ok(fs.existsSync(path.dirname(m.file)), 'the ~/.gemini Gemini CLI keeps its own things in stays');
  } finally {
    await server.close();
  }
});

test('tools lists Gemini CLI, and adds or removes it on its own; ~/.gemini without the command is not Gemini CLI', async () => {
  const m = geminiMachine(THEIRS);
  const before = fs.readFileSync(m.file, 'utf8');
  const list = await run(['tools'], m.env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /gemini\s+Gemini CLI\s+found · 0\.62\.0\s+not connected/);

  const add = await run(['tools', 'add', 'gemini'], m.env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /Gemini CLI\s+connected/);
  assert.deepEqual(json(path.join(m.home, '.claude', 'settings.json')), { model: 'opus' }, 'one at a time: not even Claude Code');
  assert.match((await run(['tools'], m.env)).stdout, /gemini\s+Gemini CLI\s+found · 0\.62\.0\s+connected/);

  const remove = await run(['tools', 'remove', 'gemini'], m.env);
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /Gemini CLI\s+disconnected/);
  assert.equal(fs.readFileSync(m.file, 'utf8'), before);
  assert.match((await run(['tools', 'remove', 'gemini'], m.env)).stdout, /Gemini CLI\s+was not connected/);

  // Antigravity keeps its own things in ~/.gemini too: only the command says Gemini CLI is here
  const server = await startServer();
  try {
    const other = geminiMachine(THEIRS, { binary: false });
    fs.mkdirSync(path.join(other.home, '.gemini', 'antigravity-cli'), { recursive: true });
    assert.match((await run(['tools'], other.env)).stdout, /gemini\s+Gemini CLI\s+not found/);
    const out = await login(server, other);
    assert.match(out.stdout, /Gemini CLI\s+skipped — not found on this machine/);
    assert.deepEqual(json(other.file), THEIRS);
  } finally {
    await server.close();
  }
});

test('doctor says where Gemini CLI runs our hooks, and names a script or a node that is not there', async () => {
  const server = await startServer();
  const m = geminiMachine(THEIRS);
  try {
    await login(server, m);
    const first = await run(['doctor'], m.env, m.home);
    assert.match(first.stdout, shownHere(/Gemini CLI: hooks in ~\/\.gemini\/settings\.json \(5 events\) · MCP server registered/));

    fs.rmSync(path.join(m.hookDir, 'agent_hook.mjs'));
    const broken = await run(['doctor'], m.env, m.home);
    assert.match(broken.stdout, /✗ Gemini CLI: runs .*agent_hook\.mjs, which does not exist — every call fails — run: npx agentmash login/);
    assert.equal(broken.code, 1);

    if (POSIX) {
      await login(server, m);
      const gone = path.join(m.home, 'gone', 'bin', 'node');
      fs.writeFileSync(m.file, fs.readFileSync(m.file, 'utf8').split(process.execPath).join(gone));
      const moved = await run(['doctor'], m.env, m.home);
      assert.match(moved.stdout, new RegExp(`✗ Gemini CLI: runs ${gone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, which does not exist`));
      // and login puts the node that is there back
      assert.match((await login(server, m)).stdout, /Gemini CLI\s+connected/);
      assert.doesNotMatch(fs.readFileSync(m.file, 'utf8'), /gone/);
    }
  } finally {
    await server.close();
  }
});

test("inspect says what in the person's settings stops our hooks, and how Gemini CLI runs them; GEMINI_CLI_HOME is where it reads them", async () => {
  const m = geminiMachine({ ...THEIRS, hooksConfig: { enabled: false, disabled: ['agentmash-pre-edit'] } });
  const saved = process.env.GEMINI_CLI_HOME;
  const places = { ...agentPlaces(), home: m.home, toolPath: m.env.AGENTMASH_TOOL_PATH };
  try {
    delete process.env.GEMINI_CLI_HOME;
    const said = gemini.connect(places, m.hookDir);
    assert.equal(said.status, 'connected');
    assert.ok(said.notes.some((n) => /hooksConfig\.enabled is false/.test(n)), said.notes.join('\n'));
    assert.ok(said.notes.some((n) => /agentmash-pre-edit is switched off .*hooksConfig\.disabled/.test(n)), said.notes.join('\n'));
    assert.deepEqual(json(m.file).hooksConfig, { enabled: false, disabled: ['agentmash-pre-edit'] }, 'never switched back on for them');
    const state = gemini.inspect(places);
    assert.deepEqual([state.connected, state.invalid, state.mcp, state.events], [true, false, true, EVENTS]);
    assert.equal(state.warnings.length, 2);
    assert.match(state.notes[0], /only in a folder it trusts/);
    assert.deepEqual(gemini.files(places), { settings: m.file });

    // GEMINI_CLI_HOME: the home Gemini CLI reads .gemini from, ours with it
    const alt = path.join(m.home, 'elsewhere');
    process.env.GEMINI_CLI_HOME = alt;
    assert.deepEqual(gemini.files(places), { settings: path.join(alt, '.gemini', 'settings.json') });
    assert.equal(gemini.connect(places, m.hookDir).status, 'connected');
    assert.ok(ours(json(path.join(alt, '.gemini', 'settings.json'))).length === 5);
    assert.equal(gemini.disconnect(places, m.hookDir).status, 'removed');
    assert.ok(!fs.existsSync(path.join(alt, '.gemini', 'settings.json')));
  } finally {
    if (saved === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = saved;
  }
});

test("a settings file login cannot write cleanly is left as it is, and said; logout names one that still holds ours, and keeps the scripts", async () => {
  const server = await startServer();
  try {
    const cases = [
      ['{ "general": { "preferredEditor": ', /is not valid JSON — fix it, then run login again/],
      ['{\n  // my editor\n  "general": { "preferredEditor": "vim" }\n}\n', /has comments in it, which writing it back would lose — take them out, then run login again/],
      ['{\n  "hooks": [1, 2]\n}\n', /has a "hooks" that is not an object/],
    ];
    for (const [text, why] of cases) {
      const m = geminiMachine(text);
      const out = await login(server, m);
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, shownHere(new RegExp(`Gemini CLI\\s+skipped — ~/\\.gemini/settings\\.json ${why.source}`)));
      assert.equal(fs.readFileSync(m.file, 'utf8'), text, 'not a byte changed');
    }

    // ours in it, then a comment added by hand, or the file broken: ours cannot come out without theirs
    for (const spoil of [(t) => t.replace('{', '{\n  // mine'), (t) => t.replace(/\}\s*$/, ',}')]) {
      const m = geminiMachine(THEIRS);
      await login(server, m);
      fs.writeFileSync(m.file, spoil(fs.readFileSync(m.file, 'utf8')));
      const spoiled = fs.readFileSync(m.file, 'utf8');
      const out = await run(['logout'], m.env);
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, shownHere(/~\/\.gemini\/settings\.json is not valid JSON: agentmash is still in it/));
      assert.match(out.stdout, shownHere(/kept .*\.agentmash\/hooks/));
      assert.equal(fs.readFileSync(m.file, 'utf8'), spoiled);
      assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')), 'what Gemini CLI still runs is still there');
    }

    // a broken file that never held ours is not ours to name
    const clean = geminiMachine('{ nope');
    const out = await run(['logout'], clean.env);
    assert.doesNotMatch(out.stdout, /settings\.json is not valid JSON/);
  } finally {
    await server.close();
  }
});

test('a symlinked settings file stays a link, and a private one stays private', { skip: !POSIX && 'POSIX modes and symlinks' }, async () => {
  const server = await startServer();
  try {
    const m = geminiMachine(null);
    const dotfiles = path.join(m.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const target = path.join(dotfiles, 'gemini-settings.json');
    const text = JSON.stringify(THEIRS, null, 2) + '\n';
    fs.writeFileSync(target, text);
    fs.chmodSync(target, 0o600);
    fs.symlinkSync(target, m.file);

    await login(server, m);
    assert.ok(fs.lstatSync(m.file).isSymbolicLink(), 'still the link');
    assert.equal(ours(json(target)).length, 5, 'ours went into what it points at');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    for (const dir of [path.dirname(m.file), dotfiles]) {
      assert.deepEqual(fs.readdirSync(dir).filter((f) => /tmp/.test(f)), [], `no temporary file left in ${dir}`);
    }

    await run(['logout'], m.env);
    assert.ok(fs.lstatSync(m.file).isSymbolicLink());
    assert.equal(fs.readFileSync(target, 'utf8'), text);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  } finally {
    await server.close();
  }
});

test("a server called agentmash of the person's own is left alone, and a path Gemini CLI would read a variable in is never written", async () => {
  const server = await startServer();
  try {
    const mine = { ...THEIRS, mcpServers: { agentmash: { command: 'docker', args: ['run', 'my/agentmash'] } } };
    const m = geminiMachine(mine);
    const out = await login(server, m);
    assert.match(out.stdout, shownHere(/a server called agentmash is in ~\/\.gemini\/settings\.json already, and not ours: left as it is/));
    assert.deepEqual(json(m.file).mcpServers, mine.mcpServers);
    assert.equal(ours(json(m.file)).length, 5, 'the hooks went in all the same');
    await run(['logout'], m.env);
    assert.deepEqual(json(m.file), mine);

    if (POSIX) {
      // ~/.agentmash under a folder with a $ in its name: Gemini CLI would expand it in the command
      const odd = geminiMachine(THEIRS);
      const env = { ...odd.env, AGENTMASH_HOME: path.join(odd.home, 'cost$HOME') };
      const said = await run(['login', '--server', server.url, '--no-open'], env);
      assert.match(said.stdout, /Gemini CLI\s+skipped — .* has a \$, a quote or a backslash in its path/);
      assert.deepEqual(json(odd.file), THEIRS);
    }
  } finally {
    await server.close();
  }
});

test('what login registers is the same every time, names node as the person reaches it, and reads settings as Gemini CLI does', { skip: !POSIX && 'POSIX paths' }, () => {
  const dir = '/home/someone/.agentmash/hooks';
  assert.deepEqual(geminiHooks(dir, '/usr/local/bin/node'), geminiHooks(dir, '/usr/local/bin/node'));
  assert.equal(
    geminiHooks(dir, '/usr/local/bin/node').BeforeTool[0].hooks[0].command,
    '"/usr/local/bin/node" "/home/someone/.agentmash/hooks/agent_hook.mjs" pre_edit --global --client gemini 2>/dev/null'
  );
  assert.equal(geminiCommand(dir, 'prompt', 'node'), 'node "/home/someone/.agentmash/hooks/agent_hook.mjs" prompt --global --client gemini', 'as on Windows');
  // Gemini CLI expands $NAME and ${NAME} anywhere in its settings: a matcher's closing $ is not one
  assert.doesNotMatch(JSON.stringify(geminiHooks(dir, '/usr/local/bin/node')), /\$[\w{]/);
  assert.deepEqual(gemini.hooks(dir), gemini.hooks(dir));

  // the node on PATH by the link that reaches this one; another node on PATH is not trusted to be one this runs on
  const m = machine({ with: [] });
  const bin = m.env.AGENTMASH_TOOL_PATH;
  assert.equal(nodeFor({ toolPath: bin }), process.execPath);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  assert.equal(nodeFor({ toolPath: bin }), path.join(bin, 'node'));
  fs.rmSync(path.join(bin, 'node'));
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\n');
  fs.chmodSync(path.join(bin, 'node'), 0o755);
  assert.equal(nodeFor({ toolPath: bin }), process.execPath);

  // JSON with comments, as strip-json-comments reads it: a // in a string is text
  assert.deepEqual(withoutComments('{"u": "http://x"}'), { text: '{"u": "http://x"}', comments: false });
  const commented = withoutComments('{\n  // a\n  "u": "a\\"//b", /* c */ "v": 1\n}');
  assert.equal(commented.comments, true);
  assert.deepEqual(JSON.parse(commented.text), { u: 'a"//b', v: 1 });
  const file = path.join(m.home, 'settings.json');
  fs.writeFileSync(file, '\t{"a": 1}');
  assert.deepEqual(readSettings(file).value, { a: 1 });
  fs.writeFileSync(file, '');
  assert.deepEqual(readSettings(file).value, {});
  assert.equal(readSettings(path.join(m.home, 'none.json')).existed, false);
});
