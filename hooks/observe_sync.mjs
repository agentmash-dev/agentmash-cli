// AgentMash observe sync: what this machine's agents found goes to the room
// that asked for it, and what the team found comes back
// (docs/plans/enrichment-step2-room.md, "Sync" and "Team recall").
//
// This is the only observe file that talks to a server. The worker runs a
// round as soon as a batch has logged a finding, every thirty seconds while
// it is alive, and once before it exits (observe_worker.mjs). No hook loads this file: what a round leaves is plain
// files, and the hooks read those (observe.mjs, "what syncing keeps").
//
// A round, for each repository this machine has observed in:
//
// - Pull first. GET /observations says whether the room shares, since when,
//   and what its team found. The answer is kept as the team cache; with
//   sharing off it is a cache that says so and holds nothing.
// - Then push, only where the room shares and this machine has not said no
//   (observe.vetoesSharing): the lines of the local log after the cursor
//   that were made since the room began to share, oldest first. The cursor
//   moves when the room answers 200 and at no other time, so an outage
//   loses no line, and one sent twice is kept once by the room. A finding of
//   the room's that a session here was told and found false goes the same
//   way, as its id, the time and the checkout's commit (observe.pendingLines).
//   So does what came of telling one of the room's findings to a session
//   here, that it was told and that it acted on it: the finding's id and the
//   time of each, never which session and never what it did. And a finding of
//   the room's that a session here found again by itself, which the observer
//   named in place of writing it a second time (observe.noteSeenAgain): a
//   `seen` of the finding's id and the time, as of one of this machine's own,
//   and nothing of the batch it was found in. And a finding of the room's
//   that this machine held to a checkout of the default branch and found the
//   code changed under (observe.voteStale): a `stale` of the finding's id,
//   the time and that checkout's commit, and nothing of the code.
// - Where the room does not share, or this machine has said no, what was
//   shared before can still be taken back: of the lines after the cursor
//   the round sends the `forget`s and no others, and not a forget of a
//   finding the room was never sent. The cursor stays where it is, for the
//   lines that did not go, and a number beside it (`forgot`) keeps a forget
//   that went from going again every round.
//
// What leaves the machine is an observation's own fields and nothing else
// (wireObservation): never the spool, a batch's text, a prompt, a tool's
// input or output, a transcript, or where on this disk a checkout is.
//
// Nothing here throws, and nothing waits long: a request has four seconds
// and a round eight.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// See the note in post_tool_use.mjs: guarded access for post-v0 helpers.
import * as lib from './lib.mjs';
import * as observe from './observe.mjs';

const PUSH_ENTRIES = 50; // the room takes no more in one request
const PUSH_BYTES = 60 * 1024; // and no body over 64 KB
const PUSHES_A_ROUND = 3; // a backlog goes over several rounds, not in one burst
const REQUEST_MS = 4000;
const ROUND_MS = 8000;
// with less than this left of a round, a request would be cut short and read as the server's failure
const REQUEST_MIN_MS = 300;
// A push the room turned away for what this machine or its room is (a key
// that names nobody, another repository) is turned away again a moment
// later: it is tried again after this long, and the pull goes on meanwhile.
const HOLD_MS = 10 * 60_000;
// A repository no batch has come from for this long is asked about this
// often, and not every round: its team cache is read when a session starts
// there, and a session there makes it busy again.
const QUIET_MS = 10 * 60_000;
// how often a checkout that is at work is noted as being so
const NOTE_MS = 60_000;

// The longest of each field, as the room holds an observation to them
// (server/src/observations.ts): one that is longer is refused whole.
const CHARS = { session: 200, agent: 40, model: 60, ref: 200, path: 1024, branch: 200 };
/** A session's id, an agent's name, a model's: one word, as the room reads them. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/=+-]*$/;
const COMMIT_ID = /^[0-9a-f]{7,64}$/i;
const BLOB_ID = /^[0-9a-f]{40,64}$/i;
const EVIDENCE_KINDS = ['file', 'command', 'commit', 'none'];

const brief = (text, max = 120) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isString = (value) => typeof value === 'string';

function isFolder(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// ── which checkout a repository is in ───────────────────────────────────────

/**
 * Remembers that the repository filed under `key` is checked out at `top`,
 * and that it is at work now: the worker says so for each batch it observes.
 * A round finds the repository's room from that folder, as its hooks do.
 * Kept on this machine and never sent. Never throws.
 */
export function noteCheckout(key, top, now = Date.now()) {
  try {
    if (!key || typeof top !== 'string' || !path.isAbsolute(top)) return;
    const state = observe.readSyncState(key);
    if (state?.top === top && now - (state.noted_at ?? 0) < NOTE_MS) return;
    observe.updateSyncState(key, { top, noted_at: now });
  } catch {
    // a state that cannot be written costs this round's sync, and the next batch says it again
  }
}

/**
 * The room a checkout reports to, as its hooks find it: the one the
 * repository carries (lib.loadConfig), signed beside its key where this
 * machine is signed in, else the one the machine's sign-in is connected to
 * for this repository (lib.resolveConfig). Null where there is none, or
 * AgentMash is switched off.
 */
async function roomOf(top) {
  let config = lib.loadConfig(top);
  config = lib.withSignIn?.(config) ?? config;
  if (!config.room && !config.disabled && lib.resolveConfig && !lib.hasRepoInstall?.(top)) {
    config = await lib.resolveConfig(top, { global: true });
  }
  return config && !config.disabled && config.room ? config : null;
}

// ── what leaves the machine ─────────────────────────────────────────────────

/**
 * Text with nothing in it that says where on this machine it was written:
 * the checkout's own folder is taken off the front of a path under it, which
 * leaves the path every teammate has, and the home folder is `~`. Both as
 * they were given and as the disk spells them (a temp folder on a Mac is
 * reached through a link). Secrets are masked once more on the way out.
 */
function scrubber(top) {
  const spelled = (dir) => {
    const out = [dir];
    try {
      out.push(fs.realpathSync(dir));
    } catch {
      // not there any more: as given is all there is
    }
    return out;
  };
  // a folder that is the root of the disk, or nearly, names nothing worth hiding and is in every path
  const worth = (dir) => typeof dir === 'string' && dir.length > 3 && path.isAbsolute(dir);
  const folders = [
    ...spelled(top).filter(worth).map((dir) => [dir, '.']),
    ...spelled(process.env.AGENTMASH_HOME || '').filter(worth).map((dir) => [dir, '~']),
    ...spelled(os.homedir()).filter(worth).map((dir) => [dir, '~']),
  ].sort((a, b) => b[0].length - a[0].length);
  // `<top>/src/a.ts` is `src/a.ts` and the checkout itself `.`; `<home>/notes` is `~/notes`.
  // A folder whose name only starts the same (`<top>-old`) is another folder, and is left for the home's turn.
  const swap = (text, dir, as) => {
    let out = '';
    let from = 0;
    for (let at = text.indexOf(dir); at !== -1; at = text.indexOf(dir, from)) {
      const end = at + dir.length;
      const next = text[end] ?? '';
      if (/^(?:[\w-]|\.\w)/.test(text.slice(end, end + 2))) out += text.slice(from, end);
      else if (next === '/' && as === '.') out += text.slice(from, at);
      else out += text.slice(from, at) + as;
      from = next === '/' && as === '.' ? end + 1 : end;
    }
    return out + text.slice(from);
  };
  return (text) => folders.reduce((out, [dir, as]) => swap(out, dir, as), lib.redactSecrets(String(text ?? '')));
}

/** A file as every machine of a room spells it, or null for one that is not in the repository (the server's repoRelativePath). */
function repoPath(file) {
  if (!isString(file)) return null;
  const s = file.replace(/\\/g, '/');
  if (!s || s.length > CHARS.path || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s === '~' || s.startsWith('~/')) return null;
  const segments = s.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  const clean = segments.join('/');
  return said(clean, CHARS.path) === clean ? clean : null;
}

/** At most `max` characters as the room counts them, cut with "…". */
function atMost(text, max) {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/**
 * Text as the room keeps a teammate's: nothing hidden in it and nothing
 * shaped like a tag (lib.sanitizeTeammateText, the server's own rules). The
 * room refuses whole an observation whose text it would have to change, so
 * it is sent already as the room would leave it.
 */
function said(text, max) {
  const clean = lib.sanitizeTeammateText ? lib.sanitizeTeammateText(text, Infinity) : text.replace(/\s+/g, ' ').trim();
  return atMost(clean, max);
}

const word = (value, max) => (isString(value) && value.length <= max && NAME.test(value) ? value : null);
const time = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : null);

/**
 * An observation as a room is sent it: the fields the room keeps, each held
 * to the room's own limit, and no others. `developer` stays behind (the
 * room settles who a machine is from how it signed in), and so do `seen`
 * (the room counts for itself), `repo` (said once for the request) and
 * anything else a log line may hold. A file that is not in the repository is
 * left out, with its anchor; a name the room would not read as one is null.
 */
function wireObservation(obs, scrub) {
  const text = (value, max) => said(scrub(value), max);
  const files = [];
  const spelled = new Map(); // a file as the log names it, to how the room is sent it
  for (const file of Array.isArray(obs.files) ? obs.files : []) {
    const clean = isString(file) ? repoPath(scrub(file)) : null;
    if (!clean || files.length >= observe.LIMITS.files) continue;
    if (!files.includes(clean)) files.push(clean);
    spelled.set(file, clean);
  }
  const blobs = {};
  for (const [file, blob] of Object.entries(obs.blobs && typeof obs.blobs === 'object' ? obs.blobs : {})) {
    if (spelled.has(file) && isString(blob) && BLOB_ID.test(blob)) blobs[spelled.get(file)] = blob;
  }
  const ts = time(obs.ts);
  const from = time(obs.batch?.from) ?? ts;
  const to = time(obs.batch?.to) ?? ts;
  const kind = obs.evidence && typeof obs.evidence === 'object' && EVIDENCE_KINDS.includes(obs.evidence.kind) ? obs.evidence.kind : null;
  return {
    id: obs.id,
    ts,
    session_id: word(obs.session_id, CHARS.session),
    agent: word(obs.agent, CHARS.agent),
    branch: isString(obs.branch) ? atMost(obs.branch, CHARS.branch) : null,
    checkout_id: isString(obs.checkout_id) && obs.checkout_id.length <= 64 ? obs.checkout_id : null,
    head: isString(obs.head) && COMMIT_ID.test(obs.head) ? obs.head : null,
    type: obs.type,
    title: text(obs.title, observe.LIMITS.titleChars),
    facts: (Array.isArray(obs.facts) ? obs.facts : []).filter(isString).slice(0, observe.LIMITS.facts).map((fact) => text(fact, observe.LIMITS.factChars)).filter(Boolean),
    files,
    blobs,
    symbols: (Array.isArray(obs.symbols) ? obs.symbols : []).filter((symbol) => isString(symbol) && symbol.length <= 80).slice(0, observe.LIMITS.symbols),
    evidence: kind ? { kind, ref: kind === 'none' ? '' : text(obs.evidence.ref ?? '', CHARS.ref) } : null,
    batch: { from: Math.min(from, to), to },
    model: word(obs.model, CHARS.model),
  };
}

/**
 * A log line as the room is sent it: an observation added, seen again, or
 * forgotten, or a finding of the room's that a session here found false. Of
 * that last the room is told which finding, when, and the commit the
 * session's checkout was at, and nothing of why: what the session saw
 * (`because`) is a sentence about this machine's work, and stays in its log.
 * Of a finding a session here was told (`told`) and of one it acted on
 * (`use`), as of one seen again or forgotten, the room is told which finding
 * and when, and not a field more: which session it was (`session`) and what
 * it did (`how`) stay in the log too. A `seen` of a teammate's finding, one
 * a session here found again by itself, is the same entry as a `seen` of
 * this machine's own: the room tells them apart by who sent it. Of a stale
 * vote (`stale`), a finding of the room's that this machine held to a
 * checkout of the default branch and found the code changed under, the room
 * is told which finding, when, and the commit that checkout was at, which
 * the line always has (observe.pendingLines): never which file, which lines
 * or why, and the log holds none of that to send.
 */
function wireEntry(line, scrub) {
  if (line.op === 'add') return { op: 'add', obs: wireObservation(line.obs, scrub) };
  if (line.op === 'refute') return { op: 'refute', id: line.id, ts: Math.round(line.ts), head: isString(line.head) && COMMIT_ID.test(line.head) ? line.head : null };
  if (line.op === 'stale') return { op: 'stale', id: line.id, ts: Math.round(line.ts), head: line.head };
  return { op: line.op, id: line.id, ts: Math.round(line.ts) };
}

// ── a round ─────────────────────────────────────────────────────────────────

/** Why a request did not do what it was sent for, in a few words: the status and the server's code for it, or why there was no answer. */
function failure(step, res) {
  if (res.error) return `${step}: ${brief(res.error, 40)}`;
  const code = isString(res.json?.code) ? ` ${brief(res.json.code, 60)}` : '';
  return `${step}: ${res.status}${code}`;
}

/**
 * Of the lines a room is owed, the ones that go where nothing found does,
 * from a machine that keeps what it finds to itself or to a room that does
 * not share: the `forget`s numbered after the last one sent that way
 * (`forgot`), and nothing else. Taking a finding back is not sharing one,
 * and the room may hold it from before the veto, or from when it shared.
 * The cursor does not pass a forget sent so, since the lines around it are
 * still to go when the veto is lifted or the room shares again; that is why
 * it has a number of its own, and why it goes once more then, to a room that
 * keeps it once.
 *
 * A forget of a finding that is itself held back waits with it, and
 * observe.pendingLines leaves out the same for a room that does not share.
 * The room keeps a forget once, by its id, and takes one only of a finding
 * it holds: sent ahead of its finding it would be used up, and the finding,
 * sent later, would stay in the room with nothing left to take it back.
 */
function takenBack(owed, forgot) {
  const heldBack = new Set(owed.filter((line) => line.op === 'add').map((line) => line.obs.id));
  return owed.filter((line) => line.op === 'forget' && line.n > forgot && !heldBack.has(line.id));
}

/**
 * One repository's round. Returns its line of the summary,
 * { key, pulled, pushed, refused, error } and, with refusals, `why` (how many for each of the room's reasons), or null when there was nothing to
 * do for it: its checkout is gone, it has no room, or nobody is at work in
 * it and it was asked about a moment ago.
 */
async function syncKey(key, now, until) {
  let state = observe.readSyncState(key);
  if (!state || !isString(state.top) || !isFolder(state.top)) return null;
  const top = state.top;
  const save = (patch) => (state = observe.updateSyncState(key, patch));

  const quiet = now - (state.noted_at ?? 0) > QUIET_MS && now - state.pulled_at < QUIET_MS && now >= state.pulled_at;
  // Something to send is a reason to ask all the same. In a room that does
  // not share only a forget is, and only one that has not gone and was not
  // turned away a moment ago: the cursor does not pass a forget there, so it
  // would be a reason for good.
  const waits = () => {
    const owed = observe.pendingLines(key, state);
    if (state.sharing === true) return owed.length > 0;
    return now >= (state.retry_at ?? 0) && takenBack(owed, state.forgot ?? 0).length > 0;
  };
  if (quiet && !waits()) return null;

  const config = await roomOf(top);
  if (!config) return null;
  const summary = { key, pulled: 0, pushed: 0, refused: 0, error: null };
  const ask = (method, route, body) => {
    const left = until - Date.now();
    if (left < REQUEST_MIN_MS) return { error: 'the round ran out of time' };
    return lib.request(method, `${config.url}${route}`, {
      room: config.room,
      token: config.token,
      user: config.user,
      dev: config.dev,
      timeoutMs: Math.min(REQUEST_MS, left),
      body,
    });
  };
  const failed = (what, patch = {}) => {
    save({ ...patch, error: { at: now, what } });
    summary.error = what;
    return summary;
  };

  // Pull. The room says whether it shares, and since when: nothing is pushed on what it said last time.
  const got = await ask('GET', `/observations?limit=${observe.LIMITS.teamMax}`);
  if (got.status === 404) {
    // A server from before observations has no such route. Its room shares
    // nothing, which is not a failure to report every round: it is told as a
    // room that does not share, as the recall tool tells it.
    observe.writeTeam(key, { v: 1, at: now, sharing: false, share_since: null, seq: 0, observations: [] });
    save({ sharing: false, share_since: null, pulled_at: now, team: 0, error: null });
    return summary;
  }
  if (got.status !== 200 || typeof got.json?.sharing !== 'boolean') {
    return failed(got.status === 200 ? 'pull: the answer is not a list of observations' : failure('pull', got));
  }
  const sharing = got.json.sharing;
  const since = sharing && Number.isFinite(got.json.share_since) ? got.json.share_since : null;
  const found = sharing && Array.isArray(got.json.observations) ? got.json.observations.slice(0, observe.LIMITS.teamMax) : [];
  const seq = Number.isFinite(got.json.seq) ? got.json.seq : 0;
  observe.writeTeam(key, { v: 1, at: now, sharing, share_since: since, seq, observations: found });
  summary.pulled = found.length;
  // A push that was turned away waits out its time, unless the room has
  // changed its answer on sharing since: the hold was about the room as it
  // was, and one that shares now is not kept waiting for what it asked for.
  const held = now < (state.retry_at ?? 0) && sharing === state.sharing;
  save({ sharing, share_since: since, pulled_at: now, team: found.length, ...(held ? {} : { error: null }) });

  // Push. What was found goes where the room shares and this machine has not
  // said no (observe.vetoesSharing). Anywhere else nothing found goes, and
  // what was taken back still does (takenBack).
  const takingBack = !sharing || observe.vetoesSharing();
  const log = observe.readLog(key);
  const end = log.reduce((last, line) => Math.max(last, line.n), 0);
  // A cursor past the end of the log is from a log that was removed and has
  // started again: its lines are new to the room, whatever their numbers.
  // A round that only takes back leaves the cursor to the one that sends
  // past it: no line of such a log has reached the room, so the room is owed
  // no forget of one.
  if (!takingBack && state.sent > end) save({ sent: 0 });
  if ((state.forgot ?? 0) > end) save({ forgot: 0 });
  const owed = observe.pendingLines(key, state, log);
  const lines = takingBack ? takenBack(owed, state.forgot ?? 0) : owed;
  if (!lines.length) {
    // A round that only takes back says nothing of the lines that do not go: what their last push left stands.
    if (!takingBack && (state.error || state.retry_at)) save({ error: null, retry_at: 0 });
    return summary;
  }
  if (held) {
    summary.error = state.error?.what ?? null;
    return summary;
  }

  const scrub = scrubber(top);
  const head = { developer: lib.getDeveloper(config, top), repo: lib.repoSlug(top) || undefined };
  const empty = Buffer.byteLength(JSON.stringify({ ...head, entries: [] }));
  let at = 0;
  for (let pushes = 0; pushes < PUSHES_A_ROUND && at < lines.length; pushes++) {
    // out of time is not the room's failure: what is left goes next round
    if (until - Date.now() < REQUEST_MIN_MS) break;
    const entries = [];
    let bytes = empty;
    let last = 0;
    while (at < lines.length && entries.length < PUSH_ENTRIES) {
      const entry = wireEntry(lines[at], scrub);
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (entries.length && bytes + size > PUSH_BYTES) break;
      entries.push(entry);
      bytes += size;
      last = lines[at].n;
      at++;
    }
    const res = await ask('POST', '/observations', { ...head, entries });
    if (res.status === 200) {
      // An entry the room refused is not sent again: it would be refused again. It is counted, and the cursor passes it.
      const said = Array.isArray(res.json?.refused) ? res.json.refused : [];
      const refused = Math.min(said.length, entries.length);
      summary.pushed += entries.length - refused;
      summary.refused += refused;
      // Why, in the room's own word for it (`path`: the finding names a folder of this machine; `orders`, `link`,
      // `secret`, `shape`), counted: a round with refusals says what they were for, and one without has no `why`.
      for (const one of said.slice(0, refused)) {
        const code = typeof one?.code === 'string' && /^[a-z_]{1,24}$/.test(one.code) ? one.code : 'unknown';
        summary.why = { ...(summary.why ?? {}), [code]: (summary.why?.[code] ?? 0) + 1 };
      }
      save({ ...(takingBack ? { forgot: last } : { sent: last }), pushed_at: now, error: null, retry_at: 0 });
      continue;
    }
    if (res.status === 403 && res.json?.code === 'sharing_off') {
      // switched off between the pull and here: nothing was kept, and what was pulled is not to be shown
      observe.writeTeam(key, { v: 1, at: now, sharing: false, share_since: null, seq, observations: [] });
      // From a room that had already said it does not share, it is the answer
      // of a server from before such a room took a forget. It is believed the
      // same, and is no error to tell every round: the forgets stay after the
      // cursor for when the room shares again, and are not sent again at once.
      save({ sharing: false, share_since: null, team: 0, ...(sharing ? {} : { retry_at: now + HOLD_MS }) });
      summary.pulled = 0;
      return summary;
    }
    // Anything else leaves the cursor where it is. An answer that is about
    // this machine or its room, and not about the moment, is not asked for
    // again at once.
    const lasting = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    return failed(failure('push', res), lasting ? { retry_at: now + HOLD_MS } : {});
  }
  return summary;
}

/**
 * One round of syncing, for every repository this machine has observed in
 * whose checkout is still there and reports to a room: the pull, then the
 * push (see the top of this file). The repository asked longest ago goes
 * first, so one slow room does not starve the rest. Resolves the summary,
 * one line a repository that was asked: [{ key, pulled, pushed, refused,
 * error }], where `pulled` is how many of the team's findings came back,
 * `pushed` how many lines the room took, `refused` how many it would not
 * keep, and `error` null or a few words. Never throws.
 */
export async function syncRound({ now = Date.now() } = {}) {
  const summary = [];
  try {
    if (typeof lib.request !== 'function') return summary; // a lib.mjs from before it could be asked for
    const until = Date.now() + ROUND_MS;
    const keys = observe
      .syncKeys()
      .map((key) => ({ key, asked: observe.readSyncState(key)?.pulled_at ?? 0 }))
      .sort((a, b) => a.asked - b.asked);
    for (const { key } of keys) {
      if (until - Date.now() < REQUEST_MIN_MS) break;
      try {
        const line = await syncKey(key, now, until);
        if (line) summary.push(line);
      } catch (err) {
        summary.push({ key, pulled: 0, pushed: 0, refused: 0, error: brief(err?.message || err) });
      }
    }
  } catch {
    // a sync folder that cannot be read: there is nothing to say of any repository
  }
  return summary;
}

/** owner/name from a key that was made from one (observe.repoKey), for a checkout that is gone. */
function repoOfKey(key) {
  const parts = key.startsWith('local__') ? [] : key.split('__');
  return parts.length === 2 && parts[0] && parts[1] ? `${parts[0]}/${parts[1]}` : null;
}

/**
 * Where syncing stands, for `agentmash observe status`: a line for each
 * repository that has a sync state, read from files alone, with no server
 * asked: [{ key, repo, top, sharing, share_since, sent, pending, pulled_at,
 * pushed_at, team, error }]. `sent` is the number of the last log line the
 * room has, `pending` how many lines after it the room is still to be sent
 * (observe.pendingLines: this machine's own veto holds them back and does
 * not make them fewer, and a `forget` that went on its own, under the veto
 * or to a room that does not share, is still counted, since the cursor has
 * not passed it), `team` how many of the team's findings the last pull
 * brought. Never throws.
 */
export function syncStatus() {
  try {
    return observe.syncKeys().map((key) => {
      const state = observe.readSyncState(key) ?? {};
      const top = isString(state.top) ? state.top : null;
      let repo = null;
      try {
        repo = (top && lib.repoSlug(top)) || repoOfKey(key);
      } catch {
        repo = repoOfKey(key);
      }
      let pending = 0;
      try {
        pending = observe.pendingLines(key, state).length;
      } catch {
        // a log that cannot be read has nothing counted
      }
      return {
        key,
        repo,
        top,
        sharing: typeof state.sharing === 'boolean' ? state.sharing : null,
        share_since: Number.isFinite(state.share_since) ? state.share_since : null,
        sent: Number.isInteger(state.sent) ? state.sent : 0,
        pending,
        pulled_at: Number.isFinite(state.pulled_at) ? state.pulled_at : 0,
        pushed_at: Number.isFinite(state.pushed_at) ? state.pushed_at : 0,
        team: Number.isInteger(state.team) ? state.team : 0,
        error: state.error && typeof state.error === 'object' && isString(state.error.what) ? { at: Number(state.error.at) || 0, what: state.error.what } : null,
      };
    });
  } catch {
    return [];
  }
}
