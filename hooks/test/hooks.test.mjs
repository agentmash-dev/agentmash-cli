import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timed, within } from './fixtures.mjs';
import {
  ACK_PLACEHOLDER,
  ackFile,
  ackGrounding,
  ackToken,
  buildCollisionAdvice,
  buildReconciliationBrief,
  buildStrictBlock,
  checkoutId,
  composeSummary,
  CREW_AGENTS,
  crewAgentOf,
  holderFacts,
  noteTouched,
  promptForEdit,
  readPrompt,
  readSessionCache,
  resolveAck,
  writeSessionCache,
} from '../lib.mjs';

const HOOKS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The launcher starts a server on stdin the moment it is loaded, which is not
// something a test process can host. This is the one way in to the pieces that
// cannot be run here: the Windows spawn, on a machine that is not Windows.
process.env.AGENTMASH_MCP_IMPORT_ONLY = '1';
const { npxInvocation, isJsonRpcLine } = await import(
  pathToFileURL(path.join(HOOKS_DIR, 'mcp_launcher.mjs')).href
);
const ROOM = 'mash_testroomtestroomtes';

// Strip any real AgentMash config so tests are hermetic. The hooks keep a log
// of reports that never arrived under AGENTMASH_HOME (or the home directory),
// so they get a home of their own too: a test with the server down must not
// write into the developer's real ~/.agentmash.
const baseEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTMASH_') && k !== 'CLAUDE_PROJECT_DIR')
  ),
  AGENTMASH_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-hooks-home-')),
};

let sessionCounter = 0;
function freshSession() {
  sessionCounter += 1;
  return `hooktest-${process.pid}-${Date.now()}-${sessionCounter}`;
}

function makeProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-hooks-test-'));
}

/** Spawn a hook script exactly like Claude Code would: JSON on stdin, env, collect stdio. */
function runHook(script, stdinPayload, env = {}, args = []) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, [path.join(HOOKS_DIR, script), ...args], {
      env: { ...baseEnv, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, elapsed: Date.now() - start }));
    child.stdin.write(typeof stdinPayload === 'string' ? stdinPayload : JSON.stringify(stdinPayload));
    child.stdin.end();
  });
}

function startMockServer({
  delayMs = 0,
  status = 200,
  checkResponse = null,
  collisionsResponse = null,
  eventsResponse = null,
} = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        room: req.headers['x-agentmash-room'],
        token: req.headers['x-agentmash-token'],
        body: body ? JSON.parse(body) : null,
      });
      const respond = () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        if (url.pathname === '/check') {
          res.end(JSON.stringify(checkResponse ?? { conflict: false, holders: [] }));
        } else if (url.pathname === '/collisions') {
          res.end(JSON.stringify(collisionsResponse ?? { reconcile_mode: 'approve', collisions: [] }));
        } else {
          res.end(JSON.stringify(eventsResponse ?? { ok: true }));
        }
      };
      if (delayMs > 0) setTimeout(respond, delayMs);
      else respond();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function editStdin(projectDir, sessionId, relFile = path.join('src', 'models', 'user.ts')) {
  return {
    session_id: sessionId,
    cwd: projectDir,
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(projectDir, relFile), old_string: 'a', new_string: 'b' },
  };
}

function hookEnv(projectDir, port, extra = {}) {
  return {
    CLAUDE_PROJECT_DIR: projectDir,
    AGENTMASH_URL: `http://127.0.0.1:${port}`,
    AGENTMASH_ROOM: ROOM,
    AGENTMASH_DEV: 'bob',
    ...extra,
  };
}

/**
 * The id a hook run with baseEnv gives the checkout at `dir`: made with the
 * key under baseEnv's AGENTMASH_HOME, which is where the hooks under test keep
 * theirs. (lib.mjs remembers the key once read, so this home is the one.)
 */
function ownCheckoutId(dir) {
  const before = process.env.AGENTMASH_HOME;
  process.env.AGENTMASH_HOME = baseEnv.AGENTMASH_HOME;
  try {
    return checkoutId(dir);
  } finally {
    if (before === undefined) delete process.env.AGENTMASH_HOME;
    else process.env.AGENTMASH_HOME = before;
  }
}

const conflictCheckResponse = {
  conflict: true,
  holders: [
    {
      developer: 'alice',
      task_hint: 'refactor the user model',
      last_touched: new Date(Date.now() - 4 * 60_000).toISOString(),
      minutes_ago: 4,
      branch: 'feat/user-model',
      file_path: 'src/models/user.ts',
    },
  ],
  window_minutes: 30,
  scope: 'file',
};

// ---------------------------------------------------------------------------
// Server up
// ---------------------------------------------------------------------------

test('post_tool_use reports an edit event, silently', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    const result = await runHook(
      'post_tool_use.mjs',
      { ...editStdin(projectDir, freshSession()), hook_event_name: 'PostToolUse' },
      hookEnv(projectDir, mock.port)
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');

    assert.equal(mock.requests.length, 1);
    const req = mock.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/events');
    assert.equal(req.room, ROOM);
    assert.equal(req.body.developer, 'bob');
    assert.equal(req.body.event_type, 'edit');
    assert.equal(req.body.tool, 'Edit');
    assert.equal(req.body.file_path, 'src/models/user.ts'); // repo-relative, forward slashes
    assert.ok(req.body.timestamp);
  } finally {
    await mock.close();
  }
});

test('user_prompt_submit caches the task hint and post_tool_use attaches it', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  try {
    const promptResult = await runHook(
      'user_prompt_submit.mjs',
      {
        session_id: sessionId,
        cwd: projectDir,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Refactor the user model to support soft deletes',
      },
      hookEnv(projectDir, mock.port, { AGENTMASH_DEV: 'alice' })
    );
    // The report runs in the background, where what it printed would reach
    // the agent a turn late: it prints nothing. The heads-up is prompt_note's.
    assert.equal(promptResult.code, 0);
    assert.equal(promptResult.stdout, '');
    assert.equal(promptResult.stderr, '');

    const editResult = await runHook(
      'post_tool_use.mjs',
      { ...editStdin(projectDir, sessionId), hook_event_name: 'PostToolUse' },
      hookEnv(projectDir, mock.port, { AGENTMASH_DEV: 'alice' })
    );
    assert.equal(editResult.code, 0);

    const reported = mock.requests.filter((r) => r.path === '/events');
    assert.equal(reported.length, 2);
    assert.equal(mock.requests.length, 2, 'and nothing else: the report asks after nobody');
    const [promptEvent, editEvent] = reported.map((r) => r.body);
    assert.equal(promptEvent.event_type, 'prompt');
    assert.equal(promptEvent.task_hint, 'Refactor the user model to support soft deletes');
    assert.equal(editEvent.event_type, 'edit');
    assert.equal(editEvent.task_hint, 'Refactor the user model to support soft deletes');
  } finally {
    await mock.close();
  }
});

test('pre_tool_use emits advisory additionalContext on conflict', async () => {
  const mock = await startMockServer({ checkResponse: conflictCheckResponse });
  const projectDir = makeProjectDir();
  try {
    const result = await runHook('pre_tool_use.mjs', editStdin(projectDir, freshSession()), hookEnv(projectDir, mock.port));
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');

    const out = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, 'PreToolUse');
    assert.equal(out.permissionDecision, undefined, 'advisory mode must not touch the permission flow');
    assert.match(
      out.additionalContext,
      /^\[AgentMash: ACTIVE COLLISION\] alice's agent is working in src\/models\/user\.ts — last write 4 min ago/
    );
    assert.match(out.additionalContext, /'refactor the user model'/);
    assert.match(out.additionalContext, /on branch feat\/user-model/);

    const req = mock.requests[0];
    assert.equal(req.path, '/check');
    assert.equal(req.query.file_path, 'src/models/user.ts');
    assert.equal(req.query.developer, 'bob');
    assert.equal(req.room, ROOM);
  } finally {
    await mock.close();
  }
});

test('the changed text crosses the wire only when the room asked and this developer allows it', async () => {
  const projectDir = makeProjectDir();
  const edit = (sessionId) => ({
    session_id: sessionId,
    cwd: projectDir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: {
      file_path: path.join(projectDir, 'src', 'models', 'user.ts'),
      old_string: 'interface User {}',
      new_string: 'interface User { deletedAt: Date | null }',
    },
  });

  // The same call, before it: Claude Code hands both hooks the same tool_input.
  const before = (sessionId) => ({ ...edit(sessionId), hook_event_name: 'PreToolUse' });

  // A room that streams: PreToolUse hears it on /check and keeps it for this
  // edit's PostToolUse, which has no answer of its own to read.
  const streaming = await startMockServer({ checkResponse: { conflict: false, holders: [], stream_diffs: true } });
  try {
    const session = freshSession();
    await runHook('pre_tool_use.mjs', before(session), hookEnv(projectDir, streaming.port));
    await runHook('post_tool_use.mjs', edit(session), hookEnv(projectDir, streaming.port));
    const posted = streaming.requests.find((r) => r.path === '/events');
    assert.deepEqual(posted.body.diff, {
      before: 'interface User {}',
      after: 'interface User { deletedAt: Date | null }',
      truncated: false,
      edits: 1,
    });

    // A session that never asked /check (or an older server) sends nothing.
    await runHook('post_tool_use.mjs', edit(freshSession()), hookEnv(projectDir, streaming.port));
    assert.equal(streaming.requests.filter((r) => r.path === '/events')[1].body.diff, undefined);

    // The developer's own switch wins over the room's.
    const quiet = freshSession();
    await runHook('pre_tool_use.mjs', before(quiet), hookEnv(projectDir, streaming.port, { AGENTMASH_DIFFS: '0' }));
    await runHook('post_tool_use.mjs', edit(quiet), hookEnv(projectDir, streaming.port, { AGENTMASH_DIFFS: '0' }));
    assert.equal(streaming.requests.filter((r) => r.path === '/events')[2].body.diff, undefined);
  } finally {
    await streaming.close();
  }

  // A room that does not stream: the answer is remembered as "no".
  const plain = await startMockServer({ checkResponse: { conflict: false, holders: [], stream_diffs: false } });
  try {
    const session = freshSession();
    await runHook('pre_tool_use.mjs', before(session), hookEnv(projectDir, plain.port));
    await runHook('post_tool_use.mjs', edit(session), hookEnv(projectDir, plain.port));
    assert.equal(plain.requests.find((r) => r.path === '/events').body.diff, undefined);
  } finally {
    await plain.close();
  }
});

// The room's answer about diffs is good for the edit it was given before, and
// no other. A room that turns streaming off is obeyed from the next edit on,
// one inside a file's cooldown included, and an edit whose /check does not
// answer in time sends no text, whatever an earlier edit was told. While the
// room streams, no edit's text is lost either: Claude Code runs one edit's
// PostToolUse alongside the next edit's PreToolUse.
function diffEdit(projectDir, sessionId, rel, n) {
  const tool_input = { file_path: path.join(projectDir, ...rel.split('/')), old_string: `apiKey: 'v${n}'`, new_string: `apiKey: 'v${n + 1}'` };
  return {
    pre: { session_id: sessionId, cwd: projectDir, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input },
    post: { session_id: sessionId, cwd: projectDir, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input },
  };
}
const lastDiff = (mock) => mock.requests.filter((r) => r.path === '/events').at(-1).body.diff;

test("no diff leaves the machine once the room stops streaming, inside a file's cooldown too", async () => {
  const projectDir = makeProjectDir();
  // alice is in the file, so the first edit is advised and its cooldown starts
  const answer = { ...conflictCheckResponse, stream_diffs: true };
  const room = await startMockServer({ checkResponse: answer });
  try {
    const session = freshSession();
    const env = hookEnv(projectDir, room.port);
    const edit = async (n) => {
      const call = diffEdit(projectDir, session, 'src/models/user.ts', n);
      const pre = await runHook('pre_tool_use.mjs', call.pre, env);
      await runHook('post_tool_use.mjs', call.post, env);
      return pre.stdout;
    };
    assert.match(await edit(1), /alice's agent/);
    assert.equal(lastDiff(room).after, "apiKey: 'v2'");
    assert.equal(await edit(2), '', 'inside the minute nothing more is said');
    assert.equal(lastDiff(room).after, "apiKey: 'v3'", 'and a room that streams still gets the text');

    // `agentmash diffs off`, then the same file again, inside the minute
    answer.stream_diffs = false;
    await edit(3);
    assert.equal(lastDiff(room), undefined, 'the room said off: the text stays home');
  } finally {
    await room.close();
  }
});

test('no diff leaves the machine when the room does not answer /check in time', async () => {
  const projectDir = makeProjectDir();
  // a room that streams, then a /check that answers after the budget
  const streaming = await startMockServer({ checkResponse: { conflict: false, holders: [], stream_diffs: true } });
  const slow = await startMockServer({ delayMs: 800, checkResponse: { conflict: false, holders: [], stream_diffs: false } });
  try {
    const session = freshSession();
    const first = diffEdit(projectDir, session, 'src/config.ts', 1);
    await runHook('pre_tool_use.mjs', first.pre, hookEnv(projectDir, streaming.port));
    await runHook('post_tool_use.mjs', first.post, hookEnv(projectDir, streaming.port));
    assert.equal(lastDiff(streaming).after, "apiKey: 'v2'");

    const env = hookEnv(projectDir, slow.port, { AGENTMASH_TIMEOUT_MS: '300' });
    const second = diffEdit(projectDir, session, 'src/config.ts', 2);
    await runHook('pre_tool_use.mjs', second.pre, env);
    await runHook('post_tool_use.mjs', second.post, env);
    assert.equal(slow.requests.filter((r) => r.path === '/check').length, 1, 'the room was asked');
    assert.equal(lastDiff(slow), undefined, 'and gave no answer in time: the text stays home');
  } finally {
    await streaming.close();
    await slow.close();
  }
});

test("an edit's text still goes when the next edit's PreToolUse runs beside its PostToolUse, and not once the room says off", async () => {
  const projectDir = makeProjectDir();
  const answer = { conflict: false, holders: [], stream_diffs: true };
  const room = await startMockServer({ checkResponse: answer });
  try {
    const session = freshSession();
    const env = hookEnv(projectDir, room.port);
    for (let n = 1; n <= 10; n++) {
      // the next edit is to another file, or to the same one, as an agent's often is
      const a = diffEdit(projectDir, session, 'src/a.ts', n * 10);
      const b = diffEdit(projectDir, session, n % 2 ? 'src/b.ts' : 'src/a.ts', n * 10 + 5);
      await runHook('pre_tool_use.mjs', a.pre, env);
      await Promise.all([runHook('post_tool_use.mjs', a.post, env), runHook('pre_tool_use.mjs', b.pre, env)]);
      await runHook('post_tool_use.mjs', b.post, env);
    }
    const sent = room.requests.filter((r) => r.path === '/events').map((r) => `${r.body.file_path} ${r.body.diff?.after ?? 'no text'}`);
    const expected = [];
    for (let n = 1; n <= 10; n++) expected.push(`src/a.ts apiKey: 'v${n * 10 + 1}'`, `${n % 2 ? 'src/b.ts' : 'src/a.ts'} apiKey: 'v${n * 10 + 6}'`);
    assert.deepEqual(sent.sort(), expected.sort(), 'every edit carried its text while the room streamed');

    // an edit told yes, then the room turns streaming off before its PostToolUse:
    // the next edit's answer of no is the room's word for it too
    const a = diffEdit(projectDir, session, 'src/a.ts', 100);
    const b = diffEdit(projectDir, session, 'src/b.ts', 200);
    await runHook('pre_tool_use.mjs', a.pre, env);
    answer.stream_diffs = false;
    await runHook('pre_tool_use.mjs', b.pre, env);
    await runHook('post_tool_use.mjs', a.post, env);
    assert.equal(lastDiff(room), undefined, 'the room said off before it went');
  } finally {
    await room.close();
  }
});

test('a diff is clipped before it leaves the machine', async () => {
  const { diffForEdit, DIFF_CHARS } = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);
  const big = 'x'.repeat(DIFF_CHARS + 500);
  const clipped = diffForEdit('Write', { file_path: 'a.ts', content: big });
  assert.equal(clipped.before, null);
  assert.equal(clipped.after.length, DIFF_CHARS);
  assert.equal(clipped.truncated, true);

  const multi = diffForEdit('MultiEdit', {
    file_path: 'a.ts',
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c', new_string: 'd' },
    ],
  });
  assert.deepEqual(multi, { before: 'a', after: 'b', truncated: true, edits: 2 });
  assert.equal(diffForEdit('Edit', { file_path: 'a.ts' }), null, 'nothing textual, nothing sent');
  assert.equal(diffForEdit('Edit', null), null);
});

test('post_tool_use summarizes what the edit changed', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    await runHook(
      'post_tool_use.mjs',
      {
        session_id: freshSession(),
        cwd: projectDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(projectDir, 'src', 'models', 'user.ts'),
          old_string: 'interface User {\n  id: string;\n}',
          new_string: 'interface User {\n  id: string;\n  deletedAt: Date | null;\n}\nconst SOFT_DELETE = true;',
        },
      },
      hookEnv(projectDir, mock.port)
    );
    const summary = mock.requests[0].body.change_summary;
    assert.match(summary, /^\+5\/-3 lines/, `unexpected summary: ${summary}`);
    assert.match(summary, /touching SOFT_DELETE/, 'new declarations should be named');
    assert.ok(!/touching.*\bUser\b/.test(summary), 'User existed before the edit, so it is not new');

    await runHook(
      'post_tool_use.mjs',
      {
        session_id: freshSession(),
        cwd: projectDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: path.join(projectDir, 'a.ts'), content: 'export function greet() {}\n' },
      },
      hookEnv(projectDir, mock.port)
    );
    assert.match(mock.requests[1].body.change_summary, /^wrote 2 lines, defining greet$/);
  } finally {
    await mock.close();
  }
});

test('session_end reports the session as over, silently', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    const result = await runHook(
      'session_end.mjs',
      { session_id: 'sess-x', cwd: projectDir, hook_event_name: 'SessionEnd', reason: 'exit' },
      hookEnv(projectDir, mock.port, { AGENTMASH_DEV: 'alice' })
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].body.event_type, 'session_end');
    assert.equal(mock.requests[0].body.developer, 'alice');
  } finally {
    await mock.close();
  }
});

test('session_end fails open when the server is down', async () => {
  const mock = await startMockServer();
  const deadPort = mock.port;
  await mock.close();
  const projectDir = makeProjectDir();
  const result = await runHook(
    'session_end.mjs',
    { session_id: 'sess-x', cwd: projectDir, hook_event_name: 'SessionEnd' },
    hookEnv(projectDir, deadPort)
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.ok(result.elapsed < within(1500), `session_end took ${result.elapsed}ms — it shares a short budget`);
});

test('advisory names the change and distinguishes same-branch from cross-branch', async () => {
  const projectDir = makeProjectDir();
  // a real branch to compare against: .git/HEAD is all the hook reads
  fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  const sameBranch = await startMockServer({
    checkResponse: {
      conflict: true,
      holders: [
        {
          developer: 'alice',
          task_hint: 'soft deletes',
          minutes_ago: 3,
          branch: 'main',
          file_path: 'src/models/user.ts',
          change_summary: '+12/-3 lines, touching deletedAt',
          // made in this very checkout (alice at bob's keyboard, say)
          checkout_id: ownCheckoutId(projectDir),
        },
      ],
    },
  });
  try {
    const result = await runHook('pre_tool_use.mjs', editStdin(projectDir, freshSession()), hookEnv(projectDir, sameBranch.port));
    const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(text, /on your branch \(main\)/);
    assert.match(text, /\(\+12\/-3 lines, touching deletedAt\)/);
    assert.match(text, /Leave deletedAt named and shaped as alice left it/);
    assert.match(text, /Re-read src\/models\/user\.ts now/);
  } finally {
    await sameBranch.close();
  }

  const otherBranch = await startMockServer({
    checkResponse: {
      conflict: true,
      holders: [
        { developer: 'alice', task_hint: 'soft deletes', minutes_ago: 3, branch: 'feat/soft-delete', file_path: 'src/models/user.ts' },
      ],
    },
  });
  try {
    const result = await runHook('pre_tool_use.mjs', editStdin(projectDir, freshSession()), hookEnv(projectDir, otherBranch.port));
    const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(text, /on branch feat\/soft-delete \(you are on main\)/);
    assert.match(text, /isn't in your working tree/);
  } finally {
    await otherBranch.close();
  }
});

test('an edit says which checkout it was made in, by an id that names neither the machine nor the folder', async () => {
  const mock = await startMockServer();
  const first = makeProjectDir();
  const second = makeProjectDir();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-hooks-other-machine-'));
  try {
    const post = (dir, env = {}) =>
      runHook('post_tool_use.mjs', { ...editStdin(dir, freshSession()), hook_event_name: 'PostToolUse' }, hookEnv(dir, mock.port, env));
    await post(first);
    await post(first); // another session in the same checkout
    await post(second); // a checkout of its own
    await post(first, { AGENTMASH_HOME: elsewhere }); // the same folder on a machine with another key
    const ids = mock.requests.filter((r) => r.path === '/events').map((r) => r.body.checkout_id);
    assert.equal(ids.length, 4);
    for (const id of ids) assert.match(id, /^co_[A-Za-z0-9_-]{22}$/);
    assert.equal(ids[0], ids[1], 'one checkout, one id, whichever session');
    assert.notEqual(ids[0], ids[2], 'two checkouts, two ids');
    assert.notEqual(ids[0], ids[3], 'keyed per machine: a guess at the folder cannot be checked against it');
    assert.equal(ids[0], ownCheckoutId(first));
    // nothing in it is the folder, the machine or the person
    for (const id of ids) {
      for (const part of [path.basename(first), path.basename(second), os.hostname(), os.userInfo().username]) {
        assert.ok(!id.toLowerCase().includes(part.toLowerCase().slice(0, 6)), `${id} carries ${part}`);
      }
    }
    // the key stays on the machine, readable by its owner only
    const keyFile = path.join(baseEnv.AGENTMASH_HOME, '.agentmash', 'checkout-key');
    assert.match(fs.readFileSync(keyFile, 'utf8'), /^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o077, 0);
    for (const r of mock.requests) assert.ok(!JSON.stringify(r).includes(fs.readFileSync(keyFile, 'utf8')), 'the key is never sent');

    // a home it cannot write to: no id, and the edit is reported all the same
    const blocked = path.join(elsewhere, 'not-a-folder');
    fs.writeFileSync(blocked, '');
    await post(first, { AGENTMASH_HOME: blocked });
    const last = mock.requests.filter((r) => r.path === '/events').at(-1).body;
    assert.equal(last.file_path, 'src/models/user.ts');
    assert.equal(last.checkout_id, null);
  } finally {
    await mock.close();
  }
});

test("pre_tool_use tells its own checkout from a teammate's clone on a branch of the same name", async () => {
  // The e2e run that found this: alice and bob each in a clone of their own,
  // both on main. Bob was told alice's write was already in his working tree.
  const projectDir = makeProjectDir();
  fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const alice = { developer: 'alice', task_hint: 'soft deletes', minutes_ago: 1, branch: 'main', file_path: 'src/models/user.ts' };
  const answers = [
    ['her own clone', { ...alice, checkout_id: 'co_alicesOwnCloneOfTheRepo' }, /^\[AgentMash: PARALLEL EDIT\] .* on main, as you are, in a checkout of their own/, /already in your working tree|Re-read/],
    ['this checkout', { ...alice, checkout_id: ownCheckoutId(projectDir) }, /on your branch \(main\)[\s\S]*Their write is already in your working tree/, /in a checkout of their own/],
    ['an older server, which cannot say', alice, /If you share their checkout, their write is already in your working tree/, /Their write is already in your working tree/],
  ];
  for (const [label, holder, said, unsaid] of answers) {
    const mock = await startMockServer({ checkResponse: { conflict: true, holders: [holder] } });
    try {
      const result = await runHook('pre_tool_use.mjs', editStdin(projectDir, freshSession()), hookEnv(projectDir, mock.port));
      const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
      assert.match(text, said, label);
      assert.doesNotMatch(text, unsaid, label);
    } finally {
      await mock.close();
    }
  }
});

test("pre_tool_use relays a teammate's claim on the file, before any edit exists", async () => {
  const now = Date.now();
  const claimed = {
    conflict: false,
    holders: [],
    claimed: true,
    claims: [
      {
        id: 'claim_test0000000',
        developer: 'alice',
        session_id: 'sess-alice',
        task: 'rewrite the auth flow',
        paths: ['src/models'],
        symbols: [],
        created_ts: now - 3 * 60_000,
        expires_ts: now + 117 * 60_000,
        created_at: new Date(now - 3 * 60_000).toISOString(),
        expires_at: new Date(now + 117 * 60_000).toISOString(),
        overlap: { paths: ['src/models'], symbols: [] },
      },
    ],
  };
  const mock = await startMockServer({ checkResponse: claimed });
  const projectDir = makeProjectDir();
  try {
    const result = await runHook('pre_tool_use.mjs', editStdin(projectDir, freshSession()), hookEnv(projectDir, mock.port));
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, 'PreToolUse');
    assert.equal(out.permissionDecision, undefined, 'a claim is advisory');
    assert.match(out.additionalContext, /^\[AgentMash: CLAIMED\] alice's agent has claimed src\/models\/ — which includes src\/models\/user\.ts/);
    assert.match(out.additionalContext, /for 'rewrite the auth flow'/);
    assert.match(out.additionalContext, /claimed 3 min ago, 117 min left/);
    assert.match(out.additionalContext, /may not have written to it yet/);

    // Strict mode blocks on writes that happened; intent alone still only advises.
    const strict = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, freshSession()),
      hookEnv(projectDir, mock.port, { AGENTMASH_STRICT: '1' })
    );
    const strictOut = JSON.parse(strict.stdout).hookSpecificOutput;
    assert.equal(strictOut.permissionDecision, undefined, 'strict mode must not deny on a claim alone');
    assert.match(strictOut.additionalContext, /\[AgentMash: CLAIMED\]/);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Stop hook: reconcile before you finish
// ---------------------------------------------------------------------------

const stopStdin = (projectDir, sessionId, extra = {}) => ({
  session_id: sessionId,
  cwd: projectDir,
  hook_event_name: 'Stop',
  stop_hook_active: false,
  ...extra,
});

/** `sessionId`, once it has changed `file`, as its edit hooks note it: the Stop hook asks the room about no other session. */
const edited = (sessionId, file = 'src/models/user.ts') => {
  noteTouched(sessionId, [file]);
  return sessionId;
};

const oneCollision = (mode = 'approve') => ({
  reconcile_mode: mode,
  window_minutes: 60,
  collisions: [
    {
      file_path: 'src/models/user.ts',
      key: 'src/models/user.ts|alice,bob',
      mine: {
        developer: 'bob',
        sessions: ['s-bob'],
        branch: 'feat/login',
        task_hint: 'add a login endpoint',
        change_summary: '+8/-1 lines, touching login',
        symbols: ['User', 'login'],
        minutes_ago: 1,
      },
      theirs: [
        {
          developer: 'alice',
          sessions: ['s-alice'],
          branch: 'feat/soft-delete',
          task_hint: 'add soft deletes to the user model',
          change_summary: '+12/-3 lines, touching User, deletedAt',
          symbols: ['User', 'deletedAt'],
          minutes_ago: 6,
        },
      ],
      shared_symbols: ['User'],
      same_branch: false,
    },
  ],
});

/** Anything that would have an agent act on a teammate's change on its own: push, branch, open a PR, commit. */
const ACTS_ON_ITS_OWN = /\bpush\b|reconcile\/|gh pr|pull request|\bbranch named\b|\bcommit (?:the|on|it)\b|Do not end here/i;

test('stop tells the session once that its work overlaps a teammate\'s, and never blocks it', async () => {
  const mock = await startMockServer({ collisionsResponse: oneCollision('approve') });
  const projectDir = makeProjectDir();
  const sessionId = edited(freshSession());
  try {
    const first = await runHook('stop.mjs', stopStdin(projectDir, sessionId), hookEnv(projectDir, mock.port));
    assert.equal(first.code, 0, 'never exit 2: that would keep the agent working');
    assert.equal(first.stderr, '');
    const out = JSON.parse(first.stdout);
    // A blocked Stop ends a headless run as an error (error_max_turns), and
    // with broad permissions an agent told to reconcile pushes a branch and
    // opens a pull request for a teammate change nobody pushed. The human decides.
    assert.equal(out.decision, undefined, 'the finish is never blocked');
    assert.equal(out.reason, undefined);
    assert.equal(out.continue, undefined);
    const note = out.systemMessage;
    assert.match(note, /^\[AgentMash: OVERLAP\] /);
    assert.match(note, /src\/models\/user\.ts — also changed by alice/);
    assert.match(note, /alice: last write 6 min ago on branch feat\/soft-delete — you are on feat\/login/);
    assert.match(note, /while working on 'add soft deletes to the user model'/);
    assert.match(note, /You both touched User/);
    assert.match(note, /a person decides/i);
    assert.doesNotMatch(note, ACTS_ON_ITS_OWN);

    const asked = mock.requests.find((r) => r.path === '/collisions');
    assert.equal(asked.query.developer, 'bob');
    assert.equal(asked.query.session_id, sessionId);
    assert.equal(asked.query.advisory, '1', 'it tells the server it only advises');

    // The same collision is said once a session.
    const second = await runHook('stop.mjs', stopStdin(projectDir, sessionId), hookEnv(projectDir, mock.port));
    assert.equal(second.code, 0);
    assert.equal(second.stdout, '', 'already said for this collision');
  } finally {
    await mock.close();
  }
});

test('stop never asks the server when it is already the reason the agent is continuing', async () => {
  const mock = await startMockServer({ collisionsResponse: oneCollision('approve') });
  const projectDir = makeProjectDir();
  try {
    const result = await runHook(
      'stop.mjs',
      stopStdin(projectDir, edited(freshSession()), { stop_hook_active: true }),
      hookEnv(projectDir, mock.port)
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(mock.requests.length, 0, 'must not even ask the server — no chance of a loop');
  } finally {
    await mock.close();
  }
});

test('every reconcile mode only advises at stop: auto commits nothing, off says nothing', async () => {
  const projectDir = makeProjectDir();
  for (const mode of ['approve', 'auto', 'some-mode-from-a-newer-server']) {
    const server = await startMockServer({ collisionsResponse: oneCollision(mode) });
    try {
      const result = await runHook('stop.mjs', stopStdin(projectDir, edited(freshSession())), hookEnv(projectDir, server.port));
      assert.equal(result.code, 0, mode);
      const out = JSON.parse(result.stdout);
      assert.equal(out.decision, undefined, `${mode}: never blocks`);
      assert.match(out.systemMessage, /src\/models\/user\.ts/, `${mode}: says which file`);
      assert.doesNotMatch(out.systemMessage, ACTS_ON_ITS_OWN, `${mode}: asks nobody to push, branch, commit or open a PR`);
    } finally {
      await server.close();
    }
  }

  const off = await startMockServer({ collisionsResponse: oneCollision('off') });
  try {
    const result = await runHook('stop.mjs', stopStdin(projectDir, edited(freshSession())), hookEnv(projectDir, off.port));
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '', 'off means nothing is said at stop');
  } finally {
    await off.close();
  }
});

test('the brief get_collisions hands an agent asks it to do nothing on its own, in every mode', () => {
  for (const mode of ['approve', 'auto']) {
    const brief = buildReconciliationBrief({ collisions: oneCollision(mode).collisions, mode });
    assert.match(brief, /src\/models\/user\.ts — also changed by alice/);
    assert.doesNotMatch(brief, ACTS_ON_ITS_OWN, mode);
    assert.match(brief, /mark_resolved/, 'what a person decided can still be recorded');
  }
  assert.equal(buildReconciliationBrief({ collisions: oneCollision('off').collisions, mode: 'off' }), null);
});

test('stop is silent when there is nothing to reconcile, and fails open when the server is down', async () => {
  const projectDir = makeProjectDir();
  const quiet = await startMockServer();
  try {
    const result = await runHook('stop.mjs', stopStdin(projectDir, edited(freshSession())), hookEnv(projectDir, quiet.port));
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
  } finally {
    await quiet.close();
  }

  const dead = await startMockServer();
  const deadPort = dead.port;
  await dead.close();
  const result = await runHook('stop.mjs', stopStdin(projectDir, edited(freshSession())), hookEnv(projectDir, deadPort));
  assert.equal(result.code, 0, 'a dead server must never trap the agent in its turn');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.ok(result.elapsed < within(2500), `stop took ${result.elapsed}ms with the server down`);
});

// The room reads a session's overlaps off that session's own edits, so a
// session that changed nothing has none to hear about. Stop used to ask at
// every turn's end all the same, and the turn waited on the answer.
test('stop asks the room nothing in a session that changed no file, and asks once it has', async () => {
  const mock = await startMockServer({ collisionsResponse: oneCollision('approve') });
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  try {
    const idle = await runHook('stop.mjs', stopStdin(projectDir, sessionId), hookEnv(projectDir, mock.port));
    assert.deepEqual([idle.code, idle.stdout, idle.stderr], [0, '', '']);
    assert.deepEqual(mock.requests, [], 'nothing edited: nothing asked, nothing waited on');

    edited(sessionId);
    const busy = await runHook('stop.mjs', stopStdin(projectDir, sessionId), hookEnv(projectDir, mock.port));
    assert.match(JSON.parse(busy.stdout).systemMessage, /src\/models\/user\.ts — also changed by alice/);
    assert.deepEqual(mock.requests.map((r) => r.path), ['/collisions']);
  } finally {
    await mock.close();
  }
});

test('pre_tool_use suppresses repeat advisories for the same file in one session', async () => {
  const mock = await startMockServer({ checkResponse: conflictCheckResponse });
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  try {
    const first = await runHook('pre_tool_use.mjs', editStdin(projectDir, sessionId), hookEnv(projectDir, mock.port));
    assert.ok(first.stdout.includes('AgentMash'));
    const second = await runHook('pre_tool_use.mjs', editStdin(projectDir, sessionId), hookEnv(projectDir, mock.port));
    assert.equal(second.code, 0);
    assert.equal(second.stdout, '', 'second advisory for the same file should be suppressed');
  } finally {
    await mock.close();
  }
});

// The cooldown is for who the agent was told about, not for the file: inside
// it the file is asked about again once a minute at most, and a teammate or a
// claim new to it is said, alone. A minute is a long wait for a test, so the
// cache is told the last ask was longer ago, which is all the hook reads.
test('inside the cooldown a new teammate or claim on the file is still told, and the ones told already are not', async () => {
  const FILE = 'src/models/user.ts';
  const [alice] = conflictCheckResponse.holders;
  const dave = { ...alice, developer: 'dave', task_hint: 'track last login on the user model', minutes_ago: 0 };
  const now = Date.now();
  const carols = {
    id: 'claim_carol000000',
    developer: 'carol',
    session_id: 'sess-carol',
    task: 'move users to postgres',
    paths: ['src/models'],
    symbols: [],
    created_ts: now,
    expires_ts: now + 120 * 60_000,
    overlap: { paths: ['src/models'], symbols: [] },
  };
  const answer = { conflict: true, holders: [alice], claims: [] };
  const mock = await startMockServer({ checkResponse: answer });
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  const pre = () => runHook('pre_tool_use.mjs', editStdin(projectDir, sessionId), hookEnv(projectDir, mock.port));
  const said = (r) => {
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
  };
  const asks = () => mock.requests.filter((r) => r.path === '/check').length;
  const entry = () => readSessionCache(sessionId).advised?.[FILE];
  const lastAskedAgo = (ms) => {
    const cache = readSessionCache(sessionId);
    // an entry from hooks before the minute (a bare time) knows no last ask to move
    if (cache.advised?.[FILE] && typeof cache.advised[FILE] === 'object') cache.advised[FILE].asked = Date.now() - ms;
    writeSessionCache(sessionId, cache);
  };
  try {
    assert.match(said(await pre()), /alice's agent/);
    assert.equal(asks(), 1);
    assert.deepEqual(entry().seen, ['alice'], 'who the advisory named is kept with it');

    assert.equal(said(await pre()), '', 'the same teammate, inside the minute: nothing said');
    assert.equal(asks(), 1, 'and nothing asked');

    lastAskedAgo(61_000);
    assert.equal(said(await pre()), '', 'a minute on, the same teammate: nothing said');
    assert.equal(asks(), 2, 'but the room was asked');
    assert.equal(said(await pre()), '', 'and the minute starts over');
    assert.equal(asks(), 2);

    // dave reaches the file
    answer.holders = [alice, dave];
    assert.equal(said(await pre()), '', 'inside the minute even dave waits');
    assert.equal(asks(), 2);
    lastAskedAgo(61_000);
    const toldDave = said(await pre());
    assert.equal(asks(), 3);
    assert.match(toldDave, /^\[AgentMash: [A-Z ]+\] dave's agent /, toldDave);
    assert.match(toldDave, /track last login on the user model/);
    assert.doesNotMatch(toldDave, /alice|refactor the user model/, 'alice was said already');
    assert.deepEqual(entry().seen, ['alice', 'dave']);

    // carol claims it
    answer.claims = [carols];
    lastAskedAgo(61_000);
    const toldClaim = said(await pre());
    assert.match(toldClaim, /^\[AgentMash: CLAIMED\] carol's agent has claimed src\/models\/ — which includes src\/models\/user\.ts for 'move users to postgres'/);
    assert.doesNotMatch(toldClaim, /alice|dave/);
    assert.deepEqual(entry().seen, ['alice', 'claim_carol000000', 'dave']);

    lastAskedAgo(61_000);
    assert.equal(said(await pre()), '', 'all three told: nothing more to say');
    assert.equal(asks(), 5);
  } finally {
    await mock.close();
  }
});

test('a cooldown kept by hooks from before it named anyone still holds, and is asked about after a minute', async () => {
  const FILE = 'src/models/user.ts';
  const mock = await startMockServer({ checkResponse: conflictCheckResponse });
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  const pre = () => runHook('pre_tool_use.mjs', editStdin(projectDir, sessionId), hookEnv(projectDir, mock.port));
  const asks = () => mock.requests.filter((r) => r.path === '/check').length;
  try {
    writeSessionCache(sessionId, { advised: { [FILE]: Date.now() - 30_000 } });
    const quiet = await pre();
    assert.deepEqual([quiet.code, quiet.stdout, quiet.stderr], [0, '', '']);
    assert.equal(asks(), 0, 'half a minute old: not asked');

    // who it named was never kept, so whoever is there is said once more
    writeSessionCache(sessionId, { advised: { [FILE]: Date.now() - 2 * 60_000 } });
    const again = await pre();
    assert.equal(asks(), 1);
    assert.match(JSON.parse(again.stdout).hookSpecificOutput.additionalContext, /alice's agent/);
    assert.deepEqual(readSessionCache(sessionId).advised[FILE].seen, ['alice']);
  } finally {
    await mock.close();
  }
});

test('pre_tool_use hard-blocks with permissionDecision deny when AGENTMASH_STRICT=1', async () => {
  const mock = await startMockServer({ checkResponse: conflictCheckResponse });
  const projectDir = makeProjectDir();
  try {
    const result = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, freshSession()),
      hookEnv(projectDir, mock.port, { AGENTMASH_STRICT: '1' })
    );
    assert.equal(result.code, 0);
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /alice's agent is working in src\/models\/user\.ts/);
    assert.match(out.permissionDecisionReason, /strict mode blocked this edit/);
  } finally {
    await mock.close();
  }
});

test('pre_tool_use is silent when there is no conflict', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    const result = await runHook('pre_tool_use.mjs', editStdin(projectDir, freshSession()), hookEnv(projectDir, mock.port));
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Server down / misbehaving — the fail-open contract
// ---------------------------------------------------------------------------

test('all hooks exit 0, fast and silent, when the server is down', async () => {
  const mock = await startMockServer();
  const deadPort = mock.port;
  await mock.close();
  const projectDir = makeProjectDir();
  const sessionId = freshSession();

  for (const script of ['pre_tool_use.mjs', 'post_tool_use.mjs', 'user_prompt_submit.mjs']) {
    const stdin =
      script === 'user_prompt_submit.mjs'
        ? { session_id: sessionId, cwd: projectDir, prompt: 'do things' }
        : editStdin(projectDir, sessionId);
    const result = await runHook(script, stdin, hookEnv(projectDir, deadPort));
    assert.equal(result.code, 0, `${script} must exit 0 with the server down`);
    assert.equal(result.stdout, '', `${script} must stay silent with the server down`);
    assert.equal(result.stderr, '', `${script} must not write stderr with the server down`);
    assert.ok(result.elapsed < within(2000), `${script} took ${result.elapsed}ms with the server down`);
  }
});

test('hooks abandon a slow server within their budget', async () => {
  const SERVER_DELAY_MS = 20_000;
  const mock = await startMockServer({ delayMs: SERVER_DELAY_MS, checkResponse: conflictCheckResponse });
  const projectDir = makeProjectDir();
  try {
    // The advisory blocks an edit, so it gets the tighter budget.
    const advisory = await runHook('pre_tool_use.mjs', editStdin(projectDir, freshSession()), hookEnv(projectDir, mock.port));
    assert.equal(advisory.code, 0);
    assert.equal(advisory.stdout, '', 'a slow server must not produce advisory output');
    assert.ok(advisory.elapsed < within(3000), `pre_tool_use waited ${advisory.elapsed}ms on a hung server`);

    // Reporting runs async in Claude Code, so it may wait longer — but still bounded.
    const report = await runHook('post_tool_use.mjs', editStdin(projectDir, freshSession()), hookEnv(projectDir, mock.port));
    assert.equal(report.code, 0);
    assert.equal(report.stdout, '');
    assert.ok(report.elapsed < within(5000), `post_tool_use waited ${report.elapsed}ms on a hung server`);
  } finally {
    await mock.close();
  }
});

test('the advisory budget is configurable for distant servers', async () => {
  const mock = await startMockServer({ delayMs: 900, checkResponse: conflictCheckResponse });
  const projectDir = makeProjectDir();
  try {
    // Below the budget: the advisory is skipped rather than waited for.
    const tight = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, freshSession()),
      hookEnv(projectDir, mock.port, { AGENTMASH_TIMEOUT_MS: '300' })
    );
    assert.equal(tight.stdout, '', 'a 900ms server should be abandoned under a 300ms budget');
    assert.ok(tight.elapsed < within(900), `waited ${tight.elapsed}ms despite a 300ms budget`);

    // Raised above it: the same server now produces the warning.
    const generous = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, freshSession()),
      hookEnv(projectDir, mock.port, { AGENTMASH_TIMEOUT_MS: '3000' })
    );
    assert.match(generous.stdout, /AgentMash/, 'a raised budget should let the advisory through');
  } finally {
    await mock.close();
  }
});

test('hooks exit 0 silently when the server rejects the room', async () => {
  const mock = await startMockServer({ status: 401 });
  const projectDir = makeProjectDir();
  try {
    const result = await runHook(
      'post_tool_use.mjs',
      editStdin(projectDir, freshSession()),
      hookEnv(projectDir, mock.port, { AGENTMASH_ROOM: 'mash_wrongwrongwrongwrong' })
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    await mock.close();
  }
});

test('hooks exit 0 silently on malformed stdin', async () => {
  const projectDir = makeProjectDir();
  for (const script of ['pre_tool_use.mjs', 'post_tool_use.mjs', 'user_prompt_submit.mjs']) {
    const result = await runHook(script, 'this is not json{{', hookEnv(projectDir, 1));
    assert.equal(result.code, 0, `${script} must exit 0 on garbage stdin`);
    assert.equal(result.stdout, '', `${script} must stay silent on garbage stdin`);
    assert.equal(result.stderr, '', `${script} must not write stderr on garbage stdin`);
  }
});

test('Cursor running these Claude Code hooks gets nothing from them: its own adapter reports its edits', async () => {
  // Cursor's "third-party hooks" setting (on by default) runs the hooks in
  // .claude/settings.json and ~/.claude/settings.json too, and every payload it
  // sends carries cursor_version. Its edits already reach the room through
  // clients/cursor/after_file_edit.mjs, so through here they would land twice.
  const mock = await startMockServer({ checkResponse: conflictCheckResponse, collisionsResponse: oneCollision() });
  const projectDir = makeProjectDir();
  const cursor = { cursor_version: '1.7.52', conversation_id: 'conv-1', generation_id: 'gen-1' };
  const sessionId = freshSession();
  try {
    const payloads = [
      ['session_start.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'SessionStart' }],
      ['user_prompt_submit.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'UserPromptSubmit', prompt: 'rename the user model' }],
      ['prompt_note.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'UserPromptSubmit', prompt: 'rename the user model' }],
      ['pre_tool_use.mjs', editStdin(projectDir, sessionId)],
      ['post_tool_use.mjs', { ...editStdin(projectDir, sessionId), hook_event_name: 'PostToolUse' }],
      ['post_tool_use.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'touch x' } }],
      ['stop.mjs', stopStdin(projectDir, sessionId)],
      ['session_end.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'SessionEnd', reason: 'exit' }],
    ];
    for (const [script, payload] of payloads) {
      for (const args of [[], ['--global']]) {
        const result = await runHook(script, { ...payload, ...cursor }, hookEnv(projectDir, mock.port), args);
        assert.equal(result.code, 0, `${script} ${args.join(' ')} exits 0 under Cursor`);
        assert.equal(result.stdout, '', `${script} ${args.join(' ')} says nothing under Cursor`);
        assert.equal(result.stderr, '', `${script} ${args.join(' ')} writes no stderr under Cursor`);
      }
    }
    assert.deepEqual(mock.requests, [], 'nothing is asked or reported for a Cursor session');
    assert.equal(readPrompt(sessionId).task_hint, null, 'and nothing is kept for it either');

    // The same edit from Claude Code itself is checked and reported as ever.
    const advised = await runHook('pre_tool_use.mjs', editStdin(projectDir, freshSession()), hookEnv(projectDir, mock.port));
    assert.match(advised.stdout, /AgentMash/);
    await runHook('post_tool_use.mjs', { ...editStdin(projectDir, sessionId), hook_event_name: 'PostToolUse' }, hookEnv(projectDir, mock.port));
    assert.ok(mock.requests.some((r) => r.path === '/events'), 'Claude Code\'s own edit is reported');
  } finally {
    await mock.close();
  }
});

test('hooks do nothing when no room is configured', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    const result = await runHook('post_tool_use.mjs', editStdin(projectDir, freshSession()), {
      CLAUDE_PROJECT_DIR: projectDir,
      AGENTMASH_URL: `http://127.0.0.1:${mock.port}`,
      AGENTMASH_DEV: 'bob',
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(mock.requests.length, 0, 'an unconfigured repo must not send anything');
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('hooks read the committed .claude/agentmash/config.json', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    fs.mkdirSync(path.join(projectDir, '.claude', 'agentmash'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.claude', 'agentmash', 'config.json'),
      JSON.stringify({ url: `http://127.0.0.1:${mock.port}`, room: ROOM, label: 'team repo' })
    );
    // no AGENTMASH_URL / AGENTMASH_ROOM at all — this is the `git pull` case
    const result = await runHook(
      'post_tool_use.mjs',
      { ...editStdin(projectDir, freshSession()), hook_event_name: 'PostToolUse' },
      { CLAUDE_PROJECT_DIR: projectDir, AGENTMASH_DEV: 'carol' }
    );
    assert.equal(result.code, 0);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].room, ROOM);
    assert.equal(mock.requests[0].body.developer, 'carol');
  } finally {
    await mock.close();
  }
});

test('environment variables override the committed config', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    fs.mkdirSync(path.join(projectDir, '.claude', 'agentmash'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.claude', 'agentmash', 'config.json'),
      JSON.stringify({ url: 'http://127.0.0.1:1', room: 'mash_committedcommitted' })
    );
    const result = await runHook(
      'post_tool_use.mjs',
      { ...editStdin(projectDir, freshSession()), hook_event_name: 'PostToolUse' },
      hookEnv(projectDir, mock.port, { AGENTMASH_DEV: 'dave' })
    );
    assert.equal(result.code, 0);
    assert.equal(mock.requests.length, 1, 'env vars should have redirected this to the mock server');
    assert.equal(mock.requests[0].room, ROOM);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Message shapes and severity
//
// These call the builder directly. The injected paragraph is the product, so it
// gets asserted as text — a reviewer reading this file should be able to see
// what an agent actually receives without running anything.
// ---------------------------------------------------------------------------

// alice's edit, made in the very checkout this agent works in (two sessions,
// or two people, at one clone): the case where her write really is in this
// working tree. The tests further down move her to a checkout of her own, and
// to one nobody can name.
const HOLDER = {
  developer: 'alice',
  task_hint: 'add soft deletes to the user model',
  minutes_ago: 2,
  branch: 'main',
  file_path: 'src/models/user.ts',
  last_touched: '2026-08-30T14:32:01.000Z',
  change_summary: '+12/-3 lines, touching deletedAt',
  checkout_id: 'co_thisCheckout',
};

const advise = (holders, over = {}) =>
  buildCollisionAdvice({ file: 'src/models/user.ts', branch: 'main', checkout: 'co_thisCheckout', holders, ...over });

test('each situation picks its own shape, and the rule is recency plus working tree', () => {
  const active = advise([HOLDER]);
  assert.equal(active.level, 'active');
  assert.match(active.text, /^\[AgentMash: ACTIVE COLLISION\]/);
  assert.match(active.text, /already in your working tree/);
  assert.match(active.text, /Re-read src\/models\/user\.ts now/);

  // Same file, their branch: re-reading cannot help, so it must not be asked for.
  const parallel = advise([{ ...HOLDER, branch: 'feat/soft-delete' }]);
  assert.equal(parallel.level, 'parallel');
  assert.match(parallel.text, /^\[AgentMash: PARALLEL EDIT\]/);
  assert.match(parallel.text, /re-reading the file won't show it/);
  assert.match(parallel.text, /merge conflict forming/);
  assert.ok(!/Re-read src\/models\/user\.ts now/.test(parallel.text));

  const recent = advise([{ ...HOLDER, minutes_ago: 25 }]);
  assert.equal(recent.level, 'recent');
  assert.match(recent.text, /^\[AgentMash: RECENT EDIT\]/);
  assert.match(recent.text, /Low urgency/);

  const nearby = advise([{ ...HOLDER, file_path: 'src/models/session.ts', minutes_ago: 22 }]);
  assert.equal(nearby.level, 'nearby');
  assert.match(nearby.text, /^\[AgentMash: NEARBY EDIT\]/);
  assert.match(nearby.text, /No action needed unless/);
});

// A teammate who deleted or moved the file didn't change lines in it, so
// neither "re-read it" nor "keep this edit additive" is any help: the file
// is gone from their tree, or somewhere else in it.
test('a file a teammate deleted or moved is worded as that, never as an edit', () => {
  const theirs = { ...HOLDER, checkout_id: 'co_alicesClone' };
  const additive = /additive|re-read|Re-read|modified|merge conflict forming/;

  const deleted = advise([{ ...theirs, change_summary: 'deleted, in a patch' }]);
  assert.equal(deleted.level, 'parallel');
  assert.match(
    deleted.text,
    /^\[AgentMash: PARALLEL EDIT\] alice's agent deleted src\/models\/user\.ts 2 min ago on main, as you are, in a checkout of their own, while working on 'add soft deletes to the user model' \(in a patch\)\. It is gone on their side only, so an edit here meets their delete as a conflict/
  );
  assert.doesNotMatch(deleted.text, additive);

  const moved = advise([{ ...theirs, change_summary: 'moved to src/models/account.ts, in a patch' }]);
  assert.match(moved.text, /alice's agent moved src\/models\/user\.ts to src\/models\/account\.ts 2 min ago/);
  assert.match(moved.text, /It is at src\/models\/account\.ts on their side only, so this edit has to follow it there/);
  assert.doesNotMatch(moved.text, additive);

  // a commit the git client reported, in this very checkout: already gone here
  const committed = advise([{ ...HOLDER, change_summary: 'commit 1a2b3c4 · deleted' }]);
  assert.equal(committed.level, 'active');
  assert.match(committed.text, /^\[AgentMash: ACTIVE COLLISION\] alice's agent deleted src\/models\/user\.ts 2 min ago on your branch \(main\), while working on '[^']+' \(commit 1a2b3c4\)\. It is already gone from your working tree: writing it brings back a file they removed\./);
  assert.doesNotMatch(committed.text, additive);

  // and nobody can tell whose tree: both, hedged
  const unknown = advise([{ ...HOLDER, checkout_id: undefined, change_summary: 'moved to src/models/account.ts, in a patch' }]);
  assert.match(unknown.text, /If you share their checkout, it is already at src\/models\/account\.ts: make this change there, not here\. If you work in a checkout of your own/);

  // the file it moved to is written like any other
  const arrived = advise([{ ...theirs, change_summary: 'moved from src/models/old.ts, +1/-1 lines, in a patch' }]);
  assert.match(arrived.text, /alice's agent modified src\/models\/user\.ts/);
});

test('the same branch name in a checkout of their own is a merge forming, not a stale read', () => {
  // alice and bob each in their own clone, both on main: her uncommitted
  // write is in her working tree and not in his, so "re-read it" is a lie.
  const elsewhere = advise([{ ...HOLDER, checkout_id: 'co_alicesClone' }]);
  assert.equal(elsewhere.level, 'parallel');
  assert.match(elsewhere.text, /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts 2 min ago on main, as you are, in a checkout of their own/);
  assert.match(elsewhere.text, /isn't in your working tree, so re-reading the file won't show it/);
  assert.doesNotMatch(elsewhere.text, /already in your working tree|on your branch|Re-read/);

  // and the same file five, twenty-five minutes on, and with presence gone: never "in your tree"
  for (const holder of [{ minutes_ago: 25 }, { presence: 'ended', presence_label: 'ended their session 20 min ago' }]) {
    const text = advise([{ ...HOLDER, checkout_id: 'co_alicesClone', ...holder }]).text;
    assert.doesNotMatch(text, /already in your working tree/, JSON.stringify(holder));
  }

  // one checkout, two sessions or two people at it: it is the same tree, and says so
  const shared = advise([HOLDER]);
  assert.equal(shared.level, 'active');
  assert.match(shared.text, /on your branch \(main\)/);
  assert.match(shared.text, /Their write is already in your working tree/);
});

test('when nobody can tell whose checkout it is, the advisory says only what is true either way', () => {
  const cases = [
    ['a server from before checkout_id sends none', {}, { checkout_id: undefined }],
    ['a hook from before it sent none', {}, { checkout_id: null }],
    ['this hook cannot work its own out', { checkout: null }, {}],
  ];
  for (const [label, over, holder] of cases) {
    // the level is what it always was: re-reading is cheap and harmless when wrong
    const active = advise([{ ...HOLDER, ...holder }], over);
    assert.equal(active.level, 'active', label);
    assert.match(active.text, /alice's agent is working in src\/models\/user\.ts — last write 2 min ago on main, as you are/, label);
    assert.doesNotMatch(active.text, /Their write is already in your working tree|on your branch/, label);
    assert.match(active.text, /If you share their checkout, their write is already in your working tree: re-read src\/models\/user\.ts now/, label);
    assert.match(active.text, /If you work in a checkout of your own, re-reading will not show it: pull once they have pushed, or expect to merge/, label);

    const recent = advise([{ ...HOLDER, ...holder, minutes_ago: 25 }], over);
    assert.equal(recent.level, 'recent', label);
    assert.doesNotMatch(recent.text, /their write is already in your working tree and/, label);
    assert.match(recent.text, /If you share their checkout, re-read src\/models\/user\.ts first only if this edit depends on lines they may have moved; if you work in your own, pull once they have pushed/, label);

    // a confirmed symbol overlap in another file, the same way
    const symbol = advise([{ ...HOLDER, ...holder, file_path: 'src/models/repo.ts', overlapping_symbols: ['findById'] }], over);
    assert.doesNotMatch(symbol.text, /Their write is already in your working tree/, label);
    assert.match(symbol.text, /If you share their checkout, their write is already in your working tree: read src\/models\/repo\.ts before you finish this edit/, label);
  }
  // another branch is another tree whatever the checkouts say
  const otherBranch = advise([{ ...HOLDER, checkout_id: undefined, branch: 'feat/soft-delete' }]);
  assert.equal(otherBranch.level, 'parallel');
});

test('severity is honest: a weak signal is short and asks for nothing', () => {
  const active = advise([HOLDER]).text;
  const recent = advise([{ ...HOLDER, minutes_ago: 25 }]).text;
  const nearby = advise([{ ...HOLDER, file_path: 'src/models/session.ts', minutes_ago: 22 }]).text;

  assert.ok(nearby.length < recent.length, 'the nearby shape must cost less context than the recent one');
  assert.ok(recent.length < active.length, 'the recent shape must cost less context than an active collision');

  // A demoted collision is still a collision: it asks for the same re-read the
  // loud one asks for, so it must not shrink to the cold-file shape.
  const stale = advise([
    { ...HOLDER, presence: 'ended', presence_label: 'ended their session 20 min ago' },
  ]).text;
  assert.ok(recent.length < stale.length, 'a stale file is not a cold one');
  assert.match(stale, /Re-read src\/models\/user\.ts now/);
  // The cheapest way to make every warning ignorable is to make every warning
  // demand something.
  assert.ok(!/Re-read/.test(nearby), 'a neighbouring-file edit must not demand a re-read');
  assert.ok(!/must|urgent|STOP/i.test(nearby), 'a weak signal must not borrow urgent language');
  assert.match(recent, /only if this edit depends on/);
});

test('one minute in the same file does not read like twenty-five', () => {
  assert.match(advise([{ ...HOLDER, minutes_ago: 0 }]).text, /is inside src\/models\/user\.ts — last write seconds ago/);
  assert.match(advise([{ ...HOLDER, minutes_ago: 1 }]).text, /is inside src\/models\/user\.ts — last write 1 min ago/);
  assert.match(advise([{ ...HOLDER, minutes_ago: 4 }]).text, /is working in src\/models\/user\.ts/);
  assert.match(advise([{ ...HOLDER, minutes_ago: 25 }]).text, /25 min ago/);
});

test('symbol-level detection slots in and outranks both file and recency', () => {
  // The seam: detection may soon report which declarations actually collided.
  // A neighbouring file, twenty minutes cold, is a nearby edit — unless the
  // symbol you are about to call is the one that moved.
  const cold = { ...HOLDER, file_path: 'src/models/repo.ts', minutes_ago: 20, change_summary: '+6/-6 lines' };
  assert.equal(advise([cold]).level, 'nearby');

  const overlap = advise([{ ...cold, overlapping_symbols: ['findById'] }]);
  assert.equal(overlap.level, 'active');
  assert.match(overlap.text, /You are both changing findById\./);
  assert.match(overlap.text, /Read src\/models\/repo\.ts before you finish this edit/);

  // Cross-branch overlap is a merge problem, not a stale-read one.
  const crossBranch = advise([{ ...cold, branch: 'feat/repo', overlapping_symbols: ['findById'] }]);
  assert.equal(crossBranch.level, 'parallel');
  assert.match(crossBranch.text, /still shows you the old findById/);
});

test('a symbol match outranks the directory heuristic, in this branch and not only downstream', () => {
  // feat/semantic-conflicts' headline case, fed through this branch's classify:
  // alice changed createUser in a file three directories away that this one
  // imports. Path matching calls that a neighbour; the server has already said
  // it is the same declaration, and that has to win here — an integration-only
  // fix is one rebase away from being lost.
  const holder = {
    developer: 'alice',
    task_hint: 'rename the store API',
    minutes_ago: 1,
    branch: 'main',
    file_path: 'packages/core/src/db.ts',
    change_summary: '+12/-3 lines, touching findHolders',
    match_kind: 'symbol',
    symbols: ['findHolders'],
    confidence: 'high',
  };
  const advice = buildCollisionAdvice({ file: 'server/src/app.ts', branch: 'main', holders: [holder] });
  assert.equal(advice.level, 'active');
  assert.match(advice.text, /depends on for findHolders/);
  assert.ok(!/same directory/.test(advice.text), 'it is not the same directory, and saying so is a lie');
  assert.ok(!/nothing of yours is stale/.test(advice.text), 'something of theirs is very much in your tree');
  assert.ok(!/No action needed/.test(advice.text));

  // Cross-branch, same evidence: a merge problem rather than a stale read.
  const parallel = buildCollisionAdvice({
    file: 'server/src/app.ts',
    branch: 'main',
    holders: [{ ...holder, branch: 'feat/store-api' }],
  });
  assert.equal(parallel.level, 'parallel');
  assert.match(parallel.text, /still shows you the old findHolders/);

  // The match kind is the evidence; the names are only how we word it. A
  // confirmed symbol match with nothing nameable still must not read as nearby.
  const nameless = buildCollisionAdvice({
    file: 'server/src/app.ts',
    branch: 'main',
    holders: [{ ...holder, symbols: ['not an identifier'], change_summary: '+2/-2 lines' }],
  });
  assert.equal(nameless.level, 'active');
  assert.ok(!/NEARBY/.test(nameless.text));

  // Unconfirmed symbols still inform wording only — a medium-confidence path
  // match is not evidence that the declaration is yours too.
  const unconfirmed = buildCollisionAdvice({
    file: 'server/src/app.ts',
    branch: 'main',
    holders: [{ ...holder, match_kind: 'dir', confidence: 'medium' }],
  });
  assert.equal(unconfirmed.level, 'nearby');
  assert.match(unconfirmed.text, /same directory/);
});

test('presence from the server outranks the guess the timestamp allows', () => {
  // Wording, not level: `idle` is a teammate at their desk between turns, so
  // the collision stands (see teammateGone) while "is inside this file" stops
  // being something we are entitled to say.
  const quiet = advise([
    { ...HOLDER, presence: 'idle', presence_label: 'has an open session but has done nothing for 4 min' },
  ]);
  assert.equal(quiet.level, 'active');
  assert.match(quiet.text, /alice's agent has open work in src\/models\/user\.ts/);
  assert.match(quiet.text, /alice has an open session but has done nothing for 4 min\./);

  // An active teammate needs no sentence: "last write 2 min ago" already said it.
  const working = advise([{ ...HOLDER, presence: 'active', presence_label: 'is working right now' }]);
  assert.match(working.text, /is working in src\/models\/user\.ts/);
  assert.ok(!/is working right now/.test(working.text));

  // A server that predates presence produces exactly what it always did.
  assert.match(advise([HOLDER]).text, /is working in src\/models\/user\.ts — last write 2 min ago/);
  assert.ok(!/appears to have stopped/.test(advise([HOLDER]).text));
});

// ---------------------------------------------------------------------------
// Presence × the working tree: the severity model, as a table
//
// The two axes are independent and the tests are laid out so that they can be
// read as one: rows are what is true of *my working tree*, columns are what the
// server knows about *the teammate*. A reviewer should be able to disagree with
// a cell here without running anything.
// ---------------------------------------------------------------------------

const PRESENCE_LABELS = {
  active: 'is working right now',
  idle: 'has an open session but has done nothing for 4 min',
  stale: 'has sent nothing for 20 min and appears to have stopped',
  ended: 'ended their session 20 min ago',
};

/** Attach presence the way GET /check attaches it; `null` is a server too old to send any. */
const withPresence = (holder, state) =>
  state === null ? { ...holder } : { ...holder, presence: state, presence_label: PRESENCE_LABELS[state] };

/** Same file, my branch, two minutes old — the only row presence is allowed to move. */
const SAME_TREE_FRESH = HOLDER;
/** Same file, their branch: a merge problem, and merges do not care who is awake. */
const OTHER_BRANCH = { ...HOLDER, branch: 'feat/soft-delete' };
/** Same file, my branch, long cold: already the quiet end of the scale. */
const SAME_TREE_COLD = { ...HOLDER, minutes_ago: 25 };
/** A different file in the same directory: claims nothing about anybody. */
const NEIGHBOUR = { ...HOLDER, file_path: 'src/models/session.ts', minutes_ago: 22 };
/** Confirmed at the declaration — evidence that does not decay. */
const SYMBOL = {
  ...HOLDER,
  file_path: 'src/models/repo.ts',
  minutes_ago: 20,
  change_summary: '+6/-6 lines',
  match_kind: 'symbol',
  symbols: ['findById'],
  confidence: 'high',
};
const SYMBOL_OTHER_BRANCH = { ...SYMBOL, branch: 'feat/repo' };

test('presence moves exactly one row of the severity table, and the table is here', () => {
  const columns = [null, 'active', 'idle', 'stale', 'ended'];
  //                                    no presence  active     idle       stale      ended
  const table = [
    ['same file, my branch, 2 min', SAME_TREE_FRESH, 'active', 'active', 'active', 'stale', 'stale'],
    ['same file, their branch', OTHER_BRANCH, 'parallel', 'parallel', 'parallel', 'parallel', 'parallel'],
    ['same file, my branch, 25 min', SAME_TREE_COLD, 'recent', 'recent', 'recent', 'recent', 'recent'],
    ['neighbouring file', NEIGHBOUR, 'nearby', 'nearby', 'nearby', 'nearby', 'nearby'],
    ['confirmed symbol, my branch', SYMBOL, 'active', 'active', 'active', 'active', 'active'],
    ['confirmed symbol, their branch', SYMBOL_OTHER_BRANCH, 'parallel', 'parallel', 'parallel', 'parallel', 'parallel'],
  ];

  for (const [name, holder, ...expected] of table) {
    columns.forEach((state, i) => {
      const advice = advise([withPresence(holder, state)]);
      assert.equal(
        advice.level,
        expected[i],
        `${name} + presence ${state ?? 'absent'} should be ${expected[i]}, got ${advice.level}`
      );
    });
  }
});

test('the demotion drops the claim about the person and keeps the one about the file', () => {
  const live = advise([withPresence(SAME_TREE_FRESH, 'active')]);
  const gone = advise([withPresence(SAME_TREE_FRESH, 'ended')]);

  // What is withdrawn: the assertion that somebody is in there with you.
  assert.match(live.text, /^\[AgentMash: ACTIVE COLLISION\] alice's agent is working in/);
  assert.match(gone.text, /^\[AgentMash: STALE READ\] alice's agent left src\/models\/user\.ts changed/);
  assert.ok(!/is working in|is inside/.test(gone.text), 'nobody is working in it, so it must not say so');

  // What survives: their write is in this tree either way, so the imperative
  // that fixes a stale read is word-for-word the same one.
  for (const text of [live.text, gone.text]) {
    assert.match(text, /already in your working tree/);
    assert.match(text, /Re-read src\/models\/user\.ts now and rebuild this edit/);
    assert.match(text, /Leave deletedAt named and shaped as alice left it/);
  }
  // And it is not the cold-file advice, which would have thrown that away.
  assert.ok(!/Low urgency/.test(gone.text));
  assert.ok(!/only if this edit depends on/.test(gone.text));
});

test('a session that said goodbye is a fact; one that went quiet is a guess', () => {
  const ended = advise([withPresence(SAME_TREE_FRESH, 'ended')]).text;
  const quiet = advise([withPresence(SAME_TREE_FRESH, 'stale')]).text;

  // Same level, deliberately different confidence — see absenceClause.
  assert.equal(advise([withPresence(SAME_TREE_FRESH, 'ended')]).level, 'stale');
  assert.equal(advise([withPresence(SAME_TREE_FRESH, 'stale')]).level, 'stale');
  assert.notEqual(ended, quiet, 'a reported end and an inferred one must not render identically');

  assert.match(ended, /ended their session 20 min ago — reported by their own client, not inferred/);
  assert.match(ended, /no second agent in this file to surprise/);

  assert.match(quiet, /has sent nothing for 20 min and appears to have stopped/);
  assert.match(quiet, /timeout on the board's clock rather than a goodbye/);
  assert.ok(
    !/no second agent in this file to surprise|not inferred/.test(quiet),
    'the guess must not borrow the report\'s certainty'
  );

  // The trailing presence footnote is gone from this shape: the same fact is
  // now load-bearing and sits next to the headline it qualifies.
  assert.equal(
    (quiet.match(/has sent nothing for 20 min/g) || []).length,
    1,
    'presence must be stated once, where it explains the level'
  );
});

test('a confirmed symbol collision is never demoted, and says why when presence disagrees', () => {
  const gone = advise([withPresence(SYMBOL, 'ended')]);
  assert.equal(gone.level, 'active', 'the proof is that the declaration moved, and that does not expire');
  assert.match(gone.text, /^\[AgentMash: ACTIVE COLLISION\]/);
  assert.match(gone.text, /alice is not at the keyboard, and this is still a collision rather than a stale file/);
  assert.match(gone.text, /confirmed at findById/);
  assert.match(gone.text, /does not become safe to write against because its author stepped away/);

  // A live teammate needs no such explanation — nothing is in tension.
  const live = advise([withPresence(SYMBOL, 'active')]);
  assert.ok(!/not at the keyboard/.test(live.text));

  // And the explanation is only owed where the level actually held: a path-only
  // match with the same presence is a stale file, and says so instead.
  const pathOnly = advise([withPresence(SAME_TREE_FRESH, 'ended')]);
  assert.ok(!/still a collision rather than a stale file/.test(pathOnly.text));
});

test('a stale file outranks a parallel edit when two teammates hold the same file', () => {
  // A stale read fails inside this edit, unreviewed; a merge conflict fails at
  // a merge, where git and a human are both looking. So the demoted collision
  // still gets the paragraph.
  const advice = advise(
    [
      { ...OTHER_BRANCH, developer: 'bob', minutes_ago: 1 },
      withPresence(SAME_TREE_FRESH, 'stale'),
    ],
    {}
  );
  assert.equal(advice.level, 'stale');
  assert.equal(advice.developer, 'alice');
  assert.match(advice.text, /Also recently in this area: bob \(1 min ago\)/);
});

test('a change_summary carrying an override note does not corrupt the next advisory', () => {
  // This PR appends "[overrode alice: …]" to change_summary, and namesFromSummary
  // reads everything after "touching" as a comma list — so the advisory was
  // parsing its own output back in as a declaration name.
  const polluted = advise([
    {
      ...HOLDER,
      developer: 'bob',
      change_summary:
        '+4/-2 lines, touching createUser [overrode alice: the schema change has to land before the migration runs today]',
    },
  ]);
  assert.match(polluted.text, /Leave createUser named and shaped as bob left it/);
  // The note itself still rides out in the parenthetical — that is the channel
  // it was built to use. What it must never do is become a declaration name.
  assert.match(polluted.text, /\[overrode alice: the schema change/);
  assert.ok(
    !/Leave createUser \[|Leave [^.]*overrode/.test(polluted.text),
    'the note was read back in as a symbol name'
  );

  // And anything that is not a declaration name is dropped rather than quoted.
  // "it", not "them": only the one candidate that is a declaration name survived.
  const junk = advise([{ ...HOLDER, change_summary: '+1/-1 lines, touching some prose, 42, User' }]);
  assert.match(junk.text, /Leave User named and shaped as alice left it/);
});

test('the override note rides out whole, inside what the server will accept', () => {
  const note = '[overrode alice: the retry helper is new code at the end of the file]';
  assert.equal(composeSummary('+4/-2 lines', note), `+4/-2 lines ${note}`);
  assert.equal(composeSummary('+4/-2 lines', null), '+4/-2 lines');
  assert.equal(composeSummary(null, null), null);
  assert.equal(composeSummary(null, note), note);

  // A long summary must cost the summary, not the note and not the whole event:
  // change_summary is bounded at 300 on the server, and a rejected event is a
  // lost edit report.
  const long = composeSummary(`wrote 900 lines, defining ${'A'.repeat(280)}`, note);
  assert.ok(long.length <= 300, `composed summary was ${long.length} characters`);
  assert.ok(long.endsWith(note), 'the note is the half that cannot be recomputed');
});

test('names in change_summary inform the wording but never the severity', () => {
  // Until detection confirms an overlap, "touching deletedAt" is a hint about
  // their edit, not evidence that it is yours too.
  const withNames = advise([{ ...HOLDER, minutes_ago: 25 }]);
  assert.equal(withNames.level, 'recent');
  assert.match(withNames.text, /don't rename or delete deletedAt/);

  const withoutNames = advise([{ ...HOLDER, minutes_ago: 25, change_summary: '+4/-1 lines' }]);
  assert.equal(withoutNames.level, 'recent');
  assert.match(withoutNames.text, /Otherwise carry on\.$/);
});

test('partial and missing data degrade to a shorter sentence, never to "undefined"', () => {
  const drops = [
    {},
    { developer: 'alice' },
    { ...HOLDER, change_summary: null, task_hint: null, branch: null },
    { ...HOLDER, minutes_ago: null, last_touched: null },
    { ...HOLDER, file_path: null },
    { developer: 'alice', minutes_ago: 'soon', branch: 42, task_hint: {}, change_summary: [] },
    { ...HOLDER, overlapping_symbols: 'findById' },
    { ...HOLDER, symbols: [null, '', 'User'] },
  ];
  for (const holder of drops) {
    const advice = advise([holder]);
    assert.ok(advice, `no advice for ${JSON.stringify(holder)}`);
    assert.ok(
      !/undefined|\bnull\b|NaN|\[object Object\]/.test(advice.text),
      `leaked a placeholder value: ${advice.text}`
    );
    assert.match(advice.text, /^\[AgentMash: /);
    assert.ok(advice.token.startsWith('ack_'));
  }
  // An entirely empty holder still names somebody, because "'s agent" is worse.
  assert.match(advise([{}]).text, /a teammate's agent modified src\/models\/user\.ts recently/);
});

test('a server that sends nothing usable produces nothing', () => {
  assert.equal(advise([]), null);
  assert.equal(advise(null), null);
  assert.equal(advise([null, 'nope', 7]), null);
});

test('the loudest holder leads and the rest get one clause each', () => {
  const advice = advise([
    { developer: 'carol', minutes_ago: 18, branch: 'main', file_path: 'src/models/user.ts' },
    { ...HOLDER, minutes_ago: 1 },
    { developer: 'bob', minutes_ago: 9, branch: 'main', file_path: 'src/models/user.ts' },
  ]);
  assert.equal(advice.developer, 'alice', 'the most urgent holder should lead');
  assert.match(advice.text, /^\[AgentMash: ACTIVE COLLISION\] alice's agent is inside/);
  assert.match(advice.text, /Also recently in this area: bob \(9 min ago\), carol \(18 min ago\)\.$/);
  assert.equal(advice.text.match(/\[AgentMash/g).length, 1, 'only one full shape per message');
});

test('task hints can be kept out of the message', () => {
  assert.match(advise([HOLDER]).text, /while working on 'add soft deletes to the user model'/);
  assert.ok(!/while working on/.test(advise([HOLDER], { showHints: false }).text));
});

test('long task hints and hostile file paths stay bounded', () => {
  const advice = advise([{ ...HOLDER, task_hint: 'x'.repeat(4000), change_summary: 'y'.repeat(4000) }]);
  assert.ok(advice.text.length < 1400, `message grew to ${advice.text.length} characters`);
  assert.match(advice.text, /…/);
  const newlines = advise([{ ...HOLDER, task_hint: 'line one\nline two\n\nline three' }]).text;
  assert.ok(!newlines.includes('\n'), 'a prompt with newlines must not reshape the message');
});

// ---------------------------------------------------------------------------
// Acknowledgement tokens and reasons
// ---------------------------------------------------------------------------

test('an acknowledgement token is bound to one teammate, one file, one write', () => {
  const base = holderFacts(HOLDER, 'src/models/user.ts', 'main');
  const token = ackToken(base);
  assert.equal(ackToken(holderFacts({ ...HOLDER }, 'src/models/user.ts', 'main')), token, 'same facts, same token');

  for (const changed of [
    { developer: 'bob' },
    { file_path: 'src/models/session.ts' },
    { last_touched: '2026-08-30T14:40:00.000Z' },
    { branch: 'feat/other' },
  ]) {
    assert.notEqual(
      ackToken(holderFacts({ ...HOLDER, ...changed }, 'src/models/user.ts', 'main')),
      token,
      `${Object.keys(changed)[0]} must produce a different token`
    );
  }
});

test('acknowledgement reasons must be specific, fresh, and the agent\'s own words', () => {
  const token = 'ack_abc123';
  const good = 'the deletedAt column is unrelated to the retry logic I am adding at the bottom';

  assert.equal(resolveAck([{ token, reason: good }], token).ok, true);
  assert.equal(resolveAck([], token).ok, false);
  assert.equal(resolveAck([{ token: 'ack_other', reason: good }], token).ok, false);

  const placeholder = resolveAck([{ token, reason: ACK_PLACEHOLDER }], token);
  assert.equal(placeholder.ok, false);
  assert.equal(placeholder.rejected, 'placeholder');

  const thin = resolveAck([{ token, reason: 'need to edit' }], token);
  assert.equal(thin.ok, false);
  assert.equal(thin.rejected, 'thin');

  // The same sentence filed under two collisions is the signature of a reflex.
  const recycled = resolveAck([{ token: 'ack_earlier', reason: good }, { token, reason: good }], token);
  assert.equal(recycled.ok, false);
  assert.equal(recycled.rejected, 'recycled');

  // A bad attempt does not poison a later good one.
  const mixed = resolveAck([{ token, reason: 'no' }, { token, reason: good }], token);
  assert.equal(mixed.ok, true);
  assert.equal(mixed.reason, good);
});

test('a reason is checked against the collision it was handed, not counted', () => {
  const token = 'ack_abc123';
  const grounding = ackGrounding(holderFacts(HOLDER, 'src/models/user.ts', 'main'));
  assert.deepEqual(grounding.particulars, ['deletedAt', 'alice']);

  const at = (reason, taskHint) => resolveAck([{ token, reason }], token, { grounding, taskHint });

  // The sentence the review got through, verbatim. It is 53 characters of
  // nothing, and it would fit any collision in any repo, which is exactly what
  // makes it not a reason.
  const generic = at('I need to edit this file to complete my assigned task.');
  assert.equal(generic.ok, false, 'the generic sentence must not buy passage');
  assert.equal(generic.rejected, 'ungrounded');

  for (const empty of [
    'this edit is required for the work I was asked to do',
    'proceeding because the change must be made now',
    'I have considered the collision and the edit still has to happen',
  ]) {
    assert.equal(at(empty).rejected, 'ungrounded', `"${empty}" should not have been accepted`);
  }

  // An honest reason is about *this* collision, and still passes.
  for (const honest of [
    'my change is a new retry helper at the end of the file and does not go near deletedAt',
    "alice's soft-delete column is on the model; I am editing the serializer below it",
    'deletedAt keeps its name and type here — I only add a nullable column beside it',
  ]) {
    const verdict = at(honest);
    assert.equal(verdict.ok, true, `an honest reason was refused: ${honest} (${verdict.rejected})`);
    assert.equal(verdict.reason, honest);
  }

  // Naming the particulars is necessary, not sufficient: a sentence that says
  // them back and adds nothing of its own is the same reflex with keywords on.
  assert.equal(at('deletedAt alice deletedAt alice deletedAt').rejected, 'restated');

  // Checked against the agent's own task, too: restating the task you are
  // already on is not an argument that the collision is acceptable.
  const restated = at('I have to rename deletedAt on the user model', 'rename deletedAt on the user model');
  assert.equal(restated.ok, false);
  assert.equal(restated.rejected, 'restated');
  // Same task, a real claim about the collision: accepted.
  assert.equal(
    at('renaming deletedAt is the whole task and alice only reformatted around it', 'rename deletedAt on the user model').ok,
    true
  );

  // Deleting one character used to defeat the recycling check, because it
  // compared whole strings. It compares the claim now.
  const claim = 'the deletedAt column is unrelated to the retry logic I am adding at the bottom';
  const recycled = resolveAck(
    [{ token: 'ack_earlier', reason: `${claim}.` }, { token, reason: claim }],
    token,
    { grounding }
  );
  assert.equal(recycled.rejected, 'recycled');
});

test('a collision with nothing to check against does not become unacknowledgeable', () => {
  // No name, no symbols, same file, same branch: there is no particular an
  // honest sentence could be required to contain. A check that cannot be
  // satisfied is not a stricter check, it is an uninstalled hook.
  const facts = holderFacts({ minutes_ago: 2 }, 'src/models/user.ts', '');
  const grounding = ackGrounding(facts);
  assert.deepEqual(grounding.particulars, []);
  const token = 'ack_bare';
  const verdict = resolveAck(
    [{ token, reason: 'the file is a barrel of re-exports and my line is a new one at the end' }],
    token,
    { grounding }
  );
  assert.equal(verdict.ok, true);
});

test('the block message tells the agent exactly how to proceed, and why not to', () => {
  const advice = advise([HOLDER]);
  const block = buildStrictBlock(advice, { ackDir: '/tmp/agentmash', ackPath: '/tmp/agentmash/ack-s.log' });
  assert.ok(block.startsWith(advice.text), 'the guidance must survive the block, not be replaced by it');
  assert.match(block, /mkdir -p "\/tmp\/agentmash" && echo "ack_[a-z0-9]+ WHY-THIS-EDIT-STILL-NEEDS-TO-HAPPEN" >> "\/tmp\/agentmash\/ack-s\.log"/);
  assert.match(block, /expires 10 minutes after you first use it/);
  assert.match(block, /alice and the room dashboard will see that you overrode this/);
  assert.match(block, /Do not acknowledge on reflex/);

  // The block says what a reason is checked against, by name, because a check
  // the agent cannot see how to satisfy is a check it routes around.
  assert.match(block, /name deletedAt and alice in it/);
  assert.match(block, /I need to edit this file to complete my assigned task/);

  const retry = buildStrictBlock(advice, { ackDir: '/tmp/agentmash', ackPath: '/tmp/x.log', rejected: 'recycled' });
  assert.match(retry, /already given that same reason for a different collision/);
});

test('building a message stays far inside the advisory budget', () => {
  const holders = [HOLDER, { developer: 'bob', minutes_ago: 9, branch: 'main', file_path: 'src/models/user.ts' }];
  const { ms, limit } = timed(0.5 * 2000, () => {
    for (let i = 0; i < 2000; i++) advise(holders);
  });
  const perCallMs = ms / 2000;
  // The hook's budget is spent almost entirely on the network — see
  // `npm run bench:budget` — so the message must not be a line item at all.
  assert.ok(ms < limit, `message construction took ${perCallMs.toFixed(3)}ms per call`);
});

// ---------------------------------------------------------------------------
// Strict mode, end to end
// ---------------------------------------------------------------------------

function ackTokenFor(holder, myBranch = '') {
  return ackToken(holderFacts(holder, 'src/models/user.ts', myBranch));
}

function writeAck(sessionId, line) {
  const file = ackFile(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${line}\n`);
}

const strictHolder = {
  developer: 'alice',
  task_hint: 'add soft deletes',
  minutes_ago: 2,
  branch: 'main',
  file_path: 'src/models/user.ts',
  last_touched: '2026-08-30T14:32:01.000Z',
  change_summary: '+12/-3 lines, touching deletedAt',
};
const strictResponse = { conflict: true, holders: [strictHolder] };
const GOOD_REASON = 'my change is a new helper at the end of the file and does not touch deletedAt';

test('strict mode blocks with an acknowledge path an agent can complete alone', async () => {
  const mock = await startMockServer({ checkResponse: strictResponse });
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  try {
    const result = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, sessionId),
      hookEnv(projectDir, mock.port, { AGENTMASH_STRICT: '1' })
    );
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    const reason = out.permissionDecisionReason;
    assert.match(reason, /^\[AgentMash: ACTIVE COLLISION\]/);
    assert.ok(reason.includes(ackTokenFor(strictHolder)), 'the block must name this collision\'s token');
    assert.ok(reason.includes(ackFile(sessionId)), 'the block must name the exact file to append to');
    assert.match(reason, /mkdir -p /, 'the command must work without any prior setup');
  } finally {
    await mock.close();
  }
});

test('an acknowledgement unblocks the edit and the advisory still arrives', async () => {
  const mock = await startMockServer({ checkResponse: strictResponse });
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  try {
    writeAck(sessionId, `${ackTokenFor(strictHolder)} ${GOOD_REASON}`);
    const result = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, sessionId),
      hookEnv(projectDir, mock.port, { AGENTMASH_STRICT: '1' })
    );
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, undefined, 'an ack must not grant permission, only remove our block');
    assert.match(out.additionalContext, /^\[AgentMash: ACTIVE COLLISION\]/, 'passage is not silence');
    assert.match(out.additionalContext, /You acknowledged this collision/);
    assert.ok(out.additionalContext.includes(GOOD_REASON));
  } finally {
    await mock.close();
  }
});

test('a reflexive acknowledgement does not unblock anything', async () => {
  const mock = await startMockServer({ checkResponse: strictResponse });
  const projectDir = makeProjectDir();
  const token = ackTokenFor(strictHolder);
  try {
    for (const [line, expect] of [
      [`${token} ${ACK_PLACEHOLDER}`, /placeholder was still in it/],
      [`${token} need to edit`, /under 25 characters/],
      [`ack_somethingelse ${GOOD_REASON}`, /Run exactly this/],
    ]) {
      const sessionId = freshSession();
      writeAck(sessionId, line);
      const result = await runHook(
        'pre_tool_use.mjs',
        editStdin(projectDir, sessionId),
        hookEnv(projectDir, mock.port, { AGENTMASH_STRICT: '1' })
      );
      const out = JSON.parse(result.stdout).hookSpecificOutput;
      assert.equal(out.permissionDecision, 'deny', `"${line}" should not have unblocked`);
      assert.match(out.permissionDecisionReason, expect);
    }

    // The same sentence reused across two collisions is refused as the habit it is.
    const sessionId = freshSession();
    writeAck(sessionId, `ack_earliercollision ${GOOD_REASON}`);
    writeAck(sessionId, `${token} ${GOOD_REASON}`);
    const result = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, sessionId),
      hookEnv(projectDir, mock.port, { AGENTMASH_STRICT: '1' })
    );
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /already given that same reason/);
  } finally {
    await mock.close();
  }
});

test('the sentence that used to buy ten minutes now buys nothing, three edits running', async () => {
  // The review's own reproduction: 53 characters that restate the task, and
  // then three further edits to the same file went through unchallenged.
  const REVIEW_SENTENCE = 'I need to edit this file to complete my assigned task.';
  const mock = await startMockServer({ checkResponse: strictResponse });
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  try {
    writeAck(sessionId, `${ackTokenFor(strictHolder)} ${REVIEW_SENTENCE}`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await runHook(
        'pre_tool_use.mjs',
        editStdin(projectDir, sessionId),
        hookEnv(projectDir, mock.port, { AGENTMASH_STRICT: '1' })
      );
      const out = JSON.parse(result.stdout).hookSpecificOutput;
      assert.equal(out.permissionDecision, 'deny', `edit ${attempt} was allowed through`);
      assert.match(out.permissionDecisionReason, /named nothing from this collision/);
      // And the block says what would work, so this is a checkpoint and not a wall.
      assert.match(out.permissionDecisionReason, /name deletedAt and alice in it/);
    }
  } finally {
    await mock.close();
  }
});

test('a reason that is actually about the collision still gets through, first time', async () => {
  const HONEST = 'my retry helper is new code at the end of the file and leaves deletedAt exactly as alice wrote it';
  const mock = await startMockServer({ checkResponse: strictResponse });
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  try {
    writeAck(sessionId, `${ackTokenFor(strictHolder)} ${HONEST}`);
    const result = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, sessionId),
      hookEnv(projectDir, mock.port, { AGENTMASH_STRICT: '1' })
    );
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, undefined, 'an honest reason must not be blocked');
    assert.ok(out.additionalContext.includes(HONEST));
  } finally {
    await mock.close();
  }
});

test('a reason that only echoes this agent\'s own prompt is refused', async () => {
  const mock = await startMockServer({ checkResponse: strictResponse });
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  const env = hookEnv(projectDir, mock.port, { AGENTMASH_STRICT: '1' });
  try {
    await runHook(
      'user_prompt_submit.mjs',
      { session_id: sessionId, cwd: projectDir, prompt: 'rename deletedAt on the user model' },
      env
    );
    writeAck(sessionId, `${ackTokenFor(strictHolder)} I have to rename deletedAt on the user model`);
    const result = await runHook('pre_tool_use.mjs', editStdin(projectDir, sessionId), env);
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /only echoed this collision and the task you are on/);
  } finally {
    await mock.close();
  }
});

test('strict mode checks every edit, and an unreachable server costs under 2 s each time', async () => {
  // A server that is *down* refuses the connection in milliseconds. A server
  // that is unreachable — a firewall, a hung instance — answers nothing at all,
  // and the connecting socket outlives the AbortSignal. Strict mode has no
  // cooldown on purpose, so every edit pays this, and it has to stay small.
  // (TEST-NET-2 per RFC 5737. Where a network fails the connection fast this
  // test is weaker rather than flaky: the assertion holds either way.)
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await runHook('pre_tool_use.mjs', editStdin(projectDir, sessionId), {
      CLAUDE_PROJECT_DIR: projectDir,
      AGENTMASH_URL: 'http://198.51.100.1:8787',
      AGENTMASH_ROOM: ROOM,
      AGENTMASH_DEV: 'bob',
      AGENTMASH_STRICT: '1',
    });
    assert.equal(result.code, 0, 'an unreachable server must never block an edit');
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.ok(result.elapsed < within(2000), `edit ${attempt} waited ${result.elapsed}ms on an unreachable server`);
  }
});

test('an acknowledgement dies when the teammate writes again', async () => {
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  const first = await startMockServer({ checkResponse: strictResponse });
  try {
    writeAck(sessionId, `${ackTokenFor(strictHolder)} ${GOOD_REASON}`);
    const allowed = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, sessionId),
      hookEnv(projectDir, first.port, { AGENTMASH_STRICT: '1' })
    );
    assert.equal(JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision, undefined);
  } finally {
    await first.close();
  }

  // alice writes again: new timestamp, new token, and the old ack is worthless.
  const moved = { ...strictHolder, last_touched: '2026-08-30T14:41:00.000Z', minutes_ago: 0 };
  const second = await startMockServer({ checkResponse: { conflict: true, holders: [moved] } });
  try {
    const result = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, sessionId),
      hookEnv(projectDir, second.port, { AGENTMASH_STRICT: '1' })
    );
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny', 'a newer write must re-block');
    assert.ok(out.permissionDecisionReason.includes(ackTokenFor(moved)));
  } finally {
    await second.close();
  }
});

test('an acknowledgement expires instead of standing open', async () => {
  const mock = await startMockServer({ checkResponse: strictResponse });
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  try {
    const token = ackTokenFor(strictHolder);
    writeAck(sessionId, `${token} ${GOOD_REASON}`);
    // Backdate first use rather than waiting ten minutes for it.
    const cache = readSessionCache(sessionId);
    cache.acks = { [token]: Date.now() - 11 * 60_000 };
    writeSessionCache(sessionId, cache);

    const result = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, sessionId),
      hookEnv(projectDir, mock.port, { AGENTMASH_STRICT: '1' })
    );
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /more than 10 minutes old/);
  } finally {
    await mock.close();
  }
});

test('an override is published to the room on the next reported edit', async () => {
  const mock = await startMockServer({ checkResponse: strictResponse });
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  try {
    writeAck(sessionId, `${ackTokenFor(strictHolder)} ${GOOD_REASON}`);
    await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, sessionId),
      hookEnv(projectDir, mock.port, { AGENTMASH_STRICT: '1' })
    );
    await runHook(
      'post_tool_use.mjs',
      { ...editStdin(projectDir, sessionId), hook_event_name: 'PostToolUse' },
      hookEnv(projectDir, mock.port, { AGENTMASH_STRICT: '1' })
    );
    const edit = mock.requests.find((r) => r.body?.event_type === 'edit');
    assert.ok(edit, 'the edit should still be reported');
    assert.match(edit.body.change_summary, /^\+1\/-1 lines \[overrode alice: my change is a new helper/);

    // Published once, not stapled to every later edit in the session.
    await runHook(
      'post_tool_use.mjs',
      { ...editStdin(projectDir, sessionId), hook_event_name: 'PostToolUse' },
      hookEnv(projectDir, mock.port, { AGENTMASH_STRICT: '1' })
    );
    const edits = mock.requests.filter((r) => r.body?.event_type === 'edit');
    assert.ok(!/overrode/.test(edits[edits.length - 1].body.change_summary));
  } finally {
    await mock.close();
  }
});

test('strict mode still fails open when the server is down', async () => {
  const mock = await startMockServer();
  const deadPort = mock.port;
  await mock.close();
  const projectDir = makeProjectDir();
  const result = await runHook(
    'pre_tool_use.mjs',
    editStdin(projectDir, freshSession()),
    hookEnv(projectDir, deadPort, { AGENTMASH_STRICT: '1' })
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '', 'a dead server must never block an edit, even in strict mode');
  assert.ok(result.elapsed < within(2000));
});

// ---------------------------------------------------------------------------
// Prompt privacy
// ---------------------------------------------------------------------------

test('AGENTMASH_HINTS=0 keeps this developer\'s prompts off the wire', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  try {
    const env = hookEnv(projectDir, mock.port, { AGENTMASH_DEV: 'alice', AGENTMASH_HINTS: '0' });
    await runHook(
      'user_prompt_submit.mjs',
      { session_id: sessionId, cwd: projectDir, prompt: 'rotate the STRIPE_KEY in the billing service' },
      env
    );
    await runHook('post_tool_use.mjs', { ...editStdin(projectDir, sessionId), hook_event_name: 'PostToolUse' }, env);
    // and when the session ends: the prompt it was last on stays home too
    await runHook('session_end.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'SessionEnd', reason: 'exit' }, env);

    const reported = mock.requests.filter((r) => r.path === '/events');
    assert.equal(reported.length, 3, 'presence is still reported — only the prompt is withheld');
    for (const req of mock.requests) {
      assert.ok(!JSON.stringify(req).includes('STRIPE_KEY'), 'not in any request, its query included');
    }
    for (const req of reported) assert.equal(req.body.task_hint, null);
    assert.equal(reported[0].body.event_type, 'prompt');
    assert.equal(reported[1].body.developer, 'alice');
    assert.equal(reported[2].body.event_type, 'session_end');
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// A prompt is what the developer wrote
//
// UserPromptSubmit fires for every turn that enters the conversation as the
// user's, and Claude Code sends its own turns through the same door: a
// background task's notification, another session's message, a CI event, a
// loop wakeup. None of them is what this developer is working on, so none is
// reported, and none replaces the prompt their edits are still about. The
// desktop app's context wrapped around a real prompt is not part of it either.
// ---------------------------------------------------------------------------

/** A background task's notification, as Claude Code sends it when a task it started ends. */
const TASK_NOTIFICATION = [
  '<task-notification>',
  '<task-id>b8x2k1</task-id>',
  '<tool-use-id>toolu_01ABC</tool-use-id>',
  '<status>completed</status>',
  '<summary>Background command "npm test" completed (exit code 0)</summary>',
  '</task-notification>',
].join('\n');

test('a turn the harness sent is not a prompt: nothing is reported, and the real prompt stays the hint', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  try {
    const env = hookEnv(projectDir, mock.port, { AGENTMASH_DEV: 'alice' });
    /** One turn, as Claude Code runs it: the report, then the heads-up; what either prints goes to the agent. */
    const submit = async (prompt, extra = {}) => {
      const turn = { session_id: sessionId, cwd: projectDir, hook_event_name: 'UserPromptSubmit', prompt, ...extra };
      const reported = await runHook('user_prompt_submit.mjs', turn, env);
      const noted = await runHook('prompt_note.mjs', turn, env);
      return {
        code: reported.code || noted.code,
        stdout: reported.stdout + noted.stdout,
        stderr: reported.stderr + noted.stderr,
      };
    };

    await submit('add a role column to the user model');
    for (const [prompt, extra] of [
      [TASK_NOTIFICATION, {}], // Claude Code before 2.1.250 does not say who sent a turn
      [TASK_NOTIFICATION, { source: 'system' }], // from 2.1.250 it does
      [
        `[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n\n${TASK_NOTIFICATION}`,
        {},
      ],
      [
        'Another Claude session sent a message:\n<cross-session-message from="local_1" name="docs">rebase onto main</cross-session-message>\n\nThis came from another Claude session — not typed by your user.',
        {},
      ],
      ['<ci-monitor-event>CI failed on #51: 2 checks failing</ci-monitor-event>', {}],
      ['check the deploy', { source: 'loop_wakeup' }],
      ['check the deploy', { source: 'ci-monitor' }], // a raw wakeup source, outside the documented ones
    ]) {
      const result = await submit(prompt, extra);
      assert.equal(result.code, 0);
      assert.equal(result.stdout, '', 'nothing is added to the agent\'s context either');
      assert.equal(result.stderr, '');
    }
    assert.equal(
      readSessionCache(sessionId).task_hint,
      'add a role column to the user model',
      'the session cache still holds the real prompt'
    );

    await runHook('post_tool_use.mjs', { ...editStdin(projectDir, sessionId), hook_event_name: 'PostToolUse' }, env);
    const reported = mock.requests.filter((r) => r.path === '/events').map((r) => r.body);
    assert.deepEqual(reported.map((b) => b.event_type), ['prompt', 'edit'], 'the real prompt and the edit, nothing else');
    assert.equal(reported[1].task_hint, 'add a role column to the user model', 'the edit is still about the real prompt');
    assert.equal(mock.requests.filter((r) => r.path === '/team').length, 1, 'only the real prompt asked after the team');
    const wire = JSON.stringify(mock.requests);
    for (const leak of ['task-notification', 'SYSTEM NOTIFICATION', 'cross-session-message', 'ci-monitor-event', 'check the deploy']) {
      assert.ok(!wire.includes(leak), `${leak} must not reach the server`);
    }
  } finally {
    await mock.close();
  }
});

test('a real prompt the harness wrapped context around is reported without the wrapper', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  try {
    const env = hookEnv(projectDir, mock.port, { AGENTMASH_DEV: 'alice' });
    for (const prompt of [
      // the desktop app's context, ahead of what was typed
      '<system-reminder>\n<recent-project-folders>C:/a, C:/b</recent-project-folders>\n</system-reminder>\n\nadd a role column to the user model',
      // a notification that arrived with a prompt typed while the agent was busy
      `${TASK_NOTIFICATION}\r\n\r\nand bump the version while you are there`,
      // prose that only names the tags is the developer's own
      'skip harness blocks like <task-notification> and <system-reminder> in prompts',
    ]) {
      const result = await runHook(
        'user_prompt_submit.mjs',
        { session_id: sessionId, cwd: projectDir, hook_event_name: 'UserPromptSubmit', prompt },
        env
      );
      assert.equal(result.code, 0);
    }
    const hints = mock.requests.filter((r) => r.path === '/events').map((r) => r.body.task_hint);
    assert.deepEqual(hints, [
      'add a role column to the user model',
      'and bump the version while you are there',
      'skip harness blocks like <task-notification> and <system-reminder> in prompts',
    ]);
    assert.equal(
      readSessionCache(sessionId).task_hint,
      'skip harness blocks like <task-notification> and <system-reminder> in prompts'
    );
  } finally {
    await mock.close();
  }
});

test('userPromptText keeps what the developer wrote and none of what the harness did', async () => {
  const { userPromptText, HARNESS_TAGS } = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);
  const pasted = '<pasted_content id="d422">\nError: ECONNRESET at user.ts:14\n</pasted_content id="d422">';
  // [what it is, the hook's input, what is reported: '' is nothing at all]
  const cases = [
    ['a prompt', { prompt: 'fix the login redirect' }, 'fix the login redirect'],
    ['trimmed', { prompt: '  fix the login redirect\n' }, 'fix the login redirect'],
    ['the older payload key', { user_prompt: 'fix the login redirect' }, 'fix the login redirect'],
    ['no prompt', {}, ''],
    ['a prompt that is not text', { prompt: 42 }, ''],
    ['no input at all', null, ''],

    // Claude Code 2.1.250+ says who sent the turn; only a person or the SDK is a prompt
    ['typed, and says so', { prompt: 'rename the column', source: 'user' }, 'rename the column'],
    ['from the SDK', { prompt: 'rename the column', source: 'sdk' }, 'rename the column'],
    ['a system turn', { prompt: 'rename the column', source: 'system' }, ''],
    ['a loop wakeup', { prompt: 'check the deploy', source: 'loop_wakeup' }, ''],
    ['a scheduled wakeup', { prompt: 'check the deploy', source: 'schedule_wakeup' }, ''],
    ['a polled event', { prompt: 'check the deploy', source: 'poll_event' }, ''],
    ['a raw wakeup source', { prompt: 'CI failed', source: 'ci-monitor' }, ''],

    // and before 2.1.250 the turn names itself
    ['a task notification', { prompt: TASK_NOTIFICATION }, ''],
    ['a task notification, CRLF', { prompt: TASK_NOTIFICATION.replace(/\n/g, '\r\n') }, ''],
    ['a notification, then what was typed', { prompt: `${TASK_NOTIFICATION}\n\nalso bump the version` }, 'also bump the version'],
    ['what was typed, then a notification', { prompt: `also bump the version\n${TASK_NOTIFICATION}` }, 'also bump the version'],
    [
      'the system notification header',
      { prompt: `[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n${TASK_NOTIFICATION}` },
      '',
    ],
    [
      'a notification in a reminder, delivered with a real message',
      {
        prompt: `<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nIt is delivered in the same turn as a genuine message from the user.\n\n${TASK_NOTIFICATION}\n</system-reminder>\nwhy did the tests fail?`,
      },
      'why did the tests fail?',
    ],
    [
      'another session\'s message',
      {
        prompt:
          'Another Claude session sent a message:\n<cross-session-message from="local_1" name="docs">rebase onto main</cross-session-message>\n\nThis came from another Claude session — not typed by your user.',
      },
      '',
    ],
    [
      'another session\'s message, while working',
      { prompt: 'A peer session sent a message while you were working:\n<cross-session-message from="local_1">stop</cross-session-message>' },
      '',
    ],
    ['another session\'s message, bare', { prompt: '<cross-session-message from="local_1" name="docs">\nstopped.\n</cross-session-message>' }, ''],
    [
      'another session\'s message, its trailer left over',
      { prompt: '<cross-session-message from="local_1">stop</cross-session-message>\n\nThis came from another Claude session — not typed by your user.' },
      '',
    ],
    ['a CI event', { prompt: '<ci-monitor-event>CI failed on #51: 2 checks failing</ci-monitor-event>' }, ''],
    ['a slash command, as the transcript records it', { prompt: '<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>the auth PR</command-args>' }, ''],
    ['a local command\'s output', { prompt: '<local-command-stdout>Set model to opus</local-command-stdout>' }, ''],
    ['bash mode', { prompt: '<bash-input>git status</bash-input>' }, ''],
    ['a harness opener that never closed', { prompt: '<task-notification>\n<task-id>b1</task-id>\n<status>comp' }, ''],

    // context the desktop app wraps around a real prompt
    [
      'recent folders',
      { prompt: '<system-reminder>\n<recent-project-folders>C:/a, C:/b</recent-project-folders>\n</system-reminder>\n\nadd a role column' },
      'add a role column',
    ],
    ['the artifact on screen', { prompt: '<artifact-view-context artifact="x">viewing</artifact-view-context>\nmake the header smaller' }, 'make the header smaller'],
    ['the file open in the IDE', { prompt: '<ide_opened_file>The user opened a.ts in the IDE.</ide_opened_file>\nwhy is this slow' }, 'why is this slow'],
    ['indented', { prompt: '  <system-reminder>\n  context\n  </system-reminder>\nwhy is this slow' }, 'why is this slow'],
    ['self-closing', { prompt: '<artifact-content-authored-by-others/>\nsummarize it' }, 'summarize it'],

    // a paste is the developer's own, and the prompt when nothing was typed around it
    ['a paste and a question', { prompt: `why does this fail?\n\n${pasted}\n` }, 'why does this fail?'],
    ['only a paste', { prompt: pasted }, 'Error: ECONNRESET at user.ts:14'],

    // what merely looks like the harness is left alone
    [
      'prose that names the tags',
      { prompt: 'skip blocks like <task-notification> and <system-reminder> in prompts' },
      'skip blocks like <task-notification> and <system-reminder> in prompts',
    ],
    [
      'a tag quoted inside a sentence',
      { prompt: 'what does `<system-reminder>x</system-reminder>` mean here?' },
      'what does `<system-reminder>x</system-reminder>` mean here?',
    ],
    ['markup of their own', { prompt: '<div class="hero">\n  make this <b>bold</b>\n</div>' }, '<div class="hero">\n  make this <b>bold</b>\n</div>'],
    ['a tag with a harness-like prefix', { prompt: '<system-reminders>\nlist\n</system-reminders>' }, '<system-reminders>\nlist\n</system-reminders>'],
  ];
  for (const [name, input, want] of cases) assert.equal(userPromptText(input), want, name);

  assert.ok(Object.isFrozen(HARNESS_TAGS));
  for (const tag of ['task-notification', 'system-reminder', 'cross-session-message', 'ci-monitor-event', 'command-name']) {
    assert.ok(HARNESS_TAGS.includes(tag), tag);
  }
  assert.ok(!HARNESS_TAGS.includes('pasted_content'), 'a paste is the developer\'s, not the harness\'s');
});

test('a paste full of harness-looking lines is cleaned in one pass, not one per line', async () => {
  const { userPromptText } = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);
  // An RSS feed, say: <channel> is one of Claude Code's tags. Twenty thousand
  // openers with no closer must not each search the rest of half a megabyte,
  // because the login hooks run this in line, before the prompt is sent.
  const wall = Array.from({ length: 20_000 }, (_, i) => `<channel> item ${i} of the feed`).join('\n');
  const { ms, limit, value } = timed(200, () => [userPromptText({ prompt: wall }), userPromptText({ prompt: `read this feed\n${wall}` })]);
  assert.equal(value[0], '', 'an opener that never closed is still the harness');
  assert.equal(value[1], `read this feed\n${wall}`);
  assert.ok(ms < limit, `took ${Math.round(ms)}ms on ${(wall.length / 1024) | 0} KB`);
});

// ---------------------------------------------------------------------------
// The prompt behind each edit
//
// An edit is reported with the prompt that caused it, which is not always the
// session's newest. A subagent spawned for one prompt keeps editing after the
// developer has asked for the next, and PreToolUse holds the session cache
// across a /check round trip while a new prompt can be written under it.
// ---------------------------------------------------------------------------

const ROLE_PROMPT = 'add role and isAdmin to the user model';
const README_PROMPT = 'fix the typo in the README';

/** Poll until `done()` holds, for what a hook writes to disk while another is still running. */
async function until(done, what, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('a prompt submitted while PreToolUse waits on /check is not lost', async () => {
  // /check answers slowly and reports a collision, so PreToolUse is still
  // waiting when the developer's next prompt lands, and writes its advisory
  // cooldown to the session cache after that.
  const mock = await startMockServer({ delayMs: 1500, checkResponse: conflictCheckResponse });
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  const env = hookEnv(projectDir, mock.port, { AGENTMASH_DEV: 'alice', AGENTMASH_TIMEOUT_MS: '3000' });
  const submit = (prompt) =>
    runHook('user_prompt_submit.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'UserPromptSubmit', prompt }, env);
  try {
    await submit(ROLE_PROMPT);
    const pre = runHook('pre_tool_use.mjs', editStdin(projectDir, sessionId), env);
    let preDone = false;
    pre.then(() => (preDone = true));
    await until(() => mock.requests.some((r) => r.path === '/check'), 'PreToolUse to ask /check');
    const second = submit(README_PROMPT);
    await until(() => readSessionCache(sessionId).task_hint === README_PROMPT, 'the second prompt to be cached');
    assert.equal(preDone, false, 'the new prompt landed while PreToolUse was still waiting');
    const [advised] = await Promise.all([pre, second]);
    assert.match(advised.stdout, /refactor the user model/, 'and PreToolUse still advised');

    await runHook('post_tool_use.mjs', { ...editStdin(projectDir, sessionId, 'README.md'), hook_event_name: 'PostToolUse' }, env);
    const edit = mock.requests.find((r) => r.path === '/events' && r.body.event_type === 'edit');
    assert.equal(edit.body.task_hint, README_PROMPT, 'the README edit is about the README prompt');
    const cache = readSessionCache(sessionId);
    assert.equal(cache.task_hint, README_PROMPT, 'nothing wrote the older prompt back');
    assert.ok(cache.advised?.['src/models/user.ts'], 'and the cooldown PreToolUse wrote is kept too');
  } finally {
    await mock.close();
  }
});

test('a subagent\'s edits carry the prompt it was spawned under, and which prompt that was', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  const env = hookEnv(projectDir, mock.port, { AGENTMASH_DEV: 'alice' });
  const submit = (prompt) =>
    runHook('user_prompt_submit.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'UserPromptSubmit', prompt }, env);
  const edit = (hook, rel, agent = {}) =>
    runHook(hook, { ...editStdin(projectDir, sessionId, rel), hook_event_name: hook === 'pre_tool_use.mjs' ? 'PreToolUse' : 'PostToolUse', ...agent }, env);
  const early = { agent_id: 'a1b2c3d4', agent_type: 'general-purpose' };
  const late = { agent_id: 'e5f6a7b8', agent_type: 'Explore' };
  try {
    await submit(ROLE_PROMPT);
    // the subagent that prompt started reaches for its first file
    await edit('pre_tool_use.mjs', 'src/models/user.ts', early);
    await submit(README_PROMPT);
    await submit(TASK_NOTIFICATION); // the harness's turn is nobody's prompt
    // the subagent's edit is reported after the developer has moved on
    await edit('post_tool_use.mjs', 'src/models/user.ts', early);
    await edit('pre_tool_use.mjs', 'src/api/users.ts', early);
    await edit('post_tool_use.mjs', 'src/api/users.ts', early);
    // the main agent's edit, and a subagent the second prompt started
    await edit('post_tool_use.mjs', 'README.md');
    await edit('pre_tool_use.mjs', 'docs/setup.md', late);
    await edit('post_tool_use.mjs', 'docs/setup.md', late);

    const sent = mock.requests.filter((r) => r.path === '/events').map((r) => r.body);
    const prompts = sent.filter((e) => e.event_type === 'prompt');
    const edits = sent.filter((e) => e.event_type === 'edit');
    assert.deepEqual(prompts.map((e) => e.task_hint), [ROLE_PROMPT, README_PROMPT]);
    assert.deepEqual(
      edits.map((e) => [e.file_path, e.task_hint]),
      [
        ['src/models/user.ts', ROLE_PROMPT],
        ['src/api/users.ts', ROLE_PROMPT],
        ['README.md', README_PROMPT],
        ['docs/setup.md', README_PROMPT],
      ]
    );
    // and the id of that prompt, so the room can tell two prompts apart
    // without reading them (hints off sends the id and no text)
    const [role, readme] = prompts;
    for (const p of prompts) assert.match(p.prompt_id ?? '', /^[A-Za-z0-9_-]{1,64}$/, 'an id the server keeps');
    assert.notEqual(role.prompt_id, readme.prompt_id);
    assert.deepEqual(
      edits.map((e) => e.prompt_id),
      [role.prompt_id, role.prompt_id, readme.prompt_id, readme.prompt_id]
    );
  } finally {
    await mock.close();
  }
});

test('a subagent\'s pin survives a hook writing back the session cache it read before the pin', async () => {
  // Hooks read the session cache, wait, and write it back: PreToolUse after
  // /check, and every subagent at work in parallel doing the same. A pin kept
  // in that cache went whenever one of them wrote back a copy from before it,
  // and the developer's next prompt then became the subagent's.
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  const env = hookEnv(projectDir, mock.port, { AGENTMASH_DEV: 'alice' });
  const submit = (prompt) =>
    runHook('user_prompt_submit.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'UserPromptSubmit', prompt }, env);
  const subagent = { agent_id: 'a1b2c3d4', agent_type: 'general-purpose' };
  try {
    await submit(ROLE_PROMPT);
    // what another subagent's PreToolUse read before this one's pin, and writes back after it
    const stale = readSessionCache(sessionId);
    await runHook('pre_tool_use.mjs', { ...editStdin(projectDir, sessionId), ...subagent }, env);
    writeSessionCache(sessionId, { ...stale, advised: { 'src/api/users.ts': Date.now() } });
    await submit(README_PROMPT);
    await runHook('post_tool_use.mjs', { ...editStdin(projectDir, sessionId), hook_event_name: 'PostToolUse', ...subagent }, env);

    const sent = mock.requests.filter((r) => r.path === '/events').map((r) => r.body);
    const [role] = sent.filter((e) => e.event_type === 'prompt');
    const edit = sent.find((e) => e.event_type === 'edit');
    assert.equal(edit.task_hint, ROLE_PROMPT, 'still the prompt that started the subagent');
    assert.equal(edit.prompt_id, role.prompt_id);
  } finally {
    await mock.close();
  }
});

test('the team note pairs each file with the prompt it was edited for, not the teammate\'s newest', async () => {
  const { buildTeamContext } = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);
  const alice = {
    developer: 'alice',
    presence: 'active',
    minutes_ago: 2,
    branch: 'main',
    prompt: README_PROMPT,
    files: ['src/models/user.ts', 'src/api/users.ts'],
    edits: [
      { file_path: 'src/models/user.ts', task_hint: ROLE_PROMPT, ts: 1 },
      { file_path: 'src/api/users.ts', task_hint: ROLE_PROMPT, ts: 1 },
    ],
  };
  const line = (team, opts) => buildTeamContext(team, opts).split('\n').find((l) => l.startsWith('- alice'));

  const paired = line({ developers: [alice] });
  assert.ok(paired.includes(`"${README_PROMPT}"`), 'what alice is on now is still said');
  assert.match(paired, /src\/models\/user\.ts, src\/api\/users\.ts for "add role and isAdmin to the user model"/);
  assert.doesNotMatch(paired, /"fix the typo in the README" — editing src\/models\/user\.ts/);

  // every file edited for the newest prompt: the line reads as it always did
  const same = { ...alice, prompt: ROLE_PROMPT };
  assert.equal(
    line({ developers: [same] }),
    '- alice, 2 min ago on main: "add role and isAdmin to the user model" — editing src/models/user.ts, src/api/users.ts'
  );
  // a server from before `edits`: today's line, unchanged
  const { edits: _edits, ...older } = alice;
  assert.equal(
    line({ developers: [older] }),
    '- alice, 2 min ago on main: "fix the typo in the README" — editing src/models/user.ts, src/api/users.ts'
  );
  // hints off: no prompt at all, the files still named
  const quiet = line({ developers: [alice] }, { showHints: false });
  assert.doesNotMatch(quiet, /README|role/);
  assert.match(quiet, /src\/models\/user\.ts, src\/api\/users\.ts/);
});

test('today\'s hooks beside a lib.mjs from before the prompt file still send each edit its prompt', async () => {
  const vendored = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-oldlib-'));
  const oldLib = fs.readFileSync(path.join(HOOKS_DIR, 'lib.mjs'), 'utf8').split('// ── symbol extraction')[0];
  fs.writeFileSync(path.join(vendored, 'lib.mjs'), oldLib);
  for (const script of ['user_prompt_submit.mjs', 'pre_tool_use.mjs', 'post_tool_use.mjs', 'session_end.mjs']) {
    fs.copyFileSync(path.join(HOOKS_DIR, script), path.join(vendored, script));
  }
  for (const helper of ['readPrompt', 'writePrompt', 'pinAgentPrompt', 'promptForEdit']) {
    assert.ok(!oldLib.includes(`function ${helper}(`), `the stand-in lib must really lack ${helper}`);
  }
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  const run = (script, payload) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(vendored, script)], {
        env: { ...baseEnv, ...hookEnv(projectDir, mock.port, { AGENTMASH_DEV: 'alice' }) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(payload));
    });
  const agent = { agent_id: 'a1b2c3d4', agent_type: 'general-purpose' };
  try {
    const results = [
      await run('user_prompt_submit.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'UserPromptSubmit', prompt: ROLE_PROMPT }),
      await run('pre_tool_use.mjs', { ...editStdin(projectDir, sessionId), ...agent }),
      await run('post_tool_use.mjs', { ...editStdin(projectDir, sessionId), hook_event_name: 'PostToolUse', ...agent }),
      await run('session_end.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'SessionEnd', reason: 'exit' }),
    ];
    for (const result of results) {
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '', `no link error: ${result.stderr}`);
    }
    const sent = mock.requests.filter((r) => r.path === '/events').map((r) => r.body);
    assert.deepEqual(
      sent.map((e) => [e.event_type, e.task_hint, e.prompt_id ?? null]),
      [
        ['prompt', ROLE_PROMPT, null],
        ['edit', ROLE_PROMPT, null],
        ['session_end', ROLE_PROMPT, null],
      ],
      'the prompt still reaches every event, as it did before; there is just no id to go with it'
    );
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Presence
//
// The design adds no client-side work to the edit path: no timer, no extra
// request, no extra field on Write/Edit/MultiEdit. These tests hold that line,
// cover what session_end now reports, and check both directions of version
// skew — a new hook against an old server, and an old hook's payload against a
// new one.
// ---------------------------------------------------------------------------

function presenceHolder(overrides = {}) {
  return {
    conflict: true,
    holders: [
      {
        developer: 'alice',
        task_hint: 'refactor the user model',
        last_touched: new Date(Date.now() - 20 * 60_000).toISOString(),
        minutes_ago: 20,
        branch: 'feat/user-model',
        file_path: 'src/models/user.ts',
        ...overrides,
      },
    ],
    window_minutes: 30,
    scope: 'file',
  };
}

test('session_end reports why the session ended', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    await runHook(
      'session_end.mjs',
      { session_id: freshSession(), cwd: projectDir, hook_event_name: 'SessionEnd', reason: 'logout' },
      hookEnv(projectDir, mock.port, { AGENTMASH_DEV: 'alice' })
    );
    assert.equal(mock.requests[0].body.end_reason, 'logout');
  } finally {
    await mock.close();
  }
});

test('session_end normalizes a reason it does not recognize, and copes with none', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    await runHook(
      'session_end.mjs',
      { session_id: freshSession(), cwd: projectDir, hook_event_name: 'SessionEnd', reason: 'WAT-1' },
      hookEnv(projectDir, mock.port)
    );
    await runHook(
      'session_end.mjs',
      { session_id: freshSession(), cwd: projectDir, hook_event_name: 'SessionEnd' },
      hookEnv(projectDir, mock.port)
    );
    assert.equal(mock.requests[0].body.end_reason, 'other', 'junk must not reach the board verbatim');
    assert.equal(mock.requests[1].body.end_reason, null);
  } finally {
    await mock.close();
  }
});

test('session_end clears the session scratch file it is done with', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  const sessionId = freshSession();
  const env = hookEnv(projectDir, mock.port);
  const submit = (prompt) =>
    runHook('user_prompt_submit.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'UserPromptSubmit', prompt }, env);
  /** Everything in the scratch directory that is this session's. */
  const scratch = () => {
    try {
      return fs.readdirSync(path.join(os.tmpdir(), 'agentmash'), { recursive: true }).filter((p) => String(p).includes(sessionId));
    } catch {
      return [];
    }
  };
  const subagent = 'a1b2c3d4';
  try {
    await submit('ship it');
    await runHook('pre_tool_use.mjs', { ...editStdin(projectDir, sessionId), agent_id: subagent, agent_type: 'general-purpose' }, env);
    await submit('and tag the release');
    const cacheFile = path.join(os.tmpdir(), 'agentmash', `${sessionId}.json`);
    assert.ok(fs.existsSync(cacheFile), 'the prompt hook should have written a task hint');
    assert.equal(readPrompt(sessionId).task_hint, 'and tag the release', 'and the prompt the edits after it are for');
    assert.equal(promptForEdit(sessionId, subagent).task_hint, 'ship it', 'and the one the subagent started under');

    await runHook('session_end.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'SessionEnd', reason: 'exit' }, env);
    const ended = mock.requests.find((r) => r.path === '/events' && r.body.event_type === 'session_end');
    assert.equal(ended.body.task_hint, 'and tag the release', 'the hint still rides along with the end');
    assert.ok(!fs.existsSync(cacheFile), 'and the file is gone afterwards');
    assert.deepEqual(scratch(), [], 'as is everything else the session kept: its prompt, the subagent\'s');
    assert.equal(promptForEdit(sessionId, subagent).task_hint, null);
  } finally {
    await mock.close();
  }
});

test('a new session_end against a server that rejects it still exits 0, silently', async () => {
  // An old server validates the body it knows and 400s the rest; the hook must
  // not care, and must not slow the shutdown down.
  const mock = await startMockServer({ status: 400 });
  const projectDir = makeProjectDir();
  try {
    const result = await runHook(
      'session_end.mjs',
      { session_id: freshSession(), cwd: projectDir, hook_event_name: 'SessionEnd', reason: 'clear' },
      hookEnv(projectDir, mock.port)
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.ok(result.elapsed < within(2500), `session_end took ${result.elapsed}ms`);
  } finally {
    await mock.close();
  }
});

test('the advisory says so when the teammate it names has stopped', async () => {
  const mock = await startMockServer({
    checkResponse: presenceHolder({
      presence: 'stale',
      presence_label: 'has sent nothing for 22 min and appears to have stopped',
    }),
  });
  const projectDir = makeProjectDir();
  try {
    const result = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, freshSession()),
      hookEnv(projectDir, mock.port)
    );
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /alice's agent modified src\/models\/user\.ts 20 min ago/);
    assert.match(context, /alice has sent nothing for 22 min and appears to have stopped\./);
  } finally {
    await mock.close();
  }
});

test('the advisory stays quiet about presence when the teammate is still working', async () => {
  const mock = await startMockServer({
    checkResponse: presenceHolder({
      minutes_ago: 2,
      presence: 'active',
      presence_label: 'is working right now',
    }),
  });
  const projectDir = makeProjectDir();
  try {
    const result = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, freshSession()),
      hookEnv(projectDir, mock.port)
    );
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    // fix/ack-and-summary rewrote the advisory; at 2 min the shape is ACTIVE
    // COLLISION. What this test is about is unchanged: no presence sentence.
    assert.match(context, /alice's agent is working in src\/models\/user\.ts/);
    assert.doesNotMatch(context, /is working right now/, '"2 min ago" already said that');
  } finally {
    await mock.close();
  }
});

test('a teammate who has gone quiet no longer produces an ACTIVE COLLISION, end to end', async () => {
  // The whole point of the branch, through the real hook: a write two minutes
  // old is still in this working tree and still has to be re-read, but the
  // board has not heard from its author in twenty minutes, so the message stops
  // announcing that someone is editing alongside this agent.
  const projectDir = makeProjectDir();
  const mock = await startMockServer({
    checkResponse: presenceHolder({
      minutes_ago: 2,
      presence: 'stale',
      presence_label: 'has sent nothing for 20 min and appears to have stopped',
      // in this very checkout, where her write is in the working tree
      checkout_id: ownCheckoutId(projectDir),
    }),
  });
  try {
    const result = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, freshSession()),
      hookEnv(projectDir, mock.port)
    );
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /^\[AgentMash: STALE READ\]/);
    assert.doesNotMatch(context, /ACTIVE COLLISION/);
    assert.match(context, /Re-read src\/models\/user\.ts now/, 'the staleness is still real');
    assert.match(context, /timeout on the board's clock rather than a goodbye/);
  } finally {
    await mock.close();
  }
});

test('an old server that sends no presence at all produces the advisory it always did', async () => {
  const mock = await startMockServer({ checkResponse: conflictCheckResponse });
  const projectDir = makeProjectDir();
  try {
    const result = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, freshSession()),
      hookEnv(projectDir, mock.port)
    );
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /alice's agent is working in src\/models\/user\.ts — last write 4 min ago/);
    assert.doesNotMatch(context, /appears to have stopped/);
  } finally {
    await mock.close();
  }
});

test('presence adds nothing to what the edit path sends or waits for', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    const post = await runHook(
      'post_tool_use.mjs',
      { ...editStdin(projectDir, freshSession()), hook_event_name: 'PostToolUse' },
      hookEnv(projectDir, mock.port)
    );
    assert.equal(post.code, 0);
    assert.equal(mock.requests.length, 1, 'still exactly one request per edit — no heartbeat');
    assert.equal(mock.requests[0].body.event_type, 'edit');

    const pre = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, freshSession()),
      hookEnv(projectDir, mock.port)
    );
    assert.equal(pre.code, 0);
    assert.equal(mock.requests.length, 2, 'and exactly one /check before it');
    assert.ok(pre.elapsed < within(1500), `pre_tool_use took ${pre.elapsed}ms — the advisory budget is 1500ms`);
  } finally {
    await mock.close();
  }
});

// ── the MCP launcher ───────────────────────────────────────────────────────

/**
 * Node's `spawn` has refused `.cmd` and `.bat` without `shell: true` since the
 * BatBadBut fix (18.20.2 / 20.12.2 / 21.7.3): it throws EINVAL. The launcher
 * catches that and degrades, so the cost was invisible — layer 2 simply never
 * ran on Windows.
 */
test('layer 2 is spawned in a form Windows can actually run', () => {
  const posix = npxInvocation('linux', 'agentmash@1.2.3');
  assert.equal(posix.command, 'npx');
  assert.equal(posix.shell, false);
  assert.deepEqual(posix.args, ['--yes', '--package', 'agentmash@1.2.3', '--', 'agentmash', 'mcp']);

  const win = npxInvocation('win32', 'C:\\Users\\a b\\agentmash.tgz');
  assert.equal(win.shell, true);
  // one command line, quoted for the shell: arguments beside shell: true are
  // joined as they are, and Node 24 warns about it (DEP0190)
  assert.deepEqual(win.args, []);
  assert.equal(
    win.command,
    'npx.cmd --yes --package "C:\\Users\\a b\\agentmash.tgz" -- agentmash mcp',
    'a shell means every argument that could be split has to be quoted, and plain flags stay unquoted'
  );
});

/**
 * stdout is the protocol. An npm notice on it would be injected mid-stream, and
 * — worse — was taken as proof the child had answered, which permanently
 * disabled the fallback to the degraded server.
 */
test('only a JSON-RPC line counts as the npx child speaking', () => {
  assert.equal(isJsonRpcLine('{"jsonrpc":"2.0","id":1,"result":{}}'), true);
  assert.equal(isJsonRpcLine('npm notice New major version of npm available!'), false);
  assert.equal(isJsonRpcLine('{"id":1,"result":{}}'), false, 'JSON alone is not the protocol');
  assert.equal(isJsonRpcLine('[{"jsonrpc":"2.0"}]'), false);
  assert.equal(isJsonRpcLine(''), false);
});

// ---------------------------------------------------------------------------
// Symbol extraction
//
// The fixtures are this repository's own source, because a regex extractor that
// only works on hand-written examples is a demo, not a feature.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.dirname(HOOKS_DIR);
// The server's source is not in the public client repository; these read it when it is there.
const NO_SERVER = !fs.existsSync(path.join(REPO_ROOT, 'server', 'src', 'db.ts')) && 'needs the server source';

function writeFile(dir, rel, content) {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

test('extraction names the exports of this repo\'s own files', { skip: NO_SERVER }, async () => {
  const { symbolsForFile, supportsSymbols } = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);

  const db = symbolsForFile(path.join(REPO_ROOT, 'server', 'src', 'db.ts'));
  for (const name of ['Store', 'normalizeFilePath', 'dirOf', 'newRoomId', 'Holder', 'EventRow']) {
    assert.ok(db.includes(name), `db.ts should surface ${name}, got ${db.join(', ')}`);
  }
  // Granularity is the importable name, not the member: `Store.findHolders` is
  // reached through `Store`, which is also what a dependent file imports.
  assert.ok(!db.includes('findHolders'), 'class members are not separate symbols');

  // app.ts imports from db.ts — that edge is what makes cross-file matching work.
  const app = symbolsForFile(path.join(REPO_ROOT, 'server', 'src', 'app.ts'));
  for (const name of ['Store', 'looksLikeRoomId', 'createApp', 'buildInstallPlan']) {
    assert.ok(app.includes(name), `app.ts should surface ${name}, got ${app.join(', ')}`);
  }
  assert.ok(
    db.includes('Store') && app.includes('Store'),
    'the db.ts -> app.ts edge is the one the whole feature rests on'
  );

  assert.ok(supportsSymbols('a.tsx') && supportsSymbols('a.mjs') && supportsSymbols('a.cjs'));
  assert.ok(!supportsSymbols('a.py') && !supportsSymbols('a.go') && !supportsSymbols('Makefile'));
});

test('extraction claims exports only — never locals, never noise', async () => {
  const { symbolsForFile } = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);
  const dir = makeProjectDir();
  const file = writeFile(
    dir,
    'sample.ts',
    [
      "import { Store, type EventInput } from './db.js';",
      "import defaultThing from 'pkg';",
      "import * as helpers from './helpers.js';",
      'const localCounter = 0;',
      'let scratchValue = 1;',
      'function privateHelper() { return localCounter; }',
      'export interface PublicShape { id: string }',
      'export type PublicAlias = PublicShape;',
      'export const PUBLIC_CONST = 1;',
      'export async function publicFn(input: string) {',
      '  const inner = input;',
      '  return inner;',
      '}',
      'export default class PublicClass {}',
      'export { privateHelper as renamedHelper };',
    ].join('\n')
  );
  const got = symbolsForFile(file);
  for (const name of [
    'PublicShape', 'PublicAlias', 'PUBLIC_CONST', 'publicFn', 'PublicClass', 'renamedHelper',
    'Store', 'EventInput', 'defaultThing', 'helpers',
  ]) {
    assert.ok(got.includes(name), `expected ${name}, got ${got.join(', ')}`);
  }
  for (const name of ['localCounter', 'scratchValue', 'privateHelper', 'inner', 'input']) {
    assert.ok(!got.includes(name), `${name} is not part of the API surface, but was claimed`);
  }
});

test('imports name what a file takes by its name in the file it comes from', async () => {
  const { bindingsForFile, symbolsForFile } = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);
  const dir = makeProjectDir();
  const file = writeFile(
    dir,
    'renames.ts',
    [
      "import { createUser as baseCreateUser, type Account as AccountRow } from '../models/user';",
      "import { default as Button } from './Button';",
      "export { createClient as makeClient, default as Card } from './client';",
      "const { listUsers: allUsers } = require('../models/user');",
      'export function createUser(email) { return { ...baseCreateUser(email), admin: true }; }',
    ].join('\n')
  );
  const got = bindingsForFile(file);
  // The other file's createUser, Account, createClient and listUsers; a
  // default has no name of its own there, so it goes by the one given here.
  assert.deepEqual(
    [...got.imports].sort(),
    ['Account', 'Button', 'Card', 'createClient', 'createUser', 'listUsers']
  );
  // What this file exports is still its own names.
  for (const name of ['createUser', 'makeClient', 'Card']) {
    assert.ok(got.symbols.includes(name), `expected ${name} in ${got.symbols.join(', ')}`);
  }
  // and symbols is what it always was, names as they go by here: what
  // `npm run bench:symbols` measures against the compiler, and what a server
  // from before `imports` matches with
  assert.deepEqual(got.symbols, symbolsForFile(file));
  assert.deepEqual(
    [...got.symbols].sort(),
    ['AccountRow', 'Button', 'Card', 'baseCreateUser', 'createUser', 'makeClient']
  );

  // a name too short to send here still takes a long one from there
  const short = writeFile(dir, 'short.ts', "import { createUser as mk } from '../models/user';\n\nmk('a@b.c');\n");
  assert.deepEqual(bindingsForFile(short), { symbols: [], imports: ['createUser'] });
  assert.equal(symbolsForFile(short), null);
});

test('before an edit, its own exports are the ones its old text is in, or all of them when that is unsure', async () => {
  const { bindingsForFile, symbolsBeforeEdit } = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);
  const dir = makeProjectDir();
  const file = writeFile(
    dir,
    'user.ts',
    [
      "import { database } from './db';",
      'export interface User {',
      '  id: string;',
      '}',
      '',
      'export function createUser(email: string): User {',
      '  return { id: email };',
      '}',
      '',
      'function audit(u: User) {',
      "  return database.log('audit', u.id);",
      '}',
      '',
      'export function deleteUser(u: User): void {',
      "  console.log('bye', u.id);",
      '}',
      '',
    ].join('\n')
  );
  const edit = (old_string) => ({ file_path: file, old_string, new_string: `${old_string} // x` });

  assert.deepEqual(symbolsBeforeEdit(file, 'Edit', edit("console.log('bye', u.id);")), ['deleteUser']);
  assert.deepEqual(
    symbolsBeforeEdit(file, 'Edit', { file_path: file, old_string: 'export function createUser(', new_string: 'export function makeUser(' }).sort(),
    ['createUser', 'makeUser'],
    'a rename names both sides'
  );
  assert.deepEqual(
    symbolsBeforeEdit(file, 'MultiEdit', { file_path: file, edits: [edit('return { id: email };'), edit("console.log('bye', u.id);")] }).sort(),
    ['createUser', 'deleteUser']
  );
  // a helper, a line the file doesn't have yet, a Write: anything could be in play
  assert.equal(symbolsBeforeEdit(file, 'Edit', edit("return database.log('audit', u.id);")), null);
  assert.equal(symbolsBeforeEdit(file, 'Edit', edit('return { id: email.trim() };')), null);
  assert.equal(symbolsBeforeEdit(file, 'Write', { file_path: file, content: 'export const x = 1;\n' }), null);

  // and what the file is bound to keeps its imports, with only those exports
  assert.deepEqual(bindingsForFile(file, { editing: ['deleteUser'] }).symbols, ['deleteUser', 'database']);
  assert.deepEqual(bindingsForFile(file).symbols, ['User', 'createUser', 'deleteUser', 'database']);
});

test('extraction reads code, and not commented-out code or template literals', async () => {
  const { symbolsForFile, symbolsForEdit } = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);
  const dir = makeProjectDir();
  const content = [
    'export function live() { return 1; }',
    '/*',
    'export function retiredApi(a, b) { return a + b; }',
    '*/',
    '// export const lineCommented = 1;',
    'export const snippet = `',
    'export class InsideATemplate {}',
    "import { fromInsideATemplate } from './x.js';",
    '`;',
    // An unbalanced `/*` inside a string used to open a comment that never closed,
    // which swallowed the rest of the file.
    "const url = 'https://example.com/*';",
    'export function afterTheString() { return url; }',
    // Code generators build source as strings; that source is not this file's.
    "const emitted = 'const Generated = require(\\'./generated\\')';",
  ].join('\n');
  const file = writeFile(dir, 'commented.ts', content);

  const got = symbolsForFile(file);
  for (const name of ['live', 'snippet', 'afterTheString']) {
    assert.ok(got.includes(name), `expected ${name}, got ${got.join(', ')}`);
  }
  for (const name of ['retiredApi', 'lineCommented', 'InsideATemplate', 'fromInsideATemplate', 'Generated']) {
    assert.ok(!got.includes(name), `${name} is not code, but was claimed: ${got.join(', ')}`);
  }

  // A Write claims every export in the file, so it is the loudest way a phantom
  // reaches the server's definition side.
  const written = symbolsForEdit(file, 'Write', { content });
  assert.ok(!written.includes('retiredApi'), `a Write claimed a commented-out export: ${written.join(', ')}`);

  // The instance that prompted this: a real dependency in this checkout carries a
  // 100-line commented-out `export function addOriginalScope`.
  const real = path.join(REPO_ROOT, 'node_modules', '@jridgewell', 'gen-mapping', 'src', 'gen-mapping.ts');
  if (fs.existsSync(real) && fs.readFileSync(real, 'utf8').includes('export function addOriginalScope')) {
    const claimed = symbolsForFile(real) || [];
    assert.ok(
      !claimed.includes('addOriginalScope'),
      `gen-mapping's commented-out export was claimed: ${claimed.join(', ')}`
    );
  }
});

test('blanking keeps every offset, including on CRLF files', async () => {
  const { scrubForScan } = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);
  const source = [
    'export const a = 1; // trailing',
    '/* two',
    '   lines */',
    'export const b = `x${ `nested` }y`;',
    "export const c = 'quoted';",
    'const re = /[/*]/;',
    'export const d = 4;',
  ].join('\r\n');
  const scrubbed = scrubForScan(source);
  assert.equal(scrubbed.length, source.length, 'offsets into the original must stay valid');
  assert.equal(
    scrubbed.split('\n').length,
    source.split('\n').length,
    'line structure must survive, or line-anchored matching moves'
  );
  assert.ok(!scrubbed.includes('trailing') && !scrubbed.includes('two'), 'comments are gone');
  assert.ok(!scrubbed.includes('nested') && !scrubbed.includes('quoted'), 'literal bodies are gone');
  // The regex holds a `/*` that is not a comment; losing that swallows the file.
  assert.ok(scrubbed.includes('export const d = 4;'), 'a regex literal must not open a comment');
});

// The scrubber is a lexer, and every way a hand-written one goes wrong on
// JavaScript is here: a template's `${…}` substitutions hold code, that code
// holds strings, comments, regexes and further templates, and any of those may
// hold a `}` or a backtick that is text. Getting one wrong used to leave the
// scan stuck "inside a literal" to the end of the input, so every declaration
// below the mistake vanished — total, silent loss of the feature for that file.
// Each fixture puts one such shape above two ordinary declarations and asks for
// both back, and every one of them is held to the equal-length contract.
const SCRUB_FIXTURES = [
  ['a backtick inside a regex inside a substitution', 'const q = `${x.replace(/`/g, "")}`;'],
  ['a quote in the text and a quote in a regex in the substitution', 'const q = `"${String(a).replace(/"/g, \'""\')}"`;'],
  ['a template nested in a substitution', 'const t = `a${ `b${ c }d` }e`;'],
  ['a closing brace inside the substitution\'s own string', 'const t = `${ f("}") + \'}\' }`;'],
  ['a closing brace inside a template inside the substitution', 'const t = `${ `}` }`;'],
  ['an object literal in the substitution', 'const t = `${ JSON.stringify({ a: { b: 1 } }) }`;'],
  ['a block comment holding a brace inside the substitution', 'const t = `${ /* } */ value }`;'],
  ['a line comment holding a backtick inside the substitution', 'const t = `${ value // ` and }\n }`;'],
  ['an escaped backtick and an escaped dollar in template text', 'const t = `a\\`b\\${notASubstitution}c`;'],
  ['an escaped quote in a string', "const s = 'it\\'s a \\\\ backslash';"],
  ['a regex holding braces and quotes', 'const re = /^\\{"a":\\s*"[^"]*"\\}$/;'],
  ['a regex holding a slash in a character class, inside a substitution', 'const t = `${ p.replace(/[/]/g, "-") }`;'],
  ['a regex holding the brace that would close the substitution', 'const t = `${ x.replace(/}/g, "") }`;'],
  ['a backtick inside a string inside a substitution', 'const t = `${ "`" + \'`\' }`;'],
  ['division that is not a regex', 'const ratio = total / count, other = (a + b) / 2;'],
  ['a regex after a keyword, holding a quote', 'const ok = typeof s === "string" && /["\']/.test(s);'],
  // Not valid JavaScript, but an edit fragment is routinely half a template.
  // The rule this asserts is the one the old lexer broke: being wrong about a
  // span costs that span, never the rest of the input.
  ['a backtick that never closes', 'const label = `unterminated;'],
];

test('the scrubber lexes the literal shapes that used to blank the rest of the file', async () => {
  const { scrubForScan, symbolsForFile } = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);
  const dir = makeProjectDir();
  let n = 0;
  for (const [what, line] of SCRUB_FIXTURES) {
    const source = [
      line,
      'export function afterTheLiteral(rows) { return rows.length; }',
      'export const alphaValue = 2;',
      '',
    ].join('\n');

    const scrubbed = scrubForScan(source);
    assert.equal(scrubbed.length, source.length, `${what}: the copy must be the same length`);
    assert.equal(
      scrubbed.split('\n').length,
      source.split('\n').length,
      `${what}: line structure must survive`
    );

    const file = writeFile(dir, `fixture${n++}.mjs`, source);
    const got = symbolsForFile(file) || [];
    for (const name of ['afterTheLiteral', 'alphaValue']) {
      assert.ok(got.includes(name), `${what}: lost ${name}, got ${got.join(', ') || '(nothing)'}`);
    }
  }
});

test('a declaration written inside a substitution is still not a declaration', async () => {
  const { symbolsForFile } = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);
  const dir = makeProjectDir();
  const file = writeFile(
    dir,
    'nested.mjs',
    [
      // The substitution is code, but it is code this file describes rather than
      // code it runs, so nothing declared in it is part of this file's surface.
      'export const rendered = `head${ `\\nexport function inBackticks() {}\\n` }tail`;',
      'export function realExport() { return rendered; }',
      '',
    ].join('\n')
  );
  const got = symbolsForFile(file) || [];
  assert.ok(got.includes('rendered') && got.includes('realExport'), `got ${got.join(', ')}`);
  assert.ok(!got.includes('inBackticks'), `claimed a name from inside a template: ${got.join(', ')}`);
});

test('the launcher that exposed the lexer bug keeps every export it has', async () => {
  const { scrubForScan, symbolsForFile } = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);
  // `hooks/mcp_launcher.mjs` ships into every consumer's repo, and one line of
  // it — a `"` in template text, a `"` in a regex inside the substitution — used
  // to blank the file from there to the end. Two exports were lost with it.
  const launcher = path.join(HOOKS_DIR, 'mcp_launcher.mjs');
  const source = fs.readFileSync(launcher, 'utf8');
  const scrubbed = scrubForScan(source);
  assert.equal(scrubbed.length, source.length, 'offsets into the original must stay valid');
  assert.equal(scrubbed.split('\n').length, source.split('\n').length, 'line structure must survive');
  const got = symbolsForFile(launcher) || [];
  for (const name of ['npxInvocation', 'isJsonRpcLine']) {
    assert.ok(got.includes(name), `${name} was lost, got ${got.join(', ')}`);
  }
});

test('attribution says nothing when the edited text appears in two functions', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    // Identical bodies: `indexOf` used to credit the first one, whichever was edited.
    const content = [
      'export function renderHeader(ctx) {',
      '  const rows = ctx.items.map(toRow);',
      '  return rows;',
      '}',
      'export function renderFooter(ctx) {',
      '  const rows = ctx.items.map(toRow);',
      '  return rows;',
      '}',
      '',
    ].join('\n');
    writeFile(projectDir, path.join('src', 'render.js'), content);
    await runHook(
      'post_tool_use.mjs',
      {
        session_id: freshSession(),
        cwd: projectDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(projectDir, 'src', 'render.js'),
          old_string: '  const rows = ctx.items.map(toRows);',
          new_string: '  const rows = ctx.items.map(toRow);',
        },
      },
      hookEnv(projectDir, mock.port)
    );
    const sent = mock.requests[0].body;
    assert.equal(
      sent.symbols,
      null,
      `an ambiguous edit must name nobody, got ${JSON.stringify(sent.symbols)}`
    );
    assert.equal(sent.file_path, 'src/render.js', 'the path still reports, so v0 matching still works');
  } finally {
    await mock.close();
  }
});

test('a line repeated inside one function is still credited to that function', async () => {
  const { symbolsForEdit } = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);
  const dir = makeProjectDir();
  // Both occurrences live in `tally`, so there is no ambiguity to be careful about.
  const file = writeFile(
    dir,
    'tally.js',
    [
      'export function tally(rows) {',
      '  let total = 0;',
      '  for (const r of rows) total += r.n;',
      '  for (const r of rows) total += r.n;',
      '  return total;',
      '}',
      'export function unrelated() { return 0; }',
      '',
    ].join('\n')
  );
  const got = symbolsForEdit(file, 'Edit', {
    old_string: '  for (const r of rows) total += r.m;',
    new_string: '  for (const r of rows) total += r.n;',
  });
  assert.deepEqual(got, ['tally'], `expected tally, got ${JSON.stringify(got)}`);
});

test('an edit inside a function body is credited to that exported function', { skip: NO_SERVER }, async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    // A real slice of this repo, so the shape under test is real code.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'server', 'src', 'db.ts'), 'utf8');
    const line = source.split('\n').find((l) => l.includes('return i === -1'));
    assert.ok(line, 'fixture drifted: dirOf no longer looks the way this test assumes');
    const changed = line.replace('-1', '-1 /* touched */');
    writeFile(projectDir, path.join('server', 'src', 'db.ts'), source.replace(line, () => changed));

    await runHook(
      'post_tool_use.mjs',
      {
        session_id: freshSession(),
        cwd: projectDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(projectDir, 'server', 'src', 'db.ts'),
          old_string: line,
          new_string: changed,
        },
      },
      hookEnv(projectDir, mock.port)
    );
    const sent = mock.requests[0].body;
    // The edit never mentions `dirOf` — only walking back through the file finds it.
    assert.ok(
      sent.symbols?.includes('dirOf'),
      `expected the enclosing export dirOf, got ${JSON.stringify(sent.symbols)}`
    );
    assert.ok(!sent.symbols.includes('normalizeFilePath'), 'the neighbouring export must not be swept in');
  } finally {
    await mock.close();
  }
});

test('an edit that changes an exported signature names it, in both directions', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    const before = 'export function createUser(name: string) {\n  return { name };\n}';
    const after = 'export function createUser(name: string, email: string) {\n  return { name, email };\n}';
    writeFile(projectDir, path.join('src', 'models', 'user.ts'), after + '\n');
    await runHook(
      'post_tool_use.mjs',
      {
        session_id: freshSession(),
        cwd: projectDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(projectDir, 'src', 'models', 'user.ts'),
          old_string: before,
          new_string: after,
        },
      },
      hookEnv(projectDir, mock.port)
    );
    assert.deepEqual(mock.requests[0].body.symbols, ['createUser']);

    // A removed export is a change too — it has to be reported from old_string.
    writeFile(projectDir, path.join('src', 'models', 'account.ts'), 'export const kept = 1;\n');
    await runHook(
      'post_tool_use.mjs',
      {
        session_id: freshSession(),
        cwd: projectDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(projectDir, 'src', 'models', 'account.ts'),
          old_string: 'export function retiredHelper() {}\n',
          new_string: '',
        },
      },
      hookEnv(projectDir, mock.port)
    );
    assert.ok(mock.requests[1].body.symbols.includes('retiredHelper'));
  } finally {
    await mock.close();
  }
});

test('a Write puts every export in the file in play', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    const content = 'export const alpha = 1;\nexport function beta() {}\nconst gamma = 3;\n';
    writeFile(projectDir, 'fresh.ts', content);
    await runHook(
      'post_tool_use.mjs',
      {
        session_id: freshSession(),
        cwd: projectDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: path.join(projectDir, 'fresh.ts'), content },
      },
      hookEnv(projectDir, mock.port)
    );
    assert.deepEqual(mock.requests[0].body.symbols.sort(), ['alpha', 'beta']);
  } finally {
    await mock.close();
  }
});

test('unsupported languages degrade to path matching instead of guessing', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    writeFile(projectDir, 'main.py', 'def create_user(name):\n    return {"name": name}\n');
    await runHook(
      'post_tool_use.mjs',
      {
        session_id: freshSession(),
        cwd: projectDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(projectDir, 'main.py'),
          old_string: 'def create_user(name):',
          new_string: 'def create_user(name, email):',
        },
      },
      hookEnv(projectDir, mock.port)
    );
    const sent = mock.requests[0].body;
    assert.equal(sent.symbols, null, 'a language we cannot read must send nothing, not a guess');
    assert.equal(sent.file_path, 'main.py', 'the path is still reported, so v0 matching still works');

    // Same for a file that is no longer on disk by the time the hook runs.
    await runHook(
      'post_tool_use.mjs',
      {
        session_id: freshSession(),
        cwd: projectDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(projectDir, 'vanished.ts'),
          old_string: 'const a = 1;',
          new_string: 'const a = 2;',
        },
      },
      hookEnv(projectDir, mock.port)
    );
    assert.equal(mock.requests[1].body.symbols, null);
    assert.equal(mock.requests[1].body.file_path, 'vanished.ts');
  } finally {
    await mock.close();
  }
});

test('pre_tool_use sends the file\'s symbols, and omits them when it has none', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    writeFile(
      projectDir,
      path.join('src', 'api', 'handlers.ts'),
      "import { createUser, type User } from '../models/user.js';\nexport function handleSignup() { return createUser('a'); }\n"
    );
    await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, freshSession(), path.join('src', 'api', 'handlers.ts')),
      hookEnv(projectDir, mock.port)
    );
    const sent = (mock.requests[0].query.symbols ?? '').split(',');
    for (const name of ['createUser', 'User', 'handleSignup']) {
      assert.ok(sent.includes(name), `expected ${name} in the check, got ${sent.join(',')}`);
    }
    // and, apart, only what it takes from other files: its own handleSignup
    // makes nobody else's handleSignup its business
    assert.deepEqual(mock.requests[0].query.imports.split(',').sort(), ['User', 'createUser']);

    writeFile(projectDir, 'notes.md', '# nothing to extract here\n');
    await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, freshSession(), 'notes.md'),
      hookEnv(projectDir, mock.port)
    );
    assert.equal(mock.requests[1].query.symbols, undefined, 'no symbols means no parameter at all');
    assert.equal(mock.requests[1].query.imports, undefined);
    assert.equal(mock.requests[1].query.file_path, 'notes.md');

    // a file that imports nothing says so, rather than leaving it to be guessed
    writeFile(projectDir, path.join('packages', 'mobile', 'client.ts'), 'export function createClient() {}\n');
    await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, freshSession(), path.join('packages', 'mobile', 'client.ts')),
      hookEnv(projectDir, mock.port)
    );
    assert.equal(mock.requests[2].query.symbols, 'createClient');
    assert.equal(mock.requests[2].query.imports, '');

    // and one whose only names are too short to send still says what it takes
    writeFile(projectDir, path.join('src', 'jobs', 'seed.ts'), "import { createUser as mk } from '../models/user.js';\nmk('a');\n");
    await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, freshSession(), path.join('src', 'jobs', 'seed.ts')),
      hookEnv(projectDir, mock.port)
    );
    assert.equal(mock.requests[3].query.symbols, undefined);
    assert.equal(mock.requests[3].query.imports, 'createUser');
  } finally {
    await mock.close();
  }
});

test('the advisory says which symbol the other file is being changed for', async () => {
  const mock = await startMockServer({
    checkResponse: {
      conflict: true,
      semantic: true,
      holders: [
        {
          developer: 'alice',
          task_hint: 'add email to signup',
          minutes_ago: 3,
          branch: 'main',
          file_path: 'src/models/user.ts',
          change_summary: '+4/-2 lines, touching createUser',
          match_kind: 'symbol',
          symbols: ['createUser'],
          confidence: 'high',
        },
      ],
    },
  });
  const projectDir = makeProjectDir();
  try {
    writeFile(
      projectDir,
      path.join('src', 'api', 'handlers.ts'),
      "import { createUser } from '../models/user.js';\nexport function handleSignup() {}\n"
    );
    const result = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, freshSession(), path.join('src', 'api', 'handlers.ts')),
      hookEnv(projectDir, mock.port)
    );
    const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(text, /src\/models\/user\.ts/);
    assert.match(text, /depends on for createUser/);
    assert.ok(!text.includes('same directory'), 'a symbol match is not a directory neighbour');
  } finally {
    await mock.close();
  }
});

test("a dependent file's advisory does not say the reader is changing what it only imports", async () => {
  // alice changed createUser, and bob is about to edit a handler that imports
  // it. The symbol match proves handlers.ts is bound to createUser, not that
  // bob is rewriting it, so "You are both changing createUser" was false. And
  // the time used to run on from the name: "depends on for createUser seconds
  // ago".
  const holder = {
    developer: 'alice',
    task_hint: 'add email to signup',
    minutes_ago: 0,
    branch: 'feat/signup',
    file_path: 'src/models/user.ts',
    change_summary: '+4/-2 lines, touching createUser',
    match_kind: 'symbol',
    symbols: ['createUser'],
    confidence: 'high',
  };
  const mock = await startMockServer({ checkResponse: { conflict: true, semantic: true, holders: [holder] } });
  const projectDir = makeProjectDir();
  fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  try {
    writeFile(
      projectDir,
      path.join('src', 'api', 'handlers.ts'),
      "import { createUser } from '../models/user.js';\nexport function handleSignup() {}\n"
    );
    const result = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, freshSession(), path.join('src', 'api', 'handlers.ts')),
      hookEnv(projectDir, mock.port)
    );
    const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(
      text,
      /^\[AgentMash: PARALLEL EDIT\] alice's agent modified src\/models\/user\.ts \(which src\/api\/handlers\.ts depends on for createUser\) seconds ago on branch feat\/signup \(you are on main\)/
    );
    assert.match(text, /depends on for createUser/);
    assert.doesNotMatch(text, /You are both changing createUser/);
    assert.doesNotMatch(text, /depends on for \w+ seconds ago/);
    assert.match(text, /Assume createUser moved under you/, 'what she changed is still named');
  } finally {
    await mock.close();
  }

  // In this very checkout it is ACTIVE COLLISION, and the same holds.
  const here = { file: 'src/api/handlers.ts', branch: 'main', checkout: 'co_thisCheckout' };
  const active = buildCollisionAdvice({
    ...here,
    holders: [{ ...holder, branch: 'main', minutes_ago: 1, checkout_id: 'co_thisCheckout' }],
  });
  assert.equal(active.level, 'active');
  assert.match(
    active.text,
    /alice's agent is inside src\/models\/user\.ts \(which src\/api\/handlers\.ts depends on for createUser\) — last write 1 min ago/
  );
  assert.doesNotMatch(active.text, /You are both changing/);

  // An overlap the server declares is a statement about both sides, and is still said.
  const declared = buildCollisionAdvice({ ...here, holders: [{ ...holder, overlapping_symbols: ['createUser'] }] });
  assert.match(declared.text, /You are both changing createUser\./);
});

test('a holder in another file with no symbols still reads as a directory neighbour', async () => {
  const mock = await startMockServer({
    checkResponse: {
      conflict: true,
      holders: [{ developer: 'alice', minutes_ago: 2, file_path: 'src/models/account.ts' }],
    },
  });
  const projectDir = makeProjectDir();
  try {
    const result = await runHook('pre_tool_use.mjs', editStdin(projectDir, freshSession()), hookEnv(projectDir, mock.port));
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /same directory as/);
  } finally {
    await mock.close();
  }
});

test('extraction stays far inside the edit budget, even on a large file', async () => {
  const { symbolsForFile, symbolsForEdit } = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);
  const dir = makeProjectDir();
  // ~250 KB of plausible source: 2000 exported functions with bodies.
  const blocks = [];
  for (let i = 0; i < 2000; i++) {
    blocks.push(`export function handler${i}(input: string): string {\n  const value = input + '${i}';\n  return value;\n}\n`);
  }
  const before = "  const value = input + '1500';";
  const after = "  const value = input + '1500' + '!';";
  const content = ("import { Store } from './db.js';\n" + blocks.join('\n')).replace(before, () => after);
  const file = writeFile(dir, 'huge.ts', content);

  const read = timed(150, () => symbolsForFile(file));
  const refs = read.value;
  const edit = timed(150, () => symbolsForEdit(file, 'Edit', { old_string: before, new_string: after }));
  const defs = edit.value;

  assert.ok(refs.length > 0 && defs?.includes('handler1500'), 'the large file must still extract correctly');
  // The advisory budget is 1500 ms of network; extraction may not meaningfully
  // eat into it. 150 ms is 10% of that, and a decade of headroom over reality.
  assert.ok(read.ms < read.limit, `symbolsForFile took ${Math.round(read.ms)}ms on ${(content.length / 1024) | 0} KB`);
  assert.ok(edit.ms < edit.limit, `symbolsForEdit took ${Math.round(edit.ms)}ms on ${(content.length / 1024) | 0} KB`);
});

test('files past the size ceiling are skipped rather than parsed on the edit path', async () => {
  const { symbolsForFile } = await import(pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href);
  const dir = makeProjectDir();
  const file = writeFile(dir, 'enormous.ts', 'export const x1 = 1;\n' + '// pad\n'.repeat(90_000));
  assert.ok(fs.statSync(file).size > 512 * 1024);
  assert.equal(symbolsForFile(file), null, 'a file over the ceiling must not be read on the edit path');
});

test('a new hook beside an old lib.mjs still exits 0 and still reports the path', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  // Vendored hooks can drift apart in a partial merge. Simulate the worst
  // version of that: today's hook scripts, yesterday's lib.
  const vendored = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-oldlib-'));
  const oldLib = fs
    .readFileSync(path.join(HOOKS_DIR, 'lib.mjs'), 'utf8')
    .split('// ── symbol extraction')[0];
  fs.writeFileSync(path.join(vendored, 'lib.mjs'), oldLib);
  for (const script of ['pre_tool_use.mjs', 'post_tool_use.mjs']) {
    fs.copyFileSync(path.join(HOOKS_DIR, script), path.join(vendored, script));
  }
  assert.ok(!oldLib.includes('symbolsForEdit'), 'the stand-in lib must really lack the new helpers');
  assert.ok(!oldLib.includes('crewAgentOf'), 'and the crew roster, which sits below the symbols');

  try {
    writeFile(projectDir, path.join('src', 'models', 'user.ts'), 'export const User = 1;\n');
    for (const script of ['post_tool_use.mjs', 'pre_tool_use.mjs']) {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(vendored, script)], {
          env: { ...baseEnv, ...hookEnv(projectDir, mock.port) },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(JSON.stringify({ ...editStdin(projectDir, freshSession()), agent_type: 'pipe-backend' }));
      });
      assert.equal(result.code, 0, `${script} must exit 0 against an old lib.mjs`);
      assert.equal(result.stderr, '', `${script} must not print a link error: ${result.stderr}`);
    }
    const reported = mock.requests.find((r) => r.path === '/events');
    assert.equal(reported.body.file_path, 'src/models/user.ts', 'path reporting must survive');
    assert.equal(reported.body.symbols, null, 'and symbols are simply absent');
    assert.equal(reported.body.agent_type, null, 'as is the crew agent, even from a crew subagent');
  } finally {
    await mock.close();
  }
});

test('a new prompt hook beside an old lib.mjs still exits 0 and still reports the prompt', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  const vendored = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-oldlib-'));
  const oldLib = fs
    .readFileSync(path.join(HOOKS_DIR, 'lib.mjs'), 'utf8')
    .split('// ── symbol extraction')[0];
  fs.writeFileSync(path.join(vendored, 'lib.mjs'), oldLib);
  fs.copyFileSync(path.join(HOOKS_DIR, 'user_prompt_submit.mjs'), path.join(vendored, 'user_prompt_submit.mjs'));
  assert.ok(!oldLib.includes('userPromptText'), 'the stand-in lib must really lack the prompt cleaner');

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(vendored, 'user_prompt_submit.mjs')], {
        env: { ...baseEnv, ...hookEnv(projectDir, mock.port) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(
        JSON.stringify({ session_id: freshSession(), cwd: projectDir, hook_event_name: 'UserPromptSubmit', prompt: 'add a role column' })
      );
    });
    assert.equal(result.code, 0, 'the prompt hook must exit 0 against an old lib.mjs');
    assert.equal(result.stderr, '', `and must not print a link error: ${result.stderr}`);
    const reported = mock.requests.find((r) => r.path === '/events');
    assert.equal(reported.body.task_hint, 'add a role column', 'the prompt is reported as it came, as it was before');
  } finally {
    await mock.close();
  }
});

test('the heads-up beside a lib.mjs from before it says nothing and asks nothing, and session_start says what it always did', async () => {
  // A partial merge, or a repository whose settings.json came up to date
  // before its scripts did: today's heads-up and session_start, an old lib.
  const projectDir = makeProjectDir();
  const vendored = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-oldlib-'));
  const oldLib = fs.readFileSync(path.join(HOOKS_DIR, 'lib.mjs'), 'utf8').split('// ── symbol extraction')[0];
  fs.writeFileSync(path.join(vendored, 'lib.mjs'), oldLib);
  for (const script of ['prompt_note.mjs', 'session_start.mjs']) {
    fs.copyFileSync(path.join(HOOKS_DIR, script), path.join(vendored, script));
  }
  assert.ok(!oldLib.includes('writeNoteState'), 'the stand-in lib must really lack the heads-up');
  const mock = await startMockServer({
    eventsResponse: {
      developers: [
        { developer: 'carol', presence: 'active', minutes_ago: 1, branch: 'design/hero', prompt: 'redo the hero', files: ['landing/hero.tsx'] },
      ],
    },
  });
  const run = (script, payload) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(vendored, script)], {
        env: { ...baseEnv, ...hookEnv(projectDir, mock.port) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(payload));
    });
  try {
    const sessionId = freshSession();
    const noted = await run('prompt_note.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'UserPromptSubmit', prompt: 'add a role column' });
    assert.deepEqual([noted.code, noted.stdout, noted.stderr], [0, '', ''], 'no heads-up, no link error');
    assert.equal(mock.requests.length, 0, 'and no request: the prompt waits on nothing');

    const started = await run('session_start.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(started.code, 0);
    assert.equal(started.stderr, '', `no link error: ${started.stderr}`);
    const note = JSON.parse(started.stdout).hookSpecificOutput.additionalContext;
    assert.match(note, /carol, 1 min ago on design\/hero: "redo the hero"/, 'the whole team, as session_start always told it');
  } finally {
    await mock.close();
  }
});

test('the heads-up and session_start beside a lib.mjs from before resolveConfig end quietly, as if never installed', async () => {
  // A repository set up by this version, then by a CLI of 0.4.0 or older:
  // that one puts its own lib.mjs and hooks back, leaves the two scripts it
  // never had, and keeps their registration. Its lib has no resolveConfig and
  // no buildTeamContext, and a script importing either by name dies linking,
  // with a stack trace in the agent's transcript, at every prompt.
  const projectDir = makeProjectDir();
  const vendored = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-oldlib-'));
  const oldLib = fs
    .readFileSync(path.join(HOOKS_DIR, 'lib.mjs'), 'utf8')
    .split('// ── symbol extraction')[0]
    .replace('export async function resolveConfig(', 'async function resolveConfig(')
    .replace('export function buildTeamContext(', 'function buildTeamContext(');
  assert.ok(!/export (async )?function (resolveConfig|buildTeamContext)\(/.test(oldLib), 'the stand-in lib must really lack both');
  fs.writeFileSync(path.join(vendored, 'lib.mjs'), oldLib);
  for (const script of ['prompt_note.mjs', 'session_start.mjs']) {
    fs.copyFileSync(path.join(HOOKS_DIR, script), path.join(vendored, script));
  }
  const mock = await startMockServer({
    eventsResponse: {
      developers: [{ developer: 'carol', presence: 'active', minutes_ago: 1, branch: 'main', prompt: 'redo the hero', files: [] }],
    },
  });
  const run = (script, payload) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(vendored, script)], {
        env: { ...baseEnv, ...hookEnv(projectDir, mock.port) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(payload));
    });
  try {
    const sessionId = freshSession();
    const noted = await run('prompt_note.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'UserPromptSubmit', prompt: 'add a role column' });
    assert.deepEqual([noted.code, noted.stdout, noted.stderr], [0, '', ''], 'the prompt: no heads-up, no link error');
    const started = await run('session_start.mjs', { session_id: sessionId, cwd: projectDir, hook_event_name: 'SessionStart', source: 'startup' });
    assert.deepEqual([started.code, started.stdout, started.stderr], [0, '', ''], 'the session: no note, no link error');
    assert.equal(mock.requests.length, 0, 'and nothing asked of a room');
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Files from another repository: never this room's
//
// A session rooted in one repository edits files in others all the time:
// another repository opened beside it, a scratchpad, ~/.claude. None of them
// belong in this room, and each used to arrive there as an absolute path.
// hooks/test/paths.test.mjs pins the rule itself; these pin the hooks on it.
// ---------------------------------------------------------------------------

/** A checkout with a space in its path, as "comp programming" has. A .git with a HEAD is all the hooks read. */
function makeCheckout(prefix, branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  return dir;
}

/** The session's repository, and a second one beside it holding the file from the dogfood report. */
function twoRepositories() {
  const projectDir = makeCheckout('comp programming-sandbox-', 'main');
  const other = makeCheckout('comp programming-hero-', 'dogfood');
  const film = writeFile(other, path.join('landing', 'src', 'home', 'Film.tsx'), 'export const Film = 1;\n');
  return { projectDir, other, film: film.split(path.sep).join('/') };
}

const editOf = (projectDir, sessionId, file, extra = {}) => ({
  ...editStdin(projectDir, sessionId),
  ...extra,
  tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
});

test('an edit to a file in another repository is never reported', async () => {
  const mock = await startMockServer();
  const { projectDir, other, film } = twoRepositories();
  try {
    // Wherever the agent is standing: in this repository, or in the other one.
    for (const cwd of [projectDir, other]) {
      const result = await runHook(
        'post_tool_use.mjs',
        editOf(projectDir, freshSession(), film, { cwd, hook_event_name: 'PostToolUse' }),
        hookEnv(projectDir, mock.port)
      );
      assert.equal(result.code, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    }
    assert.deepEqual(
      mock.requests.map((r) => `${r.method} ${r.path} ${r.body?.file_path ?? ''}`),
      [],
      'nothing about a file in another repository reaches this room'
    );
  } finally {
    await mock.close();
  }
});

test('an edit to a file in another repository is never checked, and strict mode never blocks it', async () => {
  const mock = await startMockServer({ checkResponse: conflictCheckResponse });
  const { projectDir, film } = twoRepositories();
  try {
    for (const strict of ['0', '1']) {
      const result = await runHook(
        'pre_tool_use.mjs',
        editOf(projectDir, freshSession(), film),
        hookEnv(projectDir, mock.port, { AGENTMASH_STRICT: strict })
      );
      assert.equal(result.code, 0);
      assert.equal(result.stdout, '', `no advisory and no deny (strict=${strict})`);
      assert.equal(result.stderr, '');
    }
    assert.deepEqual(
      mock.requests.map((r) => `${r.method} ${r.path} ${r.query?.file_path ?? ''}`),
      [],
      'no /check spends the advisory budget on a file this room cannot know'
    );
  } finally {
    await mock.close();
  }
});

test('an edit in this repository is reported on its own branch, wherever the agent is standing', async () => {
  const mock = await startMockServer();
  const { projectDir, other } = twoRepositories();
  try {
    for (const cwd of [projectDir, other]) {
      await runHook(
        'post_tool_use.mjs',
        { ...editStdin(projectDir, freshSession()), cwd, hook_event_name: 'PostToolUse' },
        hookEnv(projectDir, mock.port)
      );
    }
    const reported = mock.requests.filter((r) => r.path === '/events').map((r) => [r.body.file_path, r.body.git_branch]);
    assert.deepEqual(reported, [
      ['src/models/user.ts', 'main'],
      ['src/models/user.ts', 'main'],
    ], 'the branch is the checkout the file is in, never the one the agent stood in');
  } finally {
    await mock.close();
  }
});

test('an edit in another worktree of this repository is reported from that worktree, on its branch', async () => {
  const mock = await startMockServer();
  const projectDir = makeCheckout('comp programming-agentmesh-', 'main');
  const hero = fs.mkdtempSync(path.join(os.tmpdir(), 'comp programming-hero-'));
  const gitDir = path.join(projectDir, '.git', 'worktrees', 'hero');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/dogfood-fixes\n');
  fs.writeFileSync(path.join(hero, '.git'), `gitdir: ${gitDir}\n`);
  const film = writeFile(hero, path.join('landing', 'src', 'home', 'Film.tsx'), 'export const Film = 1;\n');
  try {
    await runHook(
      'post_tool_use.mjs',
      editOf(projectDir, freshSession(), film, { hook_event_name: 'PostToolUse' }),
      hookEnv(projectDir, mock.port)
    );
    const reported = mock.requests.find((r) => r.path === '/events');
    assert.equal(reported?.body.file_path, 'landing/src/home/Film.tsx', 'one room per repository, and this is the same one');
    assert.equal(reported.body.git_branch, 'dogfood-fixes');
  } finally {
    await mock.close();
  }
});

test('on Windows, a path in another case or in Git Bash form is still this repository\'s file', { skip: process.platform !== 'win32' && 'Windows paths' }, async () => {
  const mock = await startMockServer();
  const projectDir = makeCheckout('comp programming-sandbox-', 'main');
  const file = writeFile(projectDir, path.join('src', 'Models', 'User.ts'), 'export const User = 1;\n');
  const msys = `/${file[0].toLowerCase()}/${file.slice(3).split(path.sep).join('/')}`;
  try {
    for (const spelling of [file.toLowerCase(), msys]) {
      await runHook(
        'post_tool_use.mjs',
        editOf(projectDir, freshSession(), spelling, { hook_event_name: 'PostToolUse' }),
        hookEnv(projectDir, mock.port)
      );
    }
    assert.deepEqual(
      mock.requests.filter((r) => r.path === '/events').map((r) => r.body.file_path),
      ['src/Models/User.ts', 'src/Models/User.ts'],
      'the path the disk has, so it matches what a teammate sends'
    );
  } finally {
    await mock.close();
  }
});

test('today\'s edit hooks beside a lib.mjs without locateInRepo keep this repository\'s files and drop the rest', async () => {
  const mock = await startMockServer({ checkResponse: conflictCheckResponse });
  const { projectDir, film } = twoRepositories();
  // Every vendored lib.mjs from before locateInRepo answers a file outside the
  // project with its absolute path, forward-slashed. Put exactly that one in.
  const legacy = [
    'export function toRepoRelative(projectDir, filePath) {',
    '  if (!filePath) return null;',
    '  let result = filePath;',
    '  if (projectDir) {',
    '    const rel = path.relative(projectDir, filePath);',
    "    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) result = rel;",
    '  }',
    "  return result.replace(/\\\\/g, '/');",
    '}',
    'function replacedToRepoRelative(',
  ].join('\n');
  const vendored = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-oldlib-'));
  const oldLib = fs
    .readFileSync(path.join(HOOKS_DIR, 'lib.mjs'), 'utf8')
    .split('// ── symbol extraction')[0]
    .replace('export function locateInRepo(', 'function locateInRepo(')
    .replace('export function toRepoRelative(', () => legacy);
  fs.writeFileSync(path.join(vendored, 'lib.mjs'), oldLib);
  for (const script of ['pre_tool_use.mjs', 'post_tool_use.mjs']) {
    fs.copyFileSync(path.join(HOOKS_DIR, script), path.join(vendored, script));
  }
  assert.ok(!oldLib.includes('export function locateInRepo('), 'the stand-in lib must really lack locateInRepo');
  assert.ok(oldLib.includes('function replacedToRepoRelative('), 'and must carry the old toRepoRelative');

  const run = (script, payload) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(vendored, script)], {
        env: { ...baseEnv, ...hookEnv(projectDir, mock.port, { AGENTMASH_STRICT: '1' }) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(payload));
    });

  try {
    for (const script of ['pre_tool_use.mjs', 'post_tool_use.mjs']) {
      const result = await run(script, editOf(projectDir, freshSession(), film));
      assert.equal(result.code, 0, `${script} must exit 0 against an old lib.mjs`);
      assert.equal(result.stdout, '', `${script} must not advise or block on another repository's file`);
      assert.equal(result.stderr, '', `${script} must not print a link error: ${result.stderr}`);
    }
    assert.deepEqual(mock.requests, [], 'the old answer, an absolute path, is refused by the hook itself');

    await run('post_tool_use.mjs', editStdin(projectDir, freshSession()));
    const reported = mock.requests.find((r) => r.path === '/events');
    assert.equal(reported?.body.file_path, 'src/models/user.ts', 'this repository\'s files are reported as before');
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Crew agents: which one made an edit, and never anybody else's agent's name
// ---------------------------------------------------------------------------

test('the crew roster is exactly the vendored catalog, in its order', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(path.dirname(HOOKS_DIR), 'crew', 'catalog.json'), 'utf8'));
  assert.deepEqual([...CREW_AGENTS], catalog.agents.map((a) => a.name));
  assert.equal(CREW_AGENTS.length, 22);
  assert.ok(Object.isFrozen(CREW_AGENTS));
});

test('a crew agent is named by its catalog name, with one plugin prefix stripped, and nothing else is named at all', () => {
  // the crew as a plugin, and as project agents `agentmash team` wrote
  assert.equal(crewAgentOf('agentmash-crew:pipe-backend'), 'pipe-backend');
  assert.equal(crewAgentOf('pipe-backend'), 'pipe-backend');
  assert.equal(crewAgentOf('agentmash-crew:mash-coordinator'), 'mash-coordinator');
  for (const name of CREW_AGENTS) {
    assert.equal(crewAgentOf(`agentmash-crew:${name}`), name);
    assert.equal(crewAgentOf(name), name);
  }
  // Claude Code's own agents, and ones people wrote themselves
  for (const other of ['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'my-reviewer', 'acme-billing-bot']) {
    assert.equal(crewAgentOf(other), null, other);
  }
  // exactly one prefix, and only the crew's
  assert.equal(crewAgentOf('agentmash-crew:agentmash-crew:pipe-backend'), null);
  assert.equal(crewAgentOf('agentmash-crew:my-reviewer'), null);
  assert.equal(crewAgentOf('other-plugin:pipe-backend'), null);
  assert.equal(crewAgentOf('agentmash-crew:'), null);
  // the exact name: no case folding, no trimming, no short names
  assert.equal(crewAgentOf('Pipe-Backend'), null);
  assert.equal(crewAgentOf(' pipe-backend'), null);
  assert.equal(crewAgentOf('pipe-backend '), null);
  assert.equal(crewAgentOf('pipe'), null);
  // over-long input is not even compared
  assert.equal(crewAgentOf('agentmash-crew:' + 'x'.repeat(100)), null);
  assert.equal(crewAgentOf('x'.repeat(10_000)), null);
  // and anything that is not a string
  for (const junk of [undefined, null, 42, true, {}, ['pipe-backend'], { name: 'pipe-backend' }]) {
    assert.equal(crewAgentOf(junk), null);
  }
});

test('post_tool_use says which crew agent made an edit, and sends nothing for any other agent', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    // What Claude Code passes a hook that fires inside a subagent: its id and its type.
    const cases = [
      ['agentmash-crew:pipe-backend', 'pipe-backend'],
      ['probe-qa', 'probe-qa'],
      // somebody's own agent that shares a crew name is taken at its word:
      // what leaves is still one of the eighteen public names (README, privacy)
      ['gavel-reviewer', 'gavel-reviewer'],
      ['my-secret-reviewer', null],
      ['general-purpose', null],
      [undefined, null], // the main agent
    ];
    for (const [agentType] of cases) {
      const stdin = { ...editStdin(projectDir, freshSession()), hook_event_name: 'PostToolUse', agent_id: 'agent-7f3e2a' };
      if (agentType !== undefined) stdin.agent_type = agentType;
      const result = await runHook('post_tool_use.mjs', stdin, hookEnv(projectDir, mock.port));
      assert.equal(result.code, 0);
      assert.equal(result.stdout + result.stderr, '');
    }
    const sent = mock.requests.filter((r) => r.path === '/events').map((r) => r.body);
    assert.deepEqual(sent.map((b) => b.agent_type), cases.map(([, expected]) => expected));
    for (const body of sent) {
      const wire = JSON.stringify(body);
      assert.ok(!wire.includes('my-secret-reviewer'), 'a name someone gave their own agent never leaves the machine');
      assert.ok(!wire.includes('general-purpose'));
      assert.ok(!wire.includes('agent-7f3e2a'), 'nor does the agent id');
      assert.ok(!('agent_id' in body));
    }
  } finally {
    await mock.close();
  }
});

test('a disabled room sends nothing, crew agent or not', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  try {
    const result = await runHook(
      'post_tool_use.mjs',
      { ...editStdin(projectDir, freshSession()), hook_event_name: 'PostToolUse', agent_type: 'agentmash-crew:pipe-backend' },
      hookEnv(projectDir, mock.port, { AGENTMASH_DISABLE: '1' })
    );
    assert.equal(result.code, 0);
    assert.equal(mock.requests.length, 0);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// The document, as a test
//
// PROTOCOL.md §8 claims compatibility is checked by test rather than intention.
// This is that test: it reads §4's field table out of the document itself and
// holds the events these hooks actually send to it. Change the table without
// changing the hooks — or the hooks without the table — and this fails.
// ---------------------------------------------------------------------------

/** §4's table: { field: { required, max } }, parsed from PROTOCOL.md. */
function documentedFields() {
  const doc = fs.readFileSync(path.join(path.dirname(HOOKS_DIR), 'PROTOCOL.md'), 'utf8');
  const section = doc.slice(doc.indexOf('\n## 4. The event'), doc.indexOf('\n### 4.1'));
  const fields = {};
  for (const line of section.split('\n')) {
    // Split on unescaped pipes only: the type column contains `string \| null`.
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    // | `field` | type | Req | Max | Meaning |
    const name = cells[1]?.match(/^`([a-z_]+)`$/)?.[1];
    if (!name) continue;
    fields[name] = {
      required: /yes/i.test(cells[3] ?? ''),
      max: /^\d+$/.test(cells[4] ?? '') ? Number(cells[4]) : null,
    };
  }
  return fields;
}

/** §4.2's table of event types. */
function documentedEventTypes() {
  const doc = fs.readFileSync(path.join(path.dirname(HOOKS_DIR), 'PROTOCOL.md'), 'utf8');
  const section = doc.slice(doc.indexOf('\n### 4.2'), doc.indexOf('\n### 4.3'));
  return section
    .split('\n')
    .map((line) => line.split('|')[1]?.trim().match(/^`([a-z_]+)`$/)?.[1])
    .filter((name) => name && name !== 'event_type'); // the header cell names the column
}

test('every event the hooks send matches the shape PROTOCOL.md §4 documents', async () => {
  const fields = documentedFields();
  const types = documentedEventTypes();
  assert.ok(Object.keys(fields).length >= 9, 'the §4 table did not parse — has the document moved?');
  assert.deepEqual(types.sort(), ['edit', 'prompt', 'session_end'], 'the §4.2 table did not parse');

  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  const session = freshSession();
  try {
    // One of each documented event type, from the hooks that produce them.
    await runHook(
      'user_prompt_submit.mjs',
      { session_id: session, cwd: projectDir, hook_event_name: 'UserPromptSubmit', prompt: 'Add soft deletes' },
      hookEnv(projectDir, mock.port)
    );
    await runHook(
      'post_tool_use.mjs',
      { ...editStdin(projectDir, session), hook_event_name: 'PostToolUse' },
      hookEnv(projectDir, mock.port)
    );
    // and one from inside a crew subagent, so agent_type is checked as a string too
    await runHook(
      'post_tool_use.mjs',
      { ...editStdin(projectDir, session), hook_event_name: 'PostToolUse', agent_type: 'agentmash-crew:patch-integrations' },
      hookEnv(projectDir, mock.port)
    );
    await runHook(
      'session_end.mjs',
      { session_id: session, cwd: projectDir, hook_event_name: 'SessionEnd', reason: 'exit' },
      hookEnv(projectDir, mock.port)
    );

    const events = mock.requests.filter((r) => r.path === '/events').map((r) => r.body);
    assert.deepEqual(
      [...new Set(events.map((e) => e.event_type))].sort(),
      ['edit', 'prompt', 'session_end'],
      'this test is only honest if it covers every type the hooks send'
    );
    assert.ok(
      events.some((e) => e.agent_type === 'patch-integrations'),
      'and it covers an edit a crew agent made'
    );

    for (const event of events) {
      for (const [name, rule] of Object.entries(fields)) {
        const value = event[name];
        if (rule.required) {
          assert.equal(typeof value, 'string', `${event.event_type}: ${name} is required by §4`);
          assert.ok(value.length > 0, `${event.event_type}: ${name} must not be empty`);
        }
        if (rule.max && typeof value === 'string') {
          assert.ok(value.length <= rule.max, `${event.event_type}: ${name} is over §4's ${rule.max}-character max`);
        }
      }
      for (const name of Object.keys(event)) {
        assert.ok(fields[name], `${event.event_type} sends "${name}", which §4 does not document`);
      }
      assert.ok(types.includes(event.event_type), `§4.2 does not document event_type "${event.event_type}"`);
      // §4: an ISO 8601 string or epoch milliseconds, never epoch seconds.
      const ms = typeof event.timestamp === 'number' ? event.timestamp : Date.parse(event.timestamp);
      assert.ok(Number.isFinite(ms), 'timestamp must parse');
      assert.ok(ms > 1_600_000_000_000, 'timestamp must be in milliseconds, not seconds');
    }
    // §4.3: repo-relative, forward slashes, no leading ./
    for (const event of events.filter((e) => e.event_type === 'edit')) {
      assert.ok(!path.isAbsolute(event.file_path) && !event.file_path.includes('\\') && !event.file_path.startsWith('./'),
        `§4.3: ${event.file_path}`);
    }
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Per-developer tokens (opt-in) and compatibility with servers that ignore them
// ---------------------------------------------------------------------------

/** A machine that has run `agentmash login`: credentials in a fake home dir. */
function makeHomeWithToken(url, roomRef, token) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-home-'));
  fs.mkdirSync(path.join(home, '.agentmash'));
  fs.writeFileSync(
    path.join(home, '.agentmash', 'credentials.json'),
    JSON.stringify({ version: 1, tokens: { [`${url}|${roomRef}`]: { token, developer: 'bob' } } })
  );
  return home;
}

function writeRepoConfig(projectDir, config) {
  fs.mkdirSync(path.join(projectDir, '.claude', 'agentmash'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.claude', 'agentmash', 'config.json'),
    JSON.stringify(config, null, 2)
  );
}

test('no developer token is sent when this machine has not enrolled', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-home-'));
  try {
    const result = await runHook(
      'post_tool_use.mjs',
      { ...editStdin(projectDir, freshSession()), hook_event_name: 'PostToolUse' },
      hookEnv(projectDir, mock.port, { AGENTMASH_HOME: home })
    );
    assert.equal(result.code, 0);
    assert.equal(mock.requests[0].token, undefined, 'the zero-config path sends exactly what it always did');
  } finally {
    await mock.close();
  }
});

test('an enrolled machine sends its developer token on the request it was already making', async () => {
  const mock = await startMockServer({ checkResponse: conflictCheckResponse });
  const projectDir = makeProjectDir();
  const url = `http://127.0.0.1:${mock.port}`;
  const home = makeHomeWithToken(url, 'rm_abc123', 'amt_tokentokentokentoken');
  writeRepoConfig(projectDir, { url, room: ROOM, room_ref: 'rm_abc123' });
  try {
    const post = await runHook(
      'post_tool_use.mjs',
      { ...editStdin(projectDir, freshSession()), hook_event_name: 'PostToolUse' },
      { CLAUDE_PROJECT_DIR: projectDir, AGENTMASH_DEV: 'bob', AGENTMASH_HOME: home }
    );
    assert.equal(post.code, 0);
    assert.equal(mock.requests[0].token, 'amt_tokentokentokentoken');
    assert.equal(mock.requests[0].room, ROOM);

    const pre = await runHook(
      'pre_tool_use.mjs',
      editStdin(projectDir, freshSession()),
      { CLAUDE_PROJECT_DIR: projectDir, AGENTMASH_DEV: 'bob', AGENTMASH_HOME: home }
    );
    assert.equal(pre.code, 0);
    assert.equal(mock.requests[1].token, 'amt_tokentokentokentoken', 'reads carry it too, for the audit trail');
    // fix/ack-and-summary rewrote the advisory; the point here is only that the
    // token did not cost us the advisory.
    assert.match(pre.stdout, /\[AgentMash: ACTIVE COLLISION\]/);
  } finally {
    await mock.close();
  }
});

test('a token for a different room is not sent, and the hook still works', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  const url = `http://127.0.0.1:${mock.port}`;
  const home = makeHomeWithToken(url, 'rm_someotherroom', 'amt_tokentokentokentoken');
  writeRepoConfig(projectDir, { url, room: ROOM, room_ref: 'rm_abc123' });
  try {
    const result = await runHook(
      'post_tool_use.mjs',
      { ...editStdin(projectDir, freshSession()), hook_event_name: 'PostToolUse' },
      { CLAUDE_PROJECT_DIR: projectDir, AGENTMASH_DEV: 'bob', AGENTMASH_HOME: home }
    );
    assert.equal(result.code, 0);
    assert.equal(mock.requests[0].token, undefined);
  } finally {
    await mock.close();
  }
});

test('a server that refuses the write is still a silent exit 0', async () => {
  // An old hook against a room that now requires tokens gets a 401; that must
  // look exactly like every other failure — nothing printed, nothing blocked.
  const mock = await startMockServer({ status: 401 });
  const projectDir = makeProjectDir();
  try {
    const post = await runHook(
      'post_tool_use.mjs',
      { ...editStdin(projectDir, freshSession()), hook_event_name: 'PostToolUse' },
      hookEnv(projectDir, mock.port)
    );
    assert.equal(post.code, 0);
    assert.equal(post.stdout, '');
    assert.equal(post.stderr, '');

    const pre = await runHook('pre_tool_use.mjs', editStdin(projectDir, freshSession()), hookEnv(projectDir, mock.port));
    assert.equal(pre.code, 0);
    assert.equal(pre.stdout, '');
  } finally {
    await mock.close();
  }
});

test('a connect attempt gets half the request budget, not Node\'s 250 ms', async () => {
  // Node gives each address a hostname resolves to 250 ms to connect before it
  // moves on. From far enough away that is shorter than the TCP handshake, so
  // every attempt is abandoned and fetch fails in ~300 ms against a server that
  // is perfectly well: the hooks went silent for a whole continent. Latency
  // like that cannot be reproduced on loopback, so this pins the knob itself.
  const net = await import('node:net');
  const { widenConnectAttempts, httpJson } = await import('../lib.mjs');
  const before = net.getDefaultAutoSelectFamilyAttemptTimeout();
  try {
    widenConnectAttempts(1500);
    assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 750);
    widenConnectAttempts(100);
    assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 250, 'never below the default');
    // and a request sets it from its own budget before it connects
    await httpJson('GET', 'http://127.0.0.1:9/healthz', { room: 'mash_x', timeoutMs: 4000 });
    assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 2000);
  } finally {
    net.setDefaultAutoSelectFamilyAttemptTimeout(before);
  }
});

// ---------------------------------------------------------------------------
// Edits that never got tracked
//
// Reports go out from async hooks, so Claude Code shows nothing when one fails:
// each failure leaves one line in a log on this machine instead. And the edit
// tools are not the only way a file changes: a notebook cell, a Bash or
// PowerShell command, a hand edit from before the session. The working tree
// says what moved, so the hooks read it (`git status`) and report that.
// ---------------------------------------------------------------------------

const REPORT_TOKEN = 'amt_reportlogtokenreportlogtok';

function reportLog(home) {
  try {
    return fs
      .readFileSync(path.join(home, '.agentmash', 'log', 'reports.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const makeHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-report-home-'));
const postEdit = (projectDir, sessionId, extra = {}) => ({
  ...editStdin(projectDir, sessionId),
  hook_event_name: 'PostToolUse',
  ...extra,
});

test('a report the server refuses leaves one line in the local log, and nothing on screen', async () => {
  const mock = await startMockServer({
    status: 401,
    eventsResponse: { error: 'this room requires a developer token — run: npx agentmash login', code: 'token_required' },
  });
  const projectDir = makeProjectDir();
  const home = makeHome();
  const sessionId = freshSession();
  const env = hookEnv(projectDir, mock.port, { AGENTMASH_HOME: home, AGENTMASH_TOKEN: REPORT_TOKEN });
  try {
    const prompt = await runHook(
      'user_prompt_submit.mjs',
      { session_id: sessionId, cwd: projectDir, hook_event_name: 'UserPromptSubmit', prompt: 'rotate the signing secret' },
      env
    );
    const edit = await runHook('post_tool_use.mjs', postEdit(projectDir, sessionId), env);
    const end = await runHook('session_end.mjs', { session_id: sessionId, cwd: projectDir, reason: 'exit' }, env);
    for (const result of [prompt, edit, end]) {
      assert.equal(result.code, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    }

    const lines = reportLog(home);
    assert.deepEqual(
      lines.map((l) => [l.hook, l.event_type, l.outcome, l.status, l.code]),
      [
        ['user_prompt_submit', 'prompt', 'refused', 401, 'token_required'],
        ['post_tool_use', 'edit', 'refused', 401, 'token_required'],
        ['session_end', 'session_end', 'refused', 401, 'token_required'],
      ],
      'one line per report that did not arrive, from every hook that reports'
    );
    const [, editLine] = lines;
    assert.equal(editLine.tool, 'Edit');
    assert.equal(editLine.file_path, 'src/models/user.ts');
    assert.equal(editLine.url, `http://127.0.0.1:${mock.port}`);
    assert.ok(Number.isFinite(editLine.ms) && editLine.ms >= 0);
    assert.ok(Number.isFinite(Date.parse(editLine.at)));
    assert.ok(editLine.repo, 'which checkout it was for, so doctor can say which repository');

    const raw = fs.readFileSync(path.join(home, '.agentmash', 'log', 'reports.jsonl'), 'utf8');
    assert.ok(!raw.includes(ROOM), 'the room key never reaches the log');
    assert.ok(!raw.includes(REPORT_TOKEN), 'nor the developer token');
    assert.ok(!raw.includes('signing secret'), 'nor the prompt');
  } finally {
    await mock.close();
  }
});

test('a report with no reply is logged with why', async () => {
  const mock = await startMockServer();
  const deadPort = mock.port;
  await mock.close();
  const projectDir = makeProjectDir();
  const home = makeHome();
  const result = await runHook(
    'post_tool_use.mjs',
    postEdit(projectDir, freshSession()),
    hookEnv(projectDir, deadPort, { AGENTMASH_HOME: home })
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const [line] = reportLog(home);
  assert.equal(line?.outcome, 'no_reply');
  assert.equal(line?.error, 'ECONNREFUSED');
});

test('a report budget of 4 s is the budget: the exit guard does not end the report first', async () => {
  // The guard used to fire at a flat 4 s, so a room with timeout_ms 4000 had
  // every slow report killed by it, silently, before its own abort could fire.
  const mock = await startMockServer({ delayMs: 20_000 });
  const projectDir = makeProjectDir();
  const home = makeHome();
  try {
    const result = await runHook(
      'post_tool_use.mjs',
      postEdit(projectDir, freshSession()),
      hookEnv(projectDir, mock.port, { AGENTMASH_HOME: home, AGENTMASH_TIMEOUT_MS: '4000' })
    );
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.ok(result.elapsed < within(5000), `took ${result.elapsed}ms, past Claude Code's 5 s for this hook`);
    const [line] = reportLog(home);
    assert.equal(line?.outcome, 'no_reply', 'the request ran out its own budget');
    assert.equal(line?.error, 'timeout');
    assert.ok(line.ms >= 3900, `the report was given ${line.ms}ms of its 4000`);
  } finally {
    await mock.close();
  }
});

test('a report still in the air when the hook has to go is logged as cut off', async () => {
  // A budget past what Claude Code waits for: the guard ends the hook before
  // Claude Code kills it, and says what it was still waiting on.
  const mock = await startMockServer({ delayMs: 20_000 });
  const projectDir = makeProjectDir();
  const home = makeHome();
  try {
    const result = await runHook(
      'post_tool_use.mjs',
      postEdit(projectDir, freshSession()),
      hookEnv(projectDir, mock.port, { AGENTMASH_HOME: home, AGENTMASH_TIMEOUT_MS: '10000' })
    );
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.ok(result.elapsed < within(5000), `took ${result.elapsed}ms, past Claude Code's 5 s for this hook`);
    const [line] = reportLog(home);
    assert.equal(line?.outcome, 'cut_off');
    assert.equal(line?.file_path, 'src/models/user.ts');
  } finally {
    await mock.close();
  }
});

test('a report that arrives logs nothing', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  const home = makeHome();
  try {
    await runHook('post_tool_use.mjs', postEdit(projectDir, freshSession()), hookEnv(projectDir, mock.port, { AGENTMASH_HOME: home }));
    assert.equal(mock.requests.filter((r) => r.path === '/events').length, 1);
    assert.ok(!fs.existsSync(path.join(home, '.agentmash', 'log')), 'no log at all while every report arrives');
  } finally {
    await mock.close();
  }
});

test('the log rolls over at its cap instead of growing forever, and a log it cannot write costs nothing', async () => {
  const mock = await startMockServer({ status: 503, eventsResponse: { error: 'down for maintenance' } });
  const projectDir = makeProjectDir();
  const home = makeHome();
  const file = path.join(home, '.agentmash', 'log', 'reports.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ at: new Date(0).toISOString(), pad: 'x'.repeat(300) })}\n`.repeat(1000));
  try {
    await runHook('post_tool_use.mjs', postEdit(projectDir, freshSession()), hookEnv(projectDir, mock.port, { AGENTMASH_HOME: home }));
    assert.ok(fs.existsSync(`${file}.1`), 'the full log moved aside');
    assert.deepEqual(reportLog(home).map((l) => [l.outcome, l.status]), [['refused', 503]], 'and the live one starts over');

    // a home that is a file: the log cannot be written, and the hook does not care
    const blocked = path.join(makeHome(), 'not-a-directory');
    fs.writeFileSync(blocked, '');
    const result = await runHook(
      'post_tool_use.mjs',
      postEdit(projectDir, freshSession()),
      hookEnv(projectDir, mock.port, { AGENTMASH_HOME: blocked })
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    await mock.close();
  }
});

test('a NotebookEdit is reported and checked by its notebook_path, repo-relative', async () => {
  const mock = await startMockServer();
  const projectDir = makeProjectDir();
  const notebook = {
    notebook_path: path.join(projectDir, 'nb', 'analysis.ipynb'),
    cell_id: 'c1',
    new_source: 'df = load()\ndf.head()',
    edit_mode: 'replace',
  };
  try {
    const pre = await runHook(
      'pre_tool_use.mjs',
      { session_id: freshSession(), cwd: projectDir, hook_event_name: 'PreToolUse', tool_name: 'NotebookEdit', tool_input: notebook },
      hookEnv(projectDir, mock.port)
    );
    assert.equal(pre.code, 0);
    const post = await runHook(
      'post_tool_use.mjs',
      { session_id: freshSession(), cwd: projectDir, hook_event_name: 'PostToolUse', tool_name: 'NotebookEdit', tool_input: notebook },
      hookEnv(projectDir, mock.port)
    );
    assert.equal(post.code, 0);
    assert.equal(post.stderr, '');

    const check = mock.requests.find((r) => r.path === '/check');
    assert.equal(check?.query.file_path, 'nb/analysis.ipynb', 'a teammate on the notebook is found before the cell changes');
    const edit = mock.requests.find((r) => r.path === '/events')?.body;
    assert.equal(edit?.tool, 'NotebookEdit');
    assert.equal(edit?.file_path, 'nb/analysis.ipynb');
    assert.equal(edit?.change_summary, 'notebook cell replace, 2 lines');
  } finally {
    await mock.close();
  }
});

test("Devin's lowercase edit and write are reported and checked, by file_path or by path", async () => {
  // Devin reads the hooks in .claude/settings.json, and calls its tools edit,
  // write and apply_patch: the same edits, under names and fields of its own.
  const mock = await startMockServer({ checkResponse: conflictCheckResponse });
  const projectDir = makeProjectDir();
  try {
    const calls = [
      ['edit', { path: 'src/models/user.ts', old_string: 'id: string', new_string: 'id: string;\n  deletedAt?: Date' }],
      ['write', { file_path: path.join(projectDir, 'src', 'models', 'team.ts'), content: 'export interface Team {}\n' }],
    ];
    for (const [tool_name, tool_input] of calls) {
      const call = { session_id: freshSession(), cwd: projectDir, tool_name, tool_input };
      const pre = await runHook('pre_tool_use.mjs', { ...call, hook_event_name: 'PreToolUse' }, hookEnv(projectDir, mock.port));
      assert.equal(pre.code, 0);
      assert.match(JSON.parse(pre.stdout).hookSpecificOutput.additionalContext, /alice's agent/, `${tool_name} is advised`);
      const post = await runHook('post_tool_use.mjs', { ...call, hook_event_name: 'PostToolUse' }, hookEnv(projectDir, mock.port));
      assert.deepEqual([post.code, post.stdout, post.stderr], [0, '', '']);
    }
    assert.deepEqual(
      mock.requests.filter((r) => r.path === '/check').map((r) => r.query.file_path),
      ['src/models/user.ts', 'src/models/team.ts']
    );
    assert.deepEqual(
      mock.requests.filter((r) => r.path === '/events').map((r) => [r.body.tool, r.body.file_path, r.body.change_summary]),
      [
        ['devin:edit', 'src/models/user.ts', '+2/-1 lines'],
        ['devin:write', 'src/models/team.ts', 'wrote 2 lines, defining Team'],
      ],
      "each said as Devin's, whose tools these are"
    );
  } finally {
    await mock.close();
  }
});

test("an apply_patch is checked and reported file by file, the files its patch text names", async () => {
  const holder = conflictCheckResponse.holders[0];
  // a teammate in only one of the patch's files: that one is advised on
  const mock = { requests: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      mock.requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      const busy = url.pathname === '/check' && url.searchParams.get('file_path') === 'src/models/user.ts';
      res.end(JSON.stringify(busy ? { conflict: true, holders: [holder] } : url.pathname === '/check' ? { conflict: false, holders: [] } : { ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const projectDir = makeProjectDir();
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/models/user.ts',
    '@@',
    '-  name: string;',
    '+  name: string | null;',
    '*** Add File: src/models/role.ts',
    '+export type Role = "admin" | "member";',
    '*** Delete File: src/models/legacy.ts',
    '*** Update File: src/a.ts',
    '*** Move to: src/b.ts',
    '*** End Patch',
  ].join('\n');
  // and one outside the repository, which is nobody in the room's business
  const outside = `${patch.replace('*** End Patch', '')}*** Add File: ../elsewhere/x.ts\n+x\n*** End Patch`;
  try {
    const call = { session_id: freshSession(), cwd: projectDir, tool_name: 'apply_patch', tool_input: { command: outside } };
    const pre = await runHook('pre_tool_use.mjs', { ...call, hook_event_name: 'PreToolUse' }, hookEnv(projectDir, port));
    assert.equal(pre.code, 0);
    const advice = JSON.parse(pre.stdout).hookSpecificOutput.additionalContext;
    assert.match(advice, /^\[AgentMash: [A-Z ]+\] alice's agent .* src\/models\/user\.ts/);
    assert.equal((advice.match(/\[AgentMash:/g) ?? []).length, 1, 'one advisory, for the one file a teammate is in');
    const checked = mock.requests.filter((r) => r.path === '/check').map((r) => r.query.file_path).sort();
    assert.deepEqual(checked, ['src/a.ts', 'src/b.ts', 'src/models/legacy.ts', 'src/models/role.ts', 'src/models/user.ts']);

    const post = await runHook('post_tool_use.mjs', { ...call, hook_event_name: 'PostToolUse' }, hookEnv(projectDir, port));
    assert.deepEqual([post.code, post.stdout, post.stderr], [0, '', '']);
    const reported = mock.requests
      .filter((r) => r.path === '/events')
      .map((r) => [r.body.tool, r.body.file_path, r.body.change_summary])
      .sort((a, b) => a[1].localeCompare(b[1]));
    assert.deepEqual(reported, [
      ['devin:apply_patch', 'src/a.ts', 'moved to src/b.ts, in a patch'],
      ['devin:apply_patch', 'src/b.ts', 'moved from src/a.ts, +0/-0 lines, in a patch'],
      ['devin:apply_patch', 'src/models/legacy.ts', 'deleted, in a patch'],
      ['devin:apply_patch', 'src/models/role.ts', 'wrote 1 line, in a patch'],
      ['devin:apply_patch', 'src/models/user.ts', '+1/-1 lines, in a patch'],
    ]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// Real repositories from here on: `git status` is what the hooks read. Git
// reads the global config of whoever runs the tests (a global excludes file,
// commit signing), so it gets an empty one, as cli/test/cli.test.mjs does.
const EMPTY_GITCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-hooks-git-')), 'gitconfig');
fs.writeFileSync(EMPTY_GITCONFIG, '');
const gitEnv = { GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG, GIT_CONFIG_NOSYSTEM: '1' };

/** A committed repository with a space in its path, as "comp programming" has, and dist/ ignored. */
function makeGitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'comp programming-worktree-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: { ...baseEnv, ...gitEnv }, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'bob@example.com');
  git('config', 'user.name', 'bob');
  git('config', 'core.autocrlf', 'false');
  writeFile(dir, path.join('src', 'models', 'user.ts'), 'export interface User { id: string }\n');
  writeFile(dir, path.join('src', 'models', 'team.ts'), 'export interface Team { id: string }\n');
  writeFile(dir, '.gitignore', 'dist/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

/** Change a file the way a command would, a moment later than the last look could have seen. */
function rewrite(file, text) {
  fs.appendFileSync(file, text);
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(file, later, later);
}

const repoEnv = (repo, port, extra = {}) => hookEnv(repo, port, { ...gitEnv, ...extra });
const promptTurn = (repo, sessionId, prompt) => ({ session_id: sessionId, cwd: repo, hook_event_name: 'UserPromptSubmit', prompt });
const shellTurn = (repo, sessionId, command, tool_name = 'Bash') => ({
  session_id: sessionId,
  cwd: repo,
  hook_event_name: 'PostToolUse',
  tool_name,
  tool_input: { command },
});
const editsIn = (mock) => mock.requests.filter((r) => r.path === '/events' && r.body.event_type === 'edit').map((r) => r.body);

test('uncommitted work from before the session is reported once, at its first prompt, as nobody\'s prompt', async () => {
  const mock = await startMockServer();
  const repo = makeGitRepo();
  const sessionId = freshSession();
  const env = repoEnv(repo, mock.port);
  try {
    // the role/isAdmin case: a hand edit, or a session with no hooks, an hour ago
    const user = path.join(repo, 'src', 'models', 'user.ts');
    fs.appendFileSync(user, "export type Role = 'admin' | 'member';\n");
    const anHourAgo = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(user, anHourAgo, anHourAgo);
    // and one left over from days before that
    const team = path.join(repo, 'src', 'models', 'team.ts');
    fs.appendFileSync(team, 'export const MAX_MEMBERS = 50;\n');
    const daysAgo = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    fs.utimesSync(team, daysAgo, daysAgo);
    writeFile(repo, 'notes.md', 'untracked: somebody\'s scratch, not work in the repository yet\n');

    const sent = Date.now();
    const result = await runHook('user_prompt_submit.mjs', promptTurn(repo, sessionId, 'add a displayName'), env);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    const edits = editsIn(mock).sort((a, b) => a.file_path.localeCompare(b.file_path));
    assert.deepEqual(
      edits.map((e) => [e.file_path, e.tool, e.change_summary]),
      [
        ['src/models/team.ts', 'worktree', 'uncommitted before this session started, last written 3 days ago'],
        ['src/models/user.ts', 'worktree', 'uncommitted before this session started, last written an hour ago'],
      ],
      'each says how old it is, so nobody reads it as an edit made a moment ago'
    );
    for (const edit of edits) {
      assert.equal(edit.task_hint, null, 'work from before the session is not this prompt\'s');
      assert.equal(edit.prompt_id, null);
      // Stamped when it was found, not when the file was written: the room
      // warns a teammate about an edit only for a while after its timestamp,
      // and an hour-old change nobody has committed is still work in progress
      // (server/test/advisory-e2e.test.ts has the teammate it warns).
      const at = Date.parse(edit.timestamp);
      assert.ok(at >= sent - 1000 && at <= Date.now() + 1000, `stamped when it was reported: ${edit.timestamp}`);
    }

    await runHook('user_prompt_submit.mjs', promptTurn(repo, sessionId, 'and a test for it'), env);
    assert.equal(editsIn(mock).length, 2, 'once a session, not once a prompt');
  } finally {
    await mock.close();
  }
});

test('a command looked at before the first prompt leaves the work from before the session to the prompt', async () => {
  // In a repository install both hooks run in the background, so a quick
  // first command can have its look taken before its prompt's is.
  const mock = await startMockServer();
  const repo = makeGitRepo();
  const sessionId = freshSession();
  const env = repoEnv(repo, mock.port);
  try {
    const user = path.join(repo, 'src', 'models', 'user.ts');
    fs.appendFileSync(user, "export type Role = 'admin' | 'member';\n");
    const anHourAgo = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(user, anHourAgo, anHourAgo);

    await runHook('post_tool_use.mjs', shellTurn(repo, sessionId, 'git status'), env);
    assert.equal(editsIn(mock).length, 0, 'the command only takes stock: none of that is its doing');
    await runHook('user_prompt_submit.mjs', promptTurn(repo, sessionId, 'add a displayName'), env);
    assert.deepEqual(
      editsIn(mock).map((e) => [e.file_path, e.tool, e.task_hint, e.change_summary]),
      [['src/models/user.ts', 'worktree', null, 'uncommitted before this session started, last written an hour ago']],
      'and the prompt still reports it'
    );
    await runHook('user_prompt_submit.mjs', promptTurn(repo, sessionId, 'and a test for it'), env);
    assert.equal(editsIn(mock).length, 1, 'once a session');
  } finally {
    await mock.close();
  }
});

test('past the cap, the files written last are the ones reported', async () => {
  const mock = await startMockServer();
  const repo = makeGitRepo();
  const sessionId = freshSession();
  const env = repoEnv(repo, mock.port);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...baseEnv, ...gitEnv }, stdio: 'ignore' });
  try {
    const names = Array.from({ length: 12 }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`);
    for (const name of names) writeFile(repo, name, `export const ${path.basename(name, '.ts')} = 0;\n`);
    git('add', '-A');
    git('commit', '-q', '-m', 'twelve more');
    // all twelve left uncommitted, and the two written last sort last by name
    names.forEach((name, i) => {
      const file = path.join(repo, name);
      fs.appendFileSync(file, '// wip\n');
      const at = new Date(Date.now() - (60 - i) * 60_000);
      fs.utimesSync(file, at, at);
    });

    await runHook('user_prompt_submit.mjs', promptTurn(repo, sessionId, 'tidy the exports'), env);
    const edits = editsIn(mock);
    assert.deepEqual(
      edits.map((e) => e.file_path).sort(),
      names.slice(2),
      'the ten written most recently, which are likelier to be what is being worked on'
    );
    assert.equal(edits.filter((e) => /\(and 2 more files\)$/.test(e.change_summary)).length, 1);
  } finally {
    await mock.close();
  }
});

test('files a Bash or PowerShell command changed are reported as its edits, under the prompt it ran for', async () => {
  const mock = await startMockServer();
  const repo = makeGitRepo();
  const sessionId = freshSession();
  const env = repoEnv(repo, mock.port);
  try {
    fs.appendFileSync(path.join(repo, 'src', 'models', 'user.ts'), '// dirty before\n');
    await runHook('user_prompt_submit.mjs', promptTurn(repo, sessionId, 'refactor the models'), env);
    const promptId = mock.requests.find((r) => r.body?.event_type === 'prompt').body.prompt_id;
    const baseline = editsIn(mock).length;

    // what `sed -i`, a heredoc and a build leave behind
    rewrite(path.join(repo, 'src', 'models', 'team.ts'), '// sed\n');
    rewrite(path.join(repo, 'src', 'models', 'user.ts'), '// again\n');
    writeFile(repo, path.join('src', 'models', 'role.ts'), "export type Role = 'admin';\n");
    writeFile(repo, path.join('dist', 'bundle.js'), 'ignored\n');
    const result = await runHook('post_tool_use.mjs', shellTurn(repo, sessionId, "sed -i 's/a/b/' src/models/team.ts"), env);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');

    const bash = editsIn(mock).slice(baseline);
    assert.deepEqual(
      bash.map((e) => [e.file_path, e.tool]).sort(),
      [
        ['src/models/role.ts', 'Bash'],
        ['src/models/team.ts', 'Bash'],
        ['src/models/user.ts', 'Bash'],
      ],
      'newly dirty, rewritten while dirty, and new; never what .gitignore ignores'
    );
    for (const e of bash) {
      assert.equal(e.task_hint, 'refactor the models');
      assert.equal(e.prompt_id, promptId);
      assert.equal(e.change_summary, 'changed by a Bash command');
    }

    // a command that only reads changes nothing and reports nothing
    const before = mock.requests.length;
    await runHook('post_tool_use.mjs', shellTurn(repo, sessionId, 'ls src'), env);
    assert.equal(mock.requests.length, before);

    writeFile(repo, path.join('src', 'models', 'admin.ts'), 'export const isAdmin = false;\n');
    await runHook('post_tool_use.mjs', shellTurn(repo, sessionId, 'Set-Content src/models/admin.ts', 'PowerShell'), env);
    assert.deepEqual(editsIn(mock).slice(baseline + bash.length).map((e) => [e.file_path, e.tool]), [
      ['src/models/admin.ts', 'PowerShell'],
    ]);
  } finally {
    await mock.close();
  }
});

test('a file its own edit hook reported is not reported again by the next command', async () => {
  const mock = await startMockServer();
  const repo = makeGitRepo();
  const sessionId = freshSession();
  const env = repoEnv(repo, mock.port);
  try {
    await runHook('user_prompt_submit.mjs', promptTurn(repo, sessionId, 'rename the team'), env);
    const team = path.join(repo, 'src', 'models', 'team.ts');
    rewrite(team, '// via Write\n');
    await runHook(
      'post_tool_use.mjs',
      postEdit(repo, sessionId, { tool_name: 'Write', tool_input: { file_path: team, content: 'x' } }),
      env
    );
    await runHook('post_tool_use.mjs', shellTurn(repo, sessionId, 'npm test'), env);
    assert.deepEqual(editsIn(mock).map((e) => [e.file_path, e.tool]), [['src/models/team.ts', 'Write']], 'one edit, one event');
  } finally {
    await mock.close();
  }
});

// Two sessions of one developer in one checkout: two terminals, or a second
// window on the same repository. Each session compares the working tree with
// its own last look, but the working tree is the checkout's, so each one sees
// the other's work in it too. /team pairs a file with its newest edit, so a
// second report of the same change, under the other session's prompt or under
// none, is what a teammate would be told the file is being changed for.
const whoEdited = (a) => (e) => [e.session_id === a ? 'A' : 'B', e.tool, e.file_path, e.task_hint];

test('a second session in the checkout does not report the first one\'s edits again, under its own prompt', async () => {
  const mock = await startMockServer();
  const repo = makeGitRepo();
  const a = freshSession();
  const b = freshSession();
  const env = repoEnv(repo, mock.port);
  try {
    await runHook('user_prompt_submit.mjs', promptTurn(repo, a, 'add isAdmin to the user model'), env);
    await runHook('user_prompt_submit.mjs', promptTurn(repo, b, 'fix the flaky tests'), env);

    // A's agent edits the user model, and runs a codegen that writes one more file
    const user = path.join(repo, 'src', 'models', 'user.ts');
    rewrite(user, 'export const isAdmin = (u: User) => false;\n');
    await runHook(
      'post_tool_use.mjs',
      postEdit(repo, a, { tool_name: 'Edit', tool_input: { file_path: user, old_string: 'a', new_string: 'b' } }),
      env
    );
    writeFile(repo, path.join('src', 'models', 'role.ts'), "export type Role = 'admin';\n");
    await runHook('post_tool_use.mjs', shellTurn(repo, a, 'npm run codegen'), env);

    // B's agent runs commands that write nothing, and B's developer goes on
    await runHook('post_tool_use.mjs', shellTurn(repo, b, 'npm test'), env);
    await runHook('post_tool_use.mjs', shellTurn(repo, b, 'Get-ChildItem src', 'PowerShell'), env);
    await runHook('user_prompt_submit.mjs', promptTurn(repo, b, 'now the lint'), env);
    assert.deepEqual(
      editsIn(mock).map(whoEdited(a)),
      [
        ['A', 'Edit', 'src/models/user.ts', 'add isAdmin to the user model'],
        ['A', 'Bash', 'src/models/role.ts', 'add isAdmin to the user model'],
      ],
      'each file once, by the session that changed it, under the prompt it was changed for'
    );

    // what B's own command changes is B's, in the same file or not
    rewrite(user, '// lint --fix\n');
    await runHook('post_tool_use.mjs', shellTurn(repo, b, 'npm run lint -- --fix'), env);
    assert.deepEqual(editsIn(mock).slice(2).map(whoEdited(a)), [['B', 'Bash', 'src/models/user.ts', 'now the lint']]);
    // and A does not take it back as its own
    await runHook('post_tool_use.mjs', shellTurn(repo, a, 'npm test'), env);
    await runHook('user_prompt_submit.mjs', promptTurn(repo, a, 'and a test for isAdmin'), env);
    assert.equal(editsIn(mock).length, 3);
  } finally {
    await mock.close();
  }
});

test('a session that starts after another one\'s edits does not take them for work from before it', async () => {
  const mock = await startMockServer();
  const repo = makeGitRepo();
  const a = freshSession();
  const b = freshSession();
  const env = repoEnv(repo, mock.port);
  const summarized = (e) => [...whoEdited(a)(e), e.change_summary];
  try {
    // left uncommitted an hour ago, before either session
    const team = path.join(repo, 'src', 'models', 'team.ts');
    fs.appendFileSync(team, 'export const MAX_MEMBERS = 50;\n');
    const anHourAgo = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(team, anHourAgo, anHourAgo);

    await runHook('user_prompt_submit.mjs', promptTurn(repo, a, 'add isAdmin to the user model'), env);
    const user = path.join(repo, 'src', 'models', 'user.ts');
    rewrite(user, 'export const isAdmin = (u: User) => false;\n');
    await runHook(
      'post_tool_use.mjs',
      postEdit(repo, a, { tool_name: 'Edit', tool_input: { file_path: user, old_string: 'a', new_string: 'b' } }),
      env
    );

    // B starts only now, with A's edit still uncommitted
    await runHook('user_prompt_submit.mjs', promptTurn(repo, b, 'fix the flaky tests'), env);
    await runHook('post_tool_use.mjs', shellTurn(repo, b, 'npm test'), env);
    await runHook('user_prompt_submit.mjs', promptTurn(repo, b, 'now the lint'), env);
    assert.deepEqual(
      editsIn(mock).map(summarized),
      [
        ['A', 'worktree', 'src/models/team.ts', null, 'uncommitted before this session started, last written an hour ago'],
        ['A', 'Edit', 'src/models/user.ts', 'add isAdmin to the user model', '+1/-1 lines'],
      ],
      'A\'s live edit keeps its prompt, and the older work is reported once, not once a session'
    );

    // a hand edit is found once, by whichever session looks first
    rewrite(team, '// by hand\n');
    await runHook('user_prompt_submit.mjs', promptTurn(repo, b, 'and the formatter'), env);
    await runHook('post_tool_use.mjs', shellTurn(repo, a, 'npm test'), env);
    await runHook('user_prompt_submit.mjs', promptTurn(repo, a, 'and a test for isAdmin'), env);
    assert.deepEqual(editsIn(mock).slice(2).map(summarized), [
      ['B', 'worktree', 'src/models/team.ts', null, 'changed between prompts, by hand or in the background, last written just now'],
    ]);
  } finally {
    await mock.close();
  }
});

/** The notes kept for the checkout whose notes name `rel`: each hook that reports files adds one. */
function notesNaming(rel) {
  const root = path.join(os.tmpdir(), 'agentmash', 'checkouts');
  for (const dir of fs.readdirSync(root)) {
    const notes = fs
      .readdirSync(path.join(root, dir))
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(root, dir, name), 'utf8')))
      // a report note, not the owner check kept beside them (owner-check.json)
      .filter((note) => Array.isArray(note.claims));
    if (notes.some((note) => note.claims.some(([claimed]) => claimed === rel))) return notes;
  }
  return [];
}

test('what the hooks noted of their reports is folded into one note, and every report still holds', async () => {
  // One note per report, so edit hooks running at once never write over each
  // other's; a look folds them, keeping only files still as they were noted.
  const mock = await startMockServer();
  const repo = makeGitRepo();
  const a = freshSession();
  const b = freshSession();
  const env = repoEnv(repo, mock.port);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...baseEnv, ...gitEnv }, stdio: 'ignore' });
  const tag = `${process.pid}${Date.now().toString(36)}`;
  const names = Array.from({ length: 18 }, (_, i) => `src/gen/${tag}-${String(i).padStart(2, '0')}.ts`);
  try {
    await runHook('user_prompt_submit.mjs', promptTurn(repo, a, 'generate the models'), env);
    await runHook('user_prompt_submit.mjs', promptTurn(repo, b, 'fix the flaky tests'), env);
    // six Writes in a row at a time, whose hooks run in the background, at once
    for (let i = 0; i < names.length; i += 6) {
      await Promise.all(
        names.slice(i, i + 6).map((name) => {
          const file = writeFile(repo, name, 'export {};\n');
          return runHook(
            'post_tool_use.mjs',
            postEdit(repo, a, { tool_name: 'Write', tool_input: { file_path: file, content: 'export {};\n' } }),
            env
          );
        })
      );
    }
    assert.equal(notesNaming(names[0]).length, names.length, 'a note for each report, none written over');

    // two of them committed: nobody's work in progress any more
    git('add', names[0], names[1]);
    git('commit', '-q', '-m', 'the first two');
    await runHook('post_tool_use.mjs', shellTurn(repo, a, 'git commit'), env);
    const notes = notesNaming(names[2]);
    assert.equal(notes.length, 1, 'folded into one');
    assert.deepEqual(notes[0].claims.map(([rel]) => rel).sort(), names.slice(2), 'less the files that went back to clean');

    await runHook('post_tool_use.mjs', shellTurn(repo, b, 'npm test'), env);
    await runHook('user_prompt_submit.mjs', promptTurn(repo, b, 'now the lint'), env);
    const reports = editsIn(mock);
    assert.deepEqual(
      reports
        .filter((e) => e.tool !== 'git-commit')
        .map(whoEdited(a))
        .sort((x, y) => x[2].localeCompare(y[2])),
      names.map((name) => ['A', 'Write', name, 'generate the models']),
      'each file once, by the session that wrote it'
    );
    // and the commit once, in a session of its own (reportCommits)
    const committed = reports.filter((e) => e.tool === 'git-commit');
    assert.deepEqual(committed.map((e) => e.file_path).sort(), names.slice(0, 2));
    assert.ok(committed.every((e) => e.session_id !== a && e.session_id !== b));
  } finally {
    await mock.close();
  }
});

test('a commit that deleted a file reports it as deleted, not as lines taken out', async () => {
  // what a teammate about to edit the file is then told it is gone (removalOf)
  const mock = await startMockServer();
  const repo = makeGitRepo();
  const sessionId = freshSession();
  const env = repoEnv(repo, mock.port);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...baseEnv, ...gitEnv }, stdio: 'ignore' });
  try {
    await runHook('user_prompt_submit.mjs', promptTurn(repo, sessionId, 'drop teams for now'), env);
    git('rm', '-q', path.join('src', 'models', 'team.ts'));
    rewrite(path.join(repo, 'src', 'models', 'user.ts'), '// no teams\n');
    git('commit', '-q', '-am', 'drop teams');
    await runHook('post_tool_use.mjs', shellTurn(repo, sessionId, 'git commit -am "drop teams"'), env);
    const committed = editsIn(mock).filter((e) => e.tool === 'git-commit');
    const summaries = Object.fromEntries(committed.map((e) => [e.file_path, e.change_summary]));
    assert.match(summaries['src/models/team.ts'], /^commit [0-9a-f]{7} · deleted$/);
    assert.match(summaries['src/models/user.ts'], /^commit [0-9a-f]{7} · \+1\/-0 lines$/);
  } finally {
    await mock.close();
  }
});

test('a command that rewrites a whole tree reports a bounded number of files, and says how many more', async () => {
  const mock = await startMockServer();
  const repo = makeGitRepo();
  const sessionId = freshSession();
  const env = repoEnv(repo, mock.port);
  try {
    await runHook('user_prompt_submit.mjs', promptTurn(repo, sessionId, 'run the codegen'), env);
    for (let i = 0; i < 40; i++) writeFile(repo, path.join('gen', `f${String(i).padStart(2, '0')}.ts`), `export const f${i} = ${i};\n`);
    const result = await runHook('post_tool_use.mjs', shellTurn(repo, sessionId, 'npm run codegen'), env);
    assert.equal(result.code, 0);
    assert.ok(result.elapsed < within(5000), `took ${result.elapsed}ms`);
    const edits = editsIn(mock);
    assert.equal(edits.length, 10);
    assert.equal(edits.filter((e) => /\(and 30 more files\)$/.test(e.change_summary)).length, 1);
  } finally {
    await mock.close();
  }
});

test('the first look in a session only takes stock, and outside a repository there is nothing to look at', async () => {
  const mock = await startMockServer();
  const repo = makeGitRepo();
  const sessionId = freshSession();
  const env = repoEnv(repo, mock.port);
  const plain = makeProjectDir();
  try {
    // no prompt hook ran first: what is dirty now is not this command's doing
    fs.appendFileSync(path.join(repo, 'src', 'models', 'user.ts'), '// dirty before\n');
    await runHook('post_tool_use.mjs', shellTurn(repo, sessionId, 'npm test'), env);
    assert.equal(editsIn(mock).length, 0);
    rewrite(path.join(repo, 'src', 'models', 'team.ts'), '// then this\n');
    await runHook('post_tool_use.mjs', shellTurn(repo, sessionId, 'npm run fmt'), env);
    assert.deepEqual(editsIn(mock).map((e) => e.file_path), ['src/models/team.ts']);

    const outside = await runHook('post_tool_use.mjs', shellTurn(plain, freshSession(), 'echo hi > x.txt'), hookEnv(plain, mock.port));
    assert.equal(outside.code, 0);
    assert.equal(outside.stdout, '');
    assert.equal(outside.stderr, '');
    assert.equal(editsIn(mock).length, 1);
  } finally {
    await mock.close();
  }
});

test('a turn the harness sent still catches up on files changed since the last prompt', async () => {
  const mock = await startMockServer();
  const repo = makeGitRepo();
  const sessionId = freshSession();
  const env = repoEnv(repo, mock.port);
  try {
    await runHook('user_prompt_submit.mjs', promptTurn(repo, sessionId, 'build the docs'), env);
    // a background command finishes writing after its own hook ran
    writeFile(repo, path.join('docs', 'api.md'), '# api\n');
    // and a file comes back with the time it was written two hours ago (a
    // copy that keeps its times, an unpacked archive), reported now all the same
    writeFile(repo, path.join('docs', 'guide.md'), '# guide\n');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    fs.utimesSync(path.join(repo, 'docs', 'guide.md'), twoHoursAgo, twoHoursAgo);
    const notification =
      '<task-notification>\n<task-id>b8x2k1</task-id>\n<status>completed</status>\n<summary>Background command "npm run docs" completed (exit code 0)</summary>\n</task-notification>';
    const sent = Date.now();
    const result = await runHook('user_prompt_submit.mjs', { ...promptTurn(repo, sessionId, notification), source: 'system' }, env);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    const edits = editsIn(mock).sort((a, b) => a.file_path.localeCompare(b.file_path));
    assert.deepEqual(
      edits.map((e) => [e.file_path, e.tool, e.task_hint, e.change_summary]),
      [
        ['docs/api.md', 'worktree', null, 'changed between prompts, by hand or in the background, last written just now'],
        ['docs/guide.md', 'worktree', null, 'changed between prompts, by hand or in the background, last written 2 hours ago'],
      ]
    );
    for (const edit of edits) {
      const at = Date.parse(edit.timestamp);
      assert.ok(at >= sent - 1000 && at <= Date.now() + 1000, `stamped when it was reported: ${edit.timestamp}`);
    }
    assert.equal(mock.requests.filter((r) => r.body?.event_type === 'prompt').length, 1, 'the notification is still no prompt');
    assert.equal(mock.requests.filter((r) => r.path === '/team').length, 0, 'and the report asks after nobody');
  } finally {
    await mock.close();
  }
});

test('AGENTMASH_WORKTREE=0 or share_worktree false keeps files the agent did not change on this machine', async () => {
  const mock = await startMockServer();
  try {
    for (const optOut of ['env', 'config']) {
      const repo = makeGitRepo();
      const sessionId = freshSession();
      const env =
        optOut === 'env'
          ? repoEnv(repo, mock.port, { AGENTMASH_WORKTREE: '0' })
          : repoEnv(repo, mock.port);
      if (optOut === 'config') {
        writeRepoConfig(repo, { url: `http://127.0.0.1:${mock.port}`, room: ROOM, share_worktree: false });
      }
      const before = editsIn(mock).length;
      fs.appendFileSync(path.join(repo, 'src', 'models', 'user.ts'), '// a hand edit\n');
      await runHook('user_prompt_submit.mjs', promptTurn(repo, sessionId, 'tidy up'), env);
      // a second session in the checkout, which looked before the next hand edit
      const other = freshSession();
      await runHook('user_prompt_submit.mjs', promptTurn(repo, other, 'fix the flaky tests'), env);
      writeFile(repo, 'hand.md', 'written by hand between prompts\n');
      await runHook('user_prompt_submit.mjs', promptTurn(repo, sessionId, 'tidy up more'), env);
      // what one session kept back, the other does not send as its command's
      await runHook('post_tool_use.mjs', shellTurn(repo, other, 'npm test'), env);
      assert.equal(editsIn(mock).length, before, `${optOut}: nothing from before the session, nothing from between prompts`);

      // what the agent's own command changed is its edit, as a Write would be
      rewrite(path.join(repo, 'src', 'models', 'team.ts'), '// the agent did this\n');
      await runHook('post_tool_use.mjs', shellTurn(repo, sessionId, 'npm run fmt'), env);
      assert.deepEqual(editsIn(mock).slice(before).map((e) => [e.file_path, e.tool]), [['src/models/team.ts', 'Bash']], optOut);
    }
  } finally {
    await mock.close();
  }
});

test('today\'s edit hooks beside an old lib.mjs pass over a notebook and a command quietly', async () => {
  const mock = await startMockServer();
  const repo = makeGitRepo();
  const vendored = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-oldlib-'));
  const oldLib = fs.readFileSync(path.join(HOOKS_DIR, 'lib.mjs'), 'utf8').split('// ── symbol extraction')[0];
  fs.writeFileSync(path.join(vendored, 'lib.mjs'), oldLib);
  for (const script of ['post_tool_use.mjs', 'user_prompt_submit.mjs']) {
    fs.copyFileSync(path.join(HOOKS_DIR, script), path.join(vendored, script));
  }
  const run = (script, payload) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(vendored, script)], {
        env: { ...baseEnv, ...repoEnv(repo, mock.port) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(payload));
    });
  try {
    const sessionId = freshSession();
    fs.appendFileSync(path.join(repo, 'src', 'models', 'user.ts'), '// dirty before\n');
    const results = [
      await run('user_prompt_submit.mjs', promptTurn(repo, sessionId, 'refactor')),
      await run('post_tool_use.mjs', shellTurn(repo, sessionId, 'npm run fmt')),
    ];
    for (const result of results) {
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '', `no link error: ${result.stderr}`);
    }
    assert.deepEqual(
      mock.requests.filter((r) => r.path === '/events').map((r) => r.body.event_type),
      ['prompt'],
      'the prompt goes out as it always did, and nothing else'
    );
  } finally {
    await mock.close();
  }
});

test('a repository someone else owns is never run: git refuses it, and nothing from its config executes', async () => {
  // CVE-2022-24765: another account plants a .git above the project (C:\.git
  // on a shared Windows machine) whose config names a command. git itself
  // refuses a repository another user owns; the hooks must not talk it out of
  // that, and must not run that command as whoever opened Claude Code here.
  // GIT_TEST_ASSUME_DIFFERENT_OWNER makes git treat the planted repository as
  // another user's, which is what the real attack looks like.
  const mock = await startMockServer();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'comp programming-planted-')));
  const planted = path.join(base, 'shared root');
  const project = path.join(planted, 'my project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'notes.md'), 'x\n');
  const marker = path.join(base, 'marker.txt');
  const git = (...args) => execFileSync('git', args, { cwd: planted, env: { ...baseEnv, ...gitEnv }, stdio: 'ignore' });
  git('init', '-q', '.');
  git('config', 'core.fsmonitor', `echo ran-as-victim > "${marker.split(path.sep).join('/')}"; false`);
  const env = repoEnv(project, mock.port, { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' });
  try {
    const sessionId = freshSession();
    const prompt = await runHook('user_prompt_submit.mjs', promptTurn(project, sessionId, 'tidy the notes'), env);
    assert.equal(prompt.code, 0);
    // a command writes a file, so a look that did read the planted repository
    // would have something to report
    fs.writeFileSync(path.join(project, 'made-by-command.md'), 'y\n');
    const shell = await runHook('post_tool_use.mjs', shellTurn(project, sessionId, 'echo y > made-by-command.md'), env);
    assert.equal(shell.code, 0);
    assert.equal(shell.stdout, '');
    assert.ok(!fs.existsSync(marker), "the planted repository's command ran as the developer");
    assert.equal(editsIn(mock).length, 0, 'nothing from a refused repository is reported');
  } finally {
    await mock.close();
  }
});

test('a .git git cannot read does not send the look on to the repository around it', async () => {
  // A parent repository with work in progress, and a folder inside it with a
  // .git of its own that git cannot read (empty, half-cloned). Without a
  // ceiling git walks past it into the parent, and the parent's changes would
  // be reported as this folder's, as uncommitted before the session started.
  const mock = await startMockServer();
  const parent = makeGitRepo();
  fs.appendFileSync(path.join(parent, 'src', 'models', 'user.ts'), '// work in progress in the parent\n');
  const child = path.join(parent, 'vendor', 'child');
  fs.mkdirSync(path.join(child, '.git'), { recursive: true });
  writeFile(child, path.join('src', 'models', 'user.ts'), 'export const child = 1;\n');
  try {
    const sessionId = freshSession();
    const prompt = await runHook('user_prompt_submit.mjs', promptTurn(child, sessionId, 'tidy the child'), repoEnv(child, mock.port));
    assert.equal(prompt.code, 0);
    assert.deepEqual(editsIn(mock), [], "the parent's changes are not reported as the child's");
  } finally {
    await mock.close();
  }
});
