// The hooks as the other coding agents run them. `npx agentmash login`
// registers the same scripts with Codex (~/.codex/hooks.json) and GitHub
// Copilot (~/.copilot/hooks/agentmash.json), each with `--global --client
// <agent>`, and the reports that Claude Code runs async with `--detach`, since
// neither host waits for a hook in the background. Each agent names its edit
// tools and their files its own way, and sends its own shape of payload: what
// these tests pin is that every one of them is advised before an edit,
// reported after it, and says which agent it was.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { asClaudeEdit, clientTool, editedFiles, hookClient, normalizeHookInput, summarizeChange } from '../lib.mjs';
import { KEY, USER_TOKEN, eventsOf, machine, runHook, session, startServer, within } from './fixtures.mjs';

const PATCH = (project) =>
  [
    '*** Begin Patch',
    '*** Update File: src/models/user.ts',
    '@@',
    '-export interface User { id: string }',
    '+export interface User { id: string; role: string }',
    '*** End Patch',
  ].join('\n');

/** Codex's own payloads, as codex-rs/hooks/schema/generated describes them. */
const codex = {
  pre: (project, session) => ({
    session_id: session,
    turn_id: 't-1',
    transcript_path: null,
    cwd: project,
    hook_event_name: 'PreToolUse',
    model: 'gpt-5.5-codex',
    permission_mode: 'default',
    tool_name: 'apply_patch',
    tool_use_id: 'call_1',
    tool_input: { command: PATCH(project) },
  }),
  post: (project, session) => ({ ...codex.pre(project, session), hook_event_name: 'PostToolUse', tool_response: 'Success.' }),
  prompt: (project, session) => ({
    session_id: session,
    turn_id: 't-1',
    transcript_path: null,
    cwd: project,
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-5.5-codex',
    permission_mode: 'default',
    prompt: 'give the user a role',
  }),
  end: (project, session) => ({ session_id: session, transcript_path: null, cwd: project, hook_event_name: 'SessionEnd', reason: 'other' }),
};

test('every agent names its files its own way, and the hooks read them all', () => {
  const abs = '/r/src/a.ts';
  // Codex and Devin, and Copilot in VS Code: a patch in its text
  assert.deepEqual(editedFiles('apply_patch', { command: '*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch' }), ['a.ts']);
  assert.deepEqual(editedFiles('apply_patch', { input: '*** Begin Patch\n*** Update File: b.ts\n*** End Patch', explanation: 'x' }), ['b.ts']);
  // Copilot in VS Code
  assert.deepEqual(editedFiles('create_file', { filePath: abs, content: 'x' }), [abs]);
  assert.deepEqual(editedFiles('replace_string_in_file', { filePath: abs, oldString: 'a', newString: 'b' }), [abs]);
  assert.deepEqual(editedFiles('insert_edit_into_file', { filePath: abs, code: 'x' }), [abs]);
  assert.deepEqual(
    editedFiles('multi_replace_string_in_file', {
      replacements: [
        { filePath: abs, oldString: 'a', newString: 'b' },
        { filePath: '/r/src/b.ts', oldString: 'c', newString: 'd' },
        { filePath: abs, oldString: 'e', newString: 'f' },
      ],
    }),
    [abs, '/r/src/b.ts']
  );
  assert.deepEqual(editedFiles('editFiles', { files: [abs, { filePath: '/r/b.ts' }] }), [abs, '/r/b.ts']);
  // Copilot CLI, and Devin
  assert.deepEqual(editedFiles('create', { path: 'src/a.ts', file_text: 'x' }), ['src/a.ts']);
  assert.deepEqual(editedFiles('edit', { path: 'src/a.ts', old_str: 'a', new_str: 'b' }), ['src/a.ts']);
  // reading is not editing, whoever does it, and a path is a file only to an edit tool
  assert.deepEqual(editedFiles('read_file', { filePath: abs, startLine: 1, endLine: 9 }), []);
  assert.deepEqual(editedFiles('view', { path: 'src/a.ts' }), []);
  assert.deepEqual(editedFiles('run_in_terminal', { command: 'ls' }), []);
});

test('an edit in any agent\'s shape is summarised the way a Claude Code edit is', () => {
  const said = (tool, input) => {
    const edit = asClaudeEdit(tool, input);
    return summarizeChange(edit.tool, edit.input);
  };
  assert.equal(said('create_file', { filePath: 'a.ts', content: 'export const a = 1;\n' }), 'wrote 2 lines, defining a');
  assert.equal(said('create', { path: 'a.ts', file_text: 'one\ntwo' }), 'wrote 2 lines');
  assert.equal(said('replace_string_in_file', { filePath: 'a.ts', oldString: 'a', newString: 'b\nc' }), '+2/-1 lines');
  assert.equal(said('edit', { path: 'a.ts', old_str: 'a', new_str: 'b' }), '+1/-1 lines');
  assert.equal(
    said('multi_replace_string_in_file', { replacements: [{ filePath: 'a.ts', oldString: 'a', newString: 'b' }, { filePath: 'a.ts', oldString: 'c', newString: 'd' }] }),
    '2 edits, +2/-2 lines'
  );
  assert.equal(said('insert_edit_into_file', { filePath: 'a.ts', code: 'x\ny' }), '+2/-0 lines');
  // Claude Code's own are left as they are
  assert.deepEqual(asClaudeEdit('Edit', { old_string: 'a' }), { tool: 'Edit', input: { old_string: 'a' } });
});

test('a payload in camelCase, or with its tool input as a JSON string, reads as a Claude Code one', () => {
  const normal = normalizeHookInput({
    sessionId: 's-1',
    hookEventName: 'preToolUse',
    toolName: 'edit',
    toolArgs: JSON.stringify({ path: 'a.ts', old_str: 'a', new_str: 'b' }),
    cwd: '/r',
  });
  assert.equal(normal.session_id, 's-1');
  assert.equal(normal.tool_name, 'edit');
  assert.deepEqual(normal.tool_input, { path: 'a.ts', old_str: 'a', new_str: 'b' });
  assert.deepEqual(normalizeHookInput({ session_id: 's', tool_input: '{"filePath":"a.ts"}' }).tool_input, { filePath: 'a.ts' });
  assert.equal(normalizeHookInput(null), null);
  assert.equal(normalizeHookInput({ session_id: 's', tool_input: 'not json' }).tool_input, 'not json');
});

test('which agent a hook runs for, and how its events say so', () => {
  assert.equal(hookClient(['node', 'x.mjs', '--global', '--client', 'codex']), 'codex');
  assert.equal(hookClient(['node', 'x.mjs', '--global']), null);
  assert.equal(hookClient(['node', 'x.mjs', '--client', 'Not A Name']), null);
  assert.equal(clientTool(null, 'Edit'), 'Edit', "Claude Code's events are as they always were");
  assert.equal(clientTool(null, null), null);
  assert.equal(clientTool('codex', 'apply_patch'), 'codex:apply_patch');
  assert.equal(clientTool('codex', null), 'codex');
});

test('Codex, signed in: an apply_patch is advised before it runs and reported after, as codex', async () => {
  const server = await startServer();
  const m = machine(server.port);
  const s = session();
  try {
    const pre = await runHook('pre_tool_use.mjs', codex.pre(m.project, s), m.env, ['--global', '--client', 'codex']);
    assert.equal(pre.code, 0, pre.stderr);
    const out = JSON.parse(pre.stdout);
    // Codex reads exactly this: hookSpecificOutput.additionalContext, since 0.129
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts/);
    assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName'], 'nothing Codex would refuse');
    const check = server.requests.find((r) => r.path === '/check');
    assert.equal(check.query.file_path, 'src/models/user.ts');
    assert.equal(check.user, USER_TOKEN, 'as this machine, by its sign-in');

    const post = await runHook('post_tool_use.mjs', codex.post(m.project, s), m.env, ['--global', '--client', 'codex', '--detach']);
    assert.deepEqual([post.code, post.stdout, post.stderr], [0, '', '']);
    // Both reports run in the background, each in a copy of its hook. Codex's
    // next prompt comes a turn after the edit; started at once here, on a busy
    // machine the prompt's copy could keep its prompt before the edit's copy
    // read it, and the edit would carry it. So the edit lands first, as it does
    // in a real session.
    assert.deepEqual((await eventsOf(server, 1)).map((r) => r.body.event_type), ['edit'], 'the edit was reported');
    const prompt = await runHook('user_prompt_submit.mjs', codex.prompt(m.project, s), m.env, ['--global', '--client', 'codex', '--detach']);
    assert.deepEqual([prompt.code, prompt.stdout], [0, '']);
    const events = (await eventsOf(server, 2)).map((r) => r.body);
    const edit = events.find((e) => e.event_type === 'edit');
    assert.equal(edit.tool, 'codex:apply_patch', 'the room can tell it was Codex');
    assert.equal(edit.file_path, 'src/models/user.ts');
    assert.equal(edit.change_summary, '+1/-1 lines, in a patch');
    assert.equal(edit.developer, 'bob');
    assert.equal(edit.git_branch, 'feat/login');
    const asked = events.find((e) => e.event_type === 'prompt');
    assert.equal(asked.tool, 'codex');
    assert.equal(asked.task_hint, 'give the user a role');
    assert.equal(edit.prompt_id ?? null, null, 'the edit came before the prompt was kept');

    const end = await runHook('session_end.mjs', codex.end(m.project, s), m.env, ['--global', '--client', 'codex', '--detach']);
    assert.equal(end.code, 0);
    const ended = (await eventsOf(server, 3)).map((r) => r.body).find((e) => e.event_type === 'session_end');
    assert.equal(ended?.tool, 'codex');
  } finally {
    await server.close();
  }
});

test("in a checkout that carries a room of its own, another agent's login hooks report there; Claude Code's still step aside", async () => {
  const server = await startServer();
  const m = machine(server.port, { committed: true });
  try {
    // Claude Code: the repository's own hooks report, and the login's say nothing
    await runHook('post_tool_use.mjs', { ...codex.post(m.project, session()), tool_name: 'Edit', tool_input: { file_path: path.join(m.project, 'src/models/user.ts'), old_string: 'a', new_string: 'b' } }, m.env, ['--global']);
    assert.equal(server.requests.length, 0, 'the committed install owns Claude Code');

    // Codex: no hooks of its own in the repository, so the login's report, to its room
    const pre = await runHook('pre_tool_use.mjs', codex.pre(m.project, session()), m.env, ['--global', '--client', 'codex']);
    assert.match(JSON.parse(pre.stdout).hookSpecificOutput.additionalContext, /alice's agent/);
    await runHook('post_tool_use.mjs', codex.post(m.project, session()), m.env, ['--global', '--client', 'codex']);
    const [edit] = await eventsOf(server, 1);
    assert.equal(edit.room, KEY, 'with the room key the checkout carries');
    assert.equal(edit.body.tool, 'codex:apply_patch');
    // AGENTMASH_DEV is set on this machine: every request says the name is one set on purpose
    assert.deepEqual([...new Set(server.requests.map((r) => r.source))], ['env']);
    assert.equal(edit.body.developer, 'bob');
  } finally {
    await server.close();
  }
});

test('a report handed to the background lets the agent go on at once, and still arrives', async () => {
  const server = await startServer({ eventsDelayMs: 1200 });
  const m = machine(server.port);
  try {
    const post = await runHook('post_tool_use.mjs', codex.post(m.project, session()), m.env, ['--global', '--client', 'codex', '--detach']);
    assert.equal(post.code, 0);
    assert.ok(post.elapsed < within(1000), `the hook waited ${post.elapsed}ms on a report it had handed off`);
    const events = await eventsOf(server, 1, 5000);
    assert.equal(events.length, 1, 'the report arrived anyway');
  } finally {
    await server.close();
  }
});

test('Copilot, in VS Code and in its CLI: its edit tools are advised and reported, and reading is left alone', async () => {
  const server = await startServer();
  const m = machine(server.port);
  const file = path.join(m.project, 'src', 'models', 'user.ts');
  const s = session();
  // VS Code's shape: PascalCase event names, snake_case fields, its own tool names
  const vscode = (event, tool_name, tool_input) => ({
    timestamp: new Date().toISOString(),
    cwd: m.project,
    session_id: s,
    hook_event_name: event,
    tool_name,
    tool_input,
    tool_use_id: 'u1',
  });
  try {
    const read = await runHook('pre_tool_use.mjs', vscode('PreToolUse', 'read_file', { filePath: file, startLine: 1, endLine: 5 }), m.env, ['--global', '--client', 'copilot']);
    assert.deepEqual([read.code, read.stdout], [0, '']);
    assert.equal(server.requests.length, 0, 'a read asks nothing');

    const pre = await runHook('pre_tool_use.mjs', vscode('PreToolUse', 'replace_string_in_file', { filePath: file, oldString: 'id: string', newString: 'id: string; role: string' }), m.env, ['--global', '--client', 'copilot']);
    assert.match(JSON.parse(pre.stdout).hookSpecificOutput.additionalContext, /alice's agent modified src\/models\/user\.ts/);

    await runHook('post_tool_use.mjs', vscode('PostToolUse', 'replace_string_in_file', { filePath: file, oldString: 'id: string', newString: 'id: string;\n  role: string' }), m.env, ['--global', '--client', 'copilot']);
    // the CLI's shape for the same: `edit` with its arguments as a JSON string
    await runHook('post_tool_use.mjs', { ...vscode('PostToolUse', 'edit', JSON.stringify({ path: file, old_str: 'a', new_str: 'b' })), session_id: session() }, m.env, ['--global', '--client', 'copilot']);
    const edits = (await eventsOf(server, 2)).map((r) => r.body).filter((e) => e.event_type === 'edit');
    assert.deepEqual(
      edits.map((e) => [e.tool, e.file_path, e.change_summary]),
      [
        ['copilot:replace_string_in_file', 'src/models/user.ts', '+2/-1 lines'],
        ['copilot:edit', 'src/models/user.ts', '+1/-1 lines'],
      ]
    );
  } finally {
    await server.close();
  }
});

test("the Copilot CLI's edits as 1.0.91 really sends them: Claude Code's tool names with its own arguments, or a bare patch", async () => {
  const server = await startServer();
  const m = machine(server.port);
  const file = path.join(m.project, 'src', 'models', 'user.ts');
  // captured from a live run: PascalCase events, snake_case fields, an Edit
  // that names its file `path`, and an Edit whose input is an apply_patch patch
  const cli = (event, tool_name, tool_input) => ({
    hook_event_name: event,
    session_id: session(),
    timestamp: new Date().toISOString(),
    cwd: m.project,
    tool_name,
    tool_input,
  });
  const strEdit = { path: file, old_str: 'id: string', new_str: 'id: string;\n  role: string' };
  const patch = `*** Begin Patch\n*** Update File: ${file}\n@@\n-  id: string\n+  id: string;\n+  role: string\n*** End Patch\n`;
  try {
    const read = await runHook('pre_tool_use.mjs', cli('PreToolUse', 'Read', { path: file, view_range: [1, 80] }), m.env, ['--global', '--client', 'copilot']);
    assert.deepEqual([read.code, read.stdout], [0, '']);
    assert.equal(server.requests.length, 0, 'a read asks nothing');

    for (const input of [strEdit, patch]) {
      const pre = await runHook('pre_tool_use.mjs', cli('PreToolUse', 'Edit', input), m.env, ['--global', '--client', 'copilot']);
      assert.match(JSON.parse(pre.stdout).hookSpecificOutput.additionalContext, /alice's agent modified src\/models\/user\.ts/);
    }
    await runHook('post_tool_use.mjs', cli('PostToolUse', 'Edit', strEdit), m.env, ['--global', '--client', 'copilot']);
    await runHook('post_tool_use.mjs', cli('PostToolUse', 'Edit', patch), m.env, ['--global', '--client', 'copilot']);
    await runHook('post_tool_use.mjs', cli('PostToolUse', 'Create', { path: path.join(m.project, 'src', 'new.ts'), file_text: 'export const x = 1;\n' }), m.env, ['--global', '--client', 'copilot']);
    const edits = (await eventsOf(server, 3)).map((r) => r.body).filter((e) => e.event_type === 'edit');
    assert.deepEqual(
      edits.map((e) => [e.tool, e.file_path, e.change_summary]).sort(),
      [
        ['copilot:Edit', 'src/models/user.ts', '+2/-1 lines'],
        ['copilot:Write', 'src/new.ts', 'wrote 2 lines, defining x'],
        ['copilot:apply_patch', 'src/models/user.ts', '+2/-1 lines, in a patch'],
      ]
    );
  } finally {
    await server.close();
  }
});

test('a patch that moves a file out of the repository says so, and names no folder outside it', async () => {
  const server = await startServer({ holders: [] });
  const m = machine(server.port);
  const away = '/Users/someone/private/notes/user.ts';
  const patch = ['*** Begin Patch', '*** Update File: src/models/user.ts', `*** Move to: ${away}`, '*** End Patch'].join('\n');
  try {
    const call = { ...codex.post(m.project, session()), tool_input: { command: patch } };
    await runHook('post_tool_use.mjs', call, m.env, ['--global', '--client', 'codex']);
    const events = (await eventsOf(server, 1)).map((r) => r.body);
    assert.deepEqual(events.map((e) => [e.file_path, e.change_summary]), [['src/models/user.ts', 'moved out of the repository, in a patch']]);
    assert.ok(!JSON.stringify(events).includes('/Users/someone'), 'no path from outside the repository reaches the room');
  } finally {
    await server.close();
  }
});
