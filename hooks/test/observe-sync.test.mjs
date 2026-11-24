// Syncing (observe_sync.mjs): what a machine's agents found goes to a room
// that shares and to no other, and what the team found comes back and is in
// the next session's index (docs/plans/enrichment-step2-room.md, criteria 1,
// 2 and 10).
//
// The room is fixtures/observe-mock-room.mjs, a server on a port of its own
// that writes down every request. A machine is a throwaway AGENTMASH_HOME and
// a checkout of acme/app that carries the room; a test with two of them moves
// this process from one to the other (`use`), since everything here reads its
// home and its name from the environment as it is called. No worker, no
// `claude`, and nothing of the real ~/.agentmash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as observe from '../observe.mjs';
import * as sync from '../observe_sync.mjs';
import { KEY, REF, USER_TOKEN, baseEnv, runHook } from './fixtures.mjs';
import { startRoom } from './fixtures/observe-mock-room.mjs';
import { tempDir } from './tmp.mjs';

// Whatever of AgentMash's this shell has set would point a machine of these tests elsewhere.
for (const name of Object.keys(process.env)) if (name.startsWith('AGENTMASH_')) delete process.env[name];

const REPO_KEY = 'acme__app';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.now();
// when the room of most tests turned sharing on
const SINCE = NOW - 6 * HOUR;

/** A room that is closed when its test ends. */
async function roomFor(t, options) {
  const room = await startRoom(options);
  t.after(() => room.close());
  return room;
}

/**
 * A machine with observing on and a checkout of acme/app, which syncing has
 * been told of. With a `room`, the checkout carries it (its key, as `npx
 * agentmash init` commits it); with `signedIn`, the machine is signed in to
 * that server instead and the checkout carries nothing. `use()` makes this
 * process that machine.
 */
function machine(name, { room = null, signedIn = null } = {}) {
  const home = fs.realpathSync(tempDir('observe-sync-home-'));
  const top = fs.realpathSync(tempDir('observe-sync-checkout-'));
  fs.mkdirSync(path.join(top, '.git'));
  fs.writeFileSync(path.join(top, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(top, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/app.git\n');
  if (room) {
    fs.mkdirSync(path.join(top, '.claude', 'agentmash'), { recursive: true });
    fs.writeFileSync(path.join(top, '.claude', 'agentmash', 'config.json'), JSON.stringify({ url: room.url, room: KEY }));
  }
  if (signedIn) {
    fs.mkdirSync(path.join(home, '.agentmash'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agentmash', 'user.json'), JSON.stringify({ url: signedIn.url, token: USER_TOKEN, login: name }));
  }
  const m = {
    name,
    home,
    top,
    use() {
      process.env.AGENTMASH_HOME = home;
      if (signedIn) delete process.env.AGENTMASH_DEV;
      else process.env.AGENTMASH_DEV = name;
      return m;
    },
  };
  m.use();
  observe.writeConfig({ enabled: true });
  sync.noteCheckout(REPO_KEY, top);
  return m;
}

let made = 0;
/** An observation as the worker logs one, made at `ts`. */
function found(title, ts, more = {}) {
  made += 1;
  return {
    v: 1,
    id: `o_${made.toString(36).padStart(10, '0')}`,
    ts,
    session_id: 'session-1',
    agent: 'claude-code',
    developer: null,
    repo: 'acme/app',
    branch: 'main',
    checkout_id: 'co_0123456789abcdefghijkl',
    head: 'abc1234',
    type: 'cause',
    title,
    facts: [`${title}, in detail.`],
    files: ['src/tags.ts'],
    blobs: {},
    symbols: [],
    evidence: { kind: 'none', ref: '' },
    batch: { from: ts - 1000, to: ts },
    model: 'claude-haiku-5-5',
    seen: 1,
    ...more,
  };
}

/** Logs an observation on machine `m`, as new. */
function log(m, obs) {
  m.use();
  assert.deepEqual(observe.addObservation(REPO_KEY, obs, obs.ts), { added: obs.id });
  return obs;
}

/** One round on machine `m`, at work in its checkout at `now`, as the worker says of each batch it observes. */
function round(m, now = NOW) {
  m.use();
  sync.noteCheckout(REPO_KEY, m.top, now);
  return sync.syncRound({ now });
}

/** One round on machine `m` with nothing said of its checkout: whether it is at work is as the test left it. */
function roundAsItIs(m, now = NOW) {
  m.use();
  return sync.syncRound({ now });
}

const asked = (room) => room.requests.map((r) => `${r.method} ${r.path}`);
const entriesOf = (post) => post.body.entries.map((entry) => `${entry.op} ${entry.op === 'add' ? entry.obs.id : entry.id}`);
const rawLog = (m) => fs.readFileSync(path.join(m.home, '.agentmash', 'observe', 'log', `${REPO_KEY}.jsonl`), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
/** The cursor, and the number of the last forget that went on its own: under a veto, or to a room that does not share. */
const cursors = () => [observe.readSyncState(REPO_KEY).sent, observe.readSyncState(REPO_KEY).forgot];

/**
 * Turns a room's sharing off as a server that still takes a forget does it:
 * asked, the room says it does not share, and it goes on taking what it is
 * posted, which a test holds to forgets alone. The mock room's own switch
 * (`room.sharing = false`) is a server from before that: it turns every post
 * away with 403 sharing_off.
 */
function stopSharing(room) {
  room.answer = { sharing: false, share_since: null, seq: room.seq, observations: [] };
}

test('against a room that does not share, a machine with twenty observations posts nothing, and its team cache says the room does not share', async (t) => {
  const room = await roomFor(t);
  const m = machine('alim', { room });
  for (let i = 0; i < 20; i++) log(m, found(`finding number ${i}`, NOW - HOUR + i));

  assert.deepEqual(await round(m), [{ key: REPO_KEY, pulled: 0, pushed: 0, refused: 0, error: null }]);
  assert.deepEqual(await round(m, NOW + 30_000), [{ key: REPO_KEY, pulled: 0, pushed: 0, refused: 0, error: null }]);

  assert.deepEqual(asked(room), ['GET /observations', 'GET /observations'], 'the room is asked, and sent nothing');
  assert.equal(room.requests[0].query.limit, '500');
  assert.equal(room.requests[0].room, KEY, 'with the credentials its hooks report with');
  assert.deepEqual(observe.readTeam(REPO_KEY), { v: 1, at: NOW + 30_000, sharing: false, share_since: null, seq: 0, observations: [] });
  assert.equal(observe.readObservations(REPO_KEY).length, 20, 'what was found stays on the machine');
  assert.deepEqual(sync.syncStatus(), [
    { key: REPO_KEY, repo: 'acme/app', top: m.top, sharing: false, share_since: null, sent: 0, pending: 0, pulled_at: NOW + 30_000, pushed_at: 0, team: 0, error: null },
  ]);
  assert.equal(observe.recallIndex(REPO_KEY, { now: NOW }).split('\n')[0], observe.RECALL_HEADER, 'and its sessions are told its own, as before');
});

test('with sharing on, what was found since the room began to share is posted once, what was found before never is, a forget made later is posted, and a 503 leaves the cursor where it was', async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const m = machine('alim', { room });
  const old = [log(m, found('the lock file is rewritten on install', SINCE - 5000)), log(m, found('tags are cut from main only', SINCE - 4000))];
  const fresh = [0, 1, 2].map((i) => log(m, found(`fresh finding ${i}`, SINCE + 1000 + i)));
  // found again since: one from before the room shared, and one from after
  assert.deepEqual(observe.addObservation(REPO_KEY, found('The lock file is rewritten on install!', SINCE + 2000), SINCE + 2000), { merged: old[0].id });
  assert.deepEqual(observe.addObservation(REPO_KEY, found('fresh finding 1', SINCE + 2500), SINCE + 2500), { merged: fresh[1].id });
  assert.deepEqual(rawLog(m).map((line) => line.n), [1, 2, 3, 4, 5, 6, 7], 'every line of the log has its number');

  assert.deepEqual(await round(m), [{ key: REPO_KEY, pulled: 0, pushed: 4, refused: 0, error: null }]);
  const [first, ...more] = room.posts();
  assert.equal(more.length, 0, 'one request');
  assert.equal(first.body.developer, 'alim');
  assert.equal(first.body.repo, 'acme/app');
  assert.equal(first.room, KEY);
  assert.deepEqual(entriesOf(first), [`add ${fresh[0].id}`, `add ${fresh[1].id}`, `add ${fresh[2].id}`, `seen ${fresh[1].id}`], 'oldest first');
  assert.deepEqual(first.body.entries[3], { op: 'seen', id: fresh[1].id, ts: SINCE + 2500 });
  assert.equal(observe.readSyncState(REPO_KEY).sent, 7, 'the cursor is at the last line of the request');
  assert.equal(observe.readSyncState(REPO_KEY).share_since, SINCE);

  // the second round has nothing to send
  assert.deepEqual(await round(m, NOW + 30_000), [{ key: REPO_KEY, pulled: 3, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 1);
  assert.equal(sync.syncStatus()[0].pending, 0);

  // a forget made later, while the server is failing
  m.use();
  assert.equal(observe.forgetObservation(fresh[2].id, NOW + 40_000), REPO_KEY);
  assert.equal(sync.syncStatus()[0].pending, 1);
  room.fail = 503;
  assert.deepEqual(await round(m, NOW + 60_000), [{ key: REPO_KEY, pulled: 3, pushed: 0, refused: 0, error: 'push: 503 unavailable' }]);
  assert.equal(room.posts().length, 2, 'it was tried');
  assert.equal(observe.readSyncState(REPO_KEY).sent, 7, 'and the cursor did not move');
  assert.deepEqual(observe.readSyncState(REPO_KEY).error, { at: NOW + 60_000, what: 'push: 503 unavailable' });
  assert.equal(sync.syncStatus()[0].pending, 1);

  // the server back, the forget goes
  room.fail = null;
  assert.deepEqual(await round(m, NOW + 90_000), [{ key: REPO_KEY, pulled: 3, pushed: 1, refused: 0, error: null }]);
  assert.deepEqual(room.posts().at(-1).body.entries, [{ op: 'forget', id: fresh[2].id, ts: NOW + 40_000 }]);
  assert.ok(room.entries.has(`o:forget:${fresh[2].id}`));
  const state = observe.readSyncState(REPO_KEY);
  assert.deepEqual([state.sent, state.error, state.pushed_at], [8, null, NOW + 90_000]);
  assert.deepEqual(await round(m, NOW + 120_000), [{ key: REPO_KEY, pulled: 2, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 3, 'and is not sent again');

  // nothing of what was found before the room shared ever left
  const sent = room.posts().map((post) => post.raw).join('\n');
  for (const obs of old) assert.ok(!sent.includes(obs.id) && !sent.includes(obs.title), obs.title);
  assert.deepEqual([...room.entries.keys()].filter((id) => id.startsWith('o:add:')).sort(), fresh.map((obs) => `o:add:${obs.id}`).sort());
});

test('a backlog goes fifty entries and sixty kilobytes at a time, a few requests a round, and an entry the room refuses is counted and not sent again', async (t) => {
  // small ones: fifty to a request, three requests a round
  const small = await roomFor(t, { sharing: true, shareSince: SINCE });
  const a = machine('alim', { room: small });
  const few = Array.from({ length: 170 }, (_, i) => log(a, found(`small finding ${i}`, SINCE + 1000 + i)));
  assert.deepEqual(await round(a), [{ key: REPO_KEY, pulled: 0, pushed: 150, refused: 0, error: null }]);
  assert.deepEqual(small.posts().map((post) => post.body.entries.length), [50, 50, 50]);
  assert.equal(observe.readSyncState(REPO_KEY).sent, 150);
  assert.equal(sync.syncStatus()[0].pending, 20);
  assert.deepEqual((await round(a, NOW + 30_000)).map((line) => line.pushed), [20]);
  assert.deepEqual(small.posts().flatMap(entriesOf), few.map((obs) => `add ${obs.id}`), 'each once, in the order they were found');

  // fat ones: a request ends before it is over sixty kilobytes
  const fat = await roomFor(t, { sharing: true, shareSince: SINCE });
  const b = machine('bob', { room: fat });
  const facts = (i) => [1, 2, 3].map((n) => `fact ${n} of finding ${i} ${'and more of it '.repeat(15)}`.slice(0, 240));
  const files = (i) => Array.from({ length: 8 }, (_, n) => `packages/app-${i}/src/${'deep/'.repeat(16)}module-${n}.ts`);
  const many = Array.from({ length: 120 }, (_, i) => log(b, found(`fat finding ${i} ${'x'.repeat(90)}`, SINCE + 1000 + i, { facts: facts(i), files: files(i) })));
  fat.refuse = (entry) => (entry.obs?.id === many[7].id ? 'orders' : null);
  const rounds = [await round(b), await round(b, NOW + 30_000), await round(b, NOW + 60_000)];
  const posts = fat.posts();
  assert.ok(posts.length > 3, `${posts.length} requests for what would be three by count alone`);
  for (const post of posts) {
    assert.ok(post.bytes <= 60 * 1024, `a request of ${post.bytes} bytes`);
    assert.ok(post.body.entries.length <= 50);
  }
  assert.ok(posts[0].bytes > 50 * 1024, 'and a request is as full as it may be');
  assert.deepEqual(posts.flatMap(entriesOf), many.map((obs) => `add ${obs.id}`), 'each once, the refused one too');
  assert.equal(rounds.flat().reduce((n, line) => n + line.refused, 0), 1);
  assert.equal(rounds.flat().reduce((n, line) => n + line.pushed, 0), 119);
  // the round that met the refusal says what the room refused it for, and no other round has a why
  assert.deepEqual(rounds.flat().filter((line) => 'why' in line).map((line) => [line.refused, line.why]), [[1, { orders: 1 }]]);
  assert.ok(!fat.entries.has(`o:add:${many[7].id}`));
  assert.equal(observe.readSyncState(REPO_KEY).sent, 120, 'the cursor passed it');
});

test('a machine that keeps what it finds to itself posts nothing it found, and still pulls what the team found', async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const a = machine('alim', { room });
  log(a, found('getLatestTag misses tags on unmerged branches', NOW - HOUR));
  await round(a);
  assert.equal(room.posts().length, 1);

  const b = machine('bob', { room });
  log(b, found('schema.json is written by scripts/gen.mjs', NOW - 30 * MINUTE));
  log(b, found('the release job reads tags from main', NOW - 20 * MINUTE));
  const kept = () => {
    assert.equal(room.posts().length, 1, 'nothing more is posted');
    assert.deepEqual(observe.readTeam(REPO_KEY).observations.map((o) => [o.developer, o.title]), [['alim', 'getLatestTag misses tags on unmerged branches']]);
    assert.equal(observe.readSyncState(REPO_KEY).sent, 0);
  };

  // "share": false in observe.json
  observe.writeConfig({ share: false });
  assert.equal(observe.vetoesSharing(), true);
  assert.deepEqual(await round(b), [{ key: REPO_KEY, pulled: 1, pushed: 0, refused: 0, error: null }]);
  kept();
  assert.match(observe.recallIndex(REPO_KEY, { now: NOW }), /\(alim, claude-code, 60 min ago\)/, 'and its sessions are told what the team found');

  // AGENTMASH_OBSERVE_SHARE, as any off word
  observe.writeConfig({ share: true });
  for (const word of ['0', 'off', 'false', 'no', 'OFF', 'False', ' No ']) {
    process.env.AGENTMASH_OBSERVE_SHARE = word;
    assert.equal(observe.vetoesSharing(), true, word);
    await round(b, NOW + 1000);
    kept();
  }
  // a word that is not an off word is no veto, and neither is the variable unset
  for (const word of ['1', 'on', 'yes', 'maybe', '']) {
    process.env.AGENTMASH_OBSERVE_SHARE = word;
    assert.equal(observe.vetoesSharing(), false, JSON.stringify(word));
  }
  delete process.env.AGENTMASH_OBSERVE_SHARE;
  assert.equal(observe.vetoesSharing(), false);
  assert.equal(asked(room).filter((line) => line === 'GET /observations').length, 9, 'one pull a round, the veto or not');

  // As the code is today: a veto holds lines back and does not move the cursor past them, so what was
  // found under it goes once it is lifted. Whether that is what a person who said no expects is not settled.
  assert.equal(sync.syncStatus()[0].pending, 2);
  assert.deepEqual(await round(b, NOW + 2000), [{ key: REPO_KEY, pulled: 1, pushed: 2, refused: 0, error: null }]);
  assert.deepEqual(room.posts().at(-1).body.developer, 'bob');
});

test('a machine that keeps what it finds to itself still takes back what its room was sent: the forget is posted once, with no add or seen beside it and the cursor where it was, and what was held back goes when the veto is lifted', async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const m = machine('bob', { room });
  const tags = log(m, found('getLatestTag misses tags on unmerged branches', NOW - HOUR));
  const schema = log(m, found('schema.json is written by scripts/gen.mjs', NOW - 50 * MINUTE));
  assert.deepEqual(await round(m), [{ key: REPO_KEY, pulled: 0, pushed: 2, refused: 0, error: null }]);
  assert.deepEqual(cursors(), [2, 0]);

  // `observe local on`, and under it: a finding of its own, one the room has seen again, and that one taken back
  observe.writeConfig({ share: false });
  const home = log(m, found('the release job reads tags from main', NOW - 20 * MINUTE));
  assert.deepEqual(observe.addObservation(REPO_KEY, found('GetLatestTag misses tags on unmerged branches!', NOW - 10 * MINUTE), NOW - 10 * MINUTE), { merged: tags.id });
  assert.equal(observe.forgetObservation(tags.id, NOW + 10_000), REPO_KEY);
  assert.deepEqual(rawLog(m).map((line) => `${line.n} ${line.op}`), ['1 add', '2 add', '3 add', '4 seen', '5 forget']);

  // the room failing: the forget is tried, alone, and its number stays where it was
  room.fail = 503;
  assert.deepEqual(await round(m, NOW + 30_000), [{ key: REPO_KEY, pulled: 2, pushed: 0, refused: 0, error: 'push: 503 unavailable' }]);
  assert.equal(room.posts().length, 2, 'it was tried');
  assert.deepEqual(cursors(), [2, 0]);

  // the room back: the forget goes, and the cursor has not moved
  room.fail = null;
  assert.deepEqual(await round(m, NOW + 60_000), [{ key: REPO_KEY, pulled: 2, pushed: 1, refused: 0, error: null }]);
  assert.equal(room.posts().length, 3);
  assert.deepEqual(room.posts().at(-1).body.entries, [{ op: 'forget', id: tags.id, ts: NOW + 10_000 }], 'no add and no seen beside it');
  assert.ok(room.entries.has(`o:forget:${tags.id}`));
  assert.deepEqual(room.findings().map((finding) => finding.title), [schema.title], 'the room no longer holds it');
  assert.deepEqual(cursors(), [2, 5]);
  assert.equal(sync.syncStatus()[0].pending, 3, 'what is held back still waits, the forget among it');

  // a second round posts nothing
  assert.deepEqual(await round(m, NOW + 90_000), [{ key: REPO_KEY, pulled: 1, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 3);

  // a forget made later goes without the one before it
  assert.equal(observe.forgetObservation(schema.id, NOW + 100_000), REPO_KEY);
  assert.deepEqual(await round(m, NOW + 120_000), [{ key: REPO_KEY, pulled: 1, pushed: 1, refused: 0, error: null }]);
  assert.deepEqual(room.posts().at(-1).body.entries, [{ op: 'forget', id: schema.id, ts: NOW + 100_000 }]);
  assert.deepEqual(cursors(), [2, 6]);

  // nothing this machine found left it under the veto
  const under = room.posts().slice(1);
  assert.deepEqual(under.flatMap(entriesOf), [`forget ${tags.id}`, `forget ${tags.id}`, `forget ${schema.id}`]);
  for (const post of under) assert.ok(!post.raw.includes(home.id) && !post.raw.includes(home.title), 'what was found under the veto is in none of them');

  // the veto lifted: the lines held back go as they did before, in their order, and the room keeps each forget once
  observe.writeConfig({ share: true });
  assert.equal(sync.syncStatus()[0].pending, 4);
  assert.deepEqual(await round(m, NOW + 150_000), [{ key: REPO_KEY, pulled: 0, pushed: 4, refused: 0, error: null }]);
  assert.deepEqual(entriesOf(room.posts().at(-1)), [`add ${home.id}`, `seen ${tags.id}`, `forget ${tags.id}`, `forget ${schema.id}`]);
  assert.equal(observe.readSyncState(REPO_KEY).sent, 6);
  assert.deepEqual([...room.entries.keys()].filter((id) => id.startsWith('o:forget:')), [`o:forget:${tags.id}`, `o:forget:${schema.id}`]);
  assert.deepEqual(room.findings().map((finding) => finding.title), [home.title]);
  assert.deepEqual(await round(m, NOW + 180_000), [{ key: REPO_KEY, pulled: 1, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 5, 'and nothing is sent again');
});

test('a forget of a finding the veto is holding back waits with it, so the room is never sent a forget ahead of its finding and left holding the finding', async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const m = machine('bob', { room });
  observe.writeConfig({ share: false });
  const home = log(m, found('the release job reads tags from main', NOW - 20 * MINUTE));
  assert.equal(observe.forgetObservation(home.id, NOW + 10_000), REPO_KEY);

  assert.deepEqual(await round(m), [{ key: REPO_KEY, pulled: 0, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 0, 'the room was never sent it, and is not told it is gone');
  assert.deepEqual(cursors(), [0, 0]);

  // The veto lifted: the finding and its forget go together, in the order they were made. The room keeps a
  // forget once and takes it only of a finding it holds, so one sent ahead would have left this finding there.
  observe.writeConfig({ share: true });
  assert.deepEqual(await round(m, NOW + 30_000), [{ key: REPO_KEY, pulled: 0, pushed: 2, refused: 0, error: null }]);
  assert.deepEqual(room.posts().map(entriesOf), [[`add ${home.id}`, `forget ${home.id}`]]);
  assert.deepEqual(room.findings(), [], 'and the room holds nothing of it');
});

test('a forget made while the room has sharing off is posted once, alone, with the cursor where it was and the team cache saying the room does not share, and goes once more when the room shares again', async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const m = machine('bob', { room });
  const tags = log(m, found('getLatestTag misses tags on unmerged branches', NOW - HOUR));
  const schema = log(m, found('schema.json is written by scripts/gen.mjs', NOW - 50 * MINUTE));
  assert.deepEqual(await round(m), [{ key: REPO_KEY, pulled: 0, pushed: 2, refused: 0, error: null }]);
  assert.deepEqual(cursors(), [2, 0]);

  // The room stops sharing. Then: a finding, which no room is sent; one the room holds taken back; and the new one too.
  stopSharing(room);
  const home = log(m, found('the release job reads tags from main', NOW - 20 * MINUTE));
  assert.equal(observe.forgetObservation(tags.id, NOW + 10_000), REPO_KEY);
  assert.equal(observe.forgetObservation(home.id, NOW + 11_000), REPO_KEY);
  assert.deepEqual(rawLog(m).map((line) => `${line.n} ${line.op}`), ['1 add', '2 add', '3 add', '4 forget', '5 forget']);

  assert.deepEqual(await round(m, NOW + 30_000), [{ key: REPO_KEY, pulled: 0, pushed: 1, refused: 0, error: null }]);
  assert.equal(room.posts().length, 2);
  assert.deepEqual(room.posts().at(-1).body.entries, [{ op: 'forget', id: tags.id, ts: NOW + 10_000 }], 'alone: the room was never sent the other finding, and is not told it is gone');
  assert.ok(room.entries.has(`o:forget:${tags.id}`));
  assert.deepEqual(cursors(), [2, 4], 'the cursor has not moved');
  assert.ok(!room.posts().at(-1).raw.includes(home.id) && !room.posts().at(-1).raw.includes(home.title), 'nothing of what was found since');
  // everything else about a room that does not share is as it was
  assert.deepEqual([observe.readTeam(REPO_KEY).sharing, observe.readTeam(REPO_KEY).observations], [false, []]);
  assert.deepEqual([sync.syncStatus()[0].sharing, sync.syncStatus()[0].error], [false, null]);

  // a second round posts nothing, and a forget that has gone is no reason to ask about a repository nobody is at work in
  assert.deepEqual(await round(m, NOW + 60_000), [{ key: REPO_KEY, pulled: 0, pushed: 0, refused: 0, error: null }]);
  observe.updateSyncState(REPO_KEY, { noted_at: NOW - 15 * MINUTE });
  assert.deepEqual(await roundAsItIs(m, NOW + 90_000), []);
  assert.equal(room.posts().length, 2);

  // The room shares again, from now. The forgets are from before that and are owed all the same: both go, as
  // lines after the cursor did before, and the room keeps the one it has once.
  room.answer = null;
  room.share_since = NOW + 100_000;
  assert.deepEqual(await round(m, NOW + 120_000), [{ key: REPO_KEY, pulled: 1, pushed: 2, refused: 0, error: null }]);
  assert.deepEqual(entriesOf(room.posts().at(-1)), [`forget ${tags.id}`, `forget ${home.id}`]);
  assert.deepEqual(cursors(), [5, 4]);
  assert.deepEqual([...room.entries.keys()].filter((id) => id.startsWith('o:forget:')), [`o:forget:${tags.id}`, `o:forget:${home.id}`]);
  assert.deepEqual(room.findings().map((finding) => finding.title), [schema.title]);
  assert.ok(!room.posts().some((post) => post.raw.includes(home.title)), 'and what was found while the room did not share never went');
});

test('a server from before a room that does not share took a forget turns it away: the numbers stay, no error is told, it is not asked again for ten minutes, and the forget goes when the room shares again', async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const m = machine('bob', { room });
  const tags = log(m, found('getLatestTag misses tags on unmerged branches', NOW - HOUR));
  assert.deepEqual(await round(m), [{ key: REPO_KEY, pulled: 0, pushed: 1, refused: 0, error: null }]);

  // the mock room's own switch: with sharing off it turns every post away, a forget alone too
  room.sharing = false;
  assert.equal(observe.forgetObservation(tags.id, NOW + 10_000), REPO_KEY);
  assert.deepEqual(await round(m, NOW + 30_000), [{ key: REPO_KEY, pulled: 0, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 2, 'it was tried');
  assert.deepEqual(entriesOf(room.posts().at(-1)), [`forget ${tags.id}`]);
  assert.deepEqual(cursors(), [1, 0], 'and the numbers are where they were');
  assert.deepEqual([observe.readSyncState(REPO_KEY).sharing, observe.readSyncState(REPO_KEY).error, sync.syncStatus()[0].error], [false, null, null]);
  assert.deepEqual([observe.readTeam(REPO_KEY).sharing, observe.readTeam(REPO_KEY).observations], [false, []]);

  // the next round pulls and does not post, and the forget is no reason to ask about a repository nobody is at work in
  assert.deepEqual(await round(m, NOW + 60_000), [{ key: REPO_KEY, pulled: 0, pushed: 0, refused: 0, error: null }]);
  observe.updateSyncState(REPO_KEY, { noted_at: NOW - 15 * MINUTE });
  assert.deepEqual(await roundAsItIs(m, NOW + 90_000), []);
  assert.equal(room.posts().length, 2);
  assert.equal(asked(room).filter((line) => line === 'GET /observations').length, 3);
  // ten minutes on it is tried again, and turned away again
  assert.deepEqual(await round(m, NOW + 11 * MINUTE), [{ key: REPO_KEY, pulled: 0, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 3);
  assert.deepEqual(cursors(), [1, 0]);

  // The room shares again, from now, and shows the finding again. The forget is from before that and is still
  // owed: it goes in the first round, which does not wait out a hold that was about a room that did not share.
  room.sharing = true;
  room.share_since = NOW + 12 * MINUTE;
  assert.deepEqual(await round(m, NOW + 13 * MINUTE), [{ key: REPO_KEY, pulled: 1, pushed: 1, refused: 0, error: null }]);
  assert.deepEqual(room.posts().at(-1).body.entries, [{ op: 'forget', id: tags.id, ts: NOW + 10_000 }]);
  assert.deepEqual(cursors(), [2, 0]);
  assert.deepEqual(room.findings(), [], 'the room no longer holds it');
  assert.deepEqual(await round(m, NOW + 14 * MINUTE), [{ key: REPO_KEY, pulled: 0, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 4, 'and it is not sent again');
});

test('across a rotation of the log the line numbers go on growing, and the room is sent every line once: none again, none skipped', async (t) => {
  const limit = observe.LIMITS.logLines;
  observe.LIMITS.logLines = 5;
  t.after(() => (observe.LIMITS.logLines = limit));
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const m = machine('alim', { room });
  const logged = [];
  const more = (count) => {
    for (let i = 0; i < count; i++) logged.push(log(m, found(`finding ${logged.length + 1} of the rotation`, SINCE + 1000 + logged.length)));
  };
  const dir = path.join(m.home, '.agentmash', 'observe', 'log');
  const numbers = (name) => {
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).n);
    } catch {
      return null;
    }
  };
  const files = () => [numbers(`${REPO_KEY}.jsonl.1`), numbers(`${REPO_KEY}.jsonl`)];

  // a full file, all of it sent
  more(5);
  assert.deepEqual(files(), [null, [1, 2, 3, 4, 5]]);
  assert.deepEqual((await round(m)).map((line) => line.pushed), [5]);
  assert.equal(observe.readSyncState(REPO_KEY).sent, 5);

  // it rotates, and rotates again over a file the room has all of: the numbers go on from where they were
  more(7);
  assert.deepEqual(files(), [[6, 7, 8, 9, 10], [11, 12]], 'the second rotation dropped lines 1 to 5, which the room has');
  assert.equal(sync.syncStatus()[0].pending, 7, 'the lines the room has not been sent are in both files');
  assert.deepEqual((await round(m, NOW + 30_000)).map((line) => line.pushed), [7]);
  assert.equal(observe.readSyncState(REPO_KEY).sent, 12);

  // the room is down, and the log fills: it does not rotate over lines the room is still to be sent
  room.fail = 503;
  more(10);
  assert.deepEqual(files(), [[11, 12, 13, 14, 15], [16, 17, 18, 19, 20, 21, 22]], 'the current file grew past its limit instead');
  assert.equal((await round(m, NOW + 60_000))[0].error, 'push: 503 unavailable');
  assert.equal(observe.readSyncState(REPO_KEY).sent, 12);
  assert.equal(observe.readObservations(REPO_KEY).length, 12, 'and every line of both files is read, the long one too');
  const failed = room.posts().length;

  // the room back: what waited goes, oldest first, and then the log rotates as it always did
  room.fail = null;
  assert.deepEqual((await round(m, NOW + 90_000)).map((line) => line.pushed), [10]);
  assert.equal(observe.readSyncState(REPO_KEY).sent, 22);
  more(1);
  assert.deepEqual(files(), [[16, 17, 18, 19, 20, 21, 22], [23]]);
  assert.deepEqual((await round(m, NOW + 120_000)).map((line) => line.pushed), [1]);
  assert.deepEqual((await round(m, NOW + 150_000)).map((line) => line.pushed), [0]);

  // every line once, in the order it was logged, the request the room failed aside
  const taken = room.posts().filter((_, i) => i !== failed - 1).flatMap(entriesOf);
  assert.deepEqual(taken, logged.map((obs) => `add ${obs.id}`));
  assert.deepEqual([...room.entries.keys()], logged.map((obs) => `o:add:${obs.id}`));

  // a machine that keeps its findings home has nothing waiting for a room: its log rotates at the limit
  observe.writeConfig({ share: false });
  more(5);
  assert.deepEqual(files(), [[23, 24, 25, 26, 27], [28]]);
});

test('what is posted is the observation and nothing else of the machine: no path on its disk, no spool text, no developer inside it', async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const m = machine('alim', { room });
  // what the machine holds beside its log: a spooled prompt, and a batch that died
  observe.writeSpool(observe.spoolEvent('prompt', { session_id: 'session-9', cwd: m.top, prompt: 'SPOOLED PROMPT TEXT' }));
  observe.writeDead({ session: 'session-9', events: [{ kind: 'prompt', text: 'DEAD BATCH TEXT' }] }, 'bad reply twice');
  const outside = path.join(m.home, 'notes', 'plan.md');
  const obs = log(
    m,
    found('parse<T> reads "strict" twice', NOW - HOUR, {
      facts: [`It is run from ${m.top}/scripts/gen.mjs and reads ${outside}.`, `The checkout is ${m.top}.`],
      files: ['src/tags.ts', outside, path.join(m.top, 'src', 'gen.ts'), '../elsewhere.ts', './src/tags.ts'],
      blobs: { 'src/tags.ts': 'a'.repeat(40), [outside]: 'b'.repeat(40) },
      evidence: { kind: 'command', ref: `node ${m.top}/scripts/gen.mjs --strict` },
      // what a log line was never meant to hold, and must not carry out if it does
      developer: 'planted-developer',
      prompt: 'planted prompt',
      tool_input: { command: 'planted command' },
      top: m.top,
      transcript_path: path.join(m.home, 'planted-transcript.jsonl'),
      seen: 3,
    })
  );

  assert.deepEqual(await round(m), [{ key: REPO_KEY, pulled: 0, pushed: 1, refused: 0, error: null }]);
  const [post] = room.posts();
  for (const planted of [m.top, m.home, 'SPOOLED PROMPT TEXT', 'DEAD BATCH TEXT', 'planted', 'transcript']) {
    assert.ok(!post.raw.includes(planted), `${planted} is not in what was sent`);
  }
  assert.deepEqual(Object.keys(post.body).sort(), ['developer', 'entries', 'repo']);
  const [entry] = post.body.entries;
  assert.deepEqual(Object.keys(entry), ['op', 'obs']);
  // the cleaned observation of the step's contract, field for field
  assert.deepEqual(entry.obs, {
    id: obs.id,
    ts: obs.ts,
    session_id: 'session-1',
    agent: 'claude-code',
    branch: 'main',
    checkout_id: 'co_0123456789abcdefghijkl',
    head: 'abc1234',
    type: 'cause',
    // as the room keeps a teammate's text: nothing shaped like a tag, one kind of quote
    title: "parseT reads 'strict' twice",
    facts: ['It is run from scripts/gen.mjs and reads ~/notes/plan.md.', 'The checkout is ..'],
    files: ['src/tags.ts', 'src/gen.ts'],
    blobs: { 'src/tags.ts': 'a'.repeat(40) },
    symbols: [],
    evidence: { kind: 'command', ref: 'node scripts/gen.mjs --strict' },
    batch: { from: obs.ts - 1000, to: obs.ts },
    model: 'claude-haiku-5-5',
  });
});

test("a teammate's finding is in the next session's index under their name, and a finding both machines made is there once", async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const a = machine('alim', { room });
  const b = machine('bob', { room });
  log(a, found('getLatestTag misses tags on unmerged branches', NOW - 3 * HOUR));
  log(a, found('schema.json is written by scripts/gen.mjs', NOW - 2 * HOUR));
  await round(a, NOW - 100 * MINUTE);

  // bob found one of them too, in his own words' spelling, and one of his own
  log(b, found('Schema.json is written by scripts/gen.mjs!', NOW - HOUR));
  log(b, found('the release job reads tags from main only', NOW - 30 * MINUTE));
  assert.equal(observe.recallIndex(REPO_KEY, { branch: 'main', now: NOW }).split('\n')[0], observe.RECALL_HEADER, 'before his round, his own alone');

  assert.deepEqual(await round(b), [{ key: REPO_KEY, pulled: 2, pushed: 2, refused: 0, error: null }]);
  const expected = [
    observe.TEAM_RECALL_HEADER,
    '- [cause] schema.json is written by scripts/gen.mjs: schema.json is written by scripts/gen.mjs, in detail. (alim, claude-code, 2 h ago, also found by 1 other)',
    '- [cause] the release job reads tags from main only: the release job reads tags from main only, in detail. (this machine, claude-code, 30 min ago)',
    '- [cause] getLatestTag misses tags on unmerged branches: getLatestTag misses tags on unmerged branches, in detail. (alim, claude-code, 3 h ago)',
  ];
  assert.deepEqual(observe.recallIndex(REPO_KEY, { branch: 'main', now: NOW }).split('\n'), expected);

  // after the next round the room has counted him and heard the finding an hour ago, from him: it is
  // still there once, still alim's first and still two people's
  await round(b, NOW + 30_000);
  assert.equal(observe.readTeam(REPO_KEY).observations.find((o) => /schema/i.test(o.title)).people, 2);
  const counted = expected.map((line) => line.replace('2 h ago, also found', '60 min ago, also found'));
  assert.deepEqual(observe.recallIndex(REPO_KEY, { branch: 'main', now: NOW }).split('\n'), counted);

  // the session itself: the hook reads the files the round left, and asks no server
  const guard = pathToFileURL(fileURLToPath(new URL('../../cli/test/fixtures/no-network.mjs', import.meta.url))).href;
  const env = { AGENTMASH_HOME: b.home, HOME: b.home, NODE_OPTIONS: [baseEnv.NODE_OPTIONS, `--import=${guard}`].filter(Boolean).join(' ') };
  const before = room.requests.length;
  const ran = await runHook('observe_recall.mjs', { session_id: 'session-2', cwd: b.top, hook_event_name: 'SessionStart', source: 'startup' }, env, ['session_start']);
  assert.deepEqual([ran.code, ran.stderr], [0, '']);
  const lines = JSON.parse(ran.stdout).hookSpecificOutput.additionalContext.split('\n');
  assert.equal(lines[0], observe.TEAM_RECALL_HEADER);
  assert.match(lines[1], /^- \[cause\] schema\.json is written by scripts\/gen\.mjs: .+ \(alim, claude-code, \d+ min ago, also found by 1 other\)$/);
  assert.equal(lines.filter((line) => /schema\.json is written/i.test(line)).length, 1);
  assert.ok(lines.some((line) => /getLatestTag misses tags on unmerged branches: .+ \(alim, claude-code, 3 h ago\)$/.test(line)));
  assert.equal(room.requests.length, before, 'the room heard nothing from the hook');

  // and on alim's machine: bob's own under bob's name, the shared one once, his own as his
  await round(a, NOW + 60_000);
  assert.deepEqual(observe.recallIndex(REPO_KEY, { branch: 'main', now: NOW }).split('\n'), [
    observe.TEAM_RECALL_HEADER,
    '- [cause] schema.json is written by scripts/gen.mjs: schema.json is written by scripts/gen.mjs, in detail. (alim, claude-code, 60 min ago, also found by 1 other)',
    '- [cause] the release job reads tags from main only: the release job reads tags from main only, in detail. (bob, claude-code, 30 min ago)',
    '- [cause] getLatestTag misses tags on unmerged branches: getLatestTag misses tags on unmerged branches, in detail. (this machine, claude-code, 3 h ago)',
  ]);
});

test('a machine that reports through its sign-in syncs with the room its repository is connected to', async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const m = machine('bob', { signedIn: room });
  const obs = log(m, found('the release job reads tags from main', NOW - HOUR));

  assert.deepEqual(await round(m), [{ key: REPO_KEY, pulled: 0, pushed: 1, refused: 0, error: null }]);
  assert.deepEqual(asked(room), ['GET /api/lookup', 'GET /observations', 'POST /observations']);
  assert.equal(room.requests[0].query.repo, 'acme/app');
  for (const request of room.requests.slice(1)) assert.deepEqual([request.room, request.user], [REF, USER_TOKEN], 'the room by its ref, signed with the sign-in');
  assert.equal(room.posts()[0].body.developer, 'bob');
  assert.ok(room.entries.has(`o:add:${obs.id}`));
});

test('a server from before observations is a room that does not share; a room that cannot be reached and a push the room turns away each leave the cursor and say why', async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const m = machine('alim', { room });
  log(m, found('getLatestTag misses tags on unmerged branches', NOW - HOUR));

  // an older server: no such route. Nothing is shared with it, and that is no error to show every round
  room.missing = true;
  assert.deepEqual(await round(m), [{ key: REPO_KEY, pulled: 0, pushed: 0, refused: 0, error: null }]);
  assert.deepEqual([observe.readTeam(REPO_KEY).sharing, observe.readTeam(REPO_KEY).observations], [false, []]);
  assert.deepEqual([sync.syncStatus()[0].sharing, sync.syncStatus()[0].error, sync.syncStatus()[0].sent], [false, null, 0]);
  assert.equal(room.posts().length, 0, 'and nothing is pushed to a server that has nowhere to keep it');
  room.missing = false;

  // a key that names nobody: the push is turned away, and not tried again at once
  room.fail = { status: 403, json: { code: 'author_required' } };
  assert.deepEqual(await round(m, NOW + 30_000), [{ key: REPO_KEY, pulled: 0, pushed: 0, refused: 0, error: 'push: 403 author_required' }]);
  assert.equal(room.posts().length, 1);
  assert.deepEqual(await round(m, NOW + 60_000), [{ key: REPO_KEY, pulled: 0, pushed: 0, refused: 0, error: 'push: 403 author_required' }]);
  assert.equal(room.posts().length, 1, 'the next round pulls and does not push');
  assert.equal(asked(room).filter((line) => line === 'GET /observations').length, 3);
  assert.deepEqual([sync.syncStatus()[0].sent, sync.syncStatus()[0].pending], [0, 1]);
  assert.deepEqual(sync.syncStatus()[0].error, { at: NOW + 30_000, what: 'push: 403 author_required' });
  // ten minutes on it is tried again, and by then the machine has signed in
  room.fail = null;
  assert.deepEqual(await round(m, NOW + 11 * MINUTE), [{ key: REPO_KEY, pulled: 0, pushed: 1, refused: 0, error: null }]);
  assert.equal(sync.syncStatus()[0].error, null);

  // a room that stops sharing between the pull and the push is believed: nothing of the team's is shown either
  log(m, found('schema.json is written by scripts/gen.mjs', NOW - 10 * MINUTE));
  room.fail = { status: 403, json: { code: 'sharing_off' } };
  assert.deepEqual(await round(m, NOW + 12 * MINUTE), [{ key: REPO_KEY, pulled: 0, pushed: 0, refused: 0, error: null }]);
  assert.deepEqual([observe.readSyncState(REPO_KEY).sharing, observe.readSyncState(REPO_KEY).sent], [false, 1]);
  assert.deepEqual([observe.readTeam(REPO_KEY).sharing, observe.readTeam(REPO_KEY).observations], [false, []]);
  room.fail = null;

  // no server at all: a port nothing listens on
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  fs.writeFileSync(path.join(m.top, '.claude', 'agentmash', 'config.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, room: KEY }));
  const [line] = await round(m, NOW + 13 * MINUTE);
  assert.match(line.error, /^pull: \w+/);
  assert.equal(observe.readSyncState(REPO_KEY).sent, 1, 'the cursor is where it was');

  // a checkout that is gone, and one with no room, are not asked about at all
  fs.rmSync(path.join(m.top, '.claude'), { recursive: true });
  assert.deepEqual(await round(m, NOW + 14 * MINUTE), []);
  fs.rmSync(m.top, { recursive: true });
  assert.deepEqual(await round(m, NOW + 15 * MINUTE), []);
  assert.equal(sync.syncStatus()[0].top, m.top, 'status still says where it was');
});

test('a repository nobody is at work in is asked about every ten minutes, not every round', async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const m = machine('alim', { room });
  // the last batch here was a quarter of an hour ago
  observe.updateSyncState(REPO_KEY, { noted_at: NOW - 15 * MINUTE });

  assert.equal((await roundAsItIs(m)).length, 1, 'never asked: asked now');
  assert.deepEqual(await roundAsItIs(m, NOW + 30_000), [], 'asked half a minute ago, and nothing waits to be sent');
  assert.equal(asked(room).length, 1);
  // something to send is a reason to ask
  m.use();
  log(m, found('getLatestTag misses tags on unmerged branches', NOW - MINUTE));
  assert.deepEqual((await roundAsItIs(m, NOW + 60_000)).map((line) => line.pushed), [1]);
  // and so is a batch from it
  assert.deepEqual(await roundAsItIs(m, NOW + 90_000), []);
  sync.noteCheckout(REPO_KEY, m.top, NOW + 100_000);
  assert.equal((await roundAsItIs(m, NOW + 120_000)).length, 1);
  assert.equal((await roundAsItIs(m, NOW + 12 * MINUTE)).length, 1, 'quiet again, and ten minutes since it was asked');
});

test("a finding of the room's that a session here found false is told to the room once, as its id, the time and the commit, with nothing of why; one of a finding the room does not have is not sent, and a machine that keeps what it finds to itself sends none", async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const a = machine('alim', { room });
  const theirs = log(a, found('the release job reads tags from main only', NOW - 3 * HOUR));
  await round(a, NOW - 2 * HOUR);

  const b = machine('bob', { room });
  const old = log(b, found('the lock file is rewritten on install', SINCE - 5000));
  const mine = log(b, found('schema.json is written by scripts/gen.mjs', NOW - HOUR));
  assert.deepEqual(await round(b, NOW - 50 * MINUTE), [{ key: REPO_KEY, pulled: 1, pushed: 1, refused: 0, error: null }]);
  assert.match(observe.recallIndex(REPO_KEY, { branch: 'main', now: NOW }), /the release job reads tags from main only/);

  // bob's sessions were told four findings and found each false: alim's, his own that the room has, his own from
  // before the room shared, and one that neither his log nor the room's file names
  const at = NOW - 10 * MINUTE;
  const why = 'The agent read the job: every branch is tagged now (WHY-STAYS-HOME).';
  for (const id of [theirs.id, mine.id, old.id, 'o_nowhere00001']) observe.refuteObservation(REPO_KEY, id, { because: why, head: 'abc1234def', now: at });
  assert.deepEqual(rawLog(b).map((line) => `${line.n} ${line.op}`), ['1 add', '2 add', '3 refute', '4 refute', '5 refute', '6 refute']);
  assert.equal(rawLog(b)[2].because, why, 'why is in the log of the machine that saw it');
  // on his machine at once, before the room has heard anything
  assert.equal(observe.recallIndex(REPO_KEY, { branch: 'main', now: NOW }), '');
  assert.equal(sync.syncStatus()[0].pending, 2);

  assert.deepEqual(await round(b), [{ key: REPO_KEY, pulled: 2, pushed: 2, refused: 0, error: null }]);
  const post = room.posts().at(-1);
  assert.deepEqual(post.body.entries, [
    { op: 'refute', id: theirs.id, ts: at, head: 'abc1234def' },
    { op: 'refute', id: mine.id, ts: at, head: 'abc1234def' },
  ]);
  for (const kept of ['WHY-STAYS-HOME', 'because', 'every branch']) assert.ok(!post.raw.includes(kept), `${kept} is not in what was sent`);
  const everything = room.posts().map((sent) => sent.raw).join('\n');
  assert.ok(!everything.includes(old.id) && !everything.includes('o_nowhere00001'), 'the room is told nothing of a finding it was never sent');
  assert.equal(sync.syncStatus()[0].pending, 0);

  // once: the next round has nothing to say
  assert.deepEqual(await round(b, NOW + 30_000), [{ key: REPO_KEY, pulled: 2, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 3);
  // the room counts who found each false, and no machine that reads it tells them: not the one that made it either
  assert.deepEqual(observe.readTeam(REPO_KEY).observations.map((o) => [o.title, o.refuted]).sort(), [[mine.title, 1], [theirs.title, 1]]);
  await round(a, NOW + 60_000);
  assert.equal(observe.recallIndex(REPO_KEY, { branch: 'main', now: NOW + 60_000 }), '', "alim's machine tells neither, its own among them");

  // alim's agent finds his again: the room counts nobody against it, and bob's machine is told it once more
  assert.deepEqual(observe.addObservation(REPO_KEY, found(theirs.title, NOW + 70_000), NOW + 70_000), { merged: theirs.id });
  await round(a, NOW + 90_000);
  assert.deepEqual(await round(b, NOW + 120_000), [{ key: REPO_KEY, pulled: 2, pushed: 0, refused: 0, error: null }]);
  assert.deepEqual(observe.readTeam(REPO_KEY).observations.map((o) => [o.title, o.refuted]).sort(), [[mine.title, 1], [theirs.title, 0]]);
  const again = observe.recallIndex(REPO_KEY, { branch: 'main', now: NOW + 120_000 });
  assert.ok(again.includes(theirs.title) && !again.includes(mine.title), again);

  // a machine that keeps what it finds to itself says none of it: what a session found false is something found
  observe.writeConfig({ share: false });
  observe.refuteObservation(REPO_KEY, theirs.id, { because: why, head: 'abc1234def', now: NOW + 130_000 });
  assert.deepEqual(await round(b, NOW + 150_000), [{ key: REPO_KEY, pulled: 2, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 4, "alim's seen again, and nothing of bob's since");
  assert.equal(observe.recallIndex(REPO_KEY, { branch: 'main', now: NOW + 150_000 }), '', 'his own machine holds to it all the same');
  observe.writeConfig({ share: true });
  assert.deepEqual(await round(b, NOW + 180_000), [{ key: REPO_KEY, pulled: 2, pushed: 1, refused: 0, error: null }]);
  assert.deepEqual(room.posts().at(-1).body.entries, [{ op: 'refute', id: theirs.id, ts: NOW + 130_000, head: 'abc1234def' }]);
});

test('a refutation the room will not take, of a finding it refused or no longer holds, is counted with its reason and not sent again', async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const m = machine('bob', { room });
  const kept = log(m, found('the release job reads tags from main', NOW - HOUR));
  const turned = log(m, found('schema.json is written by scripts/gen.mjs', NOW - 50 * MINUTE));
  room.refuse = (entry) => (entry.obs?.id === turned.id ? 'orders' : null);
  assert.deepEqual(await round(m), [{ key: REPO_KEY, pulled: 0, pushed: 1, refused: 1, why: { orders: 1 }, error: null }]);

  // the machine sent both, so as far as its log says the room has both
  for (const id of [kept.id, turned.id]) observe.refuteObservation(REPO_KEY, id, { because: 'It saw otherwise.', head: null, now: NOW + 1000 });
  assert.deepEqual(await round(m, NOW + 30_000), [{ key: REPO_KEY, pulled: 1, pushed: 1, refused: 1, why: { no_finding: 1 }, error: null }]);
  assert.deepEqual(room.posts().at(-1).body.entries, [
    { op: 'refute', id: kept.id, ts: NOW + 1000, head: null },
    { op: 'refute', id: turned.id, ts: NOW + 1000, head: null },
  ]);
  assert.equal(observe.readSyncState(REPO_KEY).sent, 4, 'the cursor passed the one that was refused');
  assert.deepEqual(await round(m, NOW + 60_000), [{ key: REPO_KEY, pulled: 1, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 2);
  assert.deepEqual(room.findings().map((finding) => [finding.title, finding.refuted]), [[kept.title, 1]]);
});

test("what came of telling a session one of the room's findings is told to the room once, as a told and a use entry that are the finding's id and the time and nothing of the session or of what it did; of a finding the room does not have neither is sent, nor of one the room has heard found again since, and a machine that keeps what it finds to itself sends none", async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const a = machine('alim', { room });
  const theirs = log(a, found('the release job reads tags from main only', NOW - 3 * HOUR));
  await round(a, NOW - 2 * HOUR);

  const b = machine('bob', { room });
  const old = log(b, found('the lock file is rewritten on install', SINCE - 5000));
  const mine = log(b, found('schema.json is written by scripts/gen.mjs', NOW - HOUR));
  assert.deepEqual(await round(b, NOW - 50 * MINUTE), [{ key: REPO_KEY, pulled: 1, pushed: 1, refused: 0, error: null }]);

  // one of bob's sessions was told four findings: alim's, his own that the room has, his own from before the room
  // shared, and one that neither his log nor the room's file names. A second was told alim's, and acted on three.
  const at = NOW - 10 * MINUTE;
  const how = 'The agent cut the tag on main (HOW-STAYS-HOME).';
  for (const id of [theirs.id, mine.id, old.id, 'o_nowhere00001']) observe.noteTold(REPO_KEY, id, { session: 'session-told-1', now: at });
  observe.noteTold(REPO_KEY, theirs.id, { session: 'session-told-2', now: at + 1 });
  for (const id of [theirs.id, old.id, 'o_nowhere00001']) observe.noteUsed(REPO_KEY, id, { session: 'session-told-2', how, now: at + 2 });
  assert.deepEqual(rawLog(b).map((line) => `${line.n} ${line.op}`), ['1 add', '2 add', '3 told', '4 told', '5 told', '6 told', '7 told', '8 use', '9 use', '10 use']);
  assert.deepEqual([rawLog(b)[2].session, rawLog(b)[7].session, rawLog(b)[7].how], ['session-told-1', 'session-told-2', how], 'which session and what it did are in the log of the machine that saw it');
  assert.equal(sync.syncStatus()[0].pending, 4);

  assert.deepEqual(await round(b), [{ key: REPO_KEY, pulled: 2, pushed: 4, refused: 0, error: null }]);
  const post = room.posts().at(-1);
  assert.deepEqual(post.body.entries, [
    { op: 'told', id: theirs.id, ts: at },
    { op: 'told', id: mine.id, ts: at },
    { op: 'told', id: theirs.id, ts: at + 1 },
    { op: 'use', id: theirs.id, ts: at + 2 },
  ]);
  for (const kept of ['HOW-STAYS-HOME', 'how', 'session', 'cut the tag']) assert.ok(!post.raw.includes(kept), `${kept} is not in what was sent`);
  const everything = room.posts().map((sent) => sent.raw).join('\n');
  assert.ok(!everything.includes(old.id) && !everything.includes('o_nowhere00001'), 'the room is told nothing of a finding it was never sent');
  assert.equal(sync.syncStatus()[0].pending, 0);

  // once: the next round has nothing to say
  assert.deepEqual(await round(b, NOW + 30_000), [{ key: REPO_KEY, pulled: 2, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 3);
  // the room counts them, and what a pull leaves on any machine is what its briefings are ordered by: alim's too
  const counted = () => observe.readTeam(REPO_KEY).observations.map((o) => [o.title, o.told, o.used]).sort();
  assert.deepEqual(counted(), [[mine.title, 1, 0], [theirs.title, 2, 1]]);
  await round(a, NOW + 60_000);
  assert.deepEqual(observe.briefCandidates(REPO_KEY, { now: NOW + 60_000 }).map((row) => [row.title, row.told, row.used]), [[theirs.title, 2, 1], [mine.title, 1, 0]]);

  // alim's agent finds his again: the room counts from nothing, and a telling made before that is of what the finding was
  assert.deepEqual(observe.addObservation(REPO_KEY, found(theirs.title, NOW + 70_000), NOW + 70_000), { merged: theirs.id });
  await round(a, NOW + 90_000);
  assert.deepEqual(await round(b, NOW + 120_000), [{ key: REPO_KEY, pulled: 2, pushed: 0, refused: 0, error: null }]);
  assert.deepEqual(counted(), [[mine.title, 1, 0], [theirs.title, 0, 0]]);
  observe.noteTold(REPO_KEY, theirs.id, { session: 'session-told-3', now: NOW + 60_000 });
  assert.equal(sync.syncStatus()[0].pending, 0);

  // a machine that keeps what it finds to itself says none of it: what a session did with a finding is something found
  observe.writeConfig({ share: false });
  observe.noteTold(REPO_KEY, theirs.id, { session: 'session-told-4', now: NOW + 130_000 });
  assert.deepEqual(await round(b, NOW + 150_000), [{ key: REPO_KEY, pulled: 2, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 4, "alim's seen again, and nothing of bob's since");
  observe.writeConfig({ share: true });
  assert.deepEqual(await round(b, NOW + 180_000), [{ key: REPO_KEY, pulled: 2, pushed: 1, refused: 0, error: null }]);
  assert.deepEqual(room.posts().at(-1).body.entries, [{ op: 'told', id: theirs.id, ts: NOW + 130_000 }]);
  assert.deepEqual(room.findings().map((finding) => [finding.title, finding.told, finding.used]).sort(), [[mine.title, 1, 0], [theirs.title, 1, 0]]);
});

test('a telling the room will not take, of a finding it refused, is counted with its reason and not sent again', async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const m = machine('bob', { room });
  const kept = log(m, found('the release job reads tags from main', NOW - HOUR));
  const turned = log(m, found('schema.json is written by scripts/gen.mjs', NOW - 50 * MINUTE));
  room.refuse = (entry) => (entry.obs?.id === turned.id ? 'orders' : null);
  assert.deepEqual(await round(m), [{ key: REPO_KEY, pulled: 0, pushed: 1, refused: 1, why: { orders: 1 }, error: null }]);

  // the machine sent both, so as far as its log says the room has both
  for (const id of [kept.id, turned.id]) observe.noteTold(REPO_KEY, id, { session: 'session-1', now: NOW + 1000 });
  observe.noteUsed(REPO_KEY, turned.id, { session: 'session-1', how: 'It left schema.json alone.', now: NOW + 2000 });
  assert.deepEqual(await round(m, NOW + 30_000), [{ key: REPO_KEY, pulled: 1, pushed: 1, refused: 2, why: { no_finding: 2 }, error: null }]);
  assert.deepEqual(room.posts().at(-1).body.entries, [
    { op: 'told', id: kept.id, ts: NOW + 1000 },
    { op: 'told', id: turned.id, ts: NOW + 1000 },
    { op: 'use', id: turned.id, ts: NOW + 2000 },
  ]);
  assert.equal(observe.readSyncState(REPO_KEY).sent, 5, 'the cursor passed the ones that were refused');
  assert.deepEqual(await round(m, NOW + 60_000), [{ key: REPO_KEY, pulled: 1, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 2);
  assert.deepEqual(room.findings().map((finding) => [finding.title, finding.told, finding.used]), [[kept.title, 1, 0]]);
});

test("a finding of the room's that a session here found again by itself is told to the room once, as a seen of its id and the time and nothing else, and the room counts the developer among the people who found it; of a finding the room does not have none is sent, none to a room that does not share, and a machine that keeps what it finds to itself sends none", async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const a = machine('alim', { room });
  const theirs = log(a, found('the release job reads tags from main only', NOW - 3 * HOUR));
  await round(a, NOW - 2 * HOUR);

  const b = machine('bob', { room });
  const mine = log(b, found('schema.json is written by scripts/gen.mjs', NOW - HOUR));
  assert.deepEqual(await round(b, NOW - 50 * MINUTE), [{ key: REPO_KEY, pulled: 1, pushed: 1, refused: 0, error: null }]);
  assert.deepEqual(room.findings().map((finding) => [finding.title, finding.people]).sort(), [[mine.title, 1], [theirs.title, 1]]);

  // bob's observer named two findings as the ones a batch of his would only repeat: alim's, and one that neither his
  // log nor the room's file names. His own it is never written for.
  const at = NOW - 10 * MINUTE;
  assert.equal(observe.noteSeenAgain(REPO_KEY, theirs.id, { now: at }), true);
  assert.equal(observe.noteSeenAgain(REPO_KEY, 'o_nowhere00001', { now: at }), true);
  assert.equal(observe.noteSeenAgain(REPO_KEY, mine.id, { now: at }), false);
  assert.deepEqual(rawLog(b).slice(1), [
    { n: 2, op: 'seen', id: theirs.id, ts: at },
    { n: 3, op: 'seen', id: 'o_nowhere00001', ts: at },
  ], 'the line is the id and the time: nothing of the batch or of its session is in the log to be sent');
  assert.equal(sync.syncStatus()[0].pending, 1);

  assert.deepEqual(await round(b), [{ key: REPO_KEY, pulled: 2, pushed: 1, refused: 0, error: null }]);
  const post = room.posts().at(-1);
  assert.deepEqual(post.body, { developer: 'bob', repo: 'acme/app', entries: [{ op: 'seen', id: theirs.id, ts: at }] }, 'the entry a seen of his own finding is, and nothing beside it');
  assert.ok(!room.posts().map((sent) => sent.raw).join('\n').includes('o_nowhere00001'), 'the room is told nothing of a finding it does not have');
  assert.equal(sync.syncStatus()[0].pending, 0);
  // once: the next round has nothing to say
  assert.deepEqual(await round(b, NOW + 30_000), [{ key: REPO_KEY, pulled: 2, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 3);

  // the room counts bob among the people who found it, in alim's words still, and no finding of bob's came of it
  assert.deepEqual(observe.readTeam(REPO_KEY).observations.map((o) => [o.title, o.developer, o.people]).sort(), [[mine.title, 'bob', 1], [theirs.title, 'alim', 2]]);
  assert.deepEqual(observe.readObservations(REPO_KEY).map((obs) => obs.id), [mine.id]);
  await round(a, NOW + 60_000);
  assert.match(observe.recallIndex(REPO_KEY, { branch: 'main', now: NOW + 60_000 }), /the release job reads tags from main only: .+ \(alim, claude-code, .+, also found by 1 other\)/, "and alim's machine says somebody else found it too");

  // a machine that keeps what it finds to itself says none of it: that a session found something again is something found
  b.use();
  observe.writeConfig({ share: false });
  // the same finding is said to be found again once a day (LIMITS.repeatEveryMs): a minute on nothing is written
  const DAY = observe.LIMITS.repeatEveryMs;
  assert.equal(observe.noteSeenAgain(REPO_KEY, theirs.id, { now: NOW + 70_000 }), false);
  assert.equal(observe.noteSeenAgain(REPO_KEY, theirs.id, { now: NOW + DAY + 70_000 }), true);
  assert.deepEqual(await round(b, NOW + DAY + 90_000), [{ key: REPO_KEY, pulled: 2, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 3);
  // as with everything the veto holds back, the line goes when it is lifted
  observe.writeConfig({ share: true });
  assert.deepEqual(await round(b, NOW + DAY + 120_000), [{ key: REPO_KEY, pulled: 2, pushed: 1, refused: 0, error: null }]);
  assert.deepEqual(room.posts().at(-1).body.entries, [{ op: 'seen', id: theirs.id, ts: NOW + DAY + 70_000 }]);
  assert.deepEqual(room.findings().map((finding) => [finding.title, finding.people]).sort(), [[mine.title, 1], [theirs.title, 2]], 'seen again by one who found it already: nobody new');

  // a room that stopped sharing is sent none: its file here names no finding, and the line stays in the log
  stopSharing(room);
  assert.equal(observe.noteSeenAgain(REPO_KEY, theirs.id, { now: NOW + 2 * DAY + 130_000 }), true);
  assert.deepEqual(await round(b, NOW + 2 * DAY + 150_000), [{ key: REPO_KEY, pulled: 0, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 4);
  assert.equal(rawLog(b).at(-1).ts, NOW + 2 * DAY + 130_000);
});

test("a finding of the room's that this machine voted stale is told to the room once, as its id, the time and the commit and nothing else; the room counts who voted and no machine that reads it tells the finding, its author's neither, until it is found again; of a finding the room does not have none is sent, and a machine that keeps what it finds to itself sends none", async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const a = machine('alim', { room });
  const theirs = log(a, found('the release job reads tags from main only', NOW - 3 * HOUR));
  const stays = log(a, found('a tag cut on a branch is not seen by the build', NOW - 3 * HOUR + 1000));
  await round(a, NOW - 2 * HOUR);

  const b = machine('bob', { room });
  const mine = log(b, found('schema.json is written by scripts/gen.mjs', NOW - HOUR));
  assert.deepEqual(await round(b, NOW - 50 * MINUTE), [{ key: REPO_KEY, pulled: 2, pushed: 1, refused: 0, error: null }]);
  const told = (now = NOW) => [theirs, stays, mine].filter((finding) => observe.recallIndex(REPO_KEY, { branch: 'main', now }).includes(finding.title)).map((finding) => finding.title);
  assert.deepEqual(told(), [theirs.title, stays.title, mine.title]);

  // bob's machine held alim's first finding to a checkout of the default branch and found the code changed under it;
  // and, as far as its log goes, one that neither his log nor the room's file names. His own it never votes against.
  const at = NOW - 10 * MINUTE;
  const head = 'a1b2c3d4'.repeat(5);
  assert.equal(observe.noteStale(REPO_KEY, theirs.id, { head, heard: theirs.ts, now: at }), true);
  assert.equal(observe.noteStale(REPO_KEY, 'o_nowhere00001', { head, now: at }), true);
  assert.equal(observe.noteStale(REPO_KEY, mine.id, { head, now: at }), false);
  assert.deepEqual(rawLog(b).slice(1), [
    { n: 2, op: 'stale', id: theirs.id, ts: at, head },
    { n: 3, op: 'stale', id: 'o_nowhere00001', ts: at, head },
  ], 'the line is the id, the time and the commit: no path, no name and no reason is in the log to be sent');
  // on his machine at once, before the room has heard anything
  assert.deepEqual(told(), [stays.title, mine.title]);
  assert.equal(sync.syncStatus()[0].pending, 1);

  assert.deepEqual(await round(b), [{ key: REPO_KEY, pulled: 3, pushed: 1, refused: 0, error: null }]);
  const post = room.posts().at(-1);
  assert.deepEqual(post.body, { developer: 'bob', repo: 'acme/app', entries: [{ op: 'stale', id: theirs.id, ts: at, head }] }, 'the entry is the finding\'s id, the time and the commit, and nothing beside them');
  for (const kept of ['src/tags.ts', 'the release job', b.top, b.home]) assert.ok(!post.raw.includes(kept), `${kept} is not in what was sent`);
  assert.ok(!room.posts().map((sent) => sent.raw).join('\n').includes('o_nowhere00001'), 'the room is told nothing of a finding it does not have');
  assert.equal(sync.syncStatus()[0].pending, 0);
  // once: the next round has nothing to say
  assert.deepEqual(await round(b, NOW + 30_000), [{ key: REPO_KEY, pulled: 3, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 3);

  // the room counts who voted, apart from who found it false, and gives the count: no machine that reads it tells the
  // finding, and the one that made it does not tell it from its own log either
  const counted = () => observe.readTeam(REPO_KEY).observations.map((o) => [o.title, o.stale, o.refuted]).sort();
  assert.deepEqual(counted(), [[stays.title, 0, 0], [mine.title, 0, 0], [theirs.title, 1, 0]]);
  assert.deepEqual(told(NOW + 30_000), [stays.title, mine.title]);
  await round(a, NOW + 60_000);
  assert.deepEqual(told(NOW + 60_000), [stays.title, mine.title], "alim's machine tells its own finding to nobody either");
  assert.equal(observe.recallForFile(REPO_KEY, 'src/tags.ts', { now: NOW + 60_000 }).includes(theirs.title), false);
  assert.deepEqual(observe.readObservations(REPO_KEY).map((obs) => obs.id).sort(), [theirs.id, stays.id].sort(), 'it is in his log as it was');

  // alim's agent finds his again: the room counts nobody against it, and bob's machine tells it once more
  assert.deepEqual(observe.addObservation(REPO_KEY, found(theirs.title, NOW + 70_000), NOW + 70_000), { merged: theirs.id });
  await round(a, NOW + 90_000);
  assert.deepEqual(await round(b, NOW + 120_000), [{ key: REPO_KEY, pulled: 3, pushed: 0, refused: 0, error: null }]);
  assert.deepEqual(counted(), [[stays.title, 0, 0], [mine.title, 0, 0], [theirs.title, 0, 0]]);
  assert.deepEqual(told(NOW + 120_000), [theirs.title, stays.title, mine.title], 'the vote was of the finding as it was before');

  // a machine that keeps what it finds to itself says none of it (and casts no vote: observe.voteStale): a line its log
  // holds all the same stays there, and goes when the veto is lifted, as everything the veto holds back does
  observe.writeConfig({ share: false });
  assert.equal(observe.noteStale(REPO_KEY, theirs.id, { head, heard: NOW + 70_000, now: NOW + 130_000 }), true);
  assert.deepEqual(await round(b, NOW + 150_000), [{ key: REPO_KEY, pulled: 3, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 4, "alim's seen again, and nothing of bob's since");
  observe.writeConfig({ share: true });
  assert.deepEqual(await round(b, NOW + 180_000), [{ key: REPO_KEY, pulled: 3, pushed: 1, refused: 0, error: null }]);
  assert.deepEqual(room.posts().at(-1).body.entries, [{ op: 'stale', id: theirs.id, ts: NOW + 130_000, head }]);
  assert.deepEqual(room.findings().map((finding) => [finding.title, finding.stale]).sort(), [[stays.title, 0], [mine.title, 0], [theirs.title, 1]]);

  // a room that stopped sharing is sent none: its file here names no finding, and the line stays in the log
  stopSharing(room);
  assert.equal(observe.noteStale(REPO_KEY, stays.id, { head, now: NOW + 190_000 }), true);
  assert.deepEqual(await round(b, NOW + 210_000), [{ key: REPO_KEY, pulled: 0, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 5);
});

test('a stale vote the room will not take, from a server from before there was one or of a finding it no longer holds, is counted with its reason and not sent again', async (t) => {
  const room = await roomFor(t, { sharing: true, shareSince: SINCE });
  const a = machine('alim', { room });
  const theirs = log(a, found('the release job reads tags from main', NOW - 2 * HOUR));
  const other = log(a, found('schema.json is written by scripts/gen.mjs', NOW - 2 * HOUR + 1000));
  await round(a, NOW - HOUR);
  const b = machine('bob', { room });
  assert.deepEqual(await round(b, NOW - 30 * MINUTE), [{ key: REPO_KEY, pulled: 2, pushed: 0, refused: 0, error: null }]);

  const head = 'a1b2c3d4'.repeat(5);
  for (const id of [theirs.id, other.id]) assert.equal(observe.noteStale(REPO_KEY, id, { head, now: NOW + 1000 }), true);
  // the room reads no such entry, as a server from before the vote reads none, and has let go of the other finding meanwhile
  room.refuse = (entry) => (entry.op === 'stale' ? (entry.id === theirs.id ? 'shape' : 'no_finding') : null);
  assert.deepEqual(await round(b, NOW + 30_000), [{ key: REPO_KEY, pulled: 2, pushed: 0, refused: 2, why: { shape: 1, no_finding: 1 }, error: null }]);
  assert.deepEqual(room.posts().at(-1).body.entries, [
    { op: 'stale', id: theirs.id, ts: NOW + 1000, head },
    { op: 'stale', id: other.id, ts: NOW + 1000, head },
  ]);
  assert.equal(observe.readSyncState(REPO_KEY).sent, 2, 'the cursor passed the ones that were refused');
  assert.deepEqual(await round(b, NOW + 60_000), [{ key: REPO_KEY, pulled: 2, pushed: 0, refused: 0, error: null }]);
  assert.equal(room.posts().length, 2);
  assert.deepEqual(room.findings().map((finding) => finding.stale), [0, 0], 'the room counts nobody');
  // a room that takes it counts it, and a line with no commit to be true of, which no machine of today writes, is not sent at all
  room.refuse = () => null;
  assert.equal(observe.noteStale(REPO_KEY, theirs.id, { head, heard: NOW + 2000, now: NOW + 70_000 }), true);
  const line = rawLog(b).at(-1);
  fs.appendFileSync(path.join(b.home, '.agentmash', 'observe', 'log', `${REPO_KEY}.jsonl`), `${JSON.stringify({ ...line, n: line.n + 1, ts: line.ts + 1, head: undefined })}\n`);
  assert.deepEqual(await round(b, NOW + 90_000), [{ key: REPO_KEY, pulled: 2, pushed: 1, refused: 0, error: null }], 'a line with no commit is not sent at all');
  assert.deepEqual(room.findings().map((finding) => [finding.title, finding.stale]).sort(), [[theirs.title, 1], [other.title, 0]].sort());
});
