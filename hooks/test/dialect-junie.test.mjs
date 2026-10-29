// Junie's dialect (dialects/junie.mjs), run as login registers it with Junie
// (cli/agents/junie.mjs), against the payloads Junie sends (fixtures/junie,
// each from Junie's docs or a published capture). These pin that the advice
// before an edit reaches Junie as additionalContext and nothing else, that a
// read or a command asks nothing, that the project is never taken from
// Junie's cwd (its own home), that an edit is reported as Junie's once its
// file has changed and not before, and that anything going wrong says
// nothing at all, at once, with exit 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lib from '../lib.mjs';
import junie, { BESIDE_MS, WAITING_FOR_MS, filesInDiff, fingerprint, junieCall } from '../dialects/junie.mjs';
import { junieHooks } from '../../cli/agents/junie.mjs';
import { eventsOf, machine, runHook, session, startServer, within } from './fixtures.mjs';
import * as said from './fixtures/junie/session-events.mjs';
import * as call from './fixtures/junie/tool-events.mjs';

/** The arguments login gives the generic hook for one of Junie's events, from the command it registers. */
const registered = (junieEvent) => {
  const command = junieHooks('/h/.agentmash/hooks')[junieEvent][0].hooks[0].command;
  return command.slice(command.indexOf('" ') + 2).split(' ');
};
const ARGS = {
  SessionStart: registered('SessionStart'),
  UserPromptSubmit: registered('UserPromptSubmit'),
  PreToolUse: registered('PreToolUse'),
  Stop: registered('Stop'),
};
const run = (junieEvent, payload, env) => runHook('agent_hook.mjs', payload, env, ARGS[junieEvent]);
/**
 * A checkout and a home, signed in to `port`, with a temporary folder of
 * their own: the advice's once-per-session cooldown is kept there, and a
 * build that sends no session id is session "unknown" in every run.
 */
function machineOf(port) {
  const m = machine(port);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-junie-tmp-'));
  return { ...m, env: { ...m.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp } };
}
const userTs = (m) => path.join(m.project, 'src', 'models', 'user.ts');
const junieHome = (m) => path.join(m.home, '.junie');
/** A hook's answer, read: nothing, or one JSON object. */
const answerOf = (out) => (out.stdout === '' ? null : JSON.parse(out.stdout));

/** Nothing Junie would act on as an approval, a question or a changed call. */
function grantsNothing(stdout) {
  assert.doesNotMatch(stdout, /"allow"|"ask"|updatedInput|"approve"/, stdout);
}

test('login registers the generic hook in this dialect, for the events this file reads', () => {
  assert.deepEqual(ARGS.PreToolUse, ['pre_edit', '--global', '--client', 'junie', '--dialect', 'junie']);
  assert.deepEqual(ARGS.UserPromptSubmit, ['prompt', '--global', '--client', 'junie', '--dialect', 'junie']);
  assert.deepEqual(ARGS.SessionStart, ['session_start', '--global', '--client', 'junie', '--dialect', 'junie']);
  assert.deepEqual(ARGS.Stop, ['stop', '--global', '--client', 'junie', '--dialect', 'junie']);
  assert.equal(junieHooks('/h/.agentmash/hooks').PreToolUse[0].matcher, 'Edit|Write');
});

test('before an edit Junie is told in additionalContext and nothing else; a read or a command asks nothing', async () => {
  const server = await startServer();
  const m = machineOf(server.port);
  const s = session();
  try {
    // SessionStart says where the session works, and nothing else happens: no heads-up Junie would drop
    const start = await run('SessionStart', said.sessionStart({ session_id: s, junieHome: junieHome(m), project_path: m.project }), m.env);
    assert.deepEqual([start.code, start.stdout, start.stderr], [0, '', '']);
    assert.equal(server.requests.length, 0, 'session_start.mjs was not run: its heads-up would be lost, and the first prompt would not give it');

    // 3419.7's envelope without project_path: the session says where
    const write = await run('PreToolUse', call.write({ session_id: s, junieHome: junieHome(m), path: userTs(m), content: 'export interface User { id: string; role: string }\n' }), m.env);
    assert.equal(write.code, 0, write.stderr);
    const advice = answerOf(write);
    assert.deepEqual(Object.keys(advice), ['additionalContext']);
    assert.match(advice.additionalContext, /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts/);
    grantsNothing(write.stdout);
    const checks = server.requests.filter((r) => r.path === '/check');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].query.file_path, 'src/models/user.ts');
    assert.equal(checks[0].user, 'amu_agentstokenagentstokenagent');

    // the other candidate: a relative `path`, and search/replace, with project_path
    // (each in a session of its own: the advice is given once per session and file)
    const edit = await run('PreToolUse', call.editSearchReplace({ session_id: session(), project_path: m.project, path: 'src/models/user.ts' }), m.env);
    assert.match(answerOf(edit).additionalContext, /alice's agent modified src\/models\/user\.ts/);

    // a patch naming its files only inside it
    const patch = ['*** Begin Patch', '*** Update File: src/models/user.ts', '@@', '-id: string', '+id: string; role: string', '*** End Patch'].join('\n');
    const patched = await run('PreToolUse', call.editPatch({ session_id: session(), project_path: m.project, patch }), m.env);
    assert.match(answerOf(patched).additionalContext, /alice's agent modified src\/models\/user\.ts/);

    // a read, and the docs' own Bash call, ask nothing and say nothing
    const asked = server.requests.length;
    for (const payload of [call.read({ session_id: s, project_path: m.project, path: userTs(m) }), call.docsBash()]) {
      const out = await run('PreToolUse', payload, m.env);
      assert.deepEqual([out.code, out.stdout, out.stderr], [0, '', ''], payload.tool_name);
    }
    assert.equal(server.requests.length, asked, 'nothing asked');

    // a file nobody is in: nothing said, not "allow"
    const free = await run('PreToolUse', call.write({ session_id: s, project_path: m.project, path: path.join(m.project, 'src', 'free.ts') }), m.env);
    assert.deepEqual([free.code, free.stdout], [0, '']);
  } finally {
    await server.close();
  }
});

test("the project is project_path, the session's, or the checkout of a full path, and never Junie's cwd", async () => {
  const server = await startServer();
  const m = machineOf(server.port);
  const checks = () => server.requests.filter((r) => r.path === '/check').length;
  try {
    // 26.8's envelope: no session, no project; a full path is enough
    const full = await run('PreToolUse', call.editClaudeNames({ build: '26.8', path: userTs(m) }), m.env);
    assert.match(answerOf(full).additionalContext, /alice's agent modified src\/models\/user\.ts/);
    assert.equal(checks(), 1);

    // a relative path with nothing to place it: asked about nowhere
    const loose = await run('PreToolUse', call.editClaudeNames({ build: '26.8', path: 'src/models/user.ts' }), m.env);
    assert.deepEqual([loose.code, loose.stdout], [0, '']);
    // and a cwd that is a checkout changes nothing: Junie's cwd is its own home, whatever it says
    const misleading = { ...call.editClaudeNames({ session_id: session(), path: 'src/models/user.ts' }), cwd: m.project };
    const fromCwd = await run('PreToolUse', misleading, m.env);
    assert.deepEqual([fromCwd.code, fromCwd.stdout], [0, '']);
    assert.equal(checks(), 1, 'nothing asked for either');

    // a session whose prompt said where it works places a relative path from then on
    const s = session();
    await run('UserPromptSubmit', said.userPromptSubmit({ session_id: s, junieHome: junieHome(m), project_path: m.project }), m.env);
    const placed = await run('PreToolUse', call.editClaudeNames({ session_id: s, path: 'src/models/user.ts' }), m.env);
    assert.match(answerOf(placed).additionalContext, /alice's agent modified src\/models\/user\.ts/);

    // what is kept for that is private, and holds no prompt
    const kept = path.join(m.home, '.agentmash', 'junie.json');
    if (process.platform !== 'win32') assert.equal(fs.statSync(kept).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(kept, 'utf8'), /grill-with-docs/);
  } finally {
    await server.close();
  }
});

test("the room's strict mode refuses the edit in the shape Junie was seen to honour, every time", async () => {
  const server = await startServer();
  const m = machineOf(server.port);
  const env = { ...m.env, AGENTMASH_STRICT: '1' };
  const s = session();
  try {
    for (let i = 0; i < 2; i++) {
      const out = await run('PreToolUse', call.write({ session_id: s, project_path: m.project, path: userTs(m) }), env);
      assert.equal(out.code, 0, out.stderr);
      const refused = answerOf(out);
      assert.deepEqual(Object.keys(refused), ['decision', 'reason', 'hookSpecificOutput']);
      assert.equal(refused.decision, 'block');
      assert.match(refused.reason, /AgentMash strict mode blocked this edit/);
      assert.deepEqual(refused.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refused.reason });
      grantsNothing(out.stdout);
    }
  } finally {
    await server.close();
  }
});

test("an edit is reported as Junie's once its file has changed, at the next edit or as the task ends, and one that changed nothing never is", async () => {
  const server = await startServer();
  const m = machineOf(server.port);
  const s = session();
  const at = { session_id: s, project_path: m.project };
  fs.writeFileSync(path.join(m.project, 'src', 'index.ts'), 'export {};\n');
  try {
    const prompt = await run('UserPromptSubmit', said.userPromptSubmit({ ...at, junieHome: junieHome(m), prompt: 'give the user a role' }), m.env);
    assert.deepEqual([prompt.code, prompt.stdout], [0, ''], 'nobody at work: no heads-up, and nothing in its place');

    // a new file: asked about, then written by Junie
    await run('PreToolUse', call.write({ ...at, path: path.join(m.project, 'src', 'new.ts') }), m.env);
    // what a write writes is not kept: it is read back from the file once it is there
    assert.doesNotMatch(fs.readFileSync(path.join(m.home, '.agentmash', 'junie.json'), 'utf8'), /export const b/);
    fs.writeFileSync(path.join(m.project, 'src', 'new.ts'), 'export const b = 2;\n');
    // an edit Junie never makes (refused, or its search text not found)
    await run('PreToolUse', call.editSearchReplace({ ...at, path: 'src/index.ts', before: 'nope', after: 'never' }), m.env);
    await new Promise((r) => setTimeout(r, BESIDE_MS + 100));
    // the next edit: what came before it is settled, then it is asked about, then made
    const next = await run('PreToolUse', call.editSearchReplace({ ...at, path: 'src/models/user.ts' }), m.env);
    assert.match(answerOf(next).additionalContext, /alice's agent modified/);
    fs.writeFileSync(userTs(m), 'export interface User { id: string;\n  role: string }\n');

    // Junie's Stop names no session (fixtures/junie): it settles whichever session's edits have landed
    const stop = await run('Stop', said.stop(), m.env);
    assert.deepEqual([stop.code, stop.stdout, stop.stderr], [0, '', ''], 'a Stop hook that says anything sends Junie round again');
    assert.ok(!server.requests.some((r) => r.path === '/collisions'), 'stop.mjs is not run: what it says, Junie cannot be told');

    const events = (await eventsOf(server, 3, 6000)).map((r) => r.body);
    assert.deepEqual(
      events.filter((e) => e.event_type === 'edit').map((e) => [e.tool, e.file_path, e.change_summary, e.session_id]).sort(),
      [
        ['junie:Edit', 'src/models/user.ts', '+2/-1 lines', s],
        ['junie:Write', 'src/new.ts', 'wrote 2 lines, defining b', s],
      ]
    );
    const asked = events.find((e) => e.event_type === 'prompt');
    assert.deepEqual([asked.tool, asked.task_hint, asked.git_branch], ['junie', 'give the user a role', 'feat/login']);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!server.requests.some((r) => r.path === '/events' && r.body?.file_path === 'src/index.ts'), 'the edit that changed nothing');

    // all settled: nothing left waiting, so a second Stop reports nothing more
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(m.home, '.agentmash', 'junie.json'), 'utf8')).waiting, []);
  } finally {
    await server.close();
  }
});

test('two hooks at once report a landed edit once between them, and neither loses what the other waits for', async () => {
  const server = await startServer();
  const m = machineOf(server.port);
  const s = session();
  const at = { session_id: s, project_path: m.project };
  const kept = path.join(m.home, '.agentmash', 'junie.json');
  const src = (name) => path.join(m.project, 'src', name);
  try {
    for (let round = 0; round < 4; round++) {
      // an edit asked about, then made: it waits to be seen to land
      fs.writeFileSync(src(`landed-${round}.ts`), 'export const a = 1;\n');
      await run('PreToolUse', call.editSearchReplace({ ...at, path: `src/landed-${round}.ts`, before: 'a = 1', after: 'a = 2' }), m.env);
      fs.writeFileSync(src(`landed-${round}.ts`), 'export const a = 2;\n');
      // Junie runs two calls side by side: both hooks find the landed edit
      fs.writeFileSync(src(`b-${round}.ts`), 'export const b = 1;\n');
      fs.writeFileSync(src(`c-${round}.ts`), 'export const c = 1;\n');
      await Promise.all(
        ['b', 'c'].map((name) => run('PreToolUse', call.editSearchReplace({ ...at, path: `src/${name}-${round}.ts`, before: `${name} = 1`, after: `${name} = 2` }), m.env))
      );
      const waiting = JSON.parse(fs.readFileSync(kept, 'utf8')).waiting.map((w) => path.basename(w.file));
      assert.ok(waiting.includes(`b-${round}.ts`) && waiting.includes(`c-${round}.ts`), `round ${round}: both still waited for (${waiting})`);
      assert.ok(!waiting.includes(`landed-${round}.ts`), `round ${round}: the landed edit is settled`);
    }
    await eventsOf(server, 4, 6000);
    await new Promise((r) => setTimeout(r, 500));
    const reported = server.requests.filter((r) => r.path === '/events' && r.body?.event_type === 'edit').map((r) => r.body.file_path).sort();
    assert.deepEqual(reported, ['src/landed-0.ts', 'src/landed-1.ts', 'src/landed-2.ts', 'src/landed-3.ts'], 'each once');

    // the state held by another hook that is not letting go: this one says its advice and touches nothing
    fs.mkdirSync(`${kept}.lock`);
    fs.writeFileSync(src('held.ts'), 'export const h = 1;\n');
    const before = fs.readFileSync(kept, 'utf8');
    const held = await run('PreToolUse', call.editSearchReplace({ ...at, path: 'src/held.ts', before: 'h = 1', after: 'h = 2' }), m.env);
    assert.equal(held.code, 0);
    assert.equal(fs.readFileSync(kept, 'utf8'), before, 'nothing written without the lock');
    // and one left by a hook that died holding it is taken, once it is old enough
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${kept}.lock`, old, old);
    await run('PreToolUse', call.editSearchReplace({ ...at, path: 'src/held.ts', before: 'h = 1', after: 'h = 2' }), m.env);
    assert.ok(JSON.parse(fs.readFileSync(kept, 'utf8')).waiting.some((w) => path.basename(w.file) === 'held.ts'));
    assert.ok(!fs.existsSync(`${kept}.lock`), 'and let go of');
  } finally {
    await server.close();
  }
});

test('a build that sends no session is reported too, and an edit waited for past its time is forgotten', async () => {
  const server = await startServer();
  const m = machineOf(server.port);
  try {
    await run('PreToolUse', call.write({ build: '26.8', path: path.join(m.project, 'src', 'old.ts') }), m.env);
    fs.writeFileSync(path.join(m.project, 'src', 'old.ts'), 'export const c = 3;\n');
    await run('Stop', said.stop(), m.env);
    const [edit] = (await eventsOf(server, 1, 6000)).map((r) => r.body);
    assert.deepEqual([edit.tool, edit.file_path, edit.session_id], ['junie:Write', 'src/old.ts', 'unknown']);

    // a wait written down long ago, whose file has changed since: not this session's news any more
    const kept = path.join(m.home, '.agentmash', 'junie.json');
    const stale = { session: 'unknown', root: m.project, file: path.join(m.project, 'src', 'index.ts'), print: 'absent', tool: 'Write', kind: 'write', at: Date.now() - WAITING_FOR_MS - 1000 };
    fs.writeFileSync(kept, JSON.stringify({ sessions: {}, waiting: [stale] }));
    fs.writeFileSync(path.join(m.project, 'src', 'index.ts'), 'export {};\n');
    await run('Stop', said.stop(), m.env);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(server.requests.filter((r) => r.path === '/events').length, 1, 'nothing more reported');

    // and one whose file never changed, asked about more than a moment before a Stop, was refused or failed: forgotten, unreported
    const failed = { ...stale, session: 'session-261005-101500-ab12', print: fingerprint(stale.file), at: Date.now() - BESIDE_MS - 500 };
    const asked = { ...failed, file: userTs(m), print: fingerprint(userTs(m)), at: Date.now() };
    fs.writeFileSync(kept, JSON.stringify({ sessions: {}, waiting: [failed, asked] }));
    await run('Stop', said.stop(), m.env);
    assert.deepEqual(JSON.parse(fs.readFileSync(kept, 'utf8')).waiting.map((w) => w.file), [asked.file], 'one asked about a moment ago may still be running');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(server.requests.filter((r) => r.path === '/events').length, 1);
  } finally {
    await server.close();
  }
});

test('anything wrong says nothing, at once, with exit 0: a room down or hung, garbage, switched off, an event with nothing to say', async () => {
  const down = await startServer();
  const m = machineOf(down.port);
  await down.close();
  const s = session();
  const quiet = async (junieEvent, payload, env = m.env) => {
    const out = await run(junieEvent, payload, env);
    assert.deepEqual([out.code, out.stdout, out.stderr], [0, '', ''], `${junieEvent}: ${JSON.stringify(payload).slice(0, 80)}`);
    return out;
  };
  const refused = await quiet('PreToolUse', call.write({ session_id: s, project_path: m.project, path: userTs(m) }));
  assert.ok(refused.elapsed < within(1500), `${refused.elapsed}ms with the room down`);
  for (const garbage of ['not json at all', '[1,2]', '', '{"hook_event_name":', 'null']) {
    for (const junieEvent of ['PreToolUse', 'UserPromptSubmit', 'SessionStart', 'Stop']) await quiet(junieEvent, garbage);
  }
  await quiet('PreToolUse', call.write({ session_id: s, project_path: m.project, path: userTs(m) }), { ...m.env, AGENTMASH_DISABLE: '1' });
  await quiet('PreToolUse', { hook_event_name: 'PreToolUse', session_id: s, project_path: m.project, tool_name: 'Write', tool_input: 'not an object' });
  await quiet('PreToolUse', { hook_event_name: 'PreToolUse', session_id: s, project_path: 'relative/project', tool_name: 'Write', tool_input: { file_path: 'src/models/user.ts' } });
  // SessionEnd is not registered; were it run, it names no session and says nothing
  await quiet('Stop', said.sessionEnd());

  const hung = await startServer({ hang: true });
  const h = machineOf(hung.port);
  try {
    const slow = await quiet('PreToolUse', call.write({ session_id: s, project_path: h.project, path: userTs(h) }), { ...h.env, AGENTMASH_TIMEOUT_MS: '600' });
    assert.ok(slow.elapsed < within(600 + 250 + 400 + 500), `${slow.elapsed}ms`);
    assert.ok(hung.requests.some((r) => r.path === '/check'), 'it did ask');
  } finally {
    await hung.close();
  }

  // what the dialect keeps cannot be written (a folder where its file goes):
  // the advice still comes, and with nothing written down nothing is reported
  const room = await startServer();
  const w = machineOf(room.port);
  try {
    fs.mkdirSync(path.join(w.home, '.agentmash', 'junie.json', 'in-the-way'), { recursive: true });
    const out = await run('PreToolUse', call.write({ session_id: s, project_path: w.project, path: path.join(w.project, 'src', 'models', 'user.ts') }), w.env);
    assert.equal(out.code, 0, out.stderr);
    assert.match(answerOf(out).additionalContext, /alice's agent modified src\/models\/user\.ts/);
    fs.writeFileSync(userTs(w), 'export interface User { id: string; role: string }\n');
    await quiet('Stop', said.stop({ session_id: s }), w.env);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(room.requests.filter((r) => r.path === '/events').length, 0);
  } finally {
    await room.close();
  }
});

test('the dialect says advice and heads-ups as additionalContext, a strict refusal as a block, and nothing else ever', () => {
  const advice = { action: 'advise', text: '[AgentMash: RECENT EDIT] x' };
  assert.equal(junie.answer('pre_edit', advice).stdout, '{"additionalContext":"[AgentMash: RECENT EDIT] x"}\n');
  assert.equal(junie.answer('prompt', advice).stdout, '{"additionalContext":"[AgentMash: RECENT EDIT] x"}\n');
  assert.equal(junie.answer('prompt', { ...advice, action: 'deny' }).stdout, '{"additionalContext":"[AgentMash: RECENT EDIT] x"}\n', 'a prompt is never refused');
  assert.equal(JSON.parse(junie.answer('pre_edit', { action: 'deny', text: 'no' }).stdout).decision, 'block');
  for (const event of ['session_start', 'stop', 'session_end', 'post_edit']) {
    assert.equal(junie.answer(event, advice).stdout, '', event);
    assert.equal(junie.neutral(event).stdout, '', event);
  }
  assert.equal(junie.answer('pre_edit', { action: 'allow', text: null }).stdout, '');
  assert.equal(junie.answer('pre_edit', null).stdout, '');
  assert.equal(junie.neutral('pre_edit').stdout, '');
});

test("an edit's call is read whichever names Junie gives its fields, and a read is never an edit", () => {
  lib.registerClientTools('junie', junie.tools);
  assert.deepEqual(junieCall('Write', { file_path: '/r/a.ts', content: 'x' }, 'junie', lib).files, ['/r/a.ts']);
  const searched = junieCall('Edit', { path: 'a.ts', search: 'a', replace: 'b' }, 'junie', lib);
  assert.deepEqual([searched.files, searched.input.old_string, searched.input.new_string], [['a.ts'], 'a', 'b']);
  const named = junieCall('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y', search: 'a' }, 'junie', lib);
  assert.equal(named.input.old_string, 'x', "Claude Code's names win where both are given");
  const patched = junieCall('Edit', { patch: '*** Begin Patch\n*** Add File: b.ts\n+x\n*** Update File: c.ts\n@@\n-a\n+b\n*** End Patch' }, 'junie', lib);
  assert.deepEqual(patched.files, ['b.ts', 'c.ts']);
  assert.ok(patched.patch);
  assert.deepEqual(junieCall('Edit', { diff: '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n' }, 'junie', lib).files, ['src/x.ts']);
  assert.deepEqual(junieCall('Read', { file_path: '/r/a.ts' }, 'junie', lib).files, [], 'a read names no file it changes');
  assert.deepEqual(junieCall('Bash', { command: 'sed -i s/a/b/ a.ts' }, 'junie', lib).files, []);
  assert.deepEqual(junieCall('Edit', 'not an object', 'junie', lib).files, []);

  assert.deepEqual(filesInDiff('--- /dev/null\n+++ b/new.ts\n@@\n+x\n--- a/gone.ts\n+++ /dev/null\n'), ['new.ts', 'gone.ts']);
  assert.deepEqual(filesInDiff('--- src/a.ts\t2026-10-01\n+++ src/a.ts\t2026-10-02\n'), ['src/a.ts'], 'plain diff -u keeps its paths as they are');
  assert.deepEqual(filesInDiff('+++ b/only-half.ts\n'), [], 'a +++ line on its own is not a diff');
});
