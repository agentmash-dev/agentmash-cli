// What every agent's file is written with (cli/agent-kit.mjs writeFileSafely):
// the first time agentmash writes a file of the person's, what it held is
// kept beside it as <file>.before-agentmash, once, with its mode, and never
// for a file that is ours already. A file that holds a sign-in is never
// copied and never written. Every test works in a folder of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BEFORE, holdsSignIn, removeFile, shown, writeFileSafely } from '../agent-kit.mjs';
import { AGENTS } from '../tools.mjs';
import { CLEARED, machine, run, startServer } from './fixtures/machine.mjs';

const POSIX = { skip: process.platform === 'win32' ? 'POSIX modes and symlinks' : false };
const folder = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-')));
const read = (file) => fs.readFileSync(file, 'utf8');
const mode = (file) => fs.statSync(file).mode & 0o777;

test("the first write to a person's file keeps what it held beside it, once, and a later write keeps that copy", () => {
  const dir = folder();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{ "model": "opus" }\n');
  writeFileSafely(file, '{ "model": "opus", "hooks": {} }\n');
  assert.equal(BEFORE, '.before-agentmash');
  assert.equal(read(`${file}${BEFORE}`), '{ "model": "opus" }\n', 'what was there before');
  assert.equal(read(file), '{ "model": "opus", "hooks": {} }\n');
  // the person changes it, and agentmash writes again: the copy is still what was there before agentmash
  fs.writeFileSync(file, '{ "model": "sonnet" }\n');
  writeFileSafely(file, '{ "model": "sonnet", "hooks": {} }\n');
  assert.equal(read(`${file}${BEFORE}`), '{ "model": "opus" }\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['settings.json', `settings.json${BEFORE}`], 'and nothing else, no temporary file');
});

test('no copy of a file that was not there, that runs our hooks already, or that is ours by its place', () => {
  const dir = folder();
  // made here: nothing was there before agentmash
  const made = path.join(dir, 'mcp.json');
  writeFileSafely(made, '{}\n');
  // one an earlier run wired: a command in it runs a script from ~/.agentmash/hooks, written with a Windows
  // path's backslashes doubled too, as JSON and TOML write them
  const wired = path.join(dir, 'hooks.json');
  fs.writeFileSync(wired, JSON.stringify({ hooks: { Stop: [{ command: 'node /home/me/.agentmash/hooks/stop.mjs' }] } }));
  writeFileSafely(wired, '{}\n');
  const windows = path.join(dir, 'settings.json');
  fs.writeFileSync(windows, JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'node C:\\Users\\me\\.agentmash\\hooks\\stop.mjs' }] }] } }));
  assert.match(read(windows), /\\\\\.agentmash\\\\hooks\\\\/, 'the fixture has the doubled backslashes');
  writeFileSafely(windows, '{}\n');
  const toml = path.join(dir, 'config.toml');
  fs.writeFileSync(toml, '[mcp_servers.agentmash]\ncommand = "node"\nargs = ["C:\\\\Users\\\\me\\\\.agentmash\\\\hooks\\\\mcp_server.mjs"]\n');
  writeFileSafely(toml, '');
  // ours by its place: named after agentmash (Amp's plugin, the stub logout leaves of it), or in a .agentmash folder
  const stub = path.join(dir, 'agentmash.ts');
  fs.writeFileSync(stub, '// agentmash: taken out by `npx agentmash logout`\n');
  writeFileSafely(stub, 'export default function () {}\n');
  const named = path.join(dir, 'agentmash.json');
  fs.writeFileSync(named, '{}\n');
  writeFileSafely(named, '{ "hooks": {} }\n');
  const home = path.join(dir, '.agentmash', 'hooks');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'lib.mjs'), 'export {};\n');
  writeFileSafely(path.join(home, 'lib.mjs'), 'export const v = 2;\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.agentmash', 'agentmash.json', 'agentmash.ts', 'config.toml', 'hooks.json', 'mcp.json', 'settings.json']);
  assert.deepEqual(fs.readdirSync(home), ['lib.mjs']);
});

test("a file that names agentmash but runs none of our hooks is still the person's: what it held is kept", () => {
  const dir = folder();
  // Claude Code's settings after the crew's install (claude plugin marketplace add agentmash-dev/agentmash-crew)
  const claude = path.join(dir, 'settings.json');
  const crew = `${JSON.stringify(
    {
      enabledPlugins: { 'agentmash-crew@agentmash-crew': true },
      extraKnownMarketplaces: { 'agentmash-crew': { source: { source: 'github', repo: 'agentmash-dev/agentmash-crew' } } },
    },
    null,
    2
  )}\n`;
  fs.writeFileSync(claude, crew);
  // Codex trusting a checkout of ours, and an MCP server of the person's with our name in it
  const codex = path.join(dir, 'config.toml');
  fs.writeFileSync(codex, '[projects."/home/me/code/agentmash"]\ntrust_level = "trusted"\n');
  const mcp = path.join(dir, 'mcp.json');
  fs.writeFileSync(mcp, '{ "mcpServers": { "agentmash-notes": { "command": "npx", "args": ["notes-server"] } } }\n');
  const before = new Map([claude, codex, mcp].map((f) => [f, read(f)]));
  for (const file of before.keys()) writeFileSafely(file, `${read(file)}\n`);
  for (const [file, text] of before) assert.equal(read(`${file}${BEFORE}`), text, path.basename(file));
});

test('a file that holds a sign-in is never written, never copied and never removed', () => {
  const dir = folder();
  // Claude Code's ~/.claude.json can hold a key, Qwen Code reads one from ~/.qwen/.env, and .netrc (_netrc on Windows) holds passwords
  const names = ['auth.json', '.credentials.json', 'credentials.json', 'oauth_creds.json', 'google_accounts.json', 'secrets.yaml', 'id.key'];
  for (const name of [...names, '.claude.json', '.env', '.netrc', '_netrc']) {
    const file = path.join(dir, name);
    assert.ok(holdsSignIn(file), name);
    fs.writeFileSync(file, '{ "token": "theirs" }\n');
    assert.throws(() => writeFileSafely(file, '{}\n'), /holds a sign-in: agentmash never writes it/, name);
    removeFile(file, '{}\n');
    assert.equal(read(file), '{ "token": "theirs" }\n', `${name} as it was`);
    assert.ok(!fs.existsSync(`${file}${BEFORE}`), `${name} never copied`);
  }
  // nor one made where there was none
  assert.throws(() => writeFileSafely(path.join(dir, 'new', 'auth.json'), '{}\n'));
  assert.ok(!fs.existsSync(path.join(dir, 'new')));
  for (const name of ['settings.json', 'config.toml', 'mcp.json', 'hooks.json', 'opencode.jsonc', 'crush.json', 'mcp_config.json', 'config.yaml']) {
    assert.ok(!holdsSignIn(path.join(dir, name)), `${name} is settings`);
  }
});

test("the README says what a copy holds: whatever the file held, a token in a settings file too, and logout leaves it", () => {
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(
    readme,
    /kept beside it as `<file>\.before-agentmash`, with its mode, and logout leaves it there: it holds whatever the file held, tokens and keys included\./
  );
  assert.match(readme, /An agent's own sign-in file \(`auth\.json`, `\.credentials\.json` and the like\) is never written, copied or removed\./);
  assert.doesNotMatch(readme, /a file that holds a sign-in \(`auth\.json`, `\.credentials\.json` and the like\) is never copied/, 'never that no secret is copied');
  // and the settings a copy is made of can hold one: Qwen Code's, with an MCP server's token in it
  const settings = path.join(folder(), 'settings.json');
  fs.writeFileSync(settings, '{ "mcpServers": { "github": { "env": { "GITHUB_TOKEN": "theirs" } } } }\n');
  assert.ok(!holdsSignIn(settings));
  writeFileSafely(settings, '{}\n');
  assert.match(read(`${settings}${BEFORE}`), /"GITHUB_TOKEN": "theirs"/);
});

test('the copy keeps the mode of a private file, and a symlinked file is copied beside the link, from what it points at', POSIX, () => {
  const dir = folder();
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, 'model = "o3"\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  writeFileSafely(file, 'model = "o3"\n[mcp_servers.agentmash]\n');
  assert.equal(mode(`${file}${BEFORE}`), 0o600, 'as private as the file it came from');
  assert.equal(mode(file), 0o600);

  const dotfiles = path.join(dir, 'dotfiles');
  fs.mkdirSync(dotfiles);
  fs.writeFileSync(path.join(dotfiles, 'settings.json'), '{ "theme": "dark" }\n');
  const link = path.join(dir, 'settings.json');
  fs.symlinkSync(path.join(dotfiles, 'settings.json'), link);
  writeFileSafely(link, '{ "theme": "dark", "hooks": {} }\n');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link stays a link');
  assert.equal(read(`${link}${BEFORE}`), '{ "theme": "dark" }\n');
  assert.ok(!fs.lstatSync(`${link}${BEFORE}`).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(dotfiles), ['settings.json'], 'nothing written into the dotfiles');
});

test("no copy where it would land in the person's dotfiles: an agent's folder that is a link, as stow folds one", () => {
  const home = folder();
  const dotfiles = path.join(home, 'dotfiles');
  // a junction on Windows, which needs no rights a symlink does
  const links = [];
  const link = (to, at) => {
    fs.symlinkSync(to, at, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(at);
  };
  const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    assert.equal(os.homedir(), home);
    // ~/.config/zed is the link: the file is in their dotfiles, and a copy beside it would be too
    fs.mkdirSync(path.join(dotfiles, 'zed'), { recursive: true });
    fs.writeFileSync(path.join(dotfiles, 'zed', 'settings.json'), '{ "theme": "dark" }\n');
    fs.mkdirSync(path.join(home, '.config'));
    link(path.join(dotfiles, 'zed'), path.join(home, '.config', 'zed'));
    writeFileSafely(path.join(home, '.config', 'zed', 'settings.json'), '{ "theme": "dark", "context_servers": {} }\n');
    assert.equal(read(path.join(dotfiles, 'zed', 'settings.json')), '{ "theme": "dark", "context_servers": {} }\n', 'written all the same');
    assert.deepEqual(fs.readdirSync(path.join(dotfiles, 'zed')), ['settings.json'], 'and nothing beside it in the dotfiles');
    // ~/.junie is the link, a folder above the file's own
    fs.mkdirSync(path.join(dotfiles, 'junie', 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(dotfiles, 'junie', 'mcp', 'mcp.json'), '{ "mcpServers": {} }\n');
    link(path.join(dotfiles, 'junie'), path.join(home, '.junie'));
    writeFileSafely(path.join(home, '.junie', 'mcp', 'mcp.json'), '{ "mcpServers": { "theirs": {} } }\n');
    assert.deepEqual(fs.readdirSync(path.join(dotfiles, 'junie', 'mcp')), ['mcp.json']);
    // a folder of their own, no link: the copy beside the file, as ever
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "o3"\n');
    writeFileSafely(path.join(home, '.codex', 'config.toml'), 'model = "o3"\n[mcp_servers.theirs]\n');
    assert.equal(read(path.join(home, '.codex', `config.toml${BEFORE}`)), 'model = "o3"\n');
  } finally {
    for (const [key, value] of Object.entries(was)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // the links only, never what they point at
    for (const at of links) (process.platform === 'win32' ? fs.rmdirSync : fs.unlinkSync)(at);
  }
});

test("login keeps what each agent's file held before it, and logout leaves those copies; a sign-in file is never touched", async () => {
  const server = await startServer();
  // Codex and Cursor with the person's files, Zed's settings as Zed first writes them, and Codex's sign-in beside them
  const m = machine({ copilot: false });
  const zed =
    process.platform === 'win32' ? path.join(m.home, 'AppData', 'Roaming', 'Zed', 'settings.json') : path.join(m.home, '.config', 'zed', 'settings.json');
  fs.mkdirSync(path.dirname(zed), { recursive: true });
  fs.writeFileSync(zed, '// Zed settings\n{\n  "ui_font_size": 16,\n}\n');
  const auth = path.join(m.home, '.codex', 'auth.json');
  fs.writeFileSync(auth, '{ "OPENAI_API_KEY": null, "tokens": { "access_token": "theirs" } }\n');
  const files = [
    path.join(m.home, '.claude', 'settings.json'),
    path.join(m.home, '.codex', 'hooks.json'),
    path.join(m.home, '.codex', 'config.toml'),
    path.join(m.home, '.cursor', 'hooks.json'),
    path.join(m.home, '.cursor', 'mcp.json'),
    zed,
  ];
  const before = new Map(files.map((f) => [f, read(f)]));
  const authBefore = fs.statSync(auth);
  try {
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(login.code, 0, login.stderr);
    for (const file of files) {
      assert.notEqual(read(file), before.get(file), `${file} has agentmash in it now`);
      assert.equal(read(`${file}${BEFORE}`), before.get(file), `${file}: what it held before is kept beside it`);
    }
    const agentmashHome = path.join(m.home, '.agentmash');
    assert.ok(!fs.readdirSync(agentmashHome, { recursive: true }).some((f) => String(f).endsWith(BEFORE)), 'nothing of ours in ~/.agentmash is copied');
    // signing in again keeps those copies as they are
    assert.equal((await run(['login', '--server', server.url, '--no-open'], m.env)).code, 0);
    for (const file of files) assert.equal(read(`${file}${BEFORE}`), before.get(file), file);

    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    for (const file of files) assert.equal(read(`${file}${BEFORE}`), before.get(file), `${file}: kept after logout`);
    // the sign-in: not a byte changed, never written, never copied
    assert.equal(read(auth), '{ "OPENAI_API_KEY": null, "tokens": { "access_token": "theirs" } }\n');
    assert.equal(fs.statSync(auth).mtimeMs, authBefore.mtimeMs);
    assert.ok(!fs.existsSync(`${auth}${BEFORE}`));
  } finally {
    await server.close();
  }
});

// On Windows the hooks folder is C:\Users\…\.agentmash\hooks, and JSON, a YAML
// double-quoted string and a plugin's JSON.stringify write each backslash of
// it twice. What looks for ours in a file's text has to find it written that
// way too: it did not, so on Windows login again called our own OpenCode and
// Kilo plugins somebody else's and logout left them, and logout said nothing
// of a broken file that still held ours. Run with such a folder on every OS.
test("a Windows hooks folder is ours in a file's text as JSON writes it: login again, inspect and logout all find it", () => {
  const hookDir = 'C:\\Users\\bob\\.agentmash\\hooks';
  const saved = Object.fromEntries([...CLEARED, 'APPDATA'].map((k) => [k, process.env[k]]));
  const machineFor = () => {
    const home = folder();
    for (const k of CLEARED) delete process.env[k];
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
    // Continue is connected only where it has a config.yaml (its own first one)
    fs.mkdirSync(path.join(home, '.continue'));
    fs.writeFileSync(path.join(home, '.continue', 'config.yaml'), 'name: Local Agent\nversion: 1.0.0\nschema: v1\n');
    fs.mkdirSync(path.join(home, '.codex'));
    return { home, toolPath: '', apps: null, codex: path.join(home, '.codex') };
  };
  try {
    for (const id of ['opencode', 'kilo', 'continue']) {
      const places = machineFor();
      const agent = AGENTS[id];
      assert.equal(agent.connect(places, hookDir).status, 'connected', id);
      assert.equal(agent.connect(places, hookDir).status, 'already', `${id}: ours, not somebody else's`);
      assert.equal(agent.inspect(places).connected, true, id);
      assert.equal(agent.disconnect(places).status, 'removed', id);
      assert.equal(agent.inspect(places).connected, false, `${id}: all of it out`);
    }
    // a file login wrote ours into, broken by hand since: logout says ours is still in it
    const broken = [['amp', 'settings'], ['antigravity', 'hooks'], ['junie', 'mcp'], ['zed', 'settings'], ['continue', 'config'], ['codex', 'config']];
    for (const [id, key] of broken) {
      const places = machineFor();
      const agent = AGENTS[id];
      assert.equal(agent.connect(places, hookDir).status, 'connected', id);
      const file = agent.files(places)[key];
      if (id === 'continue') fs.appendFileSync(file, '---\nname: second\n');
      else if (id === 'codex') fs.appendFileSync(file, '\n[[[ broken\n'); // TOML, not JSON
      else fs.writeFileSync(file, read(file).replace(/\}\s*$/, ',,}\n'));
      assert.deepEqual(agent.disconnect(places, hookDir).invalid, [shown(file, places)], id);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
