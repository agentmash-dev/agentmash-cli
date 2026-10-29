// Cline through the generic hook (agent_hook.mjs <event> --global --client
// cline, as the hook files cli/agents/cline.mjs writes run it, the dialect
// picked by the client's name), fed what Cline's two runners send, recorded
// in fixtures/cline/ with where each came from. Cline adds what a hook says
// to the model's context only after the tool call has run, and its one
// refusal stops the whole run. These tests pin that the advice before an edit
// goes as context that says so, that nothing ever cancels (strict mode
// included), that reads and commands ask nothing, that only edits that went
// through reach the room, as cline's, and that every way of failing is
// {"cancel":false} and exit 0, in time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOOKS_DIR, eventsOf, machine, runHook, session, startServer, within } from './fixtures.mjs';
import * as vscode from './fixtures/cline/vscode-4.1.22.mjs';
import * as cli from './fixtures/cline/cli-3.0.68.mjs';

/** What each of Cline's hook files runs, after node and the script. */
const hook = (event, payload, env) => runHook('agent_hook.mjs', payload, env, [event, '--global', '--client', 'cline']);
const NEUTRAL = '{"cancel":false}\n';
const ADVICE = /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts/;
const AFTER = /\n\nAgentMash checked this just before your edit, and Cline passes a hook's note on only after the tool call, so the edit was not held back for it\. Look at the file as it is now before you change it again\.$/;
const PATCH = ['*** Begin Patch', '*** Update File: src/models/user.ts', '@@', '-export interface User { id: string }', '+export interface User { id: string; role: string }', '*** End Patch'].join('\n');

/** The answer, read as Cline reads it: one JSON object, never a cancel. */
function said(out, what) {
  assert.equal(out.code, 0, `${what}: ${out.stderr}`);
  assert.equal(out.stderr, '', what);
  const answer = JSON.parse(out.stdout);
  assert.equal(answer.cancel, false, `${what}: never a cancel, which would stop the whole run`);
  return answer;
}

test('before an edit the file is asked about, and the advice goes as context that says it comes after the edit', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const before = [
      ['vs code editor', vscode.preEditorReplace({ taskId: session(), root: m.project })],
      ['cli apply_patch', cli.preApplyPatch({ session: session(), root: m.project, patch: PATCH })],
      ['cli editor insert, a subagent', cli.preEditorInsert({ session: session(), root: m.project, lead: session() })],
    ];
    for (const [what, payload] of before) {
      const answer = said(await hook('pre_edit', payload, m.env), what);
      assert.deepEqual(Object.keys(answer), ['cancel', 'contextModification'], what);
      assert.match(answer.contextModification, ADVICE, what);
      assert.match(answer.contextModification, AFTER, what);
    }
    const checks = server.requests.filter((r) => r.path === '/check');
    assert.equal(checks.length, before.length);
    assert.ok(checks.every((c) => c.query.file_path === 'src/models/user.ts' && c.user === 'amu_agentstokenagentstokenagent'), JSON.stringify(checks));
  } finally {
    await server.close();
  }
});

test('reads, searches, commands and a patch Cline sends without its text ask nothing', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const t = session();
    const asked = [
      ['read_files', vscode.preReadFiles({ taskId: t, root: m.project })],
      ['apply_patch as a bare string', vscode.preApplyPatchBare({ taskId: t, root: m.project })],
      ['search_codebase', { ...vscode.preReadFiles({ taskId: t, root: m.project }), preToolUse: { toolName: 'search_codebase', parameters: { queries: '["User"]' } } }],
      ['run_commands', { ...vscode.preReadFiles({ taskId: t, root: m.project }), preToolUse: { toolName: 'run_commands', parameters: { commands: '["npm test"]' } } }],
      ['an MCP tool', { ...vscode.preReadFiles({ taskId: t, root: m.project }), preToolUse: { toolName: 'agentmash__who_is_working_on_what', parameters: {} } }],
    ];
    for (const [what, payload] of asked) {
      const out = await hook('pre_edit', payload, m.env);
      assert.deepEqual([out.code, out.stdout, out.stderr], [0, NEUTRAL, ''], what);
    }
    assert.equal(server.requests.length, 0, 'nothing asked of the room');
  } finally {
    await server.close();
  }
});

test('after a tool only what went through is reported, as cline\'s, and the hook answers at once', async () => {
  const server = await startServer({ eventsDelayMs: 800 });
  const m = machine(server.port);
  try {
    const t = session();
    const user = path.join(m.project, 'src', 'models', 'user.ts');
    const after = [
      vscode.postEditorReplace({ taskId: t, root: m.project }),
      vscode.postEditorCreate({ taskId: t, root: m.project }),
      cli.postEditor({ session: session(), root: m.project, input: { path: 'src/models/user.ts', old_text: 'id', new_text: 'key' }, output: cli.editorDone(user) }),
      // not reported: rejected at Cline's prompt (VS Code leaves success out), and an edit whose old_text was not there
      vscode.postEditorRejected({ taskId: t, root: m.project }),
      cli.postEditor({ session: session(), root: m.project, input: { path: user, old_text: 'nope', new_text: 'x' }, output: cli.editorFailed(user) }),
    ];
    for (const payload of after) {
      const out = await hook('post_edit', payload, m.env);
      assert.deepEqual([out.code, out.stdout, out.stderr], [0, NEUTRAL, '']);
      assert.ok(out.elapsed < within(700), `the hook waited ${out.elapsed}ms on a report it had handed off`);
    }
    const edits = (await eventsOf(server, 3, 6000)).map((r) => r.body).filter((e) => e.event_type === 'edit');
    assert.deepEqual(
      edits.map((e) => [e.tool, e.file_path, e.change_summary]).sort(),
      [
        ['cline:Edit', 'src/models/user.ts', '+1/-1 lines'],
        ['cline:Edit', 'src/models/user.ts', '+2/-1 lines'],
        ['cline:Write', 'src/new.ts', 'wrote 2 lines, defining a'],
      ]
    );
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(server.requests.filter((r) => r.path === '/events').length, 3, 'the rejected and the failed edit were never sent');
    assert.ok(edits.every((e) => e.developer === 'bob' && e.git_branch === 'feat/login'));
  } finally {
    await server.close();
  }
});

test("a command's report is handed to the working tree's look, and answers at once", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const out = await hook('post_edit', cli.postRunCommands({ session: session(), root: m.project }), m.env);
    assert.deepEqual([out.code, out.stdout, out.stderr], [0, NEUTRAL, '']);
  } finally {
    await server.close();
  }
});

test("a prompt is reported as cline's, and the CLI's own reminders are not prompts", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const t = session();
    said(await hook('prompt', vscode.prompt({ taskId: t, root: m.project }), m.env), 'vs code');
    const queued = cli.promptSubmit({ session: session(), root: m.project, text: 'and keep the old ids' });
    said(await hook('prompt', queued, m.env), 'a message queued during a cli run');
    const reminder = cli.promptSubmit({ session: session(), root: m.project, text: '[SYSTEM] This run is not complete until you call submit_and_exit.' });
    assert.equal((await hook('prompt', reminder, m.env)).stdout, NEUTRAL);
    // a CLI before 3.0.63 sent what hooks add to the context as a prompt too: ours is not the person's
    const echoed = cli.promptSubmit({ session: session(), root: m.project, text: '<hook_context source="PreToolUse" tool_name="editor" tool_call_id="call_1">\n[AgentMash: PARALLEL EDIT] …\n</hook_context>' });
    assert.equal((await hook('prompt', echoed, m.env)).stdout, NEUTRAL);
    const empty = vscode.prompt({ taskId: t, root: m.project, text: '' });
    assert.equal((await hook('prompt', empty, m.env)).stdout, NEUTRAL);

    const prompts = (await eventsOf(server, 2)).map((r) => r.body).filter((e) => e.event_type === 'prompt');
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(prompts.map((e) => [e.tool, e.task_hint]).sort(), [
      ['cline', 'and keep the old ids'],
      ['cline', 'give the user a role'],
    ]);
    assert.equal(server.requests.filter((r) => r.path === '/events').length, 2, 'no reminder, no empty prompt');
  } finally {
    await server.close();
  }
});

test("the room's strict mode reaches Cline as advice, never as a cancel, and never says to make the edit again", async () => {
  const server = await startServer();
  const m = machine(server.port);
  const env = { ...m.env, AGENTMASH_STRICT: '1' };
  try {
    const t = session();
    for (let i = 0; i < 2; i++) {
      const answer = said(await hook('pre_edit', vscode.preEditorReplace({ taskId: t, root: m.project }), env), `try ${i + 1}`);
      assert.match(answer.contextModification, ADVICE);
      assert.match(answer.contextModification, /Cline cannot hold back one edit, so yours was not stopped\. Look at the file as it is now, and tell the user about the collision before you change it again\.$/);
      assert.doesNotMatch(answer.contextModification, /make the same edit again|blocked this edit|mkdir -p/);
    }
  } finally {
    await server.close();
  }
});

test('anything wrong is {"cancel":false} and exit 0: a room down or hung, garbage, another hook\'s payload, switched off', async () => {
  const neutral = async (event, payload, env, limit, what) => {
    const out = await hook(event, payload, env);
    assert.deepEqual([out.code, out.stdout, out.stderr], [0, NEUTRAL, ''], what);
    if (limit) assert.ok(out.elapsed < within(limit), `${what}: ${out.elapsed}ms`);
  };

  const down = await startServer();
  const m = machine(down.port);
  await down.close();
  await neutral('pre_edit', vscode.preEditorReplace({ taskId: session(), root: m.project }), m.env, 1500, 'room down');
  await neutral('post_edit', vscode.postEditorReplace({ taskId: session(), root: m.project }), m.env, 1500, 'room down, after');

  const hung = await startServer({ hang: true });
  const h = machine(hung.port);
  try {
    const env = { ...h.env, AGENTMASH_TIMEOUT_MS: '600' };
    await neutral('pre_edit', vscode.preEditorReplace({ taskId: session(), root: h.project }), env, 600 + 250 + 400 + 500, 'room never answers');
    assert.ok(hung.requests.some((r) => r.path === '/check'), 'it did ask');

    for (const garbage of ['not json', '', '[1,2]', 'null', '{"hookName":']) await neutral('pre_edit', garbage, h.env, null, JSON.stringify(garbage));
    const before = hung.requests.length;
    // a payload for another hook than the event it is run for: nothing in it for this one
    await neutral('pre_edit', vscode.postEditorReplace({ taskId: session(), root: h.project }), h.env, null, 'PostToolUse to pre_edit');
    await neutral('post_edit', vscode.prompt({ taskId: session(), root: h.project }), h.env, null, 'a prompt to post_edit');
    await neutral('session_start', vscode.prompt({ taskId: session(), root: h.project }), h.env, null, 'an event Cline is not wired for');
    await neutral('pre_edit', vscode.preEditorReplace({ taskId: session(), root: h.project }), { ...h.env, AGENTMASH_DISABLE: '1' }, null, 'switched off');
    assert.equal(hung.requests.length, before, 'none of them asked the room');
  } finally {
    await hung.close();
  }
});

test('what is read from each runner: the session, the folder, the file and what the edit was', async () => {
  const { default: dialect, parseCline } = await import(pathToFileURL(path.join(HOOKS_DIR, 'dialects', 'cline.mjs')).href);
  // absolute paths as this OS writes them: C:\work\app on Windows
  const root = path.resolve(path.sep, 'work', 'app');
  const other = path.resolve(path.sep, 'work', 'lib');

  // VS Code: every parameter a string; "null" is a value the model left out
  const replace = parseCline('pre_edit', vscode.preEditorReplace({ taskId: 't-1', root }));
  assert.deepEqual(replace, {
    session_id: 't-1',
    cwd: root,
    tool: 'editor',
    files: [{ path: path.join(root, 'src', 'models', 'user.ts'), before: 'id: string', after: 'id: string;\n  role: string' }],
  });
  const create = parseCline('pre_edit', { ...vscode.preEditorReplace({ taskId: 't-1', root }), preToolUse: { toolName: 'editor', parameters: { path: 'a.ts', old_text: 'null', new_text: 'x', insert_line: 'null' } } });
  assert.deepEqual(create.files, [{ path: path.join(root, 'a.ts'), after: 'x', action: 'write' }], 'no old_text: a file made, relative to the first root');
  const insert = parseCline('pre_edit', { ...vscode.preEditorReplace({ taskId: 't-1', root }), preToolUse: { toolName: 'editor', parameters: { path: 'a.ts', new_text: 'x', insert_line: '3' } } });
  assert.deepEqual(insert.files, [{ path: path.join(root, 'a.ts'), before: '', after: 'x' }], 'an insert removes nothing');

  // several roots: the one the file is in
  const twoRoots = { ...vscode.preEditorReplace({ taskId: 't-1', root, path: path.join(other, 'index.ts') }), workspaceRoots: [root, other] };
  assert.equal(parseCline('pre_edit', twoRoots).cwd, other);

  // the CLI: the call as the model sent it; a subagent's session is its lead's
  const sub = parseCline('pre_edit', cli.preEditorInsert({ session: 's-worker', root, lead: 's-lead' }));
  assert.deepEqual([sub.session_id, sub.agent_id, sub.files], ['s-lead', 'agent_01JC8N9WORKER', [{ path: path.join(root, 'src', 'models', 'user.ts'), before: '', after: '// roles\n' }]]);
  assert.equal(parseCline('pre_edit', cli.preApplyPatch({ session: 's', root, patch: PATCH })).patch, PATCH);
  assert.equal(parseCline('pre_edit', { ...cli.preApplyPatch({ session: 's', root, patch: PATCH }), tool_call: { id: 'c', name: 'apply_patch', input: PATCH } }).patch, PATCH, 'the patch alone');

  // the legacy edit names VS Code still counts
  const legacy = (toolName, parameters) => parseCline('pre_edit', { ...vscode.preEditorReplace({ taskId: 't', root }), preToolUse: { toolName, parameters } }).files;
  assert.deepEqual(legacy('write_to_file', { path: 'b.ts', content: 'y' }), [{ path: path.join(root, 'b.ts'), after: 'y', action: 'write' }]);
  assert.deepEqual(legacy('delete_file', { path: 'b.ts' }), [{ path: path.join(root, 'b.ts'), action: 'delete' }]);
  assert.deepEqual(legacy('replace_in_file', { path: 'b.ts', diff: '------- SEARCH\na\n=======\nb\n+++++++ REPLACE' }), [{ path: path.join(root, 'b.ts') }]);

  // its answers: context or nothing, and its tools for lib.mjs
  assert.equal(dialect.neutral('pre_edit').stdout, NEUTRAL);
  assert.equal(dialect.answer('post_edit', { action: 'advise', text: 'x' }).stdout, NEUTRAL, 'nothing is said after a tool');
  assert.equal(dialect.answer('prompt', { action: 'advise', text: 'alice is at work' }).stdout, '{"cancel":false,"contextModification":"alice is at work"}\n');
  assert.ok(JSON.parse(dialect.answer('pre_edit', { action: 'advise', text: 'x'.repeat(60_000) }).stdout).contextModification.length < 50_000, 'inside Cline\'s 50,000');
  assert.deepEqual(dialect.tools.patch, ['apply_patch']);
  assert.ok(dialect.tools.read.includes('read_files'));
});
