// OpenHands, through the generic hook (agent_hook.mjs) in OpenHands' dialect
// (dialects/openhands.mjs): each test runs the very commands `npx agentmash
// login` registers (cli/agents/openhands.mjs) on what the OpenHands Software
// Agent SDK sends a hook (fixtures/openhands/, from its source at v1.21.0 and
// v1.51.0), from a temporary home and a room on a port of its own, in the
// workspace, with the environment OpenHands gives a hook. OpenHands reads a
// flat decision before a tool and nothing it could add to a call it lets
// run, so these pin that the advice goes as a refusal of the first try and
// never of the second, that the heads-up at a prompt is the additionalContext
// the model reads, that reads ask nothing, that reports reach the room as
// OpenHands', and that every way of failing prints nothing and exits 0
// (OpenHands reads a deny in stdout, or exit status 2, as a refusal).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { openhandsHooks } from '../../cli/agents/openhands.mjs';
import { HOOKS_DIR, REF, baseEnv, eventsOf, machine, session, startServer, within } from './fixtures.mjs';
import * as tool from './fixtures/openhands/tool-events.mjs';
import { prompt, sessionEnd } from './fixtures/openhands/session-events.mjs';

/** The arguments each of OpenHands' events runs agent_hook.mjs with, as login registers them. */
const REGISTERED = Object.fromEntries(
  Object.entries(openhandsHooks(HOOKS_DIR)).map(([event, groups]) => {
    const { command } = groups[0].hooks[0];
    const quoted = `node "${path.join(HOOKS_DIR, 'agent_hook.mjs')}" `;
    assert.ok(command.startsWith(quoted), command);
    return [event, command.slice(quoted.length).split(' ')];
  })
);

/**
 * Run the hook OpenHands runs for `ohEvent` on `payload`, as it runs one: in
 * the workspace, with the variables it sets (hooks/executor.py):
 * { code, stdout, stderr, elapsed }.
 */
function openhands(ohEvent, payload, env, { cwd = payload?.working_dir ?? process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(HOOKS_DIR, 'agent_hook.mjs'), ...REGISTERED[ohEvent]], {
      cwd,
      env: {
        ...baseEnv,
        OPENHANDS_PROJECT_DIR: cwd,
        OPENHANDS_SESSION_ID: payload?.session_id ?? '',
        OPENHANDS_EVENT_TYPE: ohEvent,
        OPENHANDS_TOOL_NAME: payload?.tool_name ?? '',
        AI_AGENT: 'openhands',
        ...env,
      },
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

const userTs = (m) => path.join(m.project, 'src', 'models', 'user.ts');
const ORIGINAL = 'export interface User { id: string }\n';
const at = (m) => ({ session_id: session(), working_dir: m.project });

/** What OpenHands must never be told by one of our hooks: a deny is the only decision, and only before an edit. */
function readAnswer(stdout, what) {
  if (stdout === '') return null;
  const said = JSON.parse(stdout);
  assert.ok(said && typeof said === 'object' && !Array.isArray(said), what);
  assert.equal('continue' in said, false, `${what}: continue false refuses the call`);
  assert.ok(said.decision === undefined || said.decision === 'deny', `${what}: decision ${said.decision}`);
  assert.equal('hookSpecificOutput' in said, false, `${what}: Claude Code's shape, which OpenHands does not read`);
  return said;
}

test('before an edit of a file a teammate is in: refused once with the warning as its reason, and the same edit again goes on', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const payload = tool.preStrReplace({ ...at(m), path: userTs(m) });
    const first = await openhands('PreToolUse', payload, m.env);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stderr, '');
    const refused = readAnswer(first.stdout, 'first try');
    assert.deepEqual(Object.keys(refused), ['decision', 'reason']);
    assert.equal(refused.decision, 'deny');
    // the model reads it as "Action rejected: <reason>", and its turn goes on
    assert.match(refused.reason, /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts/);
    assert.match(refused.reason, /make the same edit again and it goes through\.$/);
    const checks = server.requests.filter((r) => r.path === '/check');
    assert.deepEqual(checks.map((c) => c.query.file_path), ['src/models/user.ts']);
    assert.equal(checks[0].user, 'amu_agentstokenagentstokenagent');

    const again = await openhands('PreToolUse', payload, m.env);
    assert.deepEqual([again.code, again.stdout, again.stderr], [0, '', ''], 'the same edit again: nothing said, the call goes on');

    // every preset's edit tool, each in a session of its own: told too
    const patch = '*** Begin Patch\n*** Update File: src/models/user.ts\n@@\n-export interface User { id: string }\n+export interface User { id: string; role: string }\n*** End Patch';
    for (const other of [
      tool.preStrReplace({ ...at(m), path: userTs(m), tool_name: 'planning_file_editor' }),
      tool.preInsert({ ...at(m), path: userTs(m) }),
      tool.preGeminiEdit({ ...at(m), file_path: 'src/models/user.ts' }),
      tool.preApplyPatch({ ...at(m), patch }),
    ]) {
      const out = await openhands('PreToolUse', other, m.env);
      assert.equal(readAnswer(out.stdout, other.tool_name)?.decision, 'deny', `${other.tool_name} ${other.tool_input.command ?? ''}`);
    }

    // a file nobody is in: asked about, and nothing said
    const free = await openhands('PreToolUse', tool.preCreate({ ...at(m), path: path.join(m.project, 'src', 'index.ts') }), m.env);
    assert.deepEqual([free.code, free.stdout], [0, '']);
    assert.ok(server.requests.some((r) => r.path === '/check' && r.query.file_path === 'src/index.ts'));
  } finally {
    await server.close();
  }
});

test("in the room's strict mode the edit is refused on every try", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const env = { ...m.env, AGENTMASH_STRICT: '1' };
    const payload = tool.preStrReplace({ ...at(m), path: userTs(m) });
    for (let i = 0; i < 2; i++) {
      const out = await openhands('PreToolUse', payload, env);
      const said = readAnswer(out.stdout, `try ${i + 1}`);
      assert.equal(said.decision, 'deny');
      assert.match(said.reason, /AgentMash strict mode blocked this edit/);
    }
  } finally {
    await server.close();
  }
});

test("a view, and a shell command, ask nothing before they run, even when the matcher sends them", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    for (const payload of [
      tool.preView({ ...at(m), path: userTs(m) }),
      tool.preView({ ...at(m), path: userTs(m), tool_name: 'planning_file_editor' }),
      tool.preTerminal({ ...at(m) }),
    ]) {
      const out = await openhands('PreToolUse', payload, m.env);
      assert.deepEqual([out.code, out.stdout, out.stderr], [0, '', ''], `${payload.tool_name} ${payload.tool_input.command}`);
    }
    assert.equal(server.requests.length, 0, 'not a question asked of the room');
  } finally {
    await server.close();
  }
});

test("after an edit: reported as OpenHands', at once; a view, or an edit that failed, is not reported", async () => {
  const server = await startServer({ eventsDelayMs: 800 });
  const m = machine(server.port);
  try {
    const s = { session_id: session(), working_dir: m.project };
    const replaced = await openhands(
      'PostToolUse',
      tool.postStrReplace({ ...s, path: userTs(m), old_str: 'id: string', new_str: 'id: string;\n  role: string', before: ORIGINAL, after: 'export interface User { id: string;\n  role: string }\n' }),
      m.env
    );
    assert.deepEqual([replaced.code, replaced.stdout, replaced.stderr], [0, '', '']);
    assert.ok(replaced.elapsed < within(700), `the hook waited ${replaced.elapsed}ms on a report it had handed off`);

    const created = path.join(m.project, 'src', 'new.ts');
    assert.equal((await openhands('PostToolUse', tool.postCreate({ ...s, path: created, file_text: 'export const b = 2;\n' }), m.env)).stdout, '');
    // the gemini preset: write_file, and an edit the model named relative to the workspace
    assert.equal((await openhands('PostToolUse', tool.postWriteFile({ ...s, file_path: path.join(m.project, 'src', 'w.ts'), content: 'export const w = 1;\n' }), m.env)).stdout, '');
    const relative = tool.postGeminiEdit({ ...s, file_path: 'src/models/user.ts', old_string: 'id: string', new_string: 'id: number', resolved: userTs(m) });
    assert.equal((await openhands('PostToolUse', relative, m.env)).stdout, '');
    // nothing to report: a view, a str_replace that found nothing, an edit that failed
    assert.equal((await openhands('PostToolUse', tool.postView({ ...s, path: userTs(m), content: ORIGINAL }), m.env)).stdout, '');
    const failed = tool.postStrReplace({ ...s, path: userTs(m), old_str: 'nope', new_str: 'x', is_error: true });
    assert.equal((await openhands('PostToolUse', failed, m.env)).stdout, '');
    const failedEdit = tool.postGeminiEdit({ ...s, file_path: 'src/models/user.ts', old_string: 'nope', new_string: 'x', is_error: true });
    assert.equal((await openhands('PostToolUse', failedEdit, m.env)).stdout, '');

    const edits = (await eventsOf(server, 4, 6000)).map((r) => r.body).filter((e) => e.event_type === 'edit');
    assert.deepEqual(
      edits.map((e) => [e.tool, e.file_path, e.change_summary]).sort(),
      [
        ['openhands:Edit', 'src/models/user.ts', '+1/-1 lines'],
        ['openhands:Edit', 'src/models/user.ts', '+2/-1 lines'],
        ['openhands:Write', 'src/new.ts', 'wrote 2 lines, defining b'],
        ['openhands:Write', 'src/w.ts', 'wrote 2 lines, defining w'],
      ]
    );
    assert.ok(edits.every((e) => e.developer === 'bob' && e.git_branch === 'feat/login' && e.session_id === s.session_id));
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(server.requests.filter((r) => r.path === '/events').length, 4, 'the view and the failed edits sent nothing');
    assert.ok(!JSON.stringify(server.requests).includes('has been edited'), "the tool's output stays on the machine");
  } finally {
    await server.close();
  }
});

test('a patch is reported file by file, and a shell command hands its report off at once', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const s = { session_id: session(), working_dir: m.project };
    const patch = '*** Begin Patch\n*** Add File: src/role.ts\n+export type Role = string;\n*** End Patch';
    const patched = await openhands('PostToolUse', tool.postApplyPatch({ ...s, patch }), m.env);
    assert.deepEqual([patched.code, patched.stdout, patched.stderr], [0, '', '']);
    const [event] = (await eventsOf(server, 1, 6000)).map((r) => r.body);
    assert.deepEqual([event.event_type, event.tool, event.file_path], ['edit', 'openhands:apply_patch', 'src/role.ts']);

    const ran = await openhands('PostToolUse', tool.postTerminal({ ...s }), m.env);
    assert.deepEqual([ran.code, ran.stdout, ran.stderr], [0, '', '']);
    assert.ok(ran.elapsed < within(1000), `${ran.elapsed}ms`);
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

test('the heads-up at a prompt is the additionalContext OpenHands adds to it; the prompt and the end of the session are reported', async () => {
  const server = await teamServer();
  const m = machine(server.port);
  try {
    const s = { session_id: session(), working_dir: m.project };
    const typed = 'add a role to the user model';
    const asked = await openhands('UserPromptSubmit', prompt({ ...s, message: typed }), m.env);
    assert.equal(asked.code, 0, asked.stderr);
    const said = readAnswer(asked.stdout, 'UserPromptSubmit');
    assert.deepEqual(Object.keys(said), ['additionalContext']);
    assert.match(said.additionalContext, /carol/);

    const ended = await openhands('SessionEnd', sessionEnd(s), m.env);
    assert.deepEqual([ended.code, ended.stdout, ended.stderr], [0, '', '']);

    const events = (await eventsOf(server, 2, 6000)).map((r) => r.body);
    const reported = events.find((e) => e.event_type === 'prompt');
    assert.deepEqual([reported.tool, reported.task_hint, reported.session_id], ['openhands', typed, s.session_id]);
    const end = events.find((e) => e.event_type === 'session_end');
    assert.deepEqual([end.tool, end.session_id], ['openhands', s.session_id]);
  } finally {
    await server.close();
  }
});

test("the dialect's answers, and what it reads from OpenHands' payloads", async () => {
  const { default: dialect } = await import(pathToFileURL(path.join(HOOKS_DIR, 'dialects', 'openhands.mjs')).href);
  // never "allow", never anything at all but a refusal before an edit and context at a prompt
  for (const event of ['pre_edit', 'post_edit', 'prompt', 'session_start', 'session_end', 'stop', 'nonesuch']) {
    assert.equal(dialect.neutral(event).stdout, '', event);
    assert.equal(dialect.answer(event, { action: 'allow', files: [], stdout: '' }).stdout, '', event);
  }
  const context = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'carol is here' } });
  assert.equal(dialect.answer('prompt', { stdout: context }).stdout, '{"additionalContext":"carol is here"}\n');
  // a paused sign-in: what the model reads is the additionalContext, never the person's systemMessage alone
  assert.equal(dialect.answer('prompt', { stdout: JSON.stringify({ systemMessage: 'paused' }) }).stdout, '');
  for (const stdout of ['', 'not json', '[]', '{"hookSpecificOutput":{"additionalContext":""}}']) assert.equal(dialect.answer('prompt', { stdout }).stdout, '', stdout);
  for (const event of ['post_edit', 'session_end', 'stop']) assert.equal(dialect.answer(event, { action: 'advise', text: 'x', stdout: context }).stdout, '', event);

  const s = { session_id: 's-1', working_dir: '/r' };
  const parse = (event, payload) => dialect.parse(event, payload);
  assert.equal(parse('pre_edit', 'not an object'), null);
  assert.equal(parse('pre_edit', [1]), null);
  assert.deepEqual(parse('pre_edit', tool.preView({ ...s, path: '/r/a.ts' })), { session_id: 's-1', cwd: '/r', tool: 'file_editor', files: [] });
  assert.deepEqual(parse('pre_edit', tool.preStrReplace({ ...s, path: '/r/a.ts', old_str: 'x', new_str: 'y' })).files, [{ path: '/r/a.ts', before: 'x', after: 'y' }]);
  assert.deepEqual(parse('pre_edit', tool.preCreate({ ...s, path: '/r/b.ts', file_text: 'z\n' })).files, [{ path: '/r/b.ts', action: 'write', after: 'z\n' }]);
  assert.deepEqual(parse('pre_edit', tool.preInsert({ ...s, path: '/r/a.ts', new_str: 'w\n' })).files, [{ path: '/r/a.ts', before: '', after: 'w\n' }]);
  const undo = tool.preStrReplace({ ...s, path: '/r/a.ts' });
  undo.tool_input.command = 'undo_edit';
  assert.deepEqual(parse('pre_edit', undo).files, [{ path: '/r/a.ts', action: 'edit' }]);
  // str_replace with no new_str takes the text out
  const cut = tool.preStrReplace({ ...s, path: '/r/a.ts', old_str: 'x', new_str: null });
  assert.deepEqual(parse('pre_edit', cut).files, [{ path: '/r/a.ts', before: 'x', after: '' }]);
  // the gemini preset's edit with old_string "" makes a file; after it ran, the path it resolved
  assert.deepEqual(parse('pre_edit', tool.preGeminiEdit({ ...s, file_path: 'n.ts', old_string: '', new_string: 'n\n' })).files, [{ path: 'n.ts', action: 'write', after: 'n\n' }]);
  const edited = parse('post_edit', tool.postGeminiEdit({ ...s, file_path: 'a.ts', old_string: 'x', new_string: 'y', resolved: '/r/a.ts' }));
  assert.deepEqual(edited.files, [{ path: '/r/a.ts', before: 'x', after: 'y' }]);
  assert.deepEqual(parse('post_edit', tool.postStrReplace({ ...s, path: '/r/a.ts', old_str: 'x', new_str: 'y', is_error: true })).files, []);
  assert.equal(parse('pre_edit', tool.preApplyPatch({ ...s, patch: '*** Begin Patch\n*** End Patch' })).patch, '*** Begin Patch\n*** End Patch');
  // a command: reported after it runs, from the working tree; nothing before it
  assert.equal(parse('post_edit', tool.postTerminal({ ...s, command: 'make' })).command, 'make');
  assert.equal(parse('pre_edit', tool.preTerminal({ ...s })).command, undefined);
  // a tool of somebody's MCP server, or one OpenHands adds later: nothing
  assert.deepEqual(parse('pre_edit', { ...tool.preView({ ...s, path: '/r/a.ts' }), tool_name: 'github_create_file' }).files, []);
  assert.deepEqual(parse('prompt', prompt({ ...s, message: 'do it' })), { session_id: 's-1', cwd: '/r', prompt: 'do it' });
  assert.deepEqual(parse('session_end', { ...sessionEnd(s), metadata: { reason: 'closed' } }), { session_id: 's-1', cwd: '/r', end_reason: 'closed' });

  // a payload missing its session or workspace: the environment OpenHands gives every hook
  const saved = { id: process.env.OPENHANDS_SESSION_ID, dir: process.env.OPENHANDS_PROJECT_DIR };
  try {
    process.env.OPENHANDS_SESSION_ID = 'from-env';
    process.env.OPENHANDS_PROJECT_DIR = '/w';
    assert.deepEqual(parse('prompt', { message: 'hi' }), { session_id: 'from-env', cwd: '/w', prompt: 'hi' });
  } finally {
    for (const [key, value] of [['OPENHANDS_SESSION_ID', saved.id], ['OPENHANDS_PROJECT_DIR', saved.dir]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('anything wrong prints nothing and exits 0, in time: a room that is down, input that is not a payload, AgentMash switched off', async () => {
  const down = await startServer();
  const m = machine(down.port);
  await down.close();
  const payload = tool.preStrReplace({ ...at(m), path: userTs(m) });
  const refused = await openhands('PreToolUse', payload, m.env);
  assert.deepEqual([refused.code, refused.stdout, refused.stderr], [0, '', '']);
  assert.ok(refused.elapsed < within(1500), `${refused.elapsed}ms`);

  for (const event of Object.keys(REGISTERED)) {
    for (const garbage of ['not json at all', '', '[1,2]', '{"tool_name": 7, "tool_input": "x"}', 'null', '{"event_type":"PreToolUse","tool_input":{"command":"str_replace"}}']) {
      const out = await openhands(event, garbage, m.env, { cwd: m.project });
      assert.deepEqual([out.code, out.stdout, out.stderr], [0, '', ''], `${event} ${JSON.stringify(garbage)}`);
    }
  }
  const off = await openhands('PreToolUse', payload, { ...m.env, AGENTMASH_DISABLE: '1' });
  assert.deepEqual([off.code, off.stdout], [0, '']);
});

test('the command login registers runs as OpenHands runs it (sh -c, in the workspace), and with its hooks folder gone fails as an error, never a refusal', { skip: process.platform === 'win32' && 'sh' }, async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const sh = (command, payload) =>
      new Promise((resolve, reject) => {
        const child = spawn('sh', ['-c', command], { cwd: m.project, env: { ...baseEnv, ...m.env }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout }));
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(payload));
      });
    const { command } = openhandsHooks(HOOKS_DIR).PreToolUse[0].hooks[0];
    const payload = tool.preStrReplace({ ...at(m), path: userTs(m) });
    const ran = await sh(command, payload);
    assert.equal(ran.code, 0);
    assert.equal(readAnswer(ran.stdout, 'sh -c').decision, 'deny');

    // a hooks folder that is gone: node fails (1), which OpenHands logs and goes past; only 2 would refuse
    const gone = path.join(m.home, 'gone', '.agentmash', 'hooks');
    fs.mkdirSync(path.dirname(gone), { recursive: true });
    const failed = await sh(openhandsHooks(gone).PreToolUse[0].hooks[0].command, payload);
    assert.notEqual(failed.code, 2);
    assert.notEqual(failed.code, 0);
    assert.equal(failed.stdout, '');
  } finally {
    await server.close();
  }
});
