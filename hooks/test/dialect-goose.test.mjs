// goose, through the generic hook (agent_hook.mjs) in goose's dialect
// (dialects/goose.mjs): each test runs the very commands `npx agentmash
// login` registers with goose (cli/agents/goose.mjs) on what goose v1.53.0
// sends (fixtures/goose/, from goose's source), from a temporary home and a
// room on a port of its own. goose reads only a decision before a tool, so
// these pin that the advice goes as goose's refusal of the first try and
// never of the second, that nothing else ever prints a thing goose could read
// as a refusal, that reads and commands ask nothing, that the reports reach
// the room as goose's, and that every way of failing lets the call through,
// with exit status 0 (goose reads 2 as a refusal).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { gooseHooks } from '../../cli/agents/goose.mjs';
import { HOOKS_DIR, baseEnv, eventsOf, machine, startServer, within } from './fixtures.mjs';
import { afterEdit, afterShell, afterWrite, preEdit, preExtension, preShell, preWrite } from './fixtures/goose/tool-events.mjs';
import { promptDesktop, promptLegacy, sessionEnd, sessionStart, sessionStartDesktop, stop } from './fixtures/goose/session-events.mjs';

/** The arguments each of goose's events runs agent_hook.mjs with, as login registers them. */
const REGISTERED = Object.fromEntries(
  Object.entries(gooseHooks(HOOKS_DIR)).map(([event, groups]) => {
    const { command } = groups[0].hooks[0];
    const quoted = `node "${path.join(HOOKS_DIR, 'agent_hook.mjs')}" `;
    assert.ok(command.startsWith(quoted), command);
    return [event, command.slice(quoted.length).split(' ')];
  })
);

/**
 * Run the hook goose runs for `gooseEvent`, from `cwd` (goose's own folder,
 * which a hook inherits): { code, stdout, stderr, elapsed }.
 */
function goose(gooseEvent, payload, env, { cwd = process.cwd(), dir = HOOKS_DIR } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(dir, 'agent_hook.mjs'), ...REGISTERED[gooseEvent]], {
      cwd,
      env: { ...baseEnv, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, elapsed: Date.now() - started }));
    child.stdin.on('error', () => {});
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

/** A session id of goose's form, no other test's. */
const gooseSession = () => `20261005_${process.pid}${Math.floor(Math.random() * 1e6)}`;
const userTs = (m) => path.join(m.project, 'src', 'models', 'user.ts');

/** What goose reads as a refusal: the whole of stdout, trimmed, one JSON object whose decision is block. */
function refusal(stdout) {
  const said = JSON.parse(stdout.trim());
  assert.deepEqual(Object.keys(said), ['decision', 'reason']);
  assert.equal(said.decision, 'block');
  return said.reason;
}

test('registered: the generic hook in goose dialect for each event goose reads, a matcher of goose’s own file tools, and no on_failure', () => {
  const dir = path.join(path.sep, 'home', 'someone', '.agentmash', 'hooks');
  const hooks = gooseHooks(dir);
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'AfterFileEdit', 'PostToolUse', 'SessionEnd']);
  // the script's path as this OS joins it: \home\someone\… on Windows
  assert.equal(hooks.PreToolUse[0].hooks[0].command, `node "${path.join(dir, 'agent_hook.mjs')}" pre_edit --global --client goose --dialect goose`);
  assert.deepEqual(REGISTERED.AfterFileEdit, ['post_edit', '--global', '--client', 'goose', '--dialect', 'goose']);
  for (const group of Object.values(hooks).flat()) {
    for (const action of group.hooks) assert.ok(!('on_failure' in action), 'a hook that fails must let the call through');
  }
  // goose's matcher is a regular expression tried on the tool's name: its own tools, and any extension's of the same names
  const edits = new RegExp(hooks.PreToolUse[0].matcher);
  for (const tool of ['edit', 'write', 'developer__edit', 'filesystem__write_file', 'files__edit_file', 'x__patch']) assert.ok(edits.test(tool), tool);
  for (const tool of ['shell', 'filesystem__read_file', 'texteditor', 'agentmash__claim_work', 'tree']) assert.ok(!edits.test(tool), tool);
  const shell = new RegExp(hooks.PostToolUse[0].matcher);
  assert.ok(shell.test('shell') && shell.test('developer__shell') && !shell.test('bashshell'));
});

test("before goose's own edit: the room is asked, and the advice goes as goose's refusal of the first try, which the same edit again gets past", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const s = gooseSession();
    const first = await goose('PreToolUse', preEdit({ session_id: s, working_dir: m.project }), m.env);
    assert.deepEqual([first.code, first.stderr], [0, '']);
    const reason = refusal(first.stdout);
    assert.match(reason, /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts/);
    assert.match(reason, /It is advice, not a policy/);
    // goose adds ". Do not retry; this is a policy denial, …" after the reason
    assert.match(reason, /make the same edit again and it goes through$/);
    const checks = server.requests.filter((r) => r.path === '/check');
    assert.deepEqual(checks.map((c) => c.query.file_path), ['src/models/user.ts'], 'a relative path, read against working_dir');

    const again = await goose('PreToolUse', preEdit({ session_id: s, working_dir: m.project }), m.env);
    assert.deepEqual([again.code, again.stdout, again.stderr], [0, '', ''], 'nothing printed: goose lets it go on');

    // goose's write, and another extension's write_file, of the same file in another session: told too
    const write = await goose('PreToolUse', preWrite({ session_id: gooseSession(), working_dir: m.project }), m.env);
    assert.match(refusal(write.stdout), /alice's agent modified src\/models\/user\.ts/);
    const ext = preExtension({ session_id: gooseSession(), working_dir: m.project, tool: 'filesystem__write_file', input: { path: userTs(m), content: 'x\n' } });
    assert.match(refusal((await goose('PreToolUse', ext, m.env)).stdout), /alice's agent modified src\/models\/user\.ts/);
  } finally {
    await server.close();
  }
});

test('reads and commands ask the room nothing, and a file nobody is in is let through with nothing said', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    // goose sends only its file tools here (the matcher); a person who widens it still gets nothing asked for these
    const read = preExtension({ session_id: gooseSession(), working_dir: m.project, tool: 'filesystem__read_file', input: { path: userTs(m) } });
    for (const payload of [read, preShell({ session_id: gooseSession(), working_dir: m.project })]) {
      const out = await goose('PreToolUse', payload, m.env);
      assert.deepEqual([out.code, out.stdout, out.stderr], [0, '', ''], payload.tool_name);
    }
    assert.equal(server.requests.length, 0, 'nothing asked');

    const free = await goose('PreToolUse', preWrite({ session_id: gooseSession(), working_dir: m.project, path: 'src/index.ts' }), m.env);
    assert.deepEqual([free.code, free.stdout], [0, '']);
    assert.deepEqual(server.requests.filter((r) => r.path === '/check').map((r) => r.query.file_path), ['src/index.ts']);
  } finally {
    await server.close();
  }
});

test("the room's strict mode refuses every try, as goose's refusal, until the collision is acknowledged", async () => {
  const server = await startServer();
  const m = machine(server.port);
  const env = { ...m.env, AGENTMASH_STRICT: '1' };
  try {
    const s = gooseSession();
    for (let i = 0; i < 2; i++) {
      const out = await goose('PreToolUse', preEdit({ session_id: s, working_dir: m.project }), env);
      assert.equal(out.code, 0);
      const reason = refusal(out.stdout);
      assert.match(reason, /AgentMash strict mode blocked this edit/, `try ${i + 1}`);
      assert.match(reason, /acknowledge this specific collision/);
      assert.doesNotMatch(reason, /\.$/);
    }
  } finally {
    await server.close();
  }
});

test("reports go to the background at once and reach the room as goose's: an edit, a whole file, a prompt on either loop, a session's end", async () => {
  const server = await startServer({ eventsDelayMs: 800 });
  const m = machine(server.port);
  const s = gooseSession();
  try {
    const edit = await goose('AfterFileEdit', afterEdit({ session_id: s, working_dir: m.project }), m.env);
    assert.deepEqual([edit.code, edit.stdout, edit.stderr], [0, '', '']);
    assert.ok(edit.elapsed < within(700), `goose waited ${edit.elapsed}ms on a report the hook had handed off`);
    await goose('AfterFileEdit', afterWrite({ session_id: s, working_dir: m.project }), m.env);

    // the CLI's own loop sends no working_dir: the hook's cwd, goose's, is where it works
    const legacy = await goose('UserPromptSubmit', promptLegacy({ session_id: s, message: 'give the user a role' }), m.env, { cwd: m.project });
    assert.deepEqual([legacy.code, legacy.stdout], [0, '']);
    const other = gooseSession();
    await goose('UserPromptSubmit', promptDesktop({ session_id: other, message: 'add soft deletes', working_dir: m.project }), m.env);
    const end = await goose('SessionEnd', sessionEnd({ session_id: s }), m.env, { cwd: m.project });
    assert.deepEqual([end.code, end.stdout], [0, '']);

    const events = (await eventsOf(server, 5, 8000)).map((r) => r.body);
    const edits = events.filter((e) => e.event_type === 'edit');
    assert.deepEqual(
      edits.map((e) => [e.tool, e.file_path, e.session_id]).sort(),
      [
        ['goose:Edit', 'src/models/user.ts', s],
        ['goose:Write', 'src/new.ts', s],
      ]
    );
    assert.equal(edits.find((e) => e.tool === 'goose:Edit').change_summary, '+2/-1 lines');
    assert.match(edits.find((e) => e.tool === 'goose:Write').change_summary, /^wrote \d+ lines?, defining a$/);
    assert.ok(edits.every((e) => e.developer === 'bob' && e.git_branch === 'feat/login'));
    const prompts = events.filter((e) => e.event_type === 'prompt');
    assert.deepEqual(prompts.map((p) => [p.tool, p.session_id, p.task_hint]).sort(), [
      ['goose', other, 'add soft deletes'],
      ['goose', s, 'give the user a role'],
    ].sort());
    const ended = events.find((e) => e.event_type === 'session_end');
    assert.deepEqual([ended.tool, ended.session_id], ['goose', s]);
  } finally {
    await server.close();
  }
});

test("a shell command's changes are found in the working tree after it, and reported as goose's", async () => {
  const server = await startServer();
  const m = machine(server.port);
  // a real checkout this time: the look after a command is git's
  fs.rmSync(path.join(m.project, '.git'), { recursive: true });
  // none of the person's git settings read or written: no global or system config, no templates
  const gitEnv = { ...baseEnv, GIT_CONFIG_GLOBAL: path.join(m.home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: '' };
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.email=bob@example.com', '-c', 'user.name=bob', '-c', 'commit.gpgsign=false', ...args], { cwd: m.project, env: gitEnv, stdio: 'ignore' });
  git('init', '-q');
  git('checkout', '-q', '-b', 'feat/login');
  git('remote', 'add', 'origin', 'git@github.com:acme/app.git');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  const s = gooseSession();
  try {
    // the prompt takes the session's first look; a command after it is compared with that
    await goose('UserPromptSubmit', promptDesktop({ session_id: s, message: 'rename id', working_dir: m.project }), m.env);
    await eventsOf(server, 1);
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(userTs(m), 'export interface User { uid: string }\n');
    const out = await goose('PostToolUse', afterShell({ session_id: s, working_dir: m.project, command: "sed -i '' 's/id/uid/' src/models/user.ts" }), m.env);
    assert.deepEqual([out.code, out.stdout], [0, '']);
    const events = (await eventsOf(server, 2)).map((r) => r.body);
    const edit = events.find((e) => e.event_type === 'edit');
    assert.ok(edit, JSON.stringify(events));
    assert.deepEqual([edit.tool, edit.file_path, edit.session_id, edit.task_hint], ['goose:Bash', 'src/models/user.ts', s, 'rename id']);
  } finally {
    await server.close();
  }
});

test('at the session’s start the heads-up is a banner for the person, and nothing else ever prints anything goose would read', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const s = gooseSession();
    for (const [event, payload, cwd] of [
      ['SessionStart', sessionStart({ session_id: s }), m.project],
      ['SessionStart', sessionStartDesktop({ session_id: gooseSession(), working_dir: m.project }), undefined],
      ['UserPromptSubmit', promptDesktop({ session_id: s, message: 'hello', working_dir: m.project }), undefined],
      ['SessionEnd', sessionEnd({ session_id: s }), m.project],
    ]) {
      const out = await goose(event, payload, m.env, { cwd });
      assert.deepEqual([out.code, out.stdout, out.stderr], [0, '', ''], event);
    }
    assert.ok(server.requests.some((r) => r.path === '/team'), 'the start asked who is at work');

    // what the dialect says with a heads-up to give: goose's banner, the person's to read
    const { default: dialect } = await import(pathToFileURL(path.join(HOOKS_DIR, 'dialects', 'goose.mjs')).href);
    const banner = dialect.answer('session_start', { action: 'advise', text: '[AgentMash] alice is at work on feat/login' });
    assert.deepEqual(JSON.parse(banner.stdout), { banner: '[AgentMash] alice is at work on feat/login' });
    for (const event of ['post_edit', 'prompt', 'session_end', 'stop']) {
      assert.equal(dialect.answer(event, { action: 'advise', text: 'x' }).stdout, '', event);
    }
    // a Stop payload, were it ever sent, is let be
    assert.equal(dialect.parse('stop', stop({ session_id: s, working_dir: m.project })).cwd, m.project);
  } finally {
    await server.close();
  }
});

test('anything wrong lets the call through with nothing printed and exit 0: garbage, another agent’s payload, a room down or hung, switched off', async () => {
  const down = await startServer();
  const m = machine(down.port);
  await down.close();
  const neutral = async (event, payload, env = m.env, opts) => {
    const out = await goose(event, payload, env, opts);
    assert.deepEqual([out.code, out.stdout, out.stderr], [0, '', ''], JSON.stringify(payload).slice(0, 80));
    return out;
  };
  const s = gooseSession();
  const edit = preEdit({ session_id: s, working_dir: m.project });
  const refused = await neutral('PreToolUse', edit);
  assert.ok(refused.elapsed < within(1500), `${refused.elapsed}ms with the room down`);
  for (const garbage of ['not json at all', '[1,2]', '', '{"event":', JSON.stringify({ ...edit, event: 'BeforeTool' }), JSON.stringify({ ...edit, event: undefined })]) {
    await neutral('PreToolUse', garbage);
  }
  // Claude Code's shape, from some other agent reading the same plugins folder: not goose's, so let be
  await neutral('PreToolUse', { session_id: s, cwd: m.project, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: userTs(m), old_string: 'a', new_string: 'b' } });
  await neutral('PreToolUse', { ...edit, tool_input: 'not an object' });
  await neutral('AfterFileEdit', 'garbage');
  await neutral('PreToolUse', edit, { ...m.env, AGENTMASH_DISABLE: '1' });

  const hung = await startServer({ hang: true });
  const h = machine(hung.port);
  try {
    const slow = await neutral('PreToolUse', preEdit({ session_id: gooseSession(), working_dir: h.project }), { ...h.env, AGENTMASH_TIMEOUT_MS: '600' });
    assert.ok(slow.elapsed < within(600 + 250 + 400 + 500), `${slow.elapsed}ms`);
    assert.ok(hung.requests.some((r) => r.path === '/check'), 'it did ask');
    // and the default budget, well inside the five seconds goose gives it
    const json = await neutral('PreToolUse', preEdit({ session_id: gooseSession(), working_dir: h.project }), h.env);
    assert.ok(json.elapsed < within(1500 + 250 + 400 + 500), `${json.elapsed}ms`);
  } finally {
    await hung.close();
  }
});

test('the dialect: a refusal only on advice not yet given, never a word that would read as a decision otherwise', async () => {
  const { default: dialect } = await import(pathToFileURL(path.join(HOOKS_DIR, 'dialects', 'goose.mjs')).href);
  const saved = process.env.AGENTMASH_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-goose-dialect-'));
  try {
    process.env.AGENTMASH_HOME = home;
    const advice = { action: 'advise', text: '[AgentMash: RECENT EDIT] x.', files: ['/r/a.ts'], client: 'goose', session_id: '20261005_1' };
    assert.ok(refusal(dialect.answer('pre_edit', advice).stdout).startsWith('[AgentMash: RECENT EDIT] x.\n\n'));
    assert.equal(dialect.answer('pre_edit', advice).stdout, '', 'the same file in the same session: through');
    assert.equal(dialect.answer('pre_edit', { action: 'allow', files: ['/r/b.ts'] }).stdout, '');
    assert.equal(dialect.answer('pre_edit', { action: 'advise', text: null, files: [] }).stdout, '');
    assert.equal(refusal(dialect.answer('pre_edit', { ...advice, action: 'deny', text: 'blocked.  ' }).stdout), 'blocked');
    for (const event of ['pre_edit', 'post_edit', 'prompt', 'session_start', 'session_end', 'stop']) assert.equal(dialect.neutral(event).stdout, '');
    assert.equal(dialect.parse('pre_edit', null), null);
    assert.equal(dialect.parse('pre_edit', { event: 'AfterFileEdit' }), null, 'an event in the wrong place');
    assert.deepEqual(dialect.parse('post_edit', afterShell({ session_id: 's', working_dir: '/r', command: 'ls' })), {
      session_id: 's',
      cwd: '/r',
      files: [],
      tool: 'shell',
      command: 'ls',
    });
    // a home that cannot be written: never a refusal, or every try would be refused
    const blocked = path.join(home, 'a-file');
    fs.writeFileSync(blocked, '');
    process.env.AGENTMASH_HOME = blocked;
    assert.equal(dialect.answer('pre_edit', { ...advice, session_id: '20261005_2' }).stdout, '');
  } finally {
    if (saved === undefined) delete process.env.AGENTMASH_HOME;
    else process.env.AGENTMASH_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
