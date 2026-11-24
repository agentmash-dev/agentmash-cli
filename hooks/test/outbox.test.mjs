// The outbox: a report the server may yet take is kept on the machine and
// sent later, and the room stores it once. Every report carries an id made
// once (report_id); one whose POST gets no reply, a 5xx, a 408 or a 429, or
// whose hook has to go first, becomes one file under ~/.agentmash/outbox,
// with no room key, no token and no text of the code in it; a hook whose own
// report arrived sends a few of them, and drainOutbox sends the rest for
// whoever calls it. The hooks run here as agents run them, against a room on
// a port of its own that keeps an id once as the real one does, and every
// home is a temporary folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as lib from '../lib.mjs';
import { HOOKS_DIR, KEY, REF, USER_TOKEN, baseEnv, machine, runHook, session, within } from './fixtures.mjs';
import { tempDir } from './tmp.mjs';

// This process calls lib.mjs itself, to keep reports and to drain them, so it
// has a home of its own and none of the settings a developer's shell may
// carry: lib.mjs reads both when it is called, never when it is loaded.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('AGENTMASH_') && !name.startsWith('AGENTMASH_TEST_')) delete process.env[name];
}
process.env.AGENTMASH_HOME = tempDir('agentmash-outbox-own-home-');

const CLIENTS_DIR = path.join(path.dirname(HOOKS_DIR), 'clients');
const DEV_TOKEN = 'amt_outboxtokenoutboxtokenoutb';
const DIFF = '@@ -1 +1 @@\n-const planted = "before the outage"\n+const planted = "after the outage"';
const DAY_MS = 24 * 60 * 60_000;

/**
 * A room that keeps a report id once, as the real one does (POST /events in
 * server/src/app.ts): a new id is stored and answered 201, one it has is
 * answered 200 with `duplicate` and stored nowhere. `mode` is how it answers
 * a report: 'up'; a number, that status and nothing stored; 'unheard',
 * stored and the connection dropped before any answer; 'hang', never; 'old',
 * a server from before report ids, which stores whatever it is sent. `down()`
 * closes the port and `up()` opens the same one again.
 */
function startRoom() {
  const room = { mode: 'up', code: null, delayMs: 0, requests: [], stored: new Map(), duplicates: 0, port: 0, url: '' };
  const hung = new Set();
  let server = null;
  const handle = (req, res) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const body = text ? JSON.parse(text) : null;
      const request = {
        path: url.pathname,
        room: req.headers['x-agentmash-room'],
        token: req.headers['x-agentmash-token'],
        user: req.headers['x-agentmash-user'],
        source: req.headers['x-agentmash-developer-source'],
        body,
        status: null,
      };
      room.requests.push(request);
      const send = (status, json) => {
        request.status = status;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (url.pathname === '/api/lookup') return send(200, { room_ref: REF, developer: 'bob' });
      if (url.pathname !== '/events') return send(200, {});
      if (typeof room.mode === 'number') return send(room.mode, { error: 'not now', code: room.code });
      if (room.mode === 'hang') return hung.add(res);
      if (room.mode === 'old') {
        room.stored.set(`row-${room.requests.length}`, body);
        return send(201, { ok: true });
      }
      const known = room.stored.has(body.report_id);
      if (known) room.duplicates += 1;
      else room.stored.set(body.report_id, body);
      if (room.mode === 'unheard') return req.socket.destroy();
      const answer = () => (known ? send(200, { ok: true, id: 1, duplicate: true }) : send(201, { ok: true, id: room.stored.size }));
      return room.delayMs > 0 ? setTimeout(answer, room.delayMs) : answer();
    });
  };
  const listen = (port) =>
    new Promise((resolve, reject) => {
      server = http.createServer(handle);
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        room.port = server.address().port;
        room.url = `http://127.0.0.1:${room.port}`;
        resolve(room);
      });
    });
  room.down = () =>
    new Promise((resolve) => {
      for (const res of hung) res.destroy();
      server.closeAllConnections?.();
      server.close(resolve);
    });
  room.up = () => listen(room.port);
  /** The reports the room was sent, without the lookups a signed-in machine makes. */
  room.reports = () => room.requests.filter((r) => r.path === '/events');
  return listen(0);
}

/**
 * A checkout that carries its room (`npx agentmash init`): the room's key
 * and ref in its config, and a home that holds a developer token for that
 * room and a sign-in for its server, so every credential a report can be
 * sent with is one the tests can look for.
 */
function checkout(url) {
  const { env, project, home } = machine(Number(new URL(url).port), { committed: true });
  fs.writeFileSync(path.join(project, '.claude', 'agentmash', 'config.json'), JSON.stringify({ url, room: KEY, room_ref: REF }));
  fs.mkdirSync(path.join(home, '.agentmash'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.agentmash', 'credentials.json'),
    JSON.stringify({ version: 1, tokens: { [`${url}|${REF}`]: { token: DEV_TOKEN, developer: 'bob' } } })
  );
  fs.writeFileSync(path.join(home, '.agentmash', 'user.json'), JSON.stringify({ url, token: USER_TOKEN, login: 'bob' }));
  return { env, project, home };
}

const outboxOf = (home) => path.join(home, '.agentmash', 'outbox');

/** Every file in a home's outbox, by name. */
function filesOf(home) {
  try {
    return fs.readdirSync(outboxOf(home)).sort();
  } catch {
    return [];
  }
}

/** The entries waiting in a home's outbox, oldest first, each with its file's name. */
function entriesOf(home) {
  return filesOf(home)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, ...JSON.parse(fs.readFileSync(path.join(outboxOf(home), name), 'utf8')) }));
}

/** The log of reports that did not arrive, in a home. */
function logOf(home) {
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

/** Run `run` with this process's lib.mjs on `home`, as a process on that machine would be. */
async function onMachine(home, run) {
  const before = process.env.AGENTMASH_HOME;
  process.env.AGENTMASH_HOME = home;
  try {
    return await run();
  } finally {
    process.env.AGENTMASH_HOME = before;
  }
}

/** Run `job` over `items`, `width` at a time. */
async function each(items, width, job) {
  const queue = items.slice();
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (queue.length > 0) await job(queue.shift());
    })
  );
}

const editOf = (project, sessionId, rel = 'src/models/user.ts') => ({
  session_id: sessionId,
  cwd: project,
  hook_event_name: 'PostToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: path.join(project, rel), old_string: 'a', new_string: 'b' },
});

/** An event as a hook would report it, for reports this process makes itself. */
const eventOf = (i, extra = {}) => ({
  developer: 'bob',
  session_id: 'outbox-session',
  event_type: 'edit',
  tool: 'Edit',
  file_path: `src/file-${i}.ts`,
  timestamp: new Date(Date.now() - 60_000 + i).toISOString(),
  ...extra,
});

/** Report `count` events from this process, as the hooks do, with the checkout's own config. */
function reportFrom({ home, project }, count, extra = () => ({})) {
  return onMachine(home, async () => {
    const config = lib.withSignIn(lib.loadConfig(project));
    await each([...Array(count).keys()], 10, (i) => lib.reportEvent(config, eventOf(i, extra(i)), { hook: 'post_tool_use', project }));
  });
}

/** Put an entry in a home's outbox as keepReport would have, `at` ms: for an outbox no test could fill in time. */
let planted = 0;
function plant(home, { project, url }, at, body, extra = {}) {
  const dir = outboxOf(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = `planted-${String(++planted).padStart(12, '0')}`;
  const name = `${at}-${process.pid}-${String(planted).padStart(8, '0')}.json`;
  fs.writeFileSync(
    path.join(dir, name),
    JSON.stringify({ v: 1, report_id: id, queued_at: at, tries: 0, next_at: at, project, url, room_ref: REF, body: { ...body, report_id: id }, ...extra }),
    { mode: 0o600 }
  );
  return name;
}

// ---------------------------------------------------------------------------
// An outage
// ---------------------------------------------------------------------------

test('200 events of a session made while the server is down are each kept once, and each is stored once when it returns', async () => {
  const room = await startRoom();
  const { env, project, home } = checkout(room.url);
  const sessionId = session();
  for (let i = 0; i < 198; i++) fs.writeFileSync(path.join(project, 'src', `file-${i}.ts`), `export const n${i} = ${i};\n`);
  await room.down();
  try {
    // a session as an agent has one: a prompt, its edits, and its end, with nothing listening
    const prompt = await runHook(
      'user_prompt_submit.mjs',
      { session_id: sessionId, cwd: project, hook_event_name: 'UserPromptSubmit', prompt: 'add soft deletes to every model' },
      env
    );
    assert.deepEqual([prompt.code, prompt.stderr], [0, '']);
    await each([...Array(198).keys()], 8, async (i) => {
      const result = await runHook('post_tool_use.mjs', editOf(project, sessionId, `src/file-${i}.ts`), env);
      assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', '']);
    });
    const end = await runHook('session_end.mjs', { session_id: sessionId, cwd: project, hook_event_name: 'SessionEnd', reason: 'exit' }, env);
    assert.deepEqual([end.code, end.stderr], [0, '']);

    const kept = entriesOf(home);
    assert.equal(kept.length, 200, 'one entry for each event');
    assert.equal(new Set(kept.map((e) => e.report_id)).size, 200, 'each under an id of its own');
    assert.deepEqual(
      kept.reduce((n, e) => ({ ...n, [e.body.event_type]: (n[e.body.event_type] ?? 0) + 1 }), {}),
      { prompt: 1, edit: 198, session_end: 1 }
    );
    for (const entry of kept) {
      assert.match(entry.report_id, /^[A-Za-z0-9_-]{22}$/, '22 url-safe characters');
      assert.equal(entry.body.report_id, entry.report_id);
      assert.equal(entry.body.session_id, sessionId);
      assert.deepEqual([entry.v, entry.tries, entry.project, entry.url, entry.room_ref], [1, 0, project, room.url, REF]);
      assert.equal(entry.next_at, entry.queued_at, 'due as soon as anyone can send it');
      assert.ok(Number.isFinite(Date.parse(entry.body.timestamp)), 'with the time the event was made');
    }
    const log = logOf(home);
    assert.equal(log.length, 200, 'and the log still says each one did not arrive');
    assert.ok(log.every((line) => line.outcome === 'no_reply' && line.error === 'ECONNREFUSED' && line.kept === true), 'and that it was kept');

    // The server is back. A hook whose own report arrives sends the five oldest with the time it has left.
    await room.up();
    const later = await runHook('post_tool_use.mjs', editOf(project, session()), env);
    assert.deepEqual([later.code, later.stdout, later.stderr], [0, '', '']);
    const sent = room.reports().map((r) => r.body.report_id);
    assert.equal(sent.length, 6, 'its own report, and five that were waiting');
    assert.deepEqual(sent.slice(1).sort(), kept.slice(0, 5).map((e) => e.report_id).sort(), 'the five oldest');
    assert.equal(entriesOf(home).length, 195);

    // The rest go with whoever drains the outbox: the observe worker, here this process.
    const drained = await onMachine(home, () => lib.drainOutbox({ max: 1000, budgetMs: within(30_000) }));
    assert.deepEqual(drained, { sent: 195, dropped: 0, left: 0 });
    assert.deepEqual(filesOf(home), [], 'nothing is left on the machine');
    assert.deepEqual(lib.outboxStats.call(null), await onMachine(home, () => lib.outboxStats()), 'an empty outbox, like one never made');

    assert.equal(room.duplicates, 0, 'nothing reached the room twice');
    for (const entry of kept) {
      const posts = room.reports().filter((r) => r.body.report_id === entry.report_id);
      assert.equal(posts.length, 1, 'each kept report is sent once');
      assert.equal(posts[0].status, 201, 'and stored');
      const stored = room.stored.get(entry.report_id);
      assert.equal(stored.timestamp, entry.body.timestamp, 'at its own time, not the time it was sent');
      assert.ok(Number.isFinite(stored.delayed_ms) && stored.delayed_ms >= 0, 'saying how long it waited');
      assert.equal(stored.file_path, entry.body.file_path);
      assert.equal(posts[0].room, KEY, 'with the room key its checkout has now');
    }
    assert.deepEqual(await onMachine(home, () => lib.drainOutbox()), { sent: 0, dropped: 0, left: 0 }, 'and a drain after that finds nothing');
  } finally {
    await room.down();
  }
});

test('200 events the server answers 503 are each kept once, and one it stored without answering is not stored again', async () => {
  const room = await startRoom();
  const machineOf = checkout(room.url);
  const { home } = machineOf;
  room.mode = 503;
  try {
    await reportFrom(machineOf, 200);
    const kept = entriesOf(home);
    assert.equal(kept.length, 200);
    assert.equal(new Set(kept.map((e) => e.report_id)).size, 200);
    assert.ok(logOf(home).every((line) => line.outcome === 'refused' && line.status === 503 && line.kept === true));
    assert.equal(room.stored.size, 0);

    // The room takes the oldest, and its answer is lost on the way: the entry waits, and its next attempt is a repeat.
    room.mode = 'unheard';
    const now = Date.now();
    assert.deepEqual(await onMachine(home, () => lib.drainOutbox({ max: 50, now })), { sent: 0, dropped: 0, left: 200 });
    assert.equal(room.stored.size, 1, 'one was tried, and the rest were left for a server that answers');
    const [first] = entriesOf(home);
    assert.equal(first.report_id, kept[0].report_id, 'the oldest');
    assert.equal(first.tries, 1);
    assert.ok(first.next_at >= now + 30_000 && first.next_at < now + 31_000, `tried again in 30 s, not ${first.next_at - now} ms`);

    room.mode = 'up';
    const drained = await onMachine(home, () => lib.drainOutbox({ max: 1000, budgetMs: within(30_000), now: now + 31_000 }));
    assert.deepEqual(drained, { sent: 200, dropped: 0, left: 0 });
    assert.equal(room.stored.size, 200, 'each event is in the room once');
    assert.equal(room.duplicates, 1, 'and the one it already had was answered as a repeat');
    for (const entry of kept) {
      const stored = room.stored.get(entry.report_id);
      assert.equal(stored.timestamp, entry.body.timestamp);
      assert.ok(Number.isFinite(stored.delayed_ms));
    }
    assert.ok(room.stored.get(kept[5].report_id).delayed_ms >= 31_000, 'the wait is counted to the moment it is sent');
    assert.deepEqual(filesOf(home), []);
  } finally {
    await room.down();
  }
});

test('an entry holds no room key, no token and no text of the code, and its file is the owner’s alone', async () => {
  const room = await startRoom();
  const machineOf = checkout(room.url);
  const { env, project, home } = machineOf;
  room.mode = 503;
  try {
    await reportFrom(machineOf, 3, () => ({ diff: DIFF, task_hint: 'rotate the signing secret' }));
    const hook = await runHook('post_tool_use.mjs', editOf(project, session()), env);
    assert.equal(hook.code, 0, hook.stderr);

    // what was planted really went out with the first attempt, so its absence below means something
    const first = room.reports();
    assert.equal(first.length, 4);
    assert.ok(first.every((r) => r.room === KEY && r.token === DEV_TOKEN && r.user === USER_TOKEN));
    assert.equal(first[0].body.diff, DIFF);

    const names = filesOf(home);
    assert.equal(names.length, 4);
    for (const name of names) {
      const text = fs.readFileSync(path.join(outboxOf(home), name), 'utf8');
      assert.ok(!text.includes(KEY), 'the room key');
      assert.ok(!text.includes(DEV_TOKEN), 'the developer token');
      assert.ok(!text.includes(USER_TOKEN), 'the sign-in');
      assert.ok(!text.includes('planted') && !text.includes('"diff"'), 'the changed text');
      assert.match(name, /^\d{13}-\d+-[0-9a-f]{8}\.json$/);
      const entry = JSON.parse(text);
      assert.deepEqual(Object.keys(entry).sort(), ['body', 'next_at', 'project', 'queued_at', 'report_id', 'room_ref', 'tries', 'url', 'v']);
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(outboxOf(home), name)).mode & 0o777, 0o600);
    }
    if (process.platform !== 'win32') assert.equal(fs.statSync(outboxOf(home)).mode & 0o777, 0o700);
    const log = fs.readFileSync(path.join(home, '.agentmash', 'log', 'reports.jsonl'), 'utf8');
    assert.ok(![KEY, DEV_TOKEN, USER_TOKEN, 'planted', 'signing secret'].some((secret) => log.includes(secret)), 'nor does the log');

    // sent late, each goes with the credentials its checkout resolves to then, and still without the text
    room.mode = 'up';
    room.requests.length = 0;
    assert.deepEqual(await onMachine(home, () => lib.drainOutbox({ max: 10 })), { sent: 4, dropped: 0, left: 0 });
    assert.ok(room.reports().every((r) => r.room === KEY && r.token === DEV_TOKEN && r.user === USER_TOKEN && !('diff' in r.body)));
    assert.ok(room.reports().some((r) => r.body.task_hint === 'rotate the signing secret'), 'the event itself is whole');
  } finally {
    await room.down();
  }
});

test('a kept report is the report as it was sent, without its diff: no more of a prompt than that carried, and none with hints off', async () => {
  const room = await startRoom();
  const machineOf = checkout(room.url);
  const { env, project, home } = machineOf;
  room.mode = 503;
  try {
    // a prompt longer than the 500 characters a report carries, and an edit under it
    const prompt = `rename the planted helper ${'and its callers '.repeat(40)}down to the very last one`;
    const sessionId = session();
    const submit = (extra = {}) =>
      runHook('user_prompt_submit.mjs', { session_id: sessionId, cwd: project, hook_event_name: 'UserPromptSubmit', prompt }, { ...env, ...extra });
    await submit();
    await runHook('post_tool_use.mjs', editOf(project, sessionId), env);
    // and a report with the changed text, which only a room that asked for it is sent
    await reportFrom(machineOf, 1, () => ({ diff: DIFF }));

    const live = new Map(room.reports().map((r) => [r.body.report_id, r.body]));
    const kept = entriesOf(home);
    assert.deepEqual(kept.map((e) => e.body.event_type), ['prompt', 'edit', 'edit']);
    for (const entry of kept) {
      const { diff, ...sent } = live.get(entry.report_id);
      assert.deepEqual(entry.body, sent, 'field for field what the server was sent');
      assert.equal(diff, entry.body.file_path === 'src/file-0.ts' ? DIFF : undefined);
    }
    assert.equal(kept[0].body.task_hint.length, lib.PROMPT_CHARS, 'the prompt as far as a report carries it');
    const text = () => filesOf(home).map((name) => fs.readFileSync(path.join(outboxOf(home), name), 'utf8')).join('\n');
    assert.ok(text().includes('rename the planted helper') && !text().includes('the very last one'), 'and no further');
    assert.ok(!text().includes('before the outage'), 'the changed text is in none of them');

    // with hints off the prompt stays in the session's own files, as on a live report, and out of the outbox
    for (const name of filesOf(home)) fs.rmSync(path.join(outboxOf(home), name));
    await submit({ AGENTMASH_HINTS: '0' });
    await runHook('post_tool_use.mjs', editOf(project, sessionId), { ...env, AGENTMASH_HINTS: '0' });
    assert.deepEqual(entriesOf(home).map((e) => [e.body.event_type, e.body.task_hint]), [['prompt', null], ['edit', null]]);
    assert.ok(!text().includes('planted'), 'not a word of it');
  } finally {
    await room.down();
  }
});

test('a report the room turns away is logged and not kept; one it may yet take is kept', async () => {
  const room = await startRoom();
  const machineOf = checkout(room.url);
  const { home } = machineOf;
  try {
    for (const status of [400, 401, 402, 403, 404, 409, 422]) {
      room.mode = status;
      room.code = 'no_such_luck';
      await reportFrom(machineOf, 1);
      assert.deepEqual(filesOf(home), [], `${status} is the room's answer`);
      const line = logOf(home).at(-1);
      assert.deepEqual([line.outcome, line.status, line.code, line.kept], ['refused', status, 'no_such_luck', undefined]);
    }
    let kept = 0;
    for (const status of [408, 429, 500, 502, 503, 504]) {
      room.mode = status;
      await reportFrom(machineOf, 1);
      kept += 1;
      assert.equal(entriesOf(home).length, kept, `${status} may pass`);
      const line = logOf(home).at(-1);
      assert.deepEqual([line.outcome, line.status, line.kept], ['refused', status, true]);
    }
  } finally {
    await room.down();
  }
});

test('a report still in the air when its hook has to go is kept on the way out', async () => {
  const room = await startRoom();
  const { env, project, home } = checkout(room.url);
  room.mode = 'hang';
  try {
    // session_end ends itself 2.5 s in, with a report it gave more time than that
    const sessionId = session();
    const end = await runHook(
      'session_end.mjs',
      { session_id: sessionId, cwd: project, hook_event_name: 'SessionEnd', reason: 'exit' },
      { ...env, AGENTMASH_TIMEOUT_MS: '10000' }
    );
    assert.deepEqual([end.code, end.stderr], [0, '']);
    const [entry, ...others] = entriesOf(home);
    assert.deepEqual(others, []);
    assert.deepEqual([entry.body.event_type, entry.body.session_id], ['session_end', sessionId]);
    const [line] = logOf(home);
    assert.deepEqual([line.outcome, line.kept], ['cut_off', true]);

    room.mode = 'up';
    assert.deepEqual(await onMachine(home, () => lib.drainOutbox()), { sent: 1, dropped: 0, left: 0 });
    assert.equal(room.stored.get(entry.report_id).event_type, 'session_end');
  } finally {
    await room.down();
  }
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

test('two drains started at the same moment send each entry once', async () => {
  const room = await startRoom();
  const machineOf = checkout(room.url);
  const { home } = machineOf;
  room.mode = 503;
  try {
    await reportFrom(machineOf, 60);
    room.mode = 'up';
    room.delayMs = 15; // long enough for each sender to meet the other's entries
    room.requests.length = 0;
    const script = `const lib = await import(process.argv[1]); process.stdout.write(JSON.stringify(await lib.drainOutbox({ max: 1000, budgetMs: ${within(20_000)} })));`;
    const drain = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href], {
          env: { ...baseEnv, AGENTMASH_HOME: home },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr))));
      });
    const [a, b] = await Promise.all([drain(), drain()]);
    assert.equal(a.sent + b.sent, 60, `${a.sent} and ${b.sent}`);
    assert.ok(a.sent > 0 && b.sent > 0, 'both were at it');
    assert.deepEqual([a.dropped, b.dropped], [0, 0]);
    assert.equal(room.reports().length, 60, 'no entry was sent by both');
    assert.equal(room.duplicates, 0);
    assert.equal(room.stored.size, 60);
    assert.deepEqual(filesOf(home), []);
  } finally {
    await room.down();
  }
});

test('two hooks whose reports arrive at the same moment send five entries each, and none of them twice', async () => {
  const room = await startRoom();
  const machineOf = checkout(room.url);
  const { env, project, home } = machineOf;
  room.mode = 503;
  try {
    await reportFrom(machineOf, 12);
    const waiting = entriesOf(home).map((e) => e.report_id);
    room.mode = 'up';
    room.delayMs = 15;
    room.requests.length = 0;
    const hooks = await Promise.all([
      runHook('post_tool_use.mjs', editOf(project, session()), env),
      runHook('post_tool_use.mjs', editOf(project, session()), env),
    ]);
    assert.deepEqual(hooks.map((h) => [h.code, h.stdout, h.stderr]), [[0, '', ''], [0, '', '']]);
    const late = room.reports().map((r) => r.body.report_id).filter((id) => waiting.includes(id));
    assert.equal(room.reports().length, 12, 'each hook’s own report, and five more from each');
    assert.equal(late.length, 10);
    assert.equal(new Set(late).size, 10, 'an entry one hook took was passed over by the other');
    assert.equal(room.duplicates, 0);
    assert.deepEqual(filesOf(home).length, 2, 'the two neither had room for wait for the next');
    assert.ok(filesOf(home).every((name) => name.endsWith('.json')), 'and nothing is left held');
  } finally {
    await room.down();
  }
});

test('an entry a dead sender left held is taken back after a minute; a live sender’s is left to it', async () => {
  const room = await startRoom();
  const machineOf = checkout(room.url);
  const { home, project } = machineOf;
  try {
    const now = Date.now();
    const dead = plant(home, { project, url: room.url }, now - 5000, eventOf(1));
    const live = plant(home, { project, url: room.url }, now - 4000, eventOf(2));
    const dir = outboxOf(home);
    fs.renameSync(path.join(dir, dead), path.join(dir, `${dead}.${now - 61_000}.claim`));
    fs.renameSync(path.join(dir, live), path.join(dir, `${live}.${now - 5000}.claim`));
    assert.deepEqual(await onMachine(home, () => lib.outboxStats()).then((s) => [s.count, s.oldest_at]), [2, now - 5000], 'a held entry still counts');

    assert.deepEqual(await onMachine(home, () => lib.drainOutbox({ now })), { sent: 1, dropped: 0, left: 1 });
    assert.deepEqual(room.reports().map((r) => r.body.file_path), ['src/file-1.ts'], 'the abandoned one');
    assert.deepEqual(filesOf(home), [`${live}.${now - 5000}.claim`], 'the other is still its sender’s');

    // and once that sender is a minute gone too, its entry is sent as well
    assert.deepEqual(await onMachine(home, () => lib.drainOutbox({ now: now + 56_000 })), { sent: 1, dropped: 0, left: 0 });
    assert.deepEqual(filesOf(home), []);
  } finally {
    await room.down();
  }
});

test('an entry the server does not take waits 30 s, then twice as long each time, up to half an hour', async () => {
  const room = await startRoom();
  const machineOf = checkout(room.url);
  const { home, project } = machineOf;
  room.mode = 503;
  try {
    let now = Date.now();
    plant(home, { project, url: room.url }, now - 1000, eventOf(1));
    const waits = [];
    for (let attempt = 1; attempt <= 9; attempt++) {
      const before = room.reports().length;
      assert.deepEqual(await onMachine(home, () => lib.drainOutbox({ now })), { sent: 0, dropped: 0, left: 1 });
      assert.equal(room.reports().length, before + 1, 'tried once it is due');
      const [entry] = entriesOf(home);
      assert.equal(entry.tries, attempt);
      waits.push(Math.round((entry.next_at - now) / 1000));
      // a moment before it is due, nobody asks the server anything
      await onMachine(home, () => lib.drainOutbox({ now: entry.next_at - 1000 }));
      assert.equal(room.reports().length, before + 1, 'not before');
      now = entry.next_at + 1;
    }
    assert.deepEqual(waits, [30, 60, 120, 240, 480, 960, 1800, 1800, 1800]);
  } finally {
    await room.down();
  }
});

test('the first report a server does not take ends the round, and one the room turns away for good is dropped and logged', async () => {
  const room = await startRoom();
  const machineOf = checkout(room.url);
  const { home, project } = machineOf;
  try {
    const now = Date.now();
    for (let i = 0; i < 10; i++) plant(home, { project, url: room.url }, now - 10_000 + i, eventOf(i));
    room.mode = 429;
    assert.deepEqual(await onMachine(home, () => lib.drainOutbox({ max: 10, now })), { sent: 0, dropped: 0, left: 10 });
    assert.equal(room.reports().length, 1, 'a server that is not taking reports is asked once');

    // The room answers again, and says no to these: a second attempt would only hear it again.
    room.mode = 403;
    room.code = 'room_deleted';
    room.requests.length = 0;
    assert.deepEqual(await onMachine(home, () => lib.drainOutbox({ max: 3, now })), { sent: 0, dropped: 3, left: 7 });
    assert.equal(room.reports().length, 3, 'at most `max` are tried');
    const refused = logOf(home).filter((line) => line.outcome === 'refused');
    assert.equal(refused.length, 3);
    assert.deepEqual(
      [refused[0].hook, refused[0].status, refused[0].code, refused[0].event_type, refused[0].repo, refused[0].url],
      ['outbox', 403, 'room_deleted', 'edit', project, room.url]
    );
    assert.equal(entriesOf(home).length, 7);

    // a budget that is spent stops the round where it is
    room.mode = 'up';
    assert.deepEqual(await onMachine(home, () => lib.drainOutbox({ max: 10, budgetMs: 0, now })), { sent: 0, dropped: 0, left: 7 });
  } finally {
    await room.down();
  }
});

test('a hook sends only what the server it just heard from missed; a drain asks every server, and one that is down once', async () => {
  const up = await startRoom();
  const down = await startRoom();
  const { env, project, home } = checkout(up.url);
  // a second checkout on the same machine, whose room is on another server
  const { project: other } = checkout(down.url);
  down.mode = 503;
  try {
    const now = Date.now();
    for (let i = 0; i < 8; i++) {
      plant(home, { project: other, url: down.url }, now - 20_000 + 2 * i, eventOf(i, { session_id: 'theirs' }));
      plant(home, { project, url: up.url }, now - 20_000 + 2 * i + 1, eventOf(i, { session_id: 'ours' }));
    }
    const hook = await runHook('post_tool_use.mjs', editOf(project, session()), env);
    assert.deepEqual([hook.code, hook.stdout, hook.stderr], [0, '', '']);
    assert.deepEqual(up.reports().map((r) => r.body.session_id).slice(1), Array(5).fill('ours'), 'five of its own server’s');
    assert.deepEqual(down.requests, [], 'and nothing to a server it has not heard from');
    assert.ok(entriesOf(home).every((e) => e.tries === 0), 'whose entries are as they were');

    // whoever drains asks both: the one that answers is sent the rest, the other one entry and no more
    assert.deepEqual(await onMachine(home, () => lib.drainOutbox({ max: 100, now })), { sent: 3, dropped: 0, left: 8 });
    assert.equal(up.stored.size, 9);
    assert.equal(down.reports().length, 1, 'asked once');
    assert.deepEqual(entriesOf(home).map((e) => [e.body.session_id, e.tries]), [['theirs', 1], ...Array(7).fill(['theirs', 0])]);
  } finally {
    await up.down();
    await down.down();
  }
});

test('an entry whose checkout no longer has that room waits where it is', async () => {
  const room = await startRoom();
  const other = await startRoom();
  const machineOf = checkout(room.url);
  const { home, project } = machineOf;
  const configFile = path.join(project, '.claude', 'agentmash', 'config.json');
  const config = fs.readFileSync(configFile, 'utf8');
  try {
    plant(home, { project, url: room.url }, Date.now() - 1000, eventOf(1));
    const drain = () => onMachine(home, () => lib.drainOutbox());

    fs.rmSync(configFile);
    assert.deepEqual(await drain(), { sent: 0, dropped: 0, left: 1 }, 'no room in the checkout any more');
    fs.writeFileSync(configFile, JSON.stringify({ url: other.url, room: KEY, room_ref: REF }));
    assert.deepEqual(await drain(), { sent: 0, dropped: 0, left: 1 }, 'a room on another server');
    fs.writeFileSync(configFile, JSON.stringify({ url: room.url, room: KEY, room_ref: 'rm_anotherroom' }));
    assert.deepEqual(await drain(), { sent: 0, dropped: 0, left: 1 }, 'another room on the same server');
    fs.writeFileSync(path.join(project, '.env'), 'AGENTMASH_DISABLE=1\n');
    fs.writeFileSync(configFile, config);
    assert.deepEqual(await drain(), { sent: 0, dropped: 0, left: 1 }, 'agentmash switched off in that checkout');
    assert.deepEqual([room.requests.length, other.requests.length], [0, 0], 'and nothing was sent anywhere');

    fs.rmSync(path.join(project, '.env'));
    assert.deepEqual(await drain(), { sent: 1, dropped: 0, left: 0 }, 'the room it was made for');
    assert.equal(room.reports()[0].room, KEY);
  } finally {
    await room.down();
    await other.down();
  }
});

test('a signed-in machine’s kept report is sent under its sign-in to the room it was last told of, and nothing is looked up for it', async () => {
  const room = await startRoom();
  const { env, project, home } = machine(room.port);
  room.mode = 503;
  try {
    const hook = await runHook('post_tool_use.mjs', editOf(project, session()), env, ['--global']);
    assert.equal(hook.code, 0, hook.stderr);
    const [entry] = entriesOf(home);
    assert.deepEqual([entry.room_ref, entry.url, entry.project], [REF, room.url, project]);
    assert.ok(!fs.readFileSync(path.join(outboxOf(home), entry.name), 'utf8').includes(USER_TOKEN), 'the sign-in is not in it');

    room.mode = 'up';
    room.requests.length = 0;
    assert.deepEqual(await onMachine(home, () => lib.drainOutbox()), { sent: 1, dropped: 0, left: 0 });
    assert.deepEqual(
      room.requests.map((r) => [r.path, r.room, r.user, r.source, r.body.developer]),
      [['/events', REF, USER_TOKEN, 'env', 'bob']],
      'as the hook would have sent it'
    );

    // with nothing remembered about the repository, the entry waits: a late report looks nothing up
    room.mode = 503;
    await runHook('post_tool_use.mjs', editOf(project, session()), env, ['--global']);
    assert.equal(entriesOf(home).length, 1);
    fs.rmSync(path.join(home, '.agentmash', 'rooms.json'));
    room.mode = 'up';
    room.requests.length = 0;
    assert.deepEqual(await onMachine(home, () => lib.drainOutbox()), { sent: 0, dropped: 0, left: 1 });
    assert.deepEqual(room.requests, []);
  } finally {
    await room.down();
  }
});

test('a server from before report ids takes a late report as any other, and the entry goes', async () => {
  const room = await startRoom();
  const machineOf = checkout(room.url);
  const { home } = machineOf;
  room.mode = 500;
  try {
    await reportFrom(machineOf, 2);
    room.mode = 'old';
    assert.deepEqual(await onMachine(home, () => lib.drainOutbox()), { sent: 2, dropped: 0, left: 0 });
    assert.equal(room.stored.size, 2);
    for (const body of room.stored.values()) assert.ok(body.report_id && Number.isFinite(body.delayed_ms), 'two fields it ignores');
  } finally {
    await room.down();
  }
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test('past 2,000 entries the oldest edits and prompts go first, and a session’s end and a commit’s events stay', async () => {
  const room = await startRoom();
  const machineOf = checkout(room.url);
  const { home, project } = machineOf;
  room.mode = 503;
  try {
    const start = Date.now() - 2 * 60 * 60_000;
    const kinds = [
      { event_type: 'session_end', tool: null, file_path: null },
      { event_type: 'edit', tool: 'git-commit', session_id: 'commit-abc1234', file_path: 'src/committed.ts' },
      { event_type: 'session_end', tool: 'git-commit', session_id: 'commit-abc1234', file_path: null },
      { event_type: 'prompt', tool: null, file_path: null },
      { event_type: 'edit' },
    ];
    // the oldest three are what a room is wrong without, then a prompt, then edits, and so on round
    const names = [];
    for (let i = 0; i < lib.OUTBOX_LIMITS.entries; i++) names.push(plant(home, { project, url: room.url }, start + i, eventOf(i, kinds[i % kinds.length])));
    assert.equal(await onMachine(home, () => lib.outboxStats().count), 2000);

    await reportFrom(machineOf, 1); // one more than the outbox holds
    const left = new Set(filesOf(home));
    const gone = names.filter((name) => !left.has(name));
    // room is made for a few more at once, a hundredth of the bound, so this pass is not run on every report
    assert.equal(left.size, 1980);
    assert.equal(gone.length, 21);
    const shed = names.filter((_, i) => i % kinds.length >= 3).slice(0, 21);
    assert.deepEqual(gone, shed, 'the oldest prompts and edits, and nothing else');
    assert.ok(names.slice(0, 3).every((name) => left.has(name)), 'a session’s end and a commit’s edit and end, older than all of them, are still there');
    const overflow = logOf(home).filter((line) => line.outcome === 'overflow');
    assert.equal(overflow.length, 21, 'each one given up is in the log');
    assert.ok(overflow.every((line) => line.hook === 'outbox' && ['edit', 'prompt'].includes(line.event_type) && line.tool !== 'git-commit'));
    assert.equal(entriesOf(home).at(-1).body.file_path, 'src/file-0.ts', 'and the new report is kept');
  } finally {
    await room.down();
  }
});

test('past 8 MB the oldest edits go first too, and when only ends are left the oldest of those', async () => {
  const room = await startRoom();
  const machineOf = checkout(room.url);
  const { home, project } = machineOf;
  room.mode = 503;
  try {
    const start = Date.now() - 60 * 60_000;
    const heavy = 'x'.repeat(1024 * 1024);
    const end = plant(home, { project, url: room.url }, start, eventOf(0, { event_type: 'session_end', task_hint: heavy }));
    const edits = [];
    for (let i = 1; i <= 8; i++) edits.push(plant(home, { project, url: room.url }, start + i, eventOf(i, { task_hint: heavy })));
    assert.ok((await onMachine(home, () => lib.outboxStats())).bytes > lib.OUTBOX_LIMITS.bytes);

    await reportFrom(machineOf, 1);
    let left = new Set(filesOf(home));
    assert.ok(left.has(end), 'the end stays');
    assert.deepEqual(edits.map((name) => left.has(name)), [false, false, true, true, true, true, true, true], 'the two oldest edits made the room');
    assert.ok((await onMachine(home, () => lib.outboxStats())).bytes <= lib.OUTBOX_LIMITS.bytes);
    assert.deepEqual(
      logOf(home).filter((line) => line.outcome === 'overflow').map((line) => [line.hook, line.event_type, line.file_path]),
      [['outbox', 'edit', 'src/file-1.ts'], ['outbox', 'edit', 'src/file-2.ts']],
      'and each is in the log as given up'
    );

    // an outbox of nothing but ends over its bound gives up the oldest end: the bound holds whatever is in it
    for (const name of filesOf(home)) fs.rmSync(path.join(outboxOf(home), name));
    const ends = [];
    for (let i = 0; i < 9; i++) ends.push(plant(home, { project, url: room.url }, start + i, eventOf(i, { event_type: 'session_end', task_hint: heavy })));
    await reportFrom(machineOf, 1, () => ({ event_type: 'session_end' }));
    left = new Set(filesOf(home));
    assert.deepEqual(ends.map((name) => left.has(name)), [false, false, true, true, true, true, true, true, true]);
  } finally {
    await room.down();
  }
});

test('an entry seven days old is removed and logged as expired, by whoever looks at the outbox next', async () => {
  const room = await startRoom();
  const machineOf = checkout(room.url);
  const { home, project } = machineOf;
  try {
    const now = Date.now();
    const old = plant(home, { project, url: room.url }, now - 7 * DAY_MS - 60_000, eventOf(1, { event_type: 'session_end', file_path: null }));
    const young = plant(home, { project, url: room.url }, now - 7 * DAY_MS + 60_000, eventOf(2));
    room.mode = 503;
    await reportFrom(machineOf, 1); // keeping a report looks
    assert.ok(!filesOf(home).includes(old) && filesOf(home).includes(young));
    let expired = logOf(home).filter((line) => line.outcome === 'expired');
    assert.deepEqual(expired.map((line) => [line.hook, line.event_type, line.file_path, line.repo]), [['outbox', 'session_end', null, project]]);
    assert.ok(expired[0].kept_ms >= 7 * DAY_MS);
    assert.equal(room.reports().length, 1, 'it is not sent on its way out');

    // and so does a drain: two minutes on, the younger one is too old as well
    room.mode = 'up';
    room.requests.length = 0;
    assert.deepEqual(await onMachine(home, () => lib.drainOutbox({ max: 0, now: now + 2 * 60_000 })), { sent: 0, dropped: 0, left: 1 });
    expired = logOf(home).filter((line) => line.outcome === 'expired');
    assert.deepEqual(expired.map((line) => line.file_path), [null, 'src/file-2.ts']);
    assert.deepEqual(room.requests, []);
    assert.equal(entriesOf(home).length, 1, 'the report kept a moment ago is not');
  } finally {
    await room.down();
  }
});

test('outboxStats says how many wait, how much they weigh and since when, and never throws', async () => {
  const { home, project } = machine(9, { committed: true });
  assert.deepEqual(await onMachine(home, () => lib.outboxStats()), { count: 0, bytes: 0, oldest_at: null }, 'no folder');
  assert.equal(await onMachine(home, () => lib.outboxDir()), outboxOf(home));
  const at = Date.now() - 90_000;
  const names = [plant(home, { project, url: 'http://127.0.0.1:9' }, at + 5, eventOf(1)), plant(home, { project, url: 'http://127.0.0.1:9' }, at, eventOf(2))];
  fs.writeFileSync(path.join(outboxOf(home), 'notes.txt'), 'not an entry');
  const bytes = names.reduce((sum, name) => sum + fs.statSync(path.join(outboxOf(home), name)).size, 0);
  assert.deepEqual(await onMachine(home, () => lib.outboxStats()), { count: 2, bytes, oldest_at: at });
  const blocked = path.join(tempDir('agentmash-outbox-blocked-'), 'a-file');
  fs.writeFileSync(blocked, '');
  assert.deepEqual(await onMachine(blocked, () => lib.outboxStats()), { count: 0, bytes: 0, oldest_at: null }, 'a home that is a file');
  assert.deepEqual(await onMachine(blocked, () => lib.drainOutbox()), { sent: 0, dropped: 0, left: 0 });
  assert.deepEqual(lib.OUTBOX_LIMITS.entries, 2000);
  assert.deepEqual(lib.OUTBOX_LIMITS.bytes, 8 * 1024 * 1024);
  assert.deepEqual(lib.OUTBOX_LIMITS.days, 7);
});

// ---------------------------------------------------------------------------
// What it costs
// ---------------------------------------------------------------------------

test('keeping a report adds under 20 ms to a hook, with an empty outbox and with a full one', async () => {
  const { home, project } = checkout('http://127.0.0.1:9');
  // No network at all: fetch fails at once, as a refused connection does, so what is timed is what a failure costs here.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };
  const median = (times) => times.slice().sort((a, b) => a - b)[Math.floor(times.length / 2)];
  const take = async (config) => {
    const times = [];
    for (let i = 0; i < 50; i++) {
      const started = performance.now();
      await lib.reportEvent(config, eventOf(i), { hook: 'post_tool_use', project });
      times.push(performance.now() - started);
    }
    return median(times);
  };
  try {
    await onMachine(home, async () => {
      const config = lib.withSignIn(lib.loadConfig(project));
      // the same failure with nothing kept (the kill switch's config): what a failed report cost before the outbox
      const before = await take({ ...config, disabled: true });
      assert.deepEqual(filesOf(home), []);
      const empty = await take(config);
      assert.equal(entriesOf(home).length, 50);
      // nearly full: every report kept stats the whole folder to hold it to its bounds
      for (let i = 0; i < 1900; i++) plant(home, { project, url: 'http://127.0.0.1:9' }, Date.now() - 100_000 + i, eventOf(i));
      const full = await take(config);
      assert.equal(entriesOf(home).length, 2000);
      const limit = within(20);
      assert.ok(empty - before < limit && empty < limit, `an empty outbox: ${empty.toFixed(2)} ms a report, ${before.toFixed(2)} ms without it`);
      assert.ok(full - before < limit && full < limit, `a full one: ${full.toFixed(2)} ms a report, ${before.toFixed(2)} ms without it`);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a hook that keeps a report leaves no process behind it', { skip: process.platform === 'win32' }, async () => {
  const room = await startRoom();
  const { env, project, home } = checkout(room.url);
  await room.down();
  // In a process group of its own, so anything it started and left running is still in the group when it has gone.
  const child = spawn(process.execPath, [path.join(HOOKS_DIR, 'post_tool_use.mjs')], {
    env: { ...baseEnv, ...env },
    stdio: ['pipe', 'ignore', 'ignore'],
    detached: true,
  });
  child.stdin.end(JSON.stringify(editOf(project, session())));
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  assert.equal(entriesOf(home).length, 1, 'the report was kept');
  assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' }, 'nothing of its process group is alive');
  assert.deepEqual(filesOf(home).filter((name) => !name.endsWith('.json')), [], 'and nothing half written');
});

test('a report that arrives on a machine with no outbox costs one look at a folder that is not there', async () => {
  const { project, home } = checkout('http://127.0.0.1:9');
  // Every synchronous file call lib.mjs makes, recorded from before it is loaded.
  const probe = path.join(tempDir('agentmash-outbox-probe-'), 'probe.mjs');
  fs.writeFileSync(
    probe,
    `import fs from 'node:fs';
import http from 'node:http';
const calls = [];
for (const [name, fn] of Object.entries(fs)) {
  if (typeof fn !== 'function' || !name.endsWith('Sync')) continue;
  fs[name] = function (...args) {
    calls.push([name, String(args[0])]);
    return fn.apply(this, args);
  };
}
const [libUrl, project] = process.argv.slice(2);
const lib = await import(libUrl);
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end('{"ok":true,"id":1}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const config = { ...lib.loadConfig(project), url: 'http://127.0.0.1:' + server.address().port };
const from = calls.length;
const answer = await lib.reportEvent(config, { developer: 'bob', session_id: 's', event_type: 'edit', file_path: 'a.ts' }, { hook: 'probe', project });
await new Promise((r) => setTimeout(r, 100));
server.close();
process.stdout.write(JSON.stringify({ answer, calls: calls.slice(from) }));
`
  );
  const run = () => {
    const out = execFileSync(process.execPath, [probe, pathToFileURL(path.join(HOOKS_DIR, 'lib.mjs')).href, project], {
      env: { ...baseEnv, AGENTMASH_HOME: home },
    });
    return JSON.parse(out.toString());
  };
  const about = (calls) => calls.filter(([, target]) => target.includes(`${path.sep}outbox`));

  const none = run();
  assert.deepEqual(none.answer, { ok: true, id: 1 });
  assert.deepEqual(about(none.calls), [['readdirSync', outboxOf(home)]], 'one readdir, of a folder that is not there');
  assert.deepEqual(none.calls.at(-1), ['readdirSync', outboxOf(home)], 'and no file is touched after it');
  assert.ok(!fs.existsSync(outboxOf(home)), 'nor is the folder made');

  // an outbox every report has left costs the same one call
  fs.mkdirSync(outboxOf(home), { recursive: true });
  const empty = run();
  assert.deepEqual(about(empty.calls), [['readdirSync', outboxOf(home)]]);
  assert.deepEqual(empty.calls.at(-1), ['readdirSync', outboxOf(home)]);
});

test('with AGENTMASH_DISABLE set nothing is kept, nothing is sent and nothing is tidied', async () => {
  const room = await startRoom();
  const machineOf = checkout(room.url);
  const { env, project, home } = machineOf;
  try {
    await room.down();
    const hook = await runHook('post_tool_use.mjs', editOf(project, session()), { ...env, AGENTMASH_DISABLE: '1' });
    assert.deepEqual([hook.code, hook.stdout, hook.stderr], [0, '', '']);
    assert.ok(!fs.existsSync(outboxOf(home)), 'no outbox');
    assert.deepEqual(logOf(home), [], 'and no log');

    await room.up();
    const old = plant(home, { project, url: room.url }, Date.now() - 8 * DAY_MS, eventOf(1));
    const due = plant(home, { project, url: room.url }, Date.now() - 1000, eventOf(2));
    process.env.AGENTMASH_DISABLE = '1';
    try {
      assert.deepEqual(await onMachine(home, () => lib.drainOutbox()), { sent: 0, dropped: 0, left: 0 });
      // a hook that still reports, with agentmash off for its process, sends none of them along
      const config = { ...lib.withSignIn(await onMachine(home, () => lib.loadConfig(project))), disabled: true };
      room.mode = 503;
      await onMachine(home, () => lib.reportEvent(config, eventOf(3), { hook: 'post_tool_use', project }));
    } finally {
      delete process.env.AGENTMASH_DISABLE;
    }
    assert.deepEqual(filesOf(home), [old, due].sort(), 'both are as they were, the one past its seven days too');
    assert.equal(room.reports().length, 1, 'only the report made by hand reached the server');

    room.mode = 'up';
    assert.deepEqual(await onMachine(home, () => lib.drainOutbox()), { sent: 1, dropped: 0, left: 0 }, 'switched on again, it goes on as before');
  } finally {
    await room.down();
  }
});

// ---------------------------------------------------------------------------
// The other clients
// ---------------------------------------------------------------------------

/** Run a client script in `dir` (the checkout's own, by default) with `payload` on its stdin. */
function runClient(script, args, env, payload = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

/** A real repository with one commit of two files, its room in its config, and the environment git runs in here. */
function committedRepo(url) {
  const { env, home } = machine(Number(new URL(url).port), { committed: true });
  const repo = fs.realpathSync(tempDir('agentmash-outbox-repo-'));
  const gitconfig = path.join(tempDir('agentmash-outbox-git-'), 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  // an empty global config: the developer's own hooks and identity stay out of a temporary repository
  const gitEnv = { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...baseEnv, ...gitEnv }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'alice@example.com');
  git('config', 'user.name', 'Alice');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(repo, '.claude', 'agentmash'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'agentmash', 'config.json'), JSON.stringify({ url, room: KEY, room_ref: REF }));
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 2;\n');
  git('add', 'a.ts', 'b.ts');
  git('commit', '-q', '-m', 'Add a and b');
  return { repo, home, git, env: { ...gitEnv, AGENTMASH_HOME: home, AGENTMASH_DEV: env.AGENTMASH_DEV } };
}

/** A folder with a client script beside a lib.mjs from before reportEvent, as a repository that vendored one long ago has. */
function besideOldLib(client) {
  const dir = tempDir('agentmash-outbox-oldlib-');
  const oldLib = fs.readFileSync(path.join(HOOKS_DIR, 'lib.mjs'), 'utf8').split('// ── symbol extraction')[0];
  assert.ok(!oldLib.includes('function reportEvent('), 'the stand-in lib must really lack reportEvent');
  fs.writeFileSync(path.join(dir, 'lib.mjs'), oldLib);
  fs.copyFileSync(path.join(CLIENTS_DIR, client), path.join(dir, path.basename(client)));
  return path.join(dir, path.basename(client));
}

test('the git client’s commit made while the server is down is kept, noted as reported once, and arrives later with the commit’s time', async () => {
  const room = await startRoom();
  const { repo, home, git, env } = committedRepo(room.url);
  const worker = path.join(CLIENTS_DIR, 'git', 'post_commit.mjs');
  await room.down();
  try {
    const first = await runClient(worker, [repo], env);
    assert.deepEqual([first.code, first.stdout, first.stderr], [0, '', '']);
    const kept = entriesOf(home);
    assert.deepEqual(kept.map((e) => [e.body.event_type, e.body.tool, e.body.file_path]).sort(), [
      ['edit', 'git-commit', 'a.ts'],
      ['edit', 'git-commit', 'b.ts'],
      ['session_end', 'git-commit', undefined],
    ]);
    const [sha, when] = git('log', '-1', '--format=%H%n%cI').split('\n');
    assert.ok(kept.every((e) => e.body.session_id === `commit-${sha.slice(0, 7)}` && e.body.timestamp === when && e.project === repo));
    assert.ok(logOf(home).every((line) => line.hook === 'git_post_commit' && line.kept === true));

    // The commit is noted as reported before anything is sent, and still is: run again, the client adds nothing.
    assert.ok(fs.readFileSync(path.join(repo, '.git', 'agentmash-reported.json'), 'utf8').includes(sha));
    await runClient(worker, [repo], env);
    assert.equal(entriesOf(home).length, 3, 'a commit whose report is waiting is not reported a second time');

    await room.up();
    assert.deepEqual(await onMachine(home, () => lib.drainOutbox({ max: 10 })), { sent: 3, dropped: 0, left: 0 });
    assert.deepEqual([...room.stored.keys()].sort(), kept.map((e) => e.report_id).sort());
    assert.ok([...room.stored.values()].every((body) => body.timestamp === when && Number.isFinite(body.delayed_ms)));
    assert.ok(room.reports().every((r) => r.room === KEY));
  } finally {
    await room.down();
  }
});

test('the Cursor adapter’s reports carry an id, and one made while the server is down is kept', async () => {
  const room = await startRoom();
  const { env, project, home } = checkout(room.url);
  const adapter = path.join(CLIENTS_DIR, 'cursor', 'after_file_edit.mjs');
  const conversation = session();
  const edit = {
    conversation_id: conversation,
    hook_event_name: 'afterFileEdit',
    workspace_roots: [project],
    file_path: path.join(project, 'src', 'models', 'user.ts'),
    edits: [{ old_string: 'a', new_string: 'b' }],
  };
  try {
    const arrived = await runClient(adapter, [], env, edit);
    assert.deepEqual([arrived.code, arrived.stdout, arrived.stderr], [0, '', '']);
    const [sent] = room.reports();
    assert.match(sent.body.report_id, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual([sent.body.tool, sent.body.file_path], ['afterFileEdit', 'src/models/user.ts']);
    assert.ok(!fs.existsSync(outboxOf(home)), 'a report that arrives is kept nowhere');

    await room.down();
    await runClient(adapter, [], env, edit);
    await runClient(adapter, [], env, { conversation_id: conversation, hook_event_name: 'sessionEnd', workspace_roots: [project], reason: 'window_close' });
    assert.deepEqual(entriesOf(home).map((e) => [e.body.event_type, e.body.tool, e.body.session_id]), [
      ['edit', 'afterFileEdit', conversation],
      ['session_end', 'sessionEnd', conversation],
    ]);
    assert.deepEqual(logOf(home).map((line) => [line.hook, line.kept]), [['cursor:afterFileEdit', true], ['cursor:sessionEnd', true]]);

    // back up: the adapter's next report arrives, and it sends the two that waited
    await room.up();
    room.requests.length = 0;
    await runClient(adapter, [], env, edit);
    assert.equal(room.reports().length, 3);
    assert.deepEqual(filesOf(home), []);
  } finally {
    await room.down();
  }
});

test('both clients beside a lib.mjs from before reports had ids post as they always did, and keep nothing', async () => {
  const room = await startRoom();
  try {
    // the git client, vendored beside an old lib.mjs
    const { repo, home, env } = committedRepo(room.url);
    const worker = besideOldLib(path.join('git', 'post_commit.mjs'));
    const committed = await runClient(worker, [repo], env);
    assert.deepEqual([committed.code, committed.stdout, committed.stderr], [0, '', '']);
    assert.deepEqual(room.reports().map((r) => [r.body.event_type, r.body.file_path, r.body.report_id]).sort(), [
      ['edit', 'a.ts', undefined],
      ['edit', 'b.ts', undefined],
      ['session_end', undefined, undefined],
    ]);

    // and Cursor's adapter
    const { env: cursorEnv, project, home: cursorHome } = checkout(room.url);
    const adapter = besideOldLib(path.join('cursor', 'after_file_edit.mjs'));
    const edit = {
      conversation_id: session(),
      hook_event_name: 'afterFileEdit',
      workspace_roots: [project],
      file_path: path.join(project, 'src', 'models', 'user.ts'),
      edits: [{ old_string: 'a', new_string: 'b' }],
    };
    room.requests.length = 0;
    const edited = await runClient(adapter, [], cursorEnv, edit);
    assert.deepEqual([edited.code, edited.stdout, edited.stderr], [0, '', '']);
    assert.deepEqual(room.reports().map((r) => [r.body.event_type, r.body.file_path, r.body.report_id]), [['edit', 'src/models/user.ts', undefined]]);

    // with the server gone they stay as quiet as they were, and leave nothing on the machine
    await room.down();
    fs.writeFileSync(path.join(repo, 'c.ts'), 'export const c = 3;\n');
    execFileSync('git', ['add', 'c.ts'], { cwd: repo, env: { ...baseEnv, ...env } });
    execFileSync('git', ['commit', '-q', '-m', 'Add c'], { cwd: repo, env: { ...baseEnv, ...env } });
    const lost = await runClient(worker, [repo], env);
    const quiet = await runClient(adapter, [], cursorEnv, edit);
    assert.deepEqual([lost.code, lost.stderr, quiet.code, quiet.stderr], [0, '', 0, '']);
    assert.ok(!fs.existsSync(outboxOf(home)) && !fs.existsSync(outboxOf(cursorHome)));
  } finally {
    await room.down().catch(() => {});
  }
});
