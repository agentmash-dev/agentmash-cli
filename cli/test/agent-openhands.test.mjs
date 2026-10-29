// OpenHands, as `npx agentmash login` connects it: the OpenHands CLI through
// ~/.openhands/hooks.json and the MCP server in its mcp.json, Agent Canvas
// through a plugin folder of our own under ~/.openhands/plugins, each after
// whatever is the person's, and out again by logout or `tools remove`,
// leaving their files byte for byte as they were. Every test runs in a home
// of its own (fixtures/machine.mjs), with stand-ins for the `openhands` and
// `agent-canvas` commands, and OpenHands' own variables cleared: no test
// reads or writes a real ~/.openhands. OpenHands itself is not run here; what
// it does with these entries is from its source (the Software Agent SDK at
// v1.21.0 and v1.51.0, the CLI at 1.16.0, Agent Canvas at 1.24.0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import openhands, { PLUGIN_MANIFEST, openhandsHooks } from '../agents/openhands.mjs';
import { agentPlaces } from '../tools.mjs';
import { CLI_DIR, json, machine, md5, run, runsOurs, shownHere, startServer } from './fixtures/machine.mjs';

const POSIX = process.platform !== 'win32';
const STAND_INS = {
  openhands: `if (process.argv[2] === '--version') console.log('OpenHands CLI 1.16.0');`,
  'agent-canvas': `process.exit(0);`,
};
const OURS_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionEnd'];

/**
 * A machine with OpenHands on it and no other agent: the CLI (`cli`), Agent
 * Canvas (`canvas`), each as its command, and the person's own hooks.json and
 * mcp.json (`hooks`, `mcp`: a value, or the text itself) in ~/.openhands.
 */
function ohMachine({ cli = true, canvas = false, hooks = null, mcp = null } = {}) {
  const m = machine({ with: [...(cli ? ['openhands'] : []), ...(canvas ? ['agent-canvas'] : [])], codex: false, cursor: false, copilot: false, scripts: STAND_INS });
  const dir = path.join(m.home, '.openhands');
  fs.mkdirSync(dir, { recursive: true });
  const write = (file, value) => value !== null && fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  write(path.join(dir, 'hooks.json'), hooks);
  write(path.join(dir, 'mcp.json'), mcp);
  const plugin = path.join(dir, 'plugins', 'agentmash-openhands');
  return {
    ...m,
    dir,
    hooksFile: path.join(dir, 'hooks.json'),
    mcpFile: path.join(dir, 'mcp.json'),
    plugin,
    pluginHooks: path.join(plugin, 'hooks', 'hooks.json'),
    pluginMcp: path.join(plugin, '.mcp.json'),
    manifest: path.join(plugin, '.plugin', 'plugin.json'),
  };
}

/** The person's hooks.json: their own guard on the shell, and a Stop hook of theirs. */
const THEIR_HOOKS = {
  hooks: {
    PreToolUse: [{ matcher: 'terminal', hooks: [{ type: 'command', command: '~/bin/guard.sh', timeout: 2 }] }],
    Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'say done' }] }],
  },
};
/** Their mcp.json, as `openhands mcp add` writes one. */
const THEIR_MCP = {
  mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: {}, transport: 'stdio', enabled: true } },
};

const login = (server, m, extra = []) => run(['login', '--server', server.url, '--no-open', ...extra], m.env);
const oursIn = (events) => Object.values(events).flat().filter(runsOurs);
const command = (m, event) => `node "${path.join(m.hookDir, 'agent_hook.mjs')}" ${event} --global --client openhands --dialect openhands`;

test("login connects the OpenHands CLI in ~/.openhands, after the person's hooks and servers, and says what OpenHands does with them", async () => {
  const server = await startServer();
  const m = ohMachine({ hooks: THEIR_HOOKS, mcp: THEIR_MCP });
  try {
    const out = await login(server, m);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/OpenHands\s+connected\s+~\/\.openhands\/hooks\.json\s*\n/));
    assert.match(out.stdout, /refused once, with the warning as the reason, and the same edit again goes through/);
    assert.match(out.stdout, /not in a folder with a \.openhands\/hooks\.json of its own: it reads that one instead/);

    const file = json(m.hooksFile);
    assert.deepEqual(Object.keys(file), ['hooks']);
    const hooks = file.hooks;
    assert.deepEqual(Object.keys(hooks), ['PreToolUse', 'Stop', 'PostToolUse', 'UserPromptSubmit', 'SessionEnd']);
    assert.deepEqual(hooks.PreToolUse[0], THEIR_HOOKS.hooks.PreToolUse[0], 'their hook first, as it was');
    assert.deepEqual(hooks.Stop, THEIR_HOOKS.hooks.Stop);
    assert.equal(hooks.PreToolUse[1].matcher, 'file_editor|planning_file_editor|edit|write_file|apply_patch');
    assert.equal(hooks.PostToolUse[0].matcher, 'file_editor|planning_file_editor|edit|write_file|apply_patch|terminal');
    assert.equal(hooks.UserPromptSubmit[0].matcher, '*', 'the only matcher an event with no tool matches');
    assert.equal(hooks.SessionEnd[0].matcher, '*');
    const named = { PreToolUse: 'pre_edit', PostToolUse: 'post_edit', UserPromptSubmit: 'prompt', SessionEnd: 'session_end' };
    for (const event of OURS_EVENTS) {
      const [group] = oursIn({ [event]: hooks[event] });
      assert.deepEqual(group.hooks, [{ type: 'command', command: command(m, named[event]), timeout: 5 }], event);
      assert.doesNotMatch(group.hooks[0].command, /\d+\.\d+\.\d+/, 'no version of ours: the same command from one release to the next');
    }

    const mcp = json(m.mcpFile);
    assert.deepEqual(Object.keys(mcp.mcpServers), ['github', 'agentmash']);
    assert.deepEqual(mcp.mcpServers.github, THEIR_MCP.mcpServers.github);
    assert.deepEqual(mcp.mcpServers.agentmash, { command: 'node', args: [path.join(m.hookDir, 'mcp_server.mjs')], env: {}, transport: 'stdio' });

    assert.ok(!fs.existsSync(path.join(m.dir, 'plugins')), 'no Agent Canvas here: no plugin');
    // the scripts every entry runs, and the dialect the generic hook answers in
    assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')));
    assert.ok(fs.readFileSync(path.join(m.hookDir, 'dialects', 'openhands.mjs')).equals(fs.readFileSync(path.join(CLI_DIR, '..', 'hooks', 'dialects', 'openhands.mjs'))));
  } finally {
    await server.close();
  }
});

test('Agent Canvas gets a plugin folder of our own, its MCP file private, and logout takes the folder away', async () => {
  const server = await startServer();
  const m = ohMachine({ cli: false, canvas: true });
  try {
    const out = await login(server, m);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/OpenHands\s+connected\s+~\/\.openhands\/plugins\/agentmash-openhands/));
    assert.match(out.stdout, /Agent Canvas loads the agentmash-openhands plugin into each new conversation/);
    // not "agentmash": goose's ~/.agents/plugins/agentmash is a plugin Agent Canvas finds first, and one name loads once
    assert.equal(path.basename(m.plugin), 'agentmash-openhands');
    assert.deepEqual(json(m.manifest), PLUGIN_MANIFEST);
    assert.equal(PLUGIN_MANIFEST.name, 'agentmash-openhands');
    assert.ok(!fs.existsSync(path.join(m.plugin, 'plugin.json')), 'a manifest at the root would make it another kind of plugin');
    assert.deepEqual(json(m.pluginHooks), { hooks: openhandsHooks(m.hookDir) });
    assert.deepEqual(json(m.pluginMcp), { mcpServers: { agentmash: { command: 'node', args: [path.join(m.hookDir, 'mcp_server.mjs')] } } });
    if (POSIX) assert.equal(fs.statSync(m.pluginMcp).mode & 0o777, 0o600, 'it holds an MCP server');
    assert.ok(!fs.existsSync(m.hooksFile), 'Agent Canvas reads no user hooks.json: none is written for it');
    assert.ok(!fs.existsSync(m.mcpFile));

    const out2 = await run(['logout'], m.env);
    assert.equal(out2.code, 0, out2.stderr);
    assert.ok(!fs.existsSync(m.plugin), 'the folder is ours, and gone');
    assert.ok(fs.existsSync(m.dir), 'the ~/.openhands OpenHands keeps its own things in stays');
    assert.ok(!fs.existsSync(m.hookDir), 'nothing runs the scripts any more');

    // the app alone says Agent Canvas is here too
    const app = ohMachine({ cli: false });
    fs.mkdirSync(path.join(app.env.AGENTMASH_APPS_DIR, 'OpenHands Agent Canvas.app'), { recursive: true });
    assert.match((await login(server, app)).stdout, shownHere(/OpenHands\s+connected\s+~\/\.openhands\/plugins\/agentmash-openhands\s*\n/));
  } finally {
    await server.close();
  }
});

test('login again is already connected and leaves every file byte for byte; logout gives them back byte for byte, in their own layout', async () => {
  const server = await startServer();
  // four spaces and no newline at the end: not how JSON.stringify would write them
  const hooksText = JSON.stringify(THEIR_HOOKS, null, 4);
  const mcpText = JSON.stringify(THEIR_MCP, null, 4);
  const m = ohMachine({ canvas: true, hooks: hooksText, mcp: mcpText });
  try {
    const first = await login(server, m);
    assert.match(first.stdout, shownHere(/OpenHands\s+connected\s+~\/\.openhands\/hooks\.json and ~\/\.openhands\/plugins\/agentmash-openhands/));
    const all = [m.hooksFile, m.mcpFile, m.pluginHooks, m.pluginMcp, m.manifest];
    const connected = Object.fromEntries(all.map((f) => [f, fs.readFileSync(f, 'utf8')]));
    assert.match(connected[m.hooksFile], /\n {4}"hooks": \{/, 'still four spaces');
    assert.ok(!connected[m.mcpFile].endsWith('\n'));

    const again = await login(server, m);
    assert.match(again.stdout, /OpenHands\s+already connected/);
    for (const f of all) assert.equal(fs.readFileSync(f, 'utf8'), connected[f], f);

    // a hook the person adds after ours leaves ours where it is
    const edited = json(m.hooksFile);
    edited.hooks.PreToolUse.push({ matcher: 'browser_navigate', hooks: [{ type: 'command', command: 'echo later' }] });
    fs.writeFileSync(m.hooksFile, JSON.stringify(edited, null, 4));
    const before = md5(m.hooksFile);
    assert.match((await login(server, m)).stdout, /OpenHands\s+already connected/);
    assert.equal(md5(m.hooksFile), before);
    edited.hooks.PreToolUse.pop();
    fs.writeFileSync(m.hooksFile, JSON.stringify(edited, null, 4));

    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(fs.readFileSync(m.hooksFile, 'utf8'), hooksText, 'byte for byte');
    assert.equal(fs.readFileSync(m.mcpFile, 'utf8'), mcpText, 'byte for byte');
    assert.ok(!fs.existsSync(m.plugin));
    assert.ok(!fs.existsSync(m.hookDir), 'nothing runs the scripts any more');
  } finally {
    await server.close();
  }
});

test("a hooks.json with its events at the top, or in snake_case, gets ours the same way, and comes back as it was", async () => {
  const server = await startServer();
  try {
    const snake = { pre_tool_use: [{ matcher: 'terminal', hooks: [{ type: 'command', command: '~/bin/guard.sh' }] }] };
    const m = ohMachine({ hooks: snake });
    const text = fs.readFileSync(m.hooksFile, 'utf8');
    await login(server, m);
    const file = json(m.hooksFile);
    // OpenHands refuses a file with an event in both spellings, and one with any key but events beside them
    assert.deepEqual(Object.keys(file), ['pre_tool_use', 'post_tool_use', 'user_prompt_submit', 'session_end']);
    assert.deepEqual(file.pre_tool_use[0], snake.pre_tool_use[0]);
    assert.equal(oursIn(file).length, 4);
    await run(['logout'], m.env);
    assert.equal(fs.readFileSync(m.hooksFile, 'utf8'), text);

    const pascal = { PreToolUse: snake.pre_tool_use };
    const p = ohMachine({ hooks: pascal });
    await login(server, p);
    assert.deepEqual(Object.keys(json(p.hooksFile)), ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionEnd']);
    await run(['logout'], p.env);
    assert.deepEqual(json(p.hooksFile), pascal);

    // an empty file reads as none: ours goes in wrapped, and the file goes with ours (an empty file and none are the same to OpenHands)
    const empty = ohMachine({ hooks: '' });
    await login(server, empty);
    assert.deepEqual(Object.keys(json(empty.hooksFile)), ['hooks']);
    await run(['logout'], empty.env);
    assert.ok(!fs.existsSync(empty.hooksFile));
  } finally {
    await server.close();
  }
});

test("a hooks.json OpenHands would not load is left as it is, and said; logout names one that still holds ours, and keeps the scripts", async () => {
  const server = await startServer();
  try {
    const cases = [
      ['{ "hooks": ', /is not valid JSON — fix it, then run login again/],
      ['{"PreToolUse": [], "pre_tool_use": []}\n', /is not one OpenHands can load: it has both PreToolUse and pre_tool_use/],
      ['{"$schema": "x", "PreToolUse": []}\n', /is not one OpenHands can load: "\$schema" in it is not an event OpenHands knows/],
      ['{"hooks": [1]}\n', /is not one OpenHands can load: its "hooks" is not an object/],
      ['{"hooks": {"PreToolUse": {}}}\n', /is not one OpenHands can load: its "PreToolUse" is not a list/],
    ];
    for (const [text, why] of cases) {
      const m = ohMachine({ hooks: text });
      const out = await login(server, m);
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, shownHere(new RegExp(`OpenHands\\s+skipped — ~/\\.openhands/hooks\\.json ${why.source}`)));
      assert.equal(fs.readFileSync(m.hooksFile, 'utf8'), text, 'not a byte changed');
      assert.ok(!fs.existsSync(m.mcpFile), 'nothing half connected');
    }

    // with Agent Canvas here too, it is connected all the same, and the CLI's file is named
    const both = ohMachine({ canvas: true, hooks: cases[0][0] });
    const out = await login(server, both);
    assert.match(out.stdout, shownHere(/OpenHands\s+connected\s+~\/\.openhands\/plugins\/agentmash-openhands/));
    assert.match(out.stdout, shownHere(/· ~\/\.openhands\/hooks\.json is not valid JSON — fix it, then run login again/));

    // ours in it, then the file broken by hand: ours cannot come out without theirs
    const m = ohMachine({ hooks: THEIR_HOOKS });
    await login(server, m);
    fs.writeFileSync(m.hooksFile, fs.readFileSync(m.hooksFile, 'utf8').replace(/\}\s*$/, ',}'));
    const spoiled = fs.readFileSync(m.hooksFile, 'utf8');
    const gone = await run(['logout'], m.env);
    assert.equal(gone.code, 0, gone.stderr);
    assert.match(gone.stdout, shownHere(/~\/\.openhands\/hooks\.json is not valid JSON: agentmash is still in it/));
    assert.match(gone.stdout, shownHere(/kept .*\.agentmash\/hooks/));
    assert.equal(fs.readFileSync(m.hooksFile, 'utf8'), spoiled);
    assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')), 'what OpenHands still runs is still there');

    // a broken file that never held ours is not ours to name
    const clean = ohMachine({ hooks: '{ nope' });
    assert.doesNotMatch((await run(['logout'], clean.env)).stdout, /hooks\.json is not valid JSON/);
  } finally {
    await server.close();
  }
});

test('tools lists OpenHands, and adds or removes it on its own', async () => {
  const m = ohMachine({ hooks: THEIR_HOOKS, mcp: THEIR_MCP });
  const before = { hooks: fs.readFileSync(m.hooksFile, 'utf8'), mcp: fs.readFileSync(m.mcpFile, 'utf8') };
  const list = await run(['tools'], m.env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /openhands\s+OpenHands\s+found · OpenHands CLI 1\.16\.0\s+not connected/);

  const add = await run(['tools', 'add', 'openhands'], m.env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /OpenHands\s+connected/);
  assert.deepEqual(json(path.join(m.home, '.claude', 'settings.json')), { model: 'opus' }, 'one at a time: not even Claude Code');
  assert.match((await run(['tools'], m.env)).stdout, /openhands\s+OpenHands\s+found · OpenHands CLI 1\.16\.0\s+connected/);

  const remove = await run(['tools', 'remove', 'openhands'], m.env);
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /OpenHands\s+disconnected/);
  assert.equal(fs.readFileSync(m.hooksFile, 'utf8'), before.hooks);
  assert.equal(fs.readFileSync(m.mcpFile, 'utf8'), before.mcp);
  assert.match((await run(['tools', 'remove', 'openhands'], m.env)).stdout, /OpenHands\s+was not connected/);

  // no command, no settings, no ~/.openhands: not here, and login leaves it
  const server = await startServer();
  try {
    const none = machine({ with: [], codex: false, cursor: false, copilot: false });
    assert.match((await run(['tools'], none.env)).stdout, /openhands\s+OpenHands\s+not found/);
    assert.match((await login(server, none)).stdout, /OpenHands\s+skipped — not found on this machine/);
    assert.ok(!fs.existsSync(path.join(none.home, '.openhands')));
  } finally {
    await server.close();
  }
});

test("doctor says where OpenHands runs our hooks, and names a script or the dialect that is not there", async () => {
  const server = await startServer();
  const m = ohMachine({ canvas: true, hooks: THEIR_HOOKS });
  try {
    await login(server, m);
    const first = await run(['doctor'], m.env, m.home);
    assert.match(first.stdout, shownHere(/OpenHands: hooks in ~\/\.openhands\/hooks\.json and ~\/\.openhands\/plugins\/agentmash-openhands \(4 events\) · MCP server registered/));

    fs.rmSync(path.join(m.hookDir, 'dialects', 'openhands.mjs'));
    const noDialect = await run(['doctor'], m.env, m.home);
    assert.match(noDialect.stdout, /✗ OpenHands: runs .*dialects[\\/]openhands\.mjs, which does not exist — every call fails — run: npx agentmash login/);
    assert.equal(noDialect.code, 1);

    await login(server, m);
    fs.rmSync(path.join(m.hookDir, 'agent_hook.mjs'));
    const broken = await run(['doctor'], m.env, m.home);
    assert.match(broken.stdout, /✗ OpenHands: runs .*agent_hook\.mjs, which does not exist/);

    await login(server, m);
    fs.writeFileSync(m.pluginHooks, '{ broken');
    const invalid = await run(['doctor'], m.env, m.home);
    assert.match(invalid.stdout, shownHere(/OpenHands: ~\/\.openhands\/plugins\/agentmash-openhands\/hooks\/hooks\.json is not valid JSON/));
  } finally {
    await server.close();
  }
});

test('symlinked files stay links, and a private one stays private', { skip: !POSIX && 'POSIX modes and symlinks' }, async () => {
  const server = await startServer();
  try {
    const m = ohMachine();
    const dotfiles = path.join(m.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const targets = { [m.hooksFile]: path.join(dotfiles, 'openhands-hooks.json'), [m.mcpFile]: path.join(dotfiles, 'openhands-mcp.json') };
    const texts = { [m.hooksFile]: JSON.stringify(THEIR_HOOKS, null, 2) + '\n', [m.mcpFile]: JSON.stringify(THEIR_MCP, null, 2) + '\n' };
    for (const [link, target] of Object.entries(targets)) {
      fs.writeFileSync(target, texts[link]);
      fs.chmodSync(target, 0o600);
      fs.symlinkSync(target, link);
    }

    await login(server, m);
    for (const [link, target] of Object.entries(targets)) {
      assert.ok(fs.lstatSync(link).isSymbolicLink(), `${link} is still the link`);
      assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    }
    assert.equal(oursIn(json(targets[m.hooksFile]).hooks).length, 4, 'ours went into what it points at');
    assert.ok(json(targets[m.mcpFile]).mcpServers.agentmash);
    for (const dir of [m.dir, dotfiles]) assert.deepEqual(fs.readdirSync(dir).filter((f) => /tmp/.test(f)), [], `no temporary file left in ${dir}`);

    await run(['logout'], m.env);
    for (const [link, target] of Object.entries(targets)) {
      assert.ok(fs.lstatSync(link).isSymbolicLink());
      assert.equal(fs.readFileSync(target, 'utf8'), texts[link]);
      assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    }

    // an mcp.json login makes is private
    const fresh = ohMachine();
    await login(server, fresh);
    assert.equal(fs.statSync(fresh.mcpFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(fresh.hooksFile).mode & 0o777, 0o644, 'hooks hold no secret');
  } finally {
    await server.close();
  }
});

test("a server called agentmash of the person's own is left alone, and an agentmash server they switched off stays off", async () => {
  const server = await startServer();
  try {
    const mine = { mcpServers: { agentmash: { command: 'docker', args: ['run', 'my/agentmash'] } } };
    const m = ohMachine({ mcp: mine });
    const out = await login(server, m);
    assert.match(out.stdout, shownHere(/a server called agentmash is in ~\/\.openhands\/mcp\.json already, and not ours: left as it is/));
    assert.deepEqual(json(m.mcpFile), mine);
    assert.equal(oursIn(json(m.hooksFile).hooks).length, 4, 'the hooks went in all the same');
    await run(['logout'], m.env);
    assert.deepEqual(json(m.mcpFile), mine);

    // `openhands mcp disable agentmash` writes enabled: false into ours: the person's choice, kept by login
    const off = ohMachine();
    await login(server, off);
    const disabled = json(off.mcpFile);
    disabled.mcpServers.agentmash.enabled = false;
    fs.writeFileSync(off.mcpFile, JSON.stringify(disabled, null, 2) + '\n');
    assert.match((await login(server, off)).stdout, /OpenHands\s+already connected/);
    assert.equal(json(off.mcpFile).mcpServers.agentmash.enabled, false);
    await run(['logout'], off.env);
    assert.ok(!fs.existsSync(off.mcpFile));
  } finally {
    await server.close();
  }
});

test("where each file goes follows OpenHands' own variables, and a path the shell would read into is never written", async () => {
  const m = ohMachine({ canvas: true });
  const places = { ...agentPlaces(), home: m.home, toolPath: m.env.AGENTMASH_TOOL_PATH, apps: m.env.AGENTMASH_APPS_DIR };
  const saved = { cli: process.env.OPENHANDS_PERSISTENCE_DIR, canvas: process.env.OH_PERSISTENCE_DIR };
  const restore = () => {
    for (const [key, value] of [['OPENHANDS_PERSISTENCE_DIR', saved.cli], ['OH_PERSISTENCE_DIR', saved.canvas]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    delete process.env.OPENHANDS_PERSISTENCE_DIR;
    delete process.env.OH_PERSISTENCE_DIR;
    assert.deepEqual(openhands.files(places), {
      hooks: m.hooksFile,
      mcp: m.mcpFile,
      pluginHooks: m.pluginHooks,
      pluginMcp: m.pluginMcp,
      manifest: m.manifest,
    });

    // the CLI keeps mcp.json in its persistence folder, and still reads hooks.json from the home folder (SDK 1.21.0)
    const cliDir = path.join(m.home, 'oh-cli');
    const canvasDir = path.join(m.home, 'oh-canvas');
    process.env.OPENHANDS_PERSISTENCE_DIR = cliDir;
    process.env.OH_PERSISTENCE_DIR = canvasDir;
    const at = openhands.files(places);
    assert.deepEqual([at.hooks, at.mcp, at.pluginHooks], [m.hooksFile, path.join(cliDir, 'mcp.json'), path.join(canvasDir, 'plugins', 'agentmash-openhands', 'hooks', 'hooks.json')]);
    const said = openhands.connect(places, m.hookDir);
    assert.equal(said.status, 'connected');
    assert.ok(fs.existsSync(path.join(cliDir, 'mcp.json')));
    assert.ok(fs.existsSync(at.pluginHooks));
    const state = openhands.inspect(places);
    assert.deepEqual([state.connected, state.invalid, state.mcp, state.events], [true, false, true, OURS_EVENTS]);
    assert.equal(openhands.disconnect(places, m.hookDir).status, 'removed');
    assert.ok(!fs.existsSync(path.join(cliDir, 'mcp.json')));
    assert.ok(!fs.existsSync(path.join(canvasDir, 'plugins', 'agentmash-openhands')));

    // a relative folder would be relative to wherever OpenHands started: not one to write to
    process.env.OPENHANDS_PERSISTENCE_DIR = 'relative/dir';
    assert.equal(openhands.files(places).mcp, m.mcpFile);
  } finally {
    restore();
  }

  if (POSIX) {
    const server = await startServer();
    try {
      // ~/.agentmash under a folder with a $ in its name: sh would expand it in the command
      const odd = ohMachine({ hooks: THEIR_HOOKS });
      const env = { ...odd.env, AGENTMASH_HOME: path.join(odd.home, 'cost$HOME') };
      const out = await run(['login', '--server', server.url, '--no-open'], env);
      assert.match(out.stdout, /OpenHands\s+skipped — OpenHands runs hooks through sh, and .* cannot be quoted for it safely/);
      assert.deepEqual(json(odd.hooksFile), THEIR_HOOKS);
    } finally {
      await server.close();
    }
  }
});

test('what login registers is the same every time: four events, version-free commands, whole seconds', { skip: !POSIX && 'POSIX paths' }, () => {
  const dir = '/home/someone/.agentmash/hooks';
  assert.deepEqual(openhands.hooks(dir), openhands.hooks(dir));
  const hooks = openhandsHooks(dir);
  assert.deepEqual(Object.keys(hooks), OURS_EVENTS, 'no SessionStart (its output reaches no model), no Stop (anything said there keeps the agent going)');
  assert.equal(hooks.PreToolUse[0].hooks[0].command, 'node "/home/someone/.agentmash/hooks/agent_hook.mjs" pre_edit --global --client openhands --dialect openhands');
  for (const groups of Object.values(hooks)) {
    for (const hook of groups[0].hooks) {
      assert.ok(Number.isInteger(hook.timeout), 'OpenHands reads whole seconds');
      assert.equal('async' in hook, false, 'run in order, so a report never outlives the hook OpenHands waits on');
    }
  }
  // a matcher with a | is a regular expression OpenHands matches against the whole name (re.fullmatch)
  const full = (matcher, name) => new RegExp(`^(?:${matcher})$`).test(name);
  for (const name of ['file_editor', 'planning_file_editor', 'edit', 'write_file', 'apply_patch']) assert.ok(full(hooks.PreToolUse[0].matcher, name), name);
  for (const name of ['terminal', 'file_editorX', 'browser_navigate', 'task_tracker']) assert.ok(!full(hooks.PreToolUse[0].matcher, name), name);
  assert.ok(full(hooks.PostToolUse[0].matcher, 'terminal'));
});
