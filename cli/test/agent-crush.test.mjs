// Crush, as `npx agentmash login` connects it: our hook and our MCP server in
// the person's own user-level crush.json (~/.config/crush/crush.json), after
// theirs, and out again by logout, `tools remove` or nothing at all, leaving
// the file byte for byte as it was. Every test runs in a home of its own
// (fixtures/machine.mjs), with a stand-in for the `crush` command, and
// CRUSH_GLOBAL_CONFIG, CRUSH_GLOBAL_DATA and the XDG folders cleared or
// pointed into that home: no test reads or writes a real ~/.config/crush.
// Crush itself is not run here; what it does with these entries is from its
// source (v0.63.0 to v0.97.1), and the command is run the way Crush ran it
// before its embedded shell (v0.67.0), with `sh -c`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crush, { EDIT_MATCHER, configFile, crushHooks, readConfig } from '../agents/crush.mjs';
import { agentPlaces } from '../tools.mjs';
import { CLI_DIR, baseEnv, json, machine, md5, run, runsOurs, shownHere, startServer } from './fixtures/machine.mjs';

const POSIX = process.platform !== 'win32';
const STAND_IN = { crush: `if (process.argv[2] === '--version') console.log('crush version v0.97.1');` };

/** A machine with Crush on it and nothing else, and its crush.json as the person left it (`theirs`, a value or the text itself). */
function crushMachine(theirs = null, { binary = true } = {}) {
  const m = machine({ with: binary ? ['crush'] : [], codex: false, cursor: false, copilot: false, scripts: STAND_IN });
  const file = path.join(m.home, '.config', 'crush', 'crush.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (theirs !== null) fs.writeFileSync(file, typeof theirs === 'string' ? theirs : JSON.stringify(theirs, null, 2) + '\n');
  // a hook run here hands its edit to a watcher: one that gives up soon
  return { ...m, env: { ...m.env, AGENTMASH_CRUSH_WATCH_MS: '300' }, file };
}

/** The person's crush.json: their schema, their own hook on bash, their own MCP server, and settings of theirs either side. */
const THEIRS = {
  $schema: 'https://charm.land/crush.json',
  options: { tui: { compact_mode: true } },
  hooks: { PreToolUse: [{ name: 'no-rm-rf', matcher: '^bash$', command: '/home/someone/bin/no-rm-rf.sh', timeout: 10 }] },
  mcp: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer $GH_PAT' } } },
  permissions: { allowed_tools: ['view', 'ls'] },
};

const login = (server, m, extra = []) => run(['login', '--server', server.url, '--no-open', ...extra], m.env);
const ours = (config) => Object.values(config.hooks ?? {}).flat().filter(runsOurs);

/** Run a command as Crush ran a hook before its embedded shell (v0.67.0): `sh -c`, the payload on stdin, its variables set, in `cwd`. */
function asCrush(command, payload, env, cwd) {
  return new Promise((resolve, reject) => {
    const crushEnv = {
      CRUSH: '1',
      AGENT: 'crush',
      AI_AGENT: 'crush',
      CRUSH_EVENT: payload.event,
      CRUSH_TOOL_NAME: payload.tool_name,
      CRUSH_SESSION_ID: payload.session_id,
      CRUSH_CWD: cwd,
      CRUSH_PROJECT_DIR: cwd,
      CRUSH_TOOL_INPUT_FILE_PATH: payload.tool_input.file_path,
    };
    const child = spawn('sh', ['-c', command], { cwd, env: { ...baseEnv, ...env, ...crushEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
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

test("login connects Crush in its own crush.json, after the person's hooks and servers, and says what Crush does with them", async () => {
  const server = await startServer();
  const m = crushMachine(THEIRS);
  try {
    const out = await login(server, m);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/Crush\s+connected\s+~\/\.config\/crush\/crush\.json/));
    assert.match(out.stdout, /refused once, with the warning as the reason, and the same edit again goes through/);
    assert.match(out.stdout, /an edit is reported once the file changes, and prompts, sessions and shell commands are not/);
    assert.match(out.stdout, /from v0\.63\.0 on, and loads it as it starts: restart Crush if it is running/);

    const config = json(m.file);
    assert.deepEqual(Object.keys(config), ['$schema', 'options', 'hooks', 'mcp', 'permissions'], 'their keys where they were');
    assert.deepEqual(config.options, THEIRS.options);
    assert.deepEqual(config.permissions, THEIRS.permissions, 'never an allowed tool of ours');
    assert.deepEqual(Object.keys(config.hooks), ['PreToolUse']);
    assert.equal(config.hooks.PreToolUse.length, 2);
    assert.deepEqual(config.hooks.PreToolUse[0], THEIRS.hooks.PreToolUse[0], 'their hook first, as it was');
    assert.deepEqual(config.hooks.PreToolUse[1], {
      name: 'agentmash-pre-edit',
      matcher: '^(edit|multiedit|write|lsp_replace_symbol|download)$',
      command: `node "${path.join(m.hookDir, 'agent_hook.mjs')}" pre_edit --global --client crush`,
      timeout: 5,
    });
    assert.ok(Number.isInteger(config.hooks.PreToolUse[1].timeout), 'Crush reads whole seconds, and does not start with anything else');
    assert.deepEqual(config.mcp.github, THEIRS.mcp.github);
    assert.deepEqual(config.mcp.agentmash, { type: 'stdio', command: 'node', args: [path.join(m.hookDir, 'mcp_server.mjs')] });

    // the matcher, as Crush tests it: unanchored, so anchored here
    const matcher = new RegExp(EDIT_MATCHER);
    for (const tool of ['edit', 'multiedit', 'write', 'lsp_replace_symbol', 'download']) assert.ok(matcher.test(tool), tool);
    for (const tool of ['view', 'bash', 'lsp_rename', 'mcp_docs_edit_page', 'multiedit2', 'rewrite']) assert.ok(!matcher.test(tool), tool);

    // the scripts the entry runs, and the dialect the generic hook answers in
    assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')));
    assert.ok(fs.readFileSync(path.join(m.hookDir, 'dialects', 'crush.mjs')).equals(fs.readFileSync(path.join(CLI_DIR, '..', 'hooks', 'dialects', 'crush.mjs'))));
  } finally {
    await server.close();
  }
});

test('the command login registers runs as Crush runs it, and says nothing for a file outside any repository', { skip: !POSIX && 'sh' }, async () => {
  const server = await startServer();
  const m = crushMachine(THEIRS);
  try {
    await login(server, m);
    const command = json(m.file).hooks.PreToolUse[1].command;
    const payload = {
      event: 'PreToolUse',
      session_id: '9f3c1e2a-4b5d-4e6f-8a7b-0c1d2e3f4a5b',
      cwd: m.home,
      tool_name: 'write',
      tool_input: { file_path: 'notes.md', content: 'hello\n' },
    };
    const ran = await asCrush(command, payload, m.env, m.home);
    // exit 0 and nothing: no opinion, and Crush asks the person whatever it would have
    assert.deepEqual([ran.code, ran.stdout, ran.stderr], [0, '', '']);

    // a home with a space and an apostrophe in its name: both are only text in the command's double quotes
    const odd = crushMachine(THEIRS);
    const env = { ...odd.env, AGENTMASH_HOME: path.join(odd.home, "o'brien's home") };
    assert.match((await run(['login', '--server', server.url, '--no-open'], env)).stdout, /Crush\s+connected/);
    const quoted = json(odd.file).hooks.PreToolUse[1].command;
    assert.ok(quoted.includes("o'brien's home"), quoted);
    const again = await asCrush(quoted, { ...payload, cwd: odd.home }, env, odd.home);
    assert.deepEqual([again.code, again.stdout, again.stderr], [0, '', '']);
  } finally {
    await server.close();
  }
});

test('login again is already connected and leaves the file byte for byte; logout gives it back byte for byte, in its own layout', async () => {
  const server = await startServer();
  // four spaces and no newline at the end: not how JSON.stringify would write it
  const text = JSON.stringify(THEIRS, null, 4);
  const m = crushMachine(text);
  try {
    await login(server, m);
    const connected = fs.readFileSync(m.file, 'utf8');
    assert.match(connected, /\n {4}"hooks": \{/, 'still four spaces');
    assert.ok(!connected.endsWith('\n'));
    const again = await login(server, m);
    assert.match(again.stdout, /Crush\s+already connected/);
    assert.equal(fs.readFileSync(m.file, 'utf8'), connected);

    // a hook the person adds after ours leaves ours where it is
    const edited = json(m.file);
    edited.hooks.PreToolUse.push({ matcher: '^write$', command: 'echo later' });
    fs.writeFileSync(m.file, JSON.stringify(edited, null, 4));
    const before = md5(m.file);
    assert.match((await login(server, m)).stdout, /Crush\s+already connected/);
    assert.equal(md5(m.file), before);
    edited.hooks.PreToolUse.pop();
    fs.writeFileSync(m.file, JSON.stringify(edited, null, 4));

    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(fs.readFileSync(m.file, 'utf8'), text, 'byte for byte');
    assert.ok(!fs.existsSync(m.hookDir), 'nothing runs the scripts any more');
  } finally {
    await server.close();
  }
});

test('a crush.json login made is private, and logout takes it away again', { skip: !POSIX && 'POSIX modes' }, async () => {
  const server = await startServer();
  const m = crushMachine(null);
  try {
    await login(server, m);
    assert.equal(fs.statSync(m.file).mode & 0o777, 0o600, 'it holds an MCP server');
    assert.deepEqual(Object.keys(json(m.file)), ['hooks', 'mcp']);
    await run(['logout'], m.env);
    assert.ok(!fs.existsSync(m.file));
    assert.ok(fs.existsSync(path.dirname(m.file)), 'the folder stays');
    // and the empty folder left behind is not taken for Crush on a machine without it
    const without = { ...m.env, AGENTMASH_TOOL_PATH: path.join(m.home, 'no-bin') };
    assert.match((await run(['tools'], without)).stdout, /crush\s+Crush\s+not found/);
  } finally {
    await server.close();
  }
});

test('tools lists Crush, and adds or removes it on its own; its folders say it is here without the command', async () => {
  const m = crushMachine(THEIRS);
  const before = fs.readFileSync(m.file, 'utf8');
  const list = await run(['tools'], m.env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /crush\s+Crush\s+found · crush version v0\.97\.1\s+not connected/);

  const add = await run(['tools', 'add', 'crush'], m.env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /Crush\s+connected/);
  assert.ok(!fs.existsSync(path.join(m.home, '.codex')), 'one at a time');
  assert.match((await run(['tools'], m.env)).stdout, /crush\s+Crush\s+found · crush version v0\.97\.1\s+connected/);

  const remove = await run(['tools', 'remove', 'crush'], m.env);
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /Crush\s+disconnected/);
  assert.equal(fs.readFileSync(m.file, 'utf8'), before);
  assert.match((await run(['tools', 'remove', 'crush'], m.env)).stdout, /Crush\s+was not connected/);

  const server = await startServer();
  try {
    // no command, but the person's configuration, or the state Crush keeps once it has run
    const configured = crushMachine(THEIRS, { binary: false });
    assert.match((await run(['tools'], configured.env)).stdout, /crush\s+Crush\s+found\s+not connected/);
    const ran = crushMachine(null, { binary: false });
    fs.rmSync(path.dirname(ran.file), { recursive: true });
    // where Crush keeps it on this OS (%LOCALAPPDATA%\crush on Windows)
    const data = process.platform === 'win32' ? path.join(ran.home, 'AppData', 'Local', 'crush') : path.join(ran.home, '.local', 'share', 'crush');
    fs.mkdirSync(data, { recursive: true });
    assert.match((await run(['tools'], ran.env)).stdout, /crush\s+Crush\s+found\s+not connected/);

    // none of it: not here, and login leaves it alone
    const none = crushMachine(null, { binary: false });
    fs.rmSync(path.dirname(none.file), { recursive: true });
    assert.match((await run(['tools'], none.env)).stdout, /crush\s+Crush\s+not found/);
    const out = await login(server, none);
    assert.match(out.stdout, /Crush\s+skipped — not found on this machine/);
    assert.ok(!fs.existsSync(none.file));
  } finally {
    await server.close();
  }
});

test('doctor says where Crush runs our hook, and names a script that is not there', async () => {
  const server = await startServer();
  const m = crushMachine(THEIRS);
  try {
    await login(server, m);
    const first = await run(['doctor'], m.env, m.home);
    assert.match(first.stdout, shownHere(/✓ Crush: hooks in ~\/\.config\/crush\/crush\.json \(1 event\) · MCP server registered/));

    fs.rmSync(path.join(m.hookDir, 'agent_hook.mjs'));
    const broken = await run(['doctor'], m.env, m.home);
    assert.match(broken.stdout, /✗ Crush: runs .*agent_hook\.mjs, which does not exist — every call fails — run: npx agentmash login/);
    assert.equal(broken.code, 1);
  } finally {
    await server.close();
  }
});

test('a crush.json login cannot write cleanly is left as it is, and said; logout names one that still holds ours, and keeps the scripts', async () => {
  const server = await startServer();
  try {
    const cases = [
      ['{ "options": { "tui": ', /is not valid JSON, which Crush needs to start at all — fix it, then run login again/],
      // the docs show comments; Crush itself reads strict JSON, and does not start with them
      ['{\n  // mine\n  "options": {}\n}\n', /is not valid JSON, which Crush needs to start at all/],
      ['{\n  "options": {},\n}\n', /is not valid JSON, which Crush needs to start at all/],
      ['{\n  "hooks": [1, 2]\n}\n', /has a "hooks" that is not an object/],
      ['{\n  "hooks": { "PreToolUse": { "command": "x" } }\n}\n', /has a "hooks\.PreToolUse" that is not a list/],
    ];
    for (const [text, why] of cases) {
      const m = crushMachine(text);
      const out = await login(server, m);
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, shownHere(new RegExp(`Crush\\s+skipped — ~/\\.config/crush/crush\\.json ${why.source}`)));
      assert.equal(fs.readFileSync(m.file, 'utf8'), text, 'not a byte changed');
    }

    // ours in it, then the file broken by hand: ours cannot come out without theirs
    const m = crushMachine(THEIRS);
    await login(server, m);
    fs.writeFileSync(m.file, fs.readFileSync(m.file, 'utf8').replace(/\}\s*$/, ',}'));
    const spoiled = fs.readFileSync(m.file, 'utf8');
    const doctor = await run(['doctor'], m.env, m.home);
    assert.match(doctor.stdout, shownHere(/✗ Crush: ~\/\.config\/crush\/crush\.json is not valid JSON, so Crush runs none of its hooks/));
    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/~\/\.config\/crush\/crush\.json is not valid JSON: agentmash is still in it/));
    assert.match(out.stdout, shownHere(/kept .*\.agentmash\/hooks/));
    assert.equal(fs.readFileSync(m.file, 'utf8'), spoiled);
    assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')), 'what Crush still runs is still there');

    // a broken file that never held ours is not ours to name
    const clean = crushMachine('{ nope');
    const said = await run(['logout'], clean.env);
    assert.doesNotMatch(said.stdout, /crush\.json is not valid JSON/);
  } finally {
    await server.close();
  }
});

test('a symlinked crush.json stays a link, and a private one stays private', { skip: !POSIX && 'POSIX modes and symlinks' }, async () => {
  const server = await startServer();
  try {
    const m = crushMachine(null);
    const dotfiles = path.join(m.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const target = path.join(dotfiles, 'crush.json');
    const text = JSON.stringify(THEIRS, null, 2) + '\n';
    fs.writeFileSync(target, text);
    fs.chmodSync(target, 0o600);
    fs.symlinkSync(target, m.file);

    await login(server, m);
    assert.ok(fs.lstatSync(m.file).isSymbolicLink(), 'still the link');
    assert.equal(ours(json(target)).length, 1, 'ours went into what it points at');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    for (const dir of [path.dirname(m.file), dotfiles]) {
      assert.deepEqual(fs.readdirSync(dir).filter((f) => /tmp/.test(f)), [], `no temporary file left in ${dir}`);
    }

    await run(['logout'], m.env);
    assert.ok(fs.lstatSync(m.file).isSymbolicLink());
    assert.equal(fs.readFileSync(target, 'utf8'), text);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);

    // a crush.json of theirs that is not private stays as open as they left it
    const open = crushMachine(THEIRS);
    fs.chmodSync(open.file, 0o644);
    await login(server, open);
    assert.equal(fs.statSync(open.file).mode & 0o777, 0o644);
  } finally {
    await server.close();
  }
});

test("a server called agentmash of the person's own is left alone, ours switched off stays off, and a path Crush's shell would read is never written", async () => {
  const server = await startServer();
  try {
    const mine = { ...THEIRS, mcp: { agentmash: { type: 'stdio', command: 'docker', args: ['run', 'my/agentmash'] } } };
    const m = crushMachine(mine);
    const out = await login(server, m);
    assert.match(out.stdout, shownHere(/a server called agentmash is in ~\/\.config\/crush\/crush\.json already, and not ours: left as it is/));
    assert.deepEqual(json(m.file).mcp, mine.mcp);
    assert.equal(ours(json(m.file)).length, 1, 'the hook went in all the same');
    await run(['logout'], m.env);
    assert.deepEqual(json(m.file), mine);

    // ours, switched off by the person: kept off, and said
    const off = crushMachine(THEIRS);
    await login(server, off);
    const config = json(off.file);
    config.mcp.agentmash.disabled = true;
    fs.writeFileSync(off.file, JSON.stringify(config, null, 2) + '\n');
    const again = await login(server, off);
    assert.match(again.stdout, /Crush\s+already connected/);
    assert.match(again.stdout, shownHere(/the MCP server is switched off in ~\/\.config\/crush\/crush\.json \("disabled": true\)/));
    assert.equal(json(off.file).mcp.agentmash.disabled, true);

    if (POSIX) {
      // ~/.agentmash under a folder with a $ in its name: Crush's shell would expand it
      const odd = crushMachine(THEIRS);
      const env = { ...odd.env, AGENTMASH_HOME: path.join(odd.home, 'cost$HOME') };
      const said = await run(['login', '--server', server.url, '--no-open'], env);
      assert.match(said.stdout, /Crush\s+skipped — .* has a \$, a backtick, a double quote or a backslash in its path/);
      assert.deepEqual(json(odd.file), THEIRS);
    }
  } finally {
    await server.close();
  }
});

test('Crush reads its configuration from CRUSH_GLOBAL_CONFIG, else XDG_CONFIG_HOME, else ~/.config, and inspect says what it finds', async () => {
  const m = crushMachine(THEIRS);
  // LOCALAPPDATA too: on Windows Crush's data folder is in it, and the real one is no business of this test
  const keys = ['CRUSH_GLOBAL_CONFIG', 'CRUSH_GLOBAL_DATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'LOCALAPPDATA'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const places = { ...agentPlaces(), home: m.home, toolPath: m.env.AGENTMASH_TOOL_PATH };
  try {
    for (const k of keys) delete process.env[k];
    assert.equal(configFile(places), path.join(m.home, '.config', 'crush', 'crush.json'));
    assert.deepEqual(crush.files(places), { config: m.file });
    const said = crush.connect(places, m.hookDir);
    assert.equal(said.status, 'connected');
    const state = crush.inspect(places);
    assert.deepEqual(
      [state.connected, state.invalid, state.mcp, state.events, state.where],
      [true, false, true, ['PreToolUse'], ['~', '.config', 'crush', 'crush.json'].join(path.sep)]
    );
    assert.deepEqual(state.warnings, []);
    assert.equal(crush.connect(places, m.hookDir).status, 'already');
    assert.equal(crush.disconnect(places, m.hookDir).status, 'removed');
    assert.deepEqual(json(m.file), THEIRS);

    process.env.XDG_CONFIG_HOME = path.join(m.home, 'xdg');
    assert.equal(configFile(places), path.join(m.home, 'xdg', 'crush', 'crush.json'));
    // CRUSH_GLOBAL_CONFIG names the folder, and wins
    const alt = path.join(m.home, 'elsewhere');
    process.env.CRUSH_GLOBAL_CONFIG = alt;
    assert.deepEqual(crush.files(places), { config: path.join(alt, 'crush.json') });
    assert.equal(crush.connect(places, m.hookDir).status, 'connected');
    assert.equal(ours(json(path.join(alt, 'crush.json'))).length, 1);
    assert.equal(crush.disconnect(places, m.hookDir).status, 'removed');
    assert.ok(!fs.existsSync(path.join(alt, 'crush.json')));
    assert.deepEqual(json(m.file), THEIRS, 'the other file never touched');

    // its data folder says Crush has run here; it is looked at, never written
    delete process.env.CRUSH_GLOBAL_CONFIG;
    process.env.XDG_CONFIG_HOME = path.join(m.home, 'nothing-here');
    const bare = { ...places, toolPath: path.join(m.home, 'no-bin') };
    assert.equal(crush.detect(bare).found, false);
    process.env.CRUSH_GLOBAL_DATA = path.join(m.home, 'state');
    fs.mkdirSync(process.env.CRUSH_GLOBAL_DATA);
    assert.equal(crush.detect(bare).found, true);
    assert.deepEqual(fs.readdirSync(process.env.CRUSH_GLOBAL_DATA), []);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('what login registers is the same every time, with no version in it, and crush.json is read as Crush reads it', { skip: !POSIX && 'POSIX paths' }, () => {
  const dir = '/home/someone/.agentmash/hooks';
  assert.deepEqual(crushHooks(dir), crushHooks(dir));
  assert.deepEqual(crush.hooks(dir), {
    PreToolUse: [
      {
        name: 'agentmash-pre-edit',
        matcher: '^(edit|multiedit|write|lsp_replace_symbol|download)$',
        command: 'node "/home/someone/.agentmash/hooks/agent_hook.mjs" pre_edit --global --client crush',
        timeout: 5,
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(crushHooks(dir)), /\d+\.\d+\.\d+/, 'no version of ours: the same command from one release to the next');

  const m = crushMachine(null);
  const file = path.join(m.home, 'crush.json');
  fs.writeFileSync(file, '\t{"a": 1}');
  assert.deepEqual(readConfig(file).value, { a: 1 });
  fs.writeFileSync(file, '');
  assert.deepEqual(readConfig(file).value, {});
  fs.writeFileSync(file, '{"a": 1, /* no */ "b": 2}');
  assert.equal(readConfig(file).invalid, true, 'Crush reads strict JSON');
  fs.writeFileSync(file, '[1]');
  assert.equal(readConfig(file).invalid, true);
  assert.equal(readConfig(path.join(m.home, 'none.json')).existed, false);
});
