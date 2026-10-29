// Kiro, as `npx agentmash login` connects it: a hooks file of our own in
// ~/.kiro/hooks, among the person's, and our MCP server in
// ~/.kiro/settings/mcp.json beside theirs; `logout` and `tools remove kiro`
// take out exactly that. Every test runs in a home of its own (fixtures/
// machine.mjs), with kiro-cli replaced by a stand-in, KIRO_HOME cleared
// unless a test sets it: nothing here may touch the real ~/.kiro.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS } from '../tools.mjs';
import { CLI_DIR, json, machine, md5, run, runsOurs, shownHere, startServer } from './fixtures/machine.mjs';

/** What is already in the person's Kiro, which must come through login and logout untouched. */
const THEIRS = {
  // a hook of their own, in a file of their own, in the folder ours goes in
  hooks: { version: 'v1', hooks: [{ name: 'lint-on-save', trigger: 'PostFileSave', matcher: '\\.ts$', action: { type: 'command', command: 'npm run lint' } }] },
  mcp: { mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_theirs' }, disabled: false } } },
  cli: { 'chat.defaultAgent': 'kiro_default' },
};

/** A machine with Kiro on it: kiro-cli on the tool path, and ~/.kiro with the person's hooks and servers in it. */
function kiroMachine({ kiro = true, cli = true } = {}) {
  const m = machine({
    with: cli ? ['kiro-cli'] : [],
    codex: false,
    cursor: false,
    copilot: false,
    scripts: { 'kiro-cli': `if (process.argv[2] === '--version') console.log('kiro-cli 2.27.1');` },
  });
  const dir = path.join(m.home, '.kiro');
  const at = {
    dir,
    theirs: path.join(dir, 'hooks', 'lint-on-save.json'),
    ours: path.join(dir, 'hooks', 'agentmash.json'),
    mcp: path.join(dir, 'settings', 'mcp.json'),
    cli: path.join(dir, 'settings', 'cli.json'),
  };
  if (kiro) {
    fs.mkdirSync(path.dirname(at.theirs), { recursive: true });
    fs.mkdirSync(path.dirname(at.mcp), { recursive: true });
    fs.writeFileSync(at.theirs, JSON.stringify(THEIRS.hooks, null, 2));
    // as JSON is written with two spaces and a newline at the end: a file of
    // theirs in any other layout comes back the same JSON, laid out that way
    fs.writeFileSync(at.mcp, `${JSON.stringify(THEIRS.mcp, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(at.mcp, 0o600);
    fs.writeFileSync(at.cli, JSON.stringify(THEIRS.cli));
  }
  return { ...m, at };
}

const command = (m, event) => `node "${path.join(m.hookDir, 'agent_hook.mjs')}" ${event} --global --client kiro --dialect kiro`;
const mode = (file) => fs.statSync(file).mode & 0o777;
const POSIX = { skip: process.platform === 'win32' && 'POSIX modes and symlinks' };

test('login finds Kiro and connects it at user level: a hooks file of our own, our server after theirs, nothing of theirs moved', async () => {
  const server = await startServer();
  const m = kiroMachine();
  const before = { theirs: md5(m.at.theirs), cli: md5(m.at.cli) };
  try {
    const out = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/Kiro\s+connected\s+~\/\.kiro\/hooks\/agentmash\.json/));
    assert.match(out.stdout, /refusing its first edit of a file a teammate is in; the same edit again goes through/);
    assert.match(out.stdout, /kiro-cli on its V3 engine \(kiro-cli --v3\); its default engine runs none of them/);

    // our file: Kiro's v1 format, three hooks, each the generic hook in the kiro dialect
    const ours = json(m.at.ours);
    assert.equal(ours.version, 'v1');
    assert.deepEqual(ours.hooks.map((h) => [h.name, h.trigger, h.matcher ?? null]), [
      ['agentmash-before-edit', 'PreToolUse', 'fs_write|fs_append|str_replace|delete_file'],
      ['agentmash-after-edit', 'PostToolUse', 'fs_write|fs_append|str_replace|delete_file'],
      ['agentmash-prompt', 'UserPromptSubmit', null],
    ]);
    assert.deepEqual(ours.hooks.map((h) => h.action), [
      { type: 'command', command: command(m, 'pre_edit') },
      { type: 'command', command: command(m, 'post_edit') },
      { type: 'command', command: command(m, 'prompt') },
    ]);
    assert.ok(ours.hooks.every((h) => h.timeout === 5 && h.enabled === true));
    for (const h of ours.hooks) assert.doesNotMatch(h.action.command, /\d+\.\d+\.\d+|bypass|trust|approve/i, 'the same string from one version to the next');
    // what those commands run is there, with the dialect they answer in
    assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')));
    assert.ok(
      fs.readFileSync(path.join(m.hookDir, 'dialects', 'kiro.mjs')).equals(fs.readFileSync(path.join(CLI_DIR, '..', 'hooks', 'dialects', 'kiro.mjs'))),
      'the dialect from this checkout'
    );

    // theirs: their hooks file and cli.json byte for byte, their server first and as it was, ours after
    assert.equal(md5(m.at.theirs), before.theirs);
    assert.equal(md5(m.at.cli), before.cli, 'their default agent is theirs: login switches nothing');
    const mcp = json(m.at.mcp);
    assert.deepEqual(Object.keys(mcp.mcpServers), ['github', 'agentmash']);
    assert.deepEqual(mcp.mcpServers.github, THEIRS.mcp.mcpServers.github);
    assert.deepEqual(mcp.mcpServers.agentmash, { command: 'node', args: [path.join(m.hookDir, 'mcp_server.mjs')] }, 'no autoApprove: Kiro asks the person, as it would');
    assert.equal(fs.readdirSync(path.join(m.at.dir, 'hooks')).sort().join(), 'agentmash.json,lint-on-save.json');
    assert.deepEqual(fs.readdirSync(m.at.dir).sort(), ['hooks', 'settings'], 'no agent of ours, no permissions written');
  } finally {
    await server.close();
  }
});

test('login again is already connected, byte for byte, and a hook the person put in our file stays first', async () => {
  const server = await startServer();
  const m = kiroMachine();
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const before = { ours: md5(m.at.ours), mcp: md5(m.at.mcp) };
    const again = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Kiro\s+already connected/);
    assert.deepEqual({ ours: md5(m.at.ours), mcp: md5(m.at.mcp) }, before);

    // one of theirs, added to our file (Kiro's hook panel may), and ours out of date: theirs first, ours after
    const edited = json(m.at.ours);
    const mine = { name: 'my-check', trigger: 'PreToolUse', matcher: 'execute_bash', action: { type: 'command', command: './check.sh' } };
    edited.hooks = [edited.hooks[0], mine, edited.hooks[2]];
    fs.writeFileSync(m.at.ours, JSON.stringify(edited, null, 2));
    const third = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.match(third.stdout, /Kiro\s+connected/);
    const hooks = json(m.at.ours).hooks;
    assert.deepEqual(hooks[0], mine);
    assert.deepEqual(hooks.slice(1).map((h) => h.name), ['agentmash-before-edit', 'agentmash-after-edit', 'agentmash-prompt']);

    // and logout takes ours out of it, and leaves theirs, alone, in it
    await run(['logout'], m.env);
    assert.deepEqual(json(m.at.ours), { version: 'v1', hooks: [mine] });
  } finally {
    await server.close();
  }
});

test('logout takes out everything login wrote for Kiro, and leaves the person\'s files byte for byte as they were', async () => {
  const server = await startServer();
  const m = kiroMachine();
  const before = { theirs: md5(m.at.theirs), mcp: md5(m.at.mcp), cli: md5(m.at.cli) };
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.ok(!fs.existsSync(m.at.ours));
    assert.deepEqual({ theirs: md5(m.at.theirs), mcp: md5(m.at.mcp), cli: md5(m.at.cli) }, before);
    assert.ok(fs.existsSync(path.dirname(m.at.theirs)), 'their hooks folder stays');
    assert.ok(!fs.existsSync(m.hookDir), 'nothing runs the scripts any more');

    // a Kiro with no hooks of its own: the folder login made for ours goes with it, and an mcp.json that held only ours
    const bare = kiroMachine({ kiro: false });
    fs.mkdirSync(bare.at.dir);
    await run(['login', '--server', server.url, '--no-open'], bare.env);
    assert.ok(fs.existsSync(bare.at.ours) && fs.existsSync(bare.at.mcp));
    await run(['logout'], bare.env);
    assert.ok(!fs.existsSync(path.dirname(bare.at.ours)));
    assert.ok(!fs.existsSync(bare.at.mcp));
  } finally {
    await server.close();
  }
});

test('tools lists Kiro by its version, and adds or removes it on its own', async () => {
  const m = kiroMachine();
  const list = await run(['tools'], m.env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /kiro\s+Kiro\s+found · kiro-cli 2\.27\.1\s+not connected/);

  const add = await run(['tools', 'add', 'kiro'], m.env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /Kiro\s+connected/);
  assert.ok(fs.existsSync(m.at.ours));
  assert.match((await run(['tools'], m.env)).stdout, /kiro\s+Kiro\s+found · kiro-cli 2\.27\.1\s+connected/);

  const remove = await run(['tools', 'remove', 'kiro'], m.env);
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /Kiro\s+disconnected/);
  assert.ok(!fs.existsSync(m.at.ours));
  assert.deepEqual(json(m.at.mcp), THEIRS.mcp);
  assert.match((await run(['tools'], m.env)).stdout, /kiro\s+Kiro\s+found · kiro-cli 2\.27\.1\s+not connected/);

  // found by its app, or its folder, with no kiro-cli; not found with none of them
  const app = kiroMachine({ kiro: false, cli: false });
  fs.mkdirSync(path.join(app.env.AGENTMASH_APPS_DIR, 'Kiro.app'), { recursive: true });
  assert.match((await run(['tools'], app.env)).stdout, /kiro\s+Kiro\s+found\s+not connected/);
  assert.match((await run(['tools'], kiroMachine({ kiro: false, cli: false }).env)).stdout, /kiro\s+Kiro\s+not found/);
});

test('doctor says where Kiro\'s hooks are and that its server is registered, and when a script they run is gone', async () => {
  const server = await startServer();
  const m = kiroMachine();
  try {
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const doctor = await run(['doctor'], m.env, m.home);
    assert.match(doctor.stdout, shownHere(/Kiro: hooks in ~\/\.kiro\/hooks\/agentmash\.json \(3 events\) · MCP server registered/));
    assert.doesNotMatch(doctor.stdout, /Kiro[^\n]*approv/, 'Kiro asks nobody to approve a hook');

    fs.rmSync(path.join(m.hookDir, 'dialects', 'kiro.mjs'));
    const silent = await run(['doctor'], m.env, m.home);
    assert.match(silent.stdout, /✗ Kiro: runs .*dialects[\\/]kiro\.mjs, which does not exist/, 'without its dialect every answer is silence');
    assert.equal(silent.code, 1);

    fs.rmSync(path.join(m.hookDir, 'agent_hook.mjs'));
    assert.match((await run(['doctor'], m.env, m.home)).stdout, /✗ Kiro: runs .*agent_hook\.mjs, which does not exist — every call fails/);
  } finally {
    await server.close();
  }
});

test('a hooks file login cannot read is skipped and named, and logout keeps the scripts a file it cannot read may still run', async () => {
  const server = await startServer();
  try {
    // our file broken by hand: nothing written over it, and said
    const broken = kiroMachine();
    fs.writeFileSync(broken.at.ours, '{ "version": "v1", "hooks": [ ');
    const skipped = await run(['login', '--server', server.url, '--no-open'], broken.env);
    assert.equal(skipped.code, 0, skipped.stderr);
    assert.match(skipped.stdout, shownHere(/Kiro\s+skipped — ~\/\.kiro\/hooks\/agentmash\.json is not valid JSON — fix it, then run login again/));
    assert.equal(fs.readFileSync(broken.at.ours, 'utf8'), '{ "version": "v1", "hooks": [ ');
    assert.doesNotMatch(fs.readFileSync(broken.at.mcp, 'utf8'), /agentmash/);

    // a format login does not know is not written into either
    const other = kiroMachine();
    fs.writeFileSync(other.at.ours, JSON.stringify({ version: 'v2', hooks: [] }));
    assert.match((await run(['login', '--server', server.url, '--no-open'], other.env)).stdout, shownHere(/Kiro\s+skipped — ~\/\.kiro\/hooks\/agentmash\.json is in hook format "v2", not v1/));

    // an mcp.json that is not JSON: the hooks go in, the server does not, and that is said
    const m = kiroMachine();
    fs.writeFileSync(m.at.mcp, '// mine\n{}');
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.match(login.stdout, /Kiro\s+connected/);
    assert.match(login.stdout, shownHere(/~\/\.kiro\/settings\/mcp\.json is not valid JSON: the MCP server was not added/));

    // broken after login: logout names it, keeps the scripts it may still run, and signs out all the same
    const later = kiroMachine();
    await run(['login', '--server', server.url, '--no-open'], later.env);
    fs.writeFileSync(later.at.ours, fs.readFileSync(later.at.ours, 'utf8').replace(/\}\s*$/, ',}'));
    const out = await run(['logout'], later.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/~\/\.kiro\/hooks\/agentmash\.json is not valid JSON: agentmash is still in it/));
    assert.match(out.stdout, shownHere(/kept .*\.agentmash\/hooks/));
    assert.ok(fs.existsSync(path.join(later.hookDir, 'agent_hook.mjs')), 'what Kiro still runs is still there');
    assert.ok(!fs.existsSync(path.join(later.home, '.agentmash', 'user.json')));
    assert.ok(!runsOurs(fs.readFileSync(later.at.mcp, 'utf8')), 'the server came out of the file that reads');
  } finally {
    await server.close();
  }
});

test('a symlinked mcp.json stays a link, a private one stays private, a new one starts private', POSIX, async () => {
  const server = await startServer();
  try {
    const m = kiroMachine();
    // ~/.kiro/settings/mcp.json as stow or chezmoi leave it: a link into the person's dotfiles
    const dotfiles = path.join(m.home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const target = path.join(dotfiles, 'kiro-mcp.json');
    fs.renameSync(m.at.mcp, target);
    fs.symlinkSync(target, m.at.mcp);
    const before = md5(target);

    await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.ok(fs.lstatSync(m.at.mcp).isSymbolicLink(), 'still the link');
    assert.ok(json(target).mcpServers.agentmash, 'ours went into what it points at');
    assert.equal(mode(target), 0o600, 'a file that holds their token stays private');
    for (const dir of [path.dirname(m.at.mcp), path.dirname(m.at.ours), dotfiles]) {
      assert.deepEqual(fs.readdirSync(dir).filter((f) => /tmp/.test(f)), [], `no temporary file left in ${dir}`);
    }
    await run(['logout'], m.env);
    assert.ok(fs.lstatSync(m.at.mcp).isSymbolicLink());
    assert.equal(md5(target), before, 'byte for byte');

    // no mcp.json yet: the one login makes is private from the start
    const fresh = kiroMachine({ kiro: false });
    fs.mkdirSync(fresh.at.dir);
    await run(['login', '--server', server.url, '--no-open'], fresh.env);
    assert.equal(mode(fresh.at.mcp), 0o600);
  } finally {
    await server.close();
  }
});

test('KIRO_HOME moves the MCP server, not the hooks, and login says so; --skip kiro leaves Kiro as it is', async () => {
  const server = await startServer();
  try {
    const m = kiroMachine();
    const elsewhere = path.join(m.home, 'kiro-elsewhere');
    const env = { ...m.env, KIRO_HOME: elsewhere };
    const out = await run(['login', '--server', server.url, '--no-open'], env);
    assert.equal(out.code, 0, out.stderr);
    assert.ok(fs.existsSync(m.at.ours), "the hooks where Kiro's docs say global hooks are read");
    assert.ok(json(path.join(elsewhere, 'settings', 'mcp.json')).mcpServers.agentmash);
    assert.doesNotMatch(fs.readFileSync(m.at.mcp, 'utf8'), /agentmash/);
    assert.match(out.stdout, shownHere(/KIRO_HOME is set: the hooks went in ~\/\.kiro\/hooks\/agentmash\.json/));
    await run(['logout'], env);
    assert.ok(!fs.existsSync(path.join(elsewhere, 'settings', 'mcp.json')));

    const skipped = kiroMachine();
    const before = md5(skipped.at.mcp);
    const out2 = await run(['login', '--server', server.url, '--no-open', '--skip', 'kiro'], skipped.env);
    assert.match(out2.stdout, /Kiro\s+skipped — left out with --skip/);
    assert.ok(!fs.existsSync(skipped.at.ours));
    assert.equal(md5(skipped.at.mcp), before);
  } finally {
    await server.close();
  }
});

test('what login registers with Kiro is the same strings every time, with no version in them', { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  const kiro = AGENTS.kiro;
  assert.deepEqual([kiro.id, kiro.name, kiro.env], ['kiro', 'Kiro', ['KIRO_HOME']]);
  assert.ok(kiro.order > AGENTS.devin.order, 'after the agents connected first');
  assert.equal(kiro.approvalHint, undefined, 'Kiro asks nobody to approve a hook');
  const dir = '/home/someone/.agentmash/hooks';
  assert.deepEqual(kiro.hooks(dir), kiro.hooks(dir));
  assert.deepEqual(
    kiro.hooks(dir).hooks.map((h) => h.action.command),
    [
      'node "/home/someone/.agentmash/hooks/agent_hook.mjs" pre_edit --global --client kiro --dialect kiro',
      'node "/home/someone/.agentmash/hooks/agent_hook.mjs" post_edit --global --client kiro --dialect kiro',
      'node "/home/someone/.agentmash/hooks/agent_hook.mjs" prompt --global --client kiro --dialect kiro',
    ]
  );
  // what logout looks in before it takes the scripts away (KIRO_HOME is this process's, so set aside)
  const saved = process.env.KIRO_HOME;
  delete process.env.KIRO_HOME;
  try {
    assert.deepEqual(kiro.files({ home: '/home/someone' }), { hooks: '/home/someone/.kiro/hooks/agentmash.json', mcp: '/home/someone/.kiro/settings/mcp.json' });
  } finally {
    if (saved !== undefined) process.env.KIRO_HOME = saved;
  }
});
