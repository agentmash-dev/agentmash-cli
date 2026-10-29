// The claim tools, driven through a real MCP client over stdio, against a mock
// coordination server that records what the tools actually sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { ownerCheckFile } from '../../hooks/lib.mjs';

const MCP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = path.join(MCP_DIR, 'server.mjs');
const ROOM = 'mash_claimtestclaimtestc';
const ME = 'carol@example.com';

// Nothing of the Claude Code session these tests may be run from: the folder its session files are in
// would be the server's own (see claudeSessionId in hooks/mcp_server.mjs), and its session id is set
// only where a test means it.
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !k.startsWith('AGENTMASH_') && !['CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CONFIG_DIR'].includes(k)
  )
);

/** A Claude Code config folder with no session files in it. */
const noClaudeSessions = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-mcp-claude-'));

function makeProjectDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-mcp-claims-')));
}

async function connect({ port, env = {}, projectDir = makeProjectDir() } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...baseEnv,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_CONFIG_DIR: noClaudeSessions(),
      AGENTMASH_DEV: ME,
      ...(port ? { AGENTMASH_URL: `http://127.0.0.1:${port}`, AGENTMASH_ROOM: ROOM } : {}),
      ...env,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'claims-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, projectDir, close: () => client.close() };
}

async function callText(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result.content.map((c) => c.text).join('\n');
}

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

/**
 * A route-aware stand-in for the coordination server's claim endpoints. Each
 * request is kept with the credentials it carried. `lookup` is the room ref
 * /api/lookup gives a signed-in machine for any repository, or the refusal it
 * gives instead, as { status, body }; `refuse` is a reply every room route
 * gives instead of its own, the same way. `resolved` is added to the answer
 * to POST /resolutions, which a server from before pairs leaves out.
 */
function startMockServer({ overlaps = [], claims = [], collisions = [], reconcileMode = 'approve', lookup = null, refuse = null, label = 'claims repo', sessions = null, sessionReleases = 2, resolved = {} } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const body = raw ? JSON.parse(raw) : null;
      requests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
        room: req.headers['x-agentmash-room'],
        token: req.headers['x-agentmash-token'],
        user: req.headers['x-agentmash-user'],
        source: req.headers['x-agentmash-developer-source'],
      });
      const send = (code, payload) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === '/api/lookup') {
        if (!lookup) return send(404, { error: 'not connected', code: 'not_connected' });
        if (typeof lookup === 'object') return send(lookup.status, lookup.body);
        return send(200, { repo: url.searchParams.get('repo'), room_ref: lookup, developer: 'carol', dashboard_url: `http://x/r/${lookup}` });
      }
      if (refuse) return send(refuse.status, refuse.body);
      if (req.method === 'POST' && url.pathname === '/claims') {
        // a claim until merge on a branch of its own stands a week, as the room keeps it; on main, its TTL
        const untilMerged = body.until === 'merged' && typeof body.branch === 'string' && body.branch !== 'main';
        const renewed = body.task === 'and the api too' || body.task === 'merge the fixes';
        // renewed from another session of the same person, as the room says it
        const replaced = body.task === 'merge the fixes' ? { developer: ME, session_id: 'mcp-fixer', task: 'fix the pre-edit warning' } : null;
        return send(renewed ? 200 : 201, {
          ok: true,
          claim: {
            id: 'claim_mock0000001',
            developer: body.developer,
            session_id: body.session_id,
            task: body.task,
            paths: renewed ? [...body.paths, 'src/routes'] : body.paths,
            symbols: body.symbols ?? [],
            created_at: iso(0),
            expires_at: iso(untilMerged ? 7 * 24 * 60 * 60_000 : (body.ttl_minutes ?? 120) * 60_000),
            branch: body.branch ?? null,
            until: untilMerged ? 'merged' : null,
          },
          overlaps,
          ...(renewed ? { renewed: true } : {}),
          ...(replaced ? { replaced } : {}),
        });
      }
      if (req.method === 'POST' && url.pathname === '/claims/release') {
        return send(200, { ok: true, outcome: 'released', released: body.claim_id ? 1 : sessionReleases });
      }
      if (url.pathname === '/claims') return send(200, { claims });
      if (url.pathname === '/collisions') {
        return send(200, { reconcile_mode: reconcileMode, window_minutes: 60, collisions });
      }
      if (req.method === 'POST' && url.pathname === '/resolutions') {
        return send(201, {
          ok: true,
          resolution: {
            id: 'res_mock0000001',
            file_path: body.file_path,
            developers: ['alice@example.com', ME],
            resolved_by: body.developer,
            outcome: body.outcome,
            url: body.url ?? null,
            note: body.note ?? null,
            at: iso(0),
          },
          ...resolved,
        });
      }
      if (url.pathname === '/activity') {
        return send(200, {
          now: iso(0),
          room: ROOM,
          label,
          window_minutes: 60,
          sessions: sessions ?? [
            {
              developer: 'alice@example.com',
              session_id: 's1',
              task_hint: 'refactor auth',
              git_branch: 'main',
              last_touched: iso(-60_000),
              last_ts: Date.now() - 60_000,
              ended: false,
              ended_at: null,
              files: [],
            },
          ],
          claims,
          hot_files: [],
          events: [],
        });
      }
      send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: server.address().port, requests, close: () => new Promise((r) => server.close(r)) })
    );
  });
}

const aliceClaim = {
  id: 'claim_alice0000001',
  developer: 'alice@example.com',
  session_id: 'sess-alice',
  task: 'move soft deletes into the user model',
  paths: ['src/models'],
  symbols: ['User'],
  created_at: iso(-5 * 60_000),
  expires_at: iso(115 * 60_000),
  overlap: { paths: ['src/models'], symbols: [] },
};

test('claim_work posts this agent\'s intent and reports a clear scope', async () => {
  const mock = await startMockServer();
  const session = await connect({ port: mock.port });
  try {
    const text = await callText(session.client, 'claim_work', {
      task: 'add a login endpoint',
      paths: ['./src/routes/login.ts', 'src/routes/'],
    });
    const posted = mock.requests.find((r) => r.method === 'POST' && r.path === '/claims');
    assert.ok(posted, 'a claim should have been posted');
    assert.equal(posted.body.developer, ME);
    assert.equal(posted.source, 'env', 'AGENTMASH_DEV names it, and the request says so, as the hooks do');
    assert.match(posted.body.session_id, /^mcp-[A-Za-z0-9_-]+$/, 'the process mints a session id');
    assert.deepEqual(posted.body.paths, ['src/routes/login.ts', 'src/routes'], 'paths are normalised');
    assert.equal(posted.body.task, 'add a login endpoint');
    assert.equal(posted.body.ttl_minutes, 120);

    assert.match(text, /^Claimed src\/routes\/login\.ts, src\/routes for "add a login endpoint" as carol@example\.com/);
    assert.match(text, /id claim_mock0000001/);
    assert.match(text, /No one else has claimed anything in this scope/);
    assert.match(text, /release_claim/);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('a secret in claim_work’s task goes to the room masked, as a prompt’s does', async () => {
  const mock = await startMockServer();
  const session = await connect({ port: mock.port });
  // put together from parts, so no scanner reads it as a key (see hooks/test/secrets.test.mjs)
  const key = ['sk', '_live_', '51H', 'c'.repeat(30)].join('');
  try {
    await callText(session.client, 'claim_work', { task: `rotate ${key} in billing`, paths: ['src/billing.ts'] });
    const posted = mock.requests.find((r) => r.method === 'POST' && r.path === '/claims');
    assert.equal(posted.body.task, 'rotate [hidden] in billing');
    assert.ok(!JSON.stringify(mock.requests).includes(key), 'not in any request');
  } finally {
    await session.close();
    await mock.close();
  }
});

test('claim_work names an overlap and tells the agent to split the work', async () => {
  const mock = await startMockServer({ overlaps: [aliceClaim] });
  const session = await connect({ port: mock.port });
  try {
    const text = await callText(session.client, 'claim_work', {
      task: 'rename user fields',
      paths: ['src/models/user.ts'],
      symbols: ['User'],
    });
    assert.match(text, /OVERLAP — someone else has already claimed part of this/);
    assert.match(text, /alice@example\.com has src\/models for "move soft deletes into the user model" \(claimed 5 min ago\)/);
    assert.match(text, /split the work before you write anything/);
    assert.match(text, /say so in your reply/);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('release_claim releases one claim or the whole session', async () => {
  const mock = await startMockServer();
  const session = await connect({ port: mock.port });
  try {
    const one = await callText(session.client, 'release_claim', { claim_id: 'claim_mock0000001' });
    assert.equal(one, 'Released claim_mock0000001.');
    const all = await callText(session.client, 'release_claim', {});
    assert.equal(all, 'Released 2 claims held by this session.');

    const posts = mock.requests.filter((r) => r.path === '/claims/release');
    assert.equal(posts[0].body.claim_id, 'claim_mock0000001');
    assert.equal(posts[1].body.claim_id, undefined);
    assert.match(posts[1].body.session_id, /^mcp-/);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('list_claims shows other people\'s claims and hides your own unless asked', async () => {
  const mine = { ...aliceClaim, id: 'claim_mine00000001', developer: ME, task: 'my own thing', paths: ['docs'] };
  const mock = await startMockServer({ claims: [aliceClaim, mine] });
  const session = await connect({ port: mock.port });
  try {
    const others = await callText(session.client, 'list_claims', {});
    assert.match(others, /^1 live claim by other people:/);
    assert.match(others, /alice@example\.com — src\/models · symbols User/);
    assert.match(others, /for: "move soft deletes into the user model"/);
    assert.match(others, /115 min left/);
    assert.doesNotMatch(others, /my own thing/);

    const withMe = await callText(session.client, 'list_claims', { include_self: true });
    assert.match(withMe, /^2 live claims:/);
    assert.match(withMe, /carol@example\.com \(you\) — docs/);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('list_claims distinguishes an empty room from an unreachable server', async () => {
  const mock = await startMockServer({ claims: [] });
  const session = await connect({ port: mock.port });
  try {
    const empty = await callText(session.client, 'list_claims', {});
    assert.match(empty, /Nothing is claimed right now by anyone else/);
    assert.match(empty, /real "nothing", not a failure to reach it/);
  } finally {
    await session.close();
    await mock.close();
  }

  const deadPort = mock.port;
  const dead = await connect({ port: deadPort });
  try {
    const unknown = await callText(dead.client, 'claim_work', { task: 'anything at all', paths: ['src'] });
    assert.match(unknown, /UNKNOWN/);
    assert.match(unknown, /could not ask/);
  } finally {
    await dead.close();
  }
});

// One person's agents in two checkouts are one developer to the room, so an
// answer that leaves "you" out can leave out your own other agent's work too.
// Empty, it says how much of yours it left out, and how to see it.
test('an empty answer that leaves your own claims out counts them, and names include_self', async () => {
  const mine = { ...aliceClaim, id: 'claim_mine00000001', developer: ME, task: 'fix the hooks in my other checkout', paths: ['hooks'] };
  const mineToo = { ...mine, id: 'claim_mine00000002', paths: ['server'] };
  const otherCheckout = {
    developer: ME,
    session_id: 's-other-checkout',
    task_hint: 'fix the hooks',
    git_branch: 'loop/fix-hooks',
    last_touched: iso(-60_000),
    last_ts: Date.now() - 60_000,
    ended: false,
    ended_at: null,
    files: [],
  };
  const mock = await startMockServer({ claims: [mine, mineToo], sessions: [otherCheckout] });
  const session = await connect({ port: mock.port });
  try {
    const listed = await callText(session.client, 'list_claims', {});
    assert.match(listed, /^Nothing is claimed right now by anyone else/);
    assert.match(listed, /2 live claims of yours \(carol@example\.com\)/);
    assert.match(listed, /another session or checkout of yours/);
    assert.match(listed, /list_claims with include_self: true/);
    assert.doesNotMatch(listed, /real "nothing"/, 'not while claims of yours stand');

    const who = await callText(session.client, 'who_is_working_on_what', {});
    assert.match(who, /^Nobody else has been active/);
    assert.match(who, /1 session and 2 live claims of yours/);
    assert.match(who, /who_is_working_on_what with include_self: true/);
    assert.doesNotMatch(who, /real "no one"/, 'not while a session of yours is active');
  } finally {
    await session.close();
    await mock.close();
  }

  // with nothing of yours left out, an empty answer is a real one, as before
  const quiet = await startMockServer({ claims: [], sessions: [] });
  const s2 = await connect({ port: quiet.port });
  try {
    assert.match(await callText(s2.client, 'list_claims', {}), /real "nothing", not a failure to reach it/);
    const who = await callText(s2.client, 'who_is_working_on_what', {});
    assert.match(who, /real "no one"/);
    assert.doesNotMatch(who, /include_self: true/);
  } finally {
    await s2.close();
    await quiet.close();
  }
});

test('who_is_working_on_what lists claims beside activity', async () => {
  const mock = await startMockServer({ claims: [aliceClaim] });
  const session = await connect({ port: mock.port });
  try {
    const text = await callText(session.client, 'who_is_working_on_what', {});
    assert.match(text, /Claimed right now/);
    assert.match(text, /- alice@example\.com: src\/models — "move soft deletes into the user model"/);
  } finally {
    await session.close();
    await mock.close();
  }
});

const collisionWithAlice = {
  file_path: 'src/models/user.ts',
  key: 'src/models/user.ts|alice@example.com,carol@example.com',
  mine: {
    developer: ME,
    sessions: ['s-me'],
    branch: 'feat/login',
    task_hint: 'add a login endpoint',
    change_summary: '+8/-1 lines',
    symbols: ['User'],
    minutes_ago: 2,
  },
  theirs: [
    {
      developer: 'alice@example.com',
      sessions: ['s-alice'],
      branch: 'main',
      task_hint: 'soft deletes',
      change_summary: '+12/-3 lines, touching User, deletedAt',
      symbols: ['User', 'deletedAt'],
      minutes_ago: 9,
    },
  ],
  shared_symbols: ['User'],
  same_branch: false,
};

test('get_collisions tells the agent who else changed its files, and leaves what happens to a person', async () => {
  for (const reconcileMode of ['approve', 'auto']) {
    const mock = await startMockServer({ collisions: [collisionWithAlice], reconcileMode });
    const session = await connect({ port: mock.port });
    try {
      const text = await callText(session.client, 'get_collisions', {});
      assert.match(text, /^1 unresolved collision involving you/);
      assert.match(text, /src\/models\/user\.ts — also changed by alice@example\.com/);
      assert.match(text, /alice@example\.com: last write 9 min ago on branch main — you are on feat\/login/);
      assert.match(text, /You both touched User/);
      // An agent with the permissions to branch, push and open a pull request
      // did all three when the brief asked, for a change nobody had pushed.
      assert.doesNotMatch(text, /\bpush\b|reconcile\/|gh pr|pull request|branch named|commit the reconciled/i, reconcileMode);
      assert.match(text, /person/, 'what happens is a person\'s to decide');
      assert.match(text, /mark_resolved/);

      const asked = mock.requests.find((r) => r.path === '/collisions');
      assert.equal(asked.query.developer, ME);
      assert.equal(asked.query.advisory, '1', 'it tells the server it only advises');
    } finally {
      await session.close();
      await mock.close();
    }
  }
});

test('get_collisions says "none" plainly, and respects a room with reconciliation off', async () => {
  const none = await startMockServer({ collisions: [] });
  const s1 = await connect({ port: none.port });
  try {
    const text = await callText(s1.client, 'get_collisions', {});
    assert.match(text, /No unresolved collisions involving you/);
    assert.match(text, /real "none", not a failure to reach it/);
  } finally {
    await s1.close();
    await none.close();
  }

  const off = await startMockServer({ collisions: [collisionWithAlice], reconcileMode: 'off' });
  const s2 = await connect({ port: off.port });
  try {
    const text = await callText(s2.client, 'get_collisions', {});
    assert.match(text, /reconciliation switched off/);
    assert.doesNotMatch(text, /open a pull request/);
  } finally {
    await s2.close();
    await off.close();
  }
});

// In a committed install the room is its key, and every answer goes into the
// agent's context: an answer names the room by its label, else its ref, and
// never by the key, whichever tool it comes from and whatever the room said.
const EVERY_TOOL = {
  who_is_working_on_what: {},
  has_anyone_touched: { path: 'src' },
  list_contested_files: {},
  claim_work: { task: 'add a login endpoint', paths: ['src/routes/login.ts'] },
  release_claim: {},
  list_claims: {},
  get_collisions: {},
  mark_resolved: { file_path: 'src/models/user.ts', outcome: 'merged' },
  check_inbox: {},
  reply_to_teammate: { message_id: `msg_${'a'.repeat(22)}`, text: 'thanks, on it' },
};

test('no tool answer names the room by its key', async () => {
  const rooms = [
    { what: 'an empty room with no label', mock: { label: null }, env: {}, named: /this repository's room/ },
    { what: 'an empty room with a ref', mock: { label: null }, env: { AGENTMASH_ROOM_REF: 'rm_claims0002' }, named: /room rm_claims0002/ },
    { what: 'a busy room', mock: { label: null, claims: [aliceClaim], collisions: [collisionWithAlice], overlaps: [aliceClaim] }, env: {} },
    {
      what: 'a room that turns the key away',
      mock: { refuse: { status: 401, body: { error: 'unknown, expired or missing room key', code: 'room_unauthorized' } } },
      env: {},
    },
  ];
  for (const { what, mock: options, env, named } of rooms) {
    const mock = await startMockServer(options);
    const session = await connect({ port: mock.port, env });
    try {
      const listed = (await session.client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(listed, Object.keys(EVERY_TOOL).sort(), 'every tool the server offers is asked');
      for (const [tool, args] of Object.entries(EVERY_TOOL)) {
        const text = await callText(session.client, tool, args);
        assert.ok(!text.includes(ROOM), `${what} · ${tool} names the room key: ${text}`);
      }
      if (named) assert.match(await callText(session.client, 'list_claims', {}), named, what);
    } finally {
      await session.close();
      await mock.close();
    }
  }
});

test('mark_resolved records how the collision was settled', async () => {
  const mock = await startMockServer();
  const session = await connect({ port: mock.port });
  try {
    const text = await callText(session.client, 'mark_resolved', {
      file_path: './src/models/user.ts',
      outcome: 'pr',
      url: 'https://github.com/acme/app/pull/42',
      note: 'kept deletedAt, moved login to its own module',
    });
    assert.match(text, /^Recorded: the collision on src\/models\/user\.ts between alice@example\.com and carol@example\.com is resolved as a pull request \(https:\/\/github\.com\/acme\/app\/pull\/42\)/);

    const posted = mock.requests.find((r) => r.method === 'POST' && r.path === '/resolutions');
    assert.equal(posted.body.developer, ME);
    assert.match(posted.body.session_id, /^mcp-/);
    assert.equal(posted.body.file_path, 'src/models/user.ts');
    assert.equal(posted.body.outcome, 'pr');
    assert.equal(posted.body.url, 'https://github.com/acme/app/pull/42');
    assert.equal(posted.body.note, 'kept deletedAt, moved login to its own module');
  } finally {
    await session.close();
    await mock.close();
  }
});

// A resolution settles the caller's side with each of the others, never two
// others' with each other: the reply says whom it settled with, and that the
// room still tells the others when they still collide, rather than that the
// whole file is settled.
test('mark_resolved says whom it settled with, and whether others on the file still collide', async () => {
  const cases = [
    [
      { settled: { with: ['alice@example.com', 'bob@example.com'], between: [] }, still_open: true },
      /^Recorded: the collision on src\/models\/user\.ts between you and alice@example\.com and bob@example\.com is resolved as a direct merge\. Others who changed it still collide with each other there, and the room keeps telling them until they settle it\.$/,
    ],
    [
      { settled: { with: ['alice@example.com'], between: [] }, still_open: false },
      /^Recorded: the collision on src\/models\/user\.ts between you and alice@example\.com is resolved as a direct merge\. The room will not prompt about it again unless someone edits the file after this\.$/,
    ],
    [
      { settled: { with: [], between: ['alice@example.com', 'bob@example.com'] }, still_open: false },
      /^Recorded: the collision on src\/models\/user\.ts between alice@example\.com and bob@example\.com is resolved as a direct merge\. The room will not prompt/,
    ],
    [
      { settled: { with: [], between: [] }, still_open: true },
      /^Recorded as a direct merge, though no collision on src\/models\/user\.ts was open to settle: nothing changes for anyone\.$/,
    ],
  ];
  for (const [resolved, said] of cases) {
    const mock = await startMockServer({ resolved });
    const session = await connect({ port: mock.port });
    try {
      const text = await callText(session.client, 'mark_resolved', { file_path: 'src/models/user.ts', outcome: 'merged' });
      assert.match(text, said, JSON.stringify(resolved));
      assert.doesNotMatch(text, /carol/, 'not everyone who edited the file, as the resolution names them');
    } finally {
      await session.close();
      await mock.close();
    }
  }
});

test('claims and resolutions only ever name this repository\'s paths, and say which they left out', async () => {
  const mock = await startMockServer();
  const session = await connect({ port: mock.port });
  try {
    const elsewhere = path.join(makeProjectDir(), 'src', 'auth.ts');
    const partly = await callText(session.client, 'claim_work', { task: 'rework auth', paths: ['src/auth', elsewhere] });
    const posted = mock.requests.filter((r) => r.method === 'POST' && r.path === '/claims');
    assert.deepEqual(posted.map((r) => r.body.paths), [['src/auth']], 'only the path in this repository is claimed');
    assert.match(partly, /^Claimed src\/auth for "rework auth"/);
    assert.ok(partly.includes(elsewhere), `and the agent is told what was left out: ${partly}`);

    const none = await callText(session.client, 'claim_work', { task: 'somewhere else', paths: [elsewhere] });
    assert.match(none, /inside this repository/);
    const resolved = await callText(session.client, 'mark_resolved', { file_path: elsewhere, outcome: 'no_conflict' });
    assert.match(resolved, /inside this repository/);
    assert.deepEqual(
      mock.requests.slice(posted.length).map((r) => `${r.method} ${r.path}`),
      [],
      'nothing the room could not hold is sent to it'
    );
  } finally {
    await session.close();
    await mock.close();
  }
});

// The client SDK ends a session by killing the child. On POSIX that is a
// SIGTERM the server can act on; on Windows it is TerminateProcess, which
// nothing can act on — there, the claim's TTL is what ends it.
const GRACEFUL_SHUTDOWN = process.platform !== 'win32';

test(
  'a process that claimed something releases it when the session closes',
  { skip: GRACEFUL_SHUTDOWN ? false : 'the host kills the process outright on this platform; TTL applies' },
  async () => {
  const mock = await startMockServer();
  const session = await connect({ port: mock.port });
  await callText(session.client, 'claim_work', { task: 'something brief', paths: ['src/x.ts'] });
  await session.close();

  const deadline = Date.now() + 4000;
  let release = null;
  while (Date.now() < deadline && !release) {
    release = mock.requests.find((r) => r.path === '/claims/release');
    if (!release) await new Promise((r) => setTimeout(r, 50));
  }
  await mock.close();
  assert.ok(release, 'the server should have received a release after the transport closed');
  assert.match(release.body.session_id, /^mcp-/);
  assert.equal(release.body.claim_id, undefined, 'the whole session is released');
  assert.equal(release.body.all, undefined, 'but not its claims until merge: their branch ends them');
});

/**
 * A Claude Code config folder holding the session file Claude Code keeps for
 * this test's process, the one that starts the server: as it keeps one for
 * every live session, with a socket path the server never opens.
 */
function claudeSessions(sessionId) {
  const dir = noClaudeSessions();
  fs.mkdirSync(path.join(dir, 'sessions'));
  const file = path.join(dir, 'sessions', `${process.pid}.json`);
  const write = (id) =>
    fs.writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, sessionId: id, cwd: '/r', status: 'busy', messagingSocketPath: path.join(dir, 'never-opened.sock') })
    );
  write(sessionId);
  return { dir, write };
}

test('started by Claude Code, claims go by its session id, so its session_end releases them; read at each call, as /clear starts a new one', async () => {
  const mock = await startMockServer();
  const claude = claudeSessions('5f0c2a1e-1b2c-4d3e-8f90-0123456789ab');
  const session = await connect({ port: mock.port, env: { CLAUDE_CONFIG_DIR: claude.dir } });
  try {
    await callText(session.client, 'claim_work', { task: 'add a login endpoint', paths: ['src/routes/login.ts'] });
    await callText(session.client, 'release_claim', {});
    // /clear: the same process, a new session
    claude.write('9a8b7c6d-0000-4000-8000-000000000001');
    await callText(session.client, 'claim_work', { task: 'and the tests', paths: ['test/login.test.ts'] });
    await callText(session.client, 'mark_resolved', { file_path: 'src/routes/login.ts', outcome: 'merged' });
    assert.deepEqual(
      mock.requests.filter((r) => r.method === 'POST').map((r) => [r.path, r.body.session_id]),
      [
        ['/claims', '5f0c2a1e-1b2c-4d3e-8f90-0123456789ab'],
        ['/claims/release', '5f0c2a1e-1b2c-4d3e-8f90-0123456789ab'],
        ['/claims', '9a8b7c6d-0000-4000-8000-000000000001'],
        ['/resolutions', '9a8b7c6d-0000-4000-8000-000000000001'],
      ]
    );
  } finally {
    await session.close();
    await mock.close();
  }
  assert.ok(fs.existsSync(path.join(claude.dir, 'sessions', `${process.pid}.json`)), 'the file is read, never touched');
  assert.ok(!fs.existsSync(path.join(claude.dir, 'never-opened.sock')));
});

// Claude Code hands CLAUDE_CODE_SESSION_ID to everything started under it: another agent run from
// one of its terminals has it too, and its MCP server must not hold claims under that session.
test('with no session file for the process that started it, the process mints its id, even with a Claude Code session id in its environment', async () => {
  const mock = await startMockServer();
  const claimed = async (env) => {
    const session = await connect({ port: mock.port, env });
    try {
      await callText(session.client, 'claim_work', { task: 'something', paths: ['src/x.ts'] });
    } finally {
      await session.close();
    }
    return mock.requests.filter((r) => r.path === '/claims').at(-1).body.session_id;
  };
  try {
    assert.match(await claimed({ CLAUDE_CODE_SESSION_ID: 'env-session-1' }), /^mcp-[A-Za-z0-9_-]+$/, 'an inherited id is not this process’s session');
    assert.equal(await claimed({ CLAUDE_CONFIG_DIR: claudeSessions('from-the-file').dir, CLAUDE_CODE_SESSION_ID: 'env-session-1' }), 'from-the-file', 'the file is the session');
    assert.match(await claimed({}), /^mcp-[A-Za-z0-9_-]+$/);
    assert.match(await claimed({ CLAUDE_CONFIG_DIR: claudeSessions('not one id; rm -rf ~').dir }), /^mcp-/);
  } finally {
    await mock.close();
  }
});

// Over stdio by hand, so the session can end with its stdin closing, which a test can do on
// every platform (the SDK's client kills the process instead, see GRACEFUL_SHUTDOWN).
test('a process that claimed under two of Claude Code’s sessions releases both when its stdin ends', async () => {
  const mock = await startMockServer();
  const claude = claudeSessions('first-session');
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...baseEnv,
      CLAUDE_PROJECT_DIR: makeProjectDir(),
      CLAUDE_CONFIG_DIR: claude.dir,
      AGENTMASH_DEV: ME,
      AGENTMASH_URL: `http://127.0.0.1:${mock.port}`,
      AGENTMASH_ROOM: ROOM,
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const answers = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (message.id !== undefined) answers.set(message.id, message);
    }
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const call = async (id, method, params) => {
    send({ id, method, params });
    const deadline = Date.now() + 4000;
    while (!answers.has(id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(answers.has(id), `an answer to ${method}`);
  };
  try {
    await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claims-test', version: '0' } });
    send({ method: 'notifications/initialized' });
    await call(2, 'tools/call', { name: 'claim_work', arguments: { task: 'one', paths: ['src/a.ts'] } });
    claude.write('second-session');
    await call(3, 'tools/call', { name: 'claim_work', arguments: { task: 'two', paths: ['src/b.ts'] } });
    child.stdin.end();
    const deadline = Date.now() + 4000;
    let released = [];
    while (Date.now() < deadline && released.length < 2) {
      released = mock.requests.filter((r) => r.path === '/claims/release');
      if (released.length < 2) await new Promise((r) => setTimeout(r, 50));
    }
    assert.deepEqual(released.map((r) => r.body.session_id).sort(), ['first-session', 'second-session']);
    assert.ok(released.every((r) => r.body.claim_id === undefined && r.body.all === undefined), 'each session whole, but not its claims until merge');
  } finally {
    child.kill();
    await mock.close();
  }
});

/**
 * A checkout on a branch of its own, as a session working on a feature is,
 * where the hooks looked at the repository's branches `checked` ms ago (the
 * owner's check, at a prompt), as they do in Claude Code; or never (null).
 */
function onBranch(branch, { checked = 0 } = {}) {
  const dir = makeProjectDir();
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  if (checked !== null) {
    const note = ownerCheckFile(dir);
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, JSON.stringify({ at: Date.now() - checked, tips: '' }));
  }
  return dir;
}

test('claim_work on a branch claims until it merges, and says to keep it through commits and pushes', async () => {
  const mock = await startMockServer();
  const session = await connect({ port: mock.port, projectDir: onBranch('carol/deal-probability') });
  try {
    const text = await callText(session.client, 'claim_work', { task: 'add a deal probability badge', paths: ['deals/DealCard.tsx'] });
    const posted = mock.requests.find((r) => r.method === 'POST' && r.path === '/claims');
    assert.equal(posted.body.branch, 'carol/deal-probability');
    assert.equal(posted.body.until, 'merged');
    assert.equal(
      text,
      'Claimed deals/DealCard.tsx for "add a deal probability badge" as carol@example.com, on branch carol/deal-probability until it merges (id claim_mock0000001).' +
        '\n\nNo one else has claimed anything in this scope. Go ahead. Keep the claim through your commits and pushes: the room ends it when ' +
        'carol/deal-probability merges, or after 7 days. Call release_claim only if you drop the work.'
    );
    // claiming again on the branch updates it
    const renewed = await callText(session.client, 'claim_work', { task: 'and the api too', paths: ['deals/api.ts'] });
    assert.match(renewed, /^Updated your claim on branch carol\/deal-probability: deals\/api\.ts, src\/routes for "and the api too" until it merges \(id claim_mock0000001\)\./);
    // and until_merged false asks for the hours a claim on the default branch has
    await callText(session.client, 'claim_work', { task: 'a quick fix', paths: ['x.ts'], until_merged: false, ttl_minutes: 30 });
    const quick = mock.requests.filter((r) => r.method === 'POST' && r.path === '/claims').pop();
    assert.equal(quick.body.until, undefined);
    assert.equal(quick.body.ttl_minutes, 30);
  } finally {
    await session.close();
    await mock.close();
  }
});

// Only the hooks tell the room a branch merged (the owner's check, at a
// prompt). Where they have not looked lately, as for an agent with only this
// server (Zed) or hooks from before that check, a claim until merge would
// stand the whole week: it is the next hours' claim, asked for or not, and the
// answer says why. On the default branch it never was anything else.
test('claim_work on a branch where no hooks have looked at branches lately claims for its TTL, and says why', async () => {
  const mock = await startMockServer();
  const posted = () => mock.requests.filter((r) => r.method === 'POST' && r.path === '/claims');
  try {
    for (const checked of [null, 25 * 60 * 60_000]) {
      const session = await connect({ port: mock.port, projectDir: onBranch('carol/zed-only', { checked }) });
      try {
        const text = await callText(session.client, 'claim_work', { task: 'add a deal probability badge', paths: ['deals/DealCard.tsx'] });
        const asked = await callText(session.client, 'claim_work', { task: 'and keep it', paths: ['deals/api.ts'], until_merged: true, ttl_minutes: 30 });
        const [first, second] = posted().slice(-2);
        assert.equal(first.body.branch, 'carol/zed-only');
        assert.equal(first.body.until, undefined, `checked ${checked}`);
        assert.equal(second.body.until, undefined, 'asked for or not');
        assert.equal(second.body.ttl_minutes, 30);
        assert.match(text, /^Claimed deals\/DealCard\.tsx for "add a deal probability badge" as carol@example\.com \(id claim_mock0000001, 1[12]\d min\)\./);
        assert.match(
          text,
          /\n\nNot until carol\/zed-only merges, though: AgentMash's hooks have not looked at this repository's branches in the last day, so nothing here would tell the room when it did\. Claim again if the work runs longer\.$/
        );
        assert.doesNotMatch(text, /until it merges/);
        assert.match(asked, /\(id claim_mock0000001, (30|29) min\)\./);
        assert.match(asked, /Not until carol\/zed-only merges, though/);
      } finally {
        await session.close();
      }
    }
    const onMain = await connect({ port: mock.port, projectDir: onBranch('main', { checked: null }) });
    try {
      const text = await callText(onMain.client, 'claim_work', { task: 'a quick fix', paths: ['x.ts'] });
      assert.equal(posted().pop().body.until, undefined);
      assert.doesNotMatch(text, /Not until/);
    } finally {
      await onMain.close();
    }
  } finally {
    await mock.close();
  }
});

// One person holds one claim per branch, so a second agent of theirs on the
// branch renews the first one's claim and its task text goes. The answer says
// whose claim that was and what it was for, rather than "Updated your claim".
test('claim_work that renews another session’s claim on the branch says whose it was', async () => {
  const mock = await startMockServer();
  const session = await connect({ port: mock.port, projectDir: onBranch('loop/fix-r1-patch-4') });
  try {
    const text = await callText(session.client, 'claim_work', { task: 'merge the fixes', paths: ['hooks/lib.mjs'] });
    assert.match(
      text,
      /^Updated the claim on branch loop\/fix-r1-patch-4 that another session of yours made for "fix the pre-edit warning": it is now hooks\/lib\.mjs, src\/routes for "merge the fixes" until it merges \(id claim_mock0000001\)\./
    );
    assert.match(text, /no longer says "fix the pre-edit warning"/);
    assert.match(text, /name both in the task/);
    assert.doesNotMatch(text, /Updated your claim/);

    // renewing this session's own claim is the plain update it always was
    const own = await callText(session.client, 'claim_work', { task: 'and the api too', paths: ['hooks/api.mjs'] });
    assert.match(own, /^Updated your claim on branch loop\/fix-r1-patch-4:/);
    assert.doesNotMatch(own, /another session/);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('release_claim with no id drops the session’s claims until merge too; the list says how long a branch claim stands', async () => {
  const branchClaim = { ...aliceClaim, branch: 'alice/soft-deletes', until: 'merged', created_at: iso(-3 * 60 * 60_000), expires_at: iso(6 * 24 * 60 * 60_000) };
  const mock = await startMockServer({ claims: [branchClaim] });
  const session = await connect({ port: mock.port });
  try {
    await callText(session.client, 'release_claim', {});
    await callText(session.client, 'release_claim', { claim_id: 'claim_mock0000001' });
    const posts = mock.requests.filter((r) => r.path === '/claims/release');
    assert.equal(posts[0].body.all, true, 'asked to release with no id: the work is dropped');
    assert.equal(posts[1].body.all, undefined);
    const listed = await callText(session.client, 'list_claims', {});
    assert.match(listed, /claimed 3 h ago, on branch alice\/soft-deletes until it merges \(6 d at most\)/);
  } finally {
    await session.close();
    await mock.close();
  }
});

// A claim on a branch outlives the session that made it, so the agent that
// drops the work is often in a later session, with nothing of its own to
// release: it names the paths. Every claim of yours wholly inside them goes,
// by its id, from whatever session made it; one that also covers more is
// named, not dropped whole.
test('release_claim takes paths: it releases your claims inside them, from any session, and names the rest', async () => {
  const earlier = { developer: ME, session_id: 'mcp-earlier', created_at: iso(-3 * 60 * 60_000), expires_at: iso(6 * 24 * 60 * 60_000), symbols: [] };
  const hooksClaim = { ...earlier, id: 'claim_minehooks0001', task: 'fix the hooks', paths: ['hooks/lib.mjs', 'hooks/pre_tool_use.mjs'], branch: 'loop/fix', until: 'merged' };
  const wideClaim = { ...earlier, id: 'claim_minewide00001', task: 'and the server', paths: ['hooks/mcp_render.mjs', 'server/src'] };
  const aliceHooks = { ...aliceClaim, id: 'claim_alicehooks001', paths: ['hooks/stop.mjs'] };
  const mock = await startMockServer({ claims: [aliceHooks, hooksClaim, wideClaim], sessionReleases: 0 });
  const session = await connect({ port: mock.port });
  try {
    const text = await callText(session.client, 'release_claim', { paths: ['hooks/'] });
    const posts = mock.requests.filter((r) => r.path === '/claims/release');
    assert.deepEqual(posts.map((r) => r.body.claim_id), ['claim_minehooks0001'], 'only your claim inside the paths, by its id');
    assert.match(text, /^Released claim_minehooks0001 \(hooks\/lib\.mjs, hooks\/pre_tool_use\.mjs, for "fix the hooks"\)\./);
    assert.match(text, /Not released, because it also covers more than hooks: claim_minewide00001 \(hooks\/mcp_render\.mjs, server\/src, for "and the server"\)/);
    assert.match(text, /claim_id/);
    assert.ok(!text.includes('claim_alicehooks001'), 'a teammate’s claim is not yours to release');
    const asked = mock.requests.find((r) => r.method === 'GET' && r.path === '/claims');
    assert.equal(asked.query.developer, ME, 'the room says which claims are yours');

    const none = await callText(session.client, 'release_claim', { paths: ['docs'] });
    assert.match(none, /^None of your live claims is inside docs/);
    assert.match(none, /include_self: true/);
    assert.equal(mock.requests.filter((r) => r.path === '/claims/release').length, 1, 'nothing more released');

    const both = await session.client.callTool({ name: 'release_claim', arguments: { claim_id: 'claim_minehooks0001', paths: ['hooks'] } });
    assert.equal(both.isError, true, 'one or the other');

    // with neither, a session that holds nothing says where the rest of yours went
    const empty = await callText(session.client, 'release_claim', {});
    assert.match(empty, /^This session holds no live claims — nothing to release\./);
    assert.match(empty, /claim_id, or by the paths/);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('a process that never claimed anything sends nothing on close', async () => {
  const mock = await startMockServer();
  const session = await connect({ port: mock.port });
  await callText(session.client, 'list_claims', {});
  await session.close();
  await new Promise((r) => setTimeout(r, 400));
  await mock.close();
  assert.equal(mock.requests.filter((r) => r.path === '/claims/release').length, 0);
});

// The room may want more than its key: a developer token from each machine
// (`npx agentmash secure any|github`), and a machine signed in with `npx
// agentmash login` holds no key at all, only its own token and the room's ref.
// The hooks send both; the MCP tools sent the key alone, so every claim and
// resolution in such a room was turned away.

/** An AGENTMASH_HOME as `npx agentmash login` and `login --room` leave it, for a server at `url`. */
function machineHome(url, { developerToken = null, roomRef = null, userToken = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-mcp-claims-home-'));
  fs.mkdirSync(path.join(home, '.agentmash'), { recursive: true });
  if (developerToken) {
    fs.writeFileSync(
      path.join(home, '.agentmash', 'credentials.json'),
      JSON.stringify({ version: 1, tokens: { [`${url}|${roomRef}`]: { token: developerToken, developer: 'carol', source: 'github' } } })
    );
  }
  if (userToken) {
    fs.writeFileSync(path.join(home, '.agentmash', 'user.json'), JSON.stringify({ url, token: userToken, login: 'carol' }));
  }
  return home;
}

test('every tool carries this machine\'s developer token, as the hooks do', async () => {
  const mock = await startMockServer();
  const url = `http://127.0.0.1:${mock.port}`;
  const TOKEN = 'amt_mcpdevelopertokenmcpdevel';
  const home = machineHome(url, { developerToken: TOKEN, roomRef: 'rm_claims0001' });
  const session = await connect({ port: mock.port, env: { AGENTMASH_HOME: home, AGENTMASH_ROOM_REF: 'rm_claims0001' } });
  try {
    await callText(session.client, 'claim_work', { task: 'add a login endpoint', paths: ['src/routes/login.ts'] });
    await callText(session.client, 'release_claim', {});
    await callText(session.client, 'mark_resolved', { file_path: 'src/models/user.ts', outcome: 'merged' });
    await callText(session.client, 'list_claims', {});
    await callText(session.client, 'who_is_working_on_what', {});
    assert.deepEqual(
      [...new Set(mock.requests.map((r) => r.path))].sort(),
      ['/activity', '/claims', '/claims/release', '/resolutions']
    );
    for (const r of mock.requests) {
      assert.equal(r.room, ROOM, `${r.method} ${r.path}`);
      assert.equal(r.token, TOKEN, `${r.method} ${r.path} carries the token`);
      assert.equal(r.user, undefined, `${r.method} ${r.path}`);
    }
  } finally {
    await session.close();
    await mock.close();
  }
});

test('on a machine signed in with login, the tools find the room by the repository and sign as the machine', async () => {
  const REF = 'rm_loginroom01';
  const USER = 'amu_mcpmachinetokenmcpmachine';
  const mock = await startMockServer({ lookup: REF });
  const url = `http://127.0.0.1:${mock.port}`;
  const home = machineHome(url, { userToken: USER });
  // a checkout of acme/app with no room of its own: no .claude/agentmash/config.json
  const projectDir = makeProjectDir();
  fs.mkdirSync(path.join(projectDir, '.git'));
  fs.writeFileSync(path.join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(projectDir, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/app.git\n');
  const session = await connect({ projectDir, env: { AGENTMASH_HOME: home } });
  try {
    const claimed = await callText(session.client, 'claim_work', { task: 'add a login endpoint', paths: ['src/routes/login.ts'] });
    assert.match(claimed, /^Claimed src\/routes\/login\.ts/);
    const listed = await callText(session.client, 'list_claims', {});
    assert.doesNotMatch(listed, /not connected|UNKNOWN/);

    const lookup = mock.requests.find((r) => r.path === '/api/lookup');
    assert.ok(lookup, 'the room is looked up by the repository');
    assert.equal(lookup.query.repo, 'acme/app');
    assert.equal(lookup.user, USER);
    const room = mock.requests.filter((r) => r.path !== '/api/lookup');
    assert.deepEqual(room.map((r) => `${r.method} ${r.path}`), ['POST /claims', 'GET /claims']);
    for (const r of room) {
      assert.equal(r.room, REF, 'named by its ref, never a key');
      assert.equal(r.user, USER, 'and signed with the machine\'s own token');
      assert.equal(r.token, undefined);
    }
  } finally {
    await session.close();
    await mock.close();
  }
});

// The hooks keep "not connected" ten minutes for the checks a person waits
// on. An agent with the MCP alone (Zed) has no hook to ask again, so the
// tools look again sooner, as the hooks' background reports do: a repository
// connected on the website since is found, not "not connected" for minutes.
test('signed in, the tools look again for a repository that was not connected a couple of minutes ago', async () => {
  const REF = 'rm_loginroom02';
  const USER = 'amu_mcpmachinetokenmcpmachine';
  const mock = await startMockServer({ lookup: REF });
  const url = `http://127.0.0.1:${mock.port}`;
  const home = machineHome(url, { userToken: USER });
  fs.writeFileSync(
    path.join(home, '.agentmash', 'rooms.json'),
    JSON.stringify({ [`${url}|acme/app`]: { none: true, code: 'not_connected', at: Date.now() - 2 * 60_000 } })
  );
  const projectDir = makeProjectDir();
  fs.mkdirSync(path.join(projectDir, '.git'));
  fs.writeFileSync(path.join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(projectDir, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/app.git\n');
  const session = await connect({ projectDir, env: { AGENTMASH_HOME: home } });
  try {
    const listed = await callText(session.client, 'list_claims', {});
    assert.doesNotMatch(listed, /not connected/i);
    assert.equal(mock.requests.filter((r) => r.path === '/api/lookup').length, 1, 'looked up again');
    assert.deepEqual(mock.requests.filter((r) => r.path === '/claims').map((r) => r.room), [REF]);
  } finally {
    await session.close();
    await mock.close();
  }
});

test('a write the room turns away for its credentials is called that, with the command that fixes it', async () => {
  const cases = [
    {
      refuse: { status: 401, body: { error: 'this room requires a developer token — run: npx agentmash login', code: 'token_required' } },
      says: [/requires a developer token/, /npx agentmash login --room/],
    },
    {
      refuse: { status: 403, body: { error: 'this room requires a GitHub-verified developer token', code: 'token_unverified' } },
      says: [/GitHub-verified developer token/, /npx agentmash login --room/],
    },
    {
      refuse: { status: 401, body: { error: 'unknown, expired or missing room key', code: 'room_unauthorized' } },
      says: [/room key/, /rotated or revoked/, /npx agentmash doctor/],
    },
    {
      refuse: { status: 403, body: { error: 'acme/app is public on GitHub', code: 'room_key_public', repo: 'acme/app' } },
      says: [/public on GitHub/, /npx agentmash login/],
    },
  ];
  for (const { refuse, says } of cases) {
    const mock = await startMockServer({ refuse });
    const session = await connect({ port: mock.port });
    try {
      for (const [tool, args] of [
        ['claim_work', { task: 'add a login endpoint', paths: ['src/routes/login.ts'] }],
        ['release_claim', {}],
        ['mark_resolved', { file_path: 'src/models/user.ts', outcome: 'merged' }],
      ]) {
        const text = await callText(session.client, tool, args);
        for (const pattern of says) assert.match(text, pattern, `${refuse.body.code} · ${tool}: ${text}`);
        assert.doesNotMatch(text, /reset|unreachable/, `${refuse.body.code} · ${tool}`);
        assert.match(text, /UNKNOWN/);
      }
    } finally {
      await session.close();
      await mock.close();
    }
  }

  // signed in with login, a room that stops opening to the machine is its sign-in's to fix
  const REF = 'rm_loginroom02';
  const mock = await startMockServer({
    lookup: REF,
    refuse: { status: 401, body: { error: 'unknown, expired or missing room key', code: 'room_unauthorized' } },
  });
  const projectDir = makeProjectDir();
  fs.mkdirSync(path.join(projectDir, '.git'));
  fs.writeFileSync(path.join(projectDir, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/app.git\n');
  const session = await connect({
    projectDir,
    env: { AGENTMASH_HOME: machineHome(`http://127.0.0.1:${mock.port}`, { userToken: 'amu_mcpmachinetokenmcpmachine' }) },
  });
  try {
    const text = await callText(session.client, 'claim_work', { task: 'add a login endpoint', paths: ['src/routes/login.ts'] });
    assert.match(text, /sign-in/);
    assert.match(text, /npx agentmash login/);
    assert.doesNotMatch(text, /reset|room key/);
  } finally {
    await session.close();
    await mock.close();
  }
});

// A server that enforces plans turns a claim or a resolution away, as it does
// an event, when the team's plan has no seat for the developer: a 402 in its
// own words, which is what the agent is told to pass on.
test('a write the team’s plan has no seat for is said in the server’s words, never as a server that is down', async () => {
  const message =
    'acme is on the free plan, which covers 2 developers this month, and 2 have reported already. ' +
    'upgrade to the team plan to add carol: https://agentmash.dev/pricing';
  const mock = await startMockServer({
    refuse: { status: 402, body: { error: 'seat_limit', code: 'seat_limit', message, upgrade_url: 'https://agentmash.dev/pricing' } },
  });
  const session = await connect({ port: mock.port });
  try {
    for (const [tool, args] of [
      ['claim_work', { task: 'add a login endpoint', paths: ['src/routes/login.ts'] }],
      ['mark_resolved', { file_path: 'src/models/user.ts', outcome: 'merged' }],
    ]) {
      const text = await callText(session.client, tool, args);
      assert.ok(text.includes(message), `${tool}: ${text}`);
      assert.match(text, /not shared with the team/);
      assert.doesNotMatch(text, /unreachable|HTTP 402/, tool);
      assert.match(text, /UNKNOWN/);
    }
  } finally {
    await session.close();
    await mock.close();
  }
});

// The server stops going by what GitHub said a signed-in machine can push to
// after a while, and answers `reauth` to its lookups and its room requests
// alike until it signs in again. Not a room that is gone, and not one the
// repository was never connected to: the tools say what it is.
test('a signed-in machine whose push access has gone stale is told AgentMash is paused until it signs in', async () => {
  const REAUTH = { status: 401, body: { error: 'GitHub has to say again what carol can push to: sign in again (npx agentmash login)', code: 'reauth' } };
  for (const [lookup, refuse] of [
    [REAUTH, null],
    ['rm_loginroom03', REAUTH],
  ]) {
    const mock = await startMockServer({ lookup, refuse });
    const projectDir = makeProjectDir();
    fs.mkdirSync(path.join(projectDir, '.git'));
    fs.writeFileSync(path.join(projectDir, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/app.git\n');
    const session = await connect({
      projectDir,
      env: { AGENTMASH_HOME: machineHome(`http://127.0.0.1:${mock.port}`, { userToken: 'amu_mcpmachinetokenmcpmachine' }) },
    });
    try {
      const where = refuse ? 'a room request' : 'the lookup';
      const text = await callText(session.client, 'claim_work', { task: 'add a login endpoint', paths: ['src/routes/login.ts'] });
      assert.match(text, /paused/, `${where}: ${text}`);
      assert.match(text, /GitHub has to say again what you can push to/, where);
      assert.match(text, /npx agentmash login/, where);
      assert.doesNotMatch(text, /not connected|reset|room key/, where);
      assert.match(text, /UNKNOWN/, where);
      assert.ok(text.includes(`http://127.0.0.1:${mock.port}`), `${where}: the server the sign-in is with`);
    } finally {
      await session.close();
      await mock.close();
    }
  }
});
