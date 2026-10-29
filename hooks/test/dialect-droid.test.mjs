// Factory Droid, as login connects it: every hook is the generic one
// (agent_hook.mjs) with --global --client droid, and it answers in the
// dialect named like the client (dialects/droid.mjs). These tests run it on
// Droid's own payloads, as Factory's docs and the integrations tested against
// Droid record them (fixtures/droid/), and pin what Droid then does with each
// answer: the warning before an edit reaches the model as the reason of a
// refusal of the first try (permissionDecision "deny"), and the same edit
// again goes on;
// reads, commands and tools that only look like edits ask nothing; reports
// reach the room as the agent's; the heads-up is context under Droid's own
// event names; and anything going wrong is nothing at all and exit 0, which
// lets the call go on as it would have without the hook. Nothing here is ever
// "allow", "ask", "continue", updatedInput, or an exit 2.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as lib from '../lib.mjs';
import { clientToolKind, editedFiles, registerClientTools } from '../lib.mjs';
import { HOOKS_DIR, REF, eventsOf, machine, runHook, session, startServer, within } from './fixtures.mjs';
import * as tools from './fixtures/droid/tool_use.mjs';
import { sessionEnd, sessionStart, stop, userPromptSubmit } from './fixtures/droid/session.mjs';

/** As login registers it, less the node path (cli/agents/droid.mjs). */
const ARGS = ['--global', '--client', 'droid'];
const hook = (event, payload, env, args = ARGS) => runHook('agent_hook.mjs', payload, env, [event, ...args]);
const userTs = (m) => path.join(m.project, 'src', 'models', 'user.ts');
const ADVICE = /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts/;
const dialect = async () => (await import(pathToFileURL(path.join(HOOKS_DIR, 'dialects', 'droid.mjs')).href)).default;

/** Nothing said at all, and exit 0: Droid's own permission flow goes on as if there were no hook. */
const silent = (out, what) => assert.deepEqual([out.code, out.stdout, out.stderr], [0, '', ''], what);

/**
 * A refusal Droid sends the model the reason of, and nothing else: exit 0,
 * hookSpecificOutput with permissionDecision "deny" and its reason, never
 * "allow", "ask", updatedInput or continue. Returns the reason.
 */
function refusal(out, what) {
  assert.deepEqual([out.code, out.stderr], [0, ''], `${what}: ${out.stderr}`);
  const said = JSON.parse(out.stdout);
  assert.deepEqual(Object.keys(said), ['hookSpecificOutput'], what);
  assert.deepEqual(Object.keys(said.hookSpecificOutput), ['hookEventName', 'permissionDecision', 'permissionDecisionReason'], what);
  assert.deepEqual([said.hookSpecificOutput.hookEventName, said.hookSpecificOutput.permissionDecision], ['PreToolUse', 'deny'], what);
  return said.hookSpecificOutput.permissionDecisionReason;
}

/** What Droid must never be told by one of our hooks. */
function nothingDangerous(stdout, what) {
  for (const word of ['"allow"', '"approve"', '"ask"', 'permissionDecision', 'updatedInput', '"continue"', '"decision"']) {
    assert.equal(stdout.includes(word), false, `${what}: ${word}`);
  }
}

test("before each of Droid's file tools the file is asked about, and the advice refuses the first try, its reason sent to the model", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const payloads = [
      tools.create(m.project, session(), userTs(m), 'export interface User { id: string; role: string }\n'),
      tools.editStr(m.project, session(), userTs(m), 'id: string', 'id: string;\n  role: string'),
      tools.editString(m.project, session(), 'src/models/user.ts', 'id: string', 'id: string;\n  role: string'),
      tools.applyPatch(m.project, session(), tools.patchOf('src/models/user.ts', 'export interface User { id: string }', 'export interface User { id: string; role: string }')),
    ];
    for (const payload of payloads) {
      const reason = refusal(await hook('pre_edit', payload, m.env), payload.tool_name);
      assert.match(reason, ADVICE, payload.tool_name);
      assert.match(reason, /make the same edit again and it goes through\.$/, payload.tool_name);
    }
    const checks = server.requests.filter((r) => r.path === '/check');
    assert.deepEqual(checks.map((c) => c.query.file_path), Array(payloads.length).fill('src/models/user.ts'));
    assert.ok(checks.every((c) => c.user === 'amu_agentstokenagentstokenagent'));

    // a file nobody is in: asked about, and nothing said
    const free = await hook('pre_edit', tools.create(m.project, session(), 'src/index.ts', 'export {};\n'), m.env);
    silent(free, 'a file nobody is in');
    assert.ok(server.requests.some((r) => r.path === '/check' && r.query.file_path === 'src/index.ts'));
  } finally {
    await server.close();
  }
});

test('the same edit again in the session goes through, a session of its own is told again, and the refusal names no file on disk', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const s = session();
    const payload = tools.editStr(m.project, s, userTs(m), 'id: string', 'id: string; role: string');
    refusal(await hook('pre_edit', payload, m.env), 'the first try');
    silent(await hook('pre_edit', payload, m.env), 'the retry');
    // the same file by another tool, by its relative path, is the same file
    silent(await hook('pre_edit', tools.create(m.project, s, 'src/models/user.ts', 'x\n'), m.env), 'another tool, same file');
    refusal(await hook('pre_edit', { ...payload, session_id: session() }, m.env), 'another session is told too');

    const kept = fs.readFileSync(path.join(m.home, '.agentmash', 'deny-once.json'), 'utf8');
    assert.ok(!kept.includes(s) && !kept.includes('user.ts'), kept);
  } finally {
    await server.close();
  }
});

test("in the room's strict mode the edit is refused on every try; a refusal that cannot be written down is never made", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const s = session();
    const payload = tools.editStr(m.project, s, userTs(m), 'id: string', 'id: string; role: string');
    for (let i = 0; i < 2; i++) {
      const reason = refusal(await hook('pre_edit', payload, { ...m.env, AGENTMASH_STRICT: '1' }), `try ${i + 1}`);
      assert.match(reason, /AgentMash strict mode blocked this edit/);
    }

    // Droid's sandbox can keep a hook from writing to the home folder: every try would be refused, so none is
    const sandboxed = machine(server.port);
    fs.mkdirSync(path.join(sandboxed.home, '.agentmash', 'deny-once.json'), { recursive: true });
    const there = tools.editStr(sandboxed.project, s, path.join(sandboxed.project, 'src', 'models', 'user.ts'), 'a', 'b');
    for (let i = 0; i < 2; i++) silent(await hook('pre_edit', there, sandboxed.env), `try ${i + 1}`);
  } finally {
    await server.close();
  }
});

test('reads, shell commands, MCP tools and tools that only look like edits ask nothing before they run', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const s = session();
    silent(await hook('pre_edit', tools.read(m.project, s, userTs(m)), m.env), 'Read');
    silent(await hook('pre_edit', tools.execute(m.project, s, `sed -i '' s/id/key/ ${userTs(m)}`), m.env), 'Execute');
    // the matcher Factory documents is unanchored: these could reach the hook, and are not Droid's file tools
    for (const tool_name of ['mcp__files__EditFile', 'mcp__agentmash__agentmash_status', 'NotebookEdit', 'MultiEdit', 'create', 'LS', 'Grep', 'Glob', 'Task']) {
      const payload = tools.toolUse('PreToolUse', m.project, s, tool_name, { file_path: userTs(m), path: userTs(m), patch: tools.patchOf('src/models/user.ts', 'a', 'b') });
      silent(await hook('pre_edit', payload, m.env), tool_name);
    }
    // an edit that names no file: nothing to ask about
    silent(await hook('pre_edit', tools.toolUse('PreToolUse', m.project, s, 'ApplyPatch', {}), m.env), 'ApplyPatch with nothing in it');
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(server.requests, [], 'not a question asked of the room');

    // what the dialect declares, for the droid client and for no other
    const droid = await dialect();
    assert.equal(registerClientTools('droid', droid.tools), true);
    assert.equal(clientToolKind('droid', 'Read'), 'read');
    assert.equal(clientToolKind('droid', 'Execute'), 'command');
    assert.equal(clientToolKind('droid', 'ApplyPatch'), 'patch');
    assert.deepEqual(editedFiles('Read', { file_path: 'src/a.ts' }, 'droid'), []);
    assert.deepEqual(editedFiles('Create', { file_path: 'src/a.ts', content: 'x' }, 'droid'), ['src/a.ts']);
    assert.deepEqual(editedFiles('ApplyPatch', { patch: tools.patchOf('src/b.ts', 'a', 'b') }, 'droid'), ['src/b.ts']);
  } finally {
    await server.close();
  }
});

test("after an edit: reported as Droid's, at once, from the file the tool says it wrote; a failed edit is not reported", async () => {
  const server = await startServer({ eventsDelayMs: 800 });
  const m = machine(server.port);
  try {
    const s = session();
    const created = tools.created(m.project, s, 'src/new.ts', 'export const b = 2;\n', path.join(m.project, 'src', 'new.ts'));
    const wrote = await hook('post_edit', created, m.env);
    silent(wrote, 'Create');
    assert.ok(wrote.elapsed < within(700), `the hook waited ${wrote.elapsed}ms on a report it had handed off`);

    silent(await hook('post_edit', tools.edited(m.project, s, userTs(m), 'id: string', 'id: string;\n  role: string'), m.env), 'Edit');
    silent(await hook('post_edit', tools.patched(m.project, s, ['*** Begin Patch', '*** Add File: src/added.ts', '+export const c = 3;', '*** End Patch'].join('\n')), m.env), 'ApplyPatch');
    // failed: Droid runs PostToolUse all the same, and there is nothing to report
    silent(await hook('post_edit', tools.editFailed(m.project, s, userTs(m), 'nope', 'x'), m.env), 'a failed Edit');
    // a read reaching the report hook by hand reports nothing
    silent(await hook('post_edit', { ...tools.read(m.project, s, userTs(m)), hook_event_name: 'PostToolUse', tool_response: { success: true } }, m.env), 'Read');

    const edits = (await eventsOf(server, 3, 6000)).map((r) => r.body).filter((e) => e.event_type === 'edit');
    assert.deepEqual(
      edits.map((e) => [e.tool, e.file_path]).sort(),
      [
        ['droid:Edit', 'src/models/user.ts'],
        ['droid:Write', 'src/new.ts'],
        ['droid:apply_patch', 'src/added.ts'],
      ]
    );
    assert.equal(edits.find((e) => e.tool === 'droid:Edit').change_summary, '+2/-1 lines');
    assert.match(edits.find((e) => e.tool === 'droid:Write').change_summary, /defining b/);
    assert.ok(edits.every((e) => e.developer === 'bob' && e.git_branch === 'feat/login' && e.session_id === s));
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(server.requests.filter((r) => r.path === '/events').length, 3, 'the failed Edit and the Read sent nothing');
  } finally {
    await server.close();
  }
});

/** A room with carol at work on feat/login, the branch the test checkout is on. */
function teamServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({ path: url.pathname, body: body ? JSON.parse(body) : null });
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (url.pathname === '/api/lookup') return send(200, { room_ref: REF, developer: 'bob' });
      if (url.pathname === '/team') {
        return send(200, { developers: [{ developer: 'carol', presence: 'active', minutes_ago: 1, branch: 'feat/login', prompt: 'redo the hero', files: [] }] });
      }
      if (url.pathname === '/collisions') return send(200, { reconcile_mode: 'approve', collisions: [] });
      return send(201, { ok: true });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: server.address().port, requests, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))) })
    )
  );
}

test("the heads-up is context the model reads, under Droid's own event names; prompts and the session's end are reported as Droid's", async () => {
  const server = await teamServer();
  const m = machine(server.port);
  try {
    const started = await hook('session_start', sessionStart(m.project, session()), m.env);
    assert.equal(started.code, 0, started.stderr);
    nothingDangerous(started.stdout, 'SessionStart');
    const start = JSON.parse(started.stdout);
    assert.deepEqual(Object.keys(start), ['hookSpecificOutput']);
    assert.equal(start.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(start.hookSpecificOutput.additionalContext, /carol/);

    const s = session();
    const asked = await hook('prompt', userPromptSubmit(m.project, s, 'fix the role check'), m.env);
    assert.equal(asked.code, 0, asked.stderr);
    assert.equal(asked.stderr, '');
    nothingDangerous(asked.stdout, 'UserPromptSubmit');
    const prompt = JSON.parse(asked.stdout);
    assert.deepEqual(Object.keys(prompt.hookSpecificOutput), ['hookEventName', 'additionalContext']);
    assert.equal(prompt.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(prompt.hookSpecificOutput.additionalContext, /carol/);

    silent(await hook('stop', stop(m.project, s), m.env), 'Stop with no overlap to say');
    silent(await hook('session_end', sessionEnd(m.project, s), m.env), 'SessionEnd');

    const events = (await eventsOf(server, 2, 6000)).map((r) => r.body);
    const reported = events.find((e) => e.event_type === 'prompt');
    assert.deepEqual([reported.tool, reported.task_hint, reported.session_id], ['droid', 'fix the role check', s]);
    const end = events.find((e) => e.event_type === 'session_end');
    assert.deepEqual([end.tool, end.end_reason, end.session_id], ['droid', 'prompt_input_exit', s]);
  } finally {
    await server.close();
  }
});

test("the dialect's answers, each as Droid reads it, and what it reads from Droid's payloads", async () => {
  const droid = await dialect();
  const paused = JSON.stringify({ systemMessage: 'paused', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'paused' } });
  assert.deepEqual(JSON.parse(droid.answer('prompt', { stdout: paused }).stdout), {
    systemMessage: 'paused',
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'paused' },
  });
  assert.deepEqual(JSON.parse(droid.answer('session_start', { stdout: paused }).stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  // Stop: a word for the person only, never anything that could send Droid back to work
  assert.deepEqual(JSON.parse(droid.answer('stop', { stdout: paused }).stdout), { systemMessage: 'paused' });
  const blocking = JSON.stringify({ decision: 'block', reason: 'x', continue: false, hookSpecificOutput: { permissionDecision: 'allow' } });
  for (const event of ['prompt', 'session_start', 'stop']) {
    assert.equal(droid.answer(event, { stdout: blocking }).stdout, '', event);
    // plain text after a prompt would go into the model's context as it is
    for (const stdout of ['', 'not json', '[]', '{"hookSpecificOutput":{"additionalContext":""}}']) assert.equal(droid.answer(event, { stdout }).stdout, '', `${event} ${stdout}`);
  }
  for (const event of ['post_edit', 'session_end', 'nonesuch']) {
    assert.deepEqual(droid.answer(event, { action: 'advise', text: 'x', stdout: paused }), { stdout: '' }, event);
  }
  for (const event of ['pre_edit', 'post_edit', 'prompt', 'session_start', 'session_end', 'stop']) assert.deepEqual(droid.neutral(event), { stdout: '' }, event);
  assert.deepEqual(droid.answer('pre_edit', { action: 'allow', files: [] }), { stdout: '' }, 'never an allow');

  // what is read from Droid's payloads
  registerClientTools('droid', droid.tools);
  const context = { client: 'droid', lib };
  const cwd = path.join(path.sep, 'r');
  const patch = tools.patchOf('src/b.ts', 'x', 'y');
  for (const key of ['patch', 'input', 'diff']) {
    const n = droid.parse('pre_edit', tools.toolUse('PreToolUse', cwd, 's', 'ApplyPatch', { [key]: patch }), context);
    assert.deepEqual([n.files, n.call.tool_name, n.call.tool_input], [['src/b.ts'], 'apply_patch', { patch }], key);
  }
  // an ApplyPatch that names only its file, as Factory's own guide reads it
  const named = droid.parse('pre_edit', tools.toolUse('PreToolUse', cwd, 's', 'ApplyPatch', { file_path: '/r/src/c.ts' }), context);
  assert.deepEqual([named.files, named.call.tool_name, named.tool], [['/r/src/c.ts'], 'Edit', 'ApplyPatch']);
  // both spellings of an Edit's text
  for (const payload of [tools.editStr(cwd, 's', 'a.ts', 'x', 'y'), tools.editString(cwd, 's', 'a.ts', 'x', 'y')]) {
    const n = droid.parse('pre_edit', payload, context);
    assert.deepEqual([n.call.tool_name, n.call.tool_input.old_string, n.call.tool_input.new_string, n.files], ['Edit', 'x', 'y', ['a.ts']]);
  }
  // after a Create, the absolute path the tool says it wrote
  const created = droid.parse('post_edit', tools.created(cwd, 's', 'b.ts', 'z\n', '/r/src/b.ts'), context);
  assert.deepEqual(created.call, { tool_name: 'Write', tool_input: { file_path: '/r/src/b.ts', content: 'z\n' } });
  assert.deepEqual(droid.parse('post_edit', tools.editFailed(cwd, 's', 'a.ts', 'x', 'y'), context).files, []);
  const shell = droid.parse('post_edit', tools.executed(cwd, 's', 'npm run build'), context);
  assert.deepEqual([shell.files, shell.command], [[], 'npm run build']);
  assert.deepEqual(droid.parse('pre_edit', tools.execute(cwd, 's', 'rm a.ts'), context).files, [], 'a command asks nothing before it runs');
  // camelCase, which one reference says Droid sends
  const camel = droid.parse('pre_edit', { sessionId: 's2', cwd, hookEventName: 'PreToolUse', toolName: 'Create', toolInput: { file_path: 'c.ts', content: 'q' } }, context);
  assert.deepEqual([camel.session_id, camel.files], ['s2', ['c.ts']]);
  assert.equal(droid.parse('prompt', userPromptSubmit(cwd, 's', 'do it'), context).prompt, 'do it');
  assert.equal(droid.parse('session_end', sessionEnd(cwd, 's', 'clear'), context).end_reason, 'clear');
  for (const bad of [null, [], 'x', 42]) assert.equal(droid.parse('pre_edit', bad, context), null);
});

test('anything wrong is exit 0 and silence, in time: garbage, the room down or hung, switched off, a client that is not one', async () => {
  const down = await startServer();
  const m = machine(down.port);
  await down.close();
  const payload = tools.editStr(m.project, session(), userTs(m), 'id: string', 'id: string; role: string');
  const fast = await hook('pre_edit', payload, m.env);
  silent(fast, 'the room is down');
  assert.ok(fast.elapsed < within(1500), `${fast.elapsed}ms`);

  for (const event of ['pre_edit', 'post_edit', 'prompt', 'session_start', 'session_end', 'stop']) {
    for (const garbage of ['not json at all', '', '[1,2]', '{"tool_name": 7, "tool_input": "x"}', 'null', '{"tool_name":']) {
      silent(await hook(event, garbage, m.env), `${event} ${JSON.stringify(garbage)}`);
    }
  }
  silent(await hook('pre_edit', { ...payload, tool_input: 'not an object' }, m.env), 'tool_input a string');
  silent(await hook('pre_edit', { ...payload, tool_input: { file_path: 42 } }, m.env), 'a path that is no string');
  silent(await hook('pre_edit', payload, { ...m.env, AGENTMASH_DISABLE: '1' }), 'switched off');
  silent(await hook('before_edit', payload, m.env), 'no such event');
  silent(await hook('pre_edit', payload, m.env, ['--global', '--client', 'Not A Name', '--dialect', 'droid']), 'a client that is not one');

  const hung = await startServer({ hang: true });
  const h = machine(hung.port);
  try {
    const slow = await hook('pre_edit', tools.editStr(h.project, session(), path.join(h.project, 'src', 'models', 'user.ts'), 'a', 'b'), {
      ...h.env,
      AGENTMASH_TIMEOUT_MS: '500',
    });
    silent(slow, 'the room never answers');
    assert.ok(slow.elapsed < within(500 + 250 + 400 + 600), `${slow.elapsed}ms`);
    assert.ok(hung.requests.some((r) => r.path === '/check'), 'it did ask');
  } finally {
    await hung.close();
  }
});

test("Claude Code's own hooks, imported into Droid, stay quiet there: Droid's hooks report it (lib.ranByDroid)", async () => {
  const server = await startServer();
  const m = machine(server.port, { committed: true });
  try {
    const edit = (mode, id = session()) => ({
      session_id: id,
      cwd: m.project,
      hook_event_name: 'PreToolUse',
      permission_mode: mode,
      tool_name: 'Edit',
      tool_input: { file_path: userTs(m), old_string: 'id: string', new_string: 'id: string; role: string' },
    });
    // the repository's committed hooks, run by Droid at one of its autonomy levels: nothing asked, nothing said
    for (const mode of ['off', 'spec', 'auto-low', 'auto-medium', 'auto-high']) {
      const out = await runHook('pre_tool_use.mjs', edit(mode), m.env);
      assert.deepEqual([out.code, out.stdout], [0, ''], mode);
      await runHook('post_tool_use.mjs', { ...edit(mode), hook_event_name: 'PostToolUse', tool_response: { success: true } }, m.env);
    }
    assert.equal(server.requests.filter((r) => r.path === '/check' || r.path === '/events').length, 0);
    // the same hooks in Claude Code, whatever its permission mode, ask as they always did
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions']) {
      const out = await runHook('pre_tool_use.mjs', edit(mode), m.env);
      assert.match(out.stdout, /PARALLEL EDIT/, mode);
    }
    assert.equal(server.requests.filter((r) => r.path === '/check').length, 3);
    // and Droid's own hooks, --client droid, are not held back by it
    assert.equal(lib.ranByDroid({ permission_mode: 'auto-low' }, 'droid'), false);
    assert.equal(lib.ranByDroid({ permission_mode: 'auto-low' }, null), true);
    assert.equal(lib.ranByDroid({ permission_mode: 'default' }, null), false);
  } finally {
    await server.close();
  }
});
