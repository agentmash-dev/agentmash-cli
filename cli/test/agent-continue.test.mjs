// Continue (cli/agents/continue.mjs): no hook of Continue's ever runs, so
// `npx agentmash login` gives it AgentMash's MCP server alone, as one item of
// mcpServers in ~/.continue/config.yaml, and `npx agentmash logout` takes out
// exactly those lines. config.yaml is YAML holding the person's API keys,
// edited here as lines: every test checks that not a byte of theirs moves,
// and that a file this cannot read for certain is left as it is. Every test
// runs in a home of its own (fixtures/machine.mjs), with CONTINUE_GLOBAL_DIR
// cleared unless a test sets it: nothing here may touch the real ~/.continue.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENTS, agentFiles, agentPlaces } from '../tools.mjs';
import cont, { continueItem, continueServer } from '../agents/continue.mjs';
import { machine, md5, run, shownHere, startServer } from './fixtures/machine.mjs';

/** The config.yaml Continue writes when it finds none (core/config/default.ts, through the yaml package). */
const DEFAULT = 'name: Main Config\nversion: 1.0.0\nschema: v1\nmodels: []\n';

/** A person's config.yaml: a model with its key, comments, a server of their own and a commented-out one, then more keys. */
const THEIRS = `# my Continue setup
name: Main Config
version: 1.0.0
schema: v1
models:
  - name: Claude Sonnet 4.6
    provider: anthropic
    model: claude-sonnet-4-6
    apiKey: sk-ant-not-a-real-key # rotate in March
    roles:
      - chat
      - edit
mcpServers:
  - name: memory
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-memory"
  # - name: browser
  #   command: npx

rules:
  - Keep answers short
`;

/** A home with Continue set up in it (and no other agent), its config.yaml `config` (null: none). */
function continueMachine({ config = THEIRS, with: names = [], scripts = {}, mode = 0o600 } = {}) {
  const m = machine({ with: names, codex: false, cursor: false, copilot: false, scripts });
  const dir = path.join(m.home, '.continue');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.yaml');
  if (config !== null) {
    // Continue makes its config private (setConfigFilePermissions)
    fs.writeFileSync(file, config, { mode });
    fs.chmodSync(file, mode);
  }
  return { ...m, dir, config: file, server: path.join(m.hookDir, 'mcp_server.mjs') };
}

const read = (file) => fs.readFileSync(file, 'utf8');
/** Our item as login writes it into the config, its dash `dash` columns in. */
const ourItem = (m, dash = 2) => continueItem(m.hookDir, dash);

/** A stand-in for cn where npm puts it: a link into @continuedev/cli, printing its version as cn 1.5.47 does. */
function cnCli(m) {
  const js = path.join(m.home, 'npm', 'lib', 'node_modules', '@continuedev', 'cli', 'dist', 'cn.js');
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, `#!${process.execPath}\nif (process.argv[2] === '--version') console.log('1.5.47');\n`);
  fs.chmodSync(js, 0o755);
  fs.symlinkSync(js, path.join(m.env.AGENTMASH_TOOL_PATH, 'cn'));
}

test('login connects Continue: our server after the person’s last one, every line of theirs as it was, and logout gives the file back byte for byte', async () => {
  const server = await startServer();
  const m = continueMachine();
  try {
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, shownHere(/Continue\s+connected\s+~\/\.continue\/config\.yaml/));
    assert.match(login.stdout, /Continue runs no hooks: it gets AgentMash's MCP tools only/);
    assert.match(login.stdout, /Continue asks before each agentmash tool call/);

    // exactly three lines, after the person's server and before their commented-out one
    const at = THEIRS.indexOf('  # - name: browser');
    assert.equal(read(m.config), THEIRS.slice(0, at) + ourItem(m) + THEIRS.slice(at));
    assert.equal(
      ourItem(m),
      `  - name: agentmash\n    command: node\n    args: [${JSON.stringify(m.server)}]\n`
    );
    assert.deepEqual(continueServer(m.hookDir), { name: 'agentmash', command: 'node', args: [m.server] });
    assert.ok(fs.existsSync(m.server), 'what the item runs is there');
    if (process.platform !== 'win32') assert.equal(fs.statSync(m.config).mode & 0o777, 0o600, 'a file holding API keys stays private');

    const before = md5(m.config);
    const again = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Continue\s+already connected/);
    assert.equal(md5(m.config), before, 'not a byte different');

    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(read(m.config), THEIRS);
    assert.ok(!fs.existsSync(m.hookDir));
  } finally {
    await server.close();
  }
});

test('a config with no mcpServers (Continue’s own default) gets the key at its end, and logout takes the key out with ours', async () => {
  const server = await startServer();
  const m = continueMachine({ config: DEFAULT });
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(read(m.config), `${DEFAULT}mcpServers:\n${ourItem(m)}`);
    await run(['logout'], m.env);
    assert.equal(read(m.config), DEFAULT);
  } finally {
    await server.close();
  }
});

test('a list written at the left edge, and lines ending in CRLF, are written as the person writes them', async () => {
  const server = await startServer();
  try {
    const compact = 'name: x\nversion: 1.0.0\nschema: v1\nmcpServers:\n- name: memory\n  command: npx\nmodels: []\n';
    const m = continueMachine({ config: compact });
    await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(read(m.config), compact.replace('models: []', `${ourItem(m, 0)}models: []`));
    await run(['logout'], m.env);
    assert.equal(read(m.config), compact);

    const crlf = DEFAULT.replace(/\n/g, '\r\n');
    const w = continueMachine({ config: crlf });
    await run(['login', '--server', server.url, '--no-open'], w.env);
    assert.equal(read(w.config), `${crlf}mcpServers:\r\n${continueItem(w.hookDir, 2, '\r\n')}`);
    await run(['logout'], w.env);
    assert.equal(read(w.config), crlf);
  } finally {
    await server.close();
  }
});

test('ours from another hooks folder comes out, and this one goes in after the person’s servers', async () => {
  const server = await startServer();
  const old = `${DEFAULT}mcpServers:\n${continueItem('/old/.agentmash/hooks')}  - name: memory\n    command: npx\n`;
  const m = continueMachine({ config: old });
  try {
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.match(login.stdout, /Continue\s+connected/);
    assert.equal(read(m.config), `${DEFAULT}mcpServers:\n  - name: memory\n    command: npx\n${ourItem(m)}`);
    assert.doesNotMatch(read(m.config), /\/old\//);
  } finally {
    await server.close();
  }
});

test('no config.yaml: login skips Continue and says what to do, and makes nothing', async () => {
  const server = await startServer();
  try {
    const m = continueMachine({ config: null });
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, shownHere(/Continue\s+skipped — there is no ~\/\.continue\/config\.yaml to add the MCP server to: open Continue once \(or run cn\), then run login again/));
    assert.deepEqual(fs.readdirSync(m.dir), []);

    const legacy = continueMachine({ config: null });
    fs.writeFileSync(path.join(legacy.dir, 'config.json'), '{ "models": [] }\n');
    const old = await run(['login', '--server', server.url, '--no-open'], legacy.env);
    assert.match(old.stdout, shownHere(/Continue\s+skipped — ~\/\.continue\/config\.json is Continue's older config, which agentmash does not edit/));
    assert.deepEqual(fs.readdirSync(legacy.dir), ['config.json']);
  } finally {
    await server.close();
  }
});

test('YAML this cannot read for certain, or an agentmash that is not ours, is left exactly as it is, and login says why', async () => {
  const server = await startServer();
  try {
    const refused = {
      'name: x\nmcpServers: []\n': /its mcpServers is written on one line \(\[\]\)/,
      'name: x\nmcpServers:\n  memory:\n    command: npx\n': /its mcpServers is not a list/,
      'name: x\n---\nname: y\n': /line 2 is not a plain key/,
      'name: x\nmodels:\n\t- name: y\n': /line 3 is indented with a tab/,
      'name: x\nmcpServers:\n  - name: a\n    command: b\nmcpServers:\n  - name: c\n    command: d\n': /it has mcpServers twice/,
      '{name: x, models: []}\n': /line 1 is not a plain key/,
      '': /it has no settings in it/,
    };
    for (const [config, why] of Object.entries(refused)) {
      const m = continueMachine({ config });
      const login = await run(['login', '--server', server.url, '--no-open'], m.env);
      assert.equal(login.code, 0, login.stderr);
      assert.match(login.stdout, shownHere(/Continue\s+skipped — ~\/\.continue\/config\.yaml could not be added to without rewriting it \(/), JSON.stringify(config));
      assert.match(login.stdout, why, JSON.stringify(config));
      assert.equal(read(m.config), config, JSON.stringify(config));
    }

    const theirs = `${DEFAULT}mcpServers:\n  - name: agentmash\n    command: npx\n    args: [agentmash-mcp]\n`;
    const t = continueMachine({ config: theirs });
    const taken = await run(['login', '--server', server.url, '--no-open'], t.env);
    assert.match(taken.stdout, shownHere(/Continue\s+skipped — a server called agentmash is in ~\/\.continue\/config\.yaml already, and not ours: left as it is/));
    await run(['logout'], t.env);
    assert.equal(read(t.config), theirs, 'logout leaves somebody else’s agentmash alone');
  } finally {
    await server.close();
  }
});

test('a config changed after login into one this cannot read: logout names it and keeps the scripts its server runs', async () => {
  const server = await startServer();
  const m = continueMachine({ config: DEFAULT });
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    fs.appendFileSync(m.config, '---\nname: second\n');
    const changed = read(m.config);
    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/~\/\.continue\/config\.yaml .*agentmash is still in it/));
    assert.match(out.stdout, /kept .*\.agentmash[\\/]hooks/);
    assert.ok(fs.existsSync(m.server));
    assert.equal(read(m.config), changed);
  } finally {
    await server.close();
  }
});

test('doctor says Continue is connected and has its MCP server, and that a missing server script is a server that never starts', async () => {
  const server = await startServer();
  const m = continueMachine();
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const doctor = await run(['doctor'], m.env, m.home);
    assert.match(doctor.stdout, shownHere(/Continue: [^\n]*~\/\.continue\/config\.yaml/));
    assert.match(doctor.stdout, /Continue: [^\n]*MCP server/);
    assert.doesNotMatch(doctor.stdout, /✗ Continue/);

    fs.rmSync(m.server);
    const broken = await run(['doctor'], m.env, m.home);
    assert.match(broken.stdout, /✗ Continue: runs .*mcp_server\.mjs, which does not exist/);
    assert.equal(broken.code, 1);
  } finally {
    await server.close();
  }
});

test('tools finds Continue by its folder or by a cn that is Continue’s, and adds or removes it', { skip: process.platform === 'win32' && 'symlinks' }, async () => {
  // a `cn` that is not Continue's, and no folder of Continue's
  const other = machine({ with: ['cn'], codex: false, cursor: false, copilot: false, scripts: { cn: "console.log('cn 0.1');" } });
  assert.match((await run(['tools'], other.env)).stdout, /continue\s+Continue\s+not found\s+not connected/);

  // cn as npm links it, before Continue has made its folder
  const npm = machine({ with: [], codex: false, cursor: false, copilot: false });
  cnCli(npm);
  assert.match((await run(['tools'], npm.env)).stdout, /continue\s+Continue\s+found · 1\.5\.47\s+not connected/);

  const m = continueMachine();
  cnCli(m);
  const add = await run(['tools', 'add', 'continue'], m.env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /Continue\s+connected/);
  assert.match((await run(['tools'], m.env)).stdout, /continue\s+Continue\s+found · 1\.5\.47\s+connected/);

  const remove = await run(['tools', 'remove', 'continue'], m.env);
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /Continue\s+disconnected/);
  assert.equal(read(m.config), THEIRS);
  assert.match((await run(['tools'], m.env)).stdout, /continue\s+Continue\s+found · 1\.5\.47\s+not connected/);
});

test('CONTINUE_GLOBAL_DIR moves Continue’s folder when it is an absolute path, as Continue reads it', async () => {
  const m = continueMachine({ config: null });
  const elsewhere = path.join(m.home, 'continue-config');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'config.yaml'), DEFAULT);
  const env = { ...m.env, CONTINUE_GLOBAL_DIR: elsewhere };
  const add = await run(['tools', 'add', 'continue'], env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, shownHere(/Continue\s+connected\s+~\/continue-config\/config\.yaml/));
  assert.match(read(path.join(elsewhere, 'config.yaml')), /- name: agentmash/);
  assert.deepEqual(fs.readdirSync(m.dir), [], 'not in ~/.continue');
  await run(['tools', 'remove', 'continue'], env);
  assert.equal(read(path.join(elsewhere, 'config.yaml')), DEFAULT);
  // a relative one names no folder this can know: ~/.continue, as when it is not set
  assert.match((await run(['tools', 'add', 'continue'], { ...m.env, CONTINUE_GLOBAL_DIR: 'continue-config' })).stdout, shownHere(/Continue\s+skipped — there is no ~\/\.continue\/config\.yaml/));
});

test('a symlinked config.yaml stays a link, its mode stays, and nothing half-written is left about', { skip: process.platform === 'win32' && 'POSIX modes and symlinks' }, async () => {
  const server = await startServer();
  const m = continueMachine({ config: null });
  try {
    const dotfiles = path.join(m.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const linked = path.join(dotfiles, 'continue.yaml');
    fs.writeFileSync(linked, THEIRS, { mode: 0o600 });
    fs.chmodSync(linked, 0o600);
    fs.symlinkSync(linked, m.config);

    await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.ok(fs.lstatSync(m.config).isSymbolicLink(), 'still the link');
    assert.match(read(linked), /- name: agentmash/);
    assert.equal(fs.statSync(linked).mode & 0o777, 0o600);
    for (const dir of [dotfiles, m.dir]) assert.deepEqual(fs.readdirSync(dir).filter((f) => /tmp/.test(f)), [], `no temporary file left in ${dir}`);

    await run(['logout'], m.env);
    assert.ok(fs.lstatSync(m.config).isSymbolicLink());
    assert.equal(read(linked), THEIRS);
  } finally {
    await server.close();
  }
});

test('the module: an agent like the others, with no hooks, every file it writes named for logout, and the same item every run', () => {
  assert.equal(AGENTS.continue, cont);
  assert.equal(cont.mcpOnly, true);
  assert.ok(Object.values(AGENTS).filter((a) => !a.mcpOnly).every((a) => a.order < cont.order), 'after every agent with hooks');
  assert.deepEqual(cont.hooks('/h/.agentmash/hooks'), cont.hooks('/h/.agentmash/hooks'));
  assert.equal(continueItem('/h/.agentmash/hooks'), continueItem('/h/.agentmash/hooks'));
  assert.doesNotMatch(continueItem('/h/.agentmash/hooks'), /\d+\.\d+\.\d+/, 'nothing that changes between releases');
  // a path YAML would read otherwise (backslashes, quotes, " #", ": ") is written as JSON, which YAML reads back as itself
  const odd = 'C:\\Users\\Jo "J" O\'Neil #1: x\\.agentmash\\hooks';
  const written = /^ {4}args: (\[.*\])$/m.exec(continueItem(odd));
  assert.ok(written, continueItem(odd));
  assert.deepEqual(JSON.parse(written[1]), [path.join(odd, 'mcp_server.mjs')]);

  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-continue-files-')));
  const saved = process.env.CONTINUE_GLOBAL_DIR;
  try {
    delete process.env.CONTINUE_GLOBAL_DIR;
    assert.ok(agentFiles({ ...agentPlaces(), home }).includes(path.join(home, '.continue', 'config.yaml')));
    const places = { home, toolPath: '', apps: null };
    assert.equal(cont.detect(places).found, false);
    assert.deepEqual(cont.inspect(places), { connected: false, invalid: false, where: `~${path.sep}.continue${path.sep}config.yaml`, events: [], missing: [], mcp: false });
    assert.equal(cont.disconnect(places).status, 'absent');
  } finally {
    if (saved !== undefined) process.env.CONTINUE_GLOBAL_DIR = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/** connect, then disconnect, on a config in a home of its own, straight through the module: what each left. */
function roundTrip(config) {
  const saved = process.env.CONTINUE_GLOBAL_DIR;
  delete process.env.CONTINUE_GLOBAL_DIR;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-continue-shape-')));
  const places = { home, toolPath: '', apps: null };
  const hookDir = path.join(home, '.agentmash', 'hooks');
  const file = path.join(home, '.continue', 'config.yaml');
  try {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, config);
    const connect = cont.connect(places, hookDir);
    const added = read(file);
    const again = cont.connect(places, hookDir).status;
    const connected = cont.inspect(places).connected;
    const disconnect = cont.disconnect(places).status;
    return { connect, added, again, connected, disconnect, after: read(file), item: continueItem(hookDir) };
  } finally {
    if (saved !== undefined) process.env.CONTINUE_GLOBAL_DIR = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('each way a person may write config.yaml that this reads: ours goes in as three lines, and comes out to the byte', () => {
  const shapes = {
    'a document start and a comment first': '---\n# mine\nname: x\nversion: 1.0.0\nschema: v1\n',
    'a quoted key': 'name: x\n"mcpServers":\n  - name: "memory"\n    command: npx\n',
    'a block scalar last': 'name: x\nrules:\n  - |\n    be terse\n    always\n',
    'a name that is not the first key, and one nested deeper': 'name: x\nmcpServers:\n  - command: npx\n    name: memory\n    env:\n      name: inner\n',
    'an item with no name': 'name: x\nmcpServers:\n  - uses: anthropic/memory-mcp\n    with:\n      KEY: v\n',
    'items four columns in': 'name: x\nmcpServers:\n    - name: memory\n      command: npx\n',
    'a comment ending the list': 'name: x\nmcpServers:\n  - name: memory\n    command: npx\n  # more later\n',
  };
  for (const [shape, config] of Object.entries(shapes)) {
    const r = roundTrip(config);
    assert.equal(r.connect.status, 'connected', `${shape}: ${r.connect.why}`);
    assert.ok(r.added.includes(r.item.replace(/^ {2}/gm, r.added.includes('\n    - name: memory') ? '    ' : '  ')), `${shape}:\n${r.added}`);
    assert.equal(r.again, 'already', shape);
    assert.equal(r.connected, true, shape);
    assert.equal(r.disconnect, 'removed', shape);
    assert.equal(r.after, config, shape);
  }
  // a file that does not end in a line break gets one before our key, and keeps it
  const unended = roundTrip(DEFAULT.trimEnd());
  assert.equal(unended.added, `${DEFAULT}mcpServers:\n${unended.item}`);
  assert.equal(unended.after, DEFAULT);
});

test('ours with a command the person changed (a full path to node) is already connected, and left as they wrote it', () => {
  const saved = process.env.CONTINUE_GLOBAL_DIR;
  delete process.env.CONTINUE_GLOBAL_DIR;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-continue-mine-')));
  try {
    const places = { home, toolPath: '', apps: null };
    const hookDir = path.join(home, '.agentmash', 'hooks');
    const file = path.join(home, '.continue', 'config.yaml');
    fs.mkdirSync(path.dirname(file));
    const mine = `${DEFAULT}mcpServers:\n${continueItem(hookDir).replace('command: node', 'command: /opt/node/bin/node')}`;
    fs.writeFileSync(file, mine);
    assert.equal(cont.connect(places, hookDir).status, 'already');
    assert.equal(read(file), mine);
    assert.equal(cont.inspect(places).connected, true);
    assert.equal(cont.disconnect(places).status, 'removed');
    assert.equal(read(file), DEFAULT);
  } finally {
    if (saved !== undefined) process.env.CONTINUE_GLOBAL_DIR = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
