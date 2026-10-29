// Gemini CLI, as login connects it: every hook is the generic one
// (agent_hook.mjs) with --global --client gemini, and it answers in the
// dialect named like the client (dialects/gemini.mjs). These tests run it
// on Gemini CLI's own payloads, as its source at v0.62.0 writes them
// (fixtures/gemini/), and pin what Gemini CLI then does with each answer:
// the warning before an edit reaches the model as the reason of a refusal
// of the first try, and the same edit again goes on; reads and commands ask
// nothing; reports reach the room as the agent's; the heads-up is context
// under Gemini CLI's own event names; and anything going wrong is {} and
// exit 0, which lets the call go on as it would have without the hook.
// Nothing here is ever "allow", "ask", "continue" or a rewritten tool_input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as lib from '../lib.mjs';
import { clientToolKind, editedFiles, registerClientTools } from '../lib.mjs';
import { HOOKS_DIR, REF, eventsOf, machine, runHook, session, startServer, within } from './fixtures.mjs';
import * as before from './fixtures/gemini/before_tool.mjs';
import * as after from './fixtures/gemini/after_tool.mjs';
import { beforeAgent, withReferencedFile } from './fixtures/gemini/before_agent.mjs';
import { sessionEnd, sessionStart } from './fixtures/gemini/session.mjs';

/** As login registers it, less the node path and the redirect (cli/agents/gemini.mjs). */
const ARGS = ['--global', '--client', 'gemini'];
const hook = (event, payload, env, args = ARGS) => runHook('agent_hook.mjs', payload, env, [event, ...args]);
const NOTHING = '{}\n';
const userTs = (m) => path.join(m.project, 'src', 'models', 'user.ts');
const ORIGINAL = 'export interface User { id: string }\n';

/** What Gemini CLI must never be told by one of our hooks (see dialects/gemini.mjs). */
function sayNothingDangerous(stdout, what) {
  const said = JSON.parse(stdout);
  assert.ok(said && typeof said === 'object' && !Array.isArray(said), what);
  assert.equal('continue' in said, false, `${what}: continue would end the agent's loop`);
  assert.equal(JSON.stringify(said).includes('tool_input'), false, `${what}: a tool_input would rewrite the call`);
  assert.ok(said.decision === undefined || said.decision === 'deny', `${what}: decision ${said.decision}`);
  return said;
}

test('before an edit of a file a teammate is in: refused once with the warning as its reason, and the same edit again goes on', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const s = session();
    const payload = before.replace(m.project, s, userTs(m), 'id: string', 'id: string;\n  role: string');
    const first = await hook('pre_edit', payload, m.env);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stderr, '', 'Gemini CLI reads stderr when stdout is empty');
    const refused = sayNothingDangerous(first.stdout, 'first try');
    assert.deepEqual(Object.keys(refused), ['decision', 'reason']);
    assert.equal(refused.decision, 'deny');
    // the model reads it as "Tool execution blocked: <reason>", and its turn goes on
    assert.match(refused.reason, /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts/);
    assert.match(refused.reason, /make the same edit again and it goes through\.$/);
    const checks = server.requests.filter((r) => r.path === '/check');
    assert.deepEqual(checks.map((c) => c.query.file_path), ['src/models/user.ts']);
    assert.equal(checks[0].user, 'amu_agentstokenagentstokenagent');

    const again = await hook('pre_edit', payload, m.env);
    assert.deepEqual([again.code, again.stdout], [0, NOTHING], 'the same edit again: nothing said, the call goes on');

    // the model's own relative path, in a session of its own: told too
    const relative = await hook('pre_edit', before.writeFile(m.project, session(), 'src/models/user.ts', ORIGINAL), m.env);
    assert.equal(sayNothingDangerous(relative.stdout, 'relative').decision, 'deny');

    // a file nobody is in: asked about, and nothing said
    const free = await hook('pre_edit', before.writeFile(m.project, session(), 'src/index.ts', 'export {};\n'), m.env);
    assert.deepEqual([free.code, free.stdout], [0, NOTHING]);
    assert.ok(server.requests.some((r) => r.path === '/check' && r.query.file_path === 'src/index.ts'));
  } finally {
    await server.close();
  }
});

test("in the room's strict mode the edit is refused on every try, and nothing is ever an allow", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const env = { ...m.env, AGENTMASH_STRICT: '1' };
    const payload = before.replace(m.project, session(), userTs(m), 'id: string', 'id: string; role: string');
    for (let i = 0; i < 2; i++) {
      const out = await hook('pre_edit', payload, env);
      const said = sayNothingDangerous(out.stdout, `try ${i + 1}`);
      assert.equal(said.decision, 'deny');
      assert.match(said.reason, /AgentMash strict mode blocked this edit/);
    }
  } finally {
    await server.close();
  }
});

test('reads and shell commands ask nothing before they run, even with no matcher to keep them away', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    for (const payload of [
      before.readFile(m.project, session(), userTs(m)),
      before.readManyFiles(m.project, session()),
      before.shell(m.project, session(), `sed -i '' s/id/key/ ${userTs(m)}`),
    ]) {
      const out = await hook('pre_edit', payload, m.env);
      assert.deepEqual([out.code, out.stdout, out.stderr], [0, NOTHING, ''], payload.tool_name);
    }
    assert.equal(server.requests.length, 0, 'not a question asked of the room');

    // what the dialect declares, for the gemini client and for no other
    const { default: gemini } = await import(pathToFileURL(path.join(HOOKS_DIR, 'dialects', 'gemini.mjs')).href);
    assert.equal(registerClientTools('gemini', gemini.tools), true);
    assert.equal(clientToolKind('gemini', 'read_file'), 'read');
    assert.equal(clientToolKind('gemini', 'run_shell_command'), 'command');
    assert.deepEqual(editedFiles('read_file', { file_path: 'src/a.ts' }, 'gemini'), []);
    assert.deepEqual(editedFiles('replace', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, 'gemini'), ['src/a.ts']);
    assert.deepEqual(editedFiles('write_file', { file_path: 'src/a.ts', content: 'x' }, 'gemini'), ['src/a.ts']);
  } finally {
    await server.close();
  }
});

test("after an edit: reported as Gemini CLI's, from the file it says it wrote, at once; a failed edit is not reported", async () => {
  const server = await startServer({ eventsDelayMs: 800 });
  const m = machine(server.port);
  try {
    const s = session();
    const wrote = await hook('post_edit', after.writeFile(m.project, s, 'src/new.ts', 'export const b = 2;\n'), m.env);
    assert.deepEqual([wrote.code, wrote.stdout, wrote.stderr], [0, NOTHING, '']);
    assert.ok(wrote.elapsed < within(700), `the hook waited ${wrote.elapsed}ms on a report it had handed off`);

    // the model said src/model/user.ts; the tool corrected it, and says where it wrote
    const replaced = after.replace(m.project, s, 'src/model/user.ts', 'id: string', 'id: string;\n  role: string', {
      original: ORIGINAL,
      filePath: userTs(m),
    });
    assert.equal((await hook('post_edit', replaced, m.env)).stdout, NOTHING);
    assert.equal((await hook('post_edit', after.replaceCreated(m.project, s, 'src/created.ts', 'export const c = 3;\n'), m.env)).stdout, NOTHING);
    // failed: Gemini CLI runs AfterTool all the same, and there is nothing to report
    assert.equal((await hook('post_edit', after.replaceFailed(m.project, s, 'src/models/user.ts', 'nope', 'x'), m.env)).stdout, NOTHING);

    const edits = (await eventsOf(server, 3, 6000)).map((r) => r.body).filter((e) => e.event_type === 'edit');
    assert.deepEqual(
      edits.map((e) => [e.tool, e.file_path, e.change_summary]).sort(),
      [
        ['gemini:Edit', 'src/models/user.ts', '+2/-1 lines'],
        ['gemini:Write', 'src/created.ts', 'wrote 2 lines, defining c'],
        ['gemini:Write', 'src/new.ts', 'wrote 2 lines, defining b'],
      ]
    );
    assert.ok(edits.every((e) => e.developer === 'bob' && e.git_branch === 'feat/login' && e.session_id === s));
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(server.requests.filter((r) => r.path === '/events').length, 3, 'the failed replace sent nothing');
    assert.ok(!JSON.stringify(server.requests).includes('Successfully'), "the tool's output stays on the machine");
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
      return send(201, { ok: true });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: server.address().port, requests, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))) })
    )
  );
}

test("the heads-up is context the model reads, under Gemini CLI's own event names; the prompt reported is only what was typed", async () => {
  const server = await teamServer();
  const m = machine(server.port);
  try {
    const started = await hook('session_start', sessionStart(m.project, session()), m.env);
    assert.equal(started.code, 0, started.stderr);
    const start = sayNothingDangerous(started.stdout, 'SessionStart');
    assert.deepEqual(Object.keys(start), ['hookSpecificOutput']);
    assert.equal(start.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(start.hookSpecificOutput.additionalContext, /carol/);

    const s = session();
    const typed = 'fix the role check in @src/models/user.ts';
    const asked = await hook('prompt', beforeAgent(m.project, s, withReferencedFile(typed, 'src/models/user.ts', ORIGINAL)), m.env);
    assert.equal(asked.code, 0, asked.stderr);
    const prompt = sayNothingDangerous(asked.stdout, 'BeforeAgent');
    assert.deepEqual(prompt.hookSpecificOutput && Object.keys(prompt.hookSpecificOutput), ['hookEventName', 'additionalContext']);
    assert.equal(prompt.hookSpecificOutput.hookEventName, 'BeforeAgent');
    assert.match(prompt.hookSpecificOutput.additionalContext, /carol/);

    const ended = await hook('session_end', sessionEnd(m.project, s), m.env);
    assert.deepEqual([ended.code, ended.stdout], [0, NOTHING]);

    const events = (await eventsOf(server, 2, 6000)).map((r) => r.body);
    const reported = events.find((e) => e.event_type === 'prompt');
    assert.deepEqual([reported.tool, reported.task_hint, reported.session_id], ['gemini', typed, s]);
    assert.ok(!JSON.stringify(events).includes('export interface User'), 'a file named with @ never leaves with the prompt');
    const end = events.find((e) => e.event_type === 'session_end');
    assert.deepEqual([end.tool, end.end_reason, end.session_id], ['gemini', 'exit', s]);
  } finally {
    await server.close();
  }
});

test("the dialect's answers, each as Gemini CLI reads it", async () => {
  const { default: gemini } = await import(pathToFileURL(path.join(HOOKS_DIR, 'dialects', 'gemini.mjs')).href);
  // a paused sign-in: said to the person, and to the model
  const paused = JSON.stringify({ systemMessage: 'paused', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'paused' } });
  assert.deepEqual(JSON.parse(gemini.answer('prompt', { stdout: paused }).stdout), {
    systemMessage: 'paused',
    hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: 'paused' },
  });
  for (const stdout of ['', 'not json', '[]', '{"hookSpecificOutput":{"additionalContext":""}}']) {
    assert.equal(gemini.answer('session_start', { stdout }).stdout, NOTHING, stdout);
  }
  for (const event of ['post_edit', 'session_end', 'stop', 'nonesuch']) {
    assert.equal(gemini.answer(event, { action: 'advise', text: 'x', stdout: paused }).stdout, NOTHING, event);
    assert.equal(gemini.neutral(event).stdout, NOTHING, event);
  }
  assert.equal(gemini.neutral('pre_edit').stdout, NOTHING, 'never an allow');
  assert.equal(gemini.answer('pre_edit', { action: 'allow', files: [] }).stdout, NOTHING);

  // what is read from Gemini CLI's payloads: a failed edit names nothing, a replace that made a file is its write
  registerClientTools('gemini', gemini.tools);
  const context = { client: 'gemini', lib };
  const cwd = path.join(path.sep, 'r');
  assert.deepEqual(gemini.parse('post_edit', after.replaceFailed(cwd, 's', 'a.ts', 'x', 'y'), context), { session_id: 's', cwd, files: [] });
  const created = gemini.parse('post_edit', after.replaceCreated(cwd, 's', 'b.ts', 'z\n'), context);
  assert.deepEqual(created.call, { tool_name: 'Write', tool_input: { file_path: 'b.ts', content: 'z\n' } });
  const replaced = gemini.parse('post_edit', after.replace(cwd, 's', 'a.ts', 'x', 'y', { original: 'x\n', filePath: '/r/src/a.ts' }), context);
  assert.deepEqual([replaced.files, replaced.call.tool_name, replaced.call.tool_input.file_path], [['/r/src/a.ts'], 'Edit', '/r/src/a.ts']);
  const shell = gemini.parse('post_edit', after.shell(cwd, 's', 'npm run build'), context);
  assert.deepEqual([shell.files, shell.command], [[], 'npm run build']);
  assert.equal(gemini.parse('prompt', beforeAgent(cwd, 's', withReferencedFile('do it', 'a.ts', 'secret')), context).prompt, 'do it');
  assert.equal(gemini.parse('pre_edit', 'not an object', context), null);
});

test('anything wrong is {} and exit 0, in time: a room that is down, input that is not a payload, AgentMash switched off', async () => {
  const down = await startServer();
  const m = machine(down.port);
  await down.close();
  const payload = before.replace(m.project, session(), userTs(m), 'id: string', 'id: string; role: string');
  const refused = await hook('pre_edit', payload, m.env);
  assert.deepEqual([refused.code, refused.stdout, refused.stderr], [0, NOTHING, '']);
  assert.ok(refused.elapsed < within(1500), `${refused.elapsed}ms`);

  for (const event of ['pre_edit', 'post_edit', 'prompt', 'session_start', 'session_end']) {
    for (const garbage of ['not json at all', '', '[1,2]', '{"tool_name": 7, "tool_input": "x"}', 'null']) {
      const out = await hook(event, garbage, m.env);
      assert.deepEqual([out.code, out.stdout, out.stderr], [0, NOTHING, ''], `${event} ${JSON.stringify(garbage)}`);
    }
  }
  const off = await hook('pre_edit', payload, { ...m.env, AGENTMASH_DISABLE: '1' });
  assert.deepEqual([off.code, off.stdout], [0, NOTHING]);
  // a client that is not one: the hook says nothing it could be wrong about
  const wrong = await hook('pre_edit', payload, m.env, ['--global', '--client', 'Not A Name', '--dialect', 'gemini']);
  assert.deepEqual([wrong.code, wrong.stdout], [0, NOTHING]);
});
