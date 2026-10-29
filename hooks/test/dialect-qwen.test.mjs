// Qwen Code through the generic hook (agent_hook.mjs with --client qwen
// --dialect qwen, as cli/agents/qwen.mjs registers it), fed the payloads
// Qwen Code sends, recorded in fixtures/qwen/ from its source with where each
// came from. Qwen Code shows the model nothing a hook adds before an edit,
// only a refusal's reason: these tests pin that the advice goes that way once
// per session and file, in hookSpecificOutput, that reads and commands ask
// nothing, that edits and prompts reach the room as qwen's, that a send to
// the model that is no prompt of the person's is let go at once, and that
// every way of failing is exit 0 and {}, in time. Nothing ever says allow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOOKS_DIR, eventsOf, machine, runHook, session, startServer, within } from './fixtures.mjs';
import * as tools from './fixtures/qwen/tool-events.mjs';
import * as prompts from './fixtures/qwen/prompt-events.mjs';
import * as sessions from './fixtures/qwen/session-events.mjs';

/** The arguments login registers each of Qwen Code's hooks with. */
const qwen = (event) => [event, '--global', '--client', 'qwen', '--dialect', 'qwen'];
const hook = (event, payload, env) => runHook('agent_hook.mjs', payload, env, qwen(event));
const dialect = async () => (await import(pathToFileURL(path.join(HOOKS_DIR, 'dialects', 'qwen.mjs')).href)).default;

const ADVICE = /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts/;

/** {} and nothing else, exit 0: Qwen Code goes on as it would have without the hook. */
const nothing = (out, what) => assert.deepEqual([out.code, out.stdout, out.stderr], [0, '{}\n', ''], what);

/** What an answer must never be: an approval, an ask, a stop, or a top-level decision another hook's allow would outrank. */
function neverGrants(out, what) {
  const said = JSON.parse(out.stdout);
  assert.equal(said.decision, undefined, `${what}: no top-level decision`);
  assert.equal(said.continue, undefined, `${what}: never stops the turn`);
  assert.ok(!['allow', 'ask'].includes(said.hookSpecificOutput?.permissionDecision), `${what}: never allow or ask`);
}

/** The refusal Qwen Code reads: hookSpecificOutput's deny, its reason the advice. */
function refused(out, what) {
  assert.equal(out.code, 0, `${what}: ${out.stderr}`);
  assert.equal(out.stderr, '', what);
  const said = JSON.parse(out.stdout);
  assert.deepEqual(Object.keys(said), ['hookSpecificOutput'], what);
  assert.equal(said.hookSpecificOutput.hookEventName, 'PreToolUse', what);
  assert.equal(said.hookSpecificOutput.permissionDecision, 'deny', what);
  return said.hookSpecificOutput.permissionDecisionReason;
}

test("before Qwen Code's edit and write_file the file is asked about, and the advice refuses the first try, as hookSpecificOutput's deny", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    for (const [name, payload] of [
      ['edit', tools.editBefore(m.project, session())],
      ['write_file', tools.writeBefore(m.project, session())],
      ['write_file, relative', tools.writeBefore(m.project, session(), 'src/models/user.ts')],
    ]) {
      const out = await hook('pre_edit', payload, m.env);
      const reason = refused(out, name);
      assert.match(reason, ADVICE, name);
      assert.match(reason, /make the same edit again and it goes through\.$/, name);
      neverGrants(out, name);
    }
    const checks = server.requests.filter((r) => r.path === '/check');
    assert.equal(checks.length, 3);
    assert.ok(checks.every((c) => c.query.file_path === 'src/models/user.ts' && c.user === 'amu_agentstokenagentstokenagent'), JSON.stringify(checks));

    // a notebook is asked about by its notebook_path, and nobody is in it
    const notebook = await hook('pre_edit', tools.notebookBefore(m.project, session()), m.env);
    nothing(notebook, 'notebook_edit, nobody in it');
    assert.equal(server.requests.filter((r) => r.path === '/check').at(-1).query.file_path, 'notebooks/explore.ipynb');
  } finally {
    await server.close();
  }
});

test('the same edit again in the session goes through, a session of its own is told again, and the refusal names no file on disk', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const s = session();
    refused(await hook('pre_edit', tools.editBefore(m.project, s), m.env), 'the first try');
    nothing(await hook('pre_edit', tools.editBefore(m.project, s), m.env), 'the retry');
    // the same file by the other tool is the same file
    nothing(await hook('pre_edit', tools.writeBefore(m.project, s), m.env), 'write_file, same file');
    refused(await hook('pre_edit', tools.editBefore(m.project, session()), m.env), 'another session');

    const kept = fs.readFileSync(path.join(m.home, '.agentmash', 'deny-once.json'), 'utf8');
    assert.ok(!kept.includes(s) && !kept.includes('user.ts'), kept);
  } finally {
    await server.close();
  }
});

test('reads, shell commands, MCP tools and files outside the repository ask nothing and say {}', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    nothing(await hook('pre_edit', tools.readBefore(m.project, session()), m.env), 'read_file');
    nothing(await hook('pre_edit', tools.shellBefore(m.project, session()), m.env), 'run_shell_command');
    const file = path.join(m.project, 'src', 'models', 'user.ts');
    for (const tool_name of ['read_many_files', 'grep_search', 'zoom_image', 'lsp', 'mcp__filesystem__write_file', 'Edit', 'exec']) {
      nothing(await hook('pre_edit', tools.preToolUse(m.project, session(), tool_name, { file_path: file, content: 'x' }), m.env), tool_name);
    }
    nothing(await hook('pre_edit', tools.writeBefore(m.project, session(), '/tmp/elsewhere/notes.md'), m.env), 'outside the repository');
    assert.equal(server.requests.filter((r) => r.path === '/check').length, 0, JSON.stringify(server.requests));
  } finally {
    await server.close();
  }
});

test("after an edit the report reaches the room as qwen's, read from the call, at once", async () => {
  const server = await startServer();
  const m = machine(server.port);
  const s = session();
  // the files as the tools left them
  fs.writeFileSync(path.join(m.project, 'src', 'models', 'user.ts'), tools.USER_AFTER);
  fs.writeFileSync(path.join(m.project, 'src', 'answer.ts'), 'export const answer = 42;\nexport const question = "?";\n');
  fs.writeFileSync(path.join(m.project, 'src', 'new.ts'), 'export const answer = 42;\nexport const question = "?";\n');
  fs.mkdirSync(path.join(m.project, 'notebooks'));
  fs.writeFileSync(path.join(m.project, 'notebooks', 'explore.ipynb'), '{"cells":[]}\n');
  try {
    const done = [tools.editAfter, tools.editNewFile, tools.writeAfter, tools.notebookAfter];
    for (const payload of done) {
      const out = await hook('post_edit', payload(m.project, s), m.env);
      nothing(out, payload.name);
      assert.ok(out.elapsed < within(1000), `${payload.name}: the hook waited ${out.elapsed}ms on a report it hands off`);
    }
    const edits = (await eventsOf(server, done.length, 6000)).map((r) => r.body);
    assert.equal(edits.length, done.length);
    assert.ok(edits.every((e) => e.event_type === 'edit' && e.developer === 'bob' && e.git_branch === 'feat/login' && e.session_id === s));
    assert.deepEqual(
      edits.map((e) => [e.tool, e.file_path, e.change_summary]).sort(),
      [
        ['qwen:Edit', 'src/models/user.ts', '+4/-1 lines'],
        ['qwen:NotebookEdit', 'notebooks/explore.ipynb', 'notebook cell replace, 2 lines'],
        // an edit with an empty old_string made the file: reported as the write it was
        ['qwen:Write', 'src/answer.ts', 'wrote 3 lines, defining answer, question'],
        ['qwen:Write', 'src/new.ts', 'wrote 3 lines, defining answer, question'],
      ]
    );

    // the shell is handed to the look at the working tree, and is not an edit of any file it names
    nothing(await hook('post_edit', tools.shellAfter(m.project, s), m.env), 'run_shell_command');
    // a read reported by a matcher left off by hand reports nothing
    nothing(await hook('post_edit', tools.postToolUse(m.project, s, 'read_file', { file_path: path.join(m.project, 'src', 'new.ts') }, { llmContent: 'x', returnDisplay: '' }), m.env), 'read_file');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(server.requests.filter((r) => r.path === '/events' && r.body.event_type === 'edit').length, done.length, 'no edit from the shell or the read');
  } finally {
    await server.close();
  }
});

test("a prompt the person typed is reported as qwen's; a send that takes a tool's result back is let go at once, asking nothing", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const s = session();
    const back = await hook('prompt', prompts.continuation(m.project, s), m.env);
    nothing(back, 'a tool result going back');
    assert.ok(back.elapsed < within(1000), `${back.elapsed}ms`);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(server.requests, [], 'not reported, and no heads-up asked for');

    const typed = await hook('prompt', prompts.typed(m.project, s), m.env);
    nothing(typed, 'nobody at work: nothing added to the turn');
    const [asked] = (await eventsOf(server, 1, 6000)).map((r) => r.body);
    // what the person typed, never the file contents Qwen Code read into the prompt
    assert.deepEqual([asked.event_type, asked.tool, asked.task_hint], ['prompt', 'qwen', 'add a role to the user model @src/models/user.ts']);
    assert.ok(server.requests.some((r) => r.path === '/team'), 'the heads-up asked who is at work');
  } finally {
    await server.close();
  }
});

test("a session's start asks who is at work and its end is reported as qwen's, with its reason", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const s = session();
    nothing(await hook('session_start', sessions.sessionStart(m.project, s), m.env), 'nobody at work');
    assert.ok(server.requests.some((r) => r.path === '/team'));
    const end = await hook('session_end', sessions.sessionEnd(m.project, s), m.env);
    nothing(end, 'session_end');
    assert.ok(end.elapsed < within(1000), `${end.elapsed}ms`);
    const [ended] = (await eventsOf(server, 1, 6000)).map((r) => r.body);
    assert.deepEqual([ended.event_type, ended.tool, ended.session_id, ended.end_reason], ['session_end', 'qwen', s, 'prompt_input_exit']);
  } finally {
    await server.close();
  }
});

test('what the dialect says for each event, from the result the scripts give it', async () => {
  const qwenDialect = await dialect();
  const note = '[AgentMash] alice is at work on feat/other, in src/models/user.ts';
  const claudeSaid = (event, extra = {}) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: note }, ...extra });
  assert.deepEqual(qwenDialect.answer('prompt', { action: 'advise', text: note, stdout: claudeSaid('UserPromptSubmit') }), {
    stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } })}\n`,
  });
  assert.deepEqual(qwenDialect.answer('session_start', { action: 'advise', text: note, stdout: claudeSaid('SessionStart', { systemMessage: 'for you' }) }), {
    stdout: `${JSON.stringify({ systemMessage: 'for you', hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } })}\n`,
  });
  for (const stdout of ['', 'not json', '{}', '[]', null]) assert.deepEqual(qwenDialect.answer('prompt', { stdout }), { stdout: '{}\n' }, String(stdout));
  for (const event of ['post_edit', 'session_end', 'stop']) {
    // a Stop hook's block sends Qwen Code's agent back to work: {} always
    assert.deepEqual(qwenDialect.answer(event, { action: 'advise', text: note, stdout: claudeSaid('Stop') }), { stdout: '{}\n' }, event);
  }
  for (const event of ['pre_edit', 'post_edit', 'prompt', 'session_start', 'session_end', 'stop', 'nonsense']) assert.deepEqual(qwenDialect.neutral(event), { stdout: '{}\n' }, event);
  assert.deepEqual(qwenDialect.answer('pre_edit', { action: 'allow', files: [] }), { stdout: '{}\n' });
  assert.deepEqual(qwenDialect.answer('pre_edit', null), { stdout: '{}\n' });
});

test("each of Qwen Code's payloads is read as the call it is, and nothing else as an edit", async () => {
  const qwenDialect = await dialect();
  const lib = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);
  lib.registerClientTools('qwen', qwenDialect.tools);
  const parse = (event, payload) => qwenDialect.parse(event, payload, { client: 'qwen', lib });
  const cwd = '/repo';
  const s = 'sess-1';
  const file = '/repo/src/models/user.ts';

  assert.deepEqual(parse('pre_edit', tools.editBefore(cwd, s, file)).call, {
    tool_name: 'Edit',
    tool_input: { file_path: file, old_string: 'export interface User { id: string }', new_string: tools.USER_AFTER.trimEnd() },
  });
  assert.deepEqual(parse('pre_edit', tools.writeBefore(cwd, s, file)).call, { tool_name: 'Write', tool_input: { file_path: file, content: tools.USER_AFTER } });
  assert.equal(parse('pre_edit', tools.notebookBefore(cwd, s)).call.tool_name, 'NotebookEdit');
  assert.deepEqual(parse('pre_edit', tools.notebookBefore(cwd, s)).files, [path.join(cwd, 'notebooks', 'explore.ipynb')], 'the path the fixture names');
  // after: a new file by edit is a write, an edit of one that was there an edit
  assert.deepEqual(parse('post_edit', tools.editNewFile(cwd, s, '/repo/src/answer.ts', 'x\n')).call, { tool_name: 'Write', tool_input: { file_path: '/repo/src/answer.ts', content: 'x\n' } });
  assert.equal(parse('post_edit', tools.editAfter(cwd, s, file)).call.tool_name, 'Edit');
  // edit's old name, which Qwen Code still takes
  assert.equal(parse('pre_edit', tools.preToolUse(cwd, s, 'replace', { file_path: file, old_string: 'a', new_string: 'b' })).call.tool_name, 'Edit');
  // the shell names a command, no file
  const shell = parse('post_edit', tools.shellAfter(cwd, s, 'sed -i s/a/b/ src/x.ts'));
  assert.deepEqual([shell.files, shell.command, shell.call], [[], 'sed -i s/a/b/ src/x.ts', undefined]);
  // nothing for a read, an MCP tool or any other, whatever its input names
  for (const tool_name of ['read_file', 'grep_search', 'mcp__fs__edit', 'Edit', 'Write', 'exec', undefined]) {
    assert.deepEqual(parse('pre_edit', tools.preToolUse(cwd, s, tool_name, { file_path: file, content: 'x' })).files, [], String(tool_name));
  }
  // a prompt: what the person typed; none at all for a send that carries no submitted_prompt
  assert.equal(parse('prompt', prompts.typed(cwd, s, 'hi')).prompt, 'hi @src/models/user.ts');
  assert.equal(parse('prompt', prompts.continuation(cwd, s)), null);
  assert.equal(parse('prompt', { ...prompts.typed(cwd, s), submitted_prompt: '   ' }), null);
  assert.equal(parse('prompt', { ...prompts.typed(cwd, s), submitted_prompt: 7 }), null);
  // the session as Qwen Code names it
  assert.deepEqual([parse('session_start', sessions.sessionStart(cwd, s, 'resume')).source, parse('session_end', sessions.sessionEnd(cwd, s, 'clear')).end_reason], ['resume', 'clear']);
  for (const bad of [null, [], 'x', 42]) assert.equal(qwenDialect.parse('pre_edit', bad), null);
});

test("the room's strict mode refuses on every try, with its own reason, and a refusal that cannot be written down is never made", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const s = session();
    for (let i = 0; i < 2; i++) {
      const out = await hook('pre_edit', tools.editBefore(m.project, s), { ...m.env, AGENTMASH_STRICT: '1' });
      assert.match(refused(out, `try ${i + 1}`), /AgentMash strict mode blocked this edit/);
    }

    // a home where the refusal cannot be kept (a sandbox): every try would be refused, so none is
    const sandboxed = machine(server.port);
    fs.mkdirSync(path.join(sandboxed.home, '.agentmash', 'deny-once.json'), { recursive: true });
    for (let i = 0; i < 2; i++) nothing(await hook('pre_edit', tools.editBefore(sandboxed.project, s), sandboxed.env), `try ${i + 1}`);
  } finally {
    await server.close();
  }
});

test('anything wrong is exit 0 and {}: garbage, the room down or hung, switched off, no such event', async () => {
  const down = await startServer();
  const m = machine(down.port);
  await down.close();
  const edit = tools.editBefore(m.project, session());
  const fast = await hook('pre_edit', edit, m.env);
  nothing(fast, 'the room is down');
  assert.ok(fast.elapsed < within(1500), `${fast.elapsed}ms`);
  for (const garbage of ['not json', '[1,2]', '', '{"tool_name":', 'null', '"text"']) nothing(await hook('pre_edit', garbage, m.env), JSON.stringify(garbage));
  for (const event of ['post_edit', 'prompt', 'session_start', 'session_end']) nothing(await hook(event, 'not json', m.env), `${event}, garbage`);
  nothing(await hook('pre_edit', { ...edit, tool_input: 'not an object' }, m.env), 'tool_input a string');
  nothing(await hook('pre_edit', { ...edit, tool_input: { file_path: 42 } }, m.env), 'a path that is no string');
  nothing(await hook('pre_edit', edit, { ...m.env, AGENTMASH_DISABLE: '1' }), 'switched off');
  nothing(await runHook('agent_hook.mjs', edit, m.env, ['PreToolUse', '--global', '--client', 'qwen', '--dialect', 'qwen']), 'no such event');

  const hung = await startServer({ hang: true });
  const h = machine(hung.port);
  try {
    const slow = await hook('pre_edit', tools.editBefore(h.project, session()), { ...h.env, AGENTMASH_TIMEOUT_MS: '500' });
    nothing(slow, 'the room never answers');
    assert.ok(slow.elapsed < within(500 + 250 + 400 + 600), `${slow.elapsed}ms`);
    assert.ok(hung.requests.some((r) => r.path === '/check'), 'it did ask');
  } finally {
    await hung.close();
  }
});
