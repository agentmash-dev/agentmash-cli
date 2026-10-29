// OpenCode, end to end: the plugin `npx agentmash login` writes for it
// (cli/agents/opencode.mjs), loaded as OpenCode loads one and called with
// what OpenCode 1.18.34 passes its hooks (fixtures/opencode/, recorded from
// its source), running the generic hook from this checkout in the opencode
// dialect (dialects/opencode.mjs) against a room on a port of its own. These
// pin that an edit is asked about before it runs and its first try refused
// with the advice, that reads and commands ask nothing, that the room hears
// edits, prompts and ends as OpenCode's, and that nothing that goes wrong
// ever refuses a call or rejects a hook OpenCode does not wait on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { opencodePlugin } from '../../cli/agents/opencode.mjs';
import { parseOpencode } from '../dialects/opencode.mjs';
import { HOOKS_DIR, eventsOf, machine, runHook, session, startServer, within } from './fixtures.mjs';
import { after, bashArgs, bashResult, before, editArgs, editResult, patchArgs, patchResult, readArgs, writeArgs, writeResult } from './fixtures/opencode/tool-execute.mjs';
import { chatMessage, chatMessageV1 } from './fixtures/opencode/chat-message.mjs';
import { childCreated, sessionCreated, sessionDeleted, sessionIdle } from './fixtures/opencode/events.mjs';

/** deny-once's answer when it lets a call go on: no opinion, which is never an approval of what the person would be asked about. */
const GO_ON = '{}\n';
const userTs = (m) => path.join(m.project, 'src', 'models', 'user.ts');

// The plugin runs its hooks in OpenCode's environment, which in these tests
// is this process's: nothing of a developer's own agentmash may leak in, and
// `node` is this one.
for (const key of Object.keys(process.env)) if (key.startsWith('AGENTMASH_') || key === 'CLAUDE_PROJECT_DIR') delete process.env[key];
process.env.PATH = [path.dirname(process.execPath), process.env.PATH].join(path.delimiter);

/**
 * The plugin login writes, for the hooks in `dir`, loaded and started as
 * OpenCode starts one in `m`'s checkout (plugin/index.ts: PluginInput).
 * Written as .mjs here: a Node older than 22.7 reads a .js with no
 * package.json beside it as CommonJS, where OpenCode runs it under Bun.
 */
async function plugin(m, { dir = HOOKS_DIR } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-opencode-plugin-'));
  const file = path.join(folder, 'agentmash.mjs');
  fs.writeFileSync(file, opencodePlugin(dir));
  Object.assign(process.env, m.env);
  const loaded = await import(pathToFileURL(file).href);
  assert.deepEqual(Object.keys(loaded), ['AgentMash'], 'one export, a function: an older OpenCode calls every export');
  return loaded.AgentMash({ directory: m.project, worktree: m.project, client: {}, project: { id: 'prj_4c1e2b' }, $: undefined });
}

/** Run the generic hook as the plugin runs it, with `payload` on stdin. */
const hook = (event, payload, m, extra = []) =>
  runHook('agent_hook.mjs', payload, m.env, [event, '--global', '--client', 'opencode', '--dialect', 'opencode', '--input', 'native', ...extra]);

/** The envelope the plugin hands the hook (dialects/opencode.mjs). */
const envelope = (m, hook, input, output) => ({ opencode: 1, hook, directory: m.project, input, ...(output ? { output } : {}) });

test('before an edit OpenCode asks the room, and the first try is refused with the advice as its reason; the same edit again goes through', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const hooks = await plugin(m);
    const [input, output] = before('edit', editArgs(userTs(m)), { sessionID: session() });
    const args = structuredClone(output.args);
    await assert.rejects(hooks['tool.execute.before'](input, output), (err) => {
      assert.match(err.message, /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts/);
      assert.match(err.message, /make the same edit again and it goes through\.$/);
      return true;
    });
    assert.deepEqual(output.args, args, 'what the model asked for is never changed');
    await hooks['tool.execute.before'](input, output);
    const checks = server.requests.filter((r) => r.path === '/check');
    assert.ok(checks.length >= 1, 'it asked');
    assert.ok(checks.every((c) => c.query.file_path === 'src/models/user.ts' && c.user === 'amu_agentstokenagentstokenagent'), JSON.stringify(checks));

    // write, apply_patch (the tool GPT models get), and a path relative to where OpenCode works: each a session of its own
    for (const [tool, toolArgs] of [
      ['write', writeArgs(userTs(m))],
      ['apply_patch', patchArgs('src/models/user.ts')],
      ['edit', editArgs('src/models/user.ts')],
    ]) {
      const [i, o] = before(tool, toolArgs, { sessionID: session() });
      await assert.rejects(hooks['tool.execute.before'](i, o), /alice's agent modified src\/models\/user\.ts/, tool);
    }

    // a file nobody is in goes through at once
    const [i, o] = before('write', writeArgs(path.join(m.project, 'src', 'new.ts')), { sessionID: session() });
    await hooks['tool.execute.before'](i, o);
  } finally {
    await server.close();
  }
});

test("the room's strict mode refuses every try, and nothing ever answers for the person", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const hooks = await plugin(m);
    process.env.AGENTMASH_STRICT = '1';
    const [input, output] = before('edit', editArgs(userTs(m)), { sessionID: session() });
    for (let i = 0; i < 2; i++) {
      await assert.rejects(hooks['tool.execute.before'](input, output), /acknowledge this specific collision/, `try ${i + 1}`);
    }
  } finally {
    delete process.env.AGENTMASH_STRICT;
    await server.close();
  }
});

test('reads, searches, commands and any other tool ask nothing before they run, whatever their arguments name', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const hooks = await plugin(m);
    for (const [tool, args] of [
      ['read', readArgs(userTs(m))],
      ['glob', { pattern: 'src/**/*.ts' }],
      ['grep', { pattern: 'User', path: m.project }],
      ['bash', bashArgs(m.project)],
      ['webfetch', { url: 'https://example.com', format: 'markdown' }],
      // an MCP server's tool, named as OpenCode names them (mcp/catalog.ts)
      ['github_create_or_update_file', { file_path: userTs(m), content: 'x' }],
    ]) {
      const [input, output] = before(tool, args, { sessionID: session() });
      await hooks['tool.execute.before'](input, output);
    }
    assert.equal(server.requests.length, 0, 'not one request');

    // and the hook itself, handed one, says go on and asks nobody
    for (const tool of ['read', 'github_create_or_update_file']) {
      const out = await hook('pre_edit', envelope(m, 'tool.execute.before', { tool, sessionID: session(), callID: 'c' }, { args: { filePath: userTs(m), file_path: userTs(m) } }), m);
      assert.deepEqual([out.code, out.stdout, out.stderr], [0, GO_ON, ''], tool);
    }
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("the room hears OpenCode's edits, prompts and sessions as OpenCode's, and a subagent's as its session's", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const hooks = await plugin(m);
    const top = session();
    await hooks.event(sessionCreated(m.project, top));
    await hooks['chat.message'](...chatMessage('give the user a role', { sessionID: top }));
    await hooks['tool.execute.after'](...after('edit', editArgs(userTs(m)), editResult(userTs(m), m.project), { sessionID: top }));
    await hooks['tool.execute.after'](...after('write', writeArgs(path.join(m.project, 'src', 'new.ts')), writeResult(path.join(m.project, 'src', 'new.ts'), m.project), { sessionID: top }));
    await hooks['tool.execute.after'](...after('apply_patch', patchArgs('src/models/user.ts'), patchResult(userTs(m), 'src/models/user.ts'), { sessionID: top }));
    // a read is reported by nobody, and an idle session is not an ended one
    await hooks['tool.execute.after'](...after('read', readArgs(userTs(m)), { title: 'user.ts', output: '...', metadata: {} }, { sessionID: top }));
    await hooks.event(sessionIdle(top));

    // the task tool's subagent: its prompt is its parent's, and its edit the parent session's
    const child = session();
    await hooks.event(childCreated(m.project, top, child));
    await hooks['chat.message'](...chatMessage('find where users are stored', { sessionID: child }));
    await hooks['tool.execute.after'](...after('edit', editArgs(path.join(m.project, 'src', 'a.ts')), editResult(path.join(m.project, 'src', 'a.ts'), m.project), { sessionID: child }));

    const events = (await eventsOf(server, 5, 8000)).map((r) => r.body);
    const edits = events.filter((e) => e.event_type === 'edit');
    assert.deepEqual(
      edits.map((e) => [e.tool, e.file_path, e.change_summary, e.session_id]).sort(),
      [
        ['opencode:Edit', 'src/a.ts', '+2/-1 lines', top],
        ['opencode:Edit', 'src/models/user.ts', '+2/-1 lines', top],
        ['opencode:Write', 'src/new.ts', 'wrote 2 lines, defining b', top],
        ['opencode:apply_patch', 'src/models/user.ts', '+1/-1 lines, in a patch', top],
      ].sort()
    );
    const prompts = events.filter((e) => e.event_type === 'prompt');
    assert.deepEqual(prompts.map((e) => [e.tool, e.task_hint, e.session_id]), [['opencode', 'give the user a role', top]], 'what was typed, and nothing OpenCode added');
    assert.ok(edits.every((e) => e.developer === 'bob' && e.git_branch === 'feat/login'));

    // a session deleted ends; OpenCode closing ends what is still open, the deleted one not twice
    const other = session();
    await hooks['chat.message'](...chatMessageV1('and an email', { sessionID: other }));
    await hooks.event(sessionDeleted(m.project, top));
    await hooks.event(sessionDeleted(m.project, child, { parentID: top }));
    await hooks.dispose();
    const all = (await eventsOf(server, 8, 8000)).map((r) => r.body);
    const ends = all.filter((e) => e.event_type === 'session_end');
    assert.deepEqual(ends.map((e) => [e.tool, e.session_id, e.end_reason]).sort(), [['opencode', other, 'exit'], ['opencode', top, 'other']].sort());
    assert.ok(all.some((e) => e.event_type === 'prompt' && e.session_id === other && e.task_hint === 'and an email'), 'OpenCode 1.0.0 named the session only in the message');
  } finally {
    await server.close();
  }
});

test('the dialect reads each recorded payload as the call it is, and anything else as nothing', () => {
  // an absolute path as this OS writes it: C:\work\app on Windows
  const dir = path.resolve('/work/app');
  const e = (hookName, input, output, extra = {}) => ({ opencode: 1, hook: hookName, directory: dir, input, ...(output ? { output } : {}), ...extra });
  const [bi, bo] = before('edit', editArgs('src/a.ts'));
  assert.deepEqual(parseOpencode('pre_edit', e('tool.execute.before', bi, bo)), {
    session_id: bi.sessionID,
    cwd: dir,
    tool: 'edit',
    files: ['src/a.ts'],
    call: { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts', old_string: 'id: string', new_string: 'id: string;\n  role: string' } },
  });
  const [wi, wo] = before('write', writeArgs('/work/app/b.ts'));
  assert.deepEqual(parseOpencode('pre_edit', e('tool.execute.before', wi, wo)).call, { tool_name: 'Write', tool_input: { file_path: '/work/app/b.ts', content: 'export const b = 2;\n' } });
  const [pi, po] = before('apply_patch', patchArgs('src/a.ts'));
  assert.match(parseOpencode('pre_edit', e('tool.execute.before', pi, po)).patch, /^\*\*\* Begin Patch\n\*\*\* Update File: src\/a\.ts/);
  const [ai] = after('bash', bashArgs('packages/api'), bashResult());
  assert.deepEqual(
    [parseOpencode('post_edit', e('tool.execute.after', ai)).command, parseOpencode('post_edit', e('tool.execute.after', ai)).cwd],
    [bashArgs().command, path.join(dir, 'packages', 'api')]
  );
  for (const [tool, args] of [['read', readArgs('src/a.ts')], ['glob', { pattern: '*' }], ['github_create_or_update_file', { file_path: 'src/a.ts' }]]) {
    const [i, o] = before(tool, args);
    const n = parseOpencode('pre_edit', e('tool.execute.before', i, o));
    assert.deepEqual([n.files, n.call, n.patch, n.command], [[], undefined, undefined, undefined], tool);
  }
  // a subagent's call is its session's; its prompt is nobody's
  const [ci, co] = before('edit', editArgs('src/a.ts'), { sessionID: 'ses_child' });
  assert.deepEqual(
    (({ session_id, agent_id }) => ({ session_id, agent_id }))(parseOpencode('pre_edit', e('tool.execute.before', ci, co, { root: 'ses_top' }))),
    { session_id: 'ses_top', agent_id: 'ses_child' }
  );
  const [mi, mo] = chatMessage('hello', { sessionID: 'ses_child' });
  assert.equal(parseOpencode('prompt', e('chat.message', mi, mo, { root: 'ses_top' })), null);
  assert.equal(parseOpencode('prompt', e('chat.message', ...chatMessage('hello'))).prompt, 'hello');
  assert.equal(parseOpencode('prompt', e('chat.message', ...chatMessage('   '))), null, 'nothing typed');
  assert.equal(parseOpencode('session_end', e('dispose', { sessionID: 's' })).end_reason, 'exit');
  // not the plugin's envelope
  for (const bad of [null, [], 'x', { opencode: 2, input: bi, output: bo }, { tool_name: 'Edit', tool_input: {} }]) assert.equal(parseOpencode('pre_edit', bad), null);
  assert.deepEqual(parseOpencode('pre_edit', e('tool.execute.before', bi, { args: 'not an object' })).files, []);
});

test('nothing that goes wrong refuses an edit or rejects a hook: no room, no hooks, no node, a hook that hangs or babbles, garbage', async () => {
  // the room down: the edit goes through at once
  const down = await startServer();
  const m = machine(down.port);
  await down.close();
  const hooks = await plugin(m);
  const [input, output] = before('edit', editArgs(userTs(m)), { sessionID: session() });
  let started = Date.now();
  await hooks['tool.execute.before'](input, output);
  assert.ok(Date.now() - started < within(2500), `${Date.now() - started}ms`);
  await hooks['tool.execute.after'](...after('edit', editArgs(userTs(m)), editResult(userTs(m), m.project)));
  await hooks['chat.message'](...chatMessage('hello'));

  // the generic hook handed garbage says go on, and exit 0
  for (const payload of ['not json', '[1]', '', JSON.stringify({ opencode: 2 }), JSON.stringify({ opencode: 1, input: { tool: 'edit' }, output: { args: null } })]) {
    const out = await hook('pre_edit', payload, m);
    assert.deepEqual([out.code, out.stdout, out.stderr], [0, GO_ON, ''], payload);
  }
  assert.equal((await hook('prompt', 'not json', m)).stdout, '{}\n');

  // OpenCode's event hook is not waited for: whatever it is handed, it never rejects
  for (const odd of [undefined, null, {}, { event: null }, { event: { type: 'session.deleted' } }, { event: { type: 'session.created', properties: { info: null } } }]) {
    await hooks.event(odd);
  }
  await hooks['chat.message'](undefined, undefined);
  await hooks['tool.execute.after'](undefined, undefined);
  await hooks['tool.execute.before'](undefined, undefined);
  await hooks.dispose();

  // no hooks where the plugin looks for them, and no node on the PATH
  const gone = await plugin(m, { dir: path.join(m.home, 'no-such-hooks') });
  await gone['tool.execute.before'](input, output);
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = '';
    await hooks['tool.execute.before'](input, output);
    await hooks['tool.execute.after'](...after('edit', editArgs(userTs(m)), editResult(userTs(m), m.project)));
    await hooks.dispose();
  } finally {
    process.env.PATH = savedPath;
  }

  // a hook that says what is not its answer, or a refusal with no reason: go on
  for (const script of ['console.log("not json");\n', 'console.log(JSON.stringify({ decision: "deny" }));\n', 'process.exit(3);\n']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-opencode-hooks-'));
    fs.writeFileSync(path.join(dir, 'agent_hook.mjs'), script);
    const odd = await plugin(m, { dir });
    await odd['tool.execute.before'](input, output);
  }

  // OpenCode waits on a plugin with no deadline of its own: a hook that never answers is let go after WAIT_MS
  const hung = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-opencode-hooks-'));
  fs.writeFileSync(path.join(hung, 'agent_hook.mjs'), 'setInterval(() => {}, 1000);\n');
  const stuck = await plugin(m, { dir: hung });
  started = Date.now();
  await stuck['tool.execute.before'](input, output);
  const waited = Date.now() - started;
  assert.ok(waited >= 4500 && waited < within(7000), `${waited}ms`);

  // switched off: asks nobody
  const up = await startServer();
  const on = machine(up.port);
  try {
    const quiet = await plugin({ ...on, env: { ...on.env, AGENTMASH_DISABLE: '1' } });
    await quiet['tool.execute.before'](...before('edit', editArgs(userTs(on)), { sessionID: session() }));
    assert.equal(up.requests.filter((r) => r.path === '/check').length, 0);
  } finally {
    delete process.env.AGENTMASH_DISABLE;
    await up.close();
  }
});
