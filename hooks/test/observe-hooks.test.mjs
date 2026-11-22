// The observe hooks as an agent runs them: observe_spool.mjs, which turns one
// hook input into one spool file and makes sure a worker is alive, and
// observe_recall.mjs, which tells a session what earlier ones found. Each is
// started as a child process with the hook's JSON on its stdin, as Claude
// Code starts it.
//
// Every test has a home of its own (AGENTMASH_HOME, and HOME with it), so
// nothing reads or writes the real ~/.agentmash. No test starts the real
// worker: AGENTMASH_OBSERVE_WORKER is `off`, or a script the test wrote that
// only says it ran. Nothing here starts `claude`, and nothing uses the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOOKS_DIR, baseEnv, runHook, session, timed, within } from './fixtures.mjs';
import { tempDir } from './tmp.mjs';
import * as observe from '../observe.mjs';

const SECRET = `ghp_${'a1B2c3D4e5'.repeat(3)}`;
// what a file holds, which a Read's and an Edit's answers carry and the spool must not
const FILE_TEXT = 'const hush = 1;\n';
const HOUR = 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A machine of its own for one test: a home where observing is on (or, with
 * `on: false`, was never turned on), which this process's observe.mjs reads
 * too, and the environment its hooks run in. No worker, unless a test names one.
 */
function observing({ on = true } = {}) {
  const home = fs.realpathSync(tempDir('observe-hooks-home-'));
  process.env.AGENTMASH_HOME = home;
  if (on) observe.writeConfig({ enabled: true });
  return { home, env: { AGENTMASH_HOME: home, HOME: home, AGENTMASH_OBSERVE_WORKER: 'off' } };
}

/** A git repository with one file, on main; with `origin`, a checkout of that remote. */
function scratchRepo(origin = null) {
  const top = fs.realpathSync(tempDir('observe-hooks-repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: top, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  if (origin) git('remote', 'add', 'origin', origin);
  fs.mkdirSync(path.join(top, 'src'));
  fs.writeFileSync(path.join(top, 'src', 'tags.ts'), 'export const a = 1;\n');
  return top;
}

/** An observation in the log of the repository at `top`, as the worker would have added it some hours ago. */
function observed(top, { id, title, files = ['src/tags.ts'], facts = [`${title}, in detail: see ${files[0]}.`], branch = 'main', hoursAgo = 5, by = null }) {
  const ts = Date.now() - hoursAgo * HOUR;
  const obs = { v: 1, id, ts, session_id: by, type: 'cause', title, facts, files, agent: 'claude-code', branch, seen: 1 };
  assert.deepEqual(observe.addObservation(observe.repoKey(top), obs, ts), { added: id });
}

/** Every file under a folder, relative to it, in order. */
function filesUnder(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesUnder(path.join(dir, entry.name), base) : [path.relative(base, path.join(dir, entry.name))]))
    .sort();
}

const spoolFiles = () => filesUnder(observe.observePaths().spool);
const spoolText = () => spoolFiles().map((name) => fs.readFileSync(path.join(observe.observePaths().spool, name), 'utf8')).join('\n');
/** The events spooled so far, in the order they were written. */
const spooled = () => observe.readSpool().flatMap((s) => s.entries.map((e) => e.event)).sort((a, b) => a.ts - b.ts);

/** What Claude Code hands each hook (measured from its probe, see the spec), for session `s` at work in `cwd`. */
const sent = {
  prompt: (s, cwd) => ({ session_id: s, cwd, hook_event_name: 'UserPromptSubmit', prompt: `push it with ${SECRET}`, prompt_id: 'p1', transcript_path: path.join(cwd, 't.jsonl') }),
  bash: (s, cwd) => ({
    session_id: s,
    cwd,
    hook_event_name: 'PostToolUse',
    prompt_id: 'p1',
    tool_name: 'Bash',
    tool_input: { command: 'npm test', description: 'run the tests' },
    tool_response: { stdout: `token ${SECRET}\n12 passing`, stderr: 'a warning', interrupted: false },
    tool_use_id: 'toolu_1',
  }),
  read: (s, cwd, content = FILE_TEXT) => ({
    session_id: s,
    cwd,
    hook_event_name: 'PostToolUse',
    prompt_id: 'p1',
    tool_name: 'Read',
    tool_input: { file_path: path.join(cwd, 'src', 'tags.ts') },
    tool_response: { type: 'text', file: { filePath: path.join(cwd, 'src', 'tags.ts'), content, numLines: content.split('\n').length - 1 } },
    tool_use_id: 'toolu_2',
  }),
  edit: (s, cwd) => ({
    session_id: s,
    cwd,
    hook_event_name: 'PostToolUse',
    prompt_id: 'p1',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(cwd, 'src', 'tags.ts'), old_string: 'a', new_string: 'b' },
    tool_response: { filePath: path.join(cwd, 'src', 'tags.ts'), oldString: 'a', newString: 'b', originalFile: FILE_TEXT },
    tool_use_id: 'toolu_3',
  }),
  failed: (s, cwd) => ({
    session_id: s,
    cwd,
    hook_event_name: 'PostToolUseFailure',
    prompt_id: 'p1',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    error: 'Exit code 3',
    tool_use_id: 'toolu_4',
  }),
  stop: (s, cwd) => ({ session_id: s, cwd, hook_event_name: 'Stop', prompt_id: 'p1', stop_hook_active: false, last_assistant_message: `Done. The token was ${SECRET}.` }),
};

/** One input for each kind the spool hook takes. */
const EACH_KIND = [
  ['prompt', sent.prompt],
  ['tool', sent.bash],
  ['fail', sent.failed],
  ['stop', sent.stop],
];

/** Runs a hook that must say nothing: exit 0, nothing on stdout, nothing on stderr. */
async function silent(script, args, payload, env, why) {
  const ran = await runHook(script, payload, env, args);
  assert.deepEqual([ran.code, ran.stdout, ran.stderr], [0, '', ''], why ?? `${script} ${args.join(' ')}`);
  return ran;
}

/**
 * Runs observe_recall.mjs and returns what it told the agent, or null when
 * it printed nothing. What it prints is one line of hook JSON that adds
 * context and decides nothing.
 */
async function recall(event, payload, env) {
  const ran = await runHook('observe_recall.mjs', payload, env, [event]);
  assert.equal(ran.code, 0);
  assert.equal(ran.stderr, '');
  if (ran.stdout === '') return null;
  assert.match(ran.stdout, /^[^\n]+\n$/, 'exactly one line');
  const said = JSON.parse(ran.stdout);
  assert.deepEqual(Object.keys(said), ['hookSpecificOutput'], 'no decision, no message for the person');
  assert.deepEqual(Object.keys(said.hookSpecificOutput), ['hookEventName', 'additionalContext'], 'context and nothing else: no permission decision');
  return said.hookSpecificOutput;
}

/**
 * A worker that only says it ran: it writes its pid and the folder it was
 * started in to `marker`, then stays alive for a while, as a worker does.
 * At `script`, or in a folder of its own.
 */
function fakeWorker(script = path.join(tempDir('observe-hooks-worker-'), 'worker.mjs')) {
  const marker = `${script}.started`;
  fs.writeFileSync(
    script,
    [
      "import fs from 'node:fs';",
      `const marker = ${JSON.stringify(marker)};`,
      "fs.writeFileSync(`${marker}.tmp`, JSON.stringify({ pid: process.pid, cwd: process.cwd() }));",
      'fs.renameSync(`${marker}.tmp`, marker);',
      `setTimeout(() => {}, ${within(3000)});`,
      '',
    ].join('\n')
  );
  return {
    script,
    marker,
    /** What the worker wrote, once it has; null if none started in time. Stops it, and forgets it ran. */
    async started(timeoutMs = 4000) {
      const deadline = Date.now() + within(timeoutMs);
      while (!fs.existsSync(marker) && Date.now() < deadline) await sleep(20);
      if (!fs.existsSync(marker)) return null;
      const said = JSON.parse(fs.readFileSync(marker, 'utf8'));
      let alive = true;
      try {
        process.kill(said.pid);
      } catch {
        alive = false;
      }
      fs.rmSync(marker);
      return { ...said, alive };
    },
    /** Whether none started, given a moment in which one would have. */
    async never() {
      await sleep(within(400));
      return !fs.existsSync(marker);
    },
  };
}

test('with observing never turned on, neither hook writes or prints anything', async () => {
  const { home, env } = observing({ on: false });
  // a repository with something to recall, so a hook that ran would have had something to say
  const top = scratchRepo();
  observed(top, { id: 'o_1', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)' });
  const worker = fakeWorker();
  const before = filesUnder(home);
  const s = session();

  for (const [kind, input] of EACH_KIND) await silent('observe_spool.mjs', [kind], input(s, top), { ...env, AGENTMASH_OBSERVE_WORKER: worker.script });
  await silent('observe_recall.mjs', ['session_start'], { session_id: s, cwd: top, hook_event_name: 'SessionStart', source: 'startup' }, env);
  const edit = { session_id: s, cwd: top, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(top, 'src', 'tags.ts'), old_string: 'a', new_string: 'b' } };
  await silent('observe_recall.mjs', ['pre_tool'], edit, env);

  assert.deepEqual(filesUnder(home), before, 'nothing spooled, nothing marked as told');
  assert.ok(await worker.never(), 'and no worker is started');
});

test('AGENTMASH_DISABLE switches both hooks off on a machine that observes', async () => {
  const { home, env } = observing();
  const top = scratchRepo();
  observed(top, { id: 'o_1', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)' });
  const worker = fakeWorker();
  const before = filesUnder(home);
  const s = session();
  const start = { session_id: s, cwd: top, hook_event_name: 'SessionStart', source: 'startup' };
  const edit = { session_id: s, cwd: top, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(top, 'src', 'tags.ts'), old_string: 'a', new_string: 'b' } };

  // 1 is what the observer's own sessions run with; the other words are read as loadConfig reads them
  for (const word of ['1', 'true', 'please']) {
    const off = { ...env, AGENTMASH_DISABLE: word, AGENTMASH_OBSERVE_WORKER: worker.script };
    for (const [kind, input] of EACH_KIND) await silent('observe_spool.mjs', [kind], input(s, top), off, `${kind} with AGENTMASH_DISABLE=${word}`);
    await silent('observe_recall.mjs', ['session_start'], start, off);
    await silent('observe_recall.mjs', ['pre_tool'], edit, off);
  }
  assert.deepEqual(filesUnder(home), before, 'nothing spooled, nothing marked as told');
  assert.ok(await worker.never(), 'and no worker is started');

  // it was the switch: the same inputs without it, and with it set to an off word, are spooled and recalled
  await silent('observe_spool.mjs', ['prompt'], sent.prompt(s, top), env);
  await silent('observe_spool.mjs', ['prompt'], sent.prompt(s, top), { ...env, AGENTMASH_DISABLE: '0' });
  assert.equal(spoolFiles().length, 2);
  assert.ok(await recall('session_start', start, env));
  assert.ok(await recall('pre_tool', edit, env));
});

test('each event is one spool file, with its secrets masked and no file\'s text in it', async () => {
  const { env } = observing();
  const s = session();
  const cwd = scratchRepo();
  const runs = [
    ['prompt', sent.prompt],
    ['tool', sent.bash],
    ['tool', sent.read],
    ['tool', sent.edit],
    ['fail', sent.failed],
    ['stop', sent.stop],
  ];
  let files = 0;
  for (const [kind, input] of runs) {
    await silent('observe_spool.mjs', [kind], input(s, cwd), env);
    assert.equal(spoolFiles().length, ++files, `${kind}: one file more`);
  }

  const text = spoolText();
  assert.ok(!text.includes(SECRET), 'no secret reaches the disk');
  assert.ok(!text.includes('hush'), 'nor what a file holds');

  const [prompt, bash, read, edit, failed, stop] = spooled();
  for (const event of [prompt, bash, read, edit, failed, stop]) {
    assert.equal(event.session, s);
    assert.equal(event.cwd, cwd);
    assert.equal(event.agent, 'claude-code', 'Claude Code, when no --client says otherwise');
    assert.equal(event.prompt_id, 'p1');
  }
  assert.equal(prompt.kind, 'prompt');
  assert.equal(prompt.text, 'push it with [hidden]');
  assert.deepEqual([bash.kind, bash.tool, bash.ok], ['tool', 'Bash', true]);
  assert.equal(bash.input.command, 'npm test');
  assert.equal(bash.outcome, 'token [hidden]\n12 passing\nstderr: a warning');
  assert.equal(read.outcome, 'read 1 lines', 'a read says how much, not what');
  assert.deepEqual(read.files, [path.join(cwd, 'src', 'tags.ts')]);
  assert.equal(edit.outcome, 'ok');
  assert.deepEqual([failed.kind, failed.ok, failed.outcome], ['fail', false, 'failed: Exit code 3']);
  assert.equal(stop.kind, 'stop');
  assert.equal(stop.last, 'Done. The token was [hidden].');
});

test('--client says which agent an event is from', async () => {
  const { env } = observing();
  const s = session();
  await silent('observe_spool.mjs', ['tool', '--client', 'codex'], sent.bash(s, '/repo'), env);
  await silent('observe_spool.mjs', ['stop', '--client', 'gemini'], sent.stop(s, '/repo'), env);
  // a name no agent has is no name: the event is Claude Code's, as with none
  await silent('observe_spool.mjs', ['prompt', '--client', 'Not A Name'], sent.prompt(s, '/repo'), env);
  assert.deepEqual(spooled().map((e) => [e.kind, e.agent]), [['tool', 'codex'], ['stop', 'gemini'], ['prompt', 'claude-code']]);
});

test('a worker is started when none holds the lock, and not when a live one does', async () => {
  const { env } = observing();
  const worker = fakeWorker();
  const withWorker = { ...env, AGENTMASH_OBSERVE_WORKER: worker.script };
  const { lock, dir } = observe.observePaths();
  const s = session();
  const pidFile = path.join(lock, 'pid');

  // no lock at all: the first event of the day
  const first = await silent('observe_spool.mjs', ['prompt'], sent.prompt(s, '/repo'), withWorker);
  const started = await worker.started();
  assert.ok(started, 'no lock: a worker is started');
  assert.ok(started.alive, 'and it outlives the hook, which did not wait for it');
  assert.ok(first.elapsed < within(1000), `the hook was back in ${first.elapsed} ms, with the worker still running`);
  assert.equal(fs.realpathSync(started.cwd), fs.realpathSync(dir), 'started in the observe folder, not where the agent works');

  // a live worker: this test's own process stands in for it
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));
  await silent('observe_spool.mjs', ['tool'], sent.bash(s, '/repo'), withWorker);
  assert.equal(spoolFiles().length, 2, 'the event is spooled all the same');
  assert.ok(await worker.never(), 'a live pid holds the lock: no second worker');

  // a lock left by a worker that is gone, and ones that name no process
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  for (const [pid, why] of [
    [`${gone}\n`, 'the pid of a process that has exited'],
    ['0', 'pid 0, which would signal the hook\'s own process group'],
    ['-1', 'a negative pid'],
    ['not a pid', 'a pid file that holds no number'],
  ]) {
    fs.writeFileSync(pidFile, pid);
    await silent('observe_spool.mjs', ['tool'], sent.bash(s, '/repo'), withWorker);
    assert.ok(await worker.started(), `${why}: a worker is started`);
  }
});

test('the worker started is the one beside the hook, and `off` starts none', async () => {
  const { env } = observing();
  // a copy of the hook with a worker of this test's beside it, so the real one never runs
  const dir = fs.realpathSync(tempDir('observe-hooks-copy-'));
  for (const name of ['observe_spool.mjs', 'observe.mjs', 'lib.mjs']) fs.copyFileSync(path.join(HOOKS_DIR, name), path.join(dir, name));
  const worker = fakeWorker(path.join(dir, 'observe_worker.mjs'));
  const { AGENTMASH_OBSERVE_WORKER: _, ...unnamed } = env;
  const s = session();
  const run = async (kind, input, runEnv) => {
    const ran = await runHook('observe_spool.mjs', input(s, '/repo'), runEnv, [kind], { dir });
    assert.deepEqual([ran.code, ran.stdout, ran.stderr], [0, '', '']);
  };

  await run('prompt', sent.prompt, { ...unnamed, AGENTMASH_OBSERVE_WORKER: 'off' });
  await run('stop', sent.stop, { ...unnamed, AGENTMASH_OBSERVE_WORKER: 'off' });
  assert.equal(spoolFiles().length, 2, 'the events are spooled');
  assert.ok(await worker.never(), '`off`: nothing is started, with no lock held by anyone');

  await run('prompt', sent.prompt, unnamed);
  assert.ok(await worker.started(), 'unset: observe_worker.mjs beside the hook');

  // a hook with no worker beside it, and one told of a script that is not there, have nothing to start
  fs.rmSync(worker.script);
  await run('prompt', sent.prompt, unnamed);
  await run('prompt', sent.prompt, { ...unnamed, AGENTMASH_OBSERVE_WORKER: path.join(dir, 'nowhere.mjs') });
  assert.equal(spoolFiles().length, 5);
});

test('stdin that is no hook input, or a kind there is none of, spools nothing and still exits 0', async () => {
  const { home, env } = observing();
  const top = scratchRepo();
  observed(top, { id: 'o_1', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)' });
  const worker = fakeWorker();
  const withWorker = { ...env, AGENTMASH_OBSERVE_WORKER: worker.script };
  const before = filesUnder(home);

  for (const [kind] of EACH_KIND) await silent('observe_spool.mjs', [kind], '{ "session_id": "s1", "tool_na', withWorker, `${kind}: JSON cut short`);
  for (const raw of ['', 'null', '[]', '"a string"', '42', 'not json at all']) {
    await silent('observe_spool.mjs', ['tool'], raw, withWorker, `spool: ${JSON.stringify(raw)}`);
    await silent('observe_recall.mjs', ['session_start'], raw, env, `session_start: ${JSON.stringify(raw)}`);
    await silent('observe_recall.mjs', ['pre_tool'], raw, env, `pre_tool: ${JSON.stringify(raw)}`);
  }
  const s = session();
  await silent('observe_spool.mjs', ['explode'], sent.bash(s, top), withWorker, 'a kind there is none of');
  await silent('observe_spool.mjs', [], sent.bash(s, top), withWorker, 'no kind at all');
  await silent('observe_recall.mjs', ['explode'], { session_id: s, cwd: top }, env, 'an event there is none of');
  await silent('observe_recall.mjs', [], { session_id: s, cwd: top }, env, 'no event at all');

  assert.deepEqual(filesUnder(home), before);
  assert.ok(await worker.never(), 'and nothing to observe starts no worker');
});

test('the spool hook is back in well under a second, a large tool result included', async () => {
  const { env } = observing();
  const s = session();
  // a Read of a big file: its text is in the hook's input, and none of it is spooled
  const big = sent.read(s, '/repo', `${'const hush = 1;'.repeat(40)}\n`.repeat(800));
  const took = [];
  for (let i = 0; i < 5; i++) took.push((await silent('observe_spool.mjs', ['tool'], big, env)).elapsed);
  for (const [kind, input] of EACH_KIND) took.push((await silent('observe_spool.mjs', [kind], input(s, '/repo'), env)).elapsed);
  assert.ok(Math.max(...took) < within(1000), `the slowest of ${took.length} runs took ${Math.max(...took)} ms`);
  assert.equal(spoolFiles().length, 9);
  assert.ok(!spoolText().includes('hush'));
});

test('neither hook opens a connection', async () => {
  const { env } = observing();
  const top = scratchRepo();
  observed(top, { id: 'o_1', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)' });
  // the CLI's own guard: the first use of the network ends the process with exit code 97
  const guard = pathToFileURL(fileURLToPath(new URL('../../cli/test/fixtures/no-network.mjs', import.meta.url))).href;
  const offline = { ...env, NODE_OPTIONS: [baseEnv.NODE_OPTIONS, `--import=${guard}`].filter(Boolean).join(' ') };
  const s = session();

  for (const [kind, input] of EACH_KIND) await silent('observe_spool.mjs', [kind], input(s, top), offline, `${kind}, with no network`);
  assert.equal(spoolFiles().length, 4);
  const index = await recall('session_start', { session_id: s, cwd: top, hook_event_name: 'SessionStart', source: 'startup' }, offline);
  assert.ok(index?.additionalContext.includes('getLatestTag'));
  const edit = { session_id: s, cwd: top, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(top, 'src', 'tags.ts'), old_string: 'a', new_string: 'b' } };
  assert.ok((await recall('pre_tool', edit, offline))?.additionalContext.includes('getLatestTag'));
});

test('a session is told the index of its repository as it starts, this branch\'s observations first', async () => {
  const { env } = observing();
  const top = scratchRepo();
  const key = observe.repoKey(top);
  observed(top, { id: 'o_1', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)', hoursAgo: 5 });
  observed(top, { id: 'o_2', title: 'schema.json is written by scripts/gen.mjs', files: ['schema.json'], branch: 'feature', hoursAgo: 3 });

  // started in a folder of the repository, as a session can be
  const start = (cwd) => ({ session_id: session(), cwd, hook_event_name: 'SessionStart', source: 'startup' });
  const said = await recall('session_start', start(path.join(top, 'src')), env);
  assert.equal(said.hookEventName, 'SessionStart');
  assert.equal(said.additionalContext, observe.recallIndex(key, { branch: 'main' }), 'the index, for the branch the checkout is on');
  const lines = said.additionalContext.split('\n');
  assert.equal(lines[0], observe.RECALL_HEADER);
  assert.match(lines[1], /^- \[cause\] getLatestTag misses tags on unmerged branches \(src\/tags\.ts\): .+ \(claude-code, 5 h ago\)$/, 'main is where this checkout is: its observation first, older as it is');
  assert.match(lines[2], /schema\.json is written by scripts\/gen\.mjs/);
  assert.equal(lines.length, 3);

  // and again when the session starts again (/clear, a compaction): what it was told is gone
  assert.deepEqual(await recall('session_start', { ...start(top), source: 'compact' }, env), said);

  // on the other branch, that branch's comes first
  execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: top, stdio: 'pipe' });
  const onFeature = await recall('session_start', start(top), env);
  assert.match(onFeature.additionalContext.split('\n')[1], /schema\.json is written/);
});

test('with five hundred of the team\'s findings the index is eight lines and 1,200 characters at most, every line names who found it, and it is built with the network refused, inside the hook\'s second', async (t) => {
  const { env } = observing();
  const top = scratchRepo('git@github.com:acme/app.git');
  const key = observe.repoKey(top);
  for (let i = 0; i < 12; i++) observed(top, { id: `o_own${i}`, title: `this machine's own finding number ${i}`, hoursAgo: i + 1 });
  // what a pull leaves: the room's newest five hundred, long titles and long facts, four people's
  const now = Date.now();
  const authors = ['alim', 'dana', 'bob', 'aigerim'];
  const findings = Array.from({ length: 500 }, (_, i) => ({
    id: `o_team${String(i).padStart(6, '0')}`,
    type: observe.OBSERVATION_TYPES[i % observe.OBSERVATION_TYPES.length],
    title: `team finding number ${i} ${'about the release tooling '.repeat(5)}`.slice(0, observe.LIMITS.titleChars),
    facts: [1, 2, 3].map((n) => `fact ${n} of team finding ${i} ${'with a good deal to say '.repeat(12)}`.slice(0, observe.LIMITS.factChars)),
    files: ['src/tags.ts', `src/module-${i}.ts`],
    symbols: ['getLatestTag'],
    evidence: { kind: 'command', ref: 'pnpm test' },
    branch: i % 3 ? 'main' : 'feature',
    head: 'abc1234',
    developer: authors[i % authors.length],
    agent: i % 2 ? 'claude-code' : 'codex',
    first_ts: now - (i + 2) * 60_000,
    last_ts: now - (i + 1) * 60_000,
    seen: 1 + (i % 4),
    people: 1 + (i % 7 === 0 ? 2 : 0),
    commit: null,
  }));
  observe.writeTeam(key, { v: 1, at: now, sharing: true, share_since: 0, seq: 500, observations: findings });

  // the CLI's own guard: the first use of the network ends the process with exit code 97
  const guard = pathToFileURL(fileURLToPath(new URL('../../cli/test/fixtures/no-network.mjs', import.meta.url))).href;
  const offline = { ...env, NODE_OPTIONS: [baseEnv.NODE_OPTIONS, `--import=${guard}`].filter(Boolean).join(' ') };
  const ran = await runHook('observe_recall.mjs', { session_id: session(), cwd: top, hook_event_name: 'SessionStart', source: 'startup' }, offline, ['session_start']);
  assert.deepEqual([ran.code, ran.stderr], [0, ''], 'no server was asked: the guard would have ended it with 97');
  const index = JSON.parse(ran.stdout).hookSpecificOutput.additionalContext;
  const [header, ...lines] = index.split('\n');
  assert.equal(header, observe.TEAM_RECALL_HEADER);
  assert.ok(lines.length >= 1 && lines.length <= observe.LIMITS.indexMax, `${lines.length} lines`);
  assert.ok(index.length <= observe.LIMITS.indexChars, `${index.length} characters`);
  for (const line of lines) assert.match(line, /^- \[\w+\] .+ \((?:alim|dana|bob|aigerim|this machine), (?:claude-code|codex), [^()]+\)$/, 'who found it, with what, and when');
  assert.ok(lines.some((line) => /\((?:alim|dana|bob|aigerim), /.test(line)), 'a teammate among them');
  assert.match(lines[0], /also found by 2 others\)$/, 'on this branch, what more people found comes first');

  // The hook gives itself a second (its exit guard), node's start included; the index is a few file reads in it.
  assert.ok(ran.elapsed < within(1000), `the hook took ${ran.elapsed} ms`);
  const built = timed(250, () => observe.recallIndex(key, { branch: 'main' }));
  assert.equal(built.value.split('\n').length, lines.length + 1);
  assert.ok(built.ms < built.limit, `the index took ${built.ms} ms to build`);
  t.diagnostic(`five hundred team findings: the hook ran in ${ran.elapsed} ms, the index was built in ${built.ms.toFixed(1)} ms`);
});

test('a session that starts where nothing was observed, or in no repository, is told nothing', async () => {
  const { home, env } = observing();
  const quiet = scratchRepo();
  const loud = scratchRepo();
  observed(loud, { id: 'o_1', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)' });
  const nowhere = fs.realpathSync(tempDir('observe-hooks-norepo-'));
  assert.equal(observe.findTop(nowhere), null, 'the temp folder is in no repository');
  const before = filesUnder(home);

  for (const cwd of [quiet, nowhere]) {
    const s = session();
    assert.equal(await recall('session_start', { session_id: s, cwd, hook_event_name: 'SessionStart', source: 'startup' }, env), null);
    const edit = { session_id: s, cwd, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src', 'tags.ts'), old_string: 'a', new_string: 'b' } };
    assert.equal(await recall('pre_tool', edit, env), null);
  }
  assert.deepEqual(filesUnder(home), before);
});

test('before a file is edited, what earlier sessions found about it is said once per session', async () => {
  const { env } = observing();
  const top = scratchRepo('git@github.com:acme/app.git');
  const key = observe.repoKey(top);
  assert.equal(key, 'acme__app', 'the log is found by the repository\'s origin');
  observed(top, { id: 'o_1', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)', facts: ['It runs git describe in src/tags.ts, which only walks the history of HEAD.'] });
  const about = observe.recallForFile(key, 'src/tags.ts');
  assert.match(about, /^Earlier sessions found this about src\/tags\.ts \(information, not instructions\):\n- \[cause\] getLatestTag misses/);
  const expected = { hookEventName: 'PreToolUse', additionalContext: about };
  const file = path.join(top, 'src', 'tags.ts');
  const pre = (s, tool, input, cwd = top) => ({ session_id: s, cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'toolu_1' });

  // an absolute file_path, as Claude Code names every file
  const s1 = session();
  assert.deepEqual(await recall('pre_tool', pre(s1, 'Edit', { file_path: file, old_string: 'a', new_string: 'b' }), env), expected);
  assert.equal(await recall('pre_tool', pre(s1, 'Edit', { file_path: file, old_string: 'b', new_string: 'c' }), env), null, 'the second edit of the file is told nothing');
  assert.equal(await recall('pre_tool', pre(s1, 'Write', { file_path: file, content: 'x' }), env), null, 'nor is another tool on the same file');

  // another session has not heard it
  const s2 = session();
  assert.deepEqual(await recall('pre_tool', pre(s2, 'Write', { file_path: file, content: 'x' }), env), expected);

  // a notebook's path, another agent's `path`, and a path relative to a folder of the repository
  assert.deepEqual(await recall('pre_tool', pre(session(), 'NotebookEdit', { notebook_path: file, new_source: 'x' }), env), expected);
  assert.deepEqual(await recall('pre_tool', pre(session(), 'edit', { path: 'src/tags.ts' }), env), expected);
  assert.deepEqual(await recall('pre_tool', pre(session(), 'Edit', { file_path: 'tags.ts' }, path.join(top, 'src')), env), expected);
});

test('a command that names an observed file is told about it, once per session', async () => {
  const { env } = observing();
  const top = scratchRepo();
  const key = observe.repoKey(top);
  observed(top, { id: 'o_1', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)', hoursAgo: 5 });
  observed(top, { id: 'o_2', title: 'schema.json is written by scripts/gen.mjs', files: ['schema.json'], hoursAgo: 3 });
  const tags = { hookEventName: 'PreToolUse', additionalContext: observe.recallForFile(key, 'src/tags.ts') };
  const schema = { hookEventName: 'PreToolUse', additionalContext: observe.recallForFile(key, 'schema.json') };
  const run = (s, command, tool = 'Bash') =>
    recall('pre_tool', { session_id: s, cwd: top, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command, description: 'a command' }, tool_use_id: 'toolu_1' }, env);

  const s1 = session();
  assert.deepEqual(await run(s1, 'npx vitest run src/tags.ts'), tags);
  assert.equal(await run(s1, 'npx vitest run src/tags.ts'), null, 'the same session is not told twice');
  assert.equal(await run(s1, 'git diff -- src/tags.ts'), null, 'whatever the command');

  // however the command names it
  assert.deepEqual(await run(session(), `node ${top}/src/tags.ts --dry`), tags, 'by its absolute path in this checkout');
  assert.deepEqual(await run(session(), 'cat ./src/tags.ts | head -5'), tags);
  assert.deepEqual(await run(session(), 'git diff -- "src/tags.ts"'), tags);
  assert.deepEqual(await run(session(), 'Get-Content src/tags.ts', 'PowerShell'), tags);

  // two observed files: the one the command names first, then the other is not said for the same command
  const s2 = session();
  assert.deepEqual(await run(s2, 'prettier --check schema.json src/tags.ts'), schema);
  assert.equal(await run(s2, 'prettier --check schema.json src/tags.ts'), null);

  // a command that names no observed file, or one that only looks like it
  for (const command of ['ls -la', 'npm test', 'cat src/other.ts', 'cat src/tags.tsx src/tags.ts.bak', 'cat vendor/src/tags.ts', 'cat /elsewhere/src/tags.ts', 'cat data/myschema.json']) {
    assert.equal(await run(session(), command), null, command);
  }
  // and a tool with a command that is not a shell is not read as one
  assert.equal(await recall('pre_tool', { session_id: session(), cwd: top, hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { command: 'cat src/tags.ts' } }, env), null);
});

test('the repository is the one a call works in, not the one the session started in', async () => {
  const { env } = observing();
  const started = scratchRepo('git@github.com:acme/site.git');
  const work = scratchRepo('git@github.com:acme/app.git');
  const nowhere = fs.realpathSync(tempDir('observe-hooks-nowhere-'));
  fs.mkdirSync(path.join(work, 'server', 'test'), { recursive: true });
  observed(work, { id: 'o_app', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)' });
  observed(work, { id: 'o_test', title: 'server/test/tags.test.ts needs the tags fetched first', files: ['server/test/tags.test.ts'] });
  observed(started, { id: 'o_site', title: 'the site keeps its own tags.ts', hoursAgo: 2 });
  const tags = { hookEventName: 'PreToolUse', additionalContext: observe.recallForFile('acme__app', 'src/tags.ts') };
  const test = { hookEventName: 'PreToolUse', additionalContext: observe.recallForFile('acme__app', 'server/test/tags.test.ts') };
  const site = { hookEventName: 'PreToolUse', additionalContext: observe.recallForFile('acme__site', 'src/tags.ts') };
  assert.match(tags.additionalContext, /getLatestTag misses/);
  const pre = (cwd, tool, input) => recall('pre_tool', { session_id: session(), cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'toolu_1' }, env);

  // an edit is of the repository its file is in
  assert.deepEqual(await pre(started, 'Edit', { file_path: path.join(work, 'src', 'tags.ts'), old_string: 'a', new_string: 'b' }), tags);
  assert.deepEqual(await pre(nowhere, 'Write', { file_path: path.join(work, 'src', 'tags.ts'), content: 'x' }), tags, 'from a session that started in no repository too');
  assert.deepEqual(await pre(started, 'Edit', { file_path: path.join(started, 'src', 'tags.ts'), old_string: 'a', new_string: 'b' }), site);
  // a command is of the repository it goes to first
  assert.deepEqual(await pre(started, 'Bash', { command: `cd ${work} && npx vitest run src/tags.ts` }), tags);
  assert.deepEqual(await pre(started, 'Bash', { command: `cd ${work} && cd server && node --test test/tags.test.ts` }), test, 'a file named from the folder the command works in');
  assert.deepEqual(await pre(started, 'Bash', { command: `cd ${path.join(work, 'server')}; node --test ../src/tags.ts test/other.test.ts` }), null, 'not by a path this reading does not follow');
  assert.deepEqual(await pre(started, 'Bash', { command: 'npx vitest run src/tags.ts' }), site, 'and the session\'s own when it goes nowhere');
  assert.equal(await pre(nowhere, 'Bash', { command: 'cat src/tags.ts' }), null, 'a command in no repository');
});

test('nothing is said before a command that only stages, commits, pushes, opens a pull request, or counts or lists files', async () => {
  const { env } = observing();
  const top = scratchRepo();
  observed(top, { id: 'o_1', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)' });
  const tags = { hookEventName: 'PreToolUse', additionalContext: observe.recallForFile(observe.repoKey(top), 'src/tags.ts') };
  const run = (command) => recall('pre_tool', { session_id: session(), cwd: top, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_1' }, env);

  for (const command of [
    'git add src/tags.ts',
    'git add "src/tags.ts" && git commit -m tags',
    `cd ${top} && git add src/tags.ts && git commit -q -m "getLatestTag: read src/tags.ts; then push" && git push`,
    'git commit -m "$(cat <<\'EOF\'\nfix "the" tags in src/tags.ts\nEOF\n)"',
    'git checkout -- src/tags.ts',
    'git -C . stash push src/tags.ts',
    'gh pr create --title tags --body "changes src/tags.ts"',
    'GIT_EDITOR=true git rebase --continue # src/tags.ts',
    // nor before one that only counts or lists files
    'wc -l src/tags.ts src/other.ts',
    'ls -la src/tags.ts && git status --short',
    // nor for a name deep in the text a heredoc writes: that is what the script writes, not what it works on
    `python3 - <<'PY'\np='notes.md'\ns=open(p).read()\ns+='''${'a line of the text being written. '.repeat(12)}see src/tags.ts'''\nopen(p,'w').write(s)\nPY`,
  ]) {
    assert.equal(await run(command), null, command);
  }
  // a command that reads the file is told, whatever keeps the books beside it
  const script = "python3 - <<'PY'\np='src/tags.ts'\ns=open(p).read()\nopen(p,'w').write(s.replace('a', 'b'))\nPY";
  for (const command of ['git diff -- src/tags.ts', 'git log -p --follow src/tags.ts', 'git -C . blame src/tags.ts', 'git add -A && npx vitest run src/tags.ts', 'git status --short; sed -n 1,20p src/tags.ts', 'ls src && cat src/tags.ts', script]) {
    assert.deepEqual(await run(command), tags, command);
  }
});

test('a finding is said once in a session, under whichever of its files comes first', async () => {
  const { env } = observing();
  const top = scratchRepo();
  const key = observe.repoKey(top);
  fs.writeFileSync(path.join(top, 'src', 'other.ts'), 'export const b = 2;\n');
  observed(top, { id: 'o_both', title: 'src/tags.ts and src/other.ts must change together', files: ['src/tags.ts', 'src/other.ts'], hoursAgo: 3 });
  const s = session();
  const edit = (file) => recall('pre_tool', { session_id: s, cwd: top, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(top, file), old_string: 'a', new_string: 'b' } }, env);

  assert.match((await edit('src/tags.ts')).additionalContext, /must change together/);
  assert.equal(await edit('src/other.ts'), null, 'the same finding, under its other file');
  assert.deepEqual(observe.readTold(s), { files: ['src/tags.ts'], ids: ['o_both'] }, 'a file with nothing new to say is not marked');
  // something else about that file is still to be said, and is said alone
  observed(top, { id: 'o_other', title: 'src/other.ts is read by the build before tags', files: ['src/other.ts'], hoursAgo: 1 });
  const later = (await edit('src/other.ts')).additionalContext;
  assert.equal(later, observe.recallForFile(key, 'src/other.ts', { skip: ['o_both'] }));
  assert.ok(later.includes('read by the build') && !later.includes('must change together'));
  assert.equal(await edit('src/other.ts'), null);
});

test('a session is not told before a call what it found itself, and another session is', async () => {
  const { env } = observing();
  const top = scratchRepo();
  const finder = session();
  observed(top, { id: 'o_1', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)', by: finder, hoursAgo: 0.1 });
  const pre = (s, tool, input) => recall('pre_tool', { session_id: s, cwd: top, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }, env);
  const edit = { file_path: path.join(top, 'src', 'tags.ts'), old_string: 'a', new_string: 'b' };

  assert.equal(await pre(finder, 'Edit', edit), null);
  assert.equal(await pre(finder, 'Bash', { command: 'cat src/tags.ts' }), null);
  assert.deepEqual(filesUnder(observe.observePaths().told), [], 'and its file is not marked: another session\'s finding about it is still to come');
  assert.match((await pre(session(), 'Edit', edit)).additionalContext, /getLatestTag misses/);
  // the index, which a session gets as it starts or starts again, has it all the same
  const index = await recall('session_start', { session_id: finder, cwd: top, hook_event_name: 'SessionStart', source: 'compact' }, env);
  assert.ok(index.additionalContext.includes('getLatestTag misses'));
  // a teammate's finding about the file reaches the finder too
  observed(top, { id: 'o_2', title: 'src/tags.ts is generated by scripts/gen.mjs', by: session(), hoursAgo: 0.05 });
  const told = (await pre(finder, 'Edit', edit)).additionalContext;
  assert.ok(told.includes('is generated by') && !told.includes('getLatestTag misses'), told);
});

test('what an earlier version logged about a session\'s setup is told nowhere, and what does not name a file in its title is not that file\'s note', async () => {
  const { env } = observing();
  const top = scratchRepo();
  const s = session();
  observed(top, { id: 'o_setup', title: 'Work tree is ~/src/app-next, not the session working directory', facts: ['Edits to src/tags.ts ran in ~/src/app-next.'], hoursAgo: 1 });
  observed(top, { id: 'o_glob', title: 'An unquoted --include glob fails in zsh', facts: ['zsh ends the command at a glob with no match.'], hoursAgo: 2 });
  // true, and seen in this file, and about something else: it names the file in a fact alone
  observed(top, { id: 'o_seen', title: 'The build reads the tag list twice', facts: ['Seen in src/tags.ts, in getLatestTag.'], hoursAgo: 3 });
  const edit = { session_id: s, cwd: top, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(top, 'src', 'tags.ts'), old_string: 'a', new_string: 'b' } };

  assert.equal(await recall('pre_tool', edit, env), null);
  assert.equal(await recall('pre_tool', { ...edit, tool_name: 'Bash', tool_input: { command: 'cat src/tags.ts' } }, env), null);
  assert.deepEqual(filesUnder(observe.observePaths().told), [], 'and nothing is marked');
  const index = (await recall('session_start', { session_id: s, cwd: top, hook_event_name: 'SessionStart', source: 'startup' }, env)).additionalContext;
  assert.ok(index.includes('An unquoted --include glob') && index.includes('The build reads the tag list twice') && !index.includes('Work tree is'), index);
});

test('a file nobody observed, or one outside the repository, is told nothing and not marked as told', async () => {
  const { env } = observing();
  const top = scratchRepo();
  observed(top, { id: 'o_1', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)' });
  const elsewhere = fs.realpathSync(tempDir('observe-hooks-elsewhere-'));
  const s = session();
  const edit = (file_path) => ({ session_id: s, cwd: top, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path, old_string: 'a', new_string: 'b' } });

  assert.equal(await recall('pre_tool', edit(path.join(top, 'src', 'other.ts')), env), null, 'a file with no observations');
  assert.equal(await recall('pre_tool', edit(path.join(top, 'src')), env), null, 'a folder');
  assert.equal(await recall('pre_tool', edit(path.join(elsewhere, 'src', 'tags.ts')), env), null, 'the same name outside the repository');
  assert.equal(await recall('pre_tool', edit('../src/tags.ts'), env), null, 'a relative path that leaves it');
  assert.equal(await recall('pre_tool', { ...edit(''), tool_input: {} }, env), null, 'a call that names no file');
  assert.equal(await recall('pre_tool', { ...edit(''), tool_input: 'src/tags.ts' }, env), null, 'an input that is no object');
  assert.deepEqual(filesUnder(observe.observePaths().told), [], 'nothing was said, so nothing is marked');

  // the session still hears about the observed file when it gets to it
  assert.ok(await recall('pre_tool', edit(path.join(top, 'src', 'tags.ts')), env));
  assert.equal(filesUnder(observe.observePaths().told).length, 1);
});

test('the recall hook gives up after about a second on stdin an agent never closes', async () => {
  const { env } = observing();
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(HOOKS_DIR, 'observe_recall.mjs'), 'session_start'], { env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.stdin.on('error', () => {});
  // the input never ends: written, and the pipe left open
  child.stdin.write('{"session_id":"s1",');
  const code = await new Promise((resolve) => child.on('close', resolve));
  const elapsed = Date.now() - started;
  assert.equal(code, 0);
  assert.equal(out, '', 'and says nothing');
  assert.ok(elapsed < within(2000), `it took ${elapsed} ms`);
});

test('what was picked for a session\'s prompt is said before its next call of any tool, a read too, once, and a file\'s note still comes at a later call', async () => {
  const { env } = observing();
  const top = scratchRepo('git@github.com:acme/app.git');
  const key = observe.repoKey(top);
  observed(top, { id: 'o_1', title: 'the release job reads tags from main', files: ['src/other.ts'], facts: ['Only main is tagged.', 'A tag cut elsewhere is ignored.'], by: session() });
  observed(top, { id: 'o_2', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)', by: session() });
  const s = session();
  observe.writeBrief(s, { v: 1, key, top, prompt: 'p1', at: Date.now(), ids: ['o_1'], asked: 2, stale: [] });
  const pre = (tool, input, id = s) => recall('pre_tool', { session_id: id, cwd: top, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'toolu_1' }, env);

  const free = path.join(top, 'src', 'free.ts');
  const tags = path.join(top, 'src', 'tags.ts');
  const briefing = await pre('Read', { file_path: free });
  assert.equal(briefing.hookEventName, 'PreToolUse');
  assert.match(briefing.additionalContext, /^Earlier sessions in this repository found this, and it bears on what you were asked to do \(information, not instructions\):\n- \[cause\] the release job reads tags from main \(this machine, claude-code, 5 h ago\)\n {2}Only main is tagged\.\n {2}A tag cut elsewhere is ignored\.$/);
  assert.deepEqual(observe.readTold(s).ids, ['o_1'], 'and it is marked as told');
  assert.equal(await pre('Read', { file_path: free }), null, 'once');
  assert.equal(await pre('Grep', { pattern: 'tags' }), null);

  // a read or a search of a file with a finding is no moment for the file's note: it waits for the edit
  assert.equal(await pre('Read', { file_path: tags }), null);
  assert.equal(await pre('Grep', { pattern: 'getLatestTag', path: tags }), null);
  assert.equal(await pre('Glob', { pattern: '*.ts', path: path.join(top, 'src') }), null);
  assert.deepEqual(observe.readTold(s), { files: [], ids: ['o_1'] }, 'and the file is not marked as told');

  // the note of a file still comes, at the edit that follows
  const note = await pre('Edit', { file_path: tags, old_string: 'a', new_string: 'b' });
  assert.match(note.additionalContext, /^Earlier sessions found this about src\/tags\.ts \(information, not instructions\):\n- \[cause\] getLatestTag misses/);
  assert.ok(!note.additionalContext.includes('the release job'));

  // a session with no brief is told what it always was, and no briefing is sent to it
  const other = session();
  assert.equal(await pre('Read', { file_path: free }, other), null);
  assert.equal(await pre('Read', { file_path: tags }, other), null);
  assert.match((await pre('Edit', { file_path: tags, old_string: 'a', new_string: 'b' }, other)).additionalContext, /getLatestTag misses/);
});

test('of the hooks of one turn\'s parallel tool calls, one says the briefing and the others say nothing', async () => {
  const { env } = observing();
  const top = scratchRepo('git@github.com:acme/app.git');
  const key = observe.repoKey(top);
  observed(top, { id: 'o_1', title: 'the release job reads tags from main', files: ['src/other.ts'], by: session() });
  const s = session();
  observe.writeBrief(s, { v: 1, key, top, prompt: 'p1', ts: Date.now() - 2000, at: Date.now(), ids: ['o_1'], asked: 1, stale: [] });
  const pre = (n) => recall('pre_tool', { session_id: s, cwd: top, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(top, 'src', `free-${n}.ts`) }, tool_use_id: `toolu_${n}` }, env);

  // started together, as Claude Code starts the hooks of the calls of one message: each finds the briefing owed
  const said = (await Promise.all([1, 2, 3, 4].map(pre))).filter(Boolean);
  assert.equal(said.length, 1, `${said.length} of the four said it`);
  assert.match(said[0].additionalContext, /the release job reads tags from main/);
  assert.deepEqual(observe.readTold(s).ids, ['o_1']);
  assert.equal(await pre(5), null, 'and no call after them');

  // a briefing another hook has claimed is not said by this one, which marks it and goes on to its file's note
  observed(top, { id: 'o_2', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)', by: session() });
  const t = session();
  observe.writeBrief(t, { v: 1, key, top, prompt: 'p1', ts: Date.now() - 2000, at: Date.now(), ids: ['o_1'], asked: 2, stale: [] });
  assert.equal(observe.claimBrief(t, observe.briefBefore({ session_id: t })), true);
  const edit = await recall('pre_tool', { session_id: t, cwd: top, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(top, 'src', 'tags.ts'), old_string: 'a', new_string: 'b' } }, env);
  assert.match(edit.additionalContext, /^Earlier sessions found this about src\/tags\.ts/);
  assert.deepEqual(observe.readTold(t), { files: ['src/tags.ts'], ids: ['o_1', 'o_2'] });
});

test('a subagent\'s call is not said the briefing, which waits for a call of the agent the person asked; a file\'s note is said to either', async () => {
  const { env } = observing();
  const top = scratchRepo('git@github.com:acme/app.git');
  const key = observe.repoKey(top);
  observed(top, { id: 'o_1', title: 'the release job reads tags from main', files: ['src/other.ts'], by: session() });
  observed(top, { id: 'o_2', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)', by: session() });
  const s = session();
  observe.writeBrief(s, { v: 1, key, top, prompt: 'p1', ts: Date.now() - 2000, at: Date.now(), ids: ['o_1'], asked: 2, stale: [] });
  const pre = (tool, input, more = {}) => recall('pre_tool', { session_id: s, cwd: top, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'toolu_1', ...more }, env);
  const sub = { agent_id: 'agent-a1b2c3', agent_type: 'Explore' };

  // a subagent's calls carry the session's id, and what one is told its own context keeps
  assert.equal(await pre('Read', { file_path: path.join(top, 'src', 'free.ts') }, sub), null);
  assert.equal(await pre('Bash', { command: 'ls' }, sub), null);
  assert.deepEqual(observe.readTold(s).ids, [], 'nothing is marked as told');
  // the note of the file it edits is the subagent's to hear, as it was
  assert.match((await pre('Edit', { file_path: path.join(top, 'src', 'tags.ts'), old_string: 'a', new_string: 'b' }, sub)).additionalContext, /^Earlier sessions found this about src\/tags\.ts/);

  const briefing = await pre('Read', { file_path: path.join(top, 'src', 'free.ts') });
  assert.match(briefing.additionalContext, /bears on what you were asked to do[^\n]+\n- \[cause\] the release job reads tags from main/);
  assert.deepEqual(observe.readTold(s).ids, ['o_2', 'o_1']);
});

test('a finding that was picked and cannot be said any more is marked, so that the calls after it are not held up by it', async () => {
  const { env } = observing();
  const top = scratchRepo('git@github.com:acme/app.git');
  const key = observe.repoKey(top);
  observed(top, { id: 'o_1', title: 'the release job reads tags from main', files: ['src/other.ts'], by: session() });
  observed(top, { id: 'o_2', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)', by: session() });
  const s = session();
  observe.writeBrief(s, { v: 1, key, top, prompt: 'p1', ts: Date.now() - 2000, at: Date.now(), ids: ['o_1', 'o_never'], asked: 2, stale: [] });
  // forgotten between the pick and the session's next call
  observe.forgetObservation('o_1');
  const pre = (tool, input) => recall('pre_tool', { session_id: s, cwd: top, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'toolu_1' }, env);

  assert.equal(await pre('Read', { file_path: path.join(top, 'src', 'free.ts') }), null, 'nothing of it is said');
  assert.deepEqual(observe.readTold(s).ids, ['o_1', 'o_never'], 'and it is owed no more');
  assert.equal(observe.briefBefore({ session_id: s }, { told: observe.readTold(s) }), null);
  // the call that found it gone still gets its file's note
  const t = session();
  observe.writeBrief(t, { v: 1, key, top, prompt: 'p1', ts: Date.now() - 2000, at: Date.now(), ids: ['o_1'], asked: 1, stale: [] });
  const edit = await recall('pre_tool', { session_id: t, cwd: top, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(top, 'src', 'tags.ts'), old_string: 'a', new_string: 'b' } }, env);
  assert.match(edit.additionalContext, /^Earlier sessions found this about src\/tags\.ts/);
  assert.deepEqual(observe.readTold(t), { files: ['src/tags.ts'], ids: ['o_1', 'o_2'] });
});

test('a pick a session found false between the prompt and the next call is said by none of a turn\'s parallel hooks: one of them says what is left of the briefing, and the pick holds no later call up', async () => {
  const { env } = observing();
  const top = scratchRepo('git@github.com:acme/app.git');
  const key = observe.repoKey(top);
  observed(top, { id: 'o_1', title: 'the release job reads tags from main', files: ['src/other.ts'], by: session() });
  observed(top, { id: 'o_2', title: 'the build runs twice on a cold cache', files: ['src/other.ts'], by: session() });
  observed(top, { id: 'o_3', title: 'getLatestTag misses tags on unmerged branches (src/tags.ts)', by: session() });
  const s = session();
  observe.writeBrief(s, { v: 1, key, top, prompt: 'p1', ts: Date.now() - 2000, at: Date.now(), ids: ['o_1', 'o_2'], asked: 3, stale: [] });
  // another session's batch showed the first pick false, as the worker writes it down (observe.refuteObservation)
  observe.refuteObservation(key, 'o_1', { because: 'The agent read the job: it tags every branch now.' });
  const pre = (n, id = s) => recall('pre_tool', { session_id: id, cwd: top, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(top, 'src', `free-${n}.ts`) }, tool_use_id: `toolu_${n}` }, env);
  const claims = (id) => fs.readdirSync(observe.observePaths().brief).filter((name) => name.startsWith(`${id}.`) && name.endsWith('.said'));

  const said = (await Promise.all([1, 2, 3, 4].map((n) => pre(n)))).filter(Boolean);
  assert.equal(said.length, 1, `${said.length} of the four said it`);
  assert.match(said[0].additionalContext, /bears on what you were asked to do[^\n]+\n- \[cause\] the build runs twice on a cold cache/);
  assert.ok(!said[0].additionalContext.includes('the release job reads tags from main'), 'what was found false is not in it');
  assert.deepEqual(observe.readTold(s).ids.sort(), ['o_1', 'o_2'], 'what was said and what is gone are marked alike');
  assert.deepEqual(claims(s).map((name) => name.split('.').at(-2)), ['o_2'], 'one claim, under the first finding that was said');
  assert.equal(await pre(5), null, 'and no call after them');
  assert.equal(observe.briefBefore({ session_id: s }, { told: observe.readTold(s) }), null);

  // a briefing whose every pick was found false: nothing is said, nothing is claimed, and the call goes on to its file's note
  const t = session();
  observe.writeBrief(t, { v: 1, key, top, prompt: 'p1', ts: Date.now() - 2000, at: Date.now(), ids: ['o_1'], asked: 3, stale: [] });
  assert.equal(await pre(6, t), null);
  assert.deepEqual(observe.readTold(t).ids, ['o_1'], 'and it is owed no more');
  assert.deepEqual(claims(t), [], 'no claim was made for it');
  const edit = await recall('pre_tool', { session_id: t, cwd: top, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(top, 'src', 'tags.ts'), old_string: 'a', new_string: 'b' } }, env);
  assert.match(edit.additionalContext, /^Earlier sessions found this about src\/tags\.ts \(information, not instructions\):\n- \[cause\] getLatestTag misses/);
  assert.deepEqual(observe.readTold(t), { files: ['src/tags.ts'], ids: ['o_1', 'o_3'] });
});
