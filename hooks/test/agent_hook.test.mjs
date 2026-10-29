// The generic hook (agent_hook.mjs): any agent with hooks runs it with the
// event, its own --client id and the dialect it reads, and gets what Claude
// Code's hooks would give it, said its own way. These tests pin that the
// claude dialect says exactly what pre_tool_use says, that deny-once refuses
// a first try and never a second, that the reports reach the room as the
// agent's, and that every way of failing is the dialect's neutral answer and
// exit 0, in time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { asClaudeEdit, clientToolKind, editedFiles, noteTouched, patchOf, registerClientTools } from '../lib.mjs';
import { HOOKS_DIR, eventsOf, machine, runHook, session, startServer, within } from './fixtures.mjs';

const hook = (event, payload, env, args, opts) => runHook('agent_hook.mjs', payload, env, [event, ...args], opts);
const userTs = (m) => path.join(m.project, 'src', 'models', 'user.ts');
/** deny-once's answer when it lets a call go on: no opinion, which is never an approval of what the person would be asked about. */
const GO_ON = '{}\n';

/** What Codex sends before an apply_patch (codex-rs/hooks/schema/generated). */
const codexPre = (project, s) => ({
  session_id: s,
  turn_id: 't-1',
  transcript_path: null,
  cwd: project,
  hook_event_name: 'PreToolUse',
  model: 'gpt-5.5-codex',
  permission_mode: 'default',
  tool_name: 'apply_patch',
  tool_use_id: 'call_1',
  tool_input: {
    command: ['*** Begin Patch', '*** Update File: src/models/user.ts', '@@', '-export interface User { id: string }', '+export interface User { id: string; role: string }', '*** End Patch'].join('\n'),
  },
});

/** The normalized input for one edit of user.ts. */
const normalEdit = (m, s, extra = {}) => ({
  agentmash: 1,
  session_id: s,
  cwd: m.project,
  files: [{ path: userTs(m), before: 'id: string', after: 'id: string;\n  role: string' }],
  ...extra,
});

/** A copy of the hooks folder, with `extra` files written into it, for a dialect of an agent's own or a script that misbehaves. */
function hooksCopy(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-agent-hook-copy-'));
  fs.mkdirSync(path.join(dir, 'dialects'));
  for (const file of fs.readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.mjs'))) fs.copyFileSync(path.join(HOOKS_DIR, file), path.join(dir, file));
  for (const file of fs.readdirSync(path.join(HOOKS_DIR, 'dialects'))) {
    fs.copyFileSync(path.join(HOOKS_DIR, 'dialects', file), path.join(dir, 'dialects', file));
  }
  for (const [file, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, file), text);
  return dir;
}

test('the claude dialect says exactly what pre_tool_use says for the same edit, read natively or normalized', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const args = ['--global', '--client', 'codex'];
    // Codex's own apply_patch, run straight, and through the generic hook
    const direct = await runHook('pre_tool_use.mjs', codexPre(m.project, session()), m.env, args);
    const generic = await hook('pre_edit', codexPre(m.project, session()), m.env, [...args, '--dialect', 'claude']);
    assert.equal(generic.code, 0, generic.stderr);
    assert.match(direct.stdout, /alice's agent modified src\/models\/user\.ts/);
    assert.equal(generic.stdout, direct.stdout, 'byte for byte');

    // a Claude Code Edit run straight, and the same edit as normalized input
    const edit = { session_id: session(), cwd: m.project, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: userTs(m), old_string: 'id: string', new_string: 'id: string;\n  role: string' } };
    const straight = await runHook('pre_tool_use.mjs', edit, m.env, args);
    const normal = await hook('pre_edit', normalEdit(m, session()), m.env, args);
    assert.equal(normal.code, 0, normal.stderr);
    assert.equal(normal.stdout, straight.stdout, 'no --dialect: claude');
    const said = JSON.parse(normal.stdout);
    assert.deepEqual(Object.keys(said.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
    assert.equal(said.hookSpecificOutput.hookEventName, 'PreToolUse');

    const checks = server.requests.filter((r) => r.path === '/check');
    assert.equal(checks.length, 4);
    assert.ok(checks.every((c) => c.query.file_path === 'src/models/user.ts' && c.user === 'amu_agentstokenagentstokenagent'));
  } finally {
    await server.close();
  }
});

test('deny-once refuses the first try with the advice as its reason, lets the same edit through, and refuses again in another session', async () => {
  const server = await startServer();
  const m = machine(server.port);
  const args = ['--global', '--client', 'acme', '--dialect', 'deny-once'];
  try {
    const s = session();
    const first = await hook('pre_edit', normalEdit(m, s), m.env, args);
    assert.equal(first.code, 0, first.stderr);
    const refused = JSON.parse(first.stdout);
    assert.deepEqual(Object.keys(refused), ['decision', 'reason']);
    assert.equal(refused.decision, 'deny');
    assert.match(refused.reason, /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts/);
    assert.match(refused.reason, /make the same edit again and it goes through\.$/);

    const again = await hook('pre_edit', normalEdit(m, s), m.env, args);
    assert.deepEqual([again.code, again.stdout], [0, GO_ON]);

    const other = await hook('pre_edit', normalEdit(m, session()), m.env, args);
    assert.equal(JSON.parse(other.stdout).decision, 'deny', 'a session of its own is told too');

    // after the edit, and at every other moment, it answers {} and nothing more
    const post = await hook('post_edit', normalEdit(m, s), m.env, args);
    assert.deepEqual([post.code, post.stdout], [0, '{}\n']);

    // what it keeps is small, private, and names no session and no file
    const kept = path.join(m.home, '.agentmash', 'deny-once.json');
    const text = fs.readFileSync(kept, 'utf8');
    assert.equal(Object.keys(JSON.parse(text).denied).length, 2);
    assert.ok(!text.includes(s) && !text.includes('user.ts'), text);
    if (process.platform !== 'win32') assert.equal(fs.statSync(kept).mode & 0o777, 0o600);
  } finally {
    await server.close();
  }
});

test('deny-once refuses only once it has written the refusal down, and forgets it when its window has passed', async () => {
  const { default: denyOnce, refuseOnce, ONCE_FOR_MS } = await import(pathToFileURL(path.join(HOOKS_DIR, 'dialects', 'deny-once.mjs')).href);
  const saved = process.env.AGENTMASH_HOME;
  const advice = { action: 'advise', text: '[AgentMash: RECENT EDIT] x', files: ['/r/a.ts'], client: 'acme', session_id: 's-1' };
  try {
    // a home that cannot be written (a sandbox): never a refusal, or every try would be refused
    const blocked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-deny-once-')), 'a-file');
    fs.writeFileSync(blocked, '');
    process.env.AGENTMASH_HOME = blocked;
    assert.equal(denyOnce.answer('pre_edit', advice).stdout, GO_ON);
    assert.equal(denyOnce.answer('pre_edit', advice).stdout, GO_ON);

    process.env.AGENTMASH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-deny-once-'));
    assert.match(denyOnce.answer('pre_edit', advice).stdout, /"decision":"deny"/);
    assert.equal(denyOnce.answer('pre_edit', advice).stdout, GO_ON, 'the same edit again');
    assert.match(denyOnce.answer('pre_edit', { ...advice, files: ['/r/a.ts', '/r/b.ts'] }).stdout, /"decision":"deny"/, 'a file it was not told about');
    // the window passes, or the clock goes back: told again
    const now = Date.now();
    assert.equal(refuseOnce(['k'], now), true);
    assert.equal(refuseOnce(['k'], now + ONCE_FOR_MS - 1), false);
    assert.equal(refuseOnce(['k'], now + ONCE_FOR_MS + 1), true);
    assert.equal(refuseOnce(['k'], now - 60_000), true);
    // and it keeps no more than a few hundred
    for (let i = 0; i < 400; i++) refuseOnce([`many-${i}`], now);
    const kept = JSON.parse(fs.readFileSync(path.join(process.env.AGENTMASH_HOME, '.agentmash', 'deny-once.json'), 'utf8')).denied;
    assert.ok(Object.keys(kept).length <= 300, `${Object.keys(kept).length} kept`);

    // strict mode refuses every time, as the script does; nothing to say is no opinion, never an "allow" a tool
    // could take for the person's approval (Crush's and Antigravity's do); neutral, on any failure, is the same
    const strict = { ...advice, action: 'deny', text: 'AgentMash strict mode blocked this edit', session_id: 's-2' };
    assert.match(denyOnce.answer('pre_edit', strict).stdout, /"decision":"deny"/);
    assert.match(denyOnce.answer('pre_edit', strict).stdout, /"decision":"deny"/);
    assert.equal(denyOnce.answer('pre_edit', { ...strict, action: 'advise' }).stdout, GO_ON, 'the acknowledged try goes through');
    assert.equal(denyOnce.answer('pre_edit', { action: 'allow', files: [] }).stdout, GO_ON);
    assert.equal(denyOnce.neutral('pre_edit').stdout, GO_ON);
    assert.equal(denyOnce.neutral('stop').stdout, '{}\n');
  } finally {
    if (saved === undefined) delete process.env.AGENTMASH_HOME;
    else process.env.AGENTMASH_HOME = saved;
  }
});

test("the room's strict mode refuses through every dialect that can refuse, every time, and nothing ever says allow for the person", async () => {
  const server = await startServer();
  const m = machine(server.port);
  const env = { ...m.env, AGENTMASH_STRICT: '1' };
  try {
    const s = session();
    const claude = await hook('pre_edit', normalEdit(m, s), env, ['--global', '--client', 'acme']);
    const said = JSON.parse(claude.stdout).hookSpecificOutput;
    assert.equal(said.permissionDecision, 'deny');
    assert.match(said.permissionDecisionReason, /AgentMash strict mode blocked this edit/);

    const json = JSON.parse((await hook('pre_edit', normalEdit(m, s), env, ['--global', '--client', 'acme', '--dialect', 'json'])).stdout);
    assert.deepEqual([json.action, json.strict, json.level], ['deny', true, 'parallel']);

    const deny = ['--global', '--client', 'acme', '--dialect', 'deny-once'];
    for (let i = 0; i < 2; i++) {
      const out = JSON.parse((await hook('pre_edit', normalEdit(m, s), env, deny)).stdout);
      assert.equal(out.decision, 'deny', `try ${i + 1}: refused until acknowledged`);
      assert.match(out.reason, /acknowledge this specific collision/);
    }
    // a hook never grants what the person's own rules would ask about
    assert.doesNotMatch(claude.stdout, /"permissionDecision":"allow"/);
  } finally {
    await server.close();
  }
});

test('plain says the advice as text, and json the result, every time', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const plain = await hook('pre_edit', normalEdit(m, session()), m.env, ['--global', '--client', 'acme', '--dialect', 'plain']);
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts[\s\S]*\n$/);
    assert.ok(!plain.stdout.trim().startsWith('{'));

    const json = await hook('pre_edit', normalEdit(m, session()), m.env, ['--global', '--client', 'acme', '--dialect', 'json']);
    const result = JSON.parse(json.stdout);
    assert.deepEqual(Object.keys(result), ['agentmash', 'event', 'action', 'level', 'text', 'files', 'strict']);
    assert.deepEqual(
      [result.agentmash, result.event, result.action, result.level, result.files, result.strict],
      [1, 'pre_edit', 'advise', 'parallel', [userTs(m)], false]
    );
    assert.match(result.text, /^\[AgentMash: PARALLEL EDIT\]/);

    // a file nobody is in: allow, with nothing to read, and plain says nothing at all
    const free = { agentmash: 1, session_id: session(), cwd: m.project, files: [{ path: 'src/index.ts', after: 'x\n' }] };
    const quiet = JSON.parse((await hook('pre_edit', free, m.env, ['--global', '--client', 'acme', '--dialect', 'json'])).stdout);
    assert.deepEqual([quiet.action, quiet.text, quiet.level, quiet.files], ['allow', null, null, [path.join(m.project, 'src', 'index.ts')]]);
    assert.equal((await hook('pre_edit', free, m.env, ['--global', '--client', 'acme', '--dialect', 'plain'])).stdout, '');
  } finally {
    await server.close();
  }
});

test('several files before an edit are asked about at once, and a file outside the repository is never named to the room', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const both = {
      agentmash: 1,
      session_id: session(),
      cwd: m.project,
      files: [{ path: 'src/index.ts' }, { path: userTs(m) }, '/Users/someone/private/notes.md'],
    };
    const out = await hook('pre_edit', both, m.env, ['--global', '--client', 'acme', '--dialect', 'json']);
    assert.match(JSON.parse(out.stdout).text, /alice's agent modified src\/models\/user\.ts/);
    assert.deepEqual(server.requests.filter((r) => r.path === '/check').map((r) => r.query.file_path).sort(), ['src/index.ts', 'src/models/user.ts']);

    const before = server.requests.length;
    const away = { agentmash: 1, session_id: session(), cwd: m.project, files: [{ path: '/Users/someone/private/notes.md', after: 'secret' }] };
    assert.equal((await hook('pre_edit', away, m.env, ['--global', '--client', 'acme', '--dialect', 'deny-once'])).stdout, GO_ON);
    await hook('post_edit', away, m.env, ['--global', '--client', 'acme']);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(server.requests.length, before, 'nothing asked, nothing sent');
    assert.ok(!JSON.stringify(server.requests).includes('/Users/someone'));
  } finally {
    await server.close();
  }
});

test('reports go to the background at once and reach the room as the agent: an edit, a prompt, a session ending', async () => {
  const server = await startServer({ eventsDelayMs: 800 });
  const m = machine(server.port);
  const s = session();
  const args = ['--global', '--client', 'acme'];
  try {
    const post = await hook('post_edit', normalEdit(m, s, { tool: 'replace_in_file' }), m.env, args);
    assert.deepEqual([post.code, post.stdout, post.stderr], [0, '', '']);
    assert.ok(post.elapsed < within(700), `the hook waited ${post.elapsed}ms on a report it had handed off`);

    const prompt = await hook('prompt', { agentmash: 1, session_id: s, cwd: m.project, prompt: 'give the user a role' }, m.env, args);
    assert.equal(prompt.code, 0, prompt.stderr);
    const end = await hook('session_end', { agentmash: 1, session_id: s, cwd: m.project, end_reason: 'exit' }, m.env, args);
    assert.deepEqual([end.code, end.stdout], [0, '']);

    const events = (await eventsOf(server, 3, 6000)).map((r) => r.body);
    const edit = events.find((e) => e.event_type === 'edit');
    assert.deepEqual(
      [edit.tool, edit.file_path, edit.change_summary, edit.developer, edit.git_branch],
      ['acme:Edit', 'src/models/user.ts', '+2/-1 lines', 'bob', 'feat/login']
    );
    const asked = events.find((e) => e.event_type === 'prompt');
    assert.deepEqual([asked.tool, asked.task_hint], ['acme', 'give the user a role']);
    const ended = events.find((e) => e.event_type === 'session_end');
    assert.deepEqual([ended.tool, ended.end_reason], ['acme', 'exit']);

    // a whole new file, and Codex's own patch read natively, as post_tool_use would report them
    await hook('post_edit', { agentmash: 1, session_id: session(), cwd: m.project, files: [{ path: 'src/new.ts', after: 'export const a = 1;\n' }] }, m.env, args);
    await hook('post_edit', { ...codexPre(m.project, session()), hook_event_name: 'PostToolUse' }, m.env, ['--global', '--client', 'codex']);
    const more = (await eventsOf(server, 5, 6000)).map((r) => r.body).filter((e) => e.event_type === 'edit');
    assert.ok(more.some((e) => e.tool === 'acme:Write' && e.file_path === 'src/new.ts' && e.change_summary === 'wrote 2 lines, defining a'), JSON.stringify(more));
    assert.ok(more.some((e) => e.tool === 'codex:apply_patch' && e.change_summary === '+1/-1 lines, in a patch'), JSON.stringify(more));
  } finally {
    await server.close();
  }
});

test('session_start, prompt and stop with nothing to say say nothing, in every dialect but json', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    for (const event of ['session_start', 'prompt', 'stop']) {
      const input = { agentmash: 1, session_id: session(), cwd: m.project, prompt: 'hello' };
      // a session that changed a file, as its edit hooks note it: the finish asks about no other
      if (event === 'stop') noteTouched(input.session_id, ['src/models/user.ts']);
      assert.deepEqual((await hook(event, input, m.env, ['--global', '--client', 'acme'])).stdout, '', event);
      assert.equal((await hook(event, input, m.env, ['--global', '--client', 'acme', '--dialect', 'deny-once'])).stdout, '{}\n', event);
      assert.equal(JSON.parse((await hook(event, input, m.env, ['--global', '--client', 'acme', '--dialect', 'json'])).stdout).action, 'allow', event);
    }
    assert.ok(server.requests.some((r) => r.path === '/team'), 'the heads-up asked who is at work');
    assert.ok(server.requests.some((r) => r.path === '/collisions'), 'the finish asked what overlaps');
  } finally {
    await server.close();
  }
});

test('anything wrong is the neutral answer and exit 0: bad input, no client, no such event or dialect, switched off', async () => {
  const server = await startServer();
  const m = machine(server.port);
  const s = session();
  try {
    const neutral = async (event, payload, args, env = m.env) => {
      const out = await hook(event, payload, env, args);
      assert.equal(out.code, 0, out.stderr);
      assert.equal(out.stderr, '');
      return out.stdout;
    };
    const deny = ['--global', '--client', 'acme', '--dialect', 'deny-once'];
    assert.equal(await neutral('pre_edit', 'not json at all', deny), GO_ON);
    assert.equal(await neutral('pre_edit', '[1,2]', deny), GO_ON);
    assert.equal(await neutral('pre_edit', '', deny), GO_ON);
    assert.equal(await neutral('pre_edit', normalEdit(m, s), ['--global', '--dialect', 'deny-once']), GO_ON, 'no --client');
    assert.equal(await neutral('pre_edit', normalEdit(m, s), ['--global', '--client', 'Not A Name', '--dialect', 'deny-once']), GO_ON);
    assert.equal(await neutral('before_edit', normalEdit(m, s), deny), '{}\n', 'no such event');
    assert.equal(await neutral('pre_edit', normalEdit(m, s), ['--global', '--client', 'acme', '--dialect', '../lib']), '', 'no such dialect');
    assert.equal(await neutral('pre_edit', normalEdit(m, s), ['--global', '--client', 'acme', '--dialect', 'nonesuch']), '');
    assert.equal(await neutral('pre_edit', normalEdit(m, s), deny, { ...m.env, AGENTMASH_DISABLE: '1' }), GO_ON);
    // a project that switches it off in its .env
    fs.writeFileSync(path.join(m.project, '.env'), 'AGENTMASH_DISABLE=1\n');
    assert.equal(await neutral('pre_edit', normalEdit(m, s), deny), GO_ON);
    fs.rmSync(path.join(m.project, '.env'));
    assert.equal(server.requests.filter((r) => r.path === '/check').length, 0, 'none of them asked the room');
  } finally {
    await server.close();
  }
});

test('a room that is down or never answers, and a script that hangs or crashes, are the neutral answer in time', async () => {
  const deny = ['--global', '--client', 'acme', '--dialect', 'deny-once'];
  // down: refused at once
  const down = await startServer();
  const m = machine(down.port);
  await down.close();
  const refused = await hook('pre_edit', normalEdit(m, session()), m.env, deny);
  assert.deepEqual([refused.code, refused.stdout], [0, GO_ON]);
  assert.ok(refused.elapsed < within(1500), `${refused.elapsed}ms`);

  // up, and never answering /check: the script's budget, then the neutral answer
  const hung = await startServer({ hang: true });
  const h = machine(hung.port);
  try {
    const env = { ...h.env, AGENTMASH_TIMEOUT_MS: '600' };
    const slow = await hook('pre_edit', normalEdit(h, session()), env, deny);
    assert.deepEqual([slow.code, slow.stdout], [0, GO_ON]);
    assert.ok(slow.elapsed < within(600 + 250 + 400 + 500), `${slow.elapsed}ms`);
    assert.ok(hung.requests.some((r) => r.path === '/check'), 'it did ask');
    // and the default budget, as an agent gets it
    const json = await hook('pre_edit', normalEdit(h, session()), h.env, ['--global', '--client', 'acme', '--dialect', 'json']);
    assert.equal(JSON.parse(json.stdout).action, 'allow');
    assert.ok(json.elapsed < within(1500 + 250 + 400 + 500), `${json.elapsed}ms`);
  } finally {
    await hung.close();
  }

  // a script that never ends: the guard says the neutral answer and ends it all
  const forever = hooksCopy({ 'pre_tool_use.mjs': 'setInterval(() => {}, 1000);\n' });
  const stuck = await hook('pre_edit', normalEdit(m, session()), { ...m.env, AGENTMASH_TIMEOUT_MS: '300' }, deny, { dir: forever });
  assert.deepEqual([stuck.code, stuck.stdout], [0, GO_ON]);
  assert.ok(stuck.elapsed < within(300 + 250 + 400 + 600), `${stuck.elapsed}ms`);

  // a script that crashes, or prints what is not its JSON
  for (const script of ['throw new Error("boom");\n', 'console.log("not json");\n', 'process.exit(3);\n']) {
    const broken = hooksCopy({ 'pre_tool_use.mjs': script, 'stop.mjs': script });
    const out = await hook('pre_edit', normalEdit(m, session()), m.env, deny, { dir: broken });
    assert.deepEqual([out.code, out.stdout, out.stderr], [0, GO_ON, ''], script);
    const stop = await hook('stop', { agentmash: 1, session_id: session(), cwd: m.project }, m.env, ['--global', '--client', 'acme', '--dialect', 'json'], { dir: broken });
    assert.equal(JSON.parse(stop.stdout).action, 'allow', script);
  }
});

test("an agent's own dialect file is picked up by its name, with its tool names: reads ask nothing, edits are advised and reported as its own", async () => {
  const acme = [
    "import denyOnce from './deny-once.mjs';",
    'export default {',
    '  ...denyOnce,',
    "  name: 'acme',",
    "  tools: { write: ['write_file'], edit: ['replace'], read: ['read_file'], command: ['run_shell_command'] },",
    '};',
    '',
  ].join('\n');
  const dir = hooksCopy({ 'dialects/acme.mjs': acme });
  const server = await startServer();
  const m = machine(server.port);
  const call = (tool_name, tool_input, s = session()) => ({ session_id: s, cwd: m.project, hook_event_name: 'BeforeTool', tool_name, tool_input });
  const args = ['--global', '--client', 'acme'];
  try {
    const read = await hook('pre_edit', call('read_file', { file_path: userTs(m) }), m.env, args, { dir });
    assert.deepEqual([read.code, read.stdout], [0, GO_ON]);
    assert.equal(server.requests.length, 0, 'a read asks nothing');

    const edit = await hook('pre_edit', call('replace', { file_path: userTs(m), old_string: 'id: string', new_string: 'id: string; role: string' }), m.env, args, { dir });
    assert.equal(JSON.parse(edit.stdout).decision, 'deny', 'its dialect, by its name');
    assert.match(JSON.parse(edit.stdout).reason, /alice's agent modified src\/models\/user\.ts/);

    await hook('post_edit', call('write_file', { file_path: 'src/new.ts', content: 'export const b = 2;\n' }), m.env, args, { dir });
    await hook('post_edit', call('replace', { file_path: userTs(m), old_string: 'a', new_string: 'b\nc' }), m.env, args, { dir });
    const edits = (await eventsOf(server, 2)).map((r) => r.body);
    assert.deepEqual(
      edits.map((e) => [e.tool, e.file_path, e.change_summary]).sort(),
      [
        ['acme:Edit', 'src/models/user.ts', '+2/-1 lines'],
        ['acme:Write', 'src/new.ts', 'wrote 2 lines, defining b'],
      ]
    );
  } finally {
    await server.close();
  }
});

test("an agent's tool names, declared from its own module, are read for that agent and no other", () => {
  assert.equal(registerClientTools('Not A Name', { edit: ['x'] }), false);
  assert.equal(registerClientTools('acme-test', null), false);
  assert.equal(registerClientTools('acme-test', { write: ['write_file', 7], edit: ['replace'], patch: ['patch_files'], read: ['read_file'], command: ['shell'] }), true);
  assert.equal(clientToolKind('acme-test', 'write_file'), 'write');
  assert.equal(clientToolKind('acme-test', 'nope'), null);
  assert.equal(clientToolKind(null, 'write_file'), null);

  const abs = '/r/src/a.ts';
  assert.deepEqual(editedFiles('read_file', { file_path: abs }, 'acme-test'), [], 'a read names no file it changed');
  assert.deepEqual(editedFiles('read_file', { file_path: abs }), [abs], 'and for any other agent reads as it always did');
  assert.deepEqual(editedFiles('shell', { command: 'ls' }, 'acme-test'), []);
  assert.deepEqual(editedFiles('write_file', { filePath: abs, content: 'x' }, 'acme-test'), [abs]);
  assert.deepEqual(editedFiles('replace', { TargetFile: abs, old_string: 'a', new_string: 'b' }, 'acme-test'), [abs]);
  assert.deepEqual(editedFiles('replace', { edits: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'a.ts' }] }, 'acme-test'), ['a.ts', 'b.ts']);
  assert.deepEqual(editedFiles('patch_files', { patch: '*** Begin Patch\n*** Add File: c.ts\n+x\n*** End Patch' }, 'acme-test'), ['c.ts']);
  assert.deepEqual(patchOf('patch_files', { patch: '*** Begin Patch\n*** Add File: c.ts\n+x\n*** End Patch' }), null, 'a patch tool only for the agent that declared it');

  assert.deepEqual(asClaudeEdit('write_file', { file_path: abs, content: 'x' }, 'acme-test'), { tool: 'Write', input: { file_path: abs, content: 'x' } });
  assert.deepEqual(asClaudeEdit('replace', { file_path: abs, oldString: 'a', newString: 'b' }, 'acme-test').input.new_string, 'b');
  assert.deepEqual(asClaudeEdit('replace', { edits: [{ old_string: 'a', new_string: 'b' }] }, 'acme-test'), { tool: 'MultiEdit', input: { edits: [{ old_string: 'a', new_string: 'b' }] } });
  assert.deepEqual(asClaudeEdit('replace', { file_path: abs }), { tool: 'replace', input: { file_path: abs } }, 'as it came, for any other agent');
});
