// An observer command that cannot answer (docs/plans/enrichment-step5-worker-hold.md):
// what the worker owes when `claude -p` is refused, crashes or is past the
// day's cap. Nothing is lost that a day in the spool can keep, a command that
// fails is tried about thirty times a day and not three hundred, and a batch
// in dead/ can be tried again and does not stay for good.
//
// The first half holds observe.mjs to it with a clock of its own, a day in a
// few milliseconds. The second runs the worker as the spool hook starts it,
// over a throwaway AGENTMASH_HOME, with a shell script in place of `claude`
// that answers as a plan file says, one line a run. No test starts the real
// CLI, and none asks a server anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as observe from '../observe.mjs';
import { HOOKS_DIR, baseEnv, within } from './fixtures.mjs';
import { tempDir } from './tmp.mjs';

const WORKER = path.join(HOOKS_DIR, 'observe_worker.mjs');
const posix = { skip: process.platform === 'win32' ? 'the worker is not built for Windows yet' : false };
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// what `claude -p` said on the machine this was built on, 565 times in four days
const REFUSAL = 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';

function freshHome() {
  const home = fs.realpathSync(tempDir('observe-hold-'));
  process.env.AGENTMASH_HOME = home;
  observe.writeConfig({ enabled: true });
  return home;
}

// ── observe.mjs: the hold, by its own clock ─────────────────────────────────

test('the third run in a row that ends without an answer holds observing for a minute, each try that fails after it for twice as long up to an hour, and an answer ends it', () => {
  freshHome();
  const t0 = Date.parse('2026-11-20T08:00:00Z');
  let state = observe.noteFailedStart({ why: 'the observer exited with 3: boom', now: t0 });
  assert.deepEqual([state.failing, state.failed, state.runs, state.hold, state.paused_until], [1, 1, 0, null, 0], 'one failure holds nothing');
  state = observe.noteFailedStart({ why: 'the observer exited with 3: boom', now: t0 + 1 });
  assert.deepEqual([state.failing, state.hold, state.paused_until], [2, null, 0]);
  state = observe.noteFailedStart({ why: 'the observer exited with 3: boom', now: t0 + 2 });
  assert.deepEqual([state.failing, state.failed, state.runs], [3, 3, 0], 'none of them is counted against the cap');
  assert.deepEqual(state.hold, { since: t0 + 2, step: MIN, why: 'the observer exited with 3: boom', access: false });
  assert.equal(state.paused_until, t0 + 2 + MIN);

  // the try at the end of each hold fails too
  const steps = [];
  let now = state.paused_until;
  for (let i = 0; i < 8; i++) {
    state = observe.noteFailedStart({ why: 'the observer exited with 3: boom', now });
    steps.push((state.paused_until - now) / MIN);
    now = state.paused_until;
  }
  assert.deepEqual(steps, [2, 4, 8, 16, 32, 60, 60, 60]);
  assert.equal(state.hold.since, t0 + 2, 'since the run that began it');

  state = observe.noteAnswered({ now });
  assert.deepEqual([state.failing, state.hold, state.runs, state.brief_runs, state.failed], [0, null, 1, 0, 11]);
  // and the next trouble starts from a minute again
  for (let i = 0; i < 3; i++) state = observe.noteFailedStart({ now: now + i });
  assert.equal(state.hold.step, MIN);
});

test('a run that speaks of the sign-in holds at once, and a day of a command that never answers costs under thirty runs where it cost the cap', () => {
  const day = (access) => {
    freshHome();
    const t0 = Date.parse('2026-11-20T00:00:00Z');
    let runs = 0;
    // a worker is there all day with something to observe: it runs the observer whenever nothing holds it
    for (let now = t0; now < t0 + DAY; ) {
      const state = observe.noteFailedStart({ why: access ? `the observer exited with 1: ${REFUSAL}` : 'the observer exited with 3: boom', access, now });
      runs++;
      now = Math.max(now + 1, state.paused_until);
    }
    return { runs, state: observe.readState(Date.parse('2026-11-20T23:59:00Z')) };
  };
  const refused = day(true);
  assert.equal(refused.runs, 29, 'one, then a try after 1, 2, 4, 8, 16 and 32 minutes and one an hour after that');
  assert.equal(refused.state.runs, 0, 'and the cap is untouched for when it works again');
  assert.equal(refused.state.hold.access, true);
  const wordless = day(false);
  assert.equal(wordless.runs, 31, 'two more before the first hold, where nothing says the sign-in is the trouble');
  assert.ok(refused.runs < 30 && wordless.runs < observe.DEFAULT_CONFIG.daily_cap / 9);
});

test('a hold goes on over midnight with what it knows, while the day\'s counters start again', () => {
  freshHome();
  const late = Date.parse('2026-11-20T23:50:00Z');
  observe.noteAnswered({ brief: true, now: late - 1000 });
  for (let i = 0; i < 4; i++) observe.noteFailedStart({ why: 'boom', access: i === 3, now: late + i });
  const before = observe.readState(late + 10);
  assert.deepEqual([before.runs, before.brief_runs, before.failed, before.failing], [1, 1, 4, 4]);
  const after = observe.readState(late + 20 * MIN);
  assert.deepEqual([after.day, after.runs, after.brief_runs, after.failed], ['2026-11-21', 0, 0, 0]);
  assert.deepEqual([after.failing, after.paused_until, after.hold], [4, before.paused_until, before.hold]);
  assert.equal(after.hold.access, true, 'a hold that heard of the sign-in once keeps that');
});

test('batches may take the day\'s cap less the share kept for briefings', () => {
  assert.equal(observe.LIMITS.briefShare, 0.2);
  assert.deepEqual([300, 10, 5, 4, 1, 0].map(observe.batchCap), [240, 8, 4, 4, 1, 0]);
});

test('a batch in dead/ is kept a week and no longer, and the sweep that takes it leaves a newer one', () => {
  freshHome();
  const now = Date.now();
  const batch = (session) => ({ session, events: [observe.spoolEvent('stop', { session_id: session, last_assistant_message: 'done' }, { now })] });
  const old = observe.writeDead(batch('old'), 'boom', now - observe.LIMITS.deadTtlMs - MIN);
  const young = observe.writeDead(batch('young'), 'boom', now - observe.LIMITS.deadTtlMs + MIN);
  // the sweep is the spool's, and goes on to dead/
  observe.writeSpool(observe.spoolEvent('prompt', { session_id: 's', prompt: 'x' }, { now }));
  assert.equal(observe.sweepSpool(now), 0);
  assert.deepEqual([fs.existsSync(old), fs.existsSync(young)], [false, true]);
  assert.equal(observe.deadCount(), 1);
});

test('a batch put back from dead/ is in the spool as the batch it was, in a folder of its own, under names the sweep gives a day', () => {
  freshHome();
  const then = Date.now() - 3 * DAY;
  const events = [
    observe.spoolEvent('prompt', { session_id: 's1', prompt: 'make the release job read the tags of every branch, not only main' }, { now: then }),
    observe.spoolEvent('fail', { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' }, { now: then + 1000 }),
    observe.spoolEvent('stop', { session_id: 's1', last_assistant_message: 'the tests fail' }, { now: then + 2000 }),
  ];
  observe.writeDead({ session: 's1', events }, 'the observer exited with 1', then + 3000);
  observe.writeDead({ session: 's0', events: [] }, 'nothing in it', then + 4000);
  // what the session has spooled since is not run into it
  observe.writeSpool(observe.spoolEvent('prompt', { session_id: 's1', prompt: 'and now the changelog' }));

  assert.equal(observe.retryDead(), 1, 'the one that holds events');
  assert.equal(observe.deadCount(), 0, 'dead/ is empty after it');
  assert.equal(observe.sweepSpool(), 0, 'three days old, and not swept: its files are named as of now');
  const spool = observe.readSpool();
  assert.equal(spool.length, 2);
  const again = spool.find((s) => s.entries.length === 3);
  assert.match(path.basename(path.dirname(again.entries[0].file)), /^again-\d+-s1$/);
  assert.deepEqual(again.entries.map((e) => [e.event.kind, e.event.session, e.event.ts, e.event.again]), events.map((event) => [event.kind, 's1', event.ts, true]));
  const batch = observe.takeBatch(again.entries);
  assert.deepEqual([batch.reason, batch.session, batch.events.length], ['stop', 's1', 3]);
  assert.equal(observe.retryDead(), 0);
});

test('a retry puts back the newest of dead/, no more than it is asked for at one go, each batch whole, and never one twice', () => {
  freshHome();
  const t0 = Date.now() - DAY;
  const batch = (n) => ({ session: `s${n}`, events: [observe.spoolEvent('stop', { session_id: `s${n}`, last_assistant_message: `done ${n}` }, { now: t0 + n })] });
  for (let n = 0; n < 5; n++) observe.writeDead(batch(n), 'boom', t0 + n * 1000);
  assert.equal(observe.LIMITS.retryMost, 60);
  assert.equal(observe.retryDead(Date.now(), { most: 2 }), 2);
  assert.deepEqual(observe.readSpool().map((s) => s.session).sort(), ['s3', 's4'], 'the newest two');
  assert.equal(observe.deadCount(), 3);
  // nothing is left beside the spool
  assert.deepEqual(fs.readdirSync(observe.observePaths().dir).filter((name) => name.startsWith('again-')), []);

  // a retry that stopped after a batch was moved in and before it left dead/: it is in the spool once
  const [kept] = fs.readdirSync(observe.observePaths().dead).filter((name) => name.endsWith('.json')).sort().reverse();
  const there = path.join(observe.observePaths().spool, `again-${kept.slice(0, -'.json'.length)}`);
  fs.mkdirSync(there, { recursive: true });
  fs.writeFileSync(path.join(there, `${String(Date.now()).padStart(15, '0')}-1-abcdef.json`), JSON.stringify(batch(2).events[0]));
  assert.equal(observe.retryDead(Date.now(), { most: 1 }), 1);
  assert.equal(fs.readdirSync(there).length, 1, 'not written a second time');
  assert.equal(observe.deadCount(), 2);
});

test('a batch whose run failed and fails again after the command answered another is blamed, and holds nothing; with nothing answered between, it is the machine', () => {
  freshHome();
  const t0 = Date.parse('2026-11-20T08:00:00Z');
  let state = observe.noteFailedStart({ why: 'boom', batch: 'b1.json', now: t0 });
  assert.deepEqual([state.failing, state.blamed, state.failed_on], [1, undefined, { 'b1.json': 0 }]);
  state = observe.noteFailedStart({ why: 'boom', batch: 'b1.json', now: t0 + 1 });
  assert.deepEqual([state.failing, state.blamed], [2, undefined], 'nothing answered between: still the machine');
  observe.noteAnswered({ now: t0 + 2 });
  state = observe.noteFailedStart({ why: 'boom', batch: 'b1.json', now: t0 + 3 });
  assert.deepEqual([state.blamed, state.failing, state.hold, state.failed, state.failed_on], [true, 0, null, 3, {}]);
  // one that speaks of the sign-in is never the batch's
  observe.noteFailedStart({ why: 'refused', batch: 'b2.json', now: t0 + 4 });
  observe.noteAnswered({ now: t0 + 5 });
  state = observe.noteFailedStart({ why: 'refused', access: true, batch: 'b2.json', now: t0 + 6 });
  assert.deepEqual([state.blamed, state.hold.access], [undefined, true]);
  // a model the CLI will not take holds at once, and says so
  freshHome();
  state = observe.noteFailedStart({ why: 'the selected model', model: true, now: t0 });
  assert.deepEqual([state.hold.step, state.hold.model, state.hold.access], [MIN, true, false]);
  // only the newest batches are remembered
  freshHome();
  for (let n = 0; n < observe.LIMITS.failedOnKeep + 5; n++) observe.noteFailedStart({ batch: `${String(n).padStart(4, '0')}.json`, now: t0 });
  const kept = Object.keys(observe.readState(t0).failed_on).sort();
  assert.deepEqual([kept.length, kept[0]], [observe.LIMITS.failedOnKeep, '0005.json']);
});

test('a pause written while the clock was ahead holds an hour at the most, and what is not a count reads as none', () => {
  freshHome();
  const now = Date.now();
  fs.mkdirSync(observe.observePaths().dir, { recursive: true });
  fs.writeFileSync(observe.observePaths().state, JSON.stringify({ day: '2026-01-01', paused_until: now + 7 * DAY, failing: 'x', answers: -3, failed_on: { 'a.json': 'x', 'b.json': 2 }, hold: { since: now, step: MIN, why: 'boom', access: false } }));
  const state = observe.readState(now);
  assert.equal(state.paused_until, now + observe.LIMITS.holdMaxMs);
  assert.deepEqual([state.failing, state.answers, state.failed_on], [0, 0, { 'b.json': 2 }]);
  assert.equal(observe.noteFailedStart({ why: 'boom', now }).failing, 1, 'and counts on from none, not "x1"');
});

test('the observer\'s model: the pinned id by default and for a saved `haiku`, the alias where it is named so or where this machine\'s CLI refused the id, and a person\'s own as it is', () => {
  freshHome();
  assert.equal(observe.DEFAULT_CONFIG.model, observe.OBSERVER_MODEL);
  assert.equal(observe.observerModel(), observe.OBSERVER_MODEL);
  observe.writeConfig({ model: 'haiku' });
  assert.equal(observe.readConfig().model, observe.OBSERVER_MODEL, 'what `observe on` saved when the alias was the default');
  observe.writeConfig({ model: 'alias:haiku' });
  assert.equal(observe.observerModel(), 'haiku');
  observe.writeConfig({ model: 'claude-sonnet-5-5' });
  assert.equal(observe.observerModel(), 'claude-sonnet-5-5');
  observe.writeConfig({ model: observe.OBSERVER_MODEL });
  observe.noteModelRefused({ model: observe.OBSERVER_MODEL });
  assert.equal(observe.observerModel(), observe.OBSERVER_ALIAS);
  assert.deepEqual([observe.readState().failed, observe.readState().failing, observe.readState().hold], [1, 0, null]);
});

test('a spool that was read is not read again: a look is the listing and the files that are new', () => {
  freshHome();
  const first = observe.writeSpool(observe.spoolEvent('prompt', { session_id: 's1', prompt: 'one' }, { now: Date.now() - 2000 }));
  const read = new Map();
  assert.deepEqual(observe.readSpool(read)[0].entries.map((e) => e.event.text), ['one']);
  assert.deepEqual([...read.keys()], [first]);
  // the file is not opened a second time: what it holds now is not what comes back
  fs.writeFileSync(first, JSON.stringify({ ...read.get(first), text: 'changed on disk' }));
  const second = observe.writeSpool(observe.spoolEvent('prompt', { session_id: 's1', prompt: 'two' }, { now: Date.now() - 1000 }));
  assert.deepEqual(observe.readSpool(read)[0].entries.map((e) => e.event.text), ['one', 'two']);
  assert.deepEqual(observe.readSpool()[0].entries.map((e) => e.event.text), ['changed on disk', 'two'], 'without the Map every file is read');
  // what left the spool leaves the Map
  fs.rmSync(first);
  assert.deepEqual(observe.readSpool(read)[0].entries.map((e) => e.event.text), ['two']);
  assert.deepEqual([...read.keys()], [second]);
  fs.rmSync(observe.observePaths().spool, { recursive: true });
  assert.deepEqual(observe.readSpool(read), []);
  assert.equal(read.size, 0);
});

// ── the worker, with an observer that fails ─────────────────────────────────

const running = new Set();
process.once('exit', () => {
  for (const child of running) child.kill('SIGKILL');
});

const printed = (more) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    api_error_status: null,
    total_cost_usd: 0.00085,
    usage: { input_tokens: 2100, output_tokens: 995 },
    modelUsage: { 'claude-haiku-5-5': { inputTokens: 2100, outputTokens: 995, costUSD: 0.00085 } },
    ...more,
  });

const GOOD = {
  observations: [
    { type: 'cause', title: 'the suite fails until the fixtures are built', facts: ['npm test exits 1 on a checkout whose fixtures were never built.'], files: [], symbols: [], evidence: { kind: 'command', ref: 'npm test' } },
  ],
};

// `claude -p`, as far as the worker can tell: it reads the ask, writes down that it ran and for what, and answers
// as the plan's line for this run says (the last line stands for every run after it)
const FAKE = `#!/bin/sh
cat > /dev/null
n=$(($(wc -l < "$FAKE_DIR/runs") + 1))
mode=$(sed -n "\${n}p" "$FAKE_DIR/plan")
[ -n "$mode" ] || mode=$(tail -n 1 "$FAKE_DIR/plan")
echo "$mode $AGENTMASH_OBSERVER_KIND $AGENTMASH_OBSERVER_MODEL" >> "$FAKE_DIR/runs"
case "$mode" in
  refused) cat "$FAKE_DIR/refused.json"; exit 1 ;;
  login) echo 'Invalid API key · Please run /login'; exit 1 ;;
  turns) cat "$FAKE_DIR/turns.json"; exit 1 ;;
  model)
    if [ "$AGENTMASH_OBSERVER_MODEL" = claude-haiku-5-5 ]; then
      echo "There's an issue with the selected model ($AGENTMASH_OBSERVER_MODEL). It may not exist or you may not have access to it." >&2; exit 1
    fi
    cat "$FAKE_DIR/good.json"; exit 0 ;;
  expired) cat "$FAKE_DIR/expired.json"; exit 0 ;;
  boom) echo boom >&2; exit 3 ;;
  garbage) echo 'Done! Here is what I found.'; exit 0 ;;
  about-login) cat "$FAKE_DIR/about-login.json"; exit 0 ;;
  *) if [ "$AGENTMASH_OBSERVER_KIND" = brief ]; then cat "$FAKE_DIR/brief.json"; else cat "$FAKE_DIR/good.json"; fi; exit 0 ;;
esac
`;

/**
 * A machine with observing on and the fake in place of `claude`: a home of
 * its own, which this process's observe.* calls read and write too. `plan`
 * sets how the fake answers from its next run on, `runs()` is what it wrote
 * down, `log()` the worker's own log.
 */
function freshMachine(config = {}) {
  const home = freshHome();
  observe.writeConfig(config);
  const dir = path.join(home, 'fake');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'observer.sh'), FAKE, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'refused.json'), printed({ is_error: true, result: REFUSAL }));
  fs.writeFileSync(path.join(dir, 'expired.json'), printed({ is_error: true, api_error_status: 401, result: 'API Error: 401 OAuth token has expired' }));
  fs.writeFileSync(path.join(dir, 'about-login.json'), printed({ result: 'The login page signs in through src/login.ts; access is checked there.', structured_output: GOOD }));
  // how `claude -p` ends a run that hit its turn limit: exit 1, and an answer that is an error the model was paid for
  fs.writeFileSync(path.join(dir, 'turns.json'), printed({ subtype: 'error_max_turns', is_error: true, result: 'Reached maximum number of turns (1)' }));
  fs.writeFileSync(path.join(dir, 'good.json'), printed({ structured_output: GOOD }));
  fs.writeFileSync(path.join(dir, 'brief.json'), printed({ structured_output: { picks: [{ n: 1, meets: 'the first edit' }] } }));
  fs.writeFileSync(path.join(dir, 'runs'), '');
  const m = {
    home,
    work: fs.realpathSync(tempDir('observe-hold-work-')), // a folder in no repository
    env: {
      AGENTMASH_HOME: home,
      AGENTMASH_OBSERVER_CMD: JSON.stringify(['/bin/sh', path.join(dir, 'observer.sh')]),
      AGENTMASH_OBSERVE_POLL_MS: '20',
      AGENTMASH_OBSERVE_IDLE_MS: '150',
      FAKE_DIR: dir,
    },
    plan: (...modes) => {
      // the plan counts from the fake's first run: what has run keeps its lines
      const ran = m.runs().map((run) => run.mode);
      fs.writeFileSync(path.join(dir, 'plan'), `${[...ran, ...modes].join('\n')}\n`);
    },
    runs: () => fs.readFileSync(path.join(dir, 'runs'), 'utf8').split('\n').filter(Boolean).map((line) => ({ mode: line.split(' ')[0], kind: line.split(' ')[1], model: line.split(' ')[2] })),
    log: () => {
      try {
        return fs.readFileSync(path.join(observe.observePaths().dir, 'worker.log'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
  m.plan('good');
  return m;
}

/** Runs a worker (the hooks folder's, or the `script` a test made) to its own end and holds it to what every one owes: exit 0, nothing printed, no lock left. */
async function runWorker(m, extra = {}, script = WORKER) {
  const child = spawn(process.execPath, [script], { env: { ...baseEnv, ...m.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(child);
  let said = '';
  child.stdout.on('data', (d) => (said += d));
  child.stderr.on('data', (d) => (said += d));
  const code = await new Promise((resolve, reject) => {
    const limit = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('the worker was still running after 20 s'));
    }, within(20_000));
    child.on('error', reject);
    child.on('close', (exit) => {
      clearTimeout(limit);
      running.delete(child);
      resolve(exit);
    });
  });
  assert.equal(said, '', 'the worker prints nothing');
  assert.equal(code, 0);
  assert.equal(fs.existsSync(observe.observePaths().lock), false, 'the lock is removed on the way out');
}

// every spooled event a millisecond after the one before, all of them a few seconds old
let tick = 0;
const spool = (kind, session, cwd, input = {}) => observe.writeSpool(observe.spoolEvent(kind, { session_id: session, cwd, ...input }, { now: Date.now() - 5000 + tick++ }));

/** A batch worth an observer run: a command that failed and the turn's closing message. Two events. */
function spoolBatch(session, cwd) {
  spool('fail', session, cwd, { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' });
  spool('stop', session, cwd, { last_assistant_message: 'the tests fail' });
}

const spooledCount = () => observe.readSpool().reduce((n, s) => n + s.entries.length, 0);
const counters = () => {
  const { runs, failed, observations, skipped, dead, failing } = observe.readState();
  return { runs, failed, observations, skipped, dead, failing };
};
/** Ends the hold in force without ending what it knows: the next run is its try. */
const holdOver = () =>
  observe.updateState((s) => {
    s.paused_until = Date.now() - 1;
  });

test('a refused sign-in holds observing at the first run: the batch stays in the spool, nothing goes to dead/, nothing is counted against the cap, and nothing more is run while it holds', posix, async () => {
  const m = freshMachine();
  for (const session of ['a', 'b', 'c']) spoolBatch(session, m.work);
  m.plan('refused');

  const before = Date.now();
  await runWorker(m);

  assert.deepEqual(m.runs().map((run) => run.mode), ['refused'], 'one run, and not two a batch');
  assert.equal(spooledCount(), 6, 'every batch waits');
  assert.equal(observe.deadCount(), 0);
  assert.deepEqual(counters(), { runs: 0, failed: 1, observations: 0, skipped: 0, dead: 0, failing: 1 });
  const state = observe.readState();
  assert.ok(state.paused_until >= before + MIN && state.paused_until <= Date.now() + MIN, 'held for a minute');
  assert.deepEqual([state.hold.step, state.hold.access], [MIN, true]);
  assert.match(state.hold.why, /exited with 1: Your organization has disabled Claude subscription access/);
  const [line, ...more] = m.log();
  assert.equal(more.length, 0, 'one line, for the run that was refused: a batch that waits says nothing');
  assert.deepEqual([line.session, line.outcome, line.failing, line.minutes], ['a', 'paused', 1, 1]);
  assert.match(line.why, /disabled Claude subscription access/);

  // a worker that starts while it holds runs nothing
  spoolBatch('d', m.work);
  await runWorker(m);
  assert.equal(m.runs().length, 1);
  assert.equal(spooledCount(), 8);
  assert.equal(m.log().length, 1);
});

test('the words of a sign-in are heard wherever a failed run says them: as text on its stdout, or in an answer that is an error', posix, async () => {
  for (const [mode, why] of [['login', /exited with 1: Invalid API key · Please run \/login/], ['expired', /answered with an error: API Error: 401 OAuth token has expired/]]) {
    const m = freshMachine();
    spoolBatch('a', m.work);
    m.plan(mode);
    await runWorker(m);
    assert.deepEqual(m.runs().map((run) => run.mode), [mode], mode);
    assert.deepEqual(counters(), { runs: 0, failed: 1, observations: 0, skipped: 0, dead: 0, failing: 1 }, mode);
    assert.match(observe.readState().hold.why, why);
    assert.equal(spooledCount(), 2, mode);
  }
});

test('a good reply that talks about a login page and access is no failure', posix, async () => {
  const m = freshMachine();
  spoolBatch('a', m.work);
  m.plan('about-login');
  await runWorker(m);
  assert.deepEqual(counters(), { runs: 1, failed: 0, observations: 1, skipped: 0, dead: 0, failing: 0 });
  assert.equal(observe.readState().hold, null);
  assert.deepEqual(m.log().map((line) => line.outcome), ['observed']);
});

test('a command that exits with an error and says nothing of why is asked again at once, and the third such run in a row holds observing', posix, async () => {
  const m = freshMachine();
  spoolBatch('a', m.work);
  spoolBatch('b', m.work);
  m.plan('boom');

  await runWorker(m);

  assert.deepEqual(m.runs().map((run) => run.mode), ['boom', 'boom', 'boom']);
  assert.equal(spooledCount(), 4, 'both batches wait');
  assert.equal(observe.deadCount(), 0, 'a run that never answered is not a reply that could not be used');
  assert.deepEqual(counters(), { runs: 0, failed: 3, observations: 0, skipped: 0, dead: 0, failing: 3 });
  assert.deepEqual([observe.readState().hold.step, observe.readState().hold.access], [MIN, false]);
  assert.deepEqual(m.log().map((line) => [line.session, line.outcome, line.failing]), [['a', 'paused', 3]]);
  assert.match(m.log()[0].why, /exited with 3: boom/);
});

test('when a hold is over one run tries the command: failing, it holds for twice as long; answered, the hold ends and what waited is observed', posix, async () => {
  const m = freshMachine();
  for (const session of ['a', 'b', 'c']) spoolBatch(session, m.work);
  m.plan('refused');
  await runWorker(m);
  assert.equal(m.runs().length, 1);

  holdOver();
  const before = Date.now();
  await runWorker(m);
  assert.equal(m.runs().length, 2, 'one try, not one a batch');
  let state = observe.readState();
  assert.equal(state.hold.step, 2 * MIN);
  assert.ok(state.paused_until >= before + 2 * MIN && state.paused_until <= Date.now() + 2 * MIN);
  assert.equal(spooledCount(), 6);
  assert.deepEqual(m.log().map((line) => [line.outcome, line.minutes]), [['paused', 1], ['paused', 2]]);

  // the command works again
  holdOver();
  m.plan('good');
  await runWorker(m);
  assert.deepEqual(m.runs().map((run) => run.mode), ['refused', 'refused', 'good', 'good', 'good']);
  state = observe.readState();
  assert.deepEqual([state.hold, state.failing], [null, 0]);
  assert.deepEqual(counters(), { runs: 3, failed: 2, observations: 1, skipped: 0, dead: 0, failing: 0 });
  assert.deepEqual(observe.readSpool(), [], 'every batch of the outage was observed');
  assert.equal(observe.deadCount(), 0);
  // the try at the end of each hold was a batch that had not failed yet (a, then b): c goes first, the two after it
  assert.deepEqual(m.log().slice(0, 2).map((line) => line.session), ['a', 'b']);
  assert.deepEqual(m.log().slice(2).map((line) => [line.session, line.outcome]), [['c', 'observed'], ['a', 'observed'], ['b', 'observed']]);
});

test('a run that exits with an error is not one of a batch\'s two, and the next batch is tried, not the same one again', posix, async () => {
  const m = freshMachine();
  spoolBatch('a', m.work);
  spoolBatch('b', m.work);
  // a: an exit; b: a good reply; then a, on the next pass: no JSON, twice
  m.plan('boom', 'good', 'garbage', 'garbage', 'good');

  await runWorker(m);

  assert.deepEqual(m.runs().map((run) => run.mode), ['boom', 'good', 'garbage', 'garbage']);
  assert.deepEqual(counters(), { runs: 3, failed: 1, observations: 1, skipped: 0, dead: 1, failing: 0 });
  assert.deepEqual(m.log().map((line) => [line.session, line.outcome]), [['b', 'observed'], ['a', 'dead']]);
  assert.match(m.log()[1].why, /not JSON/);
  assert.equal(observe.readState().hold, null, 'an answer between two failures: nothing is held');
});

test('a batch whose run exits with an error again after the command answered another goes to dead/: the batch fails, not the machine', posix, async () => {
  const m = freshMachine();
  spoolBatch('a', m.work);
  spoolBatch('b', m.work);
  spoolBatch('c', m.work);
  // a fails, b and c are answered, and a fails again on the next pass
  m.plan('boom', 'good', 'good', 'boom', 'good');

  await runWorker(m);

  assert.deepEqual(m.runs().map((run) => run.mode), ['boom', 'good', 'good', 'boom'], 'two runs for the batch, as two replies would have been');
  assert.deepEqual(counters(), { runs: 2, failed: 2, observations: 1, skipped: 0, dead: 1, failing: 0 });
  assert.deepEqual([observe.readState().hold, observe.readState().paused_until], [null, 0], 'nothing is held for it');
  assert.deepEqual(m.log().map((line) => [line.session, line.outcome]), [['b', 'observed'], ['c', 'observed'], ['a', 'dead']]);
  assert.match(m.log()[2].why, /exited with 3: boom \(and the command answered other runs since this batch's last\)/);
  assert.equal(observe.deadCount(), 1);
  assert.deepEqual(observe.readSpool(), []);

  // what comes after it is observed as ever
  spoolBatch('d', m.work);
  await runWorker(m);
  assert.deepEqual(m.log().at(-1).outcome, 'observed');
});

test('an answer that is an error the model was paid for is a reply that cannot be used, whatever the exit: two of them and the batch is dead, and nothing is held', posix, async () => {
  const m = freshMachine();
  spoolBatch('a', m.work);
  spoolBatch('b', m.work);
  m.plan('turns', 'turns', 'good');

  await runWorker(m);

  assert.deepEqual(m.runs().map((run) => run.mode), ['turns', 'turns', 'good']);
  assert.deepEqual(counters(), { runs: 3, failed: 0, observations: 1, skipped: 0, dead: 1, failing: 0 });
  assert.equal(observe.readState().hold, null);
  assert.deepEqual(m.log().map((line) => [line.session, line.outcome]), [['a', 'dead'], ['b', 'observed']]);
  assert.match(m.log()[0].why, /answered with an error: Reached maximum number of turns/);
});

test('what closed last goes first: fresh batches in the order they closed, then those that waited, the newest first, and the cap drops the oldest', posix, async () => {
  const m = freshMachine({ daily_cap: 2 });
  const at = (kind, session, ts, input) => observe.writeSpool(observe.spoolEvent(kind, { session_id: session, cwd: m.work, ...input }, { now: ts }));
  const batchAt = (session, ts) => {
    at('fail', session, ts, { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' });
    at('stop', session, ts + 1, { last_assistant_message: 'the tests fail' });
  };
  // two that waited through an outage, and one that closed a moment ago
  batchAt('old', Date.now() - 3 * HOUR);
  batchAt('older', Date.now() - 4 * HOUR);
  batchAt('now', Date.now() - 5000);
  assert.ok(observe.LIMITS.waitedMs < HOUR);

  await runWorker(m);

  assert.deepEqual(m.log().map((line) => [line.session, line.outcome]), [['now', 'observed'], ['old', 'observed'], ['older', 'skipped']]);
  assert.match(m.log()[2].why, /the day's cap of 2 runs is reached/);
  assert.match(m.log()[0].batch, /^\d{15}-\d+-[0-9a-f]{6}\.json$/, 'a line names its batch by its first spool file');
  assert.deepEqual(observe.readSpool(), [], 'past the cap a batch is dropped, as it always was');
  assert.deepEqual(counters(), { runs: 2, failed: 0, observations: 1, skipped: 1, dead: 0, failing: 0 });
});

test('a usage limit met while the command is held ends the hold and pauses for half an hour, as a limit does', posix, async () => {
  const m = freshMachine();
  spoolBatch('a', m.work);
  for (let i = 0; i < 4; i++) observe.noteFailedStart({ why: 'boom' });
  assert.equal(observe.readState().hold.step, 2 * MIN);
  holdOver();
  // Claude Code's own words on stderr, and a non-zero exit: the fake's `boom` says boom, so the limit is said through a command of its own
  const limit = path.join(m.home, 'limit.sh');
  fs.writeFileSync(limit, '#!/bin/sh\ncat > /dev/null\necho "Claude AI usage limit reached|1763150400" >&2\nexit 1\n', { mode: 0o755 });
  const before = Date.now();
  await runWorker(m, { AGENTMASH_OBSERVER_CMD: JSON.stringify(['/bin/sh', limit]) });
  const state = observe.readState();
  assert.ok(state.paused_until >= before + 30 * MIN);
  assert.deepEqual([state.hold, state.failing, state.runs], [null, 0, 0]);
  assert.equal(spooledCount(), 2);
});

test('past the day\'s cap a batch is dropped and counted, as it always was, and the next day\'s runs are not spent on the day before\'s', posix, async () => {
  const m = freshMachine({ daily_cap: 2 });
  for (const session of ['a', 'b', 'c', 'd']) spoolBatch(session, m.work);

  await runWorker(m);

  assert.equal(m.runs().length, 2);
  assert.deepEqual(counters(), { runs: 2, failed: 0, observations: 1, skipped: 2, dead: 0, failing: 0 });
  assert.deepEqual(observe.readSpool(), []);
  assert.deepEqual(m.log().map((line) => [line.session, line.outcome]), [['a', 'observed'], ['b', 'observed'], ['c', 'skipped'], ['d', 'skipped']]);
  assert.match(m.log()[2].why, /the day's cap of 2 runs is reached/);

  // midnight: the counters are yesterday's, and the day's first batch has its run at once
  fs.writeFileSync(observe.observePaths().state, JSON.stringify({ ...observe.readState(), day: '2026-01-01' }));
  spoolBatch('e', m.work);
  await runWorker(m);
  assert.equal(m.runs().length, 3);
  assert.deepEqual(m.log().slice(4).map((line) => [line.session, line.outcome]), [['e', 'observed']]);
});

test('a batch that meets a pause and the cap at once waits for the pause: the pause is looked at first, and nothing is deleted while it lasts', posix, async () => {
  const m = freshMachine({ daily_cap: 0 });
  spoolBatch('a', m.work);
  observe.updateState((s) => {
    s.paused_until = Date.now() + 30 * MIN;
  });
  await runWorker(m);
  assert.deepEqual([m.runs().length, spooledCount(), m.log().length], [0, 2, 0]);
});

/** A committed repository with src/tags.ts in it, and a finding of an earlier session about it in this machine's log. */
function repoWithFinding() {
  const top = fs.realpathSync(tempDir('observe-hold-repo-'));
  const gitconfig = path.join(tempDir('observe-hold-git-'), 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  const git = (...args) => execFileSync('git', args, { cwd: top, env: { ...baseEnv, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'bob@example.com');
  git('config', 'user.name', 'bob');
  fs.mkdirSync(path.join(top, 'src'));
  fs.writeFileSync(path.join(top, 'src/tags.ts'), 'export const getLatestTag = () => 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const ts = Date.now() - HOUR;
  const obs = { id: 'o_1', ts, session_id: 'earlier', type: 'cause', title: 'getLatestTag walks only the history of HEAD', facts: ['It runs git describe, which sees no tag of an unmerged branch.'], files: ['src/tags.ts'], symbols: ['getLatestTag'], agent: 'claude-code', branch: 'main', seen: 1 };
  assert.deepEqual(observe.addObservation(observe.gitFacts(top).key, obs, ts), { added: 'o_1' });
  return top;
}

const TASK = 'make getLatestTag see the tags on unmerged branches too, and keep the release job green';

test('batches stop at their share of the day\'s cap, and a prompt is still briefed from what is kept for it', posix, async () => {
  const m = freshMachine({ daily_cap: 5 }); // four for batches, one kept
  const top = repoWithFinding();
  for (const session of ['a', 'b', 'c', 'd', 'e', 'f']) spoolBatch(session, m.work);

  await runWorker(m);
  assert.deepEqual([m.runs().length, observe.readState().runs, observe.readState().brief_runs], [4, 4, 0]);
  assert.deepEqual(m.log().slice(4).map((line) => [line.session, line.outcome]), [['e', 'skipped'], ['f', 'skipped']]);
  assert.match(m.log().at(-1).why, /batches have had 4 of the day's 5 runs, and the rest are kept for briefings/);

  // a prompt comes in: its briefing is the fifth run
  observe.writeSpool(observe.spoolEvent('prompt', { session_id: 'p', cwd: top, prompt: TASK, prompt_id: 'p1' }, { now: Date.now() - 3000 }));
  observe.writeSpool(observe.spoolEvent('stop', { session_id: 'p', cwd: top, last_assistant_message: 'done' }, { now: Date.now() - 2999 }));
  await runWorker(m);
  assert.deepEqual(m.runs().map((run) => run.kind), ['observe', 'observe', 'observe', 'observe', 'brief']);
  assert.deepEqual(observe.readBrief('p').ids, ['o_1']);
  assert.deepEqual([observe.readState().runs, observe.readState().brief_runs], [5, 1]);
});

test('a prompt that waited longer than a briefing is worth is not briefed: no run, and a ledger line that says why', posix, async () => {
  const m = freshMachine();
  const top = repoWithFinding();
  const old = Date.now() - observe.LIMITS.briefPromptAgeMs - MIN;
  observe.writeSpool(observe.spoolEvent('prompt', { session_id: 'late', cwd: top, prompt: TASK, prompt_id: 'p-late' }, { now: old }));
  observe.writeSpool(observe.spoolEvent('stop', { session_id: 'late', cwd: top, last_assistant_message: 'done' }, { now: old + 1 }));
  observe.writeSpool(observe.spoolEvent('prompt', { session_id: 'now', cwd: top, prompt: TASK, prompt_id: 'p-now' }, { now: Date.now() - 2000 }));
  observe.writeSpool(observe.spoolEvent('stop', { session_id: 'now', cwd: top, last_assistant_message: 'done' }, { now: Date.now() - 1999 }));

  await runWorker(m);

  assert.deepEqual(m.runs().map((run) => run.kind), ['brief'], 'one briefing, for the prompt of a moment ago');
  assert.equal(observe.readBrief('late'), null);
  assert.deepEqual(observe.readBrief('now').ids, ['o_1']);
  const lines = observe.readLedger().filter((line) => line.what === 'prompt');
  const late = lines.find((line) => line.session === 'late');
  assert.deepEqual([late.prompt, late.outcome], ['p-late', 'none']);
  assert.match(late.why, /^over 5 minutes old when the worker came to it$/);
  assert.equal(lines.find((line) => line.session === 'now').outcome, 'briefed');
});

test('where the CLI will not take the pinned model id, the alias it was pinned from is asked for from then on, at once and with nothing held', posix, async () => {
  const m = freshMachine();
  spoolBatch('a', m.work);
  m.plan('model');

  await runWorker(m);

  assert.deepEqual(m.runs().map((run) => run.model), [observe.OBSERVER_MODEL, observe.OBSERVER_ALIAS]);
  assert.deepEqual(m.log().map((line) => line.outcome), ['observed']);
  const state = observe.readState();
  assert.deepEqual([state.refused_model, state.hold, state.paused_until, state.failing, state.failed], [observe.OBSERVER_MODEL, null, 0, 0, 1]);
  assert.equal(observe.observerModel(), observe.OBSERVER_ALIAS);
  assert.deepEqual(observe.readLedger().filter((line) => line.what === 'run').map((line) => [line.asked, line.answer]), [[observe.OBSERVER_MODEL, 'failed'], [observe.OBSERVER_ALIAS, 'answered']]);

  // `observe retry` asks for the pinned id again
  observe.askRetry();
  assert.equal(observe.observerModel(), observe.OBSERVER_MODEL);
});

test('a batch put back from dead/ is observed as it was, and its prompt is not briefed: the session has moved on', posix, async () => {
  const m = freshMachine();
  const top = repoWithFinding();
  const then = Date.now() - 2 * DAY;
  const events = [
    observe.spoolEvent('prompt', { session_id: 's1', cwd: top, prompt: TASK, prompt_id: 'p1' }, { now: then }),
    observe.spoolEvent('fail', { session_id: 's1', cwd: top, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' }, { now: then + 1000 }),
    observe.spoolEvent('stop', { session_id: 's1', cwd: top, last_assistant_message: 'the tests fail' }, { now: then + 2000 }),
  ];
  observe.writeDead({ session: 's1', events }, `the observer exited with 1: ${REFUSAL}`, then + 3000);
  assert.equal(observe.retryDead(), 1);

  await runWorker(m);

  assert.deepEqual(m.runs().map((run) => run.kind), ['observe'], 'no briefing for a prompt two days old');
  assert.equal(observe.readBrief('s1'), null);
  assert.deepEqual(m.log().map((line) => [line.session, line.reason, line.outcome]), [['s1', 'stop', 'observed']]);
  assert.deepEqual([observe.readSpool(), observe.deadCount()], [[], 0]);
});

test('what the sweep takes from the spool is said in the log: the one way a batch that waited is still lost', posix, async () => {
  const m = freshMachine();
  const old = Date.now() - observe.LIMITS.spoolTtlMs - MIN;
  observe.writeSpool(observe.spoolEvent('fail', { session_id: 'old', cwd: m.work, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' }, { now: old }));
  observe.writeSpool(observe.spoolEvent('stop', { session_id: 'old', cwd: m.work, last_assistant_message: 'the tests fail' }, { now: old + 1 }));
  await runWorker(m);
  assert.equal(m.runs().length, 0);
  assert.deepEqual(m.log().map((line) => [line.outcome, line.files]), [['swept', 2]]);
});

test('a worker beside an observe.mjs from before the hold counts an exit as a reply that cannot be used, and drops a batch past the cap, as it did', posix, async () => {
  const dir = fs.realpathSync(tempDir('observe-hold-old-'));
  for (const name of ['observe_worker.mjs', 'observe_sync.mjs', 'lib.mjs']) fs.copyFileSync(path.join(HOOKS_DIR, name), path.join(dir, name));
  fs.copyFileSync(path.join(HOOKS_DIR, 'observe.mjs'), path.join(dir, 'observe_today.mjs'));
  const added = ['noteFailedStart', 'noteAnswered', 'batchCap', 'retryDead', 'observerModel', 'noteModelRefused', 'askRetry', 'rotateLedger'];
  for (const name of added) assert.ok(name in observe, `observe.mjs exports ${name}`);
  fs.writeFileSync(path.join(dir, 'observe.mjs'), ["export * from './observe_today.mjs';", ...added.map((name) => `export const ${name} = undefined;`), ''].join('\n'));
  const old = path.join(dir, 'observe_worker.mjs');

  const m = freshMachine();
  spoolBatch('a', m.work);
  m.plan('boom');
  await runWorker(m, {}, old);
  assert.deepEqual(m.runs().map((run) => run.mode), ['boom', 'boom']);
  assert.deepEqual([observe.readState().runs, observe.readState().dead, observe.readState().paused_until], [2, 1, 0]);
  assert.deepEqual(m.log().map((line) => line.outcome), ['dead']);

  const capped = freshMachine({ daily_cap: 0 });
  spoolBatch('a', capped.work);
  await runWorker(capped, {}, old);
  assert.deepEqual([capped.runs().length, spooledCount(), observe.readState().skipped], [0, 0, 1]);
  assert.match(capped.log()[0].why, /cap of 0/);
});

// ── what the person is told: `observe status`, and `observe retry` ──────────

const CLI = path.join(HOOKS_DIR, '..', 'cli', 'agentmash.mjs');
// preloaded into the CLI: the first use of the network ends it with exit code 97
const NO_NETWORK = pathToFileURL(path.join(HOOKS_DIR, '..', 'cli', 'test', 'fixtures', 'no-network.mjs')).href;

/** Runs the CLI on the machine whose home is `home`, with no `claude` to find and no network to use: { code, stdout, stderr }. */
function cli(home, ...args) {
  const none = path.join(home, 'no-tools');
  fs.mkdirSync(none, { recursive: true });
  const env = { ...baseEnv, AGENTMASH_HOME: home, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), AGENTMASH_TOOL_PATH: none, NO_COLOR: '1', NODE_OPTIONS: `--import=${NO_NETWORK}` };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('observe status says a refused command is held, since when, what it said and what to do, and observe retry ends the hold and puts the dead batches back', async () => {
  const home = freshHome();
  const batch = { session: 's1', events: [observe.spoolEvent('stop', { session_id: 's1', last_assistant_message: 'done' })] };
  observe.writeDead(batch, 'boom');
  observe.writeDead({ ...batch, session: 's2' }, 'boom', Date.now() + 1);
  observe.noteAnswered();
  observe.noteFailedStart({ why: `the observer exited with 1: ${REFUSAL}`, access: true });
  observe.noteFailedStart({ why: `the observer exited with 1: ${REFUSAL}`, access: true, now: Date.now() + MIN });

  const held = await cli(home, 'observe', 'status');
  assert.equal(held.code, 1, held.stderr);
  assert.match(held.stdout, /! 2 dead batches, which the observer failed on twice: npx agentmash observe retry tries them again, within a week/);
  assert.match(held.stdout, /· observer runs today: 1 of 300 · 0 batches skipped · 0 observations added · 2 runs without an answer\n/);
  assert.match(held.stdout, /✗ the observer is held until \d\d:\d\d: its command was refused for its sign-in or its access, 2 runs in a row since [^,]+, and what is spooled waits, a day at most\n {4}the observer exited with 1: Your organization has disabled Claude subscription access[^\n]*\n {4}sign in again \(run claude\), then npx agentmash observe retry tries it at once\n/);
  assert.doesNotMatch(held.stdout, /usage limit/);

  const retry = await cli(home, 'observe', 'retry');
  assert.equal(retry.code, 0, retry.stderr);
  assert.match(retry.stdout, /✓ 2 batches the observer failed on are back in the spool, to be observed again\n {2}✓ the hold on the observer is over: its next run tries the command\n/);
  assert.equal(observe.deadCount(), 0);
  assert.equal(observe.readSpool().length, 2);
  const state = observe.readState();
  assert.equal(state.paused_until, 0, 'nothing holds the next run');
  assert.deepEqual([state.hold.step, state.failing], [2 * MIN, 2], 'and it is still the try of a command that was failing: one run, and twice as long if it fails');

  const after = await cli(home, 'observe', 'status');
  assert.match(after.stdout, /· no dead batches/);
  assert.match(after.stdout, /✗ the observer is tried again with its next run: its command was refused/);

  const nothing = await cli(freshHome(), 'observe', 'retry');
  assert.equal(nothing.code, 0);
  assert.match(nothing.stdout, /· nothing to retry: no dead batches, and the observer is not held/);

  // a command that exits with an error and says nothing of a sign-in is a warning, with nothing to sign in to
  const other = freshHome();
  for (let i = 0; i < 3; i++) observe.noteFailedStart({ why: 'the observer exited with 3: boom' });
  const wordless = await cli(other, 'observe', 'status');
  assert.match(wordless.stdout, /! the observer is held until \d\d:\d\d: its command exits with an error, 3 runs in a row since [^,]+, and what is spooled waits, a day at most\n {4}the observer exited with 3: boom\n {4}npx agentmash observe retry tries it at once\n/);

  // a model the CLI will not take, the pinned id and then its alias: said by its name, with no sign-in to ask for
  const modelless = freshHome();
  observe.noteModelRefused({ model: observe.OBSERVER_MODEL });
  observe.noteFailedStart({ why: "the observer exited with 1: There's an issue with the selected model (haiku). It may not exist or you may not have access to it.", model: true });
  const model = await cli(modelless, 'observe', 'status');
  assert.match(model.stdout, /✗ the observer is held until \d\d:\d\d: its command does not take the model haiku, 1 run in a row since [^,]+, and what is spooled waits, a day at most\n[^\n]*selected model \(haiku\)[^\n]*\n {4}name a model it takes in [^\n]*observe\.json \("model": "alias:haiku" asks for the alias\), then npx agentmash observe retry tries it at once\n/);
  assert.doesNotMatch(model.stdout, /sign in again/);
  assert.match(model.stdout, /· the observer asks for the model haiku: this machine's claude does not take claude-haiku-5-5, and npx agentmash observe retry asks for it again\n/);

  // and a usage limit's pause is said as it always was
  const limited = freshHome();
  observe.updateState((s) => {
    s.paused_until = Date.now() + 20 * MIN;
  });
  assert.match((await cli(limited, 'observe', 'status')).stdout, /! the observer is paused until \d\d:\d\d: it reached a usage limit, and what is spooled waits\n/);
});

