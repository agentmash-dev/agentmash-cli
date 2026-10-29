// Kilo Code: `npx agentmash login` writes a plugin of ours beside Kilo's
// global config, ~/.config/kilo/agentmash.js, and names it in that config
// with our MCP server, and `npx agentmash logout` takes out exactly that:
// the config as it was, to the byte, comments and all. Every test runs in a
// home of its own (fixtures/machine.mjs), Kilo's folders found through HOME
// and XDG_CONFIG_HOME there, and XDG_DATA_HOME and KILO_PURE cleared unless a
// test sets them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import kilo, { kiloHooks, kiloServer, readJsonc } from '../agents/kilo.mjs';
import { machine, md5, OURS, run, shownHere, startServer } from './fixtures/machine.mjs';

/** Kilo's global config as a person leaves it: comments, trailing commas, a plugin and a server of theirs. */
const THEIR_CONFIG = `// my Kilo setup
{
  "$schema": "https://app.kilo.ai/config.json",
  "model": "kilo/anthropic/claude-sonnet-4.5", // the good one
  "plugin": [
    "opencode-wakatime", // time tracking
  ],
  "mcp": {
    "sentry": { "type": "remote", "url": "https://mcp.sentry.dev/mcp" },
  },
}
`;
/** What Kilo writes itself the first time it runs and finds no global config (config/config.ts, loadGlobal). */
const KILO_SEED = JSON.stringify({ $schema: 'https://app.kilo.ai/config.json' }, null, 2);

/** A home with Kilo Code in it (and no other agent), its config folder holding `config` files by name, `with` the commands on the tool path. */
function kiloMachine({ with: names = [], config = { 'kilo.jsonc': THEIR_CONFIG }, scripts = {} } = {}) {
  const m = machine({ with: names, codex: false, cursor: false, copilot: false, scripts });
  const dir = path.join(m.home, '.config', 'kilo');
  const at = {
    dir,
    plugin: path.join(dir, 'agentmash.js'),
    kiloJsonc: path.join(dir, 'kilo.jsonc'),
    kiloJson: path.join(dir, 'kilo.json'),
    opencodeJsonc: path.join(dir, 'opencode.jsonc'),
    opencodeJson: path.join(dir, 'opencode.json'),
    data: path.join(m.home, '.local', 'share', 'kilo'),
  };
  if (config) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(config)) fs.writeFileSync(path.join(dir, name), text);
  }
  return { ...m, at, spec: pathToFileURL(at.plugin).href };
}

const read = (file) => fs.readFileSync(file, 'utf8');
const configOf = (file) => readJsonc(read(file)).value;
const login = (server, m, env = {}) => run(['login', '--server', server.url, '--no-open'], { ...m.env, ...env });

/** A stand-in for Kilo's command: `kilo --version` as @kilocode/cli 7.8.3 prints it. */
const KILO = `if (process.argv[2] === '--version') console.log('7.8.3');`;

test('login connects Kilo Code: our plugin beside its config, named in it after theirs with the MCP server, and logout puts the config back to the byte', async () => {
  const server = await startServer();
  const m = kiloMachine();
  fs.chmodSync(m.at.kiloJsonc, 0o644);
  try {
    const out = await login(server, m);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/Kilo Code\s+connected\s+~\/\.config\/kilo\/agentmash\.js/));
    assert.match(out.stdout, /Kilo Code shows the agent a warning by refusing its first edit of a file a teammate is in/);

    // the plugin: ours, running the generic hook for Kilo in its dialect, with nothing in it that changes between releases
    const plugin = read(m.at.plugin);
    assert.ok(plugin.startsWith('// AgentMash for Kilo Code.'));
    const runs = JSON.parse(/^const RUNS = (.*);$/m.exec(plugin)[1]);
    assert.deepEqual(runs, kiloHooks(m.hookDir));
    assert.deepEqual(runs['tool.execute.before'], [path.join(m.hookDir, 'agent_hook.mjs'), 'pre_edit', '--global', '--client', 'kilo', '--dialect', 'kilo', '--input', 'native']);
    assert.doesNotMatch(JSON.stringify(runs), /\d+\.\d+\.\d+/);
    assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')));
    assert.ok(fs.existsSync(path.join(m.hookDir, 'dialects', 'kilo.mjs')), "Kilo's dialect, beside the generic hook");
    assert.ok(!fs.existsSync(path.join(m.at.dir, 'plugin')), "not in Kilo's plugin folder, which would cost an npm install on every start after an update");

    // the config: theirs first and as it was, ours after, laid out as theirs is
    const text = read(m.at.kiloJsonc);
    assert.ok(text.startsWith('// my Kilo setup\n{\n  "$schema": "https://app.kilo.ai/config.json",\n  "model": "kilo/anthropic/claude-sonnet-4.5", // the good one\n'));
    assert.match(text, /"opencode-wakatime", \/\/ time tracking\n    "file:\/\/[^"]+\/\.config\/kilo\/agentmash\.js",\n  \],/);
    const config = configOf(m.at.kiloJsonc);
    assert.deepEqual(config.plugin, ['opencode-wakatime', m.spec]);
    assert.deepEqual(Object.keys(config.mcp), ['sentry', 'agentmash']);
    assert.deepEqual(config.mcp.agentmash, kiloServer(m.hookDir));
    assert.deepEqual(config.mcp.agentmash, { type: 'local', command: ['node', path.join(m.hookDir, 'mcp_server.mjs')], enabled: true });
    assert.ok(OURS.test(config.mcp.agentmash.command[1]));
    if (process.platform !== 'win32') assert.equal(fs.statSync(m.at.kiloJsonc).mode & 0o777, 0o644, 'the mode it had');

    // login again: already, and not a byte different
    const before = [md5(m.at.plugin), md5(m.at.kiloJsonc)];
    const again = await login(server, m);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Kilo Code\s+already connected/);
    assert.deepEqual([md5(m.at.plugin), md5(m.at.kiloJsonc)], before);

    // logout: their config back byte for byte, our plugin and the hooks gone
    const bye = await run(['logout'], m.env);
    assert.equal(bye.code, 0, bye.stderr);
    assert.equal(read(m.at.kiloJsonc), THEIR_CONFIG);
    assert.ok(!fs.existsSync(m.at.plugin));
    assert.ok(!fs.existsSync(m.hookDir));
  } finally {
    await server.close();
  }
});

test('with no config of its own yet, login makes a private kilo.jsonc and logout takes it away; one Kilo seeded itself comes back as Kilo left it', async () => {
  const server = await startServer();
  // Kilo run once through a front end that made no config (the JetBrains plugin never seeds one): its data folder only
  const m = kiloMachine({ config: null });
  fs.mkdirSync(m.at.data, { recursive: true });
  try {
    const out = await login(server, m);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /Kilo Code\s+connected/);
    assert.deepEqual(configOf(m.at.kiloJsonc), { $schema: 'https://app.kilo.ai/config.json', plugin: [m.spec], mcp: { agentmash: kiloServer(m.hookDir) } });
    if (process.platform !== 'win32') assert.equal(fs.statSync(m.at.kiloJsonc).mode & 0o777, 0o600, 'a new MCP config is private from the start');
    await run(['logout'], m.env);
    assert.ok(!fs.existsSync(m.at.dir), 'the folder login made, and what was in it');
  } finally {
    await server.close();
  }

  const server2 = await startServer();
  const seeded = kiloMachine({ config: { 'kilo.jsonc': KILO_SEED } });
  try {
    await login(server2, seeded);
    assert.deepEqual(configOf(seeded.at.kiloJsonc).plugin, [seeded.spec]);
    await run(['logout'], seeded.env);
    assert.equal(read(seeded.at.kiloJsonc), KILO_SEED, 'as Kilo wrote it, with no newline at the end');
  } finally {
    await server2.close();
  }
});

test('the plugin goes in the plugin list Kilo uses: a later file’s list replaces an earlier one’s', async () => {
  const server = await startServer();
  // what `kilo plugin --global` leaves: a list in opencode.json, the file it writes (plugin/install.ts, config/paths.ts)
  const theirs = '{\n  "plugin": ["@my/kilo-plugin"]\n}\n';
  const m = kiloMachine({ config: { 'kilo.jsonc': KILO_SEED, 'opencode.json': theirs } });
  try {
    await login(server, m);
    assert.deepEqual(configOf(m.at.opencodeJson).plugin, ['@my/kilo-plugin', m.spec], 'opencode.json merges after kilo.jsonc, so its list is the one Kilo loads');
    const kiloConfig = configOf(m.at.kiloJsonc);
    assert.equal(kiloConfig.plugin, undefined);
    assert.deepEqual(kiloConfig.mcp.agentmash, kiloServer(m.hookDir), 'the server where Kilo writes its own: kilo.jsonc first');
    assert.match((await run(['doctor'], m.env, m.home)).stdout, shownHere(/✓ Kilo Code: hooks in ~\/\.config\/kilo\/agentmash\.js \(4 events\) · MCP server registered/));

    // `kilo plugin --global` run since login, with no list anywhere before: its new list hides ours. Doctor says so, and tools add puts it right
    await run(['tools', 'remove', 'kilo'], m.env);
    assert.equal(read(m.at.opencodeJson), theirs);
    assert.equal(read(m.at.kiloJsonc), KILO_SEED);
    fs.rmSync(m.at.opencodeJson);
    await run(['tools', 'add', 'kilo'], m.env);
    assert.deepEqual(configOf(m.at.kiloJsonc).plugin, [m.spec]);
    fs.writeFileSync(m.at.opencodeJson, theirs);
    assert.match((await run(['doctor'], m.env, m.home)).stdout, /Kilo Code is on this machine and not connected — npx agentmash tools add kilo/);
    await run(['tools', 'add', 'kilo'], m.env);
    assert.deepEqual(configOf(m.at.opencodeJson).plugin, ['@my/kilo-plugin', m.spec]);
    await run(['tools', 'remove', 'kilo'], m.env);
    assert.equal(read(m.at.opencodeJson), theirs);
    assert.equal(read(m.at.kiloJsonc), KILO_SEED);

    // and the other way round: a list of ours alone, made where there was none, would hide one the person
    // starts in an earlier file. The next login moves ours into theirs, and takes the list of ours alone away
    fs.rmSync(m.at.opencodeJson);
    await run(['tools', 'add', 'kilo'], m.env);
    fs.writeFileSync(m.at.kiloJson, theirs);
    await run(['tools', 'add', 'kilo'], m.env);
    assert.deepEqual(configOf(m.at.kiloJson).plugin, ['@my/kilo-plugin', m.spec]);
    assert.equal(configOf(m.at.kiloJsonc).plugin, undefined);
    await run(['tools', 'remove', 'kilo'], m.env);
    assert.equal(read(m.at.kiloJson), theirs);
    assert.equal(read(m.at.kiloJsonc), KILO_SEED);
  } finally {
    await server.close();
  }
});

test('tools lists Kilo Code, finds it by its command, its folders or its VS Code extension (7 or later), and adds or removes it', async () => {
  // only the extension from before 7.0, which has no plugins: not this Kilo
  const old = kiloMachine({ config: null });
  fs.mkdirSync(path.join(old.home, '.vscode', 'extensions', 'kilocode.kilo-code-4.98.0'), { recursive: true });
  assert.match((await run(['tools'], old.env)).stdout, /kilo\s+Kilo Code\s+not found\s+not connected/);
  fs.mkdirSync(path.join(old.home, '.vscode', 'extensions', 'kilocode.kilo-code-7.8.3'), { recursive: true });
  assert.match((await run(['tools'], old.env)).stdout, /kilo\s+Kilo Code\s+found\s+not connected/);

  const m = kiloMachine({ with: ['kilo'], config: null, scripts: { kilo: KILO } });
  assert.match((await run(['tools'], m.env)).stdout, /kilo\s+Kilo Code\s+found · 7\.8\.3\s+not connected/);
  const add = await run(['tools', 'add', 'kilo'], m.env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /Kilo Code\s+connected/);
  assert.match((await run(['tools'], m.env)).stdout, /kilo\s+Kilo Code\s+found · 7\.8\.3\s+connected/);
  assert.deepEqual(configOf(m.at.kiloJsonc).mcp.agentmash, kiloServer(m.hookDir));

  const remove = await run(['tools', 'remove', 'kilo'], m.env);
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /Kilo Code\s+disconnected/);
  assert.ok(!fs.existsSync(m.at.plugin));
  assert.ok(!fs.existsSync(m.at.kiloJsonc));
  assert.match((await run(['tools'], m.env)).stdout, /kilo\s+Kilo Code\s+found · 7\.8\.3\s+not connected/);
  // Kilo's command is asked its version, and nothing else: login never runs `kilo mcp add`, which drops comments
  assert.ok(m.calls().every((c) => c === 'kilo ["--version"]'), m.calls().join('\n'));
});

test('doctor says Kilo Code is connected, with its events and its MCP server, and that a missing dialect or hook breaks every call', async () => {
  const server = await startServer();
  const m = kiloMachine();
  try {
    await login(server, m);
    const doctor = await run(['doctor'], m.env, m.home);
    assert.match(doctor.stdout, shownHere(/Kilo Code: hooks in ~\/\.config\/kilo\/agentmash\.js \(4 events\) · MCP server registered/));

    fs.rmSync(path.join(m.hookDir, 'dialects', 'kilo.mjs'));
    const noDialect = await run(['doctor'], m.env, m.home);
    assert.match(noDialect.stdout, /✗ Kilo Code: runs .*dialects[\\/]kilo\.mjs, which does not exist — every call fails — run: npx agentmash login/);
    assert.equal(noDialect.code, 1);

    fs.rmSync(path.join(m.hookDir, 'agent_hook.mjs'));
    assert.match((await run(['doctor'], m.env, m.home)).stdout, /✗ Kilo Code: runs .*agent_hook\.mjs, which does not exist/);

    // the person took the MCP server out themselves: still connected, and doctor says which half is there
    await login(server, m);
    const config = read(m.at.kiloJsonc);
    const root = readJsonc(config);
    const mcp = root.entries.find((e) => e.key === 'mcp').node;
    const ours = mcp.entries.find((e) => e.key === 'agentmash');
    fs.writeFileSync(m.at.kiloJsonc, config.slice(0, mcp.entries[0].comma + 1) + config.slice(ours.comma === -1 ? ours.node.end : ours.comma + 1));
    assert.equal(configOf(m.at.kiloJsonc).mcp.agentmash, undefined);
    assert.match((await run(['doctor'], m.env, m.home)).stdout, shownHere(/Kilo Code: hooks in ~\/\.config\/kilo\/agentmash\.js \(4 events\) · MCP server not registered/));
  } finally {
    await server.close();
  }
});

test('a config that is not JSON: login skips Kilo Code and says which file, and logout names it and keeps the plugin and the scripts it runs', async () => {
  const server = await startServer();
  // broken before any login: nothing of ours is written at all
  const fresh = kiloMachine({ config: { 'kilo.jsonc': '{ "plugin": [ }' } });
  try {
    const out = await login(server, fresh);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/Kilo Code\s+skipped — ~\/\.config\/kilo\/kilo\.jsonc is not valid JSON — fix it, then run login again/));
    assert.ok(!fs.existsSync(fresh.at.plugin));
    assert.equal(read(fresh.at.kiloJsonc), '{ "plugin": [ }');
  } finally {
    await server.close();
  }

  const server2 = await startServer();
  const m = kiloMachine();
  try {
    await login(server2, m);
    // one of Kilo's other global files broken since: Kilo reads all five
    fs.writeFileSync(m.at.kiloJson, '{ "model": ');
    const plugin = read(m.at.plugin);
    const config = read(m.at.kiloJsonc);

    const again = await login(server2, m);
    assert.match(again.stdout, shownHere(/Kilo Code\s+skipped — ~\/\.config\/kilo\/kilo\.json is not valid JSON — fix it, then run login again/));
    assert.equal(read(m.at.kiloJsonc), config, 'left as it was');

    const doctor = await run(['doctor'], m.env, m.home);
    assert.match(doctor.stdout, shownHere(/✗ Kilo Code: ~\/\.config\/kilo\/kilo\.json is not valid JSON/));

    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/~\/\.config\/kilo\/kilo\.json is not valid JSON: agentmash is still in it/));
    assert.match(out.stdout, shownHere(/kept .*\.agentmash\/hooks/));
    assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')), 'what Kilo may still run is still there');
    assert.equal(read(m.at.plugin), plugin, 'and the plugin, which a config not read may still name');
    assert.equal(read(m.at.kiloJsonc), THEIR_CONFIG, 'the file that could be read is put back');

    // fixed: logout finishes the job
    fs.rmSync(m.at.kiloJson);
    await run(['logout'], m.env);
    assert.ok(!fs.existsSync(m.at.plugin));
    assert.ok(!fs.existsSync(m.hookDir));
  } finally {
    await server2.close();
  }
});

test('a symlinked config stays a link, a private one stays private, and nothing half-written is left about', { skip: process.platform === 'win32' && 'POSIX modes and symlinks' }, async () => {
  const server = await startServer();
  const m = kiloMachine({ config: null });
  try {
    const dotfiles = path.join(m.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const linked = path.join(dotfiles, 'kilo.jsonc');
    fs.writeFileSync(linked, THEIR_CONFIG, { mode: 0o600 });
    fs.chmodSync(linked, 0o600);
    fs.mkdirSync(m.at.dir, { recursive: true });
    fs.symlinkSync(linked, m.at.kiloJsonc);

    await login(server, m);
    assert.ok(fs.lstatSync(m.at.kiloJsonc).isSymbolicLink(), 'still the link');
    assert.deepEqual(configOf(linked).plugin, ['opencode-wakatime', m.spec], 'and ours went into what it points at');
    assert.equal(fs.statSync(linked).mode & 0o777, 0o600, 'a file that may hold tokens stays private');
    for (const dir of [dotfiles, m.at.dir]) {
      assert.deepEqual(fs.readdirSync(dir).filter((f) => /tmp/.test(f)), [], `no temporary file left in ${dir}`);
    }

    await run(['logout'], m.env);
    assert.ok(fs.lstatSync(m.at.kiloJsonc).isSymbolicLink());
    assert.equal(read(linked), THEIR_CONFIG);
    assert.equal(fs.statSync(linked).mode & 0o777, 0o600);
  } finally {
    await server.close();
  }
});

test("someone else's agentmash server, a plugin file or a plugin list that is not ours to touch: each left as it is", async () => {
  const server = await startServer();
  const theirServer = '{\n  "mcp": {\n    "agentmash": { "type": "remote", "url": "https://example.com/mcp" }\n  }\n}\n';
  const m = kiloMachine({ config: { 'kilo.jsonc': theirServer } });
  try {
    const out = await login(server, m);
    assert.match(out.stdout, /Kilo Code\s+connected/);
    assert.match(out.stdout, shownHere(/a server called agentmash is in ~\/\.config\/kilo\/kilo\.jsonc already, and not ours: left as it is/));
    const config = configOf(m.at.kiloJsonc);
    assert.deepEqual(config.mcp.agentmash, { type: 'remote', url: 'https://example.com/mcp' });
    assert.deepEqual(config.plugin, [m.spec], 'the plugin, which needs no server, is connected all the same');
    await run(['logout'], m.env);
    assert.equal(read(m.at.kiloJsonc), theirServer);
  } finally {
    await server.close();
  }

  // ours, copied in disabled by Kilo's Claude Code migration (enabled: false): made ours as it is now
  const server2 = await startServer();
  const migrated = kiloMachine({ config: { 'kilo.jsonc': KILO_SEED } });
  try {
    const disabled = { type: 'local', command: ['node', path.join(migrated.hookDir, 'mcp_server.mjs')], enabled: false };
    fs.writeFileSync(migrated.at.kiloJsonc, JSON.stringify({ $schema: 'https://app.kilo.ai/config.json', mcp: { agentmash: disabled } }, null, 2));
    await login(server2, migrated);
    assert.deepEqual(configOf(migrated.at.kiloJsonc).mcp.agentmash, kiloServer(migrated.hookDir));
    await run(['logout'], migrated.env);
    assert.deepEqual(configOf(migrated.at.kiloJsonc), { $schema: 'https://app.kilo.ai/config.json' });
  } finally {
    await server2.close();
  }

  const server3 = await startServer();
  const taken = kiloMachine();
  try {
    fs.writeFileSync(taken.at.plugin, 'export const Mine = async () => ({});\n');
    const out = await login(server3, taken);
    assert.match(out.stdout, shownHere(/Kilo Code\s+skipped — ~\/\.config\/kilo\/agentmash\.js is a file of somebody else's: left as it is/));
    assert.equal(read(taken.at.plugin), 'export const Mine = async () => ({});\n');
    assert.equal(read(taken.at.kiloJsonc), THEIR_CONFIG);

    fs.rmSync(taken.at.plugin);
    fs.writeFileSync(taken.at.kiloJsonc, '{ "plugin": "opencode-wakatime" }');
    const notList = await login(server3, taken);
    assert.match(notList.stdout, shownHere(/Kilo Code\s+skipped — "plugin" in ~\/\.config\/kilo\/kilo\.jsonc is not a list/));
    assert.ok(!fs.existsSync(taken.at.plugin));
  } finally {
    await server3.close();
  }
});

test('KILO_PURE switches every Kilo plugin off: login says so', async () => {
  const server = await startServer();
  const m = kiloMachine();
  try {
    const out = await login(server, m, { KILO_PURE: '1' });
    assert.match(out.stdout, /KILO_PURE is set here: Kilo Code loads no plugin while it is, this one included/);
  } finally {
    await server.close();
  }
});

test('connect and disconnect, called as login calls them, on a config written on one line or with tabs', () => {
  const saved = process.env.XDG_CONFIG_HOME;
  try {
    for (const text of [
      '{"$schema":"https://app.kilo.ai/config.json","plugin":["a","b"],"mcp":{"x":{"type":"remote","url":"https://x"}}}',
      '{\n\t"model": "kilo/x",\n\t"plugin": [\n\t\t"a"\n\t]\n}\n',
      '{ "plugin": ["a"], "mcp": { "x": { "type": "remote", "url": "https://x" }, }, }',
    ]) {
      const m = kiloMachine({ config: { 'kilo.jsonc': text } });
      process.env.XDG_CONFIG_HOME = path.join(m.home, '.config');
      const places = { home: m.home, toolPath: '', apps: null };
      assert.equal(kilo.connect(places, m.hookDir).status, 'connected', text);
      const config = configOf(m.at.kiloJsonc);
      assert.deepEqual(config.plugin.at(-1), m.spec, text);
      assert.deepEqual(config.mcp.agentmash, kiloServer(m.hookDir), text);
      if (text.startsWith('{"')) assert.ok(!read(m.at.kiloJsonc).includes('\n'), 'still one line');
      assert.equal(kilo.connect(places, m.hookDir).status, 'already');
      assert.equal(kilo.inspect(places).connected, true);
      assert.equal(kilo.disconnect(places).status, 'removed');
      assert.equal(read(m.at.kiloJsonc), text);
      assert.equal(kilo.disconnect(places).status, 'absent');
    }
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
});
