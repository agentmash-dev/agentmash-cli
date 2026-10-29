import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { aggregate, DEFAULTS, hotZones, shortNames } from '../src/aggregate.mjs';
import { render, splitToLength } from '../src/render.mjs';
import { telegramUrl } from '../src/net.mjs';

const CLI = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'agentmash-digest.mjs');
const ROOM = 'mash_digestdigestdigest';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-31T18:00:00Z');

const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTMASH_'))
);

// The command line as npx agentmash digest runs it (cli/digest.mjs): runDigest
// with its name and a findRoom, which answers with FOUND, as JSON.
const EMBEDDED =
  'const { runDigest } = await import(process.argv[1]); const found = JSON.parse(process.env.FOUND);' +
  ' await runDigest(process.argv.slice(2), { name: "npx agentmash digest", findRoom: async () => found });';
const RUNNER = pathToFileURL(path.join(path.dirname(CLI), 'src', 'cli.mjs')).href;

function run(args, { env = {}, cwd, found } = {}) {
  return new Promise((resolve, reject) => {
    const argv = found ? ['--input-type=module', '-e', EMBEDDED, RUNNER, ...args] : [CLI, ...args];
    const child = spawn(process.execPath, argv, {
      // The fixture week is fixed; pin the CLI's clock to it so "--since 7d"
      // means the same seven days on every date the suite happens to run.
      env: { ...baseEnv, NO_COLOR: '1', AGENTMASH_DIGEST_NOW: String(NOW), ...(found ? { FOUND: JSON.stringify(found) } : {}), ...env },
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Stand-in for the coordination server: pages /events exactly as the real one
 * does, and answers /rooms/self, /api/v1/room and /api/config with `self`,
 * `self` and `config` when given. `seen` keeps each request's room and
 * sign-in headers beside its URL.
 */
function startMockServer(events, { pageSize = 1000, hang = false, broken = false, self = null, config = null } = {}) {
  const requests = [];
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push(url.pathname + url.search);
    seen.push({ url: req.url, room: req.headers['x-agentmash-room'] ?? null, user: req.headers['x-agentmash-user'] ?? null });
    if (hang) return; // never answers: the client's own timeout has to save it
    if (broken) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'database is on fire' }));
    }
    const answers = { '/rooms/self': self, '/api/v1/room': self, '/api/config': config };
    if (answers[url.pathname]) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(answers[url.pathname]));
    }
    if (url.pathname !== '/events') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    const minutes = Number(url.searchParams.get('minutes')) || 60;
    // Anchored to the same frozen clock the CLI is given (AGENTMASH_DIGEST_NOW),
    // not the wall clock: the fixtures are dated, and a window measured from
    // today slides off them about a week after they were written.
    const since = NOW - minutes * 60_000;
    const cursor = url.searchParams.get('cursor');
    let rows = events
      .filter((e) => e.ts >= since)
      .sort((a, b) => b.ts - a.ts || b.id - a.id);
    if (cursor) {
      const [ts, id] = cursor.split('.').map(Number);
      rows = rows.filter((e) => e.ts < ts || (e.ts === ts && e.id < id));
    }
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        room: ROOM,
        events: page,
        next_cursor: page.length === pageSize && last ? `${last.ts}.${last.id}` : null,
      })
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        seen,
        close: () => new Promise((r) => server.close(r)),
      })
    );
  });
}

/** Stand-in for a Slack or Telegram endpoint. */
function startMockWebhook({ status = 200, body = 'ok' } = {}) {
  const posts = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      posts.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/hook`,
        posts,
        close: () => new Promise((r) => server.close(r)),
      })
    );
  });
}

let nextId = 1;
function edit(developer, file, ts, extra = {}) {
  return {
    id: nextId++,
    developer,
    session_id: extra.session ?? `${developer}-s`,
    event_type: 'edit',
    tool: 'Edit',
    file_path: file,
    dir_path: file.slice(0, file.lastIndexOf('/')),
    git_branch: extra.branch ?? 'main',
    task_hint: extra.hint ?? null,
    change_summary: null,
    ts,
  };
}

function prompt(developer, ts, hint, extra = {}) {
  return {
    id: nextId++,
    developer,
    session_id: extra.session ?? `${developer}-s`,
    event_type: 'prompt',
    tool: null,
    file_path: null,
    dir_path: null,
    git_branch: extra.branch ?? 'main',
    task_hint: hint,
    ts,
  };
}

function week(events, overrides = {}) {
  return aggregate(events, {
    room: ROOM,
    label: 'acme-api',
    now: NOW,
    periodStart: NOW - 7 * DAY,
    periodEnd: NOW,
    previousStart: NOW - 14 * DAY,
    ...overrides,
  });
}

// ── aggregation ────────────────────────────────────────────────────────────

test('a file is a hot zone only with enough people, enough edits and enough proximity', () => {
  const t = NOW - 2 * DAY;
  const enough = [
    edit('a', 'src/x.ts', t),
    edit('b', 'src/x.ts', t + HOUR),
    edit('a', 'src/x.ts', t + 2 * HOUR),
    edit('b', 'src/x.ts', t + 3 * HOUR),
  ];
  assert.equal(week(enough).hot_zones.length, 1);

  // Same four edits, but one person: nobody to collide with.
  const alone = enough.map((e) => ({ ...e, developer: 'a' }));
  assert.equal(week(alone).hot_zones.length, 0);

  // Two people, only three edits: under the volume threshold.
  assert.equal(week(enough.slice(0, 3)).hot_zones.length, 0);

  // Four edits by two people, but five days apart: a handoff, not a collision.
  const spread = [
    edit('a', 'src/x.ts', NOW - 7 * DAY),
    edit('a', 'src/x.ts', NOW - 7 * DAY + HOUR),
    edit('b', 'src/x.ts', NOW - 2 * DAY),
    edit('b', 'src/x.ts', NOW - 2 * DAY + HOUR),
  ];
  assert.equal(week(spread).hot_zones.length, 0);
});

test('hot-zone thresholds are configurable', () => {
  const t = NOW - 2 * DAY;
  const events = [
    edit('a', 'src/x.ts', t),
    edit('b', 'src/x.ts', t + HOUR),
    edit('a', 'src/x.ts', t + 2 * HOUR),
    edit('b', 'src/x.ts', t + 3 * HOUR),
  ];
  assert.equal(week(events, { hotMinEdits: 5 }).hot_zones.length, 0);
  assert.equal(week(events, { hotMinDevs: 3 }).hot_zones.length, 0);
  assert.equal(week(events, { hotWindowHours: 0.5 }).hot_zones.length, 0);
  assert.equal(hotZones(events, { ...DEFAULTS, hotMinEdits: 2 }).length, 1);
});

test('a directory is a hot zone when its files each stay single-owner', () => {
  const t = NOW - 2 * DAY;
  const model = week([
    edit('a', 'ui/panels/one.tsx', t),
    edit('a', 'ui/panels/two.tsx', t + HOUR),
    edit('b', 'ui/panels/three.tsx', t + 2 * HOUR),
    edit('b', 'ui/panels/four.tsx', t + 3 * HOUR),
  ]);
  assert.equal(model.hot_zones.length, 1);
  assert.equal(model.hot_zones[0].kind, 'dir');
  assert.equal(model.hot_zones[0].path, 'ui/panels');
  assert.equal(model.hot_zones[0].files, 4);

  // A directory whose hot file already told the story isn't reported twice.
  const withHotFile = week([
    edit('a', 'ui/panels/one.tsx', t),
    edit('b', 'ui/panels/one.tsx', t + HOUR),
    edit('a', 'ui/panels/one.tsx', t + 2 * HOUR),
    edit('b', 'ui/panels/one.tsx', t + 3 * HOUR),
    edit('b', 'ui/panels/two.tsx', t + 4 * HOUR),
  ]);
  assert.deepEqual(
    withHotFile.hot_zones.map((z) => z.kind),
    ['file']
  );
});

test('a pair of people earns a line only after enough shared files', () => {
  const t = NOW - 2 * DAY;
  const one = [edit('a', 'src/x.ts', t), edit('b', 'src/x.ts', t + HOUR)];
  assert.equal(week(one).pairs.length, 0);

  const two = [...one, edit('a', 'src/y.ts', t + 2 * HOUR), edit('b', 'src/y.ts', t + 3 * HOUR)];
  const pairs = week(two).pairs;
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].shared_files, ['src/x.ts', 'src/y.ts']);
  assert.equal(week(two, { pairMinFiles: 3 }).pairs.length, 0);
});

test('stalled branches and prompts that produced nothing are called out', () => {
  const events = [
    ...Array.from({ length: 6 }, (_, i) =>
      edit('carol', `src/import/${i}.ts`, NOW - 6 * DAY + i * HOUR, { branch: 'feat/import' })
    ),
    edit('dan', 'src/live.ts', NOW - HOUR, { branch: 'main' }),
    prompt('alice', NOW - 2 * DAY, 'why is staging stuck', { session: 'void' }),
  ];
  const model = week(events);
  assert.deepEqual(
    model.stalled.branches.map((b) => b.branch),
    ['feat/import']
  );
  assert.equal(model.stalled.branches[0].idle_days, 5);
  assert.equal(model.stalled.dropped_sessions.length, 1);
  assert.equal(model.stalled.dropped_sessions[0].developer, 'alice');

  // A shorter patience makes main's single fresh edit stalled too; a longer one clears both.
  assert.equal(week(events, { stallDays: 30 }).stalled.branches.length, 0);
});

test('the previous period marks zones as new, repeat or cooled', () => {
  const hot = (file, at) => [
    edit('a', file, at),
    edit('b', file, at + HOUR),
    edit('a', file, at + 2 * HOUR),
    edit('b', file, at + 3 * HOUR),
  ];
  const model = week([
    ...hot('src/kept.ts', NOW - 2 * DAY),
    ...hot('src/fresh.ts', NOW - 3 * DAY),
    ...hot('src/kept.ts', NOW - 9 * DAY),
    ...hot('src/gone.ts', NOW - 10 * DAY),
  ]);
  const byPath = Object.fromEntries(model.hot_zones.map((z) => [z.path, z.status]));
  assert.equal(byPath['src/kept.ts'], 'repeat');
  assert.equal(byPath['src/fresh.ts'], 'new');
  assert.deepEqual(model.comparison.cooled, ['src/gone.ts']);
  assert.equal(model.comparison.hot_zones, 2);
  assert.equal(model.comparison.edits_delta_pct, 0);
});

test('display names shorten to the local part unless that would collide', () => {
  assert.equal(shortNames(['alice@acme.io', 'bob@acme.io']).get('alice@acme.io'), 'alice');
  const collide = shortNames(['alice@acme.io', 'alice@other.io']);
  assert.equal(collide.get('alice@acme.io'), 'alice@acme.io');
});

// ── rendering ──────────────────────────────────────────────────────────────

const NASTY_FILE = 'src/<Weird> & "Stuff"/a*b_c`d[e].ts';
const NASTY_HINT = 'make `*bold*` <b>work</b> & fix _the_ [link](x)';

function nastyModel() {
  const t = NOW - 2 * DAY;
  return week([
    edit('a@x.io', NASTY_FILE, t, { hint: NASTY_HINT }),
    edit('b@x.io', NASTY_FILE, t + HOUR, { hint: NASTY_HINT }),
    edit('a@x.io', NASTY_FILE, t + 2 * HOUR),
    edit('b@x.io', NASTY_FILE, t + 3 * HOUR),
    edit('a@x.io', `${NASTY_FILE}x`, t + 4 * HOUR),
    edit('b@x.io', `${NASTY_FILE}x`, t + 5 * HOUR),
  ]);
}

test('slack rendering escapes the three characters slack treats as markup', () => {
  const payload = render(nastyModel(), 'slack', { includeHints: true });
  const text = JSON.stringify(payload);
  assert.equal(payload.blocks[0].type, 'header');
  assert.ok(text.includes('&lt;Weird&gt; &amp;'), text);
  // Every raw < or > is gone; the only & left are the entities we wrote.
  const body = payload.blocks.map((b) => b.text.text).join('\n');
  assert.equal(/[<>]/.test(body.replace(/&lt;|&gt;/g, '')), false);
  assert.equal(/&(?!amp;|lt;|gt;)/.test(body), false);
  // A backtick inside a path would end the code span it lives in.
  for (const span of body.match(/`[^`]*`/g) ?? []) assert.equal(span.slice(1, -1).includes('`'), false);
});

test('telegram rendering emits HTML with no stray angle brackets or ampersands', () => {
  const messages = render(nastyModel(), 'telegram', { includeHints: true });
  const body = messages.join('\n');
  const withoutTags = body.replace(/<\/?(b|i|code)>/g, '');
  assert.equal(/[<>]/.test(withoutTags.replace(/&lt;|&gt;/g, '')), false, withoutTags);
  assert.equal(/&(?!amp;|lt;|gt;)/.test(withoutTags), false, withoutTags);
  assert.ok(body.includes('&lt;Weird&gt;'));
  assert.ok(body.includes('<code>'));
});

test('telegram messages are split under the 4096-character limit', () => {
  const events = [];
  for (let i = 0; i < 60; i++) {
    const t = NOW - 3 * DAY + i * 60_000;
    const file = `packages/service-${i}/src/some/deeply/nested/module-${i}.ts`;
    events.push(edit('alice@x.io', file, t), edit('bob@x.io', file, t + 1000));
    events.push(edit('alice@x.io', file, t + 2000), edit('bob@x.io', file, t + 3000));
  }
  const messages = render(week(events), 'telegram', {});
  assert.ok(messages.length > 1, `expected a split, got ${messages.length}`);
  for (const message of messages) assert.ok(message.length <= 4096, `${message.length} chars`);
  assert.equal(splitToLength('x'.repeat(50), 10).length, 5);
});

test('text rendering stays plain when nothing asks for colour', () => {
  const text = render(nastyModel(), 'text', {});
  assert.equal(/\[/.test(text), false);
  assert.ok(text.includes(NASTY_FILE));
});

// ── prompt text in a shared channel ────────────────────────────────────────

test('prompt text is withheld from every target unless it is asked for', () => {
  const model = nastyModel();
  for (const target of ['text', 'json', 'slack', 'telegram']) {
    const out = JSON.stringify(render(model, target, {}));
    assert.equal(out.includes('fix'), false, `${target} leaked a prompt`);
  }
  assert.ok(render(model, 'text', {}).includes('Prompt text withheld'));

  const withHints = JSON.stringify(render(model, 'slack', { includeHints: true }));
  assert.ok(withHints.includes('fix'));
  const json = JSON.parse(render(model, 'json', { includeHints: true }));
  assert.equal(json.hints_included, true);
  assert.equal(json.people[0].latest_hint, NASTY_HINT);
  assert.equal('latest_hint' in JSON.parse(render(model, 'json', {})).people[0], false);
});

// ── empty and thin rooms ───────────────────────────────────────────────────

test('an empty room gets a short honest digest, not a padded one', () => {
  const model = week([]);
  assert.equal(model.quiet, true);
  const text = render(model, 'text', {});
  assert.ok(text.includes('nothing recorded'));
  assert.equal(text.includes('HOT ZONES'), false);
  assert.ok(text.split('\n').filter(Boolean).length <= 3, text);
  assert.equal(render(model, 'slack', {}).blocks.length, 2);
});

test('a room with two events says exactly that', () => {
  const model = week([
    edit('alice@x.io', 'README.md', NOW - DAY),
    edit('alice@x.io', 'README.md', NOW - DAY + HOUR),
  ]);
  assert.equal(model.thin, true);
  const text = render(model, 'text', {});
  assert.ok(text.includes('2 edits'));
  assert.ok(text.includes('too little activity'));
  assert.equal(text.includes('HOT ZONES'), false);
  assert.equal(text.includes('AGAINST THE'), false);
});

// ── the command, end to end ────────────────────────────────────────────────

function realisticWeek() {
  const events = [];
  for (let d = 0; d < 5; d++) {
    for (let k = 0; k < 4; k++) {
      events.push(edit('alice@acme.io', 'server/src/billing/invoice.ts', NOW - (6 - d) * DAY + k * HOUR, {
        branch: 'feat/billing',
        hint: 'split the invoice builder',
      }));
      events.push(edit('bob@acme.io', 'server/src/billing/invoice.ts', NOW - (6 - d) * DAY + (k + 4) * HOUR, {
        branch: 'feat/billing',
      }));
    }
  }
  return events;
}

test('the digest posts Slack blocks to an incoming webhook', async () => {
  const server = await startMockServer(realisticWeek());
  const hook = await startMockWebhook();
  try {
    const result = await run([
      '--server', server.url, '--room', ROOM, '--to', 'slack', '--webhook', hook.url,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(hook.posts.length, 1);
    const payload = hook.posts[0].body;
    assert.equal(payload.blocks[0].type, 'header');
    assert.ok(JSON.stringify(payload).includes('server/src/billing/invoice.ts'));
    assert.equal(JSON.stringify(payload).includes('split the invoice builder'), false);
    assert.match(result.stderr, /posted the digest .* to Slack/);
  } finally {
    await server.close();
    await hook.close();
  }
});

test('the digest posts Telegram HTML with a chat id', async () => {
  const server = await startMockServer(realisticWeek());
  const hook = await startMockWebhook({ body: { ok: true } });
  try {
    const result = await run([
      '--server', server.url, '--room', ROOM, '--to', 'telegram',
      '--webhook', hook.url, '--chat-id', '-1001234',
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(hook.posts[0].body.parse_mode, 'HTML');
    assert.equal(hook.posts[0].body.chat_id, '-1001234');
    assert.ok(hook.posts[0].body.text.includes('<b>'));
  } finally {
    await server.close();
    await hook.close();
  }
});

test('telegram accepts a bare bot token as well as a full url', () => {
  assert.equal(telegramUrl('123:AAA'), 'https://api.telegram.org/bot123:AAA/sendMessage');
  assert.equal(telegramUrl('bot123:AAA'), 'https://api.telegram.org/bot123:AAA/sendMessage');
  assert.equal(telegramUrl('http://x/y'), 'http://x/y');
});

test('a period longer than one page is read to the end, not silently cut short', async () => {
  const events = realisticWeek();
  const server = await startMockServer(events, { pageSize: 7 });
  try {
    const result = await run(['--server', server.url, '--room', ROOM, '--to', 'json']);
    assert.equal(result.code, 0, result.stderr);
    const model = JSON.parse(result.stdout);
    assert.equal(model.totals.edits, events.length);
    assert.equal(model.truncated, false);
    assert.ok(server.requests.length > 5, `expected paging, made ${server.requests.length} requests`);
    assert.ok(server.requests.some((r) => r.includes('cursor=')));
  } finally {
    await server.close();
  }
});

// The room's key used to ride in the query string of every /events page and
// in the path of /rooms/<key>, so every access log in front of the server
// kept it. It goes in a header now, as the CLI and the hooks send theirs.
test('the room key goes in a header, never in a URL', async () => {
  const server = await startMockServer(realisticWeek(), { pageSize: 7, self: { label: 'acme-api' }, config: { oauth: true } });
  try {
    const result = await run(['--server', server.url, '--room', ROOM, '--to', 'json', '--link']);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(server.seen.length > 5, `${server.seen.length} requests`);
    for (const { url, room, user } of server.seen) {
      assert.ok(!url.includes(ROOM), `no key in ${url}`);
      // /api/config is the server's own, public, and is sent nothing
      if (url !== '/api/config') assert.equal(room, ROOM, `the key in a header for ${url}`);
      assert.equal(user, null, 'and no sign-in, which agentmash-digest never has');
    }
    assert.equal(JSON.parse(result.stdout).label, 'acme-api', 'the label from /rooms/self, by the header');
  } finally {
    await server.close();
  }
});

// npx agentmash digest hands the command line the room it found: a room key
// with this machine's sign-in beside it, or a ref and the sign-in, for a
// repository connected on the website with nothing committed.
test('a room the CLI finds is read with its sign-in beside it, by the name the CLI gives', async () => {
  const REF = 'rm_0a1b2c3d4e';
  const SIGN_IN = 'amu_digestdigestdigestdigest';
  const server = await startMockServer(realisticWeek(), { self: { room_ref: REF, label: 'from the server' }, config: { oauth: true } });
  try {
    const byRef = await run(['--to', 'json', '--link'], { found: { server: server.url, room: REF, user: SIGN_IN, label: 'acme-api' } });
    assert.equal(byRef.code, 0, byRef.stderr);
    const model = JSON.parse(byRef.stdout);
    assert.equal(model.room, REF);
    assert.equal(model.label, 'acme-api', 'the label the lookup gave, with no request for it');
    assert.ok(model.totals.edits > 0);
    assert.ok(server.seen.length > 0);
    for (const { url, room, user } of server.seen) {
      assert.ok(!url.includes(SIGN_IN) && !url.includes(REF), `nothing of the room in ${url}`);
      assert.equal(room, REF);
      assert.equal(user, SIGN_IN);
    }
    const text = await run(['--link'], { found: { server: server.url, room: REF, user: SIGN_IN } });
    assert.equal(text.code, 0, text.stderr);
    assert.ok(text.stdout.includes(`${server.url}/r/${REF}`), 'a room read by its ref is linked by it');

    server.seen.length = 0;
    const byKey = await run(['--to', 'json'], { found: { server: server.url, room: ROOM, user: SIGN_IN } });
    assert.equal(byKey.code, 0, byKey.stderr);
    assert.equal(JSON.parse(byKey.stdout).label, 'from the server');
    for (const { room, user } of server.seen) assert.deepEqual({ room, user }, { room: ROOM, user: SIGN_IN });
  } finally {
    await server.close();
  }
  const none = await run(['--to', 'json'], { found: { problem: 'no room to read — run this in a repository', code: 2 } });
  assert.equal(none.code, 2);
  assert.equal(none.stderr, 'agentmash digest: no room to read — run this in a repository\n');
  const help = await run(['--help'], { found: {} });
  assert.match(help.stdout, /^  npx agentmash digest \[--since 7d\]/m);
  assert.match(help.stdout, /the room this machine's sign-in finds/);
  assert.doesNotMatch((await run(['--help'])).stdout, /sign-in finds/, 'agentmash-digest finds no sign-in');
});

test('a Telegram error body fails loudly even though it arrives as HTTP 200', async () => {
  const server = await startMockServer(realisticWeek());
  const hook = await startMockWebhook({ body: { ok: false, description: 'chat not found' } });
  try {
    const result = await run([
      '--server', server.url, '--room', ROOM, '--to', 'telegram',
      '--webhook', hook.url, '--chat-id', 'nope',
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /chat not found/);
  } finally {
    await server.close();
    await hook.close();
  }
});

test('an unreachable coordination server exits non-zero with a usable message', async () => {
  const server = await startMockServer([]);
  const dead = server.url;
  await server.close();
  const result = await run(['--server', dead, '--room', ROOM, '--to', 'json']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /reading events failed/);
  assert.match(result.stderr, new RegExp(dead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a coordination server that answers with an error exits non-zero', async () => {
  const server = await startMockServer([], { broken: true });
  try {
    const result = await run(['--server', server.url, '--room', ROOM, '--to', 'json']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /HTTP 500/);
    assert.match(result.stderr, /database is on fire/);
  } finally {
    await server.close();
  }
});

test('a server that never answers is cut off by the timeout, not left to hang', async () => {
  const server = await startMockServer([], { hang: true });
  try {
    const started = Date.now();
    const result = await run(['--server', server.url, '--room', ROOM, '--to', 'json', '--timeout', '300']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /timed out after 300ms/);
    assert.ok(Date.now() - started < 5000, 'the CLI should not have waited around');
  } finally {
    await server.close();
  }
});

test('a dead webhook exits non-zero and says what came back', async () => {
  const server = await startMockServer(realisticWeek());
  const hook = await startMockWebhook({ status: 404, body: 'no_service' });
  try {
    const result = await run([
      '--server', server.url, '--room', ROOM, '--to', 'slack', '--webhook', hook.url,
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /posting to Slack returned HTTP 404/);
    assert.match(result.stderr, /no_service/);
  } finally {
    await server.close();
    await hook.close();
  }
});

test('usage mistakes exit 2 and never touch the network', async () => {
  const noWebhook = await run(['--server', 'http://127.0.0.1:1', '--room', ROOM, '--to', 'slack']);
  assert.equal(noWebhook.code, 2);
  assert.match(noWebhook.stderr, /needs --webhook/);

  const noChat = await run([
    '--server', 'http://127.0.0.1:1', '--room', ROOM, '--to', 'telegram', '--webhook', 'http://x',
  ]);
  assert.equal(noChat.code, 2);
  assert.match(noChat.stderr, /--chat-id/);

  const badTarget = await run(['--server', 'http://127.0.0.1:1', '--room', ROOM, '--to', 'email']);
  assert.equal(badTarget.code, 2);

  const badSince = await run(['--server', 'http://127.0.0.1:1', '--room', ROOM, '--since', 'lastweek']);
  assert.equal(badSince.code, 2);

  // A flag it does not know, a stray word or an option with no value is
  // refused, not dropped: a dropped --dryrun is a digest that posts. And every
  // threshold is checked before the room is read, as the CLI's lookup is.
  const server = await startMockServer(realisticWeek());
  try {
    const room = ['--server', server.url, '--room', ROOM];
    for (const [args, said] of [
      [[...room, '--to', 'slack', '--webhook', 'http://127.0.0.1:1', '--dryrun'], /unknown option --dryrun/],
      [[...room, 'slack'], /unexpected "slack"/],
      [[...room, '--to'], /--to needs a value/],
      [[...room, '--webhook', '--dry-run', '--to', 'slack'], /--webhook needs a value/],
      [[...room, '--hot-min-devs', '0'], /--hot-min-devs must be a whole number/],
      [[...room, '--hot-window', 'soon'], /--hot-window must look like/],
      [[...room, '--stall-days=1.5'], /--stall-days must be a whole number/],
    ]) {
      const result = await run(args);
      assert.equal(result.code, 2, `${args.slice(4).join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, said);
      assert.equal(result.stdout, '');
    }
    assert.deepEqual(server.requests, [], 'nothing was read');
    // --option=value is --option value
    const joined = await run([...room, '--to=json', '--since=24h']);
    assert.equal(joined.code, 0, joined.stderr);
    const period = JSON.parse(joined.stdout).period;
    assert.equal(Date.parse(period.end) - Date.parse(period.start), 24 * HOUR);
  } finally {
    await server.close();
  }

  const noRoomBadThreshold = await run(['--to', 'json', '--pair-min-files', 'x'], {
    found: { problem: 'should not be asked', code: 1 },
  });
  assert.equal(noRoomBadThreshold.code, 2, 'the threshold, before the room is looked for');
  assert.match(noRoomBadThreshold.stderr, /--pair-min-files must be a whole number/);

  // Run from a folder outside any repo: from the suite's own cwd, a checkout
  // connected to a room (.claude/agentmash/config.json) would hand the CLI a
  // real room, and this case would read from it instead of stopping.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-no-room-'));
  try {
    const noRoom = await run(['--to', 'json'], { env: { HOME: '/nonexistent' }, cwd: outside });
    assert.equal(noRoom.code, 2);
    assert.match(noRoom.stderr, /no room to read/);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a dry run renders the payload without posting anywhere', async () => {
  const server = await startMockServer(realisticWeek());
  try {
    const result = await run([
      '--server', server.url, '--room', ROOM, '--to', 'slack', '--dry-run',
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).blocks[0].type, 'header');
  } finally {
    await server.close();
  }
});

// --link put the room's id in the channel, and the id is the room's key:
// whoever read the channel held the room. Where a GitHub sign-in opens the
// dashboard by the room's ref, that is the link; the id only where nothing
// else opens it.
test('--link names the dashboard by its ref where a sign-in opens it, and by the room id only where nothing else does', async () => {
  const self = { room_ref: 'rm_0a1b2c3d4e', label: 'acme-api' };
  const signsIn = await startMockServer(realisticWeek(), { self, config: { oauth: true } });
  try {
    const result = await run(['--server', signsIn.url, '--room', ROOM, '--link']);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(`${signsIn.url}/r/rm_0a1b2c3d4e`), result.stdout);
    assert.ok(!result.stdout.includes(ROOM), 'no key in what goes to the channel');
    const without = await run(['--server', signsIn.url, '--room', ROOM]);
    assert.ok(!without.stdout.includes('/r/'), 'and no link unless asked for');
  } finally {
    await signsIn.close();
  }
  const signsNobodyIn = await startMockServer(realisticWeek(), { self, config: { oauth: false } });
  try {
    const result = await run(['--server', signsNobodyIn.url, '--room', ROOM, '--link']);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(`${signsNobodyIn.url}/r/${ROOM}`), result.stdout);
  } finally {
    await signsNobodyIn.close();
  }
});

test('an empty room still exits 0 and posts something honest', async () => {
  const server = await startMockServer([]);
  const hook = await startMockWebhook();
  try {
    const result = await run([
      '--server', server.url, '--room', ROOM, '--to', 'slack', '--webhook', hook.url,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(hook.posts.length, 1);
    assert.match(JSON.stringify(hook.posts[0].body), /nothing recorded/);
  } finally {
    await server.close();
    await hook.close();
  }
});
