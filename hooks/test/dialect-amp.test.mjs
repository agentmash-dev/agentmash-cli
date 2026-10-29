// Amp: AgentMash's plugin in Amp (clients/amp/plugin.mjs) and the amp dialect
// the generic hook answers it in (dialects/amp.mjs). Amp runs no hook
// commands, so these tests stand in for Amp itself: a PluginAPI as far as the
// plugin uses it, whose events are Amp's own payloads (fixtures/amp, each
// recorded from Amp's published types and docs), and whose helpers answer as
// Amp's documented ones do. The plugin then runs the real generic hook against
// a room on a port of its own, in a home of its own.
//
// What is pinned: an edit Amp names is asked about, and the first try of a
// file a teammate is in is refused with the advice as the reason, once; a
// read asks nothing; reports reach the room as amp:<tool>; and every way of
// failing is allow, or nothing, in time, and never a result Amp would act on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ampDialect from '../dialects/amp.mjs';
import { HOOKS_DIR, baseEnv, eventsOf, machine, runHook, session, startServer, within } from './fixtures.mjs';
import agentEnd from './fixtures/amp/agent-end.mjs';
import agentStart from './fixtures/amp/agent-start.mjs';
import bashCall, { shell as bashShell } from './fixtures/amp/tool-call.Bash.mjs';
import createCall, { modifies as createModifies } from './fixtures/amp/tool-call.create_file.mjs';
import editCall, { modifies as editModifies } from './fixtures/amp/tool-call.edit_file.mjs';
import readCall, { modifies as readModifies } from './fixtures/amp/tool-call.read.mjs';
import resultOf from './fixtures/amp/tool-result.done.mjs';

const PLUGIN = path.join(HOOKS_DIR, '..', 'clients', 'amp', 'plugin.mjs');
const { agentmash, EVENTS, default: unconfigured } = await import(pathToFileURL(PLUGIN).href);
const ALLOW = { action: 'allow' };
const userTs = (m) => path.join(m.project, 'src', 'models', 'user.ts');

/**
 * Amp's PluginAPI, as far as the plugin uses it: the handlers it registers,
 * kept by event; the helpers answering, per toolUseID, what the fixtures say
 * Amp's own answer to; the settings configuration.get gives (null: no
 * configuration API at all); and what it notifies the person of.
 */
function fakeAmp({ modifies = {}, shells = {}, config = {}, workspaceRoot = null, throws = false } = {}) {
  const handlers = {};
  const notified = [];
  const disposers = [];
  const uri = (p) => ({ toString: () => pathToFileURL(p).href });
  const amp = {
    logger: { log() {} },
    on(event, handler) {
      handlers[event] = handler;
      return { unsubscribe() {} };
    },
    onDispose(callback) {
      disposers.push(callback);
      return { unsubscribe() {} };
    },
    configuration: config === null ? undefined : { get: async () => (config instanceof Error ? Promise.reject(config) : config) },
    helpers: {
      filesModifiedByToolCall(event) {
        if (throws) throw new Error('helper failed');
        const files = modifies[event.toolUseID];
        return files ? files.map(uri) : null;
      },
      filePathFromURI: (u) => fileURLToPath(u.toString()),
      shellCommandFromToolCall: (event) => shells[event.toolUseID] ?? null,
    },
    system: { workspaceRoot: workspaceRoot ? uri(workspaceRoot) : null },
    ui: {
      notify: async (message) => {
        notified.push(message);
      },
    },
  };
  return { amp, handlers, notified, disposers };
}

/** The context Amp passes beside an event: the thread, whose parent is `parent` (a subagent's thread has one). */
const ctxOf = (event, parent = null) => ({ thread: { id: event.thread.id, parentThreadID: async () => parent } });

/** The plugin, loaded into `fake` as Amp loads it, for the hooks in `hooksDir`, run in machine `m`'s home. */
async function load(fake, m, { hooksDir = HOOKS_DIR, env = {}, ...options } = {}) {
  await agentmash(hooksDir, { node: process.execPath, env: { ...baseEnv, ...m.env, ...env }, ...options })(fake.amp);
  return fake.handlers;
}

/** A hooks folder whose agent_hook.mjs is `script`: for a hook that hangs, crashes, or answers what it never should. */
function fakeHooks(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-amp-hooks-'));
  fs.writeFileSync(path.join(dir, 'agent_hook.mjs'), script);
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('before an edit Amp names, the room is asked; the first try is refused with the advice as its reason, and the same edit again goes through', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const call = editCall(m.project);
    const again = { ...call, toolUseID: 'toolu_01EditUserModelAgainAaa' };
    const fake = fakeAmp({ modifies: { [call.toolUseID]: editModifies(m.project), [again.toolUseID]: editModifies(m.project) } });
    const handlers = await load(fake, m);
    assert.deepEqual(Object.keys(handlers).sort(), [...EVENTS].sort());

    const first = await handlers['tool.call'](call, ctxOf(call));
    assert.deepEqual(Object.keys(first), ['action', 'message']);
    assert.equal(first.action, 'reject-and-continue', 'refused, and the agent goes on: never "error", which stops the thread');
    assert.match(first.message, /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts/);
    assert.match(first.message, /make the same edit again and it goes through\.$/);
    const checks = server.requests.filter((r) => r.path === '/check');
    assert.deepEqual(
      checks.map((c) => [c.query.file_path, c.user]),
      [['src/models/user.ts', 'amu_agentstokenagentstokenagent']]
    );

    assert.deepEqual(await handlers['tool.call'](again, ctxOf(again)), ALLOW, 'the same edit again');
  } finally {
    await server.close();
  }
});

test('a read, a search or a command that changes no file asks nothing, and is let through at once', async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const read = readCall(m.project);
    const grep = { ...read, toolUseID: 'toolu_01GrepForUsersDddddddd', tool: 'Grep', input: { pattern: 'User', path: m.project } };
    const ls = bashCall(m.project);
    const fake = fakeAmp({ modifies: { [read.toolUseID]: readModifies() }, shells: { [ls.toolUseID]: bashShell(m.project) } });
    const handlers = await load(fake, m);
    for (const call of [read, grep, ls]) {
      const started = Date.now();
      assert.deepEqual(await handlers['tool.call'](call, ctxOf(call)), ALLOW, call.tool);
      assert.ok(Date.now() - started < within(100), `${call.tool} waited ${Date.now() - started}ms`);
    }
    await sleep(300);
    assert.deepEqual(server.requests, [], 'nothing asked, nothing sent');
  } finally {
    await server.close();
  }
});

test("the amp dialect answers in Amp's own results: a refusal once, then allow; the heads-up hidden in the prompt; an overlap for the person", async () => {
  const server = await startServer();
  const m = machine(server.port);
  const args = (event) => [event, '--global', '--client', 'amp'];
  try {
    const s = session();
    const envelope = {
      amp: 1,
      hook: 'tool.call',
      thread: s,
      cwd: m.project,
      tool: 'edit_file',
      tool_use_id: 'toolu_x',
      input: { path: userTs(m), old_str: 'id: string', new_str: 'id: string;\n  role: string' },
      files: [userTs(m)],
    };
    const first = await runHook('agent_hook.mjs', envelope, m.env, args('pre_edit'));
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^\{"action":"reject-and-continue","message":"\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts[^\n]*"\}\n$/);
    const again = await runHook('agent_hook.mjs', envelope, m.env, args('pre_edit'));
    assert.deepEqual([again.code, again.stdout], [0, '{"action":"allow"}\n']);

    // a read, sent all the same, names no file and asks nothing
    const before = server.requests.filter((r) => r.path === '/check').length;
    const read = await runHook('agent_hook.mjs', { ...envelope, tool: 'read', files: [], input: { path: userTs(m) } }, m.env, args('pre_edit'));
    assert.deepEqual([read.code, read.stdout], [0, '{"action":"allow"}\n']);
    assert.equal(server.requests.filter((r) => r.path === '/check').length, before);

    // nothing to say at a prompt, or after a report: {}
    const prompt = await runHook('agent_hook.mjs', { amp: 1, hook: 'agent.start', thread: s, cwd: m.project, prompt: 'hello' }, m.env, args('prompt'));
    assert.deepEqual([prompt.code, prompt.stdout], [0, '{}\n']);
    const post = await runHook('agent_hook.mjs', { ...envelope, hook: 'tool.result' }, m.env, args('post_edit'));
    assert.deepEqual([post.code, post.stdout], [0, '{}\n']);

    // and what there is to say, in Amp's words
    assert.equal(ampDialect.answer('prompt', { text: 'bob is at work here' }).stdout, '{"message":{"content":"bob is at work here","display":false}}\n');
    assert.equal(ampDialect.answer('stop', { text: 'src/a.ts — also changed by alice' }).stdout, '{"notify":"src/a.ts — also changed by alice"}\n');
    assert.equal(ampDialect.answer('pre_edit', { action: 'allow', files: [] }).stdout, '{"action":"allow"}\n');
    assert.equal(ampDialect.neutral('pre_edit').stdout, '{"action":"allow"}\n');
    for (const event of ['prompt', 'post_edit', 'stop', 'session_end']) assert.equal(ampDialect.neutral(event).stdout, '{}\n', event);
  } finally {
    await server.close();
  }
});

test("the room's strict mode refuses an edit every time, until it is acknowledged, and never says allow for the person", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const call = editCall(m.project);
    const fake = fakeAmp({ modifies: { [call.toolUseID]: editModifies(m.project) } });
    const handlers = await load(fake, m, { env: { AGENTMASH_STRICT: '1' } });
    for (let i = 0; i < 2; i++) {
      const out = await handlers['tool.call'](call, ctxOf(call));
      assert.equal(out.action, 'reject-and-continue', `try ${i + 1}`);
      assert.match(out.message, /acknowledge this specific collision/);
    }
  } finally {
    await server.close();
  }
});

test('edits reach the room as amp:Edit and amp:Write with their line counts, and the prompt as amp, without holding Amp up', async () => {
  const server = await startServer({ eventsDelayMs: 600 });
  const m = machine(server.port);
  try {
    const edit = editCall(m.project);
    const create = createCall(m.project);
    const fake = fakeAmp({
      modifies: { [edit.toolUseID]: editModifies(m.project), [create.toolUseID]: createModifies(m.project) },
      workspaceRoot: m.project,
    });
    const handlers = await load(fake, m);

    const prompt = agentStart();
    assert.deepEqual(await handlers['agent.start'](prompt, ctxOf(prompt)), {}, 'nobody at work: nothing added to the prompt');
    for (const call of [edit, create]) {
      const started = Date.now();
      assert.equal(handlers['tool.result'](resultOf(call), ctxOf(call)), undefined, 'the result goes to the model as it was');
      assert.ok(Date.now() - started < within(100), `tool.result held Amp ${Date.now() - started}ms`);
    }
    // a failed call is no edit
    handlers['tool.result'](resultOf(edit, 'error'), ctxOf(edit));

    const events = (await eventsOf(server, 3, 6000)).map((r) => r.body);
    const asked = events.find((e) => e.event_type === 'prompt');
    assert.deepEqual([asked.tool, asked.task_hint, asked.session_id], ['amp', 'give the user a role', prompt.thread.id]);
    const edits = events.filter((e) => e.event_type === 'edit').map((e) => [e.tool, e.file_path, e.change_summary, e.session_id]);
    assert.deepEqual(edits.sort(), [
      ['amp:Edit', 'src/models/user.ts', '+2/-1 lines', edit.thread.id],
      ['amp:Write', 'src/new.ts', 'wrote 2 lines, defining b', create.thread.id],
    ]);
    await sleep(500);
    assert.equal(server.requests.filter((r) => r.path === '/events').length, 3, 'the failed call reported nothing');
  } finally {
    await server.close();
  }
});

test("what a shell command changed is reported as amp:Bash, from the working tree, as Claude Code's Bash is", async () => {
  const server = await startServer();
  const m = machine(server.port);
  // a real checkout of acme/app: `git status` is what the hooks read
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-amp-repo-')));
  const gitconfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-amp-git-')), 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  const gitEnv = { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => execFileSync('git', a, { cwd: repo, env: { ...baseEnv, ...gitEnv }, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'bob@example.com');
  git('config', 'user.name', 'bob');
  git('remote', 'add', 'origin', 'git@github.com:acme/app.git');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  try {
    const call = bashCall(repo, "sed -i '' 's/1/2/' src/a.ts");
    const fake = fakeAmp({ shells: { [call.toolUseID]: bashShell(repo, "sed -i '' 's/1/2/' src/a.ts") } });
    const handlers = await load(fake, m, { env: gitEnv });
    // the session's first look at its working tree, as its prompt takes it
    const first = await runHook('user_prompt_submit.mjs', { session_id: call.thread.id, cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: 'bump a' }, { ...m.env, ...gitEnv }, [
      '--global',
      '--client',
      'amp',
    ]);
    assert.equal(first.code, 0, first.stderr);
    // what the command did, a moment after that look
    fs.appendFileSync(path.join(repo, 'src', 'a.ts'), '// bumped\n');
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(repo, 'src', 'a.ts'), later, later);

    assert.equal(handlers['tool.result'](resultOf(call), ctxOf(call)), undefined);
    const edits = (await eventsOf(server, 2, 6000)).map((r) => r.body).filter((e) => e.event_type === 'edit');
    assert.deepEqual(
      edits.map((e) => [e.tool, e.file_path, e.change_summary, e.task_hint]),
      [['amp:Bash', 'src/a.ts', 'changed by a Bash command', 'bump a']]
    );
  } finally {
    await server.close();
  }
});

test("a subagent's prompt is not the person's: it is not reported, and nothing is added to it", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    const fake = fakeAmp({ workspaceRoot: m.project });
    const handlers = await load(fake, m);
    const sub = agentStart('find every use of User', 'T-0c0ffee0-0000-4000-8000-000000000001');
    assert.deepEqual(await handlers['agent.start'](sub, ctxOf(sub, 'T-f9941a55-3765-421e-972f-05dc1138c3a3')), {});
    await sleep(600);
    assert.deepEqual(server.requests, []);
  } finally {
    await server.close();
  }
});

test("a turn's end says an overlap to the person without holding Amp up, and unloading ends the threads it saw", async () => {
  const server = await startServer();
  const m = machine(server.port);
  try {
    // the stop hook's answer, as the dialect gives it for an overlap
    const said = fakeHooks(
      "import fs from 'node:fs';\n" +
        'if (process.argv[2] === "stop") process.stdout.write(\'{"notify":"src/models/user.ts — also changed by alice"}\\n\');\n' +
        'else { const real = process.env.REAL_HOOK; const { spawnSync } = await import("node:child_process"); ' +
        'const r = spawnSync(process.execPath, [real, ...process.argv.slice(2)], { input: fs.readFileSync(0), env: process.env }); process.stdout.write(r.stdout); }\n'
    );
    const edit = editCall(m.project);
    const fake = fakeAmp({ modifies: { [edit.toolUseID]: editModifies(m.project) }, workspaceRoot: m.project });
    const handlers = await load(fake, m, { hooksDir: said, env: { REAL_HOOK: path.join(HOOKS_DIR, 'agent_hook.mjs') } });
    await handlers['agent.start'](agentStart(), ctxOf(edit));

    const started = Date.now();
    assert.equal(handlers['agent.end'](agentEnd(), ctxOf(edit)), undefined, 'never a "continue"');
    assert.ok(Date.now() - started < within(100));
    handlers['agent.end'](agentEnd('cancelled'), ctxOf(edit));
    for (let i = 0; i < 40 && fake.notified.length === 0; i++) await sleep(50);
    assert.deepEqual(fake.notified, ['src/models/user.ts — also changed by alice'], 'once: a cancelled turn says nothing');

    await Promise.all(fake.disposers.map((dispose) => dispose()));
    const ended = (await eventsOf(server, 2, 6000)).map((r) => r.body).find((e) => e.event_type === 'session_end');
    assert.deepEqual([ended?.tool, ended?.end_reason, ended?.session_id], ['amp', 'exit', edit.thread.id]);
  } finally {
    await server.close();
  }
});

test('with Amp\'s old permission rules on, or no way to tell, the plugin answers no tool call: it only reports', async () => {
  const m = machine(1);
  const cases = [
    [{ permissions: [{ tool: 'Bash', action: 'ask' }] }, false],
    [{ 'amp.permissions': [] }, false],
    [{ dangerouslyAllowAll: false }, false],
    [{ 'guardedFiles.allowlist': ['*.env'] }, false],
    [null, false],
    [new Error('no settings'), false],
    [{ 'notifications.enabled': true, dangerouslyAllowAll: true }, true],
  ];
  for (const [config, answers] of cases) {
    const fake = fakeAmp({ config });
    const handlers = await load(fake, m);
    assert.equal('tool.call' in handlers, answers, config instanceof Error || config === null ? String(config) : JSON.stringify(config));
    assert.equal(typeof handlers['tool.result'], 'function', 'and reports all the same');
  }
});

test('the plugin as it ships names no hooks folder, and does nothing until login writes one in', async () => {
  const fake = fakeAmp();
  await unconfigured(fake.amp);
  assert.deepEqual(fake.handlers, {});
});

test('a room that is down, a hook that is missing, hangs or crashes, and a helper that throws: allow, or nothing, in time', async () => {
  const down = await startServer();
  const m = machine(down.port);
  await down.close();
  const edit = editCall(m.project);
  const read = readCall(m.project);
  const modifies = { [edit.toolUseID]: editModifies(m.project) };

  // the room down: the hook's own neutral answer
  let handlers = await load(fakeAmp({ modifies, workspaceRoot: m.project }), m);
  let started = Date.now();
  assert.deepEqual(await handlers['tool.call'](edit, ctxOf(edit)), ALLOW);
  assert.ok(Date.now() - started < within(2000), `${Date.now() - started}ms`);
  assert.deepEqual(await handlers['agent.start'](agentStart(), ctxOf(edit)), {});

  // no hooks folder, or no node to run it with
  for (const options of [{ hooksDir: path.join(os.tmpdir(), 'agentmash-nowhere', '.agentmash', 'hooks') }, { node: path.join(os.tmpdir(), 'agentmash-no-node') }]) {
    handlers = await load(fakeAmp({ modifies, workspaceRoot: m.project }), m, options);
    assert.deepEqual(await handlers['tool.call'](edit, ctxOf(edit)), ALLOW, JSON.stringify(options));
    assert.equal(handlers['tool.result'](resultOf(edit), ctxOf(edit)), undefined);
    assert.deepEqual(await handlers['agent.start'](agentStart(), ctxOf(edit)), {});
    assert.equal(handlers['agent.end'](agentEnd(), ctxOf(edit)), undefined);
  }

  // a hook that never ends: the plugin's own time, then allow
  const hung = fakeHooks('setInterval(() => {}, 1000);\n');
  handlers = await load(fakeAmp({ modifies, workspaceRoot: m.project }), m, { hooksDir: hung, waitMs: { pre_edit: 300, prompt: 300, stop: 300 } });
  started = Date.now();
  assert.deepEqual(await handlers['tool.call'](edit, ctxOf(edit)), ALLOW);
  assert.deepEqual(await handlers['agent.start'](agentStart(), ctxOf(edit)), {});
  assert.ok(Date.now() - started < within(300 + 300 + 300 + 600), `${Date.now() - started}ms`);

  // Amp's helper throwing: a read is still let through, with nothing asked
  handlers = await load(fakeAmp({ throws: true }), m);
  assert.deepEqual(await handlers['tool.call'](read, ctxOf(read)), ALLOW);
  assert.equal(handlers['tool.result'](resultOf(read), ctxOf(read)), undefined);

  // garbage in: the dialect's neutral answer, and exit 0
  const odd = JSON.stringify({ amp: 1, thread: 7, cwd: m.project, files: 'src/a.ts', input: [] });
  for (const [event, neutral] of [['pre_edit', '{"action":"allow"}\n'], ['prompt', '{}\n'], ['stop', '{}\n']]) {
    for (const payload of ['not json at all', '[1,2]', '', odd]) {
      const out = await runHook('agent_hook.mjs', payload, m.env, [event, '--global', '--client', 'amp']);
      assert.deepEqual([out.code, out.stdout, out.stderr], [0, neutral, ''], `${event} ${payload}`);
    }
  }
});

test('a hook answering anything but a refusal or a prompt\'s note gets allow, or nothing: never an error, a changed call or a made-up result', async () => {
  const m = machine(1);
  const edit = editCall(m.project);
  const answers = [
    '{"action":"error","message":"stop the thread"}',
    '{"action":"modify","input":{"path":"/etc/passwd"}}',
    '{"action":"synthesize","result":{"output":"done"}}',
    '{"action":"reject-and-continue"}',
    '{"action":"reject-and-continue","message":"   "}',
    '{"message":{"content":5}}',
    '{"message":"a string"}',
    'not json',
    '',
  ];
  for (const answer of answers) {
    const dir = fakeHooks(`process.stdout.write(${JSON.stringify(answer)});\n`);
    const handlers = await load(fakeAmp({ modifies: { [edit.toolUseID]: editModifies(m.project) }, workspaceRoot: m.project }), m, { hooksDir: dir });
    assert.deepEqual(await handlers['tool.call'](edit, ctxOf(edit)), ALLOW, answer);
    assert.deepEqual(await handlers['agent.start'](agentStart(), ctxOf(edit)), {}, answer);
  }
  const crash = fakeHooks('process.exit(3);\n');
  const handlers = await load(fakeAmp({ modifies: { [edit.toolUseID]: editModifies(m.project) }, workspaceRoot: m.project }), m, { hooksDir: crash });
  assert.deepEqual(await handlers['tool.call'](edit, ctxOf(edit)), ALLOW);
});
