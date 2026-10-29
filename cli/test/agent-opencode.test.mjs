// OpenCode, as `npx agentmash login` connects it: a plugin of ours in
// ~/.config/opencode/plugin/ and our MCP server in OpenCode's global config,
// which is JSONC and the person's. Every test runs in a home of its own
// (fixtures/machine.mjs), with XDG_CONFIG_HOME inside it: nothing here may
// touch a real ~/.config/opencode. What the plugin does once OpenCode runs it
// is pinned in hooks/test/dialect-opencode.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AGENTS, agentFiles, agentPlaces } from '../tools.mjs';
import { opencodePlugin, opencodeServer, readJsonc } from '../agents/opencode.mjs';
import { machine, md5, run, shownHere, startServer } from './fixtures/machine.mjs';

/** `opencode --version`, as 1.18.34 prints it. */
const OPENCODE = { opencode: `if (process.argv[2] === '--version') console.log('1.18.34');` };

/** OpenCode's global config as a person leaves it: JSONC, with comments and trailing commas, and a server of theirs. */
const THEIRS = [
  '// mine: models and servers',
  '{',
  '  "$schema": "https://opencode.ai/config.json",',
  '  "model": "anthropic/claude-sonnet-4-5", // the default',
  '  "mcp": {',
  '    /* the team\'s tracker */',
  '    "linear": { "type": "remote", "url": "https://mcp.linear.app/sse" },',
  '  },',
  '}',
  '',
].join('\n');
const THEIR_PLUGIN = 'export const Notify = async () => ({});\n';

const dirOf = (m) => path.join(m.home, '.config', 'opencode');
const at = (m) => ({
  dir: dirOf(m),
  plugin: path.join(dirOf(m), 'plugin', 'agentmash.js'),
  theirPlugin: path.join(dirOf(m), 'plugin', 'notify.js'),
  config: path.join(dirOf(m), 'opencode.jsonc'),
});
const read = (file) => fs.readFileSync(file, 'utf8');
const mcpOf = (file) => readJsonc(read(file)).value.mcp;
const mode = (file) => fs.statSync(file).mode & 0o777;

/** A machine with OpenCode on it, set up the way a person leaves it (`config`: their global config, or none). */
function withOpencode({ config = THEIRS, plugin = true, ...options } = {}) {
  const m = machine({ with: ['opencode'], scripts: OPENCODE, ...options });
  const where = at(m);
  fs.mkdirSync(path.dirname(where.plugin), { recursive: true });
  if (plugin) fs.writeFileSync(where.theirPlugin, THEIR_PLUGIN);
  if (config !== null) fs.writeFileSync(where.config, config);
  return { ...m, at: where };
}

test('login connects OpenCode at user level: our plugin beside theirs, our server after theirs, their comments where they were', async () => {
  const server = await startServer();
  const m = withOpencode();
  const theirMode = mode(m.at.config);
  try {
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, shownHere(/OpenCode\s+connected\s+~\/\.config\/opencode\/plugin\/agentmash\.js/));
    assert.match(login.stdout, /refusing its first edit of a file a teammate is in; the same edit again goes through/);
    assert.match(login.stdout, /restart it/);

    // the plugin, singular plugin/: from 1.0.0 to 1.0.218 OpenCode refuses a config folder holding plugins/
    assert.equal(read(m.at.plugin), opencodePlugin(m.hookDir));
    assert.ok(!fs.existsSync(path.join(m.at.dir, 'plugins')));
    assert.equal(read(m.at.theirPlugin), THEIR_PLUGIN);
    for (const script of ['agent_hook.mjs', path.join('dialects', 'opencode.mjs'), 'mcp_server.mjs']) {
      assert.ok(fs.existsSync(path.join(m.hookDir, script)), `${script} is there to run`);
    }

    // the server: theirs first, as it was, then ours, and every byte around it theirs
    const text = read(m.at.config);
    const cut = THEIRS.indexOf('\n  },');
    assert.ok(text.startsWith(THEIRS.slice(0, cut)) && text.endsWith(THEIRS.slice(cut)), text);
    const mcp = mcpOf(m.at.config);
    assert.deepEqual(Object.keys(mcp), ['linear', 'agentmash']);
    assert.deepEqual(mcp.agentmash, { type: 'local', command: ['node', path.join(m.hookDir, 'mcp_server.mjs')], enabled: true });
    assert.deepEqual(mcp.agentmash, opencodeServer(m.hookDir));
    assert.equal(mode(m.at.config), theirMode, 'their file keeps the mode it had');
    // and what their config held before agentmash, kept beside it
    assert.deepEqual(fs.readdirSync(m.at.dir).sort(), ['opencode.jsonc', 'opencode.jsonc.before-agentmash', 'plugin']);
    assert.equal(read(`${m.at.config}.before-agentmash`), THEIRS);
    assert.deepEqual(fs.readdirSync(path.dirname(m.at.plugin)).sort(), ['agentmash.js', 'notify.js']);
  } finally {
    await server.close();
  }
});

test('login again is already connected and changes no byte; logout gives the person their files back byte for byte', async () => {
  const server = await startServer();
  const m = withOpencode();
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const before = [md5(m.at.plugin), md5(m.at.config)];
    const again = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /OpenCode\s+already connected/);
    assert.deepEqual([md5(m.at.plugin), md5(m.at.config)], before);

    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /took agentmash out of every agent on this machine/);
    assert.equal(read(m.at.config), THEIRS, 'byte for byte, comments and trailing commas too');
    assert.ok(!fs.existsSync(m.at.plugin));
    assert.equal(read(m.at.theirPlugin), THEIR_PLUGIN, 'their plugin, and the folder it is in, stay');
    assert.ok(!fs.existsSync(m.hookDir), 'nothing names the scripts any more');
  } finally {
    await server.close();
  }
});

test('tools lists OpenCode with its version, and adds or removes it on its own; a config folder it made goes with it', async () => {
  const m = machine({ with: ['opencode'], scripts: OPENCODE, codex: false, cursor: false, copilot: false });
  // OpenCode on the PATH, never run: no config folder yet, and XDG_CONFIG_HOME somewhere of the person's own
  const env = { ...m.env, XDG_CONFIG_HOME: path.join(m.home, 'xdg') };
  const dir = path.join(m.home, 'xdg', 'opencode');
  const list = await run(['tools'], env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /opencode\s+OpenCode\s+found · 1\.18\.34\s+not connected/);

  const add = await run(['tools', 'add', 'opencode'], env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /OpenCode\s+connected/);
  assert.ok(fs.existsSync(path.join(dir, 'plugin', 'agentmash.js')));
  // the file OpenCode would make on its first run, with our server in it, private from the start
  const config = path.join(dir, 'opencode.jsonc');
  assert.deepEqual(readJsonc(read(config)).value, { $schema: 'https://opencode.ai/config.json', mcp: { agentmash: opencodeServer(m.hookDir) } });
  if (process.platform !== 'win32') assert.equal(mode(config), 0o600);
  assert.ok(!fs.existsSync(path.join(m.home, '.config', 'opencode')), 'where XDG_CONFIG_HOME says, and nowhere else');
  assert.match((await run(['tools'], env)).stdout, /opencode\s+OpenCode\s+found · 1\.18\.34\s+connected/);

  const remove = await run(['tools', 'remove', 'opencode'], env);
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /OpenCode\s+disconnected/);
  assert.ok(!fs.existsSync(dir), 'the folder login made, and all in it, gone');
  assert.match((await run(['tools'], env)).stdout, /opencode\s+OpenCode\s+found · 1\.18\.34\s+not connected/);
  assert.match((await run(['tools', 'remove', 'opencode'], env)).stdout, /OpenCode\s+was not connected/);
});

test('doctor says what the plugin runs and whether the server is registered, and when a script it runs is gone', async () => {
  const server = await startServer();
  const m = withOpencode({ codex: false, cursor: false, copilot: false });
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const doctor = await run(['doctor'], m.env, m.home);
    assert.match(doctor.stdout, shownHere(/OpenCode: hooks in ~\/\.config\/opencode\/plugin\/agentmash\.js \(4 events\) · MCP server registered/));

    fs.rmSync(path.join(m.hookDir, 'agent_hook.mjs'));
    const broken = await run(['doctor'], m.env, m.home);
    assert.match(broken.stdout, /✗ OpenCode: runs .*agent_hook\.mjs, which does not exist — every call fails — run: npx agentmash login/);
    assert.equal(broken.code, 1);
  } finally {
    await server.close();
  }
});

test('a config OpenCode cannot read is left as it is and named, at login and at logout, and the scripts it names are kept', async () => {
  const server = await startServer();
  try {
    // broken before login: the plugin goes in, the server does not, and the file is not touched
    const broken = THEIRS.replace('"mcp": {', '"mcp": {{');
    const m = withOpencode({ config: broken });
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, /OpenCode\s+connected/);
    assert.match(login.stdout, shownHere(/~\/\.config\/opencode\/opencode\.jsonc is not valid JSON: the MCP server was not added/));
    assert.equal(read(m.at.config), broken);
    assert.ok(fs.existsSync(m.at.plugin));
    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /opencode\.jsonc is not valid JSON/);
    assert.equal(read(m.at.config), broken, 'nor by logout');
    assert.ok(!fs.existsSync(m.at.plugin));

    // broken since login: logout says which file, and keeps the server it still names
    const n = withOpencode();
    await run(['login', '--server', server.url, '--no-open'], n.env);
    fs.appendFileSync(n.at.config, '}\n');
    const left = await run(['logout'], n.env);
    assert.equal(left.code, 0, left.stderr);
    assert.match(left.stdout, shownHere(/~\/\.config\/opencode\/opencode\.jsonc is not valid JSON: agentmash is still in it/));
    assert.match(left.stdout, shownHere(/kept .*\.agentmash\/hooks/));
    assert.ok(fs.existsSync(path.join(n.hookDir, 'mcp_server.mjs')), 'what the file still runs is still there');
    assert.ok(!fs.existsSync(n.at.plugin), 'and the plugin, ours whole, is out');
  } finally {
    await server.close();
  }
});

test('a config file keeps its mode and its link: a private one stays private, a symlinked one a link, and nothing half-written is left', { skip: process.platform === 'win32' && 'POSIX modes and symlinks' }, async () => {
  const server = await startServer();
  try {
    const m = withOpencode({ config: null });
    // as stow or chezmoi leave it: a link into the person's dotfiles, private
    const dotfiles = path.join(m.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const target = path.join(dotfiles, 'opencode.jsonc');
    fs.writeFileSync(target, THEIRS, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    fs.symlinkSync(target, m.at.config);

    await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.ok(fs.lstatSync(m.at.config).isSymbolicLink(), 'still the link');
    assert.equal(mode(target), 0o600);
    assert.ok(mcpOf(target).agentmash, 'ours went into what it points at');
    for (const dir of [m.at.dir, dotfiles, path.dirname(m.at.plugin)]) {
      assert.deepEqual(fs.readdirSync(dir).filter((f) => /tmp/.test(f)), [], `no temporary file left in ${dir}`);
    }

    await run(['logout'], m.env);
    assert.ok(fs.lstatSync(m.at.config).isSymbolicLink());
    assert.equal(read(target), THEIRS);
    assert.equal(mode(target), 0o600);
  } finally {
    await server.close();
  }
});

test('a server or a plugin of somebody else that goes by our name is never touched', async () => {
  const server = await startServer();
  try {
    const theirs = '{\n  "mcp": {\n    "agentmash": { "type": "remote", "url": "https://agentmash.example/mcp" }\n  }\n}\n';
    const m = withOpencode({ config: theirs });
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.match(login.stdout, shownHere(/a server called agentmash is in ~\/\.config\/opencode\/opencode\.jsonc already, and not ours: left as it is/));
    assert.equal(read(m.at.config), theirs);
    await run(['logout'], m.env);
    assert.equal(read(m.at.config), theirs);

    const n = withOpencode();
    const own = 'export const AgentMash = async () => ({});\n';
    fs.writeFileSync(n.at.plugin, own);
    const skipped = await run(['login', '--server', server.url, '--no-open'], n.env);
    assert.match(skipped.stdout, shownHere(/OpenCode\s+skipped — ~\/\.config\/opencode\/plugin\/agentmash\.js is a plugin of somebody else's: left as it is/));
    assert.equal(read(n.at.plugin), own);
    assert.equal(read(n.at.config), THEIRS, 'and nothing else of OpenCode is written either');
    await run(['logout'], n.env);
    assert.equal(read(n.at.plugin), own);
  } finally {
    await server.close();
  }
});

test("an earlier login's server is brought up to date where it is, in whichever of OpenCode's files holds it", async () => {
  const server = await startServer();
  try {
    // OpenCode merges config.json, opencode.json and opencode.jsonc, the last winning
    const m = withOpencode({ config: '{\n  "theme": "tokyonight"\n}' });
    const json = path.join(m.at.dir, 'opencode.json');
    const old = { type: 'local', command: ['node', '/Users/someone/.agentmash/hooks/mcp_server.mjs'], enabled: true };
    const before = `{\n  "mcp": {\n    "sentry": { "type": "local", "command": ["npx", "sentry-mcp"] },\n    "agentmash": ${JSON.stringify(old)}\n  }\n}\n`;
    fs.writeFileSync(json, before);
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.match(login.stdout, /OpenCode\s+connected/);
    assert.deepEqual(mcpOf(json).agentmash, opencodeServer(m.hookDir));
    assert.deepEqual(Object.keys(mcpOf(json)), ['sentry', 'agentmash'], 'where it was');
    assert.equal(read(m.at.config), '{\n  "theme": "tokyonight"\n}', 'and not a second one beside it');
    await run(['logout'], m.env);
    assert.equal(read(json), '{\n  "mcp": {\n    "sentry": { "type": "local", "command": ["npx", "sentry-mcp"] }\n  }\n}\n');
    assert.equal(read(m.at.config), '{\n  "theme": "tokyonight"\n}');
  } finally {
    await server.close();
  }
});

test('ours comes out of a config OpenCode or the person rewrote since, and only ours', async () => {
  const server = await startServer();
  try {
    const m = withOpencode({ config: '{\n  "$schema": "https://opencode.ai/config.json"\n}' });
    await run(['login', '--server', server.url, '--no-open'], m.env);
    // OpenCode writes a .json back whole when its settings change (config.ts, updateGlobal); a person adds a server after ours
    const value = readJsonc(read(m.at.config)).value;
    value.mcp.github = { type: 'remote', url: 'https://api.githubcopilot.com/mcp/' };
    value.share = 'disabled';
    fs.writeFileSync(m.at.config, JSON.stringify(value, null, 2));
    await run(['logout'], m.env);
    assert.deepEqual(readJsonc(read(m.at.config)).value, {
      $schema: 'https://opencode.ai/config.json',
      mcp: { github: { type: 'remote', url: 'https://api.githubcopilot.com/mcp/' } },
      share: 'disabled',
    });
  } finally {
    await server.close();
  }
});

test('what login writes for OpenCode is the same every time, names no version, and is a plugin OpenCode can load', async () => {
  const dir = path.join(path.sep, 'home', 'someone', '.agentmash', 'hooks');
  const plugin = opencodePlugin(dir);
  assert.equal(plugin, opencodePlugin(dir));
  assert.doesNotMatch(plugin, /\d+\.\d+\.\d+/);
  assert.deepEqual(AGENTS.opencode.hooks(dir), AGENTS.opencode.hooks(dir));
  assert.deepEqual(AGENTS.opencode.hooks(dir)['tool.execute.before'], [
    path.join(dir, 'agent_hook.mjs'),
    'pre_edit',
    '--global',
    '--client',
    'opencode',
    '--dialect',
    'opencode',
    '--input',
    'native',
  ]);
  // one export, a function, and nothing it needs beyond node's own modules
  assert.deepEqual([...plugin.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['node:child_process']);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-opencode-')), 'agentmash.mjs');
  fs.writeFileSync(file, plugin);
  const loaded = await import(pathToFileURL(file).href);
  assert.deepEqual(Object.keys(loaded), ['AgentMash']);
  const hooks = await loaded.AgentMash({ directory: os.tmpdir() });
  assert.deepEqual(Object.keys(hooks).sort(), ['chat.message', 'dispose', 'event', 'tool.execute.after', 'tool.execute.before']);

  // logout keeps the hooks folder while any of these still names it
  const home = path.join(path.sep, 'h');
  const saved = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    const files = agentFiles({ ...agentPlaces(), home });
    for (const name of ['plugin/agentmash.js', 'opencode.jsonc', 'opencode.json', 'config.json']) {
      assert.ok(files.includes(path.join(home, '.config', 'opencode', ...name.split('/'))), name);
    }
  } finally {
    if (saved !== undefined) process.env.XDG_CONFIG_HOME = saved;
  }
});
