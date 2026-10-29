// `npx agentmash ask` and `npx agentmash inbox`: prompt your teammate's agent.
// What these tests pin: every request goes with this machine's sign-in as a
// Bearer token and the room by its ref, and nothing else; ask always sends a
// suggestion, read only; accept prints the text alone on stdout, with what
// the person should know on stderr, and never anything to an agent; nothing
// is sent until every argument reads; and the room is the checkout's own,
// refused without a sign-in or outside a connected room.
//
// The server is a stand-in on port 0; every run has a home of its own.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AGENT_SHELL_MARKERS,
  agentShell,
  askBody,
  confirmCode,
  confirmedAtTerminal,
  parseInboxArgs,
  stateText,
  takenByHand,
} from '../inbox.mjs';

const CLI_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODULE = pathToFileURL(path.join(CLI_DIR, 'inbox.mjs')).href;
const CLI = path.join(CLI_DIR, 'agentmash.mjs');
// the room as agentmash.mjs finds it, handed over in the environment, so the module is tested on its own; and the
// person's own terminal, as INBOX_TYPED says: 'none' for no terminal, 'code' for typing back the code it shows, or
// what is typed there. Never the real /dev/tty, which a test run from a terminal would otherwise wait on.
// INBOX_SHOWN, when set, is a file that gets what the terminal was shown. 'nothing' types nothing at all.
const RUNNER =
  'const fs = await import("node:fs"); const m = await import(process.argv[1]); const room = JSON.parse(process.env.INBOX_ROOM);' +
  ' const typed = process.env.INBOX_TYPED ?? "none"; let shown = "";' +
  ' const terminal = () => typed === "none" ? null : {' +
  '   say: (text) => { shown += text; },' +
  '   line: async () => typed === "code" ? (/type (\\w+) and press enter/.exec(shown)?.[1] ?? "") : typed === "nothing" ? null : typed,' +
  '   close: () => { if (process.env.INBOX_SHOWN) fs.writeFileSync(process.env.INBOX_SHOWN, shown); },' +
  ' };' +
  ' await m[process.argv[2]](process.argv.slice(3), { roomOf: async () => room, terminal });';
const MACHINE = 'amu_machinetokenmachinetokenxx';
const REF = 'rm_0123456789';
const KEY = 'mash_inboxcliinboxcliinbox';

// a person's own terminal: none of ours, and none of the markers an agent's shell carries (this may run inside one)
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTMASH_') && k !== 'NO_COLOR' && !AGENT_SHELL_MARKERS.includes(k))
);
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
/** What `fn` throws, as text; '' when it throws nothing. */
function catchMessage(fn) {
  try {
    fn();
  } catch (err) {
    return err.message;
  }
  return '';
}

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

const at = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

function message(overrides = {}) {
  return {
    id: 'msg_AAAAAAAAAAAAAAAAAAAAAA',
    room: REF,
    from_user: 'bob',
    to: { user: 'alice', session_id: null },
    body: 'can you check why ci is red on main?\nonly read, please.',
    mode: 'suggest',
    scope: 'read_only',
    created_at: at(-4),
    expires_at: at(56),
    parent_msg: null,
    hop: 0,
    state: 'pending',
    approved: null,
    denied: null,
    failure: null,
    history: [{ state: 'pending', at: at(-4), by: 'bob', machine_id: null }],
    ...overrides,
  };
}

/** What accepting by hand leaves: done, approved by hand into no session on no machine, delivered by no machine. */
function takenFields(m, by = m.to?.user ?? 'alice') {
  return {
    state: 'done',
    approved: { by, at: at(0), session_id: null, machine_id: null, mode: 'suggest', scope: m.scope ?? 'read_only', by_hand: true },
    delivered_at: at(0),
    result: { summary: `taken by hand, to run in ${by}’s own agent`, diff_ref: null, cost_usd: null },
    history: [
      ...(m.history ?? []),
      { state: 'approved', at: at(0), by, machine_id: null },
      { state: 'delivered', at: at(0), by, machine_id: null },
      { state: 'done', at: at(0), by, machine_id: null },
    ],
  };
}

/** A request `to` took by hand. */
function taken(overrides = {}) {
  const m = message(overrides);
  return { ...m, ...takenFields(m) };
}

/**
 * The inbox's routes, as the server answers them, and /api/lookup. `state`
 * is the test's to change while it runs: `messages` what is there,
 * `answer[route]` a { status, body } one route gives instead, `delivery` what a
 * send says of how the teammate sees it.
 */
async function startServer() {
  const requests = [];
  const state = { messages: [message()], answer: {}, lookup: { status: 200, body: { repo: 'acme/app', room_ref: REF, developer: 'alice' } } };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        authorization: req.headers.authorization,
        room: req.headers['x-agentmash-room'],
        user: req.headers['x-agentmash-user'],
        token: req.headers['x-agentmash-token'],
        cookie: req.headers.cookie,
        contentType: req.headers['content-type'],
        body: raw ? JSON.parse(raw) : null,
      });
      const send = ({ status, body }) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/api/lookup') return send(state.lookup);
      if (url.pathname === '/api/v1/room') return send({ status: 200, body: { room_ref: REF } });
      const m = /^\/api\/v1\/lobby\/inbox(?:\/(msg_[A-Za-z0-9_-]+))?(?:\/(accept|deny|cancel))?$/.exec(url.pathname);
      if (!m) return send({ status: 404, body: { error: 'no such route', code: 'not_found' } });
      const [, id, verb] = m;
      const route = !id ? (req.method === 'POST' ? 'send' : 'list') : verb ?? 'one';
      if (state.answer[route]) return send(state.answer[route]);
      if (req.headers.authorization !== `Bearer ${MACHINE}` || req.headers['x-agentmash-room'] !== REF) {
        return send({ status: 401, body: { error: 'sign in again', code: 'room_unauthorized' } });
      }
      const found = id ? state.messages.find((x) => x.id === id) : null;
      if (id && !found) return send({ status: 404, body: { error: 'no such message here, or not yours to see', code: 'not_found' } });
      if (route === 'list') return send({ status: 200, body: { messages: state.messages, next_before: null } });
      if (route === 'one') return send({ status: 200, body: { message: found } });
      if (route === 'send') {
        const asked = JSON.parse(raw);
        const sent = message({ id: 'msg_SENTSENTSENTSENTSENT12', from_user: 'alice', to: asked.to, body: asked.body, created_at: at(0), expires_at: at(asked.ttl_minutes ?? 60) });
        state.messages.push(sent);
        // a server since 2026-10 says how and when they see it (state.delivery); one from before, nothing
        return send({ status: 201, body: { message: sent, ...(state.delivery ? { delivery: state.delivery } : {}) } });
      }
      if (route === 'accept') {
        Object.assign(found, takenFields(found, 'alice'));
        return send({ status: 200, body: { message: found } });
      }
      if (route === 'deny') {
        Object.assign(found, { state: 'denied', denied: { by: 'alice', at: at(0), reason: JSON.parse(raw).reason } });
        return send({ status: 200, body: { message: found } });
      }
      Object.assign(found, { state: 'failed', failure: { code: 'canceled', message: 'alice took it back' } });
      return send({ status: 200, body: { message: found } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, requests, state };
}

function exec(argv, { home = os.tmpdir(), cwd = os.tmpdir(), env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd,
      env: { ...baseEnv, AGENTMASH_HOME: home, HOME: home, USERPROFILE: home, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: strip(stdout), stderr: strip(stderr) }));
  });
}

/** The module's own command (cmdAsk or cmdInbox) with the room it would find, in a person's terminal unless `env` says otherwise. */
const run = (fn, args, server, env = {}) =>
  exec(['--input-type=module', '-e', RUNNER, MODULE, fn, ...args], {
    env: { INBOX_ROOM: JSON.stringify({ server: server.url, ref: REF, token: MACHINE, login: 'alice', repo: 'acme/app' }), ...env },
  });

/** A person at their own terminal, who types back the code accept shows them there. */
const AT_TERMINAL = { INBOX_TYPED: 'code' };

/** A home signed in to `url` (null: not signed in). */
function home(url) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-inbox-')));
  if (url) {
    fs.mkdirSync(path.join(dir, '.agentmash'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agentmash', 'user.json'), JSON.stringify({ url, token: MACHINE, login: 'alice' }));
  }
  return dir;
}

/** A checkout whose origin is acme/app, with the room's config committed when `config` is given. */
function checkout(config = null) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-inbox-repo-')));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:Acme/App.git\n');
  if (config) {
    fs.mkdirSync(path.join(dir, '.claude', 'agentmash'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'agentmash', 'config.json'), JSON.stringify(config));
  }
  return dir;
}

// ── the arguments ───────────────────────────────────────────────────────────

test('ask reads who and what, and always asks for a suggestion that only reads', () => {
  assert.deepEqual(askBody(parseInboxArgs(['@Bob', 'look at', 'the flaky test'])), {
    to: { user: 'bob', session_id: null },
    body: 'look at the flaky test',
    mode: 'suggest',
    scope: 'read_only',
  });
  const session = 'ls_0b6f2c1e-4a8d-4c3b-9e2f-7d1a5c9b3e40';
  assert.deepEqual(askBody(parseInboxArgs(['bob', '--session', session, '--ttl=15', '-- not that file'])), {
    to: { user: 'bob', session_id: session },
    body: '-- not that file',
    mode: 'suggest',
    scope: 'read_only',
    ttl_minutes: 15,
  });
  for (const [argv, said] of [
    [[], /say who/],
    [['@bob'], /say what you want bob's agent to do/],
    [['@not a login', 'x'], /not a GitHub login/],
    [['bob', 'x', '--ttl', '0'], /--ttl takes minutes/],
    [['bob', 'x', '--ttl', '9999'], /--ttl takes minutes/],
    [['bob', 'x', '--session', 'abc'], /--session takes/],
    [['bob', 'x'.repeat(32_001)], /at most 32000/],
  ]) {
    assert.throws(() => askBody(parseInboxArgs(argv)), said, JSON.stringify(argv).slice(0, 60));
  }
  // PowerShell reads @bob as a variable to splat and passes nothing for it, so
  // the request's words arrive where the login should be: said, and never an @
  // in what it tells the person to type
  assert.throws(() => askBody(parseInboxArgs(['look at the flaky test'])), (err) => {
    assert.match(err.message, /"look at the flaky test" is not a GitHub login: npx agentmash ask teammate "…"/);
    assert.match(err.message, /in PowerShell a word that starts with @ never reaches the command: type the login without it/);
    return true;
  });
  assert.doesNotMatch(catchMessage(() => askBody(parseInboxArgs(['@not a login', 'x']))), /PowerShell/, 'only when the words were all that arrived');
  // `ask @dana fix` from PowerShell: fix reads as a login too, and the @ was dropped all the same
  assert.throws(() => askBody(parseInboxArgs(['fix'])), (err) => {
    assert.match(err.message, /say what you want fix's agent to do: npx agentmash ask fix "…"/);
    assert.match(err.message, /in PowerShell a word that starts with @ never reaches the command: type the login without it/);
    return true;
  });
  assert.doesNotMatch(catchMessage(() => askBody(parseInboxArgs(['bob', ' ']))), /PowerShell/, 'words that say nothing are not a dropped @');
  for (const argv of [[], ['@bob'], ['look at the flaky test']]) {
    assert.doesNotMatch(catchMessage(() => askBody(parseInboxArgs(argv))), /ask @/, JSON.stringify(argv));
  }
  assert.match(catchMessage(() => askBody(parseInboxArgs(['@bob']))), /npx agentmash ask bob "…"/);
  assert.throws(() => parseInboxArgs(['--mode', 'queue']), /unknown option --mode/, 'no way to ask for more than a suggestion');
  assert.throws(() => parseInboxArgs(['--scope=edit']), /unknown option --scope/, 'or for more than reading');
  assert.throws(() => parseInboxArgs(['--json=yes']), /takes no value/);
});

test('where a request is, said from the side of whoever asks', () => {
  assert.equal(stateText(message(), 'alice'), 'waiting for you');
  assert.equal(stateText(message(), 'bob'), 'waiting for alice');
  assert.equal(stateText(taken(), 'bob'), 'taken by alice, to run in their own agent');
  assert.equal(stateText(taken(), 'alice'), 'taken by you, to run in your own agent');
  // done in a lobby session: approved into it, delivered by its machine
  const lobby = message({
    state: 'done',
    approved: { by: 'alice', at: at(0), session_id: 'ls_0b6f2c1e-4a8d-4c3b-9e2f-7d1a5c9b3e40', machine_id: 'mc_1', mode: 'suggest', scope: 'read_only', by_hand: false },
    history: [{ state: 'delivered', at: at(0), by: 'alice', machine_id: 'mc_1' }],
  });
  assert.equal(stateText(lobby, 'bob'), 'done');
  assert.equal(takenByHand(lobby), false);
  // from a server before by_hand: a daemon's approval, which never said it
  const { by_hand: _byHand, ...before } = lobby.approved;
  assert.equal(takenByHand({ ...lobby, approved: before }), false);
  assert.equal(takenByHand({ ...taken(), state: 'failed' }), false);
  assert.equal(stateText(message({ state: 'denied', denied: { reason: 'busy\nthis week' } }), 'bob'), 'alice said no: "busy this week"');
  assert.equal(stateText(message({ state: 'failed', failure: { code: 'canceled' } }), 'bob'), 'taken back');
  assert.equal(stateText(message({ state: 'expired' }), 'bob'), 'expired: nobody answered in time');
});

// ── ask ─────────────────────────────────────────────────────────────────────

test('ask sends the sign-in and the room’s ref, a suggestion that only reads, and says what happens next', async () => {
  const server = await startServer();
  const res = await run('cmdAsk', ['@bob', 'can you review my csv export?', '--ttl', '30'], server);
  assert.equal(res.code, 0, res.stderr);
  const [sent] = server.requests;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.path, '/api/v1/lobby/inbox');
  assert.deepEqual(sent.query, {}, 'nothing in the URL');
  assert.deepEqual([sent.authorization, sent.room, sent.user, sent.token, sent.cookie], [`Bearer ${MACHINE}`, REF, undefined, undefined, undefined]);
  assert.deepEqual(sent.body, {
    to: { user: 'bob', session_id: null },
    body: 'can you review my csv export?',
    mode: 'suggest',
    scope: 'read_only',
    ttl_minutes: 30,
  });
  assert.match(res.stdout, /sent bob a request for their agent\s+msg_SENTSENTSENTSENTSENT12/);
  assert.match(res.stdout, /a suggestion, read only · expires in (29|30) min/);
  assert.match(res.stdout, /they see it in npx agentmash inbox and on the dashboard; nothing runs until they accept it/);
  assert.match(res.stdout, /they paste it into their own agent themselves, which runs it on their own account/);
  assert.match(res.stdout, /npx agentmash inbox cancel msg_SENTSENTSENTSENTSENT12/);

  const self = await run('cmdAsk', ['@alice', 'hi'], server);
  assert.equal(self.code, 1);
  assert.match(self.stderr, /that is you/);
  const bad = await run('cmdAsk', ['@bob'], server);
  assert.equal(bad.code, 1);
  assert.equal(server.requests.length, 1, 'nothing sent until every argument reads');

  // the server's refusal, in its words
  server.state.answer.send = { status: 404, body: { error: 'carol cannot push to this room’s repository, as far as agentmash knows', code: 'recipient_not_member' } };
  const outsider = await run('cmdAsk', ['@carol', 'hi'], server);
  assert.equal(outsider.code, 1);
  assert.match(outsider.stderr, /carol cannot push to this room’s repository, as far as agentmash knows \(recipient_not_member\)/);
});

test('ask says how and when the teammate sees it, in the server’s words on one line; from a server from before, the lines it always said', async () => {
  const server = await startServer();
  server.state.delivery = {
    via: 'app_closed',
    text: "bob's agentmash app is closed, so they see it when they open it again, or on the dashboard. nothing reaches their agent until they approve it.",
  };
  const res = await run('cmdAsk', ['@bob', 'can you review my csv export?'], server);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /sent bob a request for their agent\s+msg_SENTSENTSENTSENTSENT12/);
  assert.ok(
    res.stdout.includes("  · bob's agentmash app is closed, so they see it when they open it again, or on the dashboard. nothing reaches their agent until they approve it.\n"),
    res.stdout
  );
  // in place of what a cli guessed before: he has the app, so he would not be pasting it in himself
  assert.doesNotMatch(res.stdout, /they paste it into their own agent themselves|they see it in npx agentmash inbox and on the dashboard; nothing runs/);
  assert.match(res.stdout, /npx agentmash inbox cancel msg_SENTSENTSENTSENTSENT12/);

  // the server's words go on one line, with nothing that moves the cursor, clears the screen or turns the words around
  server.state.delivery = { via: 'cli_only', text: 'bob sees it\u001b[2J in\nnpx agentmash inbox \u202eon the dashboard' };
  const odd = await run('cmdAsk', ['@bob', 'and the docs'], server);
  assert.equal(odd.code, 0, odd.stderr);
  assert.ok(!/[\u001b\u202e]/.test(odd.stdout));
  assert.ok(odd.stdout.includes('  · bob sees it [2J in npx agentmash inbox on the dashboard\n'), odd.stdout);

  // one that says nothing usable is one from before: the two lines that hold without the app
  server.state.delivery = { via: 'app_open', text: '   ' };
  const blank = await run('cmdAsk', ['@bob', 'and the tests'], server);
  assert.match(blank.stdout, /they see it in npx agentmash inbox and on the dashboard; nothing runs until they accept it/);
  assert.match(blank.stdout, /they paste it into their own agent themselves, which runs it on their own account/);

  // --json prints the message alone, as before, for a script that reads it
  server.state.delivery = { via: 'app_open', text: "bob's agentmash app is open, so it shows there now." };
  const json = await run('cmdAsk', ['@bob', 'and the readme', '--json'], server);
  assert.equal(JSON.parse(json.stdout).id, 'msg_SENTSENTSENTSENTSENT12');
  assert.equal(JSON.parse(json.stdout).delivery, undefined);
});

// ── inbox ───────────────────────────────────────────────────────────────────

test('inbox lists what waits for you and what you sent, each with where it is', async () => {
  const server = await startServer();
  server.state.messages.push(
    message({ id: 'msg_BBBBBBBBBBBBBBBBBBBBBB', from_user: 'dave', body: 'x'.repeat(400), created_at: at(-1), scope: 'edit' }),
    message({ id: 'msg_CCCCCCCCCCCCCCCCCCCCCC', from_user: 'alice', to: { user: 'bob', session_id: null }, state: 'denied', denied: { reason: 'busy' } }),
    taken({ id: 'msg_DDDDDDDDDDDDDDDDDDDDDD', from_user: 'alice', to: { user: 'dave', session_id: null } })
  );
  const res = await run('cmdInbox', [], server);
  assert.equal(res.code, 0, res.stderr);
  const [asked] = server.requests;
  assert.deepEqual([asked.method, asked.path, asked.query], ['GET', '/api/v1/lobby/inbox', { box: 'all', limit: '50' }]);
  assert.match(res.stdout, /agentmash inbox\s+alice · acme\/app/);
  assert.match(res.stdout, /waiting for you \(2\)/);
  assert.match(res.stdout, /msg_AAAAAAAAAAAAAAAAAAAAAA\s+from bob · 4 min ago · expires in 5[56] min · read only\n\s+"can you check why ci is red on main\? only read, please\."/);
  assert.match(res.stdout, /msg_BBBBBBBBBBBBBBBBBBBBBB\s+from dave · 1 min ago · expires in 5[56] min · may edit\n\s+"x{239}…"/, 'the start of a long one');
  assert.match(res.stdout, /npx agentmash inbox show <id>/);
  assert.match(res.stdout, /you sent/);
  assert.match(res.stdout, /msg_CCCCCCCCCCCCCCCCCCCCCC\s+to bob · 4 min ago · bob said no: "busy"/);
  assert.match(res.stdout, /msg_DDDDDDDDDDDDDDDDDDDDDD\s+to dave · 4 min ago · taken by dave, to run in their own agent/);

  const json = JSON.parse((await run('cmdInbox', ['--json'], server)).stdout);
  assert.deepEqual(
    [json.you, json.waiting.map((m) => m.id), json.sent.map((m) => m.id)],
    ['alice', ['msg_AAAAAAAAAAAAAAAAAAAAAA', 'msg_BBBBBBBBBBBBBBBBBBBBBB'], ['msg_CCCCCCCCCCCCCCCCCCCCCC', 'msg_DDDDDDDDDDDDDDDDDDDDDD']]
  );
  server.state.messages = [];
  assert.match((await run('cmdInbox', [], server)).stdout, /nothing waits for you/);
});

test('accept prints the text alone on stdout, says on stderr whose words they are and how far they may go, and sends nothing anywhere else', async () => {
  const server = await startServer();
  server.state.messages[0].body = 'check ci on main\n\u001b[2Jand say why it is red\r\nthanks';
  const res = await run('cmdInbox', ['accept', 'msg_AAAAAAAAAAAAAAAAAAAAAA'], server, AT_TERMINAL);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, 'check ci on main\n[2Jand say why it is red\nthanks\n', 'the text, every line of it, and no escape sequence');
  const [accepted] = server.requests;
  assert.deepEqual([accepted.method, accepted.path, accepted.body], ['POST', '/api/v1/lobby/inbox/msg_AAAAAAAAAAAAAAAAAAAAAA/accept', {}]);
  assert.deepEqual([accepted.authorization, accepted.room], [`Bearer ${MACHINE}`, REF]);
  assert.equal(server.requests.length, 1, 'one request: nothing is delivered to any agent');
  assert.match(res.stderr, /accepted bob's request msg_AAAAAAAAAAAAAAAAAAAAAA: marked done, and bob sees you took it/);
  assert.match(res.stderr, /paste the text below into your own agent yourself: nothing was sent to it/);
  assert.match(res.stderr, /it is bob's words for your agent, not yours/);
  assert.match(res.stderr, /bob asked that it only reads: run it where your agent cannot edit/);

  // taken back in between: nothing to paste
  server.state.answer.accept = { status: 200, body: { message: message({ state: 'failed', failure: { code: 'canceled' } }) } };
  const late = await run('cmdInbox', ['accept', 'msg_AAAAAAAAAAAAAAAAAAAAAA'], server, AT_TERMINAL);
  assert.equal(late.code, 1);
  assert.equal(late.stdout, '');
  assert.match(late.stderr, /it is taken back now, so there is nothing to paste/);
  server.state.answer.accept = { status: 409, body: { error: 'this message is done: it cannot be accepted now', code: 'invalid_transition', state: 'done' } };
  const twice = await run('cmdInbox', ['accept', 'msg_AAAAAAAAAAAAAAAAAAAAAA'], server, AT_TERMINAL);
  assert.match(twice.stderr, /this message is done: it cannot be accepted now \(invalid_transition\)/);
  delete server.state.answer.accept;
  const unknown = await run('cmdInbox', ['accept', 'msg_ZZZZZZZZZZZZZZZZZZZZZZ'], server, AT_TERMINAL);
  assert.match(unknown.stderr, /no request msg_ZZZZZZZZZZZZZZZZZZZZZZ here that was sent to you or by you/);
  const notAnId = await run('cmdInbox', ['accept', 'bob'], server, AT_TERMINAL);
  assert.equal(notAnId.code, 1);
  assert.match(notAnId.stderr, /is not a request id/);
  assert.equal(server.requests.filter((r) => r.path.endsWith('/accept')).length, 4, 'not one for an id that is not one');
});

test('show reads one whole, deny says no with a reason, and cancel takes back your own', async () => {
  const server = await startServer();
  const shown = await run('cmdInbox', ['show', 'msg_AAAAAAAAAAAAAAAAAAAAAA'], server);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(shown.stdout, 'can you check why ci is red on main?\nonly read, please.\n');
  assert.match(shown.stderr, /from bob · 4 min ago · read only · waiting for you/);
  assert.match(shown.stderr, /npx agentmash inbox accept msg_AAAAAAAAAAAAAAAAAAAAAA/);
  assert.equal(server.requests.at(-1).method, 'GET', 'reading one changes nothing');

  const denied = await run('cmdInbox', ['deny', 'msg_AAAAAAAAAAAAAAAAAAAAAA', 'busy', 'this', 'week'], server);
  assert.equal(denied.code, 0, denied.stderr);
  assert.deepEqual(server.requests.at(-1).body, { reason: 'busy this week' });
  assert.match(denied.stdout, /said no to bob's request msg_AAAAAAAAAAAAAAAAAAAAAA, with your reason: bob sees it/);

  server.state.messages.push(message({ id: 'msg_SENTSENTSENTSENTSENT12', from_user: 'alice', to: { user: 'bob', session_id: null } }));
  const canceled = await run('cmdInbox', ['cancel', 'msg_SENTSENTSENTSENTSENT12'], server);
  assert.equal(canceled.code, 0, canceled.stderr);
  assert.deepEqual([server.requests.at(-1).path, server.requests.at(-1).body], ['/api/v1/lobby/inbox/msg_SENTSENTSENTSENTSENT12/cancel', {}]);
  assert.match(canceled.stdout, /took back your request to bob/);

  const strange = await run('cmdInbox', ['approve', 'msg_AAAAAAAAAAAAAAAAAAAAAA'], server);
  assert.equal(strange.code, 1);
  assert.match(strange.stderr, /unknown inbox command: approve/);
});

test('from an agent’s shell, show, accept and deny are refused before the server is asked; the list says the user answers', async () => {
  const server = await startServer();
  const id = 'msg_AAAAAAAAAAAAAAAAAAAAAA';
  for (const marker of [{ CLAUDECODE: '1' }, { AI_AGENT: 'claude-code_2.1.0_agent' }, { CLAUDE_CODE_ENTRYPOINT: 'cli' }, { AGENT: 'amp' }, { GEMINI_CLI: '1' }]) {
    const [name] = Object.keys(marker);
    for (const argv of [['accept', id], ['deny', id, 'busy'], ['show', id], ['accept', id, '--json']]) {
      const res = await run('cmdInbox', argv, server, marker);
      assert.equal(res.code, 1, `${name}: ${argv.join(' ')}`);
      assert.equal(res.stdout, '', 'not a word of the request on stdout');
      assert.match(res.stderr, /run this in your own terminal or accept it on the dashboard: an agent never answers a teammate request for you/);
      assert.match(res.stderr, new RegExp(`\\(${name} is set: this is an agent's shell\\)`));
    }
  }
  assert.deepEqual(server.requests, [], 'nothing asked of the server');
  assert.equal(server.state.messages[0].state, 'pending', 'and it still waits for the person');

  // the list still reads, without the commands, and with the start of each text only
  server.state.messages[0].body = 'y'.repeat(400);
  const listed = await run('cmdInbox', [], server, { CLAUDECODE: '1' });
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /waiting for you \(1\)/);
  assert.match(listed.stdout, /the user reads, accepts or declines these in their own terminal \(npx agentmash inbox\) or on the dashboard/);
  assert.doesNotMatch(listed.stdout, /inbox accept|inbox deny|inbox show/);
  const json = JSON.parse((await run('cmdInbox', ['--json'], server, { CLAUDECODE: '1' })).stdout);
  assert.equal(json.waiting[0].body, `${'y'.repeat(239)}…`);
  assert.equal(JSON.parse((await run('cmdInbox', ['--json'], server)).stdout).waiting[0].body, 'y'.repeat(400), 'all of it in the person’s own terminal');

  // taking back your own request is yours to ask an agent for
  server.state.messages.push(message({ id: 'msg_SENTSENTSENTSENTSENT12', from_user: 'alice', to: { user: 'bob', session_id: null } }));
  assert.equal((await run('cmdInbox', ['cancel', 'msg_SENTSENTSENTSENTSENT12'], server, { CLAUDECODE: '1' })).code, 0);

  // and through the CLI itself
  const installed = checkout({ url: server.url, room: KEY, room_ref: REF });
  const viaCli = await exec([CLI, 'inbox', 'accept', id], { home: home(server.url), cwd: installed, env: { CLAUDECODE: '1' } });
  assert.equal(viaCli.code, 1);
  assert.match(viaCli.stderr, /an agent never answers a teammate request for you/);
  assert.ok(!server.requests.some((r) => r.path.endsWith('/accept')), 'never accepted');

  // a marker that is empty, 0 or false is no agent's
  assert.equal(agentShell({ CLAUDECODE: '0', AGENT: '', GEMINI_CLI: 'false' }), null);
  assert.equal(agentShell({ PATH: '/usr/bin' }), null);
  assert.equal(agentShell({ CURSOR_AGENT: '1' }), 'CURSOR_AGENT');
});

test('accept takes a code typed at the person’s own terminal, shown there only; without it nothing is accepted', async () => {
  const server = await startServer();
  const id = 'msg_AAAAAAAAAAAAAAAAAAAAAA';
  // no terminal of the person's behind it: an agent's shell no marker names, a CI job, Git Bash's mintty
  const none = await run('cmdInbox', ['accept', id], server, { INBOX_TYPED: 'none' });
  assert.equal(none.code, 1);
  assert.equal(none.stdout, '');
  assert.match(none.stderr, /there is no terminal of yours here to say yes at, so nothing was accepted: it still waits for you/);
  assert.match(none.stderr, /accept it on the dashboard \(in Git Bash's own window: winpty npx agentmash inbox accept msg_A{22}\)/);
  // something other than the code, or nothing in time
  for (const [typed, said] of [
    ['yes', /that was not the code, so nothing was accepted: it still waits for you/],
    ['  ', /that was not the code/],
    ['nothing', /no answer at your terminal in 2 minutes, so nothing was accepted/],
  ]) {
    const res = await run('cmdInbox', ['accept', id], server, { INBOX_TYPED: typed });
    assert.equal(res.code, 1, typed);
    assert.equal(res.stdout, '', 'not a word of the request');
    assert.match(res.stderr, said);
  }
  // the desktop app's terminals: its agents' and the person's own shell set the same marker, so both are refused,
  // and the person is told it is the app's terminal and where to say yes, not that they are an agent
  for (const action of ['accept', 'deny', 'show']) {
    const hosted = await run('cmdInbox', [action, id], server, { ...AT_TERMINAL, AGENTMASH_LOBBY_SESSION: 'hs_0123456789abcdef' });
    assert.equal(hosted.code, 1, action);
    assert.equal(hosted.stdout, '', action);
    assert.match(hosted.stderr, /this terminal is one the desktop app runs, and its agents run in them too, so a request is not answered here: accept or decline it in the app or on the dashboard \(AGENTMASH_LOBBY_SESSION is set\)/, action);
    assert.doesNotMatch(hosted.stderr, /this is an agent's shell/, action);
  }
  assert.deepEqual(server.requests, [], 'nothing asked of the server');
  assert.equal(server.state.messages[0].state, 'pending', 'and it still waits for the person');

  // typed back: accepted, and the code was on the terminal alone, never on stdout or stderr, which an agent reads
  const shownFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-inbox-shown-')), 'shown.txt');
  const yes = await run('cmdInbox', ['accept', id], server, { ...AT_TERMINAL, INBOX_SHOWN: shownFile });
  assert.equal(yes.code, 0, yes.stderr);
  const shown = fs.readFileSync(shownFile, 'utf8');
  assert.match(shown, /accept msg_A{22}\? only you can say yes to it, here at your own terminal\.\n {2}type [a-hj-km-np-z]{4} and press enter to accept it/);
  assert.doesNotMatch(`${yes.stdout}${yes.stderr}`, /press enter|only you can say yes/);
  assert.equal(yes.stdout, 'can you check why ci is red on main?\nonly read, please.\n');
  assert.equal(server.requests.filter((r) => r.path.endsWith('/accept')).length, 1);
});

test('the code is a new one every time, and only that code says yes', async () => {
  const codes = new Set(Array.from({ length: 20 }, () => confirmCode()));
  assert.ok(codes.size > 15, 'not one code for everyone');
  for (const code of codes) assert.match(code, /^[a-hj-km-np-z]{4}$/, 'letters nobody misreads');

  const terminal = (typed) => {
    const t = { shown: '', closed: false };
    t.say = (text) => (t.shown += text);
    t.line = async () => (typeof typed === 'function' ? typed(t.shown) : typed);
    t.close = () => (t.closed = true);
    return t;
  };
  const id = 'msg_AAAAAAAAAAAAAAAAAAAAAA';
  const right = terminal((shown) => ` ${/type (\w+) and/.exec(shown)[1].toUpperCase()}\r`);
  assert.equal(await confirmedAtTerminal(id, right), 'yes', 'as typed, give or take spaces and case');
  assert.ok(right.closed);
  for (const [typed, said] of [['abcd', 'no'], ['yes', 'no'], [null, 'none']]) {
    const t = terminal(typed);
    assert.equal(await confirmedAtTerminal(id, t, { code: 'wxyz' }), said, String(typed));
    assert.ok(t.closed, 'the terminal is let go of, whatever was typed');
  }
});

test('on Windows the code goes to the console itself, not to a file named CONOUT$ where the command runs', { skip: process.platform !== 'win32' && 'the console device is Windows only' }, () => {
  // run where the person's repo would be: a relative CONOUT$ is a plain file there, which nobody reads
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-inbox-conout-'));
  const script =
    'const m = await import(process.argv[1]); process.stdin.isTTY = true;' +
    ' const t = m.ownTerminal(); if (t) { t.say(""); t.close(); }';
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script, MODULE], { cwd, input: '', encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(fs.readdirSync(cwd), [], 'no file holding the code');
});

test('a server from before the inbox is said to be one', async () => {
  const server = await startServer();
  server.state.answer.list = { status: 404, body: { error: 'no such route', code: 'not_found' } };
  const res = await run('cmdInbox', [], server);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /has no teammate inbox: it is older than this CLI/);
});

// ── the room, as the CLI finds it ───────────────────────────────────────────

test('from the CLI: the checkout’s own room by its ref, beside this machine’s sign-in; refused without either', async () => {
  const server = await startServer();
  const signedIn = home(server.url);

  // a repository install: its config's ref, on the server it names
  const installed = checkout({ url: server.url, room: KEY, room_ref: REF });
  const listed = await exec([CLI, 'inbox'], { home: signedIn, cwd: installed });
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /waiting for you \(1\)/);
  const asked = server.requests.at(-1);
  assert.deepEqual([asked.authorization, asked.room, asked.user, asked.token], [`Bearer ${MACHINE}`, REF, undefined, undefined], 'the ref, never the key');

  // a signed-in machine: the room its GitHub repository is connected to
  const plain = checkout();
  const viaLookup = await exec([CLI, 'ask', '@bob', 'look at the flaky test'], { home: signedIn, cwd: plain });
  assert.equal(viaLookup.code, 0, viaLookup.stderr);
  const lookup = server.requests.find((r) => r.path === '/api/lookup');
  assert.deepEqual([lookup.query.repo, lookup.user], ['acme/app', MACHINE]);
  assert.equal(server.requests.at(-1).room, REF);

  // not signed in
  const lobbyAsks = () => server.requests.filter((r) => r.path.startsWith('/api/v1/lobby')).length;
  const before = lobbyAsks();
  const signedOut = await exec([CLI, 'ask', '@bob', 'hi'], { home: home(null), cwd: installed });
  assert.equal(signedOut.code, 1);
  assert.match(signedOut.stderr, /this machine is not signed in — run: npx agentmash login/);
  // outside a connected room
  server.state.lookup = { status: 404, body: { error: 'acme/app is not connected', code: 'not_connected', can_push: true } };
  const unconnected = await exec([CLI, 'inbox'], { home: signedIn, cwd: plain });
  assert.equal(unconnected.code, 1);
  assert.match(unconnected.stderr, /acme\/app is not connected to a room/);
  // outside a repository
  const nowhere = await exec([CLI, 'inbox'], { home: signedIn, cwd: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-nowhere-'))) });
  assert.equal(nowhere.code, 1);
  assert.match(nowhere.stderr, /is not inside a git repository/);
  // signed in to another server than the room's
  const elsewhere = checkout({ url: 'http://127.0.0.1:9', room: KEY, room_ref: REF });
  const otherServer = await exec([CLI, 'inbox'], { home: signedIn, cwd: elsewhere });
  assert.equal(otherServer.code, 1);
  assert.match(otherServer.stderr, /this machine is signed in to http:\/\/127\.0\.0\.1:\d+, and this repository's room is on http:\/\/127\.0\.0\.1:9/);
  assert.equal(lobbyAsks(), before, 'none of those asked the inbox');
});

test('the help shows ask with the login bare, which PowerShell passes as typed', async () => {
  const asked = await exec([CLI, 'ask', '--help']);
  assert.equal(asked.code, 0, asked.stderr);
  assert.match(asked.stdout, /npx agentmash ask teammate "what you want their agent to do"/);
  assert.match(asked.stdout, /teammate is their GitHub login, with no @: PowerShell drops a word that starts with one/);
  const all = await exec([CLI, '--help']);
  assert.match(all.stdout, /npx agentmash ask teammate "text"/);
  for (const said of [asked.stdout, all.stdout]) assert.doesNotMatch(said, /ask @/);
});
