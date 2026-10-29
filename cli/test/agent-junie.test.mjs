// Junie: `npx agentmash login` puts the generic hook, in Junie's dialect, in
// the `hooks` of ~/.junie/config.json, after whatever is the person's, and
// our MCP server in ~/.junie/mcp/mcp.json; `npx agentmash logout` takes out
// exactly that, and gives the person their files back byte for byte, laid
// out as they had them. Every test runs in a home of its own
// (fixtures/machine.mjs), with JUNIE_HOME and JUNIE_DATA cleared unless a
// test sets them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import junie, { junieHooks } from '../agents/junie.mjs';
import { json, machine, md5, run, runsOurs, shownHere, startServer } from './fixtures/machine.mjs';

/** Junie's config.json as a person leaves it: a setting, and a hook of their own, four spaces in. */
const THEIR_CONFIG = {
  model: 'claude-sonnet-4-5',
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/.junie/hooks/guard.sh', timeout: 5 }] }] },
};
const THEIR_MCP = { mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] } } };

/**
 * A stand-in for the `junie` command. What the real one prints for --version
 * is not pinned anywhere here; `tools` shows whatever its first line is.
 */
const JUNIE = `if (process.argv[2] === '--version') console.log('junie 26.9.22');`;

/**
 * A home with Junie's CLI on it (its command on the tool path, its builds
 * folder, or neither) and no other agent, and Junie's files as `config` and
 * `mcp` say: text to write, or null for none.
 */
function junieMachine({ command = true, data = false, config = JSON.stringify(THEIR_CONFIG, null, 4) + '\n', mcp = JSON.stringify(THEIR_MCP, null, 2) + '\n' } = {}) {
  const m = machine({ with: command ? ['junie'] : [], codex: false, cursor: false, copilot: false, scripts: { junie: JUNIE } });
  const home = path.join(m.home, '.junie');
  const at = { home, config: path.join(home, 'config.json'), mcp: path.join(home, 'mcp', 'mcp.json'), data: path.join(m.home, '.local', 'share', 'junie') };
  fs.mkdirSync(path.join(home, 'mcp'), { recursive: true });
  if (config !== null) fs.writeFileSync(at.config, config);
  if (mcp !== null) {
    fs.writeFileSync(at.mcp, mcp);
    fs.chmodSync(at.mcp, 0o600);
  }
  if (data) fs.mkdirSync(path.join(at.data, 'versions'), { recursive: true });
  return { ...m, at };
}

const login = (m, server, extra = []) => run(['login', '--server', server.url, '--no-open', ...extra], m.env);
const mode = (file) => fs.statSync(file).mode & 0o777;
const tmpLeft = (dir) => fs.readdirSync(dir).filter((f) => /\.tmp$/.test(f));

test('login connects Junie at user level: the generic hook for four of its events after the person’s own, the MCP server, and nothing else touched', async () => {
  const server = await startServer();
  const m = junieMachine();
  try {
    const out = await login(m, server);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/Junie\s+connected\s+~\/\.junie\/config\.json/));
    assert.match(out.stdout, /start a new Junie session: Junie reads its hooks as a session starts/);
    assert.match(out.stdout, /Junie asks before each agentmash MCP tool call, unless you allow them .* login adds no such rule/);

    const config = json(m.at.config);
    assert.deepEqual(Object.keys(config), ['model', 'hooks'], 'their keys, where they were');
    assert.equal(config.model, THEIR_CONFIG.model);
    const want = junieHooks(m.hookDir);
    assert.deepEqual(Object.keys(config.hooks), ['PreToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop']);
    assert.deepEqual(config.hooks.PreToolUse, [THEIR_CONFIG.hooks.PreToolUse[0], want.PreToolUse[0]], 'theirs first, as it was');
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) assert.deepEqual(config.hooks[event], want[event], event);
    assert.equal(config.hooks.PreToolUse[1].matcher, 'Edit|Write');
    assert.equal(
      config.hooks.PreToolUse[1].hooks[0].command,
      `node "${path.join(m.hookDir, 'agent_hook.mjs')}" pre_edit --global --client junie --dialect junie`
    );
    // never the events where saying nothing approves an action, or that carry nothing to report
    for (const event of ['PermissionRequest', 'SessionEnd', 'PostToolUse', 'StopFailure']) assert.ok(!(event in config.hooks), event);
    for (const group of Object.values(config.hooks).flat().filter(runsOurs)) {
      assert.deepEqual(Object.keys(group).filter((k) => k !== 'matcher'), ['hooks']);
      for (const hook of group.hooks) {
        assert.deepEqual(Object.keys(hook), ['type', 'command', 'timeout'], 'only the fields Junie documents');
        assert.equal(hook.type, 'command');
        assert.ok(Number.isInteger(hook.timeout) && hook.timeout > 0, 'whole seconds, above zero, or Junie refuses the entry');
        assert.doesNotMatch(hook.command, /\d+\.\d+\.\d+|async|blockOnError/, hook.command);
        assert.ok(fs.existsSync(/"([^"]+)"/.exec(hook.command)[1]));
      }
    }
    assert.ok(fs.existsSync(path.join(m.hookDir, 'dialects', 'junie.mjs')), "Junie's dialect, beside the generic hook");
    // laid out as the person had it: four spaces in, a newline at the end
    const text = fs.readFileSync(m.at.config, 'utf8');
    assert.match(text, /^\{\n {4}"model": "claude-sonnet-4-5",\n {4}"hooks": \{\n {8}"PreToolUse": \[/);
    assert.ok(text.endsWith('}\n'));

    const mcp = json(m.at.mcp);
    assert.deepEqual(mcp.mcpServers.github, THEIR_MCP.mcpServers.github);
    assert.deepEqual(mcp.mcpServers.agentmash, { command: 'node', args: [path.join(m.hookDir, 'mcp_server.mjs')] });
    if (process.platform !== 'win32') assert.equal(mode(m.at.mcp), 0o600, 'a file that may hold tokens stays private');

    // nothing else of Junie's: no allowlist, no extension, no project config
    // (and what each file held before agentmash, kept beside it)
    assert.deepEqual(fs.readdirSync(m.at.home).sort(), ['config.json', 'config.json.before-agentmash', 'mcp']);
    assert.deepEqual(fs.readdirSync(path.join(m.at.home, 'mcp')).sort(), ['mcp.json', 'mcp.json.before-agentmash']);
  } finally {
    await server.close();
  }
});

test('login again is already connected and leaves both files byte for byte, wherever the person put a group of their own', async () => {
  const server = await startServer();
  const m = junieMachine();
  try {
    await login(m, server);
    const before = [md5(m.at.config), md5(m.at.mcp)];
    const again = await login(m, server);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Junie\s+already connected/);
    assert.doesNotMatch(again.stdout, /start a new Junie session/);
    assert.deepEqual([md5(m.at.config), md5(m.at.mcp)], before);

    // a group they add after ours: ours stay where they are, and the file is not written
    const edited = json(m.at.config);
    edited.hooks.PreToolUse.push({ matcher: 'Write', hooks: [{ type: 'command', command: 'echo added-later' }] });
    fs.writeFileSync(m.at.config, JSON.stringify(edited, null, 4) + '\n');
    const afterEdit = md5(m.at.config);
    const third = await login(m, server);
    assert.match(third.stdout, /Junie\s+already connected/);
    assert.equal(md5(m.at.config), afterEdit);
  } finally {
    await server.close();
  }
});

test("logout gives the person's files back byte for byte, however they were laid out, and takes away what login made", async () => {
  const server = await startServer();
  try {
    const layouts = [
      ['four spaces, hooks of their own', JSON.stringify(THEIR_CONFIG, null, 4) + '\n'],
      ['one line, no newline, no hooks', JSON.stringify({ model: 'gpt-5.5' })],
      ['tabs and CRLF', JSON.stringify({ model: 'gpt-5.5', theme: 'dark' }, null, '\t').replace(/\n/g, '\r\n') + '\r\n'],
    ];
    for (const [layout, text] of layouts) {
      const m = junieMachine({ config: text, mcp: JSON.stringify(THEIR_MCP) });
      const mcpBefore = fs.readFileSync(m.at.mcp, 'utf8');
      await login(m, server);
      assert.ok(json(m.at.config).hooks.Stop, layout);
      const out = await run(['logout'], m.env);
      assert.equal(out.code, 0, out.stderr);
      assert.equal(fs.readFileSync(m.at.config, 'utf8'), text, layout);
      assert.equal(fs.readFileSync(m.at.mcp, 'utf8'), mcpBefore, layout);
      assert.ok(!fs.existsSync(m.hookDir), layout);
    }

    // nothing of the person's: both files are made, private, and both go again, with the folder made for the server
    const bare = junieMachine({ config: null, mcp: null });
    fs.rmSync(path.join(bare.at.home, 'mcp'), { recursive: true });
    await login(bare, server);
    if (process.platform !== 'win32') {
      assert.equal(mode(bare.at.config), 0o600);
      assert.equal(mode(bare.at.mcp), 0o600);
    }
    assert.deepEqual(Object.keys(json(bare.at.config)), ['hooks']);
    await run(['logout'], bare.env);
    assert.ok(!fs.existsSync(bare.at.config));
    assert.ok(!fs.existsSync(path.join(bare.at.home, 'mcp')), 'mcp/, which held only ours');
  } finally {
    await server.close();
  }
});

test('tools lists Junie and adds or removes it on its own; doctor checks its hooks, the scripts they run and its dialect', async () => {
  const server = await startServer();
  const m = junieMachine();
  const before = fs.readFileSync(m.at.config, 'utf8');
  try {
    const list = await run(['tools'], m.env);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /junie\s+Junie\s+found · junie 26\.9\.22\s+not connected/);

    const add = await run(['tools', 'add', 'junie'], m.env);
    assert.equal(add.code, 0, add.stderr);
    assert.match(add.stdout, /Junie\s+connected/);
    assert.doesNotMatch(add.stdout, /Claude Code/, 'one at a time');
    assert.match((await run(['tools'], m.env)).stdout, /junie\s+Junie\s+found · junie 26\.9\.22\s+connected/);

    const remove = await run(['tools', 'remove', 'junie'], m.env);
    assert.equal(remove.code, 0, remove.stderr);
    assert.match(remove.stdout, /Junie\s+disconnected/);
    assert.equal(fs.readFileSync(m.at.config, 'utf8'), before);
    assert.match((await run(['tools', 'remove', 'junie'], m.env)).stdout, /Junie\s+was not connected/);

    await login(m, server);
    const doctor = await run(['doctor'], m.env, m.home);
    assert.match(doctor.stdout, shownHere(/Junie: hooks in ~\/\.junie\/config\.json \(4 events\) · MCP server registered/));

    // without its dialect the generic hook answers Junie with silence, and reports nothing
    fs.rmSync(path.join(m.hookDir, 'dialects', 'junie.mjs'));
    const silent = await run(['doctor'], m.env, m.home);
    assert.match(silent.stdout, /✗ Junie: runs .*dialects[\\/]junie\.mjs, which does not exist — every call fails — run: npx agentmash login/);
    assert.equal(silent.code, 1);
    fs.rmSync(path.join(m.hookDir, 'agent_hook.mjs'));
    assert.match((await run(['doctor'], m.env, m.home)).stdout, /✗ Junie: runs .*agent_hook\.mjs, which does not exist/);
  } finally {
    await server.close();
  }
});

test('Junie is found by its CLI, its command or its builds; a ~/.junie of the IDE’s alone is not it; JUNIE_HOME moves its files', async () => {
  const server = await startServer();
  try {
    // the IDE's Junie makes ~/.junie too, and runs no hooks
    const ide = junieMachine({ command: false });
    const before = md5(ide.at.config);
    const skipped = await login(ide, server);
    assert.match(skipped.stdout, /Junie\s+skipped — not found on this machine/);
    assert.equal(md5(ide.at.config), before);

    // the builds folder the installer makes, with no command on the path
    const data = junieMachine({ command: false, data: true });
    assert.match((await login(data, server)).stdout, /Junie\s+connected/);
    const elsewhere = junieMachine({ command: false });
    const dataDir = path.join(elsewhere.home, 'opt', 'junie-data');
    fs.mkdirSync(dataDir, { recursive: true });
    assert.match((await run(['login', '--server', server.url, '--no-open'], { ...elsewhere.env, JUNIE_DATA: dataDir })).stdout, /Junie\s+connected/);

    // JUNIE_HOME: Junie's home is there, and ~/.junie is left as it was
    const moved = junieMachine();
    const junieHome = path.join(moved.home, 'junie-home');
    const env = { ...moved.env, JUNIE_HOME: junieHome };
    const homeBefore = md5(moved.at.config);
    const out = await run(['login', '--server', server.url, '--no-open'], env);
    assert.match(out.stdout, shownHere(/Junie\s+connected\s+~\/junie-home\/config\.json/));
    assert.ok(json(path.join(junieHome, 'config.json')).hooks.PreToolUse);
    assert.ok(json(path.join(junieHome, 'mcp', 'mcp.json')).mcpServers.agentmash);
    assert.equal(md5(moved.at.config), homeBefore);
    await run(['logout'], env);
    assert.ok(!fs.existsSync(path.join(junieHome, 'config.json')));
  } finally {
    await server.close();
  }
});

test('a config.json that does not read, or whose hooks are not an object, is skipped and said; logout names one that still holds ours', async () => {
  const server = await startServer();
  try {
    // Junie reads config.json strictly: a trailing comma is not JSON to it either
    for (const [text, why] of [
      ['{\n  "model": "x",\n}\n', shownHere(/Junie\s+skipped — ~\/\.junie\/config\.json is not valid JSON — fix it, then run login again/)],
      ['{ "hooks": [] }\n', shownHere(/Junie\s+skipped — "hooks" in ~\/\.junie\/config\.json is not an object/)],
    ]) {
      const m = junieMachine({ config: text });
      const mcpBefore = md5(m.at.mcp);
      const out = await login(m, server);
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, why);
      assert.equal(fs.readFileSync(m.at.config, 'utf8'), text, 'not a byte changed');
      assert.equal(md5(m.at.mcp), mcpBefore);
      const logout = await run(['logout'], m.env);
      assert.doesNotMatch(logout.stdout, /config\.json is not valid JSON/, 'nothing of ours in it, nothing to say');
    }

    // broken by hand since login: logout says so, and keeps the scripts it still runs
    const m = junieMachine();
    await login(m, server);
    fs.writeFileSync(m.at.config, fs.readFileSync(m.at.config, 'utf8').replace(/\}\s*$/, ',}'));
    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/~\/\.junie\/config\.json is not valid JSON: agentmash is still in it/));
    assert.match(out.stdout, shownHere(/kept .*\.agentmash\/hooks/));
    assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')));
    assert.ok(!json(m.at.mcp).mcpServers.agentmash, 'the server came out of the file that reads');

    // an mcp.json that does not read, or an agentmash server of someone else's: the hooks still go in
    const badMcp = junieMachine({ mcp: '{ "mcpServers": { } ' });
    const said = await login(badMcp, server);
    assert.match(said.stdout, /Junie\s+connected/);
    assert.match(said.stdout, shownHere(/~\/\.junie\/mcp\/mcp\.json is not valid JSON: the MCP server was not added/));
    const theirs = { mcpServers: { agentmash: { command: 'npx', args: ['their-agentmash'] } } };
    const taken = junieMachine({ mcp: JSON.stringify(theirs) });
    assert.match((await login(taken, server)).stdout, shownHere(/a server called agentmash is in ~\/\.junie\/mcp\/mcp\.json already, and not ours: left as it is/));
    await run(['logout'], taken.env);
    assert.deepEqual(json(taken.at.mcp), theirs);
  } finally {
    await server.close();
  }
});

test('a symlinked config.json stays a link with ours in what it points at, modes are kept, and nothing half-written is left', { skip: process.platform === 'win32' && 'POSIX modes and symlinks' }, async () => {
  const server = await startServer();
  try {
    const m = junieMachine();
    const dotfiles = path.join(m.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const target = path.join(dotfiles, 'junie-config.json');
    fs.renameSync(m.at.config, target);
    fs.chmodSync(target, 0o640);
    fs.symlinkSync(target, m.at.config);
    const before = fs.readFileSync(target, 'utf8');

    await login(m, server);
    assert.ok(fs.lstatSync(m.at.config).isSymbolicLink(), 'still the link');
    assert.ok(json(target).hooks.Stop, 'ours went into what it points at');
    assert.equal(mode(target), 0o640);
    assert.equal(mode(m.at.mcp), 0o600);
    for (const dir of [m.at.home, path.join(m.at.home, 'mcp'), dotfiles]) assert.deepEqual(tmpLeft(dir), [], dir);

    await run(['logout'], m.env);
    assert.ok(fs.lstatSync(m.at.config).isSymbolicLink());
    assert.equal(fs.readFileSync(target, 'utf8'), before);
    assert.equal(mode(target), 0o640);
  } finally {
    await server.close();
  }
});

test("what login registers is the same every time: a person's file is never rewritten by an upgrade that changed nothing", { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  const dir = '/home/someone/.agentmash/hooks';
  const hooks = junieHooks(dir);
  assert.deepEqual(hooks, junieHooks(dir));
  // pinned: a change here rewrites every connected person's config.json, so it is made on purpose
  assert.equal(crypto.createHash('md5').update(JSON.stringify(hooks)).digest('hex'), '721d30edaae899e5cc73e4645296f5f8');
  assert.deepEqual(
    Object.values(hooks).flat().flatMap((g) => g.hooks.map((h) => h.command)),
    ['session_start', 'prompt', 'pre_edit', 'stop'].map((e) => `node "${dir}/agent_hook.mjs" ${e} --global --client junie --dialect junie`)
  );
  assert.deepEqual([junie.id, junie.name, junie.env], ['junie', 'Junie', ['JUNIE_HOME', 'JUNIE_DATA']]);
  assert.deepEqual(Object.keys(junie.files({ home: '/h' })), ['config', 'mcp']);
});
