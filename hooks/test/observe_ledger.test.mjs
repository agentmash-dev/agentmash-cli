// The ledger (observe.ledgerLine, docs/plans/enrichment-step5-worker-hold.md):
// what the engine's own model runs cost, what became of each prompt's
// briefing, and what the hooks put into a session's context, a line each in
// ~/.agentmash/observe/ledger.jsonl. What these tests hold it to: every
// observer run leaves a line with the tokens and dollars the CLI reported,
// a prompt that got no briefing leaves one that says why, a note leaves one
// with its length and its findings' ids, a briefing's line says before which
// call and under which prompt it was said, and none of it holds a word of a
// prompt or a finding, or is ever sent to a room.
//
// The worker and the recall hook run as they do on a machine, over a
// throwaway AGENTMASH_HOME, with a shell script in place of `claude` that
// answers each kind of run with a usage of its own. No test starts the real
// CLI, and none asks a server anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import * as observe from '../observe.mjs';
import { HOOKS_DIR, baseEnv, runHook, within } from './fixtures.mjs';
import { tempDir } from './tmp.mjs';

const WORKER = path.join(HOOKS_DIR, 'observe_worker.mjs');
const posix = { skip: process.platform === 'win32' ? 'the worker is not built for Windows yet' : false };
const MIN = 60_000;
const TASK = 'make getLatestTag see the tags on unmerged branches too, and keep the release job green';

function freshHome() {
  const home = fs.realpathSync(tempDir('observe-ledger-'));
  process.env.AGENTMASH_HOME = home;
  observe.writeConfig({ enabled: true });
  return home;
}

// ── observe.mjs: the file, the model's name, where a turn stands ────────────

test('a line of the ledger is one JSON object with its time, in a file only its owner reads, and the worker starts the ledger again at 4 MB with the old one kept: a hook never moves it', () => {
  freshHome();
  const { ledger } = observe.observePaths();
  assert.deepEqual(observe.readLedger(), []);
  observe.ledgerLine({ what: 'run', kind: 'batch', tokens_in: 3 }, Date.parse('2026-11-20T08:00:00Z'));
  observe.ledgerLine({ what: 'note', kind: 'index', chars: 12 }, Date.parse('2026-11-20T08:00:01Z'));
  assert.deepEqual(observe.readLedger(), [
    { ts: '2026-11-20T08:00:00.000Z', what: 'run', kind: 'batch', tokens_in: 3 },
    { ts: '2026-11-20T08:00:01.000Z', what: 'note', kind: 'index', chars: 12 },
  ]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(ledger).mode & 0o777, 0o600);

  // under 4 MB nothing is moved
  assert.equal(observe.rotateLedger(), false);
  // over it a hook's line goes on the file as it is: two hooks that each moved a full file would put the new one over
  // the one just kept. The worker moves it, with its sweep, and the next line starts a new file.
  fs.appendFileSync(ledger, `${' '.repeat(4 * 1024 * 1024)}\n`);
  observe.ledgerLine({ what: 'note', kind: 'briefing' }, Date.parse('2026-11-20T08:30:00Z'));
  assert.equal(fs.existsSync(`${ledger}.1`), false);
  assert.equal(observe.rotateLedger(), true);
  assert.equal(fs.existsSync(ledger), false);
  observe.ledgerLine({ what: 'run', kind: 'briefing' }, Date.parse('2026-11-20T09:00:00Z'));
  assert.equal(fs.readFileSync(ledger, 'utf8'), '{"ts":"2026-11-20T09:00:00.000Z","what":"run","kind":"briefing"}\n');
  assert.deepEqual(observe.readLedger().map((line) => line.kind), ['batch', 'index', 'briefing', 'briefing']);
});

test('a ledger that cannot be written stops nothing', () => {
  const home = freshHome();
  // where the observe folder would be, a file stands
  fs.rmSync(path.join(home, '.agentmash', 'observe'), { recursive: true, force: true });
  fs.writeFileSync(path.join(home, '.agentmash', 'observe'), 'in the way');
  assert.doesNotThrow(() => observe.ledgerLine({ what: 'run' }));
  assert.deepEqual(observe.readLedger(), []);
});

test('the observer\'s model is named by its id: the default names it, a config saved with the alias reads as it, and a name the person chose is kept', () => {
  freshHome();
  assert.equal(observe.OBSERVER_MODEL, 'claude-haiku-5-5');
  assert.equal(observe.DEFAULT_CONFIG.model, observe.OBSERVER_MODEL);
  assert.equal(observe.readConfig().model, 'claude-haiku-5-5');
  // what `observe on` saved while the alias was the default
  fs.writeFileSync(observe.observePaths().config, JSON.stringify({ enabled: true, observer: 'claude', model: 'haiku', daily_cap: 300 }));
  assert.deepEqual(observe.readConfig(), { enabled: true, observer: 'claude', model: 'claude-haiku-5-5', daily_cap: 300 });
  observe.writeConfig({ model: 'sonnet' });
  assert.equal(observe.readConfig().model, 'sonnet');
});

test('which call of its turn a briefing is said before is one more than the calls spooled since its prompt, and unknown once the prompt has left the spool or a later one is in it', () => {
  freshHome();
  const t0 = Date.now() - 10_000;
  const brief = { prompt: 'p1', ts: t0 };
  const event = (kind, at, more = {}) => observe.writeSpool(observe.spoolEvent(kind, { session_id: 's1', cwd: '/nowhere', prompt_id: 'p1', ...more }, { now: at }));

  assert.deepEqual(observe.briefedAt('s1', brief), { call: null, same: null }, 'nothing spooled says nothing');
  const prompt = event('prompt', t0, { prompt: TASK });
  assert.deepEqual(observe.briefedAt('s1', brief), { call: 1, same: true }, 'before the first call');
  event('tool', t0 + 100, { tool_name: 'Read', tool_input: { file_path: 'a.ts' }, tool_response: {} });
  event('fail', t0 + 200, { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' });
  assert.deepEqual(observe.briefedAt('s1', brief), { call: 3, same: true }, 'a call that failed is a call');
  assert.deepEqual(observe.briefedAt('s1', brief, { prompt_id: 'p1' }), { call: 3, same: true });
  // the call says it belongs to another prompt: its id is believed over the spool
  assert.deepEqual(observe.briefedAt('s1', brief, { prompt_id: 'p2' }), { call: null, same: false });
  // a later prompt in the spool, where the call carries no id
  event('prompt', t0 + 300, { prompt: 'and the changelog', prompt_id: 'p2' });
  assert.deepEqual(observe.briefedAt('s1', brief), { call: null, same: false });
  assert.deepEqual(observe.briefedAt('s1', { prompt: 'p2', ts: t0 + 300 }), { call: 1, same: true }, 'the later prompt\'s own briefing counts from it');
  // the worker took the turn's first batch: where the turn stood can no longer be told, but the ids still say whose it is
  fs.rmSync(prompt);
  assert.deepEqual(observe.briefedAt('s2', brief), { call: null, same: null });
  assert.deepEqual(observe.briefedAt('s2', brief, { prompt_id: 'p1' }), { call: null, same: true });
  assert.deepEqual(observe.briefedAt('s1', {}), { call: null, same: null }, 'a brief with no time of its prompt');
});

/** A finding of an earlier session in a repository's log, `minutes` old. */
function found(key, id, title, minutes, more = {}) {
  const ts = Date.now() - minutes * MIN;
  const obs = { id, ts, session_id: 'earlier', type: 'cause', title, facts: [`${title}, in detail.`], files: ['src/tags.ts'], symbols: ['getLatestTag'], agent: 'claude-code', branch: 'main', seen: 1, ...more };
  assert.deepEqual(observe.addObservation(key, obs, ts), { added: id });
}

test('the index gives the ids of the findings it says, in its order, and says what it said without them', () => {
  freshHome();
  found('acme__app', 'o_old', 'the release job reads tags from main', 60);
  found('acme__app', 'o_new', 'getLatestTag walks only the history of HEAD', 30);
  const plain = observe.recallIndex('acme__app', { branch: 'main' });
  const ids = [];
  assert.equal(observe.recallIndex('acme__app', { branch: 'main', ids }), plain);
  assert.deepEqual(ids, ['o_new', 'o_old']);
  assert.deepEqual(plain.split('\n').slice(1).map((line) => line.includes('getLatestTag')), [true, false], 'the newest first, as the ids are');
  const none = [];
  assert.equal(observe.recallIndex('acme__other', { ids: none }), '');
  assert.deepEqual(none, []);
});

// ── the worker and the hook, on a machine ───────────────────────────────────

const running = new Set();
process.once('exit', () => {
  for (const child of running) child.kill('SIGKILL');
});

const MODEL = 'claude-haiku-5-5';
// what the fake answers a run of each kind with, each its own so that a line is known for its kind's
const USAGE = {
  batch: { tokens_in: 3900, tokens_out: 140, cache_read: 12000, cache_write: 800, cost_usd: 0.00123 },
  briefing: { tokens_in: 1700, tokens_out: 70, cache_read: 9000, cache_write: 300, cost_usd: 0.00045 },
  shortlist: { tokens_in: 7600, tokens_out: 40, cache_read: 9000, cache_write: 0, cost_usd: 0.00081 },
};
const printed = (kind, more) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    api_error_status: null,
    total_cost_usd: USAGE[kind].cost_usd,
    usage: { input_tokens: USAGE[kind].tokens_in, output_tokens: USAGE[kind].tokens_out, cache_read_input_tokens: USAGE[kind].cache_read, cache_creation_input_tokens: USAGE[kind].cache_write },
    modelUsage: { [MODEL]: { inputTokens: USAGE[kind].tokens_in, outputTokens: USAGE[kind].tokens_out, costUSD: USAGE[kind].cost_usd } },
    ...more,
  });
const FOUND = {
  observations: [
    { type: 'cause', title: 'the suite fails until the fixtures are built', facts: ['npm test exits 1 on a checkout whose fixtures were never built.'], files: [], symbols: [], evidence: { kind: 'command', ref: 'npm test' } },
  ],
};

// `claude -p`, as far as the worker can tell: a run of a kind is answered as the plan's line for that kind's nth run
// says (good, where the plan says nothing), with that kind's usage
const FAKE = `#!/bin/sh
cat > /dev/null
kind="$AGENTMASH_OBSERVER_KIND"
n=$(($(grep -c "^$kind " "$FAKE_DIR/runs") + 1))
mode=$(grep "^$kind " "$FAKE_DIR/plan" | sed -n "\${n}p" | cut -d' ' -f2)
[ -n "$mode" ] || mode=good
echo "$kind $mode" >> "$FAKE_DIR/runs"
case "$mode" in
  boom) echo boom >&2; exit 3 ;;
  limit) echo "Claude AI usage limit reached|1763150400" >&2; exit 1 ;;
  *) cat "$FAKE_DIR/$kind-$mode.json"; exit 0 ;;
esac
`;

/** A committed repository on `main` with src/tags.ts in it. */
function scratchRepo() {
  const top = fs.realpathSync(tempDir('observe-ledger-repo-'));
  const gitconfig = path.join(tempDir('observe-ledger-git-'), 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  const git = (...args) => execFileSync('git', args, { cwd: top, env: { ...baseEnv, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'bob@example.com');
  git('config', 'user.name', 'bob');
  fs.mkdirSync(path.join(top, 'src'));
  fs.writeFileSync(path.join(top, 'src/tags.ts'), 'export const getLatestTag = () => 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return top;
}

/** A machine with observing on and the fake in place of `claude`. `plan` is lines of `<kind> <mode>`, a kind's runs in order. */
function freshMachine(plan = [], config = {}) {
  const home = freshHome();
  observe.writeConfig(config);
  const dir = path.join(home, 'fake');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'observer.sh'), FAKE, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'observe-good.json'), printed('batch', { structured_output: FOUND }));
  fs.writeFileSync(path.join(dir, 'observe-unusable.json'), printed('batch', { result: 'I found nothing to record.' }));
  fs.writeFileSync(path.join(dir, 'brief-good.json'), printed('briefing', { structured_output: { picks: [{ n: 1, meets: 'the first edit' }] } }));
  fs.writeFileSync(path.join(dir, 'brief-unusable.json'), printed('briefing', { result: 'None of them.' }));
  fs.writeFileSync(path.join(dir, 'short-good.json'), printed('shortlist', { structured_output: { numbers: [1, 2] } }));
  fs.writeFileSync(path.join(dir, 'runs'), '');
  fs.writeFileSync(path.join(dir, 'plan'), `${plan.join('\n')}\n`);
  return {
    home,
    env: {
      AGENTMASH_HOME: home,
      AGENTMASH_OBSERVER_CMD: JSON.stringify(['/bin/sh', path.join(dir, 'observer.sh')]),
      AGENTMASH_OBSERVE_POLL_MS: '20',
      AGENTMASH_OBSERVE_IDLE_MS: '150',
      FAKE_DIR: dir,
    },
    runs: () => fs.readFileSync(path.join(dir, 'runs'), 'utf8').split('\n').filter(Boolean),
    log: () => {
      try {
        return fs.readFileSync(path.join(observe.observePaths().dir, 'worker.log'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}

function startWorker(m, script = WORKER) {
  const child = spawn(process.execPath, [script], { env: { ...baseEnv, ...m.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(child);
  let said = '';
  child.stdout.on('data', (d) => (said += d));
  child.stderr.on('data', (d) => (said += d));
  const done = new Promise((resolve, reject) => {
    const limit = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('the worker was still running after 20 s'));
    }, within(20_000));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(limit);
      running.delete(child);
      assert.equal(said, '', 'the worker prints nothing');
      assert.equal(code, 0);
      resolve();
    });
  });
  return { done };
}
const runWorker = (m, script) => startWorker(m, script).done;

// every spooled event a millisecond after the one before: a session's events are read in the order of their times
let last = 0;
const stamp = (at = Date.now() - 5000) => (last = Math.max(at, last + 1));
const spool = (kind, session, cwd, input = {}, at) => {
  const now = stamp(at);
  observe.writeSpool(observe.spoolEvent(kind, { session_id: session, cwd, ...input }, { now }));
  return now;
};
/** A batch worth an observer run: a command that failed and the turn's closing message. */
function spoolBatch(session, cwd) {
  spool('fail', session, cwd, { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' });
  spool('stop', session, cwd, { last_assistant_message: 'the tests fail' });
}
/** A prompt and the closing message that ends its turn, so that a worker has nothing open to wait for. Returns the prompt's own time. */
function spoolAsked(session, cwd, prompt, id) {
  const at = spool('prompt', session, cwd, { prompt, prompt_id: id });
  spool('stop', session, cwd, { prompt_id: id, last_assistant_message: 'done' });
  return at;
}

const ledger = (what) => observe.readLedger().filter((line) => line.what === what);
const costOf = (kind) => ({ ...USAGE[kind], model: MODEL });
const pick = (line, fields) => Object.fromEntries(fields.map((field) => [field, line[field]]));
const COST = ['tokens_in', 'tokens_out', 'cache_read', 'cache_write', 'cost_usd', 'model'];

test('every observer run is a line of the ledger with what the CLI said it cost, and a batch\'s line in the log says what its runs came to', posix, async () => {
  const m = freshMachine(['observe unusable', 'observe good']);
  const work = fs.realpathSync(tempDir('observe-ledger-work-'));
  spoolBatch('a', work);
  spoolBatch('b', work);

  await runWorker(m);

  assert.deepEqual(m.runs(), ['observe unusable', 'observe good', 'observe good']);
  const runs = ledger('run');
  assert.deepEqual(runs.map((line) => [line.kind, line.session, line.attempt, line.answer]), [['batch', 'a', 1, 'answered'], ['batch', 'a', 2, 'answered'], ['batch', 'b', 1, 'answered']]);
  for (const line of runs) {
    assert.deepEqual(pick(line, COST), costOf('batch'));
    assert.equal(line.asked, MODEL, 'the name it was asked for by, beside the one that answered');
    assert.ok(Number.isInteger(line.ms) && line.ms >= 0 && !Number.isNaN(Date.parse(line.ts)));
  }
  // a reply that could not be read was paid for: the batch's line sums both of its runs
  const [a, b] = m.log();
  assert.deepEqual([a.session, a.outcome, a.kind, a.runs, a.tokens_in, a.tokens_out, a.cache_read, a.cache_write, a.cost_usd, a.model], ['a', 'observed', 'batch', 2, 7800, 280, 24000, 1600, 0.00246, MODEL]);
  assert.deepEqual([b.session, b.outcome, b.kind, b.runs, b.tokens_in, b.cost_usd], ['b', 'observed', 'batch', 1, 3900, 0.00123]);
  assert.equal(observe.readObservations('no-repo')[0].model, MODEL, 'and a finding is still filed under the model that answered');
});

test('a run that never answered is a line too: failed with no tokens for an exit, and a limit as a limit', posix, async () => {
  const m = freshMachine(['observe boom', 'observe good']);
  const work = fs.realpathSync(tempDir('observe-ledger-work-'));
  spoolBatch('a', work);
  await runWorker(m);
  assert.deepEqual(ledger('run').map((line) => [line.attempt, line.answer, line.tokens_in, line.cost_usd, line.model]), [[1, 'failed', 0, 0, null], [2, 'answered', 3900, 0.00123, MODEL]]);
  assert.deepEqual([m.log()[0].outcome, m.log()[0].runs, m.log()[0].cost_usd], ['observed', 2, 0.00123]);

  const limited = freshMachine(['observe limit']);
  spoolBatch('a', work);
  await runWorker(limited);
  assert.deepEqual(ledger('run').map((line) => [line.kind, line.answer, line.cost_usd]), [['batch', 'limit', 0]]);
  assert.deepEqual([limited.log()[0].outcome, limited.log()[0].runs], ['paused', 1]);
});

test('a batch that takes no run has no cost on its line and none in the ledger', posix, async () => {
  const m = freshMachine();
  const work = fs.realpathSync(tempDir('observe-ledger-work-'));
  spool('tool', 'a', work, { tool_name: 'Read', tool_input: { file_path: 'a.ts' }, tool_response: { file: { numLines: 1 } } });
  spool('stop', 'a', work, { last_assistant_message: 'it returns one' });
  await runWorker(m);
  const [line] = m.log();
  assert.equal(line.outcome, 'skipped');
  for (const field of ['kind', 'runs', 'cost_usd', 'tokens_in', 'model']) assert.ok(!(field in line), field);
  assert.deepEqual(observe.readLedger(), []);
});

test('a prompt that is briefed leaves its runs by their kind and one line of what became of it, and its line in the log says what they cost', posix, async () => {
  const m = freshMachine();
  const top = scratchRepo();
  const key = observe.gitFacts(top).key;
  // more than one briefing is shown: a shortlist first, then the briefing
  for (let i = 1; i <= 45; i++) found(key, `o_${i}`, `finding number ${i} about getLatestTag in src/tags.ts`, 60 + i);
  const at = spoolAsked('s1', top, TASK, 'p1');

  await runWorker(m);

  assert.deepEqual(m.runs(), ['short good', 'brief good']);
  const runs = ledger('run');
  assert.deepEqual(runs.map((line) => [line.kind, line.session, line.attempt]), [['shortlist', 's1', 1], ['briefing', 's1', 1]]);
  assert.deepEqual(pick(runs[0], COST), costOf('shortlist'));
  assert.deepEqual(pick(runs[1], COST), costOf('briefing'));
  const [prompt, ...more] = ledger('prompt');
  assert.equal(more.length, 0);
  assert.deepEqual(pick(prompt, ['session', 'prompt', 'prompt_ts', 'outcome', 'picked', 'of', 'runs', 'cost_usd']), { session: 's1', prompt: 'p1', prompt_ts: at, outcome: 'briefed', picked: 1, of: 2, runs: 2, cost_usd: 0.00126 });
  assert.ok(prompt.made_ms >= Date.now() - at - 5000 && prompt.made_ms <= Date.now() - at, 'from the prompt\'s own time to the brief being made');
  const line = m.log().find((entry) => entry.reason === 'prompt');
  assert.deepEqual([line.outcome, line.kind, line.runs, line.tokens_in, line.tokens_out, line.cost_usd, line.model], ['briefed', 'briefing', 2, 9300, 110, 0.00126, MODEL]);
  assert.deepEqual([observe.readState().runs, observe.readState().brief_runs], [2, 2]);
});

test('a prompt that got no briefing leaves a line that says why: too short, no repository, the cap, a pause, a hold, a pick that could not be read, a limit met as it was asked', posix, async () => {
  const top = scratchRepo();
  const key = observe.gitFacts(top).key;
  const plain = fs.realpathSync(tempDir('observe-ledger-plain-'));
  const why = async (m, session) => {
    await runWorker(m);
    const lines = ledger('prompt').filter((line) => line.session === session);
    assert.equal(lines.length, 1, `one line for ${session}`);
    assert.equal(lines[0].outcome, 'none');
    assert.ok(Number.isFinite(lines[0].prompt_ts) && Number.isFinite(lines[0].made_ms));
    return lines[0].why;
  };

  let m = freshMachine();
  spoolAsked('short', top, 'ok, do it', 'p1');
  spoolAsked('plain', plain, TASK, 'p2');
  assert.equal(await why(m, 'short'), 'shorter than a task (40 characters)');
  assert.equal(await why(m, 'plain'), 'not in a repository');
  assert.equal(m.runs().length, 0);
  assert.equal(m.log().filter((line) => line.reason === 'prompt').length, 0, 'the worker\'s log says of them what it did: nothing');

  m = freshMachine([], { daily_cap: 0 });
  spoolAsked('capped', top, TASK, 'p3');
  assert.equal(await why(m, 'capped'), "the day's cap of 0 runs is reached");

  m = freshMachine();
  observe.updateState((s) => {
    s.paused_until = Date.now() + 30 * MIN;
  });
  spoolAsked('paused', top, TASK, 'p4');
  assert.equal(await why(m, 'paused'), 'the observer is paused');

  m = freshMachine();
  observe.noteFailedStart({ why: 'the observer exited with 1: Please run /login', access: true });
  spoolAsked('held', top, TASK, 'p5');
  assert.equal(await why(m, 'held'), 'the observer is held: its command does not answer');

  // a briefing asked for and not read, twice: both runs are on record, and the prompt's line says what was wrong with the reply
  m = freshMachine(['brief unusable', 'brief unusable']);
  found(key, 'o_1', 'getLatestTag walks only the history of HEAD', 60);
  spoolAsked('unread', top, TASK, 'p6');
  assert.equal(await why(m, 'unread'), 'neither reply could be read', 'in the ledger\'s own words: what the reply said is the log\'s to keep');
  assert.match(m.log().find((line) => line.reason === 'prompt').why, /did not answer with/);
  assert.deepEqual(ledger('run').map((line) => [line.kind, line.attempt, line.answer]), [['briefing', 1, 'answered'], ['briefing', 2, 'answered']]);
  assert.deepEqual(pick(ledger('prompt')[0], ['runs', 'cost_usd']), { runs: 2, cost_usd: 0.0009 });
  assert.equal(observe.readBrief('unread'), null);

  // a usage limit met as the briefing is asked
  m = freshMachine(['brief limit']);
  found(key, 'o_2', 'the release job reads tags from main', 50);
  spoolAsked('limited', top, TASK, 'p7');
  assert.equal(await why(m, 'limited'), 'the observer was paused or held as it was asked');
  assert.deepEqual(ledger('run').map((line) => [line.kind, line.answer]), [['briefing', 'limit']]);
});

test('a worker beside an observe.mjs from before the ledger writes none, and its log says what it always said', posix, async () => {
  const dir = fs.realpathSync(tempDir('observe-ledger-old-'));
  for (const name of ['observe_worker.mjs', 'observe_sync.mjs', 'lib.mjs']) fs.copyFileSync(path.join(HOOKS_DIR, name), path.join(dir, name));
  fs.copyFileSync(path.join(HOOKS_DIR, 'observe.mjs'), path.join(dir, 'observe_today.mjs'));
  const added = ['ledgerLine', 'readLedger', 'briefedAt'];
  for (const name of added) assert.ok(name in observe, `observe.mjs exports ${name}`);
  fs.writeFileSync(path.join(dir, 'observe.mjs'), ["export * from './observe_today.mjs';", ...added.map((name) => `export const ${name} = undefined;`), ''].join('\n'));

  const m = freshMachine();
  const top = scratchRepo();
  found(observe.gitFacts(top).key, 'o_1', 'getLatestTag walks only the history of HEAD', 60);
  spool('prompt', 's1', top, { prompt: TASK, prompt_id: 'p1' });
  spoolBatch('s1', top);
  await runWorker(m, path.join(dir, 'observe_worker.mjs'));

  assert.deepEqual(m.runs(), ['brief good', 'observe good']);
  assert.deepEqual(observe.readLedger(), []);
  assert.equal(fs.existsSync(observe.observePaths().ledger), false);
  for (const line of m.log()) for (const field of ['kind', 'runs', 'cost_usd', 'tokens_in']) assert.ok(!(field in line), `${line.outcome}: ${field}`);
  assert.deepEqual(m.log().map((line) => line.outcome), ['briefed', 'observed']);
});

// ── the recall hook ─────────────────────────────────────────────────────────

const recall = async (m, event, input) => {
  const result = await runHook('observe_recall.mjs', input, m.env, [event]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : '';
};

test('what the hook says to a session is a line each: the index at its start, the briefing before its first call with where the turn stood, the note before an edit; and nothing where it says nothing', posix, async () => {
  const m = freshMachine();
  const top = scratchRepo();
  const key = observe.gitFacts(top).key;
  const tags = path.join(top, 'src/tags.ts');
  found(key, 'o_tags', 'getLatestTag in src/tags.ts walks only the history of HEAD', 60);
  found(key, 'o_job', 'the release job reads tags from main', 30, { files: [], symbols: [] });

  const index = await recall(m, 'session_start', { session_id: 's1', cwd: top });
  assert.match(index, /^Earlier sessions in this repository found/);

  // the prompt, briefed while the session is live: the worker stays up for the turn's open batch
  const asked = spool('prompt', 's1', top, { prompt: TASK, prompt_id: 'p1' }, Date.now());
  const worker = startWorker(m);
  const until = Date.now() + within(10_000);
  while (!observe.readBrief('s1')) {
    assert.ok(Date.now() < until, 'the brief was made');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(observe.readBrief('s1').ids, ['o_job'], 'the newest, which the fake picks');

  const read = { session_id: 's1', cwd: top, prompt_id: 'p1', tool_name: 'Read', tool_input: { file_path: tags } };
  const briefing = await recall(m, 'pre_tool', read);
  assert.match(briefing, /the release job reads tags from main/);
  const saidAfter = (Date.now() - asked) / 1000;
  assert.equal(await recall(m, 'pre_tool', read), '', 'once');
  spool('tool', 's1', top, { ...read, tool_response: { file: { numLines: 1 } } }, Date.now());

  const edit = { session_id: 's1', cwd: top, prompt_id: 'p1', tool_name: 'Edit', tool_input: { file_path: tags, old_string: '1', new_string: '2' } };
  const note = await recall(m, 'pre_tool', edit);
  assert.match(note, /Earlier sessions found this about src\/tags\.ts/);
  assert.equal(await recall(m, 'pre_tool', edit), '', 'a file\'s note once');
  spool('stop', 's1', top, { prompt_id: 'p1', last_assistant_message: 'done' }, Date.now());
  await worker.done;

  const notes = ledger('note');
  assert.deepEqual(notes.map((line) => [line.hook, line.kind, line.session, line.chars, line.ids]), [
    ['session_start', 'index', 's1', index.length, ['o_job', 'o_tags']],
    ['pre_tool', 'briefing', 's1', briefing.length, ['o_job']],
    ['pre_tool', 'file', 's1', note.length, ['o_tags']],
  ]);
  const said = notes[1];
  assert.deepEqual(pick(said, ['prompt', 'call_prompt', 'same_prompt', 'call']), { prompt: 'p1', call_prompt: 'p1', same_prompt: true, call: 1 });
  assert.ok(said.since_prompt_s > 0 && said.since_prompt_s <= saidAfter + 0.05, `${said.since_prompt_s} s after the prompt, of ${saidAfter}`);
  for (const line of [notes[0], notes[2]]) for (const field of ['prompt', 'call', 'since_prompt_s']) assert.ok(!(field in line), `${line.kind}: ${field}`);

  // numbers, ids and times: not a word of the prompt, of a finding or of a path
  const text = fs.readFileSync(observe.observePaths().ledger, 'utf8');
  for (const word of ['getLatestTag', 'release job', 'unmerged', 'tags.ts', top]) assert.ok(!text.includes(word), word);
});

test('a briefing said after the session went on is written down as said under another prompt, with no call to its name; and one said to nobody is no line', posix, async () => {
  const m = freshMachine();
  const top = scratchRepo();
  found(observe.gitFacts(top).key, 'o_1', 'getLatestTag walks only the history of HEAD', 60);
  spoolAsked('s1', top, TASK, 'p1');
  await runWorker(m);
  assert.deepEqual(observe.readBrief('s1').ids, ['o_1']);

  const call = { session_id: 's1', cwd: top, prompt_id: 'p2', tool_name: 'Read', tool_input: { file_path: path.join(top, 'src/tags.ts') } };
  // a subagent's call is said no briefing, and writes none down
  assert.equal(await recall(m, 'pre_tool', { ...call, agent_id: 'sub-1' }), '');
  assert.deepEqual(ledger('note'), []);

  const briefing = await recall(m, 'pre_tool', call);
  assert.match(briefing, /getLatestTag walks only the history of HEAD/);
  const [said, ...more] = ledger('note');
  assert.equal(more.length, 0);
  assert.deepEqual(pick(said, ['hook', 'kind', 'chars', 'ids', 'prompt', 'call_prompt', 'same_prompt', 'call']), { hook: 'pre_tool', kind: 'briefing', chars: briefing.length, ids: ['o_1'], prompt: 'p1', call_prompt: 'p2', same_prompt: false, call: null });

  // observing off: the hook says nothing and writes nothing
  observe.writeConfig({ enabled: false });
  assert.equal(await recall(m, 'session_start', { session_id: 's2', cwd: top }), '');
  assert.equal(ledger('note').length, 1);
});

test('the ledger is this machine\'s: what syncs with a room does not read it, and the room\'s wire has no field of it', () => {
  const sync = fs.readFileSync(path.join(HOOKS_DIR, 'observe_sync.mjs'), 'utf8');
  assert.doesNotMatch(sync, /ledger/i);
  // the two that write it, and nobody else among the hooks
  const writers = fs.readdirSync(HOOKS_DIR).filter((name) => name.endsWith('.mjs') && /ledgerLine/.test(fs.readFileSync(path.join(HOOKS_DIR, name), 'utf8')));
  assert.deepEqual(writers.sort(), ['observe.mjs', 'observe_recall.mjs', 'observe_worker.mjs']);
});
