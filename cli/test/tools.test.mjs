// `npx agentmash login` connects every coding agent on the machine, at user
// level, and `npx agentmash logout` takes all of it out again; `npx agentmash
// tools` lists them and adds or removes one at a time. Every test runs in a
// home of its own, with the agents' commands replaced by stand-ins that
// record what they were asked (AGENTMASH_TOOL_PATH is where the CLI looks for
// them): nothing here may touch the real ~/.codex, ~/.cursor or ~/.copilot.
// The machine, the stand-ins and the server are in fixtures/machine.mjs, for
// the tests of an agent added since to build on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseToml } from '../toml.mjs';
import { AGENTS, agentFiles, agentPlaces, codexHooks, codexServerBlock, copilotHooks, cursorHooks, namesFolder } from '../tools.mjs';
import { CLI_DIR, THEIRS, baseEnv, json, machine, md5, run, runsOurs, shownHere, startServer, vscodeMcp } from './fixtures/machine.mjs';

test('login connects every agent it finds, at user level, and says for each what it did', async () => {
  const server = await startServer();
  const m = machine();
  try {
    const result = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(result.code, 0, result.stderr);
    const out = result.stdout;
    assert.match(out, /Claude Code\s+connected/);
    assert.match(out, /Codex\s+connected/);
    assert.match(out, /open codex, type \/hooks, and approve agentmash/);
    assert.match(out, /Cursor\s+connected/);
    assert.match(out, /GitHub Copilot\s+connected/);
    assert.match(out, /Devin\s+skipped — not found on this machine/);

    // Codex: its own hooks.json, theirs first and as it was, then ours, for each of Codex's events
    const codex = json(path.join(m.home, '.codex', 'hooks.json'));
    assert.deepEqual(codex.hooks.PreToolUse[0], THEIRS.codexHooks.hooks.PreToolUse[0]);
    assert.deepEqual(Object.keys(codex.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    assert.deepEqual(Object.keys(codex), ['hooks'], 'nothing beside hooks: Codex refuses a hooks.json with keys it does not know');
    const pre = codex.hooks.PreToolUse[1];
    assert.equal(pre.matcher, '^apply_patch$');
    assert.equal(pre.hooks[0].command, `node "${path.join(m.hookDir, 'pre_tool_use.mjs')}" --global --client codex`);
    for (const group of Object.values(codex.hooks).flat().filter(runsOurs)) {
      for (const hook of group.hooks) {
        // the same string from one version to the next: Codex keys the person's approval to it
        assert.doesNotMatch(hook.command, /\d+\.\d+\.\d+|bypass|trust/i, hook.command);
        const script = /"([^"]+)"/.exec(hook.command)[1];
        assert.ok(fs.existsSync(script), `${script} is there`);
      }
    }
    assert.match(JSON.stringify(codex.hooks.PostToolUse), /--detach/, 'reports go to the background: Codex waits for every hook');
    // `codex mcp add` would rewrite the whole of config.toml in Codex's own
    // formatting (seen on Codex 0.160.0); our block goes on the end instead
    assert.ok(!m.calls().some((c) => c.startsWith('codex ["mcp"')), m.calls().join('\n'));
    const toml = fs.readFileSync(path.join(m.home, '.codex', 'config.toml'), 'utf8');
    assert.ok(toml.startsWith(THEIRS.codexConfig), 'their config, untouched, then ours');
    assert.match(toml, /\[mcp_servers\.agentmash\]/);
    assert.doesNotMatch(fs.readFileSync(path.join(m.home, '.codex', 'config.toml'), 'utf8'), /trusted_hash/, 'approving is the person\'s to do, in /hooks');

    // Cursor: hooks.json and mcp.json, theirs kept
    const cursor = json(path.join(m.home, '.cursor', 'hooks.json'));
    assert.equal(cursor.version, 1);
    assert.deepEqual(cursor.hooks.afterFileEdit[0], THEIRS.cursorHooks.hooks.afterFileEdit[0]);
    assert.deepEqual(cursor.hooks.preToolUse, [{ command: `node "${path.join(m.hookDir, 'cursor_hook.mjs')}" --global`, matcher: 'Write', timeout: 5 }]);
    assert.ok(fs.existsSync(path.join(m.hookDir, 'cursor_hook.mjs')));
    // the adapter from this checkout, not a copy bundled earlier and left behind
    assert.ok(fs.readFileSync(path.join(m.hookDir, 'cursor_hook.mjs')).equals(fs.readFileSync(path.join(CLI_DIR, '..', 'clients', 'cursor', 'after_file_edit.mjs'))));
    // and the generic hook any other agent runs, with every dialect it answers in
    assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')));
    assert.deepEqual(
      fs.readdirSync(path.join(m.hookDir, 'dialects')).sort(),
      fs.readdirSync(path.join(CLI_DIR, '..', 'hooks', 'dialects')).filter((f) => f.endsWith('.mjs')).sort()
    );
    const cursorMcp = json(path.join(m.home, '.cursor', 'mcp.json'));
    assert.deepEqual(cursorMcp.mcpServers.sentry, THEIRS.cursorMcp.mcpServers.sentry);
    assert.deepEqual(cursorMcp.mcpServers.agentmash, { command: 'node', args: [path.join(m.hookDir, 'mcp_server.mjs')] });

    // Copilot: one file of its own, PascalCase, and its MCP server for the CLI and for VS Code
    const copilot = json(path.join(m.home, '.copilot', 'hooks', 'agentmash.json'));
    assert.deepEqual(Object.keys(copilot.hooks), ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'Stop']);
    assert.equal(copilot.version, undefined, 'the format VS Code reads has no version');
    assert.match(copilot.hooks.PreToolUse[0].command, /pre_tool_use\.mjs" --global --client copilot$/);
    assert.equal(json(path.join(m.home, '.copilot', 'mcp-config.json')).mcpServers.agentmash.type, 'local');
    assert.ok(m.calls().some((c) => c.startsWith('code ["--add-mcp"')));
    assert.ok(json(vscodeMcp(m.home)).servers.agentmash);

    // and not a byte in a repository: login is run from none, and writes to none
    assert.equal(json(path.join(m.home, '.claude', 'settings.json')).model, 'opus');
  } finally {
    await server.close();
  }
});

test('login again is already connected everywhere, and leaves Codex\'s hooks byte for byte as the person approved them', async () => {
  const server = await startServer();
  const m = machine();
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const hooks = path.join(m.home, '.codex', 'hooks.json');
    const before = md5(hooks);
    const calls = m.calls().length;
    const again = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Codex\s+already connected/);
    assert.match(again.stdout, /Cursor\s+already connected/);
    assert.match(again.stdout, /GitHub Copilot\s+already connected/);
    assert.equal(md5(hooks), before, 'an approval in /hooks is keyed to these bytes');

    // and to where our groups are: a group the person adds after ours leaves ours where they were
    const edited = json(hooks);
    edited.hooks.PreToolUse.push({ matcher: '^Write$', hooks: [{ type: 'command', command: 'echo added-later' }] });
    fs.writeFileSync(hooks, JSON.stringify(edited, null, 2));
    const afterEdit = md5(hooks);
    const third = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.match(third.stdout, /Codex\s+already connected/);
    assert.equal(md5(hooks), afterEdit, 'ours stay at index 1, theirs at 0 and 2');
    assert.equal(m.calls().length, calls, 'nothing run a second time');
  } finally {
    await server.close();
  }
});

test('logout takes out everything login wrote, for every agent, and nothing of the person\'s', async () => {
  const server = await startServer();
  const m = machine();
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(json(path.join(m.home, '.codex', 'hooks.json')), THEIRS.codexHooks);
    assert.equal(fs.readFileSync(path.join(m.home, '.codex', 'config.toml'), 'utf8'), THEIRS.codexConfig);
    assert.deepEqual(json(path.join(m.home, '.cursor', 'hooks.json')), THEIRS.cursorHooks);
    assert.deepEqual(json(path.join(m.home, '.cursor', 'mcp.json')), THEIRS.cursorMcp);
    assert.ok(!fs.existsSync(path.join(m.home, '.copilot', 'hooks')), 'our file, and the folder made for it');
    assert.ok(!fs.existsSync(path.join(m.home, '.copilot', 'mcp-config.json')));
    assert.ok(!fs.existsSync(vscodeMcp(m.home)), "VS Code's mcp.json held only ours");
    assert.ok(!fs.existsSync(m.hookDir));
    assert.equal(json(path.join(m.home, '.claude', 'settings.json')).model, 'opus');
  } finally {
    await server.close();
  }
});

test("Codex's MCP server goes onto config.toml as one block of ours and comes off byte for byte, codex command or not", async () => {
  const server = await startServer();
  const m = machine({ with: [] });
  const config = path.join(m.home, '.codex', 'config.toml');
  const before = md5(config);
  try {
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.match(login.stdout, /Codex\s+connected/, 'found by its folder');
    const text = fs.readFileSync(config, 'utf8');
    assert.ok(text.startsWith(THEIRS.codexConfig), 'their config, untouched, then ours');
    assert.match(text, /\n# agentmash: added by `npx agentmash login`[^\n]*\n\[mcp_servers\.agentmash\]\ncommand = "node"\nargs = \[".*mcp_server\.mjs"\]\nenv_vars = \["AGENTMASH_LOBBY_SESSION", "AGENTMASH_WARN_SELF"\]\n$/);
    assert.match(login.stdout, /VS Code: no `code` command to add the MCP server with/);
    await run(['logout'], m.env);
    assert.equal(md5(config), before);

    // a block Codex has reformatted (codex mcp add's own) comes out by its lines, theirs untouched
    // (the path a TOML string, as Codex writes it: a Windows path's backslashes escaped)
    fs.appendFileSync(config, `\n[mcp_servers.agentmash]\ncommand = "node"\nargs = [${JSON.stringify(path.join(m.hookDir, 'mcp_server.mjs'))}]\n`);
    await run(['tools', 'add', 'codex'], m.env);
    await run(['tools', 'remove', 'codex'], m.env);
    assert.equal(fs.readFileSync(config, 'utf8').trimEnd(), THEIRS.codexConfig.trimEnd());
  } finally {
    await server.close();
  }
});

test('tools lists every agent, and adds or removes one at a time, signed in or not', async () => {
  const m = machine({ with: ['codex', 'copilot'], cursor: false });
  const list = await run(['tools'], m.env);
  assert.equal(list.code, 0, list.stderr);
  for (const line of [/claude\s+Claude Code/, /codex\s+Codex\s+found · codex-cli 0\.160\.0\s+not connected/, /cursor\s+Cursor\s+not found/, /copilot\s+GitHub Copilot\s+found · GitHub Copilot CLI 1\.0\.91\.\s+not connected/, /devin\s+Devin/]) {
    assert.match(list.stdout, line);
  }
  assert.match(list.stdout, /not signed in/);

  const add = await run(['tools', 'add', 'codex'], m.env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /Codex\s+connected/);
  assert.match(add.stdout, /open codex, type \/hooks/);
  assert.match(add.stdout, /only in repositories that carry a room of their own/, 'not signed in, and says what that costs');
  assert.ok(!fs.existsSync(path.join(m.home, '.copilot', 'hooks')), 'one at a time');
  assert.match((await run(['tools'], m.env)).stdout, /codex\s+Codex\s+found · codex-cli 0\.160\.0\s+connected · hooks not approved yet/);

  const remove = await run(['tools', 'remove', 'codex'], m.env);
  assert.equal(remove.code, 0, remove.stderr);
  assert.deepEqual(json(path.join(m.home, '.codex', 'hooks.json')), THEIRS.codexHooks);
  assert.match((await run(['tools'], m.env)).stdout, /codex\s+Codex\s+found · codex-cli 0\.160\.0\s+not connected/);

  const unknown = await run(['tools', 'add', 'vim'], m.env);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /claude, codex, cursor, copilot, devin/);
});

test('doctor on a signed-in machine checks each agent login connected, and whether Codex\'s hooks are approved', async () => {
  const server = await startServer();
  const m = machine();
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const first = await run(['doctor'], m.env, m.home);
    assert.match(first.stdout, shownHere(/Codex: hooks in ~\/\.codex\/hooks\.json \(6 events\), not approved yet — open codex, type \/hooks, and approve agentmash/));
    assert.match(first.stdout, shownHere(/Cursor: hooks in ~\/\.cursor\/hooks\.json \(4 events\) · MCP server registered/));
    assert.match(first.stdout, shownHere(/GitHub Copilot: hooks in ~\/\.copilot\/hooks\/agentmash\.json/));

    // what Codex writes in config.toml once each of ours is approved in /hooks
    const hooks = json(path.join(m.home, '.codex', 'hooks.json')).hooks;
    let approvals = '';
    for (const [event, groups] of Object.entries(hooks)) {
      const label = event.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase());
      groups.forEach((group, g) => {
        if (!runsOurs(group)) return;
        group.hooks.forEach((_, h) => {
          // the key a TOML string, as Codex writes it: a Windows path's backslashes escaped
          approvals += `\n[hooks.state.${JSON.stringify(`${path.join(m.home, '.codex', 'hooks.json')}:${label}:${g}:${h}`)}]\ntrusted_hash = "sha256:${'a'.repeat(64)}"\n`;
        });
      });
    }
    fs.appendFileSync(path.join(m.home, '.codex', 'config.toml'), approvals);
    const approved = await run(['doctor'], m.env, m.home);
    assert.match(approved.stdout, shownHere(/Codex: hooks in ~\/\.codex\/hooks\.json \(6 events\), approved in \/hooks · MCP server registered/));

    fs.rmSync(path.join(m.hookDir, 'cursor_hook.mjs'));
    const broken = await run(['doctor'], m.env, m.home);
    assert.match(broken.stdout, /✗ Cursor: runs .*cursor_hook\.mjs, which does not exist — every call fails — run: npx agentmash login/);
    assert.equal(broken.code, 1);
  } finally {
    await server.close();
  }
});

test('login --skip leaves an agent as it is, and --tools connects only those named, found or not', async () => {
  const server = await startServer();
  try {
    const m = machine();
    const cursorBefore = md5(path.join(m.home, '.cursor', 'hooks.json'));
    const skipped = await run(['login', '--server', server.url, '--no-open', '--skip', 'cursor'], m.env);
    assert.equal(skipped.code, 0, skipped.stderr);
    assert.match(skipped.stdout, /Cursor\s+skipped — left out with --skip/);
    assert.match(skipped.stdout, /Codex\s+connected/);
    assert.equal(md5(path.join(m.home, '.cursor', 'hooks.json')), cursorBefore);

    const only = machine({ with: [], codex: false, cursor: false, copilot: false });
    const named = await run(['login', '--server', server.url, '--no-open', '--tools', 'claude,codex'], only.env);
    assert.equal(named.code, 0, named.stderr);
    assert.match(named.stdout, /Codex\s+connected/, 'named, so connected though nothing of it was found');
    assert.doesNotMatch(named.stdout, /Cursor|GitHub Copilot/);
    assert.ok(fs.existsSync(path.join(only.home, '.codex', 'hooks.json')));

    const wrong = await run(['login', '--server', server.url, '--no-open', '--skip', 'vim'], m.env);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /--skip vim: the agents are claude, codex, cursor, copilot, devin/);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// config.toml, hooks.json and mcp.json are the person's files: what follows
// pins that login and logout leave them readable, theirs, and where they were.
// ---------------------------------------------------------------------------

const codexConfig = (m) => path.join(m.home, '.codex', 'config.toml');
const readToml = (file) => parseToml(fs.readFileSync(file, 'utf8')).value;

test("logout cuts our table out of config.toml with whatever was put under it, and the table above it gets none of it", async () => {
  const server = await startServer();
  try {
    const m = machine({ with: [] });
    const theirs = `${THEIRS.codexConfig}\n[mcp_servers.github]\ncommand = "gh"\nenabled = true\n`;
    fs.writeFileSync(codexConfig(m), theirs);
    await run(['login', '--server', server.url, '--no-open'], m.env);
    // what a person, or Codex, may put under ours: a key, and a table of tool approvals
    fs.appendFileSync(codexConfig(m), 'enabled = false\n\n[mcp_servers.agentmash.tools.who_is_working_on_what]\napproval_mode = "approve"\n');
    assert.equal(readToml(codexConfig(m)).mcp_servers.agentmash.enabled, false, 'still a file Codex reads');

    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    const left = readToml(codexConfig(m));
    assert.deepEqual(left.mcp_servers, { github: { command: 'gh', enabled: true } }, 'github kept its own enabled, and gained nothing');
    assert.equal(fs.readFileSync(codexConfig(m), 'utf8').trimEnd(), theirs.trimEnd());
  } finally {
    await server.close();
  }
});

test("logout also cuts a table of tool approvals Codex put straight under ours, with nothing else between", async () => {
  const server = await startServer();
  try {
    const m = machine({ with: [] });
    fs.writeFileSync(codexConfig(m), THEIRS.codexConfig);
    await run(['login', '--server', server.url, '--no-open'], m.env);
    // ours ends cleanly at a table header, but the header is a table of ours
    fs.appendFileSync(codexConfig(m), '\n[mcp_servers.agentmash.tools.get_collisions]\napproval_mode = "approve"\n');
    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    const text = fs.readFileSync(codexConfig(m), 'utf8');
    assert.ok(!text.includes('mcp_servers.agentmash'), `nothing of ours is left:\n${text}`);
    assert.equal(text.trimEnd(), THEIRS.codexConfig.trimEnd());
  } finally {
    await server.close();
  }
});

// Codex starts an MCP server with its environment cleared, then only PATH,
// HOME and the like, and the names the server's env_vars gives: the desktop
// app's session and AGENTMASH_WARN_SELF reach ours only by being named.
const SERVER_ENV = ['AGENTMASH_LOBBY_SESSION', 'AGENTMASH_WARN_SELF'];

test("Codex's MCP server block names the desktop app's session and AGENTMASH_WARN_SELF for Codex to pass on", () => {
  const ours = parseToml(codexServerBlock(path.join(os.tmpdir(), 'hooks'))).value.mcp_servers.agentmash;
  assert.deepEqual(ours.env_vars, SERVER_ENV);
  assert.deepEqual(Object.keys(ours), ['command', 'args', 'env_vars']);
});

test("a block an older login wrote gains env_vars where it is, the tool approvals under it kept, and logout still takes all of it", async () => {
  const server = await startServer();
  try {
    const m = machine({ with: [] });
    // as login wrote it before env_vars, with a key added under it and a table of tool approvals Codex keeps there
    const older =
      '\n# agentmash: added by `npx agentmash login`; `npx agentmash logout` takes it out\n' +
      `[mcp_servers.agentmash]\ncommand = "node"\nargs = [${JSON.stringify(path.join(m.hookDir, 'mcp_server.mjs'))}]\n`;
    const under = 'enabled = true\n\n[mcp_servers.agentmash.tools.get_collisions]\napproval_mode = "approve"\n';
    fs.writeFileSync(codexConfig(m), THEIRS.codexConfig + older + under);

    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(login.code, 0, login.stderr);
    assert.doesNotMatch(login.stdout, /the MCP server was not added/);
    const upgraded = fs.readFileSync(codexConfig(m), 'utf8');
    assert.equal(upgraded, `${THEIRS.codexConfig}${older}env_vars = ["AGENTMASH_LOBBY_SESSION", "AGENTMASH_WARN_SELF"]\n${under}`, 'one line added, nothing moved');
    const ours = readToml(codexConfig(m)).mcp_servers.agentmash;
    assert.deepEqual(ours.env_vars, SERVER_ENV);
    assert.equal(ours.enabled, true);
    assert.deepEqual(ours.tools, { get_collisions: { approval_mode: 'approve' } }, 'the approvals stay');

    // as it should be now: a second login leaves it be
    await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(fs.readFileSync(codexConfig(m), 'utf8'), upgraded);

    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(fs.readFileSync(codexConfig(m), 'utf8').trimEnd(), THEIRS.codexConfig.trimEnd());
  } finally {
    await server.close();
  }
});

test("login adds no MCP server to a config.toml it cannot add one to cleanly, says so, and leaves the file as it was", async () => {
  const server = await startServer();
  try {
    const shapes = [
      ['an agentmash of their own, inline', `${THEIRS.codexConfig}\n[mcp_servers]\nagentmash = { command = "npx", args = ["other-agentmash"] }\n`, /already/],
      ['agentmash by dotted keys', `mcp_servers.agentmash.command = "npx"\n${THEIRS.codexConfig}`, /already/],
      ['mcp_servers written inline', `mcp_servers = { github = { command = "gh" } }\n${THEIRS.codexConfig}`, /inline/],
      ['a file that is not TOML', `${THEIRS.codexConfig}\nthis is = not = toml\n`, /could not be read as TOML/],
    ];
    for (const [shape, text, why] of shapes) {
      const m = machine({ with: [] });
      fs.writeFileSync(codexConfig(m), text);
      const login = await run(['login', '--server', server.url, '--no-open'], m.env);
      assert.equal(login.code, 0, login.stderr);
      assert.match(login.stdout, /Codex\s+connected/, shape);
      assert.match(login.stdout, /the MCP server was not added/, shape);
      assert.match(login.stdout, why, shape);
      assert.equal(fs.readFileSync(codexConfig(m), 'utf8'), text, `${shape}: not a byte changed`);
      await run(['logout'], m.env);
      assert.equal(fs.readFileSync(codexConfig(m), 'utf8'), text, `${shape}: nor by logout`);
    }
  } finally {
    await server.close();
  }
});

test('a file login writes keeps its mode, a symlinked one stays a symlink, and nothing half-written is left about', { skip: process.platform === 'win32' && 'POSIX modes and symlinks' }, async () => {
  const server = await startServer();
  try {
    const m = machine({ with: [] });
    fs.chmodSync(path.join(m.home, '.cursor', 'mcp.json'), 0o600);
    fs.chmodSync(codexConfig(m), 0o600);
    // ~/.cursor/hooks.json as stow or chezmoi leave it: a link into the person's dotfiles
    const dotfiles = path.join(m.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    fs.renameSync(path.join(m.home, '.cursor', 'hooks.json'), path.join(dotfiles, 'cursor-hooks.json'));
    fs.symlinkSync(path.join(dotfiles, 'cursor-hooks.json'), path.join(m.home, '.cursor', 'hooks.json'));

    await run(['login', '--server', server.url, '--no-open'], m.env);
    const mode = (file) => fs.statSync(file).mode & 0o777;
    assert.equal(mode(path.join(m.home, '.cursor', 'mcp.json')), 0o600, 'a file that may hold tokens stays private');
    assert.equal(mode(codexConfig(m)), 0o600);
    assert.equal(mode(path.join(m.home, '.copilot', 'mcp-config.json')), 0o600, 'a new MCP config is private from the start');
    assert.ok(fs.lstatSync(path.join(m.home, '.cursor', 'hooks.json')).isSymbolicLink(), 'still the link');
    assert.ok(json(path.join(dotfiles, 'cursor-hooks.json')).hooks.preToolUse, 'and ours went into what it points at');
    for (const dir of [path.join(m.home, '.cursor'), path.join(m.home, '.codex'), dotfiles, m.hookDir]) {
      assert.deepEqual(fs.readdirSync(dir).filter((f) => /tmp/.test(f)), [], `no temporary file left in ${dir}`);
    }

    await run(['logout'], m.env);
    assert.ok(fs.lstatSync(path.join(m.home, '.cursor', 'hooks.json')).isSymbolicLink());
    assert.deepEqual(json(path.join(dotfiles, 'cursor-hooks.json')), THEIRS.cursorHooks);
  } finally {
    await server.close();
  }
});

test('logout that cannot take ours out of a file says which, and keeps the scripts that file still runs', async () => {
  const server = await startServer();
  try {
    const m = machine();
    await run(['login', '--server', server.url, '--no-open'], m.env);
    // broken by hand since: Codex's hooks.json, and VS Code's mcp.json with a comment in it (JSONC)
    const codexHooks = path.join(m.home, '.codex', 'hooks.json');
    fs.writeFileSync(codexHooks, fs.readFileSync(codexHooks, 'utf8').replace(/\}\s*$/, ',}'));
    fs.writeFileSync(vscodeMcp(m.home), `// mine\n${fs.readFileSync(vscodeMcp(m.home), 'utf8')}`);

    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/~\/\.codex\/hooks\.json is not valid JSON: agentmash is still in it/));
    assert.match(out.stdout, /mcp\.json is not valid JSON: agentmash is still in it/);
    assert.match(out.stdout, shownHere(/kept .*\.agentmash\/hooks/));
    assert.doesNotMatch(out.stdout, /took agentmash out of every agent/);
    assert.ok(fs.existsSync(path.join(m.hookDir, 'pre_tool_use.mjs')), 'what Codex still runs is still there');
    assert.ok(!fs.existsSync(path.join(m.home, '.agentmash', 'user.json')), 'signed out all the same');
  } finally {
    await server.close();
  }
});

test('logout counts a file as still running the scripts however it spells their folder: as it is, escaped as JSON or TOML writes it, or with forward slashes', () => {
  const dir = 'C:\\Users\\me\\.agentmash\\hooks';
  const command = `node "${dir}\\agent_hook.mjs" pre_edit`;
  assert.ok(namesFolder(command, dir), 'as it is: a YAML plain scalar, a TOML literal string');
  assert.ok(namesFolder(JSON.stringify({ hooks: { BeforeTool: [{ command }] } }, null, 2), dir), 'in a JSON file');
  assert.ok(namesFolder(`const HOOKS_DIR = ${JSON.stringify(dir)};`, dir), 'in a plugin of ours');
  assert.ok(namesFolder('args = ["C:/Users/me/.agentmash/hooks/mcp_server.mjs"]', dir), 'with forward slashes');
  assert.ok(!namesFolder(JSON.stringify({ command: 'node C:\\Users\\me\\bin\\guard.mjs' }), dir), 'another folder');
  const posix = '/home/me/.agentmash/hooks';
  assert.ok(namesFolder(JSON.stringify({ command: `node "${posix}/agent_hook.mjs"` }), posix));
  assert.ok(!namesFolder('{ "theirs": true }', posix));
});

/** Every regular file under `dir`, relative to it. */
function filesUnder(dir, rel = '') {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const at = path.join(rel, e.name);
    return e.isDirectory() ? filesUnder(dir, at) : e.isFile() ? [at] : [];
  });
}

/** Something of the person's, in the format a file of that name is in. */
const theirsFor = (file) =>
  /\.jsonc?$/.test(file) ? '{ "theirs": { "keep": true } }\n' : /\.toml$/.test(file) ? 'theirs = true\n' : /\.ya?ml$/.test(file) ? 'theirs: true\n' : 'theirs\n';

test(
  'a file of the person\'s login cannot read is never taken for one that is not there, and written over, by any agent',
  { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'a mode that keeps the file\'s owner out of it' },
  async () => {
    const ids = Object.keys(AGENTS).filter((id) => id !== 'devin');
    const written = [];
    const clobbered = [];
    await Promise.all(
      ids.map(async (id) => {
        // what a first `tools add` writes for this agent, in a home of its own: every file of the person's it touches
        const first = machine({ with: [], codex: false, cursor: false, copilot: false });
        const before = new Set(filesUnder(first.home));
        assert.equal((await run(['tools', 'add', id], first.env)).code, 0);
        // a file of ours (named agentmash, or in a folder that is) is ours to write over
        const theirs = filesUnder(first.home).filter((rel) => !before.has(rel) && !rel.split(path.sep).some((part) => /agentmash/.test(part)));
        written.push(...theirs);

        // the same files, of the person's and unreadable (a sudo run left them root's, or chmod 000)
        const m = machine({ with: [], codex: false, cursor: false, copilot: false });
        for (const rel of theirs) {
          const file = path.join(m.home, rel);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, theirsFor(file));
          fs.chmodSync(file, 0o000);
        }
        const added = await run(['tools', 'add', id], m.env);
        const removed = await run(['tools', 'remove', id], m.env);
        for (const rel of theirs) fs.chmodSync(path.join(m.home, rel), 0o600);
        assert.equal(added.code, 0, `${id}: ${added.stderr}`);
        assert.equal(removed.code, 0, `${id}: ${removed.stderr}`);
        for (const rel of theirs) if (fs.readFileSync(path.join(m.home, rel), 'utf8') !== theirsFor(rel)) clobbered.push(`${id}: ~/${rel}`);
      })
    );
    assert.deepEqual(clobbered, []);
    assert.ok(written.length >= 20, `the files of the person's login writes to, ${written.length} of them`);
  }
);

test("doctor says when the machine's scripts are older than this CLI, and that login brings them up to date", async () => {
  const server = await startServer();
  try {
    const m = machine({ with: [] });
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const serverScript = path.join(m.hookDir, 'mcp_server.mjs');
    fs.writeFileSync(serverScript, fs.readFileSync(serverScript, 'utf8').replace(/^export const VERSION = '[^']*';/m, "export const VERSION = '0.5.0';"));
    const doctor = await run(['doctor'], m.env, m.home);
    assert.match(doctor.stdout.replace(/\s+/g, ' '), shownHere(/the scripts in ~\/\.agentmash\/hooks are from 0\.5\.0, older than this CLI .* run: npx agentmash login/));
    assert.match(doctor.stdout.replace(/\s+/g, ' '), /says reconciliation is switched off/);
  } finally {
    await server.close();
  }
});

// On Windows an agent's command is often a .cmd shim, VS Code's `code` and
// every npm-installed CLI among them, which Node runs only through a shell.
// Handed to a shell as a list, the arguments were joined with spaces, unquoted
// (Node 24 says so: DEP0190, on every login), and the JSON `code --add-mcp`
// takes came apart in cmd.exe.
test('a .cmd command gets each argument as it was given, and Node warns of nothing', { skip: process.platform !== 'win32' && '.cmd shims are Windows only' }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cmd shim-'));
  fs.writeFileSync(path.join(bin, 'said.mjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  // as npm and VS Code write theirs: the program, then everything typed, with %*
  fs.writeFileSync(path.join(bin, 'code.cmd'), `@"${process.execPath}" "%~dp0said.mjs" %*\r\n`);
  const given = [
    '--add-mcp',
    JSON.stringify({ name: 'agentmash', command: 'node', args: ['C:\\Users\\R&D\\.agentmash\\hooks\\mcp_server.mjs'] }),
    'two words',
    '100% "quoted" ^caret <less> |pipe!',
    'ends with a backslash\\',
    '',
  ];
  const script =
    `import { runTool } from ${JSON.stringify(pathToFileURL(path.join(CLI_DIR, 'agent-kit.mjs')).href)};\n` +
    `const res = runTool(${JSON.stringify(path.join(bin, 'code.cmd'))}, ${JSON.stringify(given)}, { toolPath: '' });\n` +
    `process.stdout.write(JSON.stringify(res));\n`;
  const { stdout, stderr } = await new Promise((resolve, reject) =>
    execFile(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }, (err, out, errOut) =>
      err ? reject(err) : resolve({ stdout: out, stderr: errOut })
    )
  );
  const res = JSON.parse(stdout);
  assert.ok(res.ok, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), given);
  assert.doesNotMatch(stderr, /DEP0190|DeprecationWarning/);
});

// ---------------------------------------------------------------------------
// Each agent is a module of its own in agents/: what follows pins that the
// registry is read from the folder, that the four first agents register what
// they always did, and that a fifth needs nothing but its own file.
// ---------------------------------------------------------------------------

/** Every agent connected since the first four, by id: those with hooks (order 50) by id, then the MCP-only ones (60). */
const ADDED = ['amp', 'antigravity', 'cline', 'crush', 'droid', 'gemini', 'goose', 'junie', 'kilo', 'kiro', 'opencode', 'openhands', 'qwen', 'continue', 'zed'];

test('the agents are the modules in agents/, each whole, in their order', () => {
  assert.deepEqual(Object.keys(AGENTS), ['codex', 'cursor', 'copilot', 'devin', ...ADDED]);
  const modules = fs.readdirSync(path.join(CLI_DIR, 'agents')).filter((f) => f.endsWith('.mjs') && f !== 'index.mjs' && !f.startsWith('_'));
  assert.deepEqual(Object.keys(AGENTS).sort(), modules.map((f) => f.replace(/\.mjs$/, '')).sort(), 'one module each, and every module one');
  for (const [id, agent] of Object.entries(AGENTS)) {
    assert.equal(agent.id, id);
    assert.ok(Array.isArray(agent.env), id);
    for (const fn of ['files', 'hooks', 'detect', 'connect', 'disconnect', 'inspect']) assert.equal(typeof agent[fn], 'function', `${id}.${fn}`);
    assert.deepEqual(agent.hooks('/h/.agentmash/hooks'), agent.hooks('/h/.agentmash/hooks'), `${id}: the same hooks every time`);
  }
  const orders = Object.values(AGENTS).map((agent) => agent.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  assert.equal(AGENTS.devin.readsClaude, true);
  assert.equal(AGENTS.codex.approvalHint.long, 'open codex, type /hooks, and approve agentmash');

  // what logout checks before it takes the scripts away: every file an agent's connect writes, the first four's in the
  // order they always were. The agents read their folders from the environment, which is this developer's: cleared here,
  // and nothing on the tool path (Cline names its hook files only where it is found).
  const saved = Object.fromEntries(Object.values(AGENTS).flatMap((agent) => agent.env).map((name) => [name, process.env[name]]));
  for (const name of Object.keys(saved)) delete process.env[name];
  try {
    const home = path.join(path.sep, 'h');
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-tools-nothing-'));
    const places = { ...agentPlaces(), home, toolPath: empty, apps: null, codex: path.join(home, '.codex'), cursor: path.join(home, '.cursor'), copilot: path.join(home, '.copilot'), vscodeUser: path.join(home, 'Code', 'User') };
    const config = path.join(home, '.config');
    assert.deepEqual(agentFiles(places), [
      path.join(home, '.codex', 'hooks.json'),
      path.join(home, '.codex', 'config.toml'),
      path.join(home, '.cursor', 'hooks.json'),
      path.join(home, '.cursor', 'mcp.json'),
      path.join(home, '.copilot', 'hooks', 'agentmash.json'),
      path.join(home, '.copilot', 'mcp-config.json'),
      path.join(home, 'Code', 'User', 'mcp.json'),
      path.join(config, 'amp', 'plugins', 'agentmash.ts'),
      path.join(config, 'amp', 'settings.json'),
      path.join(home, '.gemini', 'config', 'hooks.json'),
      path.join(home, '.gemini', 'config', 'mcp_config.json'),
      path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
      path.join(config, 'crush', 'crush.json'),
      path.join(home, '.factory', 'hooks.json'),
      path.join(home, '.factory', 'mcp.json'),
      path.join(home, '.gemini', 'settings.json'),
      path.join(home, '.agents', 'plugins', 'agentmash', 'hooks', 'hooks.json'),
      path.join(home, '.agents', 'plugins', 'agentmash', '.mcp.json'),
      path.join(home, '.junie', 'config.json'),
      path.join(home, '.junie', 'mcp', 'mcp.json'),
      ...['agentmash.js', 'kilo.jsonc', 'kilo.json', 'opencode.jsonc', 'opencode.json', 'config.json'].map((f) => path.join(config, 'kilo', f)),
      path.join(home, '.kiro', 'hooks', 'agentmash.json'),
      path.join(home, '.kiro', 'settings', 'mcp.json'),
      path.join(config, 'opencode', 'plugin', 'agentmash.js'),
      ...['opencode.jsonc', 'opencode.json', 'config.json'].map((f) => path.join(config, 'opencode', f)),
      path.join(home, '.openhands', 'hooks.json'),
      path.join(home, '.openhands', 'mcp.json'),
      ...[['hooks', 'hooks.json'], ['.mcp.json'], ['.plugin', 'plugin.json']].map((f) => path.join(home, '.openhands', 'plugins', 'agentmash-openhands', ...f)),
      path.join(home, '.qwen', 'settings.json'),
      path.join(home, '.continue', 'config.yaml'),
      // Zed's settings folder is one per operating system
      ...Object.values(AGENTS.zed.files(places)),
    ]);
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value;
  }
});

test("what login registers is byte for byte what it always was: Codex keys a person's approval to it", { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  const dir = '/home/someone/.agentmash/hooks';
  const md5Of = (value) => crypto.createHash('md5').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
  // taken from these functions as they were in cli/tools.mjs before each agent had a module of its own
  assert.equal(md5Of(codexHooks(dir)), 'a25f3a70c29741920e848b484b86d1ec');
  assert.equal(md5Of(cursorHooks(dir)), 'd23382e41f5160007635b3c5785166fe');
  assert.equal(md5Of(copilotHooks(dir)), '9f1c5354fd6262dbd7ff1a4b7082846e');
  // the server's block changed once, on purpose: env_vars, which a block from before gains in place (see below)
  assert.equal(md5Of(codexServerBlock(dir)), '7dedb7878c9c9ab02442485a174b92b1');
  assert.equal(codexHooks(dir).PreToolUse[0].hooks[0].command, 'node "/home/someone/.agentmash/hooks/pre_tool_use.mjs" --global --client codex');
  for (const id of ['codex', 'cursor', 'copilot']) assert.equal(md5Of(AGENTS[id].hooks(dir)), md5Of({ codex: codexHooks, cursor: cursorHooks, copilot: copilotHooks }[id](dir)), id);
});

/** A copy of the CLI's own files in a folder of their own, with `agents` written into its agents/. */
function cliCopy(agents) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-copy-')));
  for (const file of ['agentmash.mjs', 'tools.mjs', 'agent-kit.mjs', 'toml.mjs', 'visibility.mjs', 'package.json']) fs.copyFileSync(path.join(CLI_DIR, file), path.join(dir, file));
  fs.mkdirSync(path.join(dir, 'agents'));
  for (const file of fs.readdirSync(path.join(CLI_DIR, 'agents'))) fs.copyFileSync(path.join(CLI_DIR, 'agents', file), path.join(dir, 'agents', file));
  for (const [file, text] of Object.entries(agents)) fs.writeFileSync(path.join(dir, 'agents', file), text);
  return dir;
}

const ACME = `
import path from 'node:path';
import { agentHookCommand, exists, which } from '../agent-kit.mjs';
const dir = (places) => process.env.ACME_HOME || path.join(places.home, '.acme');
export default {
  id: 'acme',
  name: 'Acme Code',
  order: 50,
  env: ['ACME_HOME'],
  files: (places) => ({ settings: path.join(dir(places), 'settings.json') }),
  hooks: (hookDir) => ({ BeforeEdit: [{ command: agentHookCommand(hookDir, 'pre_edit', 'acme', { dialect: 'deny-once' }) }] }),
  detect: (places) => ({ found: exists(dir(places)), bin: which('acme', places.toolPath) }),
  connect: () => ({ status: 'already', notes: [] }),
  disconnect: () => ({ status: 'absent', invalid: [] }),
  inspect: () => ({ connected: false, events: [], missing: [] }),
};
`;

test('a new agent is a module in agents/ and nothing more: listed in its order, its files kept by logout, its hook the generic one', async () => {
  const dir = cliCopy({ 'acme.mjs': ACME });
  const tools = await import(pathToFileURL(path.join(dir, 'tools.mjs')).href);
  // acme is order 50, as every agent with hooks added since the first four is: they come by id
  assert.deepEqual(Object.keys(tools.AGENTS), ['codex', 'cursor', 'copilot', 'devin', 'acme', ...ADDED]);
  const home = path.join(path.sep, 'h');
  assert.ok(tools.agentFiles({ ...agentPlaces(), home }).includes(path.join(home, '.acme', 'settings.json')));
  assert.equal(
    tools.AGENTS.acme.hooks(path.join(home, '.agentmash', 'hooks')).BeforeEdit[0].command,
    `node "${path.join(home, '.agentmash', 'hooks', 'agent_hook.mjs')}" pre_edit --global --client acme --dialect deny-once`
  );

  // and the CLI, run from that copy, knows it by its id
  const m = machine({ with: [] });
  fs.mkdirSync(path.join(m.home, '.acme'));
  const listed = await new Promise((resolve, reject) =>
    execFile(process.execPath, [path.join(dir, 'agentmash.mjs'), 'tools'], { env: { ...baseEnv, ...m.env } }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout)
    )
  );
  assert.match(listed, /acme\s+Acme Code\s+found\s+not connected/);
  const unknown = await run(['tools', 'add', 'vim'], m.env);
  assert.match(unknown.stderr, /claude, codex, cursor, copilot, devin/, 'this checkout has no acme');
});

test('a module in agents/ that is not an agent is said by its file, never skipped quietly', async () => {
  const dir = cliCopy({ 'broken.mjs': "export default { id: 'other', name: 'Other', order: 60, files() {}, hooks() {}, detect() {}, connect() {}, disconnect() {}, inspect() {} };\n" });
  await assert.rejects(import(pathToFileURL(path.join(dir, 'tools.mjs')).href), /cli\/agents\/broken\.mjs id other is not its file's name/);
  const half = cliCopy({ 'half.mjs': "export default { id: 'half', name: 'Half', order: 60, files() {} };\n" });
  await assert.rejects(import(pathToFileURL(path.join(half, 'tools.mjs')).href), /cli\/agents\/half\.mjs has no hooks, detect, connect, disconnect, inspect/);
});
