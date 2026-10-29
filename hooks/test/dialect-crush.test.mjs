// Crush, as login connects it: one PreToolUse hook before Crush's file tools,
// the generic hook (agent_hook.mjs) with --global --client crush, answering in
// the dialect named like the client (dialects/crush.mjs). These tests run it on
// Crush's own payloads, as its source at v0.97.1 writes them
// (fixtures/crush/), and pin what Crush then does with each answer: the
// warning before an edit reaches the model as the reason of a refusal of the
// first try, and the same edit again goes on; reads, commands and MCP tools
// ask nothing; an edit is reported as Crush's once its file has changed, and
// one that never happens is not; and anything going wrong is nothing on
// stdout and exit 0, which Crush reads as no opinion. Nothing here is ever
// "allow" (which would skip the person's permission prompt), updated_input,
// halt, or an exit of 2 or 49.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as lib from '../lib.mjs';
import { clientToolKind, editedFiles, registerClientTools } from '../lib.mjs';
import { HOOKS_DIR, eventsOf, machine, runHook, session, startServer, within } from './fixtures.mjs';
import * as crush from './fixtures/crush/pre_tool_use.mjs';

/** As login registers it (cli/agents/crush.mjs), less `node` and the folder. */
const ARGS = ['--global', '--client', 'crush'];
const hook = (payload, env, args = ARGS) => runHook('agent_hook.mjs', payload, env, ['pre_edit', ...args]);
const userTs = (m) => path.join(m.project, 'src', 'models', 'user.ts');
const { default: dialect } = await import(pathToFileURL(path.join(HOOKS_DIR, 'dialects', 'crush.mjs')).href);

/** A machine whose watchers give up soon, so none outlives its test for long. */
const crushMachine = (port, watchMs = 1500) => {
  const m = machine(port);
  return { ...m, env: { ...m.env, AGENTMASH_CRUSH_WATCH_MS: String(watchMs) } };
};

/** What Crush must never be told by one of our hooks, and what it reads from what it is told. */
function crushReads(out, what) {
  assert.equal(out.code, 0, `${what}: exit ${out.code} (2 refuses, 49 ends the person's turn)`);
  assert.equal(out.stderr, '', `${what}: stderr is the reason of a refusal by exit code`);
  if (!out.stdout.trim()) return { decision: 'none' };
  const said = JSON.parse(out.stdout);
  assert.ok(said && typeof said === 'object' && !Array.isArray(said), what);
  for (const key of ['hookSpecificOutput', 'updated_input', 'updatedInput', 'halt']) assert.equal(key in said, false, `${what}: ${key}`);
  assert.ok(said.decision === undefined || said.decision === 'deny', `${what}: decision ${said.decision}`);
  return { decision: said.decision ?? 'none', ...said };
}

test('before an edit of a file a teammate is in: refused once with the warning as its reason, and the same edit again goes on', async () => {
  const server = await startServer();
  const m = crushMachine(server.port);
  try {
    const s = session();
    const payload = crush.edit(m.project, s, userTs(m), 'id: string', 'id: string;\n  role: string');
    const first = crushReads(await hook(payload, m.env), 'first try');
    assert.deepEqual(Object.keys(first), ['decision', 'reason']);
    assert.equal(first.decision, 'deny');
    // the model reads it as "Tool call blocked by hook. Reason: <reason>", and its turn goes on
    assert.match(first.reason, /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts/);
    assert.match(first.reason, /make the same edit again and it goes through\.$/);
    const checks = server.requests.filter((r) => r.path === '/check');
    assert.deepEqual(checks.map((c) => c.query.file_path), ['src/models/user.ts']);
    assert.equal(checks[0].user, 'amu_agentstokenagentstokenagent');

    const again = await hook(payload, m.env);
    assert.deepEqual([again.code, again.stdout, again.stderr], [0, '', ''], 'the same edit again: no opinion, and Crush asks the person as it would have');

    // each of Crush's file tools, in a session of its own, the model's own relative path among them
    for (const call of [
      crush.edit(m.project, session(), 'src/models/user.ts', 'id', 'key'),
      crush.multiedit(m.project, session(), userTs(m), [{ old_string: 'id', new_string: 'key' }, { old_string: 'User', new_string: 'Member', replace_all: true }]),
      crush.write(m.project, session(), userTs(m), 'export interface User { key: string }\n'),
      crush.lspReplaceSymbol(m.project, session(), userTs(m), 'User', 'export interface User { key: string }'),
      crush.download(m.project, session(), 'src/models/user.ts', 'https://example.com/user.ts'),
    ]) {
      assert.equal(crushReads(await hook(call, m.env), call.tool_name).decision, 'deny', call.tool_name);
    }

    // a file nobody is in: asked about, and nothing said
    const free = await hook(crush.write(m.project, session(), 'src/index.ts', 'export {};\n'), m.env);
    assert.deepEqual([free.code, free.stdout, free.stderr], [0, '', '']);
    assert.ok(server.requests.some((r) => r.path === '/check' && r.query.file_path === 'src/index.ts'));
  } finally {
    await server.close();
  }
});

test("in the room's strict mode the edit is refused on every try", async () => {
  const server = await startServer();
  const m = crushMachine(server.port);
  try {
    const env = { ...m.env, AGENTMASH_STRICT: '1' };
    const payload = crush.edit(m.project, session(), userTs(m), 'id: string', 'id: string; role: string');
    for (let i = 0; i < 2; i++) {
      const said = crushReads(await hook(payload, env), `try ${i + 1}`);
      assert.equal(said.decision, 'deny');
      assert.match(said.reason, /AgentMash strict mode blocked this edit/);
    }
  } finally {
    await server.close();
  }
});

test('reads, shell commands, MCP tools and a rename that names no file ask nothing, even with no matcher to keep them away', async () => {
  const server = await startServer();
  const m = crushMachine(server.port);
  try {
    for (const payload of [
      crush.view(m.project, session(), userTs(m)),
      crush.bash(m.project, session(), `sed -i '' s/id/key/ ${userTs(m)}`),
      crush.mcpTool(m.project, session()),
      crush.preToolUse(m.project, session(), 'lsp_rename', { symbol: 'User', new_name: 'Member' }),
      crush.preToolUse(m.project, session(), 'grep', { pattern: 'User', path: 'src' }),
    ]) {
      const out = await hook(payload, m.env);
      assert.deepEqual([out.code, out.stdout, out.stderr], [0, '', ''], payload.tool_name);
    }
    assert.equal(server.requests.length, 0, 'not a question asked of the room');

    // what the dialect declares, for the crush client and for no other
    assert.equal(registerClientTools('crush', dialect.tools), true);
    assert.equal(clientToolKind('crush', 'view'), 'read');
    assert.equal(clientToolKind('crush', 'bash'), 'command');
    assert.equal(clientToolKind('crush', 'multiedit'), 'edit');
    assert.equal(clientToolKind('crush', 'write'), 'write');
    assert.equal(clientToolKind('crush', 'lsp_rename'), null);
    assert.deepEqual(editedFiles('view', { file_path: 'src/a.ts' }, 'crush'), []);
    assert.deepEqual(editedFiles('edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, 'crush'), ['src/a.ts']);
    assert.deepEqual(editedFiles('download', { url: 'https://example.com/a', file_path: 'src/a.ts' }, 'crush'), ['src/a.ts']);
    assert.deepEqual(editedFiles('lsp_rename', { symbol: 'a', new_name: 'b' }, 'crush'), []);
  } finally {
    await server.close();
  }
});

test("an edit is reported as Crush's once its file changes, at once; one that never happens, and a refused try, are not", async () => {
  const server = await startServer({ eventsDelayMs: 300 });
  const m = crushMachine(server.port, 1500);
  try {
    const s = session();
    fs.writeFileSync(path.join(m.project, 'src', 'app.ts'), 'export const a = 1;\n');

    // a new file, written: nothing said, the hook gone long before the watcher, and the report when the file is there
    const wrote = await hook(crush.write(m.project, s, 'src/new.ts', 'export const b = 2;\n'), m.env);
    assert.deepEqual([wrote.code, wrote.stdout, wrote.stderr], [0, '', '']);
    assert.ok(wrote.elapsed < within(1200), `the hook waited ${wrote.elapsed}ms`);
    fs.writeFileSync(path.join(m.project, 'src', 'new.ts'), 'export const b = 2;\n');

    // an edit, then the edit Crush makes
    assert.equal((await hook(crush.edit(m.project, s, path.join(m.project, 'src', 'app.ts'), 'a = 1', 'a = 2'), m.env)).stdout, '');
    fs.writeFileSync(path.join(m.project, 'src', 'app.ts'), 'export const a = 2;\n');

    // the hot file: the first try is refused and changes nothing; whatever happens to the file then is not this call's
    const hot = crush.edit(m.project, s, userTs(m), 'id: string', 'id: string;\n  role: string');
    assert.equal(crushReads(await hook(hot, m.env), 'refused').decision, 'deny');
    // the same edit again goes on, and Crush makes it
    assert.equal((await hook(hot, m.env)).stdout, '');
    fs.writeFileSync(userTs(m), 'export interface User { id: string;\n  role: string }\n');

    // an edit that fails, or that the person turns down at Crush's prompt: the file never changes
    fs.writeFileSync(path.join(m.project, 'src', 'kept.ts'), 'export const k = 1;\n');
    assert.equal((await hook(crush.edit(m.project, s, 'src/kept.ts', 'nope', 'x'), m.env)).stdout, '');

    const edits = (await eventsOf(server, 3, 8000)).map((r) => r.body).filter((e) => e.event_type === 'edit');
    assert.deepEqual(
      edits.map((e) => [e.tool, e.file_path, e.change_summary]).sort(),
      [
        ['crush:Edit', 'src/app.ts', '+1/-1 lines'],
        ['crush:Edit', 'src/models/user.ts', '+2/-1 lines'],
        ['crush:Write', 'src/new.ts', 'wrote 2 lines, defining b'],
      ]
    );
    assert.ok(edits.every((e) => e.developer === 'bob' && e.git_branch === 'feat/login' && e.session_id === s));
    // every watcher has given up by now: the refused try and the edit that never happened sent nothing
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(server.requests.filter((r) => r.path === '/events').length, 3);
  } finally {
    await server.close();
  }
});

test("a call that changed nothing is never reported for a change that came after it: a newer call's, or the person's own", async () => {
  const server = await startServer();
  const m = crushMachine(server.port, 1500);
  try {
    const s = session();
    const app = path.join(m.project, 'src', 'app.ts');
    const kept = path.join(m.project, 'src', 'kept.ts');
    const both = path.join(m.project, 'src', 'both.ts');
    fs.writeFileSync(app, 'export const a = 1;\n');
    fs.writeFileSync(kept, 'export const k = 1;\n');
    fs.writeFileSync(both, 'export const b = 1;\n');

    // an edit that fails (its old text is not in the file), then the corrected one, which Crush makes
    assert.equal((await hook(crush.edit(m.project, s, app, 'NOT_IN_FILE', 'a = 9'), m.env)).stdout, '');
    assert.equal((await hook(crush.edit(m.project, s, app, 'a = 1', 'a = 2'), m.env)).stdout, '');
    fs.writeFileSync(app, 'export const a = 2;\n');

    // an edit the person turns down, then the same edit again, which they let through
    const again = crush.edit(m.project, s, both, 'b = 1', 'b = 2');
    assert.equal((await hook(again, m.env)).stdout, '');
    assert.equal((await hook(again, m.env)).stdout, '');
    fs.writeFileSync(both, 'export const b = 2;\n');

    // an edit the person turns down, and then changes the file in their own editor
    assert.equal((await hook(crush.edit(m.project, s, kept, 'k = 1', 'k = 5'), m.env)).stdout, '');
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(kept, 'export const k = 3;\n');

    const edits = (await eventsOf(server, 2, 6000)).map((r) => r.body).filter((e) => e.event_type === 'edit');
    assert.deepEqual(edits.map((e) => e.file_path).sort(), ['src/app.ts', 'src/both.ts']);
    // every watcher has given up by now, and none of them said anything more
    await new Promise((r) => setTimeout(r, 2500));
    const all = server.requests.filter((r) => r.path === '/events').map((r) => r.body);
    assert.deepEqual(all.map((e) => e.file_path).sort(), ['src/app.ts', 'src/both.ts'], 'one report for each edit made, and none for a call that changed nothing');
  } finally {
    await server.close();
  }
});

test('a file only touched is not an edit, and the tools whose edit the call does not spell out are reported by file', async () => {
  const server = await startServer();
  const m = crushMachine(server.port, 3000);
  try {
    const s = session();
    const app = path.join(m.project, 'src', 'app.ts');
    fs.writeFileSync(app, 'export function a() { return 1; }\n');
    assert.equal((await hook(crush.lspReplaceSymbol(m.project, s, app, 'a', 'export function a() { return 2; }'), m.env)).stdout, '');
    // the time changes, the text does not
    await new Promise((r) => setTimeout(r, 300));
    fs.utimesSync(app, new Date(), new Date(Date.now() + 5000));
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(server.requests.filter((r) => r.path === '/events').length, 0, 'a touch is not an edit');
    fs.writeFileSync(app, 'export function a() { return 2; }\n');

    const role = path.join(m.project, 'src', 'models', 'role.ts');
    fs.writeFileSync(role, 'export interface Role { id: string }\n');
    assert.equal((await hook(crush.multiedit(m.project, s, 'src/models/role.ts', [{ old_string: 'id', new_string: 'key' }, { old_string: 'Role', new_string: 'Grant' }]), m.env)).stdout, '');
    fs.writeFileSync(role, 'export interface Grant { key: string }\n');

    const edits = (await eventsOf(server, 2, 6000)).map((r) => r.body);
    const symbol = edits.find((e) => e.file_path === 'src/app.ts');
    assert.equal(symbol.tool, 'crush:Edit');
    assert.ok(!symbol.change_summary || !/\+0\/-0/.test(symbol.change_summary), 'no count of lines the call never said');
    const multi = edits.find((e) => e.file_path === 'src/models/role.ts');
    assert.deepEqual([multi.tool, multi.change_summary], ['crush:MultiEdit', '2 edits, +2/-2 lines']);
  } finally {
    await server.close();
  }
});

test("the dialect's answers, each as Crush reads it, and what it reads from Crush's payloads", async () => {
  const cwd = path.join(path.sep, 'r');
  const advice = { action: 'advise', text: '[AgentMash: RECENT EDIT] alice touched a.ts', files: [path.join(cwd, 'a.ts')], client: 'crush', session_id: 'unit' };
  const saved = process.env.AGENTMASH_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-crush-dialect-'));
  try {
    process.env.AGENTMASH_HOME = home;
    const first = JSON.parse(dialect.answer('pre_edit', advice).stdout);
    assert.deepEqual(Object.keys(first), ['decision', 'reason']);
    assert.equal(first.decision, 'deny');
    // refused already for this session and file: no opinion, and the advice with the edit's result
    assert.deepEqual(JSON.parse(dialect.answer('pre_edit', advice).stdout), { context: advice.text });
    // a refusal that cannot be written down is never said: the advice comes with the result instead
    const unwritable = path.join(home, 'a-file');
    fs.writeFileSync(unwritable, '');
    process.env.AGENTMASH_HOME = unwritable;
    assert.deepEqual(JSON.parse(dialect.answer('pre_edit', { ...advice, session_id: 'other' }).stdout), { context: advice.text });
  } finally {
    if (saved === undefined) delete process.env.AGENTMASH_HOME;
    else process.env.AGENTMASH_HOME = saved;
  }

  for (const result of [{ action: 'allow', files: [] }, { action: 'deny', files: [] }, null, {}]) {
    assert.equal(dialect.answer('pre_edit', result).stdout, '', JSON.stringify(result));
  }
  for (const event of ['post_edit', 'prompt', 'session_start', 'session_end', 'stop', 'nonesuch']) {
    assert.equal(dialect.answer(event, advice).stdout, '', event);
    assert.equal(dialect.neutral(event).stdout, '', event);
  }
  assert.equal(dialect.neutral('pre_edit').stdout, '', 'never an allow');

  // what is read from Crush's payloads
  registerClientTools('crush', dialect.tools);
  const context = { client: 'crush', lib };
  const edit = dialect.parse('pre_edit', crush.edit(cwd, 's', 'a.ts', 'x', 'y'), context);
  assert.deepEqual([edit.session_id, edit.cwd, edit.files, edit.call.tool_name], ['s', cwd, ['a.ts'], 'Edit']);
  assert.deepEqual(edit.call.tool_input, { file_path: 'a.ts', old_string: 'x', new_string: 'y' });
  const multi = dialect.parse('pre_edit', crush.multiedit(cwd, 's', 'a.ts', [{ old_string: 'x', new_string: 'y', replace_all: true }]), context);
  assert.deepEqual(multi.call, { tool_name: 'MultiEdit', tool_input: { edits: [{ old_string: 'x', new_string: 'y' }], file_path: 'a.ts' } });
  const write = dialect.parse('pre_edit', crush.write(cwd, 's', 'b.ts', 'z\n'), context);
  assert.deepEqual(write.call, { tool_name: 'Write', tool_input: { file_path: 'b.ts', content: 'z\n' } });
  for (const call of [crush.lspReplaceSymbol(cwd, 's', 'c.ts', 'c', 'x'), crush.download(cwd, 's', 'c.ts', 'https://example.com/c')]) {
    const read = dialect.parse('post_edit', call, context);
    assert.deepEqual([read.files, read.call], [[{ path: 'c.ts' }], undefined], call.tool_name);
  }
  const shell = dialect.parse('pre_edit', crush.bash(cwd, 's', 'npm test'), context);
  assert.deepEqual([shell.files, shell.command], [[], 'npm test']);
  assert.deepEqual(dialect.parse('pre_edit', crush.view(cwd, 's', 'a.ts'), context).files, []);
  // Crush accepts the event in any case and in snake_case; a payload naming another event is not Crush's PreToolUse
  assert.ok(dialect.parse('pre_edit', { ...crush.edit(cwd, 's', 'a.ts', 'x', 'y'), event: 'pre_tool_use' }, context));
  assert.equal(dialect.parse('pre_edit', { ...crush.edit(cwd, 's', 'a.ts', 'x', 'y'), event: 'PostToolUse' }, context), null);
  assert.equal(dialect.parse('pre_edit', 'not an object', context), null);
  assert.equal(dialect.parse('pre_edit', [1], context), null);
});

test("anything wrong is nothing and exit 0, in time: a room that is down, input that is not Crush's, AgentMash switched off", async () => {
  const down = await startServer();
  const m = crushMachine(down.port, 300);
  await down.close();
  const payload = crush.edit(m.project, session(), userTs(m), 'id: string', 'id: string; role: string');
  const refused = await hook(payload, m.env);
  assert.deepEqual([refused.code, refused.stdout, refused.stderr], [0, '', '']);
  assert.ok(refused.elapsed < within(1500), `${refused.elapsed}ms`);

  for (const event of ['pre_edit', 'post_edit']) {
    for (const garbage of ['not json at all', '', '[1,2]', '{"tool_name": 7, "tool_input": "x"}', 'null', '{"event":"PreToolUse","tool_name":"edit","tool_input":{"file_path":7}}']) {
      const out = await runHook('agent_hook.mjs', garbage, m.env, [event, ...ARGS]);
      assert.deepEqual([out.code, out.stdout, out.stderr], [0, '', ''], `${event} ${JSON.stringify(garbage)}`);
    }
  }
  const off = await hook(payload, { ...m.env, AGENTMASH_DISABLE: '1' });
  assert.deepEqual([off.code, off.stdout], [0, '']);
  // a client that is not one: the hook says nothing it could be wrong about
  const wrong = await hook(payload, m.env, ['--global', '--client', 'Not A Name', '--dialect', 'crush']);
  assert.deepEqual([wrong.code, wrong.stdout], [0, '']);

  // the watcher, run with something that is not its job, does nothing and ends
  const watcher = await runHook(path.join('dialects', 'crush.mjs'), 'not a job', m.env, ['--agentmash-watch']);
  assert.deepEqual([watcher.code, watcher.stdout, watcher.stderr], [0, '', '']);
  assert.ok(watcher.elapsed < within(1500), `${watcher.elapsed}ms`);
});
