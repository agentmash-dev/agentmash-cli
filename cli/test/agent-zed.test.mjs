// Zed (cli/agents/zed.mjs): its agent has no hooks, so `npx agentmash login`
// gives it AgentMash's MCP server alone, in `context_servers` in Zed's user
// settings, and `npx agentmash logout` takes out exactly that. The settings
// are JSON with comments and trailing commas, and Zed writes its first one
// with both: every test here checks that not a byte of the person's moves.
// Every test runs in a home of its own (fixtures/machine.mjs), Zed's folder
// found there through HOME, XDG_CONFIG_HOME or APPDATA: nothing here may touch
// the real ~/.config/zed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENTS, agentFiles, agentPlaces } from '../tools.mjs';
import zed, { readJsonc, zedServer } from '../agents/zed.mjs';
import { machine, md5, run, startServer } from './fixtures/machine.mjs';

/** Zed's settings.json in a home, where Zed looks for it on this OS (machine() points XDG_CONFIG_HOME and APPDATA into the home). */
const settingsIn = (home) =>
  process.platform === 'win32'
    ? path.join(home, 'AppData', 'Roaming', 'Zed', 'settings.json')
    : path.join(home, '.config', 'zed', 'settings.json');

/** The settings Zed writes the first time (assets/settings/initial_user_settings.json at v1.22.0), with comments and trailing commas. */
const INITIAL = `// Zed settings
//
// For information on how to configure Zed, see the Zed
// documentation: https://zed.dev/docs/configuring-zed
//
// To see all of Zed's default settings without changing your
// custom settings, run \`zed: open default settings\` from the
// command palette (cmd-shift-p / ctrl-shift-p)
{
  "ui_font_size": 16,
  "buffer_font_size": 15,
  "theme": {
    "mode": "system",
    "light": "One Light",
    "dark": "One Dark",
  },
}
`;

/** The person's settings with a server of their own, tabs, and a comment beside it. */
const WITH_THEIRS = `{
\t"vim_mode": true,
\t"context_servers": {
\t\t"github": { "command": "github-mcp-server", "args": ["stdio"] } // mine
\t}
}
`;

/** A home with Zed set up in it (and no other agent), its settings `settings` (null: none yet). */
function zedMachine({ settings = INITIAL, with: names = [], scripts = {} } = {}) {
  const m = machine({ with: names, codex: false, cursor: false, copilot: false, scripts });
  const file = settingsIn(m.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (settings !== null) fs.writeFileSync(file, settings);
  return { ...m, settings: file, server: path.join(m.hookDir, 'mcp_server.mjs') };
}

const read = (file) => fs.readFileSync(file, 'utf8');
/** What a path looks like as the CLI shows it, as a pattern. */
const shownAs = (m, file) => `~${file.slice(m.home.length)}`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const ours = (m) => readJsonc(read(m.settings)).value.context_servers?.agentmash;

/** A stand-in for Zed's CLI where its installer links it, inside an app: `zed --version` as Zed 1.22.0 prints it. */
function zedCli(m, app = path.join(m.home, 'opt', 'Zed.app')) {
  const cli = path.join(app, 'Contents', 'MacOS', 'cli');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, `#!${process.execPath}\nif (process.argv[2] === '--version') console.log('Zed 1.22.0 – ${app}');\n`);
  fs.chmodSync(cli, 0o755);
  fs.symlinkSync(cli, path.join(m.env.AGENTMASH_TOOL_PATH, 'zed'));
}

test('login connects Zed: our MCP server after the person’s settings, their comments and trailing commas kept, and logout gives the file back byte for byte', async () => {
  const server = await startServer();
  const m = zedMachine();
  try {
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, new RegExp(`Zed\\s+connected\\s+${shownAs(m, m.settings)}`));
    assert.match(login.stdout, /Zed's agent has no hooks: it gets AgentMash's MCP tools only/);
    assert.match(login.stdout, /Zed asks before each agentmash tool call until you choose Always for it; login allows none/);

    const text = read(m.settings);
    assert.ok(text.startsWith(INITIAL.slice(0, INITIAL.lastIndexOf('},\n}'))), 'everything of theirs, up to the end of their last member, as it was');
    assert.ok(text.includes('// To see all of Zed\'s default settings'), 'their comments');
    assert.deepEqual(ours(m), { command: 'node', args: [m.server] });
    assert.deepEqual(zedServer(m.hookDir), { command: 'node', args: [m.server] });
    assert.ok(fs.existsSync(m.server), 'what the entry runs is there');
    // laid out as theirs are: two spaces a level, and a trailing comma after it as after theirs
    assert.ok(text.endsWith(`  },\n  "context_servers": {\n    "agentmash": {\n      "command": "node",\n      "args": [\n        ${JSON.stringify(m.server)}\n      ]\n    }\n  },\n}\n`), text);
    // no tool approved for the person, no other key touched
    const value = readJsonc(text).value;
    assert.deepEqual(Object.keys(value), ['ui_font_size', 'buffer_font_size', 'theme', 'context_servers']);
    assert.equal(value.agent, undefined);

    // login again: already, and not a byte different
    const before = md5(m.settings);
    const again = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Zed\s+already connected/);
    assert.equal(md5(m.settings), before);

    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(read(m.settings), INITIAL);
    assert.ok(!fs.existsSync(m.hookDir), 'nothing left that runs the scripts, so they go');
  } finally {
    await server.close();
  }
});

test('a server of the person’s stays where it is, ours goes after it in their layout, and logout takes out ours alone', async () => {
  const server = await startServer();
  const m = zedMachine({ settings: WITH_THEIRS });
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const text = read(m.settings);
    assert.ok(text.startsWith(`{\n\t"vim_mode": true,\n\t"context_servers": {\n\t\t"github": { "command": "github-mcp-server", "args": ["stdio"] }, // mine\n\t\t"agentmash": {\n\t\t\t"command": "node",`), text);
    assert.deepEqual(Object.keys(readJsonc(text).value.context_servers), ['github', 'agentmash']);
    await run(['logout'], m.env);
    assert.equal(read(m.settings), WITH_THEIRS);
  } finally {
    await server.close();
  }
});

test('ours switched off in Zed stays off through a login that points it at another hooks folder', async () => {
  const server = await startServer();
  const before = `{\n  "context_servers": {\n    "agentmash": {\n      "enabled": false,\n      "command": "node",\n      "args": ["/old/.agentmash/hooks/mcp_server.mjs"]\n    }\n  }\n}\n`;
  const m = zedMachine({ settings: before });
  try {
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.match(login.stdout, /Zed\s+connected/);
    assert.match(login.stdout, /agentmash is switched off in Zed's agent panel: left off/);
    assert.deepEqual(ours(m), { enabled: false, command: 'node', args: [m.server] });
    const again = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.match(again.stdout, /Zed\s+already connected/);
    assert.match(again.stdout, /switched off in Zed's agent panel: left off/);
    await run(['logout'], m.env);
    assert.ok(!fs.existsSync(m.settings), 'it held only ours: login made nothing of the person’s, and logout leaves nothing');
  } finally {
    await server.close();
  }
});

test('with no settings.json yet, login makes one holding only our server, private, and logout takes it away', async () => {
  const server = await startServer();
  const m = zedMachine({ settings: null });
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.deepEqual(JSON.parse(read(m.settings)), { context_servers: { agentmash: { command: 'node', args: [m.server] } } });
    if (process.platform !== 'win32') assert.equal(fs.statSync(m.settings).mode & 0o777, 0o600);
    await run(['logout'], m.env);
    assert.ok(!fs.existsSync(m.settings));
    assert.ok(fs.existsSync(path.dirname(m.settings)), "Zed's folder stays");
  } finally {
    await server.close();
  }
});

test('settings Zed cannot read, or an agentmash that is not ours: login skips Zed and says why, and the file is left as it was', async () => {
  const server = await startServer();
  try {
    const broken = '{\n  "ui_font_size": 16,,\n}\n';
    const m = zedMachine({ settings: broken });
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, new RegExp(`Zed\\s+skipped — ${shownAs(m, m.settings)} could not be read as Zed reads it \\(not JSON at character \\d+\\): left as it was`));
    assert.equal(read(m.settings), broken);

    const theirs = '{ "context_servers": { "agentmash": { "command": "npx", "args": ["agentmash-mcp"] } } }\n';
    const t = zedMachine({ settings: theirs });
    const taken = await run(['login', '--server', server.url, '--no-open'], t.env);
    assert.match(taken.stdout, /Zed\s+skipped — a server called agentmash is in .* already, and not ours: left as it is/);
    await run(['logout'], t.env);
    assert.equal(read(t.settings), theirs, 'logout leaves somebody else’s agentmash alone');

    const shape = '{ "context_servers": [] }\n';
    const s = zedMachine({ settings: shape });
    assert.match((await run(['login', '--server', server.url, '--no-open'], s.env)).stdout, /Zed\s+skipped — "context_servers" in .* is not an object: left as it is/);
    assert.equal(read(s.settings), shape);
  } finally {
    await server.close();
  }
});

test('settings broken after login: doctor says so, and logout names the file and keeps the scripts its server runs', async () => {
  const server = await startServer();
  const m = zedMachine();
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    fs.writeFileSync(m.settings, read(m.settings).replace('"ui_font_size": 16,', '"ui_font_size": 16,,'));
    const broken = read(m.settings);

    const doctor = await run(['doctor'], m.env, m.home);
    assert.match(doctor.stdout, new RegExp(`Zed: ${shownAs(m, m.settings)} is not valid JSON`));

    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`${shownAs(m, m.settings)} is not valid JSON: agentmash is still in it`));
    assert.match(out.stdout, /kept .*\.agentmash[\\/]hooks/);
    assert.ok(fs.existsSync(m.server), 'what Zed may still start is still there');
    assert.equal(read(m.settings), broken);
  } finally {
    await server.close();
  }
});

test('doctor says Zed is connected and has its MCP server, and that a missing server script is a server that never starts', async () => {
  const server = await startServer();
  const m = zedMachine();
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const doctor = await run(['doctor'], m.env, m.home);
    assert.match(doctor.stdout, new RegExp(`Zed: [^\\n]*${shownAs(m, m.settings)}`));
    assert.match(doctor.stdout, /Zed: [^\n]*MCP server/);
    assert.doesNotMatch(doctor.stdout, /✗ Zed/);

    fs.rmSync(m.server);
    const broken = await run(['doctor'], m.env, m.home);
    assert.match(broken.stdout, /✗ Zed: runs .*mcp_server\.mjs, which does not exist/);
    assert.equal(broken.code, 1);
  } finally {
    await server.close();
  }
});

test('tools finds Zed by its folder, its app or a zed command that is Zed’s (not the ZFS daemon of that name), and adds or removes it', { skip: process.platform === 'win32' && 'symlinks' }, async () => {
  // a `zed` that is not Zed, and nothing else of Zed's
  const zfs = machine({ with: ['zed'], codex: false, cursor: false, copilot: false, scripts: { zed: "console.log('zed (ZFS Event Daemon) 2.3.4');" } });
  assert.match((await run(['tools'], zfs.env)).stdout, /zed\s+Zed\s+not found\s+not connected/);

  // its command, linked into its app where the app is not where apps go
  const cli = machine({ with: [], codex: false, cursor: false, copilot: false });
  zedCli(cli);
  assert.match((await run(['tools'], cli.env)).stdout, /zed\s+Zed\s+found · Zed 1\.22\.0[^\n]*not connected/);

  if (process.platform === 'darwin') {
    // the app alone, in the applications folder
    const app = machine({ with: [], codex: false, cursor: false, copilot: false });
    fs.mkdirSync(path.join(app.env.AGENTMASH_APPS_DIR, 'Zed Preview.app'), { recursive: true });
    assert.match((await run(['tools'], app.env)).stdout, /zed\s+Zed\s+found\s+not connected/);
  }

  const m = zedMachine();
  zedCli(m);
  const add = await run(['tools', 'add', 'zed'], m.env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /Zed\s+connected/);
  assert.match((await run(['tools'], m.env)).stdout, /zed\s+Zed\s+found · Zed 1\.22\.0[^\n]*\s+connected/);
  assert.deepEqual(ours(m), { command: 'node', args: [m.server] });

  const remove = await run(['tools', 'remove', 'zed'], m.env);
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /Zed\s+disconnected/);
  assert.equal(read(m.settings), INITIAL);
  assert.match((await run(['tools'], m.env)).stdout, /zed\s+Zed\s+found · Zed 1\.22\.0[^\n]*not connected/);
});

test('a symlinked settings.json stays a link, its mode stays, and nothing half-written is left about', { skip: process.platform === 'win32' && 'POSIX modes and symlinks' }, async () => {
  const server = await startServer();
  const m = zedMachine({ settings: null });
  try {
    const dotfiles = path.join(m.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const linked = path.join(dotfiles, 'zed-settings.json');
    fs.writeFileSync(linked, INITIAL, { mode: 0o640 });
    fs.chmodSync(linked, 0o640);
    fs.symlinkSync(linked, m.settings);

    await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.ok(fs.lstatSync(m.settings).isSymbolicLink(), 'still the link');
    assert.ok(readJsonc(read(linked)).value.context_servers.agentmash, 'ours went into what it points at');
    assert.equal(fs.statSync(linked).mode & 0o777, 0o640);
    for (const dir of [dotfiles, path.dirname(m.settings)]) {
      assert.deepEqual(fs.readdirSync(dir).filter((f) => /tmp/.test(f)), [], `no temporary file left in ${dir}`);
    }

    await run(['logout'], m.env);
    assert.ok(fs.lstatSync(m.settings).isSymbolicLink());
    assert.equal(read(linked), INITIAL);
    assert.equal(fs.statSync(linked).mode & 0o777, 0o640);
  } finally {
    await server.close();
  }
});

test('the module: an agent like the others, with no hooks, every file it writes named for logout, and the same entry every run', () => {
  assert.equal(AGENTS.zed, zed);
  assert.equal(zed.mcpOnly, true);
  assert.ok(Object.values(AGENTS).filter((a) => !a.mcpOnly).every((a) => a.order < zed.order), 'after every agent with hooks');
  assert.deepEqual(zed.hooks('/h/.agentmash/hooks'), zed.hooks('/h/.agentmash/hooks'));
  assert.doesNotMatch(JSON.stringify(zed.hooks('/h/.agentmash/hooks')), /\d+\.\d+\.\d+/, 'nothing that changes between releases');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-zed-files-')));
  const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, APPDATA: process.env.APPDATA, FLATPAK_XDG_CONFIG_HOME: process.env.FLATPAK_XDG_CONFIG_HOME };
  try {
    delete process.env.FLATPAK_XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
    assert.ok(agentFiles({ ...agentPlaces(), home }).includes(settingsIn(home)));
    // nothing there: nothing found, nothing connected, nothing to take out
    const places = { home, toolPath: '', apps: null };
    assert.equal(zed.detect(places).found, false);
    assert.deepEqual(zed.inspect(places), { connected: false, invalid: false, where: `~${settingsIn(home).slice(home.length)}`, events: [], missing: [], mcp: false });
    assert.equal(zed.disconnect(places).status, 'absent');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readJsonc reads what Zed reads: comments, trailing commas and a byte order mark, and nothing more', () => {
  assert.deepEqual(readJsonc('\uFEFF/* a */ { "a": [1, 2,], // b\n "c": { "d": null, }, }').value, { a: [1, 2], c: { d: null } });
  for (const bad of ['{ "a": 1,, }', '{ a: 1 }', "{ 'a': 1 }", '{ "a": 0x1 }', '[1]', '{ "a": 1 } x', '{ "a": "\u0001" }', '{ /* open']) {
    assert.throws(() => readJsonc(bad), SyntaxError, bad);
  }
});

/** connect, then disconnect, on settings in a home of its own, straight through the module: what each left (null: no file). */
function roundTrip(settings) {
  const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, APPDATA: process.env.APPDATA, FLATPAK_XDG_CONFIG_HOME: process.env.FLATPAK_XDG_CONFIG_HOME };
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-zed-shape-')));
  const places = { home, toolPath: '', apps: null };
  const hookDir = path.join(home, '.agentmash', 'hooks');
  const file = settingsIn(home);
  const text = () => (fs.existsSync(file) ? read(file) : null);
  try {
    delete process.env.FLATPAK_XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (settings !== null) fs.writeFileSync(file, settings);
    const connect = zed.connect(places, hookDir);
    const added = text();
    const again = zed.connect(places, hookDir).status;
    const disconnect = zed.disconnect(places).status;
    return { connect, added, again, disconnect, after: text(), server: path.join(hookDir, 'mcp_server.mjs') };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('each way a person may write settings.json: ours goes in laid out as theirs, and comes out to the byte', () => {
  const shapes = {
    'tabs and comments after values': ['{\n\t"ui_font_size": 16, // big\n\t"vim_mode": true // yes\n}', '\t"vim_mode": true, // yes\n\t"context_servers": {\n\t\t"agentmash": {\n\t\t\t"command": "node",'],
    'an object on one line': ['{ "ui_font_size": 16, "vim_mode": true }\n', '"vim_mode": true, "context_servers": {"agentmash":{"command":"node","args":['],
    'empty braces with no line break after': ['{}', '{\n  "context_servers": {\n    "agentmash": {'],
    'a comment after the opening brace': ['{ // nothing yet\n}\n', '{ // nothing yet\n  "context_servers": {'],
    'their server with a comment and a trailing comma': [WITH_THEIRS.replace('] } // mine\n', '] }, // mine\n\t\t"local": { "command": "x" },\n'), '\t\t"local": { "command": "x" },\n\t\t"agentmash": {\n\t\t\t"command": "node",'],
    'CRLF line breaks': ['{\r\n  "ui_font_size": 16\r\n}\r\n', '"context_servers"'],
    'block comments': ['/* top */ {\n  "a": 1 /* one */\n}\n', '"a": 1, /* one */\n  "context_servers": {'],
  };
  for (const [shape, [settings, expect]] of Object.entries(shapes)) {
    const r = roundTrip(settings);
    assert.equal(r.connect.status, 'connected', `${shape}: ${r.connect.why}`);
    assert.ok(r.added.includes(expect), `${shape}:\n${r.added}`);
    assert.deepEqual(readJsonc(r.added).value.context_servers.agentmash, { command: 'node', args: [r.server] }, shape);
    assert.equal(r.again, 'already', shape);
    assert.equal(r.disconnect, 'removed', shape);
    assert.equal(r.after, settings, shape);
  }
  // no file: one made with ours alone, gone again at logout
  const none = roundTrip(null);
  assert.equal(none.connect.status, 'connected');
  assert.equal(none.after, null);
});

test('ours with a command the person changed (a full path to node) is already connected, and kept as they wrote it', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-zed-mine-')));
  const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, APPDATA: process.env.APPDATA, FLATPAK_XDG_CONFIG_HOME: process.env.FLATPAK_XDG_CONFIG_HOME };
  try {
    delete process.env.FLATPAK_XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
    const places = { home, toolPath: '', apps: null };
    const hookDir = path.join(home, '.agentmash', 'hooks');
    const file = settingsIn(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const mine = `{\n  "context_servers": {\n    "agentmash": { "command": "/opt/node/bin/node", "args": [${JSON.stringify(path.join(hookDir, 'mcp_server.mjs'))}] }\n  }\n}\n`;
    fs.writeFileSync(file, mine);
    assert.equal(zed.connect(places, hookDir).status, 'already');
    assert.equal(read(file), mine);
    // for another hooks folder: the new script, and still their node
    const other = path.join(home, 'elsewhere', '.agentmash', 'hooks');
    assert.equal(zed.connect(places, other).status, 'connected');
    assert.deepEqual(readJsonc(read(file)).value.context_servers.agentmash, { command: '/opt/node/bin/node', args: [path.join(other, 'mcp_server.mjs')] });
    assert.equal(zed.disconnect(places).status, 'removed');
    assert.ok(!fs.existsSync(file));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
