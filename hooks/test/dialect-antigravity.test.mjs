// Antigravity's dialect (dialects/antigravity.mjs), run the way login
// registers it with agy: `agent_hook.mjs <event> --global --client
// antigravity`, fed the payloads in fixtures/antigravity/, which say where
// each shape comes from (Antigravity's docs and what others recorded of agy;
// nothing here is a live capture). These pin that an edit agy made reaches
// the room as the agent's and is answered `{}`, the one answer agy takes
// after a tool; that a turn's prompt is read from the transcript, reported
// once, and the heads-up comes back as a note the model reads; that before an
// edit (only if someone wires it up) the first try at a teammate's file is
// refused with the advice and nothing ever says "allow"; and that every
// failure is the event's neutral answer and exit 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HOOKS_DIR, REF, eventsOf, machine, runHook, session, startServer, within } from './fixtures.mjs';
import dialect, { firstSight, lastUserInput, parseAntigravity, requestOf } from '../dialects/antigravity.mjs';

const FIXTURES = path.join(HOOKS_DIR, 'test', 'fixtures', 'antigravity');
/** Exactly the arguments login registers: no --dialect, so the hook finds this one by the client's name. */
const ARGS = ['--global', '--client', 'antigravity'];
const NOTHING = '{}\n';
const ASK = '{"decision":"ask"}\n';
const hook = (event, payload, env) => runHook('agent_hook.mjs', payload, env, [event, ...ARGS]);

/** A brain folder of agy's, with the recorded transcript in it. */
function brain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-agy-brain-'));
  fs.copyFileSync(path.join(FIXTURES, 'transcript_full.jsonl'), path.join(dir, 'transcript_full.jsonl'));
  return dir;
}

/**
 * A recorded payload, for this checkout, conversation and brain folder. The
 * placeholders sit inside JSON strings, so each value goes in as JSON writes
 * it: a Windows path's backslashes escaped, as agy's own payloads have them.
 */
function recorded(name, m, { conversation = session(), dir = brain(), fromHome = '' } = {}) {
  const inJson = (value) => JSON.stringify(value).slice(1, -1);
  const text = fs
    .readFileSync(path.join(FIXTURES, name), 'utf8')
    .replaceAll('{{workspace_from_home}}', inJson(fromHome))
    .replaceAll('{{workspace}}', inJson(m.project))
    .replaceAll('{{brain}}', inJson(dir))
    .replaceAll('{{conversation}}', inJson(conversation));
  return JSON.parse(text).stdin;
}

/** A room whose /team has `team` in it, recording every request, as fixtures.mjs's startServer does. */
function teamServer(team) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null });
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (url.pathname === '/api/lookup') return send(200, { room_ref: REF, developer: 'bob' });
      if (url.pathname === '/team') return send(200, team);
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

const quiet = (ms = 500) => new Promise((r) => setTimeout(r, ms));

test('an edit agy made reaches the room as the agent\'s, in the background, and agy is answered {} and nothing else', async () => {
  const server = await startServer({ eventsDelayMs: 800 });
  const m = machine(server.port);
  try {
    for (const name of ['post_tool_use.replace_file_content.json', 'post_tool_use.write_to_file.json', 'post_tool_use.multi_replace_file_content.json']) {
      const out = await hook('post_edit', recorded(name, m), m.env);
      assert.deepEqual([out.code, out.stdout, out.stderr], [0, NOTHING, ''], name);
      assert.ok(out.elapsed < within(700), `${name}: the hook waited ${out.elapsed}ms on a report it had handed off`);
    }
    // a path from the home folder, as agy sometimes names one (the home is USERPROFILE on Windows)
    const fromHome = { ...m.env, HOME: path.dirname(m.project), USERPROFILE: path.dirname(m.project) };
    const home = await hook('post_edit', recorded('post_tool_use.home_path.json', m, { fromHome: path.basename(m.project) }), fromHome);
    assert.deepEqual([home.code, home.stdout], [0, NOTHING]);

    const edits = (await eventsOf(server, 4, 6000)).map((r) => r.body).filter((e) => e.event_type === 'edit');
    const said = edits.map((e) => [e.tool, e.file_path, e.change_summary]).sort();
    assert.deepEqual(said.filter(([tool]) => tool === 'antigravity:Edit'), [
      ['antigravity:Edit', 'src/models/user.ts', '+2/-1 lines'],
      ['antigravity:Edit', 'src/models/user.ts', '+2/-1 lines'],
    ]);
    assert.ok(said.some(([tool, file, summary]) => tool === 'antigravity:Write' && file === 'src/new.ts' && summary === 'wrote 2 lines, defining a'), JSON.stringify(said));
    assert.ok(said.some(([tool, file]) => tool === 'antigravity:MultiEdit' && file === 'src/models/user.ts'), JSON.stringify(said));
    assert.ok(edits.every((e) => e.developer === 'bob' && e.git_branch === 'feat/login'));
  } finally {
    await server.close();
  }
});

test("a read, a tool that failed and agy's own notes are nothing to report, and nothing is asked", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    for (const name of ['post_tool_use.view_file.json', 'post_tool_use.failed.json', 'post_tool_use.artifact.json']) {
      const out = await hook('post_edit', recorded(name, m), m.env);
      assert.deepEqual([out.code, out.stdout, out.stderr], [0, NOTHING, ''], name);
    }
    // an edit of a file in agy's brain folder, not flagged as one of its notes
    const dir = brain();
    const notes = recorded('post_tool_use.replace_file_content.json', m, { dir });
    notes.toolCall.args.TargetFile = path.join(dir, 'task.md');
    assert.equal((await hook('post_edit', notes, m.env)).stdout, NOTHING);
    await quiet();
    assert.deepEqual(server.requests, [], 'not even a room lookup');
  } finally {
    await server.close();
  }
});

test("at a turn's first model call the prompt is read from the transcript and reported once, and the heads-up comes back as a note the model reads", async () => {
  const server = await teamServer({
    developers: [{ developer: 'alice', presence: 'active', branch: 'feat/login', task_hint: 'add soft deletes', files: ['src/models/user.ts'] }],
  });
  const m = machine(server.port);
  const conversation = session();
  const dir = brain();
  try {
    const first = await hook('prompt', recorded('pre_invocation.first.json', m, { conversation, dir }), m.env);
    assert.equal(first.code, 0, first.stderr);
    const said = JSON.parse(first.stdout);
    assert.deepEqual(Object.keys(said), ['injectSteps']);
    assert.equal(said.injectSteps.length, 1);
    assert.deepEqual(Object.keys(said.injectSteps[0]), ['ephemeralMessage']);
    assert.match(said.injectSteps[0].ephemeralMessage, /alice/);

    // the turn's later model calls, numbered or not, say nothing and report nothing again
    assert.equal((await hook('prompt', recorded('pre_invocation.later.json', m, { conversation, dir }), m.env)).stdout, NOTHING);
    assert.equal((await hook('prompt', recorded('pre_invocation.unnumbered.json', m, { conversation, dir }), m.env)).stdout, NOTHING);
    await quiet(800);
    const prompts = () => server.requests.filter((r) => r.path === '/events' && r.body?.event_type === 'prompt').map((r) => r.body);
    assert.deepEqual(prompts().map((p) => [p.tool, p.task_hint, p.session_id]), [['antigravity', 'give the user a role', conversation]]);
    assert.equal(server.requests.filter((r) => r.path === '/team').length, 1);

    // the next turn the person types is reported in its turn
    fs.appendFileSync(
      path.join(dir, 'transcript_full.jsonl'),
      JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>\nnow add a migration\n</USER_REQUEST>' }) + '\n'
    );
    const next = await hook('prompt', recorded('pre_invocation.unnumbered.json', m, { conversation, dir }), m.env);
    assert.equal(next.stdout, NOTHING, 'the same teammates, said a moment ago, are not news');
    await quiet(800);
    assert.deepEqual(prompts().map((p) => p.task_hint), ['give the user a role', 'now add a migration']);
  } finally {
    await server.close();
  }
});

test('before an edit, where someone wires it up: the room is asked, the first try is refused with the advice, the next is left to the person, a read asks nothing, and nothing says allow', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const conversation = session();
    const first = await hook('pre_edit', recorded('pre_tool_use.replace_file_content.json', m, { conversation }), m.env);
    assert.equal(first.code, 0, first.stderr);
    const refused = JSON.parse(first.stdout);
    assert.deepEqual(Object.keys(refused), ['decision', 'reason']);
    assert.equal(refused.decision, 'deny');
    assert.match(refused.reason, /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts/);
    assert.match(refused.reason, /make the same edit again and it goes through\.$/);
    const checks = server.requests.filter((r) => r.path === '/check');
    assert.deepEqual(checks.map((c) => c.query.file_path), ['src/models/user.ts']);

    const again = await hook('pre_edit', recorded('pre_tool_use.replace_file_content.json', m, { conversation }), m.env);
    assert.deepEqual([again.code, again.stdout], [0, ASK]);

    const asked = server.requests.length;
    const read = await hook('pre_edit', recorded('pre_tool_use.view_file.json', m, { conversation }), m.env);
    assert.deepEqual([read.code, read.stdout], [0, ASK]);
    assert.equal(server.requests.length, asked, 'the read asked nothing');

    // a file nobody is in is left to the person's own rules too
    const free = recorded('pre_tool_use.replace_file_content.json', m);
    free.toolCall.args.TargetFile = path.join(m.project, 'src', 'index.ts');
    assert.equal((await hook('pre_edit', free, m.env)).stdout, ASK);
    for (const out of [first, again, read]) assert.doesNotMatch(out.stdout, /allow/);
  } finally {
    await server.close();
  }
});

test("a room that is down, a script that cannot answer, and stdin that is not agy's are each event's neutral answer, at once, and exit 0", async () => {
  const down = await startServer();
  const m = machine(down.port);
  await down.close();
  const neutral = { post_edit: NOTHING, prompt: NOTHING, pre_edit: ASK, session_start: NOTHING, stop: NOTHING };
  const check = async (event, payload, env = m.env) => {
    const out = await hook(event, payload, env);
    assert.deepEqual([out.code, out.stdout, out.stderr], [0, neutral[event], ''], `${event}: ${JSON.stringify(payload).slice(0, 80)}`);
    assert.ok(out.elapsed < within(3500), `${event}: ${out.elapsed}ms`);
  };
  await check('post_edit', recorded('post_tool_use.replace_file_content.json', m));
  await check('prompt', recorded('pre_invocation.first.json', m));
  await check('pre_edit', recorded('pre_tool_use.replace_file_content.json', m));
  for (const event of Object.keys(neutral)) {
    for (const garbage of ['not json at all', '[1,2]', '', 'null', '{"toolCall":7,"workspacePaths":"x"}', '{"invocationNum":0}']) await check(event, garbage);
  }
  // switched off
  await check('pre_edit', recorded('pre_tool_use.replace_file_content.json', m), { ...m.env, AGENTMASH_DISABLE: '1' });
  await check('prompt', recorded('pre_invocation.first.json', m), { ...m.env, AGENTMASH_DISABLE: '1' });

  // the scripts it waits on crash or print what is not theirs to print, in a copy of the hooks folder
  const up = await startServer();
  const n = machine(up.port);
  try {
    for (const script of ['throw new Error("boom");\n', 'console.log("not json");\n', 'process.exit(3);\n']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-agy-hooks-'));
      fs.mkdirSync(path.join(dir, 'dialects'));
      for (const file of fs.readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.mjs'))) fs.copyFileSync(path.join(HOOKS_DIR, file), path.join(dir, file));
      for (const file of fs.readdirSync(path.join(HOOKS_DIR, 'dialects'))) fs.copyFileSync(path.join(HOOKS_DIR, 'dialects', file), path.join(dir, 'dialects', file));
      for (const file of ['pre_tool_use.mjs', 'prompt_note.mjs']) fs.writeFileSync(path.join(dir, file), script);
      for (const [event, name] of [['pre_edit', 'pre_tool_use.replace_file_content.json'], ['prompt', 'pre_invocation.first.json']]) {
        const out = await runHook('agent_hook.mjs', recorded(name, n), n.env, [event, ...ARGS], { dir });
        assert.deepEqual([out.code, out.stdout, out.stderr], [0, neutral[event], ''], `${event}, ${script}`);
      }
    }
  } finally {
    await up.close();
  }
});

test('what the dialect reads from each payload: files, the repository it is in, commands, turns', () => {
  // absolute paths as this OS writes them: C:\work\app on Windows
  const ws = path.resolve('/work/app');
  const other = path.resolve('/work/lib');
  const call = (name, args, extra = {}) => ({ toolCall: { name, args }, conversationId: 'c-1', workspacePaths: [ws, other], error: '', ...extra });

  const edit = parseAntigravity('post_edit', call('replace_file_content', { TargetFile: path.join(other, 'src', 'a.ts'), TargetContent: 'a', ReplacementContent: 'b' }));
  assert.deepEqual(edit, { session_id: 'c-1', cwd: other, tool: 'replace_file_content', files: [{ path: path.join(other, 'src', 'a.ts'), before: 'a', after: 'b' }] }, 'the workspace the file is in');

  const multi = parseAntigravity('post_edit', call('multi_replace_file_content', { TargetFile: path.join(ws, 'a.ts'), ReplacementChunks: JSON.stringify([{ TargetContent: 'x', ReplacementContent: 'y' }, { nothing: 1 }]) }));
  assert.deepEqual(multi.files, [{ path: path.join(ws, 'a.ts'), edits: [{ before: 'x', after: 'y' }] }]);

  const written = parseAntigravity('post_edit', call('write_to_file', JSON.stringify({ TargetFile: 'src/b.ts', CodeContent: 'b\n', Overwrite: 'true' })));
  assert.deepEqual(written.files, [{ path: path.join(ws, 'src', 'b.ts'), action: 'write', after: 'b\n' }], 'arguments sent as a string, a path relative to the first workspace');

  assert.deepEqual(parseAntigravity('post_edit', call('run_command', { CommandLine: 'npm run build' })).command, 'npm run build');
  assert.equal(parseAntigravity('pre_edit', call('run_command', { CommandLine: 'npm run build' })).command, undefined, 'a command is reported after it ran, never asked about');
  assert.deepEqual(parseAntigravity('post_edit', call('run_command', { CommandLine: 'ls' }, { workspacePaths: [] })).command, undefined, 'no workspace, no working tree to look at');

  // agy run headless without --add-dir: no workspace, so the file's own folder
  const bare = parseAntigravity('post_edit', call('write_to_file', { TargetFile: path.resolve('/elsewhere/x.ts'), CodeContent: '' }, { workspacePaths: [] }));
  assert.equal(bare.cwd, path.resolve('/elsewhere'));
  assert.deepEqual(parseAntigravity('post_edit', call('write_to_file', { TargetFile: 'x.ts' }, { workspacePaths: [] })).files, [], 'relative to nothing');
  assert.deepEqual(parseAntigravity('post_edit', call('write_to_file', { TargetFile: 7 })).files, []);
  assert.deepEqual(parseAntigravity('post_edit', call('codebase_search', { Query: 'x' })).files, [], 'a tool it does not know changes nothing');

  // a turn: only the first model call, only in a workspace, never the folder agy runs hooks in
  assert.equal(parseAntigravity('prompt', { invocationNum: 1, workspacePaths: [ws] }), null);
  assert.equal(parseAntigravity('prompt', { invocationNum: 0, workspacePaths: [] }), null);
  assert.deepEqual(parseAntigravity('prompt', { invocationNum: '0', conversationId: 'c-2', workspacePaths: [ws] }), { session_id: 'c-2', cwd: ws, prompt: '' });
  assert.equal(parseAntigravity('stop', { conversationId: 'c-2', workspacePaths: [] }), null);
  assert.equal(parseAntigravity('post_edit', [1]), null);
});

test('the transcript is read from its end, a line at a time, and a turn is counted once by where its line starts', () => {
  const dir = brain();
  const file = path.join(dir, 'transcript_full.jsonl');
  const said = lastUserInput(file);
  assert.equal(said.text, 'give the user a role');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(said.at, Buffer.byteLength(lines.slice(0, 3).join('\n') + '\n'), 'the byte its line starts at');
  fs.appendFileSync(file, JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'é'.repeat(1000) }) + '\n');
  assert.deepEqual(lastUserInput(file), said, 'the same turn, however long the transcript grows');

  assert.equal(lastUserInput(path.join(dir, 'nope.jsonl')), null);
  assert.equal(lastUserInput('relative/transcript.jsonl'), null);
  assert.equal(lastUserInput(path.join(dir, 'transcript_full.json')), null, 'a .jsonl, or nothing');
  assert.equal(lastUserInput(dir + '/'), null);
  assert.equal(requestOf('plain words\n<ADDITIONAL_METADATA>\nnoise\n</ADDITIONAL_METADATA>'), 'plain words');

  const saved = process.env.AGENTMASH_HOME;
  try {
    process.env.AGENTMASH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-agy-turns-'));
    assert.equal(firstSight('c-1', 10), true);
    assert.equal(firstSight('c-1', 10), false);
    assert.equal(firstSight('c-2', 10), true, 'another conversation');
    const kept = path.join(process.env.AGENTMASH_HOME, '.agentmash', 'antigravity-turns.json');
    assert.ok(!fs.readFileSync(kept, 'utf8').includes('c-1'), 'it names no conversation');
    if (process.platform !== 'win32') assert.equal(fs.statSync(kept).mode & 0o777, 0o600);
    for (let i = 0; i < 150; i++) firstSight('many', i, 1000 + i);
    assert.ok(Object.keys(JSON.parse(fs.readFileSync(kept, 'utf8')).seen).length <= 100);
    // a home that cannot be written: reported again rather than never
    const blocked = path.join(process.env.AGENTMASH_HOME, 'a-file');
    fs.writeFileSync(blocked, '');
    process.env.AGENTMASH_HOME = blocked;
    assert.equal(firstSight('c-3', 1), true);
    assert.equal(firstSight('c-3', 1), true);
  } finally {
    if (saved === undefined) delete process.env.AGENTMASH_HOME;
    else process.env.AGENTMASH_HOME = saved;
  }
});

test('the answers, word for word: {} after a tool, a note or {} before a model call, a refusal or ask before a tool, never allow', () => {
  assert.equal(dialect.name, 'antigravity');
  assert.equal(dialect.answer('post_edit', { action: 'advise', text: 'x' }).stdout, NOTHING, 'nothing but {} after a tool');
  assert.equal(dialect.answer('prompt', { action: 'advise', text: 'alice is here' }).stdout, '{"injectSteps":[{"ephemeralMessage":"alice is here"}]}\n');
  assert.equal(dialect.answer('prompt', { action: 'allow', text: null }).stdout, NOTHING);
  assert.equal(dialect.answer('stop', { action: 'advise', text: 'x' }).stdout, NOTHING, 'Stop has no way to tell the person: {} lets the agent finish');
  assert.equal(dialect.answer('pre_edit', { action: 'allow', files: [] }).stdout, ASK);
  for (const event of ['pre_edit', 'post_edit', 'prompt', 'session_start', 'session_end', 'stop']) {
    assert.doesNotMatch(dialect.neutral(event).stdout, /allow/, event);
    JSON.parse(dialect.neutral(event).stdout);
  }
  assert.deepEqual(dialect.tools.write, ['write_to_file']);
  assert.deepEqual(dialect.tools.edit, ['replace_file_content', 'multi_replace_file_content']);
});
