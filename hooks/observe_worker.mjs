#!/usr/bin/env node
// AgentMash observe worker: turns what the spool hook wrote down into short
// observations, one batch at a time, with a small model that has no tools
// (docs/plans/enrichment-step1-observer.md; everything shared is observe.mjs).
//
// The spool hook starts this detached and never waits for it, so nobody is
// watching. That decides most of what is here:
//
// - One per machine. The lock is a folder, because making a folder is the one
//   thing two processes cannot both do, with this process's pid in it. A hook
//   that finds the pid alive starts nothing; a worker that finds it alive
//   leaves at once.
// - Nothing is left running. It exits when observing is turned off and after
//   five minutes with nothing to do, and every way out, a signal and a crash
//   among them, removes the lock and kills the observer if one is running.
// - Nothing is lost. A batch's spool files are deleted only after what came
//   of it is on disk: its observations in the log, or the batch itself in
//   dead/. A worker killed in the middle of a run leaves the batch where it
//   was, and the next worker observes it.
// - The observer is the person's own `claude`, on their own subscription, so
//   it is run sparingly: one at a time, only for a batch that holds something
//   (observe.hasSignal), under a cap a day, and not at all for half an hour
//   after it says the usage limit is reached.
// - A command that cannot answer is the machine's trouble, not a batch's
//   (docs/plans/enrichment-step5-worker-hold.md). A run that exits with an
//   error is not counted against the cap and sends no batch to dead/: after
//   three in a row, or one that speaks of the sign-in, observing is held for
//   a minute, then two, up to an hour, with one run at the end of each to see
//   whether it works again. A batch that meets a hold or a pause waits in the
//   spool, which keeps it a day; one past the day's cap is dropped and
//   counted, as ever. A batch whose run fails where the command answers
//   others is the batch's trouble after all, and goes to dead/.
// - What closed last goes first (lineUp): the work sessions are doing now,
//   and then of what waited the newest, so that what the day's runs cannot
//   reach is the oldest.
// - It is the one process on the machine that is already there, so it is the
//   one that syncs: as soon as a batch has logged a finding, every thirty
//   seconds while it is alive and once before it exits, what was found goes
//   to a room that shares and the team's findings come back
//   (observe_sync.mjs), and the reports an outage kept are sent
//   (lib.drainOutbox). Neither is waited for long, and neither failing stops
//   a batch from being observed.
//
// It prints nothing. What it did is one line per batch in observe/worker.log,
// and one for a sync that sent something or failed. What its observer runs
// cost, each by its kind, and what became of every prompt's briefing is in
// observe/ledger.jsonl (observe.ledgerLine): this machine's own, sent nowhere.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as observe from './observe.mjs';
// See the note in post_tool_use.mjs: guarded access for post-v0 helpers.
import * as lib from './lib.mjs';

/** A number of milliseconds from the environment, for the tests; anything that is not one keeps the default. */
function fromEnv(name, fallback) {
  const asked = Number(process.env[name]);
  return Number.isFinite(asked) && asked > 0 ? asked : fallback;
}

const POLL_MS = fromEnv('AGENTMASH_OBSERVE_POLL_MS', 2000);
const IDLE_MS = fromEnv('AGENTMASH_OBSERVE_IDLE_MS', 5 * 60_000);
// how long one observer run may take before it is killed
const OBSERVER_LIMIT_MS = fromEnv('AGENTMASH_OBSERVE_TIMEOUT_MS', 60_000);
const SWEEP_MS = 10 * 60_000;
// how often the team's findings are fetched; what this machine found does not wait for it (syncIfDue)
const SYNC_MS = fromEnv('AGENTMASH_OBSERVE_SYNC_MS', 30_000);
// a round that has not ended by now is left to end by itself, or not at all
const SYNC_LIMIT_MS = fromEnv('AGENTMASH_OBSERVE_SYNC_LIMIT_MS', 10_000);
// what the outbox is asked for after a round: this many reports, for this long
const DRAIN = { max: 50, budgetMs: 3000 };
const PAUSE_MS = 30 * 60_000;
const ATTEMPTS = 2; // a reply that cannot be used is asked for once more
// and the most runs one prompt is given, the ones that exited with an error among them: they are not among its
// two, and observing is held at the third of them in a row. A batch is given one such run a pass (workBatches).
const MOST_TRIES = 8;
const LOG_BYTES = 1024 * 1024;
const OUTPUT_CHARS = 4 * 1024 * 1024; // of an observer's stdout or stderr; a reply is a few hundred
// A lock folder with no pid in it yet is a worker between making it and
// writing the pid, for this long; after that it is one that died there.
const TAKING_MS = 5000;
const POSIX = process.platform !== 'win32';

let held = false; // the lock is ours
let observer = null; // the observer's process, while one runs
let observerRuns = 0; // how many times this worker has run it, or tried to
let folder = null; // the empty folder it runs in

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const brief = (text, max = 300) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// ── the log ─────────────────────────────────────────────────────────────────

/** One line in observe/worker.log, which starts again at 1 MB with the old one kept beside it. Never throws. */
function logLine(entry) {
  try {
    const file = path.join(observe.observePaths().dir, 'worker.log');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(file).size >= LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      // no log yet
    }
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    // a log that cannot be written stops nothing
  }
}

// ── the lock ────────────────────────────────────────────────────────────────

function lockPid(dir) {
  try {
    const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Whether `pid` is a worker that is still there. Our own pid in a lock we did
 * not make, or a process this user may not signal, is the number of a worker
 * long dead, since given to something else (the spool hook reads it the same).
 */
function alive(pid) {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockAge(dir) {
  try {
    return Date.now() - fs.statSync(dir).mtimeMs;
  } catch {
    return Infinity;
  }
}

/**
 * Takes the machine's lock, or returns false when a live worker has it.
 *
 * A dead worker's lock is removed and taken. Several workers can find the
 * same dead lock at once (every hook of a turn's parallel tool calls starts
 * one), so it is moved aside before it is removed: a rename is atomic, only
 * one of them gets to do it, and the rest meet the winner's new lock.
 */
function takeLock() {
  const { dir, lock } = observe.observePaths();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let tries = 0; tries < 3; tries++) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid), { mode: 0o600 });
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    const holder = lockPid(lock);
    if (holder ? alive(holder) : lockAge(lock) < TAKING_MS) return false;
    const aside = `${lock}.${process.pid}`;
    try {
      fs.renameSync(lock, aside);
    } catch {
      continue; // another worker moved it first: the place is free, or theirs by now
    }
    if (lockPid(aside) !== holder) {
      // not the dead lock that was looked at: a worker took the place in between, and gets it back
      try {
        fs.renameSync(aside, lock);
      } catch {
        fs.rmSync(aside, { recursive: true, force: true });
      }
      return false;
    }
    fs.rmSync(aside, { recursive: true, force: true });
  }
  return false;
}

/** Whether the lock still names this process. One that was cleared or taken under it is not ours to work under. */
const holdsLock = () => lockPid(observe.observePaths().lock) === process.pid;

// ── syncing ─────────────────────────────────────────────────────────────────

let sync = null; // observe_sync.mjs, once it is loaded
let synced = 0; // when the last round began
let roundOpen = false; // a round that was given up on and has not ended yet
let unsent = false; // a finding was logged, and no round has begun since
let lastTrouble = ''; // what the last failed round said, so the same failure is one line and not one every round

/**
 * Loads observe_sync.mjs, the one observe file that talks to a server. An
 * install from before it has none beside the worker: that worker observes as
 * it always did, and says once why it does not sync.
 */
async function loadSync() {
  try {
    sync = await import('./observe_sync.mjs');
  } catch (err) {
    logLine({ outcome: 'sync', why: `observe_sync.mjs could not be loaded: ${brief(err?.code || err?.message || err, 120)}` });
  }
}

/** Says where a repository is checked out, for the next round (observe_sync.noteCheckout). Never throws. */
function noteCheckout(key, top) {
  try {
    sync?.noteCheckout?.(key, top);
  } catch {
    // syncing is not what this batch is waiting for
  }
}

/**
 * Runs `work` and resolves { value }, { error } or, when it has not ended in
 * `ms`, { abandoned: true }. It is not stopped then: `ended` runs when it
 * does end, however late.
 */
function bounded(work, ms, ended = () => {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ abandoned: true }), ms);
    Promise.resolve()
      .then(work)
      .then(
        (value) => resolve({ value }),
        (error) => resolve({ error })
      )
      .finally(() => {
        clearTimeout(timer);
        ended();
      });
  });
}

/**
 * One round: what was found goes to the rooms that share and their teams'
 * findings come back, then the reports an outage kept are sent. A failure of
 * either is a line in the log and nothing more: the same failure again, the
 * next round, is not said again.
 */
async function syncRound() {
  synced = Date.now();
  const trouble = [];
  // a round given up on may still be writing its cursor: the next starts when it has ended
  if (sync?.syncRound && !roundOpen) {
    roundOpen = true;
    // Whatever comes of this round: one that fails is not tried again every
    // poll, and what it did not send goes with the clock's next, as it did.
    unsent = false;
    const round = await bounded(() => sync.syncRound(), SYNC_LIMIT_MS, () => (roundOpen = false));
    if (round.abandoned) trouble.push(`no end to the round in ${Math.round(SYNC_LIMIT_MS / 100) / 10} s`);
    else if (round.error) trouble.push(brief(round.error?.message || round.error));
    else {
      const rows = Array.isArray(round.value) ? round.value.filter((row) => row && typeof row === 'object') : [];
      const sum = (field) => rows.reduce((n, row) => n + (Number(row[field]) || 0), 0);
      for (const row of rows) if (row.error) trouble.push(`${row.key}: ${brief(row.error, 100)}`);
      // what the room would not take, by its own reason: `path 2, orders 1`. Most are `path`, a finding that names a folder of this machine.
      const why = {};
      for (const row of rows) for (const [code, count] of Object.entries(row.why && typeof row.why === 'object' ? row.why : {})) why[code] = (why[code] ?? 0) + (Number(count) || 0);
      const refusedFor = Object.entries(why).map(([code, count]) => `${code} ${count}`).join(', ');
      if (sum('pushed') || sum('refused')) logLine({ outcome: 'synced', pushed: sum('pushed'), refused: sum('refused'), ...(refusedFor ? { refused_for: refusedFor } : {}), pulled: sum('pulled') });
    }
  }
  if (typeof lib.drainOutbox === 'function') {
    const drain = await bounded(() => lib.drainOutbox(DRAIN), SYNC_LIMIT_MS);
    if (drain.abandoned) trouble.push('the outbox did not answer in time');
    else if (drain.error) trouble.push(`the outbox: ${brief(drain.error?.message || drain.error)}`);
    else if (drain.value?.sent || drain.value?.dropped) logLine({ outcome: 'outbox', sent: drain.value.sent ?? 0, dropped: drain.value.dropped ?? 0, left: drain.value.left ?? 0 });
  }
  const said = trouble.join('; ');
  if (said && said !== lastTrouble) logLine({ outcome: 'sync', why: brief(said) });
  lastTrouble = said;
}

/**
 * A round when one is due: by the clock, or at once when a finding has been
 * logged since the last round began, so that it is in its room seconds after
 * it was found and a teammate's next edit is told of it. The clock starts
 * again from that round, which pulls too. Two rounds are never run at once,
 * so while one that was given up on is still open the finding waits for it to
 * end, and goes at the first call after. Never throws: a sync that failed is
 * not a reason to stop observing.
 */
async function syncIfDue() {
  const found = unsent && !roundOpen;
  if (!found && Date.now() - synced < SYNC_MS) return;
  try {
    await syncRound();
  } catch (err) {
    logLine({ outcome: 'sync', why: brief(err?.message || err) });
  }
}

// ── every way out ───────────────────────────────────────────────────────────

/** Kills the observer and whatever it started: it runs in a process group of its own. */
function killObserver() {
  const proc = observer;
  if (!proc?.pid) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    // no group to signal (Windows), or it is gone already
    try {
      proc.kill('SIGKILL');
    } catch {}
  }
}

function removeFolder() {
  const dir = folder;
  folder = null;
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/** Runs as the process exits, however it does: no observer, no folder of its own and no lock are left. */
function cleanUp() {
  killObserver();
  removeFolder();
  if (!held) return;
  held = false;
  try {
    if (holdsLock()) fs.rmSync(observe.observePaths().lock, { recursive: true, force: true });
  } catch {}
}

function crash(err) {
  logLine({ outcome: 'error', why: brief(err?.stack || err) });
  process.exit(1);
}

process.on('exit', cleanUp);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

// ── the observer ────────────────────────────────────────────────────────────

/**
 * The observer's command, as [program, ...arguments]: `claude` with every
 * tool off, the person's own settings, plugins and MCP servers left out,
 * nothing saved as a session, and the reply held to observe.OBSERVER_SCHEMA.
 * (`--bare` would be simpler and cannot be used: it refuses a subscription
 * sign-in.) AGENTMASH_OBSERVER_CMD, a JSON array of strings, replaces all of
 * it, for the tests; one that is anything else is null, and nothing is run.
 */
function observerCommand(model, ask = OBSERVE_ASK) {
  const named = process.env.AGENTMASH_OBSERVER_CMD;
  if (named) {
    try {
      const parts = JSON.parse(named);
      if (Array.isArray(parts) && parts.length && parts[0] && parts.every((part) => typeof part === 'string')) return parts;
    } catch {}
    return null;
  }
  return [
    'claude',
    '-p',
    '--tools',
    '',
    '--setting-sources',
    'project,local',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--model',
    model,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(ask.schema),
    '--system-prompt',
    ask.system,
  ];
}

// What the observer is asked: to write down what a batch shows (the default),
// or to pick the findings that bear on a task (briefSession).
const OBSERVE_ASK = { kind: 'observe', system: observe.OBSERVER_PROMPT, schema: observe.OBSERVER_SCHEMA };
const BRIEF_ASK = { kind: 'brief', system: observe.BRIEF_PROMPT, schema: observe.BRIEF_SCHEMA };
// the first pass where a repository holds more findings than one briefing can be shown (briefSession)
const SHORT_ASK = { kind: 'short', system: observe.SHORT_PROMPT, schema: observe.SHORT_SCHEMA };

function isInside(dir, parent) {
  const rel = path.relative(parent, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A new empty folder for one observer run, under the system's temp folder.
 * `claude` reads the settings and the CLAUDE.md of the folder it starts in
 * and of the folders above it, so it must start where there are none: never
 * inside a repository, never under the home folder. A temp folder that is
 * (TMPDIR can point anywhere) is passed over for /tmp; null when neither will do.
 */
function emptyFolder() {
  let home = null;
  try {
    home = fs.realpathSync(os.homedir());
  } catch {}
  // a home that is the root of the disk (a container's) has everything under it, and means nothing here
  if (home && home === path.parse(home).root) home = null;
  for (const base of [os.tmpdir(), '/tmp']) {
    try {
      const real = fs.realpathSync(base);
      if ((home && isInside(real, home)) || observe.findTop(real)) continue;
      return fs.mkdtempSync(path.join(real, 'agentmash-observer-'));
    } catch {
      // no such folder on this machine, or not ours to write in
    }
  }
  return null;
}

/**
 * Runs the observer once with `text` on its stdin. Resolves, never rejects,
 * with { code, signal, stdout, stderr, timedOut }, or { unstarted: why } when
 * there was nothing to run or it could not be started.
 */
function runObserver(text, model, ask = OBSERVE_ASK) {
  observerRuns++;
  return new Promise((resolve) => {
    const command = observerCommand(model, ask);
    if (!command) return resolve({ unstarted: 'AGENTMASH_OBSERVER_CMD is not a JSON array of strings' });
    const dir = emptyFolder();
    if (!dir) return resolve({ unstarted: 'there is no temp folder outside a repository and the home folder to run the observer in' });
    folder = dir;

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observer = null;
      removeFolder();
      resolve(result);
    };

    // AGENTMASH_DISABLE: the observer is a Claude Code session too, and the
    // AgentMash hooks of the machine would report it to a room and spool it
    // for this worker to observe. CLAUDE_PROJECT_DIR is the session's that
    // the hook which started this worker ran in, and is none of the observer's.
    const env = { ...process.env, AGENTMASH_DISABLE: '1' };
    delete env.CLAUDE_PROJECT_DIR;
    // A command named in place of `claude` (the tests') is not passed the prompt, the schema and the model as arguments: it reads them here.
    if (process.env.AGENTMASH_OBSERVER_CMD) Object.assign(env, { AGENTMASH_OBSERVER_KIND: ask.kind, AGENTMASH_OBSERVER_MODEL: String(model ?? ''), AGENTMASH_OBSERVER_SYSTEM: ask.system, AGENTMASH_OBSERVER_SCHEMA: JSON.stringify(ask.schema) });

    let proc;
    try {
      proc = spawn(command[0], command.slice(1), { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], detached: POSIX, windowsHide: true });
    } catch (err) {
      return settle({ unstarted: `${command[0]} could not be started: ${err?.code || err?.message}` });
    }
    observer = proc;
    timer = setTimeout(() => {
      timedOut = true;
      killObserver();
      // killed, its pipes close and `close` follows; something it started that still
      // holds them open must not hold this worker with it
      timer = setTimeout(() => {
        proc.stdout.destroy();
        proc.stderr.destroy();
        settle({ code: null, signal: 'SIGKILL', stdout, stderr, timedOut });
      }, 2000);
    }, OBSERVER_LIMIT_MS);

    proc.on('error', (err) => {
      // without a pid it never started; with one, `close` says how it ended
      if (proc.pid === undefined) settle({ unstarted: `${command[0]} could not be started: ${err?.code || err?.message}` });
    });
    proc.on('close', (code, signal) => settle({ code, signal, stdout, stderr, timedOut }));
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      if (stdout.length < OUTPUT_CHARS) stdout += chunk;
    });
    proc.stderr.on('data', (chunk) => {
      if (stderr.length < OUTPUT_CHARS) stderr += chunk;
    });
    // an observer that exits without reading its stdin: its exit says what happened
    proc.stdin.on('error', () => {});
    proc.stdin.end(text);
  });
}

// How a run that failed says the person's usage is spent: Claude Code's own
// words ("usage limit reached") and the API's ("rate limit", rate_limit_error).
const LIMIT_WORDS = /\b(?:usage|rate)[ _-]?limit/i;
// And how one says that the sign-in cannot be used, which no second run mends: "Please run /login", "Invalid
// API key", "OAuth token has expired", "authentication_error", "Your organization has disabled Claude
// subscription access", "Credit balance is too low". A loose match on purpose. It is read only in a run that
// failed, and a wrong yes holds observing after the first such run and not the third.
const ACCESS_WORDS = /\/login\b|\blog(?:ged)?[ -]?in\b|\bsign(?:ed)?[ -]?in\b|\bauthenticat|\bunauthori[sz]ed\b|\bforbidden\b|\bpermission_error\b|\b(?:api key|oauth|credit balance|subscription|access|disabled)\b/i;
// And how one says the model it was asked for is not one it can use: Claude Code's "There's an issue with the
// selected model (…). It may not exist or you may not have access to it", the API's not_found_error for "model: …".
// Heard only where the words name the model that was asked for: that one says "access" too, and is no sign-in's.
const MODEL_WORDS = /\bissue with the selected model\b|\bmodel\b[^\n]{0,120}\b(?:may not exist|does not exist|not found|not available|isn't available|not supported)\b|\bnot_found_error\b/i;

/**
 * What a run came to: { out } is the CLI's one JSON object (Claude Code
 * 2.1.304: is_error, result, structured_output, api_error_status,
 * total_cost_usd, usage, modelUsage), { bad: why } a reply that cannot be
 * used and is worth asking for again, { hold: why } a reason to stop asking
 * for a while: a usage or rate limit, or an observer that could not be
 * started at all. { failed: why, access, model } is a run that ended without
 * an answer: the command exited with an error, or answered with one that
 * speaks of the sign-in or of access (`access`, also a 401 or a 403) or of
 * the model it was `asked` for (`model`). That is the machine's trouble and
 * not what was asked: the caller counts it apart, and holds observing when it
 * goes on (observe.noteFailedStart).
 *
 * An error that shows the model ran is a reply, if one that cannot be used,
 * however the command exited: the run was paid tokens, or it stopped at a
 * limit of its own (`error_max_turns`). What it was asked is what failed
 * there, and not the machine.
 *
 * The limit words and the access words are looked for only in a run that
 * failed. A good reply about a repository's own rate limiter or its login
 * page says them too, and is neither.
 */
function readRun(run, asked = null) {
  if (run.unstarted) return { hold: run.unstarted, unstarted: true };
  if (run.timedOut) return { bad: `no answer in ${Math.round(OBSERVER_LIMIT_MS / 100) / 10} s` };
  let out = null;
  try {
    out = JSON.parse(run.stdout);
  } catch {}
  if (!out || typeof out !== 'object' || Array.isArray(out)) out = null;
  const said = `${typeof out?.result === 'string' ? out.result : ''}\n${run.stderr}`;
  const failed = run.code !== 0 || !out || out.is_error === true;
  const status = Number(out?.api_error_status);
  // `cli` is that object wherever there was one, for what the run cost (usageOf): a reply that cannot be used was paid for too
  if (status === 429 || (failed && LIMIT_WORDS.test(said))) return { hold: `usage or rate limit: ${brief(said, 200)}`, cli: out };
  if (run.code !== 0 || out?.is_error === true) {
    // a command that exits with an error may have said why on its stdout, as text
    const heard = out ? said : `${run.stdout.slice(0, 2000)}\n${run.stderr}`;
    const model = typeof asked === 'string' && asked !== '' && heard.includes(asked) && MODEL_WORDS.test(heard);
    const access = !model && (status === 401 || status === 403 || ACCESS_WORDS.test(heard));
    const spent = usageOf(out);
    const ran = !model && !access && out !== null && (spent.tokens_in + spent.tokens_out > 0 || /^error_max/.test(String(out.subtype ?? '')));
    if (!ran && run.code !== 0) return { failed: `the observer exited with ${run.code ?? run.signal}: ${brief(heard, 200)}`, access, model, cli: out };
    if (!ran && (access || model)) return { failed: `the observer answered with an error: ${brief(said, 200)}`, access, model, cli: out };
  }
  if (!out) return { bad: `the observer's output is not JSON: ${brief(run.stdout, 200)}` };
  if (out.is_error === true || run.code !== 0) return { bad: `the observer answered with an error: ${brief(said, 200)}`, cli: out };
  return { out, cli: out };
}

/**
 * What a run cost, as the CLI's reply says it: the tokens that went in and
 * came out, the ones read from and written to the prompt cache, the dollars
 * at list price (`total_cost_usd`: on a subscription nothing is charged, and
 * it is what the run would have cost), and the model that answered, by its
 * id. Zeros and null where the reply says none, as for a run that never
 * answered.
 */
function usageOf(cli) {
  const usage = cli?.usage && typeof cli.usage === 'object' ? cli.usage : {};
  const models = cli?.modelUsage && typeof cli.modelUsage === 'object' ? Object.keys(cli.modelUsage) : [];
  const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  return {
    tokens_in: count(usage.input_tokens),
    tokens_out: count(usage.output_tokens),
    cache_read: count(usage.cache_read_input_tokens),
    cache_write: count(usage.cache_creation_input_tokens),
    cost_usd: count(cli?.total_cost_usd),
    model: models[0] ?? null,
  };
}

/** The model the observer is asked for (`--model`): observe.observerModel's, or beside an observe.mjs from before it, the config's. */
function askedModel(config) {
  if (typeof observe.observerModel === 'function') return observe.observerModel(config, observe.readState());
  return typeof config.model === 'string' && config.model ? config.model : observe.DEFAULT_CONFIG.model;
}

/** The ledger's word for what the observer is asked (observe.ledgerLine). */
const KIND = { observe: 'batch', short: 'shortlist', brief: 'briefing' };
/** What the ledger takes of observe.mjs. Beside one from before it, no line is written, and the log's lines are as they were. */
const CAN_LEDGER = typeof observe.ledgerLine === 'function';

/** What the runs made for one batch or one prompt came to, for its line in the log: nothing yet. */
const nothingSpent = () => ({ runs: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0, model: null });
/** And as that line says it: nothing where no run was made, or where the observe.mjs beside this is from before the ledger. */
const spentFields = (spent, kind) => (CAN_LEDGER && spent.runs ? { kind, ...spent, cost_usd: Math.round(spent.cost_usd * 1e6) / 1e6 } : {});

/**
 * What holding takes of observe.mjs. Beside an observe.mjs from before there
 * was a hold, a run that exits with an error is a reply that cannot be used,
 * as it was: counted against the cap, asked for once more, and the batch
 * goes to dead/.
 */
const CAN_HOLD = ['noteFailedStart', 'noteAnswered', 'batchCap'].every((name) => typeof observe[name] === 'function');

/**
 * One observer run, and what it does to the day's counters and to whether
 * observing is held. Resolves, never rejects, with one of:
 *
 *   { out }    the reply, counted against the day's cap
 *   { bad }    a reply that cannot be used, counted as well: why
 *   { again }  the command exited with an error, for the first or second
 *              time in a row: why. Not counted, and worth asking once more
 *              at once, since it was not the question that failed
 *   { held }   nothing more is asked for a while: why. A usage or rate
 *              limit or an observer that could not be started (half an
 *              hour, as ever), or a command that goes on failing
 *              (observe.noteFailedStart). `until` is when it is over.
 *   { blamed } the command exited with an error for this `batch` before,
 *              and has answered other runs since: it is the batch that
 *              fails, which goes to dead/. Not counted, and holds nothing.
 *
 * `prompt` says the run is for a prompt (a briefing, or its shortlist) and
 * not a batch: the cap keeps a share for those. `batch` names the batch a
 * run is for (its first spool file).
 *
 * Where this machine's CLI refuses the pinned model id as a model, the
 * alias it was pinned from is asked for from then on (observe.observerModel,
 * noteModelRefused): the run comes back as { again, model }, held nothing,
 * and the caller asks for the model again.
 *
 * Every run is a line of the ledger, however it ended: its kind, `session`,
 * which `attempt` at its batch or prompt it was, how it was answered, how
 * long it took, and what the CLI says it cost (usageOf). `spent` is the
 * caller's sum for the batch or prompt, which its line in the log says.
 */
async function observerRun(text, model, ask, { prompt = false, session = null, attempt = 1, spent = null, batch = null } = {}) {
  const began = Date.now();
  const raw = await runObserver(text, model, ask);
  const run = readRun(raw, model);
  const cost = usageOf(run.cli);
  if (spent) {
    spent.runs += 1;
    for (const field of ['tokens_in', 'tokens_out', 'cache_read', 'cache_write', 'cost_usd']) spent[field] += cost[field];
    spent.model = cost.model ?? spent.model;
  }
  if (CAN_LEDGER) {
    const answer = run.hold ? (run.unstarted ? 'unstarted' : 'limit') : run.failed ? 'failed' : raw.timedOut ? 'timeout' : run.bad ? 'unusable' : 'answered';
    observe.ledgerLine({ what: 'run', kind: KIND[ask.kind] ?? ask.kind, session, attempt, answer, ms: Date.now() - began, asked: model, ...cost });
  }
  if (run.hold) {
    const until = Date.now() + PAUSE_MS;
    observe.updateState((s) => {
      s.paused_until = until;
      // a limit is an answer, if only a no: the command is not what is failing
      if (CAN_HOLD && !run.unstarted) Object.assign(s, { failing: 0, hold: null });
    });
    return { held: run.hold, until };
  }
  if (run.failed && CAN_HOLD) {
    if (run.model && model === observe.OBSERVER_MODEL && typeof observe.noteModelRefused === 'function') {
      observe.noteModelRefused({ model });
      return { again: run.failed, model: true };
    }
    const state = observe.noteFailedStart({ why: run.failed, access: run.access, model: run.model, batch });
    if (state.blamed) return { blamed: run.failed };
    return state.paused_until > Date.now() ? { held: run.failed, until: state.paused_until, failing: state.failing } : { again: run.failed };
  }
  if (CAN_HOLD) observe.noteAnswered({ brief: prompt });
  else {
    observe.updateState((s) => {
      s.runs += 1;
    });
  }
  return run.failed ? { bad: run.failed } : run;
}

// ── a prompt ────────────────────────────────────────────────────────────────

/** How old the room's file may be when a session is briefed from it: older, and the room is asked first. */
const BRIEF_FRESH_MS = fromEnv('AGENTMASH_OBSERVE_BRIEF_FRESH_MS', 20_000);
/**
 * How long the whole stale pass of one briefing may take (observe.staleIn,
 * for up to forty findings and each of their files): every question to git
 * is a process, three seconds at the most each, and a session is waiting for
 * what comes of it.
 */
const STALE_MS = fromEnv('AGENTMASH_OBSERVE_STALE_MS', 4000);
/**
 * How long saying to the room what that pass found changed may take
 * (observe.voteStale): a few more questions to git for each finding of a
 * teammate's the pass dropped, asked once the briefing is made, so no
 * session waits for them. The next prompt's briefing does.
 */
const VOTE_MS = fromEnv('AGENTMASH_OBSERVE_VOTE_MS', 2000);
/** The prompts already dealt with, by session: a prompt is briefed once, by the worker that first sees it. */
const promptsBriefed = new Map();
/**
 * Repositories a round was run for before a briefing and that had no fresh
 * file of their room after it, by when: one that reports to no room never
 * has one, and neither has one whose room does not answer. They are not
 * asked about again at every prompt, only with the clock's next round.
 */
const askedInVain = new Map();
/**
 * What briefing takes of observe.mjs. An install that got this worker
 * through a login may still have an observe.mjs from before the briefing
 * beside it: that worker briefs nothing, and observes as it always did.
 */
const CAN_BRIEF = ['readBrief', 'writeBrief', 'briefCandidates', 'staleIn', 'renderBriefAsk', 'checkBrief'].every((name) => typeof observe[name] === 'function');
/**
 * And what a stale vote takes of it. Beside an observe.mjs from before
 * there was one, a finding that is not true of the checkout is left out of
 * the briefing as it was, and the room is told nothing of it.
 */
const CAN_VOTE = typeof observe.voteStale === 'function';

const isFresh = (team) => Boolean(team) && Date.now() - team.at <= BRIEF_FRESH_MS;

/**
 * One question to the observer's model for a prompt, asked once more when
 * its reply cannot be used: `{ value }` (what `read` made of the reply),
 * `{ hold }` (the account is out of quota or the command goes on failing:
 * the observer is paused, as after a batch) or `{ bad }` (why neither reply
 * could be used). Every run that answered counts against the day's cap; one
 * that exited with an error does not, and is not one of the two (observerRun).
 */
async function askObserver(text, model, ask, read, { session = null, spent = null } = {}) {
  let why = '';
  for (let answered = 0, tries = 0; answered < ATTEMPTS && tries < MOST_TRIES; tries++) {
    const run = await observerRun(text, model, ask, { prompt: true, session, attempt: tries + 1, spent });
    if (run.held) return { hold: run.held };
    if (run.again) {
      why = run.again;
      // the pinned model was refused: the next try asks for the one that is asked for now
      if (run.model) model = askedModel(observe.readConfig());
      continue;
    }
    answered++;
    if (run.bad) {
      why = run.bad;
      continue;
    }
    try {
      return { value: read(run.out.structured_output) };
    } catch (err) {
      why = brief(err?.message || err);
    }
  }
  return { bad: why || 'no reply' };
}

/**
 * Briefs a session on its prompt: of the findings this machine holds about
 * the repository, its own other sessions' and its room's, the observer picks
 * the few that bear on the task, and observe_recall.mjs says them before the
 * session's next tool call. Returns `briefed`, `skipped` or `held`. A run
 * counts against the day's cap as any observer run does, so past the cap, or
 * while the observer is paused, nothing is done for the prompt at all: the
 * check comes before the room and git are asked anything.
 *
 * The room is asked first when its file here is not fresh, so that a
 * machine's first session in a repository hears what the team found there;
 * not again before the clock's next round where that left no file
 * (askedInVain).
 *
 * A finding that is not true of this checkout any more (observe.staleIn) is
 * not offered. That pass has STALE_MS for all of it, and in a partial clone
 * asks git nothing, since git would fetch each object it lacks from the
 * remote. A finding it did not get to with git is held to its file alone,
 * as one whose blob and commit this repository lacks is: the file is here
 * and has one of the finding's names in it. It is offered then, and not
 * left out: how many true findings a session hears would otherwise go by
 * how busy the machine was, while the check that is left still drops what
 * is about code that is not here, and the observer picks three at most.
 *
 * What the pass dropped of a teammate's because the code has changed under
 * it on the default branch, the room is told once the briefing is saved: a
 * stale vote, a line of the log that the clock's next round sends
 * (observe.voteStale, which holds every condition of it and has VOTE_MS).
 * No reader's machine then tells the finding, until it is found again.
 *
 * One briefing is shown LIMITS.briefAsk findings with their facts. Where the
 * machine holds more (a team's room does within days), the newest of them
 * would be all a session ever hears of, so the model is first asked which
 * of up to LIMITS.shortAsk, by their titles, are worth reading for this
 * task (SHORT_PROMPT), and the briefing is of the ones it names: two runs
 * for such a prompt. Only what is about a file of this checkout is listed.
 * A shortlist that cannot be read leaves the first of the list, as before.
 * The findings sessions have acted on (`used`), the first LIMITS.provenAsk
 * of them by the share that acted, are not put to the shortlist at all: they
 * go to the briefing beside what it names.
 */
async function briefSession(event) {
  const started = Date.now();
  const spent = nothingSpent();
  const say = (outcome, more = {}) => logLine({ session: event.session, reason: 'prompt', outcome, ...more, ...spentFields(spent, KIND.brief), ms: Date.now() - started });
  // What became of the prompt, in the ledger, whichever way this ends: a prompt that got no briefing says why.
  // `made_ms` is from the prompt's own time to now, which for a briefing is when it could first be said.
  const noted = (outcome, more = {}) => notePrompt(event, outcome, { ...more, ...(spent.runs ? { runs: spent.runs, cost_usd: Math.round(spent.cost_usd * 1e6) / 1e6 } : {}) });
  if (typeof event.text !== 'string' || event.text.trim().length < observe.LIMITS.briefPromptMin) return 'skipped';
  const config = observe.readConfig();
  const state = observe.readState();
  const cap = typeof config.daily_cap === 'number' && config.daily_cap >= 0 ? config.daily_cap : observe.DEFAULT_CONFIG.daily_cap;
  if (state.runs >= cap || state.paused_until > Date.now()) {
    noted('none', { why: state.paused_until > Date.now() ? (state.hold ? 'the observer is held: its command does not answer' : 'the observer is paused') : `the day's cap of ${cap} runs is reached` });
    return 'skipped';
  }
  const top = observe.findTop(event.cwd);
  const facts = top ? observe.gitFacts(top) : NO_REPO;
  if (!facts.top || !facts.key) {
    noted('none', { why: 'not in a repository' });
    return 'skipped';
  }
  noteCheckout(facts.key, facts.top);
  if (sync?.syncRound && !isFresh(observe.readTeam(facts.key)) && !(Date.now() - (askedInVain.get(facts.key) ?? 0) < SYNC_MS)) {
    try {
      await syncRound();
    } catch (err) {
      logLine({ outcome: 'sync', why: brief(err?.message || err) });
    }
    if (isFresh(observe.readTeam(facts.key))) askedInVain.delete(facts.key);
    else askedInVain.set(facts.key, Date.now());
  }
  const told = observe.readTold(event.session);
  let asked = askedModel(config);
  const partial = observe.isPartialClone?.(facts.top) === true;
  // the stale pass's time, counted from when it starts: a shortlist's run comes before it and is not its to spend
  let until = Infinity;
  const stale = [];
  let unchecked = 0;
  /** `findings` without the ones that are not true of this checkout (observe.staleIn). */
  const trueHere = (findings) =>
    findings.filter((finding) => {
      const lookups = !partial && Date.now() < until;
      if (!lookups) unchecked++;
      const why = observe.staleIn(finding, facts.top, { lookups, until });
      if (why) stale.push(finding.id);
      return !why;
    });
  const canShort = typeof observe.renderShortAsk === 'function' && typeof observe.checkShort === 'function' && Number.isInteger(observe.LIMITS.shortAsk);
  const all = observe.briefCandidates(facts.key, { session: event.session, top: facts.top, skip: told.ids, ...(canShort ? { limit: observe.LIMITS.shortAsk } : {}) });
  // more than one briefing can be shown: the model names, by title, the few worth it, and the briefing is of those
  let held = all;
  let from = 0;
  let proven = 0;
  let unread = '';
  if (all.length > observe.LIMITS.briefAsk) {
    // what is about a file that is not here takes no line of the list: a read of the file each, and no git
    const here = all.filter((finding) => !observe.staleIn(finding, facts.top, { lookups: false }));
    held = here.slice(0, observe.LIMITS.briefAsk);
    if (here.length > observe.LIMITS.briefAsk) {
      from = here.length;
      // What sessions acted on has earned its reading, and takes no vote of the shortlist: a title is a poor
      // advocate (the model passed over one that stood first in its list with "acted on 1" beside it, twice).
      // The first few of them, by the share that acted, go to the briefing as they are, with their facts, and
      // the shortlist is asked about the rest.
      const kept = Number.isInteger(observe.LIMITS.provenAsk) ? observe.LIMITS.provenAsk : 0;
      const earned = here.filter((finding) => finding.used > 0).slice(0, kept);
      const rest = earned.length ? here.filter((finding) => !earned.includes(finding)) : here;
      proven = earned.length;
      const short = await askObserver(observe.renderShortAsk(event.text, rest), asked, SHORT_ASK, (reply) => observe.checkShort(reply, rest), { session: event.session, spent });
      if (short.hold) {
        say('paused', { why: short.hold });
        noted('none', { why: HELD_AS_ASKED });
        return 'held';
      }
      // a shortlist that could not be read: the first of the list, as where there is no shortlist
      if (short.value) held = [...earned, ...short.value];
      else unread = short.bad;
    }
  }
  until = Date.now() + STALE_MS;
  const candidates = trueHere(held);
  let votes = 0;
  // `ts` is the prompt's own time, which is what the next prompt's is compared with (briefPrompts); `at` is when this was made
  const save = (ids) => {
    observe.writeBrief(event.session, { v: 1, key: facts.key, top: facts.top, prompt: event.prompt_id ?? null, ts: event.ts, at: Date.now(), ids, asked: candidates.length, stale });
    // With the briefing made, what the pass dropped is looked at once more, for the room: a teammate's finding the
    // default branch's code has changed under is a stale vote in the log, and goes with the clock's next round.
    // Nobody waits for a count, and a vote that could not be cast costs the briefing nothing.
    if (!CAN_VOTE || !stale.length) return;
    try {
      votes = observe.voteStale(facts.key, stale, facts.top, { until: Date.now() + VOTE_MS }).length;
    } catch (err) {
      logLine({ session: event.session, reason: 'prompt', outcome: 'vote', why: brief(err?.message || err) });
    }
  };
  const counts = () => ({ of: candidates.length, stale: stale.length, ...(votes ? { votes } : {}), ...(unchecked ? { unchecked } : {}), ...(from ? { from } : {}), ...(proven ? { proven } : {}), ...(unread ? { shortlist: unread } : {}) });
  if (!candidates.length) {
    save([]);
    say('briefed', { picked: 0, ...counts() });
    noted('briefed', { picked: 0, of: 0 });
    return 'briefed';
  }
  // the picks nobody acted on yet that are not said beside one somebody did (checkBrief)
  const waits = [];
  // the model as it is asked for now: a shortlist's run may have found the pinned one refused
  asked = askedModel(config);
  const picked = await askObserver(observe.renderBriefAsk(event.text, candidates), asked, BRIEF_ASK, (reply) => observe.checkBrief(reply, candidates, { waits }), { session: event.session, spent });
  if (picked.hold) {
    say('paused', { why: picked.hold });
    noted('none', { why: HELD_AS_ASKED });
    return 'held';
  }
  if (picked.value) {
    save(picked.value);
    say('briefed', { picked: picked.value.length, ...(waits.length ? { waits: waits.length } : {}), ...counts() });
    noted('briefed', { picked: picked.value.length, of: candidates.length });
    return 'briefed';
  }
  say('skipped', { why: picked.bad });
  noted('none', { why: 'neither reply could be read' });
  return 'skipped';
}

// Why a prompt got no briefing is said in the ledger in words of this file's own, never in the observer's or the
// CLI's: a reply that could not be read may quote the prompt or a finding, and the ledger holds no word of
// either. What the reply said is in the worker's log, as it always was.
const HELD_AS_ASKED = 'the observer was paused or held as it was asked';

/**
 * A line of the ledger for a prompt: which session's, the prompt's id and its
 * own time, whether it was briefed, and for one that was not, why. One for
 * every prompt a worker looks at, so that the prompts with no briefing can be
 * counted beside the ones with. A worker that starts again while the prompt
 * is still spooled may write its line again: a reader counts a session's
 * prompt once, by its time.
 */
function notePrompt(event, outcome, more = {}) {
  if (!CAN_LEDGER) return;
  observe.ledgerLine({ what: 'prompt', session: event.session, prompt: event.prompt_id ?? null, prompt_ts: event.ts, outcome, ...more, made_ms: Date.now() - event.ts });
}

/**
 * Briefs each session on the newest prompt in its spooled entries that is
 * long enough to be a task, unless this worker or one before it has dealt
 * with it. Only the newest: the session is on that task now, and a briefing
 * for the one before would be said into it. A brief keeps its prompt's own
 * time (`ts`), so a prompt is known as dealt with by a worker that started
 * again, and one that came in while the prompt before it was being briefed
 * is known as newer than that brief, whenever the brief was saved. Never
 * throws.
 */
async function briefPrompts(sessions) {
  if (!CAN_BRIEF) return;
  for (const { entries } of sessions) {
    try {
      if (!observe.isEnabled()) return;
      // not the prompt of a batch put back from dead/ (observe.retryDead): its session has moved on, and is not briefed on it now
      const isTask = ({ event }) => event?.kind === 'prompt' && event.again !== true && typeof event.text === 'string' && event.text.trim().length >= observe.LIMITS.briefPromptMin;
      const event = entries.findLast(isTask)?.event;
      // The session's last prompt, where it is too short to be a task, is said in the ledger once, as one that
      // got no briefing; the task before it, if one is still spooled, is briefed as ever.
      const last = entries.findLast((entry) => entry.event?.kind === 'prompt' && entry.event.again !== true)?.event;
      if (last && last !== event && typeof last.text === 'string') {
        const answers = promptsBriefed.get(last.session) ?? new Set();
        const key = `${last.prompt_id ?? ''}@${last.ts}`;
        if (!answers.has(key)) {
          answers.add(key);
          promptsBriefed.set(last.session, answers);
          notePrompt(last, 'none', { why: `shorter than a task (${observe.LIMITS.briefPromptMin} characters)` });
        }
      }
      if (!event) continue;
      const seen = promptsBriefed.get(event.session) ?? new Set();
      const id = `${event.prompt_id ?? ''}@${event.ts}`;
      if (seen.has(id)) continue;
      seen.add(id);
      promptsBriefed.set(event.session, seen);
      // a worker that started again finds the prompt in the spool, and the brief the one before it made of it
      const made = observe.readBrief(event.session);
      if (made && Number.isFinite(made.ts) && made.ts >= event.ts) continue;
      // A prompt that waited, for a hold, a pause or a worker busy for long, is past the calls a briefing is said
      // before: its session went on without one, or is over. It costs no run, and is said in the ledger as a prompt
      // that got none. A worker that started again may say so a second time; a reader counts a prompt once.
      const oldest = observe.LIMITS.briefPromptAgeMs;
      if (Number.isFinite(oldest) && Date.now() - event.ts > oldest) {
        notePrompt(event, 'none', { why: `over ${Math.round(oldest / 60_000)} minutes old when the worker came to it` });
        continue;
      }
      await briefSession(event);
    } catch (err) {
      logLine({ session: entries[0]?.event?.session, reason: 'prompt', outcome: 'skipped', why: brief(err?.message || err) });
    }
  }
}

// ── a batch ─────────────────────────────────────────────────────────────────

const NO_REPO = { top: null, key: null, repo: null, branch: null, head: null };

/** A closing message this long says something: see `carried` in handleBatch. */
const CLOSING_CHARS = 200;
/** Per session, the turn (its prompt's id) whose batch last passed the gate. Kept while this worker lives. */
const turnsObserved = new Map();
/**
 * What a finding found false takes of observe.mjs. As with the briefing
 * (CAN_BRIEF), this worker may stand beside an observe.mjs from before there
 * was any of it: then the observer is asked about the batch alone, and what
 * it answers is read for observations and for nothing else.
 */
const CAN_REFUTE = ['toldFindings', 'renderTold', 'checkRefuted', 'refuteObservation'].every((name) => typeof observe[name] === 'function');
/**
 * And what counting the findings a session acted on takes of it, on top of
 * that: beside an observe.mjs from before there was a count, a reply is read
 * for observations and refutations as it was, and neither a `told` nor a
 * `use` line is written.
 */
const CAN_USE = CAN_REFUTE && ['checkUsed', 'noteTold', 'noteUsed'].every((name) => typeof observe[name] === 'function');
/**
 * And what naming the teammate's finding a batch would only repeat takes of
 * it. Beside an observe.mjs from before there was any of that, the observer
 * is shown no finding of a teammate's with a batch, and a reply is read as
 * it was: what it found is written down in its own words, and no `seen` line
 * of a teammate's finding is.
 */
const CAN_REPEAT = ['repeatCandidates', 'renderRepeatable', 'checkRepeats', 'noteSeenAgain'].every((name) => typeof observe[name] === 'function');

/**
 * One closed batch, to its end: `skipped` (nothing in it worth a run, or
 * the day's runs for batches are used), `observed`, `dead` (two replies that
 * could not be used, or a run that fails for this batch alone), `held`
 * (observing is paused or held, and the batch stays in the spool exactly as
 * it is: the sweep takes it after a day there, and until then nothing of it
 * is lost to an outage), or `again`: its run exited with an error, and it
 * stays in the spool for the next pass (workBatches).
 *
 * Past the cap a batch is dropped and counted, as it always was, and not kept
 * for the next day: on a machine that makes more batches than the cap, the
 * next day's runs would all go at midnight to the day before's, and nothing
 * done on a day would be observed that day. What an outage would cost is
 * kept by the hold, and a failed run counts against no cap.
 */
async function handleBatch(batch) {
  const started = Date.now();
  // a batch passed over in a pass before this one comes with its runs so far, so its line and its attempts count them
  const before = batch.id ? tried.get(batch.id) : null;
  if (batch.id) tried.delete(batch.id);
  const spent = before?.spent ?? nothingSpent();
  let attempts = before?.attempts ?? 0;
  // `batch` names it in the log by its first spool file, a name and no content: which batch a line is of
  const say = (outcome, more = {}) =>
    logLine({ session: batch.session, reason: batch.reason, outcome, ...(batch.id ? { batch: batch.id } : {}), kept: 0, dropped: [], ...more, ...spentFields(spent, KIND.observe), ms: Date.now() - started });
  const drop = (counter) => {
    observe.dropSpooled(batch.entries);
    observe.updateState((state) => {
      state[counter] += 1;
    });
  };

  // A long turn is cut into batches at LIMITS.batchTools tool calls, and what is
  // left for its last one is often a call or two and the closing message: the
  // agent's own account of what it found. So the end of a turn that was worth
  // a run earlier is worth one too, when it says more than a line.
  const turn = batch.events.find((event) => event.prompt_id)?.prompt_id ?? null;
  const closing = batch.events.find((event) => event.kind === 'stop')?.last ?? '';
  // (`afterSignal`: a batch of the turn before this one in the spool passed the gate, which a batch that waited and is
  // taken newest first comes to before it: lineUp)
  const carried = turn !== null && (turnsObserved.get(batch.session) === turn || batch.afterSignal === true) && closing.length >= CLOSING_CHARS;
  if (!observe.hasSignal(batch.events) && !carried) {
    drop('skipped');
    say('skipped', { why: 'nothing in it worth an observer run' });
    return 'skipped';
  }
  if (turn !== null) turnsObserved.set(batch.session, turn);
  const config = observe.readConfig();
  const state = observe.readState();
  const cap = typeof config.daily_cap === 'number' && config.daily_cap >= 0 ? config.daily_cap : observe.DEFAULT_CONFIG.daily_cap;
  // The pause before the cap: a batch that meets both waits for both.
  if (state.paused_until > Date.now()) {
    // no line is written for it here, so what its runs so far cost goes on with it to the line it gets in the end
    if (before && batch.id) tried.set(batch.id, before);
    return 'held';
  }
  // Batches stop short of the cap by the share kept for briefings: a finding is worth what the sessions told of
  // it make of it, and a day whose runs all went on writing findings down briefs nobody on them.
  const forBatches = CAN_HOLD ? observe.batchCap(cap) : cap;
  if (state.runs >= cap || state.runs - (Number(state.brief_runs) || 0) >= forBatches) {
    drop('skipped');
    say('skipped', { why: state.runs >= cap ? `the day's cap of ${cap} runs is reached` : `batches have had ${forBatches} of the day's ${cap} runs, and the rest are kept for briefings` });
    return 'skipped';
  }

  // The repository is the one the batch's calls work in, which a session that
  // started in another checkout says only by where its files and its `cd`s are.
  const top = observe.batchTop(batch.events);
  const facts = top ? observe.gitFacts(top) : NO_REPO;
  // The repository is at work here: syncing finds its room from this folder,
  // for what this batch comes to and for what the team found, which a
  // session here is told whether or not this machine ever finds anything.
  if (facts.top && facts.key) noteCheckout(facts.key, facts.top);
  const text = observe.renderBatch(batch.events, facts);
  // what the person wrote in this batch, which is what a finding said to be in their words is held to (checkObservations)
  const promptText = batch.events.filter((event) => event.kind === 'prompt' && typeof event.text === 'string').map((event) => event.text).join('\n');
  const touched = batch.events.flatMap((event) => (Array.isArray(event.files) ? event.files : []));
  const asked = askedModel(config);
  // What this session was told so far goes after the batch, for the observer to say which of it the batch shows to
  // be false, and which it shows the agent acting on. A session that was told nothing is asked about the batch
  // alone, as it always was. The section is no part of the batch: a file or a name is kept from a reply only when
  // the batch itself holds it, and a finding said to be in the person's words only when the batch's prompts hold
  // them (checkObservations).
  const told = CAN_REFUTE && facts.key ? observe.toldFindings(facts.key, batch.session, { top: facts.top }) : [];
  const ask = told.length ? `${text}\n\n${observe.renderTold(told)}` : text;
  // And after that, the findings of teammates that share a file or a name with the batch, from the room's file as
  // the last pull left it: where a finding of the batch would only repeat one of them, the observer names that one
  // and the finding is not written a second time. Their numbers go on from the told list's, so a number names one
  // finding of the two lists. Where the room has none such, or does not share, the ask ends as it did.
  const near = CAN_REPEAT && facts.key ? observe.repeatCandidates(facts.key, batch.events, { top: facts.top, session: batch.session }) : [];
  const whole = near.length ? `${ask}\n\n${observe.renderRepeatable(near, told.length)}` : ask;

  let why = '';
  for (let answered = 0; answered < ATTEMPTS; ) {
    // every run that was answered counts against the day's cap, a reply that could not be used included;
    // one that exited with an error counts against nothing, and is not one of the batch's two (observerRun)
    const run = await observerRun(whole, asked, OBSERVE_ASK, { session: batch.session, attempt: ++attempts, spent, batch: batch.id ?? null });
    if (run.held) {
      say('paused', { why: run.held, ...(run.failing ? { failing: run.failing, minutes: Math.round((run.until - Date.now()) / 60_000) } : {}) });
      return 'held';
    }
    // Not asked again at once: the next batch is, and whether the command answers that one tells whether the command
    // or this batch is at fault. This one waits for the next pass (workBatches, observe.noteFailedStart).
    if (run.again) {
      if (batch.id) tried.set(batch.id, { spent, attempts });
      return 'again';
    }
    if (run.blamed) {
      why = `${run.blamed} (and the command answered other runs since this batch's last)`;
      break;
    }
    answered++;
    if (run.bad) {
      why = run.bad;
      continue;
    }
    let checked;
    let refuted;
    let used;
    let again;
    let added = 0;
    try {
      checked = observe.checkObservations(run.out.structured_output, { batchText: text, promptText, touched, top: facts.top, repeatable: near, after: told.length });
      again = CAN_REPEAT ? observe.checkRepeats(run.out.structured_output, near, { after: told.length }) : { kept: [], dropped: [] };
      refuted = CAN_REFUTE ? observe.checkRefuted(run.out.structured_output, told, { top: facts.top }) : { kept: [], dropped: [] };
      used = CAN_USE ? observe.checkUsed(run.out.structured_output, told, { top: facts.top }) : { kept: [], dropped: [] };
      // the model that answered, as the CLI names it, which is not always the name it was asked for by
      const model = usageOf(run.out).model ?? asked;
      const checkoutId = facts.top ? (lib.checkoutId?.(facts.top) ?? null) : null;
      for (const one of checked.kept) {
        const obs = observe.makeObservation(one, { events: batch.events, facts, model, checkoutId });
        if (observe.addObservation(facts.key ?? 'no-repo', obs).added) {
          added++;
          // It is in the log, which is where a round reads from: the next round is
          // the one right after this batch (workSession). Said here and not once
          // the batch is done, so that a finding written before a reply turned out
          // unusable goes too, and once however many the batch logs.
          if (sync?.syncRound) unsent = true;
        }
      }
      // What the batch found that a teammate's finding already states was left out of `checked.kept`, and is a `seen`
      // line under that finding's id: the id and the time, and nothing of the batch. It waits for the clock's next
      // round, as a repeat of this machine's own finding does.
      for (const one of again.kept) observe.noteSeenAgain(facts.key, one.id);
      // What the session was told and found false is a line of the same log, after what the batch found: from
      // here on it is told to no session of this machine, and the room hears of it with the next round.
      for (const one of refuted.kept) {
        observe.refuteObservation(facts.key, one.id, { because: one.because, head: facts.head });
        if (sync?.syncRound) unsent = true;
      }
      // What came of telling, after that. Each finding the observer was shown beside this batch is a `told` line
      // of the log, the first time a batch of this session is observed with it there: it was told, and somebody
      // looked at what came of it. Each one the reply says the batch shows the agent acting on is a `use` line,
      // the first time one does. Which of the session's lines the log holds already, toldFindings said with the
      // findings; a line written is marked on its finding, so a reply asked for again writes none twice. They
      // go to the room with the clock's next round or the one on the way out: nobody waits for a count.
      if (CAN_USE) {
        const shown = new Map(told.map((one) => [one.id, one]));
        const lineOf = (id) => shown.get(id)?.logged ?? {};
        for (const one of told) {
          if (lineOf(one.id).told) continue;
          observe.noteTold(facts.key, one.id, { session: batch.session });
          lineOf(one.id).told = true;
        }
        for (const one of used.kept) {
          if (lineOf(one.id).use) continue;
          observe.noteUsed(facts.key, one.id, { session: batch.session, how: one.how });
          lineOf(one.id).use = true;
        }
      }
    } catch (err) {
      // a reply of the wrong shape, or one that could not be written down: either way not asked for a third time
      why = brief(err?.message || err);
      continue;
    }
    // Only now, with its observations in the log, does the batch leave the spool.
    observe.dropSpooled(batch.entries);
    observe.updateState((s) => {
      s.observations += added;
    });
    say('observed', {
      kept: checked.kept.length,
      dropped: checked.dropped.map((d) => d.reason),
      ...(refuted.kept.length ? { refuted: refuted.kept.length } : {}),
      ...(used.kept.length ? { used: used.kept.length } : {}),
      ...(again.kept.length ? { repeats: again.kept.length } : {}),
    });
    return 'observed';
  }
  observe.writeDead(batch, why);
  drop('dead');
  say('dead', { why });
  return 'dead';
}

/**
 * The batches this worker passed over because their run exited with an error, by id: what their runs so far cost
 * and how many there were, for the line the batch gets when it is done. Kept while this worker lives; a worker
 * that starts again counts from none, as the ledger's lines of a batch are each counted anyway.
 */
const tried = new Map();

/** How long ago a batch closed before it counts as one that waited (lineUp); beside an observe.mjs from before, every batch is fresh, as it was. */
const WAITED_MS = Number.isFinite(observe.LIMITS.waitedMs) ? observe.LIMITS.waitedMs : Infinity;

/**
 * Every closed batch in the spool, in the order they are given a run:
 * { line, open }. First what closed in the last LIMITS.waitedMs, in the
 * order it closed: the work sessions are doing now, whose findings are
 * wanted while they are. Then what waited longer, for a hold, a pause or a
 * worker, the newest first: nearest to that work, and where the day's runs
 * for batches run out before the backlog does, what is dropped at the cap is
 * the oldest. Each session's batches are cut from its entries in order, as
 * ever (observe.takeBatch).
 *
 * A batch is given `id`, its first spool file's name; `closed`, its last
 * event's time; and `afterSignal`, whether a batch of the same turn before it
 * in the spool passed the gate (handleBatch's `carried`). The ones in
 * `passed` are left out. `open` says a batch is still open and will close.
 */
function lineUp(sessions, passed = new Set(), now = Date.now()) {
  const fresh = [];
  const waited = [];
  let open = false;
  for (const { entries } of sessions) {
    let rest = entries;
    const signalled = new Set(); // the turns of this session with a batch so far that passed the gate
    for (let batch = observe.takeBatch(rest, now); batch; batch = observe.takeBatch(rest, now)) {
      rest = rest.slice(batch.entries.length);
      const turn = batch.events.find((event) => event.prompt_id)?.prompt_id ?? null;
      batch.id = path.basename(batch.entries[0].file);
      batch.closed = Number(batch.events.at(-1)?.ts) || 0;
      batch.afterSignal = turn !== null && signalled.has(turn);
      if (turn !== null && observe.hasSignal(batch.events)) signalled.add(turn);
      if (!passed.has(batch.id)) (now - batch.closed > WAITED_MS ? waited : fresh).push(batch);
    }
    // Open: it closes when it is old enough, at the latest. An event with no
    // time on it never is, and is not waited for; the sweep takes it.
    if (rest.length > 0 && now - rest[0].event.ts < observe.LIMITS.batchAgeMs) open = true;
  }
  fresh.sort((a, b) => a.closed - b.closed);
  waited.sort((a, b) => b.closed - a.closed);
  // A batch whose run failed before goes after the others: the try at the end of a hold is then one that has not
  // failed, and whether it is answered says whether the command works (observe.noteFailedStart).
  const failedBefore = new Set(Object.keys(observe.readState().failed_on ?? {}));
  const line = [...fresh, ...waited];
  return { line: [...line.filter((batch) => !failedBefore.has(batch.id)), ...line.filter((batch) => failedBefore.has(batch.id))], open };
}

/**
 * Works down the line of closed batches (lineUp) until it is done or
 * observing is held, and returns whether there is still something to wait
 * for: a batch was dealt with, or one is open and will close. A batch held
 * back by a pause is neither. It is kept, and the worker does not stay up
 * for it: the next one finds it.
 *
 * After a batch that made a run the line is made again from the spool as it
 * is then: a run can take a minute, and what closed meanwhile goes before
 * what waited. A batch whose run exited with an error is passed over for the
 * rest of the pass, and the next one is tried: three of them in a row hold
 * observing, and one that is answered says the command works, and that the
 * batch passed over may be at fault (observe.noteFailedStart).
 *
 * Once a batch meets a pause or a hold, the rest of the line is looked at
 * for what is not worth a run, which is dropped all the same, as it was when
 * each session was walked on its own; a session's batches after one that met
 * it are left as they are, and nothing more is run.
 */
async function workBatches() {
  let busy = false;
  const passed = new Set();
  while (observe.isEnabled()) {
    const { line, open } = lineUp(spooled(), passed);
    if (!line.length) return busy || open;
    let ran = false;
    // the sessions with a batch that met the pause or the hold in this pass: one look each, as when each was walked
    const held = new Set();
    for (const batch of line) {
      if (!observe.isEnabled()) return busy;
      if (held.has(batch.session)) continue;
      const before = observerRuns;
      const outcome = await handleBatch(batch);
      // every way a batch is held leaves the pause in the state, so the batches after it meet it before any run
      if (outcome === 'held') {
        held.add(batch.session);
        continue;
      }
      busy = true;
      // dealt with in this pass, whatever came of it: a batch that left the spool is not in a line again, and one that
      // could not leave it (or was passed over) is not dealt with twice in a pass
      passed.add(batch.id);
      if (observerRuns !== before) {
        ran = true;
        break;
      }
    }
    if (held.size) return busy;
    // between batches: what this one found goes now, and a round the clock says is due does not wait for the next observer run, which can take a minute
    await syncIfDue();
    // and a prompt that came in meanwhile is not left waiting for the other batches
    if (ran) await briefPrompts(spooled());
  }
  return busy;
}

/** The spool files this worker has read, by their paths: one is written once, and is not read again at every look (observe.readSpool). */
const spoolRead = new Map();

function spooled() {
  try {
    return observe.readSpool(spoolRead);
  } catch {
    return []; // a session's folder went between the listing and the read; the next pass sees what is there
  }
}

async function main() {
  if (!observe.isEnabled()) return;
  if (!takeLock()) return;
  held = true;
  await loadSync();

  let swept = 0;
  let idleSince = Date.now();
  while (observe.isEnabled() && holdsLock()) {
    if (Date.now() - swept >= SWEEP_MS) {
      // what waited a day for a pause or a hold to end goes here: said, since it is the one way a batch is still lost
      const took = {};
      const gone = observe.sweepSpool(Date.now(), took);
      if (gone) logLine({ outcome: 'swept', files: gone, why: 'in the spool for over a day' });
      // and from dead/, what nobody tried again within the week it is kept (an install from before kept it for good)
      if (took.dead) logLine({ outcome: 'swept', dead: took.dead, why: `in dead/ for over ${Math.round(observe.LIMITS.deadTtlMs / 86_400_000)} days` });
      // the ledger starts again at its size here, and only here: the one process of its kind on the machine
      observe.rotateLedger?.();
      swept = Date.now();
    }
    await syncIfDue();
    // A prompt first, in every session: its briefing is wanted before the session's next tool call, and a batch can wait.
    await briefPrompts(spooled());
    const busy = await workBatches();
    if (busy) idleSince = Date.now();
    else if (Date.now() - idleSince >= IDLE_MS) break;
    await sleep(POLL_MS);
  }
  // Once more on the way out, so what the last batch found does not wait for
  // the next worker. Not when observing was turned off, which is the person
  // saying stop, nor when the lock went to another worker, which syncs itself.
  if (observe.isEnabled() && holdsLock()) {
    synced = 0;
    await syncIfDue();
  }
}

main().then(() => {
  // nothing is left to keep the process up; `exit` clears the lock
  process.exitCode = 0;
  // but for a round that was given up on and is still waiting for a server:
  // it does not keep this process, and what it had not sent the next worker sends
  setTimeout(() => process.exit(0), 1000).unref?.();
}, crash);
