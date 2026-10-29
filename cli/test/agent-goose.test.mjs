// goose: `npx agentmash login` gives it a plugin folder of ours,
// ~/.agents/plugins/agentmash, with the generic hook for each of goose's
// events in hooks/hooks.json and the MCP server in .mcp.json, and `npx
// agentmash logout` takes out exactly that. goose's own config.yaml is never
// touched, nor any other plugin. Every test runs in a home of its own
// (fixtures/machine.mjs), goose's folders found through HOME and
// XDG_CONFIG_HOME there, and GOOSE_PATH_ROOT cleared unless a test sets it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import goose, { gooseHooks } from '../agents/goose.mjs';
import { json, machine, md5, run, runsOurs, shownHere, startServer } from './fixtures/machine.mjs';

/** goose as a person leaves it: config.yaml, set up; and another plugin of theirs beside where ours goes. */
const CONFIG_YAML = 'GOOSE_PROVIDER: anthropic\nGOOSE_MODEL: claude-sonnet-4-5\nextensions:\n  developer:\n    enabled: true\n    type: platform\n    name: developer\n';
const THEIR_PLUGIN = { hooks: { PreToolUse: [{ matcher: '^shell$', hooks: [{ type: 'command', command: 'echo their-hook' }] }] } };

/** A home with goose set up in it (and no other agent), `with` the commands on the tool path. */
function gooseMachine({ with: names = [], configured = true, scripts = {} } = {}) {
  const m = machine({ with: names, codex: false, cursor: false, copilot: false, scripts });
  const at = {
    // where goose keeps its config.yaml: %APPDATA%\Block\goose\config on Windows (config/paths.rs)
    config:
      process.platform === 'win32'
        ? path.join(m.home, 'AppData', 'Roaming', 'Block', 'goose', 'config', 'config.yaml')
        : path.join(m.home, '.config', 'goose', 'config.yaml'),
    plugins: path.join(m.home, '.agents', 'plugins'),
    plugin: path.join(m.home, '.agents', 'plugins', 'agentmash'),
    hooks: path.join(m.home, '.agents', 'plugins', 'agentmash', 'hooks', 'hooks.json'),
    mcp: path.join(m.home, '.agents', 'plugins', 'agentmash', '.mcp.json'),
    theirs: path.join(m.home, '.agents', 'plugins', 'their-plugin', 'hooks', 'hooks.json'),
  };
  if (configured) {
    fs.mkdirSync(path.dirname(at.config), { recursive: true });
    fs.writeFileSync(at.config, CONFIG_YAML);
  }
  fs.mkdirSync(path.dirname(at.theirs), { recursive: true });
  fs.writeFileSync(at.theirs, JSON.stringify(THEIR_PLUGIN, null, 2));
  return { ...m, at };
}

/** A stand-in for goose's command: `goose --version` as goose 1.53.0 prints it (clap, with an empty display name). */
const GOOSE = `if (process.argv[2] === '--version') console.log(' 1.53.0');`;
/** And for pressly/goose, the database migration tool of the same name. */
const PRESSLY = `if (process.argv[2] === '--version') console.log('goose version: v3.28.0');`;

test('login connects goose: our plugin folder, the generic hook for each of its events, the MCP server private, and nothing of the person’s touched', async () => {
  const server = await startServer();
  const m = gooseMachine();
  // a group the person put in our hooks.json themselves: it stays, and first
  const mine = { matcher: '^write$', hooks: [{ type: 'command', command: 'echo my-goose-hook' }] };
  fs.mkdirSync(path.dirname(m.at.hooks), { recursive: true });
  const seeded = JSON.stringify({ hooks: { PreToolUse: [mine] } }, null, 2) + '\n';
  fs.writeFileSync(m.at.hooks, seeded);
  try {
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, shownHere(/goose\s+connected\s+~\/\.agents\/plugins\/agentmash\/hooks\/hooks\.json/));
    assert.match(login.stdout, /goose shows the agent a warning by refusing its first edit of a file a teammate is in/);

    const hooks = json(m.at.hooks).hooks;
    assert.deepEqual(Object.keys(hooks), ['PreToolUse', 'SessionStart', 'UserPromptSubmit', 'AfterFileEdit', 'PostToolUse', 'SessionEnd']);
    assert.deepEqual(hooks.PreToolUse[0], mine, 'theirs first, as it was');
    assert.deepEqual(hooks.PreToolUse[1], gooseHooks(m.hookDir).PreToolUse[0]);
    assert.equal(
      hooks.PreToolUse[1].hooks[0].command,
      `node "${path.join(m.hookDir, 'agent_hook.mjs')}" pre_edit --global --client goose --dialect goose`
    );
    for (const group of Object.values(hooks).flat().filter(runsOurs)) {
      for (const action of group.hooks) {
        // the same string from one version to the next, and nothing that would make a failure a refusal
        assert.doesNotMatch(action.command, /\d+\.\d+\.\d+/, action.command);
        assert.ok(!('on_failure' in action));
        assert.ok(fs.existsSync(/"([^"]+)"/.exec(action.command)[1]));
      }
    }
    assert.ok(fs.existsSync(path.join(m.hookDir, 'dialects', 'goose.mjs')), "goose's dialect, beside the generic hook");

    assert.deepEqual(json(m.at.mcp), { mcpServers: { agentmash: { command: 'node', args: [path.join(m.hookDir, 'mcp_server.mjs')], env: {} } } });
    if (process.platform !== 'win32') assert.equal(fs.statSync(m.at.mcp).mode & 0o777, 0o600, 'a new MCP config is private from the start');

    assert.equal(fs.readFileSync(m.at.config, 'utf8'), CONFIG_YAML, "goose's config.yaml, untouched");
    assert.deepEqual(json(m.at.theirs), THEIR_PLUGIN, 'their other plugin, untouched');

    // login again: already, and not a byte different
    const before = [md5(m.at.hooks), md5(m.at.mcp)];
    const again = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /goose\s+already connected/);
    assert.deepEqual([md5(m.at.hooks), md5(m.at.mcp)], before);

    // logout: their group and their file back byte for byte, ours gone, the rest as it was
    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(fs.readFileSync(m.at.hooks, 'utf8'), seeded);
    assert.ok(!fs.existsSync(m.at.mcp));
    assert.equal(fs.readFileSync(m.at.config, 'utf8'), CONFIG_YAML);
    assert.deepEqual(json(m.at.theirs), THEIR_PLUGIN);
    assert.ok(!fs.existsSync(m.hookDir));
  } finally {
    await server.close();
  }
});

test('logout takes the plugin folder away when it held only ours, and leaves the plugins folder and every other plugin', async () => {
  const server = await startServer();
  const m = gooseMachine();
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.ok(fs.existsSync(m.at.hooks));
    await run(['logout'], m.env);
    assert.ok(!fs.existsSync(m.at.plugin), 'our folder, and what was in it');
    assert.deepEqual(fs.readdirSync(m.at.plugins), ['their-plugin']);
    assert.deepEqual(json(m.at.theirs), THEIR_PLUGIN);
  } finally {
    await server.close();
  }
});

test('tools lists goose, finds it by its own folder or command and not by a database tool of the same name, and adds or removes it', async () => {
  // pressly/goose alone: a `goose` command that is not goose
  const pressly = gooseMachine({ with: ['goose'], configured: false, scripts: { goose: PRESSLY } });
  const notFound = await run(['tools'], pressly.env);
  assert.equal(notFound.code, 0, notFound.stderr);
  assert.match(notFound.stdout, /goose\s+goose\s+not found\s+not connected/);
  assert.doesNotMatch(notFound.stdout, /v3\.28\.0/);
  if (process.platform !== 'win32') {
    // goose run once, set up by its environment alone: its sessions are there, and no config.yaml
    fs.mkdirSync(path.join(pressly.home, '.local', 'share', 'goose', 'sessions'), { recursive: true });
    assert.match((await run(['tools'], pressly.env)).stdout, /goose\s+goose\s+found · goose version: v3\.28\.0\s+not connected/);
  }

  const m = gooseMachine({ with: ['goose'], scripts: { goose: GOOSE } });
  const list = await run(['tools'], m.env);
  assert.match(list.stdout, /goose\s+goose\s+found · 1\.53\.0\s+not connected/);

  const add = await run(['tools', 'add', 'goose'], m.env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /goose\s+connected/);
  assert.match((await run(['tools'], m.env)).stdout, /goose\s+goose\s+found · 1\.53\.0\s+connected/);
  assert.ok(json(m.at.mcp).mcpServers.agentmash);

  const remove = await run(['tools', 'remove', 'goose'], m.env);
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /goose\s+disconnected/);
  assert.ok(!fs.existsSync(m.at.plugin));
  assert.match((await run(['tools'], m.env)).stdout, /goose\s+goose\s+found · 1\.53\.0\s+not connected/);
  assert.equal(fs.readFileSync(m.at.config, 'utf8'), CONFIG_YAML);
  // goose's command is asked its version, and nothing else
  assert.ok(m.calls().every((c) => c === 'goose ["--version"]'), m.calls().join('\n'));
});

test('doctor says goose is connected, with its events and its MCP server, and that a missing dialect breaks every hook', async () => {
  const server = await startServer();
  const m = gooseMachine();
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const doctor = await run(['doctor'], m.env, m.home);
    assert.match(doctor.stdout, shownHere(/goose: hooks in ~\/\.agents\/plugins\/agentmash\/hooks\/hooks\.json \(6 events\) · MCP server registered/));

    fs.rmSync(path.join(m.hookDir, 'dialects', 'goose.mjs'));
    const broken = await run(['doctor'], m.env, m.home);
    assert.match(broken.stdout, /✗ goose: runs .*dialects[\\/]goose\.mjs, which does not exist — every call fails — run: npx agentmash login/);
    assert.equal(broken.code, 1);
  } finally {
    await server.close();
  }
});

test('a hooks.json that is not JSON: login skips goose and says which file, and logout names it and keeps the scripts it runs', async () => {
  const server = await startServer();
  const m = gooseMachine();
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    fs.writeFileSync(m.at.hooks, fs.readFileSync(m.at.hooks, 'utf8').replace(/\}\s*$/, ',}'));
    const broken = fs.readFileSync(m.at.hooks, 'utf8');

    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, shownHere(/goose\s+skipped — ~\/\.agents\/plugins\/agentmash\/hooks\/hooks\.json is not valid JSON — fix it, then run login again/));
    assert.equal(fs.readFileSync(m.at.hooks, 'utf8'), broken, 'left as it was');

    const doctor = await run(['doctor'], m.env, m.home);
    assert.match(doctor.stdout, shownHere(/goose: ~\/\.agents\/plugins\/agentmash\/hooks\/hooks\.json is not valid JSON/));

    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/~\/\.agents\/plugins\/agentmash\/hooks\/hooks\.json is not valid JSON: agentmash is still in it/));
    assert.match(out.stdout, shownHere(/kept .*\.agentmash\/hooks/));
    assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')), 'what goose still runs is still there');
    assert.equal(fs.readFileSync(m.at.hooks, 'utf8'), broken);
  } finally {
    await server.close();
  }
});

test('a symlinked hooks.json stays a link, an MCP config keeps its mode, and nothing half-written is left about', { skip: process.platform === 'win32' && 'POSIX modes and symlinks' }, async () => {
  const server = await startServer();
  const m = gooseMachine();
  try {
    // the hooks.json kept in the person's dotfiles, linked in by stow or chezmoi, with a group of theirs
    const dotfiles = path.join(m.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const linked = path.join(dotfiles, 'goose-hooks.json');
    const theirs = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }, null, 2) + '\n';
    fs.writeFileSync(linked, theirs);
    fs.mkdirSync(path.dirname(m.at.hooks), { recursive: true });
    fs.symlinkSync(linked, m.at.hooks);
    // and an .mcp.json of theirs, private
    const mcp = { mcpServers: { notes: { command: 'npx', args: ['notes-mcp'], env: { TOKEN: 'secret' } } } };
    fs.writeFileSync(m.at.mcp, JSON.stringify(mcp, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(m.at.mcp, 0o600);

    await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.ok(fs.lstatSync(m.at.hooks).isSymbolicLink(), 'still the link');
    assert.ok(json(linked).hooks.PreToolUse, 'and ours went into what it points at');
    assert.deepEqual(json(linked).hooks.Stop, JSON.parse(theirs).hooks.Stop);
    assert.equal(fs.statSync(m.at.mcp).mode & 0o777, 0o600, 'a file that may hold tokens stays private');
    assert.deepEqual(json(m.at.mcp).mcpServers.notes, mcp.mcpServers.notes);
    for (const dir of [dotfiles, m.at.plugin, path.dirname(m.at.hooks)]) {
      assert.deepEqual(fs.readdirSync(dir).filter((f) => /tmp/.test(f)), [], `no temporary file left in ${dir}`);
    }

    await run(['logout'], m.env);
    assert.ok(fs.lstatSync(m.at.hooks).isSymbolicLink());
    assert.equal(fs.readFileSync(linked, 'utf8'), theirs);
    assert.deepEqual(json(m.at.mcp), mcp);
    assert.equal(fs.statSync(m.at.mcp).mode & 0o777, 0o600);
  } finally {
    await server.close();
  }
});

test('GOOSE_PATH_ROOT moves where goose is found and where its plugins go', async () => {
  const m = gooseMachine({ configured: false });
  const root = path.join(m.home, 'goose-root');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  const env = { ...m.env, GOOSE_PATH_ROOT: root };
  assert.match((await run(['tools'], env)).stdout, /goose\s+goose\s+found\s+not connected/);
  const add = await run(['tools', 'add', 'goose'], env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, shownHere(/goose\s+connected\s+~\/goose-root\/\.agents\/plugins\/agentmash\/hooks\/hooks\.json/));
  assert.ok(fs.existsSync(path.join(root, '.agents', 'plugins', 'agentmash', '.mcp.json')));
  assert.ok(!fs.existsSync(m.at.plugin), 'not under the home folder');
  // goose ignores a relative one, and so does this
  assert.match((await run(['tools'], { ...m.env, GOOSE_PATH_ROOT: 'goose-root' })).stdout, /goose\s+goose\s+not found\s+not connected/);
  await run(['tools', 'remove', 'goose'], env);
  assert.ok(!fs.existsSync(path.join(root, '.agents', 'plugins', 'agentmash')));
});

test('a hooks folder whose path the shell would read as more than a path is never registered: goose would refuse every edit', () => {
  const saved = process.env.GOOSE_PATH_ROOT;
  delete process.env.GOOSE_PATH_ROOT;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-goose-quote-')));
  const places = { home, toolPath: '', apps: null };
  try {
    for (const odd of ['we$ird', 'back`tick', 'say"hi"']) {
      const result = goose.connect(places, path.join(home, odd, '.agentmash', 'hooks'));
      assert.equal(result.status, 'skipped', odd);
      assert.match(result.why, /goose runs hooks through sh, and .* cannot be quoted for it safely/);
    }
    assert.ok(!fs.existsSync(path.join(home, '.agents')), 'nothing written');
    // a space, brackets or a quote of the other kind are safe inside double quotes
    assert.equal(goose.connect(places, path.join(home, "Jo's (work) files", '.agentmash', 'hooks')).status, 'connected');
    assert.equal(goose.disconnect(places).status, 'removed');
  } finally {
    if (saved !== undefined) process.env.GOOSE_PATH_ROOT = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
