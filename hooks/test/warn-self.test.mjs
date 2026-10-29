// AGENTMASH_WARN_SELF: a developer's own sessions warn each other before an
// edit, as a teammate's do. Off by default, read like AGENTMASH_STRICT (the
// environment, a .env, config.json). On, the pre-edit check asks the room to
// leave out this session's edits alone (self=session&session_id=…), and the
// room marks what is the developer's own from another session `yours`. That
// is said as "your other agent", never by their name, which would read as a
// teammate's; strict mode warns about it and never stops for it; and the
// ten-minute cooldown keeps it apart from the teammates it named.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as lib from '../lib.mjs';
import { HOOKS_DIR, baseEnv, machine, runHook, session, startServer, within } from './fixtures.mjs';

const FILE = 'src/models/user.ts';

/** loadConfig for a checkout with `lines` in .env, `inner` in .claude/agentmash/.env, and `committed` in config.json. */
function configWith(lines, committed = {}, inner = []) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-warn-self-')));
  fs.writeFileSync(path.join(dir, '.env'), lines.join('\n') + '\n');
  fs.mkdirSync(path.join(dir, '.claude', 'agentmash'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'agentmash', '.env'), inner.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, '.claude', 'agentmash', 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:1', room: 'mash_x', ...committed }));
  return lib.loadConfig(dir);
}

test('AGENTMASH_WARN_SELF is off unless said on, in the environment, either .env or config.json, as AGENTMASH_STRICT is', () => {
  delete process.env.AGENTMASH_WARN_SELF;
  assert.equal(configWith([]).warnSelf, false, 'off by default');
  for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' yes ']) assert.equal(configWith([`AGENTMASH_WARN_SELF=${v}`]).warnSelf, true, v);
  assert.equal(configWith(['AGENTMASH_WARN_SELF=1 # try the warning alone']).warnSelf, true, 'a comment after the value');
  assert.equal(configWith([], {}, ['AGENTMASH_WARN_SELF=on']).warnSelf, true, '.claude/agentmash/.env');
  assert.equal(configWith([], { warn_self: true }).warnSelf, true, 'config.json');
  for (const v of ['0', 'false', 'off', 'no']) assert.equal(configWith([`AGENTMASH_WARN_SELF=${v}`], { warn_self: true }).warnSelf, false, `${v} over config.json`);
  assert.equal(configWith(['AGENTMASH_WARN_SELF=0'], {}, ['AGENTMASH_WARN_SELF=1']).warnSelf, false, '<repo>/.env before .claude/agentmash/.env');
  assert.equal(configWith(['AGENTMASH_WARN_SELF=maybe'], { warn_self: true }).warnSelf, true, 'a word it does not know leaves it to config.json');
  assert.equal(configWith(['AGENTMASH_WARN_SELF=maybe']).warnSelf, false);
  assert.equal(configWith([], { warn_self: 'yes' }).warnSelf, false, 'config.json says it with true');
  process.env.AGENTMASH_WARN_SELF = '0';
  try {
    assert.equal(configWith(['AGENTMASH_WARN_SELF=1'], { warn_self: true }).warnSelf, false, 'the real environment first');
  } finally {
    delete process.env.AGENTMASH_WARN_SELF;
  }
});

const editPayload = (project, sessionId) => ({
  ...(sessionId === undefined ? {} : { session_id: sessionId }),
  cwd: project,
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: path.join(project, 'src', 'models', 'user.ts'), old_string: 'id', new_string: 'uid' },
});

const checksOf = (server) => server.requests.filter((r) => r.path === '/check').map((r) => r.query);

test('switched on, the check before an edit and before a shell command says which session is asking; off, or with no session, it does not', async () => {
  const server = await startServer({ holders: [] });
  const { env, project } = machine(server.port, { committed: true });
  try {
    const id = session();
    for (const payload of [
      editPayload(project, id),
      { session_id: id, cwd: project, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `echo hi > ${FILE}` } },
    ]) {
      const res = await runHook('pre_tool_use.mjs', payload, { ...env, AGENTMASH_WARN_SELF: '1' });
      assert.equal(res.code, 0, res.stderr);
    }
    const on = checksOf(server);
    assert.equal(on.length, 2, 'an edit and a command, each asked about');
    for (const q of on) {
      assert.equal(q.self, 'session');
      assert.equal(q.session_id, id, 'the id its edits are reported with');
      assert.equal(q.file_path, FILE);
    }

    server.requests.length = 0;
    await runHook('pre_tool_use.mjs', editPayload(project, session()), env);
    await runHook('pre_tool_use.mjs', editPayload(project, undefined), { ...env, AGENTMASH_WARN_SELF: '1' });
    const off = checksOf(server);
    assert.equal(off.length, 2);
    for (const q of off) assert.deepEqual([q.self, q.session_id], [undefined, undefined]);
    for (const q of [...on, ...off]) assert.equal(q.lobby_session, undefined, 'outside the desktop app, no app session');
  } finally {
    await server.close();
  }
});

/** The desktop app's id for a session it started, as its daemon hands it to everything it starts there. */
const HOSTED = 'ls_0f1e2d3c-4b5a-4968-8776-655443322110';

test("in a session the desktop app started, the check also names the app's session, with AGENTMASH_WARN_SELF and a session id only", async () => {
  const server = await startServer({ holders: [] });
  const { env, project } = machine(server.port, { committed: true });
  try {
    const id = session();
    for (const payload of [
      editPayload(project, id),
      { session_id: id, cwd: project, hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: `Set-Content -Path ${FILE} -Value hi` } },
    ]) {
      const res = await runHook('pre_tool_use.mjs', payload, { ...env, AGENTMASH_WARN_SELF: '1', AGENTMASH_LOBBY_SESSION: HOSTED });
      assert.equal(res.code, 0, res.stderr);
    }
    const on = checksOf(server);
    assert.equal(on.length, 2, 'an edit and a command, each asked about');
    for (const q of on) assert.deepEqual([q.self, q.session_id, q.lobby_session], ['session', id, HOSTED]);

    // not switched on, or no session of its own to ask as: the app's session is not said either
    server.requests.length = 0;
    await runHook('pre_tool_use.mjs', editPayload(project, session()), { ...env, AGENTMASH_LOBBY_SESSION: HOSTED });
    await runHook('pre_tool_use.mjs', editPayload(project, session()), { ...env, AGENTMASH_WARN_SELF: '0', AGENTMASH_LOBBY_SESSION: HOSTED });
    await runHook('pre_tool_use.mjs', editPayload(project, undefined), { ...env, AGENTMASH_WARN_SELF: '1', AGENTMASH_LOBBY_SESSION: HOSTED });
    // a value no session could have is not said
    for (const bad of ['not one id; rm -rf ~', 'x'.repeat(195), 'ls_one&self=checkout']) {
      await runHook('pre_tool_use.mjs', editPayload(project, session()), { ...env, AGENTMASH_WARN_SELF: '1', AGENTMASH_LOBBY_SESSION: bad });
    }
    const off = checksOf(server);
    assert.equal(off.length, 6);
    for (const q of off) assert.equal(q.lobby_session, undefined);
    for (const q of off.slice(3)) assert.equal(q.self, 'session', 'the session is still asked as itself');
  } finally {
    await server.close();
  }
});

test("lobbySessionId is the app's session in the one shape the app gives (ls_ and a random uuid), as lobbyContext reads it, or null", () => {
  const before = process.env.AGENTMASH_LOBBY_SESSION;
  const said = (value) => {
    if (value === undefined) delete process.env.AGENTMASH_LOBBY_SESSION;
    else process.env.AGENTMASH_LOBBY_SESSION = value;
    return lib.lobbySessionId();
  };
  try {
    assert.equal(said(HOSTED), HOSTED);
    for (const value of [
      undefined,
      '',
      'y'.repeat(194),
      'ls_one',
      HOSTED.toUpperCase(),
      `${HOSTED} `,
      `${HOSTED}x`,
      HOSTED.replace('-4968-', '-1968-'),
      'not one id; rm -rf ~',
      'ls_one&self=checkout',
      'ls one',
      'ls_é',
    ]) {
      assert.equal(said(value), null, JSON.stringify(value));
    }
  } finally {
    said(before);
  }
});

/**
 * What the MCP server holds a claim_work claim under, started with `env` as an
 * agent starts it: over stdio, by hand, so its session file (if any) is the one
 * kept for this test's process. The room is `server`, which records the claim.
 */
async function claimedUnder(server, project, env) {
  const child = spawn(process.execPath, [path.join(HOOKS_DIR, 'mcp_server.mjs')], {
    env: { ...baseEnv, CLAUDE_PROJECT_DIR: project, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-warn-self-claude-')), ...env },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const answers = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (message.id !== undefined) answers.set(message.id, message);
    }
  });
  const call = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const deadline = Date.now() + within(4000);
    while (!answers.has(id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(answers.has(id), `an answer to ${method}`);
  };
  try {
    const before = server.requests.length;
    await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'warn-self-test', version: '0' } });
    await call(2, 'tools/call', { name: 'claim_work', arguments: { task: 'rework the user model', paths: [FILE] } });
    const claims = server.requests.slice(before).filter((r) => r.path === '/claims');
    assert.equal(claims.length, 1, 'one claim made');
    return claims[0].body.session_id;
  } finally {
    child.kill();
  }
}

test("with AGENTMASH_WARN_SELF and no Claude Code session of its own, the MCP server holds claims under the desktop app's session, which the check names", async () => {
  const server = await startServer({ holders: [] });
  const { env, project } = machine(server.port, { committed: true });
  const minted = /^mcp-[A-Za-z0-9_-]+$/;
  try {
    // codex in the app: lobby:<the app's session>, the one its hooks send as lobby_session
    const on = { ...env, AGENTMASH_WARN_SELF: '1' };
    assert.equal(await claimedUnder(server, project, { ...on, AGENTMASH_LOBBY_SESSION: HOSTED }), `lobby:${HOSTED}`);

    // without the switch nothing changes: an id the process mints, as ever, in the app or not
    assert.match(await claimedUnder(server, project, { ...env, AGENTMASH_LOBBY_SESSION: HOSTED }), minted);
    assert.match(await claimedUnder(server, project, { ...env, AGENTMASH_WARN_SELF: '0', AGENTMASH_LOBBY_SESSION: HOSTED }), minted);

    // outside the app, or with a value the app never gives: an id the process mints, as ever
    assert.match(await claimedUnder(server, project, on), minted);
    for (const bad of ['not one id; rm -rf ~', 'x'.repeat(194), 'ls_one', HOSTED.toUpperCase(), '']) {
      assert.match(await claimedUnder(server, project, { ...on, AGENTMASH_LOBBY_SESSION: bad }), minted, JSON.stringify(bad));
    }

    // claude code in the app keeps a session file for the process that starts this one: that id comes first,
    // the one its hooks send as session_id
    const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-warn-self-claude-'));
    fs.mkdirSync(path.join(claude, 'sessions'));
    fs.writeFileSync(path.join(claude, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'claude-in-the-app' }));
    assert.equal(await claimedUnder(server, project, { ...on, CLAUDE_CONFIG_DIR: claude, AGENTMASH_LOBBY_SESSION: HOSTED }), 'claude-in-the-app');
  } finally {
    await server.close();
  }
});

/** Bob's own other session, as the room hands it back with self=session. */
const YOURS = {
  developer: 'bob',
  yours: true,
  task_hint: 'add a role field to the user model',
  minutes_ago: 1,
  branch: 'feat/login',
  file_path: FILE,
  change_summary: 'Edit +3/-1 lines, touching User',
  presence: 'active',
};
const ALICE = { developer: 'alice', task_hint: 'add soft deletes', minutes_ago: 2, branch: 'feat/other', file_path: FILE, change_summary: '+3/-1 lines' };

test('his own other session is your other agent, named by its task and never by his name, at every level', () => {
  const at = (holder, over = {}) => lib.buildCollisionAdvice({ file: FILE, branch: 'feat/login', checkout: 'co_here', holders: [{ ...holder }], ...over });

  // the same checkout: their write is in front of this agent
  const same = at({ ...YOURS, checkout_id: 'co_here' });
  assert.equal(same.level, 'active');
  assert.match(same.text, /^\[AgentMash: ACTIVE COLLISION\] your other agent is inside src\/models\/user\.ts — last write 1 min ago on your branch \(feat\/login\), while working on 'add a role field to the user model'/);
  assert.match(same.text, /Their write is already in your working tree/);
  assert.match(same.text, /Leave User named and shaped as your other agent left it/);
  assert.doesNotMatch(same.text, /bob/);

  // a worktree of its own on the same branch name: a merge forming, not a stale read
  const apart = at({ ...YOURS, checkout_id: 'co_worktree' });
  assert.equal(apart.level, 'parallel');
  assert.match(apart.text, /^\[AgentMash: PARALLEL EDIT\] your other agent modified src\/models\/user\.ts 1 min ago on feat\/login, as you are, in a checkout of their own/);
  assert.match(apart.text, /re-reading the file won't show it/);

  // gone, said as gone, from a sentence that starts with it
  const ended = at({ ...YOURS, checkout_id: 'co_here', presence: 'ended', presence_label: 'ended their session 3 min ago' });
  assert.equal(ended.level, 'stale');
  assert.match(ended.text, /^\[AgentMash: STALE READ\] your other agent left src\/models\/user\.ts changed/);
  assert.match(ended.text, / Your other agent ended their session 3 min ago — reported by their own client/);
  assert.match(ended.text, /say so in your reply: your other agent is not here to watch it happen/);
  assert.doesNotMatch(ended.text, /bob/);

  // beside a teammate, each is who they are
  const both = lib.buildCollisionAdvice({ file: FILE, branch: 'feat/login', checkout: 'co_here', holders: [ALICE, { ...YOURS, checkout_id: 'co_here' }] });
  assert.match(both.text, /^\[AgentMash: ACTIVE COLLISION\] your other agent/);
  assert.match(both.text, /Also recently in this area: alice \(2 min ago\)\./);
  const first = lib.buildCollisionAdvice({ file: FILE, branch: 'feat/login', checkout: 'co_here', holders: [{ ...ALICE, branch: 'feat/login', checkout_id: 'co_here', minutes_ago: 0 }, { ...YOURS, branch: 'feat/other' }] });
  assert.match(first.text, /^\[AgentMash: ACTIVE COLLISION\] alice's agent/);
  assert.match(first.text, /Also recently in this area: your other agent \(1 min ago\)\./);

  // "your other agent" is no name for an acknowledgement to be grounded in
  const facts = lib.holderFacts({ ...YOURS, checkout_id: 'co_here' }, FILE, 'feat/login', 'co_here');
  assert.equal(facts.who, 'your other agent');
  assert.ok(!lib.ackGrounding(facts).particulars.includes('your other agent'));

  // a holder the room did not mark is a teammate, whatever its name
  assert.match(at({ ...YOURS, yours: undefined, checkout_id: 'co_here' }).text, /^\[AgentMash: ACTIVE COLLISION\] bob's agent is inside/);
});

test("his own other session's claim is your other agent's claim", () => {
  const advice = lib.buildClaimAdvice({
    file: FILE,
    claims: [{ developer: 'bob', yours: true, task: 'rework the user model', paths: [FILE], overlap: { paths: [FILE] }, created_ts: Date.now() - 60_000, expires_ts: Date.now() + 59 * 60_000 }],
  });
  assert.match(advice.text, /^\[AgentMash: CLAIMED\] your other agent has claimed this file for 'rework the user model' — claimed 1 min ago/);
  assert.match(advice.text, /say in your reply that your other agent has this claimed/);
  assert.doesNotMatch(advice.text, /bob/);
});

test('strict mode warns about his own other session and never stops for it; beside a teammate, it stops for the teammate', async () => {
  const mine = await startServer({ holders: [YOURS] });
  const both = await startServer({ holders: [YOURS, ALICE] });
  try {
    const one = machine(mine.port, { committed: true });
    const res = await runHook('pre_tool_use.mjs', editPayload(one.project, session()), { ...one.env, AGENTMASH_STRICT: '1', AGENTMASH_WARN_SELF: '1' });
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, undefined, 'advice, not a block');
    assert.match(out.additionalContext, /\[AgentMash: [A-Z ]+\] your other agent /);

    const two = machine(both.port, { committed: true });
    const blocked = JSON.parse(
      (await runHook('pre_tool_use.mjs', editPayload(two.project, session()), { ...two.env, AGENTMASH_STRICT: '1', AGENTMASH_WARN_SELF: '1' })).stdout
    ).hookSpecificOutput;
    assert.equal(blocked.permissionDecision, 'deny');
    assert.match(blocked.permissionDecisionReason, /alice/);
    assert.doesNotMatch(blocked.permissionDecisionReason, /your other agent/, 'the block is about the teammate');
  } finally {
    await mine.close();
    await both.close();
  }
});

test('inside the cooldown his own other session and a teammate are heard apart: neither quiets the other', async () => {
  const server = await startServer({ holders: [YOURS, ALICE] });
  const { env, project } = machine(server.port, { committed: true });
  // told two minutes ago, so this edit is inside the ten minutes and asks again
  const told = (seen) => {
    const id = session();
    const at = Date.now() - 2 * 60_000;
    lib.writeSessionCache(id, { advised: { [FILE]: { at, asked: at, seen } } });
    return id;
  };
  const advise = async (id) => {
    const res = await runHook('pre_tool_use.mjs', editPayload(project, id), { ...env, AGENTMASH_WARN_SELF: '1' });
    assert.equal(res.code, 0, res.stderr);
    return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput.additionalContext : null;
  };
  try {
    // heard of alice: his other agent is still news
    const afterAlice = await advise(told(['alice']));
    assert.match(afterAlice, /your other agent/);
    assert.doesNotMatch(afterAlice, /alice/);

    // heard of his other agent: alice is still news
    const afterYours = await advise(told(['yours:bob']));
    assert.match(afterYours, /alice's agent/);
    assert.doesNotMatch(afterYours, /your other agent/);

    // and "bob", his own name, quiets nothing of his other agent's
    assert.match(await advise(told(['bob', 'alice'])), /your other agent/);

    // heard of both: nothing
    assert.equal(await advise(told(['alice', 'yours:bob'])), null);
  } finally {
    await server.close();
  }
});
