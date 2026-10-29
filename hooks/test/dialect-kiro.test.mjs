// Kiro through the generic hook (agent_hook.mjs with --client kiro --dialect
// kiro, as cli/agents/kiro.mjs registers it), fed the payloads Kiro sends,
// recorded in fixtures/kiro/ with where each came from. Kiro shows the model
// nothing a hook prints before a tool: only a refusal, its reason on stderr
// and exit 2. These tests pin that the advice goes that way once per session
// and file and never again, that nothing is ever printed on stdout before a
// tool (nothing that could be read as letting it through), that reads and
// commands ask nothing, that edits reach the room as kiro's, and that every
// way of failing is exit 0 and silence, in time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOOKS_DIR, eventsOf, machine, runHook, session, startServer, within } from './fixtures.mjs';

/** The arguments login registers each of Kiro's hooks with. */
const kiro = (event) => [event, '--global', '--client', 'kiro', '--dialect', 'kiro'];
const hook = (event, payload, env) => runHook('agent_hook.mjs', payload, env, kiro(event));
/** A recorded payload, for this checkout and session. */
const payload = async (name, cwd, s = session()) =>
  (await import(pathToFileURL(path.join(HOOKS_DIR, 'test', 'fixtures', 'kiro', `${name}.mjs`)).href)).default(cwd, s);

const WRITES_BEFORE = ['ide-1.1.14-pre-fs_write', 'v3-pre-str_replace', 'v3-pre-fs_append', 'v3-pre-delete_file', 'v2-pre-fs_write-headless'];
const ADVICE = /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts/;

/**
 * A temporary folder of the test's own for the hooks' per-session scratch
 * (lib.mjs keeps it in the OS's temp folder): kiro-cli's V2 engine sends no
 * session id, and every session without one shares the scratch of "unknown".
 */
const ownTemp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-kiro-scratch-'));
  return { TMPDIR: dir, TMP: dir, TEMP: dir };
};

/** Nothing said at all, and the tool goes on: Kiro's "allow", which grants nothing the person's approval card would ask. */
const silent = (out, what) => assert.deepEqual([out.code, out.stdout, out.stderr], [0, '', ''], what);

test('before each of Kiro\'s writes the file is asked about, and the advice refuses the first try on stderr with exit 2', async () => {
  const server = await startServer();
  const m = machine(server.port);
  const env = { ...m.env, ...ownTemp() };
  try {
    for (const name of WRITES_BEFORE) {
      const out = await hook('pre_edit', await payload(name, m.project), env);
      assert.equal(out.code, 2, `${name}: ${out.stderr}`);
      assert.equal(out.stdout, '', `${name}: stdout before a tool never reaches the model, and is never written`);
      assert.match(out.stderr, ADVICE, name);
      assert.match(out.stderr, /make the same edit again and it goes through\.\n$/, name);
    }
    const checks = server.requests.filter((r) => r.path === '/check');
    assert.equal(checks.length, WRITES_BEFORE.length);
    assert.ok(checks.every((c) => c.query.file_path === 'src/models/user.ts' && c.user === 'amu_agentstokenagentstokenagent'), JSON.stringify(checks));
  } finally {
    await server.close();
  }
});

test('the same edit again in the session goes through, a session of its own is told again, and the refusal names no file on disk', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const s = session();
    const first = await hook('pre_edit', await payload('ide-1.1.14-pre-fs_write', m.project, s), m.env);
    assert.equal(first.code, 2, first.stderr);
    silent(await hook('pre_edit', await payload('ide-1.1.14-pre-fs_write', m.project, s), m.env), 'the retry');
    // the same file by another tool, and by its absolute path, is the same file
    silent(await hook('pre_edit', await payload('v3-pre-str_replace', m.project, s), m.env), 'another tool, same file');
    const other = await hook('pre_edit', await payload('ide-1.1.14-pre-fs_write', m.project, session()), m.env);
    assert.equal(other.code, 2, 'another session is told too');

    const kept = fs.readFileSync(path.join(m.home, '.agentmash', 'deny-once.json'), 'utf8');
    assert.ok(!kept.includes(s) && !kept.includes('user.ts'), kept);
  } finally {
    await server.close();
  }
});

test('reads, shell commands, MCP tools and Kiro\'s own memory ask nothing and say nothing', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    silent(await hook('pre_edit', await payload('docs-pre-read_file', m.project), m.env), 'read_file');
    silent(await hook('pre_edit', await payload('ide-1.0.242-pre-execute_pwsh', m.project), m.env), 'execute_pwsh');
    const base = await payload('docs-pre-read_file', m.project);
    for (const tool_name of ['fs_read', 'grep_search', 'execute_bash', '@agentmash/agentmash_status', 'memory', '@github/write_file']) {
      silent(await hook('pre_edit', { ...base, tool_name, tool_input: { path: 'src/models/user.ts', file_path: 'src/models/user.ts' } }, m.env), tool_name);
      silent(await hook('post_edit', { ...base, hook_event_name: 'PostToolUse', tool_name, tool_input: { path: 'src/models/user.ts' } }, m.env), tool_name);
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(server.requests, [], 'not one request');
  } finally {
    await server.close();
  }
});

test('after an edit the report reaches the room as kiro\'s, read from the input or, when Kiro sends none, from its prose', async () => {
  const server = await startServer();
  const m = machine(server.port);
  const s = session();
  try {
    const names = ['ide-1.0.165-post-fs_write', 'ide-1.0.242-post-str_replace', 'ide-1.0.242-post-fs_append', 'ide-1.1-post-str_replace-filled', 'ide-1.1-post-fs_write-filled'];
    for (const name of names) {
      const out = await hook('post_edit', await payload(name, m.project, s), m.env);
      silent(out, name);
      assert.ok(out.elapsed < within(1500), `${name}: the hook waited ${out.elapsed}ms on a report it hands off`);
    }
    const edits = (await eventsOf(server, names.length, 6000)).map((r) => r.body);
    assert.equal(edits.length, names.length);
    assert.ok(edits.every((e) => e.event_type === 'edit' && e.developer === 'bob' && e.git_branch === 'feat/login'));
    assert.deepEqual(
      edits.map((e) => [e.tool, e.file_path, e.change_summary ?? null]).sort(),
      [
        // prose names the file and nothing of the change: no size is made up for it
        ['kiro:Edit', 'src/models/user.ts', null],
        ['kiro:Edit', 'src/models/user.ts', null],
        ['kiro:Edit', 'src/models/user.ts', null],
        ['kiro:Edit', 'src/models/user.ts', '+2/-1 lines'],
        ['kiro:Write', 'src/new.ts', 'wrote 2 lines, defining answer'],
      ]
    );
    assert.ok(edits.every((e) => /^kiro:[A-Za-z]+$/.test(e.tool)));
  } finally {
    await server.close();
  }
});

test('a write that failed, or prose that names no file, reports nothing', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const filled = await payload('ide-1.1-post-fs_write-filled', m.project);
    silent(await hook('post_edit', { ...filled, tool_response: { success: false, result: ['permission denied'] } }, m.env), 'V2 says it failed');
    const empty = await payload('ide-1.0.165-post-fs_write', m.project);
    for (const tool_response of ['Error: could not write src/models/user.ts', 'Created the src/a.ts file.\nand more', '', null, 42]) {
      silent(await hook('post_edit', { ...empty, tool_response }, m.env), JSON.stringify(tool_response));
    }
    // and prose is read only in the wording of the tool that wrote it
    silent(await hook('post_edit', { ...empty, tool_name: 'str_replace' }, m.env), 'fs_write\'s wording for str_replace');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(server.requests.filter((r) => r.path === '/events').length, 0);
  } finally {
    await server.close();
  }
});

test('a prompt is reported as kiro\'s, and the heads-up, when there is one, goes into the turn as plain text', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const out = await hook('prompt', await payload('ide-1.0.293-prompt', m.project), m.env);
    silent(out, 'nobody at work: nothing added to the turn');
    const [asked] = (await eventsOf(server, 1, 6000)).map((r) => r.body);
    assert.deepEqual([asked.event_type, asked.tool, asked.task_hint], ['prompt', 'kiro', 'give the user a role']);
    assert.ok(server.requests.some((r) => r.path === '/team'), 'the heads-up asked who is at work');
  } finally {
    await server.close();
  }

  // what the dialect says for each event, from the result the scripts give it
  const { default: dialect } = await import(pathToFileURL(path.join(HOOKS_DIR, 'dialects', 'kiro.mjs')).href);
  const note = '[AgentMash] alice is at work on feat/other, in src/models/user.ts';
  assert.deepEqual(dialect.answer('prompt', { action: 'advise', text: note }), { stdout: `${note}\n` });
  assert.deepEqual(dialect.answer('session_start', { action: 'advise', text: note }), { stdout: `${note}\n` });
  for (const event of ['post_edit', 'session_end', 'stop']) {
    // a Stop hook's stdout can send Kiro's agent back to work: nothing, ever
    assert.deepEqual(dialect.answer(event, { action: 'advise', text: note }), { stdout: '' }, event);
  }
  for (const event of ['pre_edit', 'post_edit', 'prompt', 'session_start', 'session_end', 'stop']) assert.deepEqual(dialect.neutral(event), { stdout: '' }, event);
  assert.deepEqual(dialect.answer('pre_edit', { action: 'allow', files: [] }), { stdout: '' });
});

test("each of Kiro's write shapes is read as the edit it is, and nothing else as one", async () => {
  const { default: dialect } = await import(pathToFileURL(path.join(HOOKS_DIR, 'dialects', 'kiro.mjs')).href);
  const files = (tool_name, tool_input, event = 'pre_edit', extra = {}) => dialect.parse(event, { session_id: 's', cwd: '/r', tool_name, tool_input, ...extra }).files;
  assert.deepEqual(files('fs_write', { path: 'a.ts', text: 'x\n' }), [{ path: 'a.ts', after: 'x\n', action: 'write' }]);
  assert.deepEqual(files('str_replace', { path: 'a.ts', oldStr: 'x', newStr: 'y' }), [{ path: 'a.ts', before: 'x', after: 'y', action: 'edit' }]);
  assert.deepEqual(files('fs_append', { path: 'a.ts', text: 'z\n' }), [{ path: 'a.ts', before: '', after: 'z\n', action: 'edit' }]);
  assert.deepEqual(files('delete_file', { targetFile: 'a.ts' }), [{ path: 'a.ts', action: 'delete' }]);
  // kiro-cli's V2 engine: fs_write's commands, and its TUI's `write`
  assert.deepEqual(files('fs_write', { command: 'create', path: 'a.ts', file_text: 'x' }), [{ path: 'a.ts', after: 'x', action: 'write' }]);
  assert.deepEqual(files('fs_write', { command: 'str_replace', path: 'a.ts', old_str: 'x', new_str: 'y' }), [{ path: 'a.ts', before: 'x', after: 'y', action: 'edit' }]);
  assert.deepEqual(files('fs_write', { command: 'insert', path: 'a.ts', insert_line: 3, new_str: 'y' }), [{ path: 'a.ts', before: '', after: 'y', action: 'edit' }]);
  assert.deepEqual(files('write', { path: 'a.ts', oldStr: 'x', newStr: 'y' }), [{ path: 'a.ts', before: 'x', after: 'y', action: 'edit' }]);
  // a write whose input says only where: the file, and nothing made up about the change
  assert.deepEqual(files('fs_write', { path: 'a.ts' }), [{ path: 'a.ts' }]);
  // nothing for a read, a command, an MCP tool, no tool, or a write that names no file
  for (const [tool, input] of [['read_file', { path: 'a.ts' }], ['execute_bash', { command: 'rm a.ts' }], ['@fs/write_file', { path: 'a.ts' }], [undefined, { path: 'a.ts' }], ['fs_write', {}], ['fs_write', 'a.ts'], ['str_replace', { path: 7 }]]) {
    assert.deepEqual(files(tool, input), [], `${tool} ${JSON.stringify(input)}`);
  }
  // prose only after a write, and only the writing tool's own
  assert.deepEqual(files('fs_append', {}, 'pre_edit', { tool_response: 'Appended the text to the a.ts file.' }), []);
  assert.deepEqual(files('fs_append', {}, 'post_edit', { tool_response: 'Appended the text to the a.ts file.\n' }), [{ path: 'a.ts' }]);
  assert.deepEqual(files('str_replace', {}, 'post_edit', { tool_response: 'Replaced text in src/a b.ts (1 occurrence)' }), [{ path: 'src/a b.ts' }]);
  assert.deepEqual(files('fs_write', {}, 'post_edit', { tool_response: 'Replaced text in a.ts' }), []);
  // the prompt, and the session, as Kiro names them
  assert.deepEqual(dialect.parse('prompt', { session_id: 'sess_1', cwd: '/r', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }), { session_id: 'sess_1', cwd: '/r', tool: undefined, prompt: 'hi' });
  assert.equal(dialect.parse('prompt', { session_id: 'sess_1', cwd: '/r', prompt: 7 }).prompt, '');
  for (const bad of [null, [], 'x', 42]) assert.equal(dialect.parse('pre_edit', bad), null);
});

test("the room's strict mode refuses on every try, with its own reason, and a refusal that cannot be written down is never made", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const s = session();
    for (let i = 0; i < 2; i++) {
      const out = await hook('pre_edit', await payload('v3-pre-str_replace', m.project, s), { ...m.env, AGENTMASH_STRICT: '1' });
      assert.equal(out.code, 2, `try ${i + 1}`);
      assert.equal(out.stdout, '');
      assert.match(out.stderr, /AgentMash strict mode blocked this edit/);
    }

    // a home where the refusal cannot be kept (a sandbox): every try would be refused, so none is
    const sandboxed = machine(server.port);
    fs.mkdirSync(path.join(sandboxed.home, '.agentmash', 'deny-once.json'), { recursive: true });
    for (let i = 0; i < 2; i++) silent(await hook('pre_edit', await payload('ide-1.1.14-pre-fs_write', sandboxed.project, s), sandboxed.env), `try ${i + 1}`);
  } finally {
    await server.close();
  }
});

test('anything wrong is exit 0 and silence: garbage, the room down or hung, switched off, no such event', async () => {
  const down = await startServer();
  const m = machine(down.port);
  await down.close();
  const write = await payload('ide-1.1.14-pre-fs_write', m.project);
  const fast = await hook('pre_edit', write, m.env);
  silent(fast, 'the room is down');
  assert.ok(fast.elapsed < within(1500), `${fast.elapsed}ms`);
  for (const garbage of ['not json', '[1,2]', '', '{"tool_name":', 'null', '"text"']) silent(await hook('pre_edit', garbage, m.env), JSON.stringify(garbage));
  silent(await hook('pre_edit', { ...write, tool_input: 'not an object' }, m.env), 'tool_input a string');
  silent(await hook('pre_edit', { ...write, tool_input: { path: 42 } }, m.env), 'a path that is no string');
  silent(await hook('pre_edit', write, { ...m.env, AGENTMASH_DISABLE: '1' }), 'switched off');
  silent(await runHook('agent_hook.mjs', write, m.env, ['before_edit', '--global', '--client', 'kiro', '--dialect', 'kiro']), 'no such event');

  const hung = await startServer({ hang: true });
  const h = machine(hung.port);
  try {
    const slow = await hook('pre_edit', await payload('v3-pre-str_replace', h.project), { ...h.env, AGENTMASH_TIMEOUT_MS: '500' });
    silent(slow, 'the room never answers');
    assert.ok(slow.elapsed < within(500 + 250 + 400 + 600), `${slow.elapsed}ms`);
    assert.ok(hung.requests.some((r) => r.path === '/check'), 'it did ask');
  } finally {
    await hung.close();
  }
});
