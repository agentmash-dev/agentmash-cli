// Antigravity (agents/antigravity.mjs): `npx agentmash tools add antigravity`
// puts one hook of ours in ~/.gemini/config/hooks.json, after the person's,
// and our MCP server in ~/.gemini/config/mcp_config.json; logout takes out
// exactly that, so both files are byte for byte what they were. A plain
// login leaves Antigravity out until it is asked for. Every test runs in a
// home of its own (fixtures/machine.mjs), with agy replaced by a stand-in:
// nothing here touches the real ~/.gemini.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import antigravity, { HOOK_NAME, antigravityHooks } from '../agents/antigravity.mjs';
import { CLI_DIR, OURS, json, machine as aMachine, md5, run, shownHere, startServer } from './fixtures/machine.mjs';

/** The person's own hook, as they wrote it, in their own layout: four spaces, no newline at the end. */
const THEIR_HOOKS =
  '{\n    "my-guard": {\n        "PreToolUse": [\n            {\n                "matcher": "run_command",\n' +
  '                "hooks": [{ "type": "command", "command": "/usr/local/bin/my-guard", "timeout": 5 }]\n            }\n        ]\n    }\n}';
const THEIR_MCP = JSON.stringify({ mcpServers: { sentry: { command: 'npx', args: ['sentry-mcp'] } } }, null, 2) + '\n';

/** A home with agy in it (its folder and a stand-in command), and the person's hooks and MCP servers. */
function machine({ hooks = THEIR_HOOKS, mcp = THEIR_MCP, agy = true } = {}) {
  const m = aMachine({
    with: agy ? ['agy'] : [],
    codex: false,
    cursor: false,
    copilot: false,
    scripts: { agy: "if (process.argv[2] === '--version') console.log('1.2.16');" },
  });
  const config = path.join(m.home, '.gemini', 'config');
  fs.mkdirSync(config, { recursive: true });
  if (agy) fs.mkdirSync(path.join(m.home, '.gemini', 'antigravity-cli'));
  const at = { hooks: path.join(config, 'hooks.json'), mcp: path.join(config, 'mcp_config.json') };
  if (hooks !== null) fs.writeFileSync(at.hooks, hooks);
  if (mcp !== null) fs.writeFileSync(at.mcp, mcp);
  return { ...m, ...at };
}

const ours = (m) => antigravityHooks(m.hookDir)[HOOK_NAME];
const mode = (file) => fs.statSync(file).mode & 0o777;

test('a plain login leaves Antigravity out, says how to connect it, and touches neither of its files', async () => {
  const server = await startServer();
  const m = machine();
  try {
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, /Claude Code\s+connected/);
    assert.match(login.stdout, /Antigravity\s+skipped — .*npx agentmash tools add antigravity/);
    assert.equal(fs.readFileSync(m.hooks, 'utf8'), THEIR_HOOKS);
    assert.equal(fs.readFileSync(m.mcp, 'utf8'), THEIR_MCP);
  } finally {
    await server.close();
  }
});

test("tools add connects it at user level: the person's hook first and as they wrote it, then ours, in the shape each event takes, and no PreToolUse", async () => {
  const m = machine();
  const add = await run(['tools', 'add', 'antigravity'], m.env);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, shownHere(/Antigravity\s+connected\s+~\/\.gemini\/config\/hooks\.json/));
  assert.match(add.stdout, /restart agy/);
  assert.match(add.stdout, /at the start of each turn, not before each edit/);
  assert.match(add.stdout, /only in repositories that carry a room of their own/, 'not signed in, and says what that costs');

  const text = fs.readFileSync(m.hooks, 'utf8');
  assert.ok(text.startsWith(THEIR_HOOKS.slice(0, THEIR_HOOKS.lastIndexOf('}')).trimEnd() + ',\n'), text);
  const hooks = JSON.parse(text);
  assert.deepEqual(Object.keys(hooks), ['my-guard', HOOK_NAME], 'theirs first, then ours, and nothing else at the top');
  assert.deepEqual(hooks['my-guard'], JSON.parse(THEIR_HOOKS)['my-guard']);
  const hook = hooks[HOOK_NAME];
  assert.deepEqual(hook, ours(m));
  assert.deepEqual(Object.keys(hook), ['enabled', 'PostToolUse', 'PreInvocation']);
  assert.equal(hook.PreToolUse, undefined, 'nothing that can refuse or approve a tool');
  // a tool event takes matcher groups; a model-call event a flat list of handlers, or agy drops the file
  assert.deepEqual(Object.keys(hook.PostToolUse[0]), ['matcher', 'hooks']);
  assert.equal(hook.PostToolUse[0].matcher, '^(write_to_file|replace_file_content|multi_replace_file_content|run_command)$');
  assert.deepEqual(Object.keys(hook.PreInvocation[0]), ['type', 'command', 'timeout']);
  const handlers = [...hook.PostToolUse[0].hooks, ...hook.PreInvocation];
  // the script quoted, but bare on Windows, where agy keeps the quotes (agents/antigravity.mjs)
  const script = process.platform === 'win32' ? path.join(m.hookDir, 'agent_hook.mjs') : `"${path.join(m.hookDir, 'agent_hook.mjs')}"`;
  assert.deepEqual(
    handlers.map((h) => h.command),
    ['post_edit', 'prompt'].map((event) => `node ${script} ${event} --global --client antigravity`)
  );
  for (const h of handlers) {
    assert.equal(h.type, 'command');
    assert.equal(h.timeout, 10, 'seconds');
    assert.doesNotMatch(h.command, /\d+\.\d+\.\d+|allow|bypass|trust|--dialect/i, h.command);
  }
  assert.ok(fs.existsSync(path.join(m.hookDir, 'agent_hook.mjs')));
  assert.ok(fs.existsSync(path.join(m.hookDir, 'dialects', 'antigravity.mjs')), 'the dialect the hook answers in');

  const mcp = json(m.mcp);
  assert.deepEqual(Object.keys(mcp.mcpServers), ['sentry', 'agentmash']);
  assert.deepEqual(mcp.mcpServers.agentmash, { command: 'node', args: [path.join(m.hookDir, 'mcp_server.mjs')] });
  // nothing that loosens what Antigravity asks the person about
  assert.ok(!fs.existsSync(path.join(m.home, '.gemini', 'antigravity-cli', 'settings.json')));
  assert.deepEqual(m.calls(), [], 'agy itself is never run to connect it');
});

test('a second time is already connected, byte for byte, and logout takes out exactly what went in', async () => {
  const server = await startServer();
  const m = machine();
  try {
    await run(['tools', 'add', 'antigravity'], m.env);
    const hooks = md5(m.hooks);
    const mcp = md5(m.mcp);
    const again = await run(['tools', 'add', 'antigravity'], m.env);
    assert.match(again.stdout, /Antigravity\s+already connected/);
    const login = await run(['login', '--server', server.url, '--no-open', '--tools', 'claude,antigravity'], m.env);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, /Antigravity\s+already connected/);
    assert.deepEqual([md5(m.hooks), md5(m.mcp)], [hooks, mcp]);

    const out = await run(['logout'], m.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /took agentmash out of every agent on this machine/);
    assert.equal(fs.readFileSync(m.hooks, 'utf8'), THEIR_HOOKS, 'their layout and all');
    assert.equal(fs.readFileSync(m.mcp, 'utf8'), THEIR_MCP);
    assert.ok(!fs.existsSync(m.hookDir));
  } finally {
    await server.close();
  }
});

test('tools lists it, adds and removes it, and a login keeps it connected once it is', async () => {
  const server = await startServer();
  const m = machine();
  try {
    const list = await run(['tools'], m.env);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /antigravity\s+Antigravity\s+found · 1\.2\.16\s+not connected/);

    await run(['tools', 'add', 'antigravity'], m.env);
    assert.match((await run(['tools'], m.env)).stdout, /antigravity\s+Antigravity\s+found · 1\.2\.16\s+connected/);
    const login = await run(['login', '--server', server.url, '--no-open'], m.env);
    assert.match(login.stdout, /Antigravity\s+already connected/, 'asked for once, kept up to date by every login after');

    const remove = await run(['tools', 'remove', 'antigravity'], m.env);
    assert.equal(remove.code, 0, remove.stderr);
    assert.match(remove.stdout, /Antigravity\s+disconnected/);
    assert.equal(fs.readFileSync(m.hooks, 'utf8'), THEIR_HOOKS);
    assert.equal(fs.readFileSync(m.mcp, 'utf8'), THEIR_MCP);
    assert.match((await run(['tools', 'remove', 'antigravity'], m.env)).stdout, /Antigravity\s+was not connected/);

    // found by any of its own folders or apps, never by ~/.gemini alone, which the Gemini CLI writes to too
    const none = machine({ agy: false });
    assert.match((await run(['tools'], none.env)).stdout, /antigravity\s+Antigravity\s+not found/);
    fs.mkdirSync(path.join(none.home, 'Applications', 'Antigravity.app'), { recursive: true });
    assert.match((await run(['tools'], none.env)).stdout, /antigravity\s+Antigravity\s+found\s+not connected/);
  } finally {
    await server.close();
  }
});

test('doctor says where its hooks are, that it is there and not connected, and when the script they run is gone', async () => {
  const server = await startServer();
  const m = machine();
  try {
    // signed in, with Claude Code alone
    await run(['login', '--server', server.url, '--no-open', '--tools', 'claude'], m.env);
    const before = await run(['doctor'], m.env, m.home);
    assert.match(before.stdout, /Antigravity is on this machine and not connected — npx agentmash tools add antigravity/);

    await run(['tools', 'add', 'antigravity'], m.env);
    const doctor = await run(['doctor'], m.env, m.home);
    assert.match(doctor.stdout, shownHere(/✓ Antigravity: hooks in ~\/\.gemini\/config\/hooks\.json \(2 events\) · MCP server registered/));

    fs.rmSync(path.join(m.hookDir, 'agent_hook.mjs'));
    const broken = await run(['doctor'], m.env, m.home);
    assert.match(broken.stdout, /✗ Antigravity: runs .*agent_hook\.mjs, which does not exist — every call fails — run: npx agentmash login/);
    assert.equal(broken.code, 1);
  } finally {
    await server.close();
  }
});

test('a hooks file that is not JSON is never written to and is named; one that never held ours is not mentioned at logout', async () => {
  const server = await startServer();
  try {
    // agy drops the whole of a hooks file it cannot read, the person's hooks with it
    const broken = `// mine\n${THEIR_HOOKS}`;
    const m = machine({ hooks: broken });
    const add = await run(['tools', 'add', 'antigravity'], m.env);
    assert.equal(add.code, 0, add.stderr);
    assert.match(add.stdout, shownHere(/Antigravity\s+skipped — ~\/\.gemini\/config\/hooks\.json is not valid JSON/));
    assert.equal(fs.readFileSync(m.hooks, 'utf8'), broken);
    assert.equal(fs.readFileSync(m.mcp, 'utf8'), THEIR_MCP, 'nothing half-connected');
    await run(['login', '--server', server.url, '--no-open'], m.env);
    const quiet = await run(['logout'], m.env);
    assert.doesNotMatch(quiet.stdout, /hooks\.json is not valid JSON/);
    assert.equal(fs.readFileSync(m.hooks, 'utf8'), broken);

    // broken by hand after ours went in: said, and the scripts it still runs are kept
    const n = machine();
    await run(['login', '--server', server.url, '--no-open'], n.env);
    await run(['tools', 'add', 'antigravity'], n.env);
    fs.writeFileSync(n.hooks, fs.readFileSync(n.hooks, 'utf8').replace(/\}\s*$/, ',}'));
    const out = await run(['logout'], n.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, shownHere(/~\/\.gemini\/config\/hooks\.json is not valid JSON: agentmash is still in it/));
    assert.match(out.stdout, shownHere(/kept .*\.agentmash\/hooks/));
    assert.ok(fs.existsSync(path.join(n.hookDir, 'agent_hook.mjs')), 'what agy still runs is still there');
    assert.equal(fs.readFileSync(n.mcp, 'utf8'), THEIR_MCP, 'the MCP server came out all the same');
  } finally {
    await server.close();
  }
});

test('a symlinked hooks file stays a link, a private MCP file stays private, and a new one starts private', { skip: process.platform === 'win32' && 'POSIX modes and symlinks' }, async () => {
  const m = machine();
  fs.chmodSync(m.mcp, 0o600);
  const dotfiles = path.join(m.home, 'dotfiles');
  fs.mkdirSync(dotfiles);
  fs.renameSync(m.hooks, path.join(dotfiles, 'agy-hooks.json'));
  fs.symlinkSync(path.join(dotfiles, 'agy-hooks.json'), m.hooks);

  await run(['tools', 'add', 'antigravity'], m.env);
  assert.ok(fs.lstatSync(m.hooks).isSymbolicLink(), 'still the link');
  assert.ok(json(path.join(dotfiles, 'agy-hooks.json'))[HOOK_NAME], 'and ours went into what it points at');
  assert.equal(mode(m.mcp), 0o600, 'a file that may hold tokens stays private');
  for (const dir of [path.dirname(m.hooks), dotfiles]) assert.deepEqual(fs.readdirSync(dir).filter((f) => /tmp/.test(f)), [], `no temporary file left in ${dir}`);

  await run(['tools', 'remove', 'antigravity'], m.env);
  assert.ok(fs.lstatSync(m.hooks).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(dotfiles, 'agy-hooks.json'), 'utf8'), THEIR_HOOKS);
  assert.equal(mode(m.mcp), 0o600);

  // nothing of agy's there yet: both files made, the MCP one private, and gone again after
  const fresh = machine({ hooks: null, mcp: null });
  await run(['tools', 'add', 'antigravity'], fresh.env);
  assert.deepEqual(json(fresh.hooks), antigravityHooks(fresh.hookDir));
  assert.equal(mode(fresh.mcp), 0o600);
  await run(['tools', 'remove', 'antigravity'], fresh.env);
  assert.ok(!fs.existsSync(fresh.hooks) && !fs.existsSync(fresh.mcp));
});

test("the person's switch is theirs, a hook called agentmash that is not ours is left alone, and ours from another folder is replaced where it stands", async () => {
  // switched off in /hooks: agy writes `enabled` in our hook, in its own layout
  const m = machine();
  await run(['tools', 'add', 'antigravity'], m.env);
  const off = json(m.hooks);
  off[HOOK_NAME] = { PreInvocation: off[HOOK_NAME].PreInvocation, PostToolUse: off[HOOK_NAME].PostToolUse, enabled: false };
  fs.writeFileSync(m.hooks, JSON.stringify(off));
  const before = md5(m.hooks);
  const again = await run(['tools', 'add', 'antigravity'], m.env);
  assert.match(again.stdout, /Antigravity\s+already connected/, 'the same hook, however agy ordered it');
  assert.match(again.stdout, /switched off in Antigravity \(\/hooks\): left off/);
  assert.equal(md5(m.hooks), before);

  // a hook of somebody else's by our name
  const theirs = JSON.stringify({ agentmash: { Stop: [{ type: 'command', command: 'echo mine' }] } }, null, 2);
  const n = machine({ hooks: theirs });
  const taken = await run(['tools', 'add', 'antigravity'], n.env);
  assert.match(taken.stdout, shownHere(/Antigravity\s+skipped — a hook called agentmash is in ~\/\.gemini\/config\/hooks\.json already, and not ours/));
  assert.equal(fs.readFileSync(n.hooks, 'utf8'), theirs);
  assert.equal(fs.readFileSync(n.mcp, 'utf8'), THEIR_MCP);

  // ours from another hooks folder (an older login), and one of ours the person copied into a hook of theirs
  const p = machine();
  const old = antigravityHooks('/old/.agentmash/hooks')[HOOK_NAME];
  const block = `,\n  "agentmash": ${JSON.stringify(old, null, 2).replace(/\n/g, '\n  ')}`;
  const at = THEIR_HOOKS.lastIndexOf('\n}');
  fs.writeFileSync(p.hooks, THEIR_HOOKS.slice(0, at) + block + THEIR_HOOKS.slice(at));
  const replaced = await run(['tools', 'add', 'antigravity'], p.env);
  assert.match(replaced.stdout, /Antigravity\s+connected/);
  assert.ok(fs.readFileSync(p.hooks, 'utf8').startsWith(THEIR_HOOKS.slice(0, at) + ',\n'), 'theirs as it was');
  assert.deepEqual(json(p.hooks)[HOOK_NAME], ours(p));
  await run(['tools', 'remove', 'antigravity'], p.env);
  assert.equal(fs.readFileSync(p.hooks, 'utf8'), THEIR_HOOKS, 'byte for byte');

  const q = machine();
  await run(['tools', 'add', 'antigravity'], q.env);
  const copied = json(q.hooks);
  copied['my-guard'].PostToolUse = [...ours(q).PostToolUse];
  fs.writeFileSync(q.hooks, JSON.stringify(copied, null, 2));
  await run(['tools', 'add', 'antigravity'], q.env);
  const once = json(q.hooks);
  assert.equal(once['my-guard'].PostToolUse, undefined, 'ours runs once, from our hook');
  assert.deepEqual(once['my-guard'].PreToolUse, JSON.parse(THEIR_HOOKS)['my-guard'].PreToolUse);
  await run(['tools', 'remove', 'antigravity'], q.env);
  assert.deepEqual(json(q.hooks), JSON.parse(THEIR_HOOKS));

  // a handler of theirs put in our hook stays, before ours, through an update of ours and out the other side of logout
  const r = machine();
  await run(['tools', 'add', 'antigravity'], r.env);
  const mine = { type: 'command', command: 'echo mine', timeout: 1 };
  const withMine = json(r.hooks);
  withMine[HOOK_NAME].PreInvocation.push(mine);
  fs.writeFileSync(r.hooks, JSON.stringify(withMine, null, 2).replaceAll(r.hookDir, '/old/.agentmash/hooks'));
  await run(['tools', 'add', 'antigravity'], r.env);
  assert.deepEqual(json(r.hooks)[HOOK_NAME].PreInvocation, [mine, ...ours(r).PreInvocation]);
  await run(['tools', 'remove', 'antigravity'], r.env);
  assert.deepEqual(json(r.hooks)[HOOK_NAME], { enabled: true, PreInvocation: [mine] });
});

test('what it registers is the same string every time, and it is the module the registry reads', { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  const dir = '/home/someone/.agentmash/hooks';
  assert.deepEqual(antigravity.hooks(dir), antigravityHooks(dir));
  assert.equal(
    crypto.createHash('md5').update(JSON.stringify(antigravityHooks(dir))).digest('hex'),
    'e956de3fb4a8ec32795f404a046ab08f',
    JSON.stringify(antigravityHooks(dir))
  );
  assert.deepEqual([antigravity.id, antigravity.name, antigravity.optIn, antigravity.env], ['antigravity', 'Antigravity', true, []]);
  const places = { home: '/h', toolPath: '', apps: null };
  assert.deepEqual(antigravity.files(places), { hooks: '/h/.gemini/config/hooks.json', mcp: '/h/.gemini/config/mcp_config.json' });
  assert.ok(Object.values(antigravityHooks(dir)[HOOK_NAME]).flat().every((e) => typeof e === 'boolean' || OURS.test(JSON.stringify(e))));
  assert.ok(fs.existsSync(path.join(CLI_DIR, '..', 'hooks', 'dialects', 'antigravity.mjs')), 'the dialect its hooks answer in ships beside them');
});
