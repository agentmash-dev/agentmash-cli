// Amp (cli/agents/amp.mjs): `npx agentmash login` puts AgentMash's plugin in
// Amp's plugins folder and its MCP server in Amp's user settings, beside the
// person's own; logout takes exactly that out again. Every test runs in a home
// of its own (fixtures/machine.mjs), with Amp's command a stand-in on the tool
// path and XDG_CONFIG_HOME inside that home: nothing here may touch the real
// ~/.config/amp.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, agentFiles, agentPlaces } from '../tools.mjs';
import { ampPlugin, scanJsonc } from '../agents/amp.mjs';
import { CLI_DIR, json, machine, md5, run, shownHere, startServer } from './fixtures/machine.mjs';

const PLUGIN_SOURCE = path.join(CLI_DIR, '..', 'clients', 'amp', 'plugin.mjs');
const source = () => fs.readFileSync(PLUGIN_SOURCE, 'utf8');
const UNSET_LINE = 'const HOOKS_DIR = null; // agentmash:hooks-dir';

/** What `amp --version` prints (npm @ampcode/cli and the Homebrew formula, 2026-10-04). */
const AMP_STANDIN = `if (process.argv[2] === '--version') console.log('0.0.1791146283-g5c3f72 (released 2026-10-04T20:38:00.000Z, 1h ago)');`;

/** The person's settings, laid out as Amp's docs lay them out: tabs, the schema, a server of their own. */
const THEIRS = `{
\t"$schema": "https://ampcode.com/cli-settings.schema.json",
\t"amp.showCosts": false,
\t"amp.mcpServers": {
\t\t"postgres": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/app"] }
\t},
\t"amp.notifications.enabled": true
}
`;
/** The same as JSON with comments and a trailing comma, which Amp reads, and no servers of their own. */
const THEIRS_JSONC = `{
\t// the person's own
\t"amp.showCosts": false, /* keep */
\t"amp.tools.disable": ["painter"],
}
`;
/** A plugin of the person's own, beside ours. */
const MINE = "export default function (amp) {\n\tamp.on('agent.end', () => {})\n}\n";

/** A home with Amp in it: its command on the tool path, its folder with `settings` (null: none) and a plugin of theirs. */
function ampMachine({ settings = THEIRS, file = 'settings.json', bin = true } = {}) {
  const m = machine({ with: bin ? ['amp'] : [], codex: false, cursor: false, copilot: false, scripts: { amp: AMP_STANDIN } });
  const dir = path.join(m.home, '.config', 'amp');
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'mine.ts'), MINE);
  if (settings !== null) fs.writeFileSync(path.join(dir, file), settings);
  return { ...m, dir, plugin: path.join(dir, 'plugins', 'agentmash.ts'), settings: path.join(dir, file) };
}

const read = (file) => fs.readFileSync(file, 'utf8');
const serverEntry = (m) => ({ command: 'node', args: [path.join(m.hookDir, 'mcp_server.mjs')] });
/** Our server as login writes it into the person's settings: one line, after theirs. */
const ourMember = (m) => `"agentmash": { "command": "node", "args": [${JSON.stringify(path.join(m.hookDir, 'mcp_server.mjs'))}] }`;

test('login connects Amp: our plugin beside theirs, and our MCP server after theirs, and not a byte of theirs moved', async () => {
  const server = await startServer();
  const m = ampMachine();
  try {
    const result = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, shownHere(/Amp\s+connected\s+~\/\.config\/amp\/plugins\/agentmash\.ts/));
    assert.match(result.stdout, /Amp loads the plugin when it next starts; in an Amp already running: Ctrl\+O, then plugins: reload/);
    assert.match(result.stdout, /refusing its first edit of a file a teammate's agent is in; the same edit again goes through/);

    // the plugin: the source as it ships, with its one line naming this machine's hooks folder
    const plugin = read(m.plugin);
    assert.equal(plugin, source().replace(UNSET_LINE, `const HOOKS_DIR = ${JSON.stringify(m.hookDir)}; // agentmash:hooks-dir`));
    assert.equal(plugin.split('\n')[0], '// @i-know-the-amp-plugin-api-is-wip-and-very-experimental-right-now');
    if (process.platform !== 'win32') assert.equal(fs.statSync(m.plugin).mode & 0o777, 0o644);
    // and the scripts it runs, where it says they are
    for (const script of ['agent_hook.mjs', 'lib.mjs', 'pre_tool_use.mjs', path.join('dialects', 'amp.mjs'), path.join('dialects', 'deny-once.mjs')]) {
      assert.ok(fs.existsSync(path.join(m.hookDir, script)), script);
    }
    assert.equal(read(path.join(m.dir, 'plugins', 'mine.ts')), MINE, 'their plugin, untouched');

    // the settings: theirs, with our server after theirs, and nothing else changed
    const settings = read(m.settings);
    assert.equal(settings, THEIRS.replace('"] }\n\t},', `"] },\n\t\t${ourMember(m)}\n\t},`));
    const value = JSON.parse(settings);
    assert.deepEqual(Object.keys(value), Object.keys(JSON.parse(THEIRS)), 'their keys, in their order');
    assert.deepEqual(Object.keys(value['amp.mcpServers']), ['postgres', 'agentmash'], 'theirs first');
    assert.deepEqual(value['amp.mcpServers'].agentmash, serverEntry(m));
  } finally {
    await server.close();
  }
});

test('login again is already connected, and leaves the plugin and the settings byte for byte', async () => {
  const server = await startServer();
  const m = ampMachine();
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const before = [md5(m.plugin), md5(m.settings)];
    const again = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Amp\s+already connected/);
    assert.deepEqual([md5(m.plugin), md5(m.settings)], before);
  } finally {
    await server.close();
  }
});

test("logout takes out exactly what login put in: the person's settings come back byte for byte, their plugin stays", async () => {
  const server = await startServer();
  try {
    const m = ampMachine();
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(read(m.settings), THEIRS);
    assert.ok(!fs.existsSync(m.plugin));
    assert.deepEqual(fs.readdirSync(path.join(m.dir, 'plugins')), ['mine.ts']);
    assert.ok(!fs.existsSync(m.hookDir), 'nothing runs the scripts any more');

    // an Amp with no settings and no plugins of its own: login made both, and logout leaves nothing
    const bare = machine({ with: ['amp'], codex: false, cursor: false, copilot: false, scripts: { amp: AMP_STANDIN } });
    await run(['login', '--server', server.url, '--no-open'], bare.env);
    const made = path.join(bare.home, '.config', 'amp', 'settings.json');
    assert.deepEqual(json(made), { 'amp.mcpServers': { agentmash: serverEntry(bare) } });
    if (process.platform !== 'win32') assert.equal(fs.statSync(made).mode & 0o777, 0o600, 'a settings file made here holds an MCP server: private from the start');
    await run(['logout'], bare.env);
    assert.ok(!fs.existsSync(path.join(bare.home, '.config', 'amp')), 'the folders made for them go too');
  } finally {
    await server.close();
  }
});

test('comments, a trailing comma and a settings.jsonc are kept: the server goes in and comes out as text', async () => {
  const server = await startServer();
  try {
    const m = ampMachine({ settings: THEIRS_JSONC, file: 'settings.jsonc' });
    await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.ok(!fs.existsSync(path.join(m.dir, 'settings.json')), 'the file there is, not a second one');
    const text = read(m.settings);
    assert.equal(
      text,
      THEIRS_JSONC.replace('["painter"],', `["painter"],\n\t"amp.mcpServers": {\n\t\t${ourMember(m)}\n\t},`),
      'an amp.mcpServers of its own, after theirs, indented as theirs'
    );
    assert.deepEqual(scanJsonc(text).value['amp.mcpServers'].agentmash, serverEntry(m));

    await run(['logout'], m.env);
    assert.equal(read(m.settings), THEIRS_JSONC);
  } finally {
    await server.close();
  }
});

test("a server of the person's added after ours, with a comment above it, keeps the comment when ours comes out", async () => {
  const server = await startServer();
  try {
    const m = ampMachine({ settings: THEIRS_JSONC, file: 'settings.jsonc' });
    await run(['login', '--server', server.url, '--no-open'], m.env);
    // ours is the first, and only, server: the person adds one of their own after it, and says why above it
    const theirs = '\t\t// github: token comes from 1password, see notes\n\t\t"github": { "command": "gh-mcp" }';
    fs.writeFileSync(m.settings, read(m.settings).replace(`${ourMember(m)}\n`, `${ourMember(m)},\n${theirs}\n`));
    assert.deepEqual(Object.keys(scanJsonc(read(m.settings)).value['amp.mcpServers']), ['agentmash', 'github']);

    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(read(m.settings), THEIRS_JSONC.replace('["painter"],', `["painter"],\n\t"amp.mcpServers": {\n${theirs}\n\t},`));
  } finally {
    await server.close();
  }
});

test('a server of ours from another hooks folder is put right where it was, and an empty settings file stays the person\'s', async () => {
  const server = await startServer();
  try {
    const m = ampMachine();
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const written = read(m.settings);
    // as an older login, or one with another AGENTMASH_HOME, left it
    const elsewhere = path.join(path.sep, 'elsewhere', '.agentmash', 'hooks', 'mcp_server.mjs');
    fs.writeFileSync(m.settings, written.replace(JSON.stringify(path.join(m.hookDir, 'mcp_server.mjs')), JSON.stringify(elsewhere)));
    const again = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.match(again.stdout, /Amp\s+connected/);
    assert.equal(read(m.settings), written, 'the same line, in the same place');
    await run(['logout'], m.env);
    assert.equal(read(m.settings), THEIRS);

    const empty = ampMachine({ settings: '{}\n' });
    await run(['login', '--server', server.url, '--no-open'], empty.env);
    assert.deepEqual(json(empty.settings), { 'amp.mcpServers': { agentmash: serverEntry(empty) } });
    await run(['logout'], empty.env);
    assert.equal(read(empty.settings), '{}\n');
  } finally {
    await server.close();
  }
});

test('the settings are read as Amp reads them: comments and trailing commas, and none of either inside a string', () => {
  const text = '{\n\t"a//b": "/* not a comment */", // one\n\t"c": [1, 2,], /* two */\n\t"d": {"e": null,},\n}';
  const root = scanJsonc(text);
  assert.deepEqual(root.value, { 'a//b': '/* not a comment */', c: [1, 2], d: { e: null } });
  assert.deepEqual(root.members.map((m) => [m.key, text.slice(m.keyStart, m.end)]), [
    ['a//b', '"a//b": "/* not a comment */"'],
    ['c', '"c": [1, 2,]'],
    ['d', '"d": {"e": null,}'],
  ]);
  for (const bad of ['', '{', '{"a" 1}', '{"a": 1} x', '{"a": tru}', '{"a": "line\nbreak"}', '/* open', '{,}']) {
    assert.throws(() => scanJsonc(bad), /not JSON at character/, JSON.stringify(bad));
  }
  assert.equal(Object.getPrototypeOf(scanJsonc('{"__proto__": {"x": 1}}').value), Object.prototype, 'a key is a key');
});

test('tools lists Amp, and adds or removes it on its own', async () => {
  const m = ampMachine();
  const list = await run(['tools'], m.env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /amp\s+Amp\s+found · 0\.0\.1791146283-g5c3f72 \(released 2026-10-04T20:38:00\.000Z[^\n]*\s+not connected\n/);

  const add = await run(['tools', 'add', 'amp'], m.env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /Amp\s+connected/);
  assert.ok(fs.existsSync(m.plugin));
  assert.match((await run(['tools'], m.env)).stdout, /amp\s+Amp\s+found .*\s+connected/);

  const remove = await run(['tools', 'remove', 'amp'], m.env);
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /Amp\s+disconnected/);
  assert.equal(read(m.settings), THEIRS);
  assert.ok(!fs.existsSync(m.plugin));
  assert.match((await run(['tools'], m.env)).stdout, /amp\s+Amp\s+found .*\s+not connected/);

  // found by its folder alone, and by its installer's copy off PATH
  const folder = ampMachine({ bin: false });
  assert.match((await run(['tools'], folder.env)).stdout, /amp\s+Amp\s+found\s+not connected/);
  const nothing = machine({ with: [], codex: false, cursor: false, copilot: false });
  assert.match((await run(['tools'], nothing.env)).stdout, /amp\s+Amp\s+not found/);
  fs.mkdirSync(path.join(nothing.home, '.amp', 'bin'), { recursive: true });
  if (process.platform === 'win32') {
    // there the installer's copy is amp.exe, which no script can stand in for: found, and with no version to say
    fs.writeFileSync(path.join(nothing.home, '.amp', 'bin', 'amp.exe'), '');
    assert.match((await run(['tools'], nothing.env)).stdout, /amp\s+Amp\s+found\s+not connected/);
    return;
  }
  fs.writeFileSync(path.join(nothing.home, '.amp', 'bin', 'amp'), `#!${process.execPath}\n${AMP_STANDIN}\n`, { mode: 0o755 });
  assert.match((await run(['tools'], nothing.env)).stdout, /amp\s+Amp\s+found · 0\.0\.1791146283-g5c3f72/);
});

test("doctor checks Amp's plugin, the scripts it runs and its MCP server", async () => {
  const server = await startServer();
  const m = ampMachine();
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const first = await run(['doctor'], m.env, m.home);
    assert.match(first.stdout, shownHere(/Amp: hooks in ~\/\.config\/amp\/plugins\/agentmash\.ts \(4 events\) · MCP server registered/));

    fs.rmSync(path.join(m.hookDir, 'agent_hook.mjs'));
    const broken = await run(['doctor'], m.env, m.home);
    assert.match(broken.stdout, /✗ Amp: runs .*agent_hook\.mjs, which does not exist — every call fails — run: npx agentmash login/);
    assert.equal(broken.code, 1);
  } finally {
    await server.close();
  }
});

test('settings that do not read: login adds the plugin and no server, and says which file; logout says it, and keeps the scripts it names', async () => {
  const server = await startServer();
  try {
    const broken = '{\n\t"amp.showCosts": false,,\n}\n';
    const m = ampMachine({ settings: broken });
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, /Amp\s+connected/);
    assert.match(login.stdout, shownHere(/~\/\.config\/amp\/settings\.json could not be read \(not JSON at character \d+\): the MCP server was not added, and the file was left as it was/));
    assert.equal(read(m.settings), broken);
    assert.ok(fs.existsSync(m.plugin));
    await run(['logout'], m.env);
    assert.equal(read(m.settings), broken);

    // read when login wrote to it, broken by hand since
    const later = ampMachine();
    await run(['login', '--server', server.url, '--no-open'], later.env);
    fs.writeFileSync(later.settings, read(later.settings).replace(/\}\s*$/, ',,}'));
    const out = await run(['logout'], later.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/~\/\.config\/amp\/settings\.json is not valid JSON: agentmash is still in it/));
    assert.match(out.stdout, shownHere(/kept .*\.agentmash\/hooks/));
    assert.ok(fs.existsSync(path.join(later.hookDir, 'mcp_server.mjs')), 'what the settings still name is still there');
    assert.ok(!fs.existsSync(later.plugin), 'the plugin, which reads, is out');
  } finally {
    await server.close();
  }
});

test('a symlinked or private settings file stays so, and nothing half-written is left about', { skip: process.platform === 'win32' && 'POSIX modes and symlinks' }, async () => {
  const server = await startServer();
  try {
    const m = ampMachine();
    // ~/.config/amp/settings.json as stow or chezmoi leave it: a private file in the person's dotfiles
    const dotfiles = path.join(m.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    fs.renameSync(m.settings, path.join(dotfiles, 'amp-settings.json'));
    fs.chmodSync(path.join(dotfiles, 'amp-settings.json'), 0o600);
    fs.symlinkSync(path.join(dotfiles, 'amp-settings.json'), m.settings);

    await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.ok(fs.lstatSync(m.settings).isSymbolicLink(), 'still the link');
    assert.equal(fs.statSync(m.settings).mode & 0o777, 0o600);
    assert.deepEqual(json(path.join(dotfiles, 'amp-settings.json'))['amp.mcpServers'].agentmash, serverEntry(m));
    for (const dir of [m.dir, path.join(m.dir, 'plugins'), dotfiles]) {
      assert.deepEqual(fs.readdirSync(dir).filter((f) => /tmp/.test(f)), [], `no temporary file left in ${dir}`);
    }

    await run(['logout'], m.env);
    assert.ok(fs.lstatSync(m.settings).isSymbolicLink());
    assert.equal(read(path.join(dotfiles, 'amp-settings.json')), THEIRS);
  } finally {
    await server.close();
  }
});

test('a plugin or a server called agentmash that is not ours is left as it is', async () => {
  const server = await startServer();
  try {
    const m = ampMachine();
    fs.writeFileSync(m.plugin, MINE);
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.match(login.stdout, shownHere(/Amp\s+skipped — ~\/\.config\/amp\/plugins\/agentmash\.ts is there already, and not ours: left as it is/));
    assert.equal(read(m.settings), THEIRS, 'skipped is skipped: no server either');
    await run(['logout'], m.env);
    assert.equal(read(m.plugin), MINE);

    const theirs = ampMachine({ settings: THEIRS.replace('"postgres"', '"agentmash"') });
    const out = await run(['login', '--server', server.url, '--no-open'], theirs.env);
    assert.match(out.stdout, shownHere(/a server called agentmash is in ~\/\.config\/amp\/settings\.json already, and not ours: left as it is/));
    await run(['logout'], theirs.env);
    assert.equal(read(theirs.settings), THEIRS.replace('"postgres"', '"agentmash"'));
  } finally {
    await server.close();
  }
});

test("with Amp's old permission rules in its settings, login says AgentMash only reports there", async () => {
  const server = await startServer();
  try {
    const m = ampMachine({ settings: THEIRS.replace('\t"amp.showCosts": false,', '\t"amp.permissions": [{ "tool": "Bash", "action": "ask" }],') });
    const out = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.match(out.stdout, /your Amp settings turn on its permission rules \(amp\.permissions\): there AgentMash reports Amp's edits, and answers no tool call/);
    assert.doesNotMatch(out.stdout, /refusing its first edit/);
  } finally {
    await server.close();
  }
});

test('the Amp module: its files follow XDG_CONFIG_HOME, what it registers is the same every time, and logout keeps its files in view', () => {
  const amp = AGENTS.amp;
  assert.equal(amp.name, 'Amp');
  assert.ok(amp.order > 40, 'after the agents connected first');
  assert.deepEqual(amp.env, ['AMP_HOME', 'XDG_CONFIG_HOME']);
  const home = path.join(path.sep, 'h');
  const saved = process.env.XDG_CONFIG_HOME;
  try {
    delete process.env.XDG_CONFIG_HOME;
    assert.deepEqual(amp.files({ ...agentPlaces(), home }), {
      plugin: path.join(home, '.config', 'amp', 'plugins', 'agentmash.ts'),
      settings: path.join(home, '.config', 'amp', 'settings.json'),
    });
    process.env.XDG_CONFIG_HOME = path.join(home, 'xdg');
    assert.equal(amp.files({ ...agentPlaces(), home }).plugin, path.join(home, 'xdg', 'amp', 'plugins', 'agentmash.ts'));
    assert.ok(agentFiles({ ...agentPlaces(), home }).includes(path.join(home, 'xdg', 'amp', 'plugins', 'agentmash.ts')));
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
  const dir = '/home/someone/.agentmash/hooks';
  assert.deepEqual(amp.hooks(dir), amp.hooks(dir));
  assert.equal(ampPlugin(dir), ampPlugin(dir), 'no version, date or anything else that changes in it');
  assert.equal(ampPlugin(dir, 'no line to fill in'), null);
  assert.equal(ampPlugin(dir, `${UNSET_LINE}\n${UNSET_LINE}\n`), null);
});

test('the plugin is plain JavaScript Amp loads as TypeScript: its marker first, a static description, one line for login, node modules only', () => {
  const text = source();
  assert.equal(text.split('\n')[0], '// @i-know-the-amp-plugin-api-is-wip-and-very-experimental-right-now');
  assert.equal(text.split(UNSET_LINE).length, 2, 'the one line login fills in, once');
  const description = /^export const description = "([^"\\]*)";$/m.exec(text);
  assert.ok(description, 'a static string literal, as Amp reads it');
  assert.ok(description[1].length <= 300, `${description[1].length} characters`);
  const imports = [...text.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0 && imports.every((from) => from.startsWith('node:')), imports.join(', '));
  assert.doesNotMatch(text, /action: 'error'|action: 'modify'|action: 'synthesize'|action: 'continue'/, 'never an answer Amp acts on beyond allow and a refusal');
});
