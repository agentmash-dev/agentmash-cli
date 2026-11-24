#!/usr/bin/env node
// A stand-in for `claude -p` in the worker's tests (observe-worker.test.mjs).
// It reads the batch on its stdin, writes down how it was run, and answers as
// it is told. No model, no network: a test never starts the real CLI.
//
//   OBSERVE_FAKE          what to answer, one of the names in ANSWERS below;
//                         `good` when nothing is said
//   OBSERVE_FAKE_PLAN     a file holding a JSON array of those names, one per
//                         run in order; the last stands for every run after it
//   OBSERVE_FAKE_RECORD   a file that gets one JSON line per run, written
//                         before the answer: pid, mode, cwd, what the folder
//                         held, the arguments, the environment, stdin
//   OBSERVE_FAKE_REPLY    the `structured_output` of a good answer, as JSON
//   OBSERVE_FAKE_BRIEF    the same for a briefing (AGENTMASH_OBSERVER_KIND is `brief`):
//                         the first finding of the list, when nothing is said
//   OBSERVE_FAKE_SHORT    the same for a shortlist (AGENTMASH_OBSERVER_KIND is `short`):
//                         the first title of the list, when nothing is said
//   OBSERVE_FAKE_SLOW_MS  how long `slow` waits before it answers (30 s)
//
// Of the environment it records every variable's name and the value of
// AgentMash's and CLAUDE_PROJECT_DIR alone: a record is a file, and the rest
// of a developer's environment is not a test's to write down.

import fs from 'node:fs';

const GOOD = {
  observations: [
    {
      type: 'cause',
      title: 'getLatestTag never sees tags on unmerged branches',
      facts: ['It runs git describe in src/tags.ts, which only walks the history of HEAD.'],
      files: ['src/tags.ts'],
      symbols: ['getLatestTag'],
      evidence: { kind: 'command', ref: 'pnpm test' },
    },
  ],
};

/** The one JSON object `claude -p --output-format json` prints, as Claude Code 2.1.304 shapes it. */
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

const BRIEF = { picks: [{ n: 1, meets: 'the first edit' }] };
const SHORT = { numbers: [1] };

// The worker asks for a briefing, and for a shortlist before one, as well as for observations (observe_worker.mjs), and says which in its environment.
const reply = () => {
  if (process.env.AGENTMASH_OBSERVER_KIND === 'brief') return process.env.OBSERVE_FAKE_BRIEF ? JSON.parse(process.env.OBSERVE_FAKE_BRIEF) : BRIEF;
  if (process.env.AGENTMASH_OBSERVER_KIND === 'short') return process.env.OBSERVE_FAKE_SHORT ? JSON.parse(process.env.OBSERVE_FAKE_SHORT) : SHORT;
  return process.env.OBSERVE_FAKE_REPLY ? JSON.parse(process.env.OBSERVE_FAKE_REPLY) : GOOD;
};

// each: [stdout, stderr, exit code]
const ANSWERS = {
  good: () => [printed({ structured_output: reply() }), '', 0],
  empty: () => [printed({ structured_output: { observations: [] } }), '', 0],
  // a good reply whose text talks about a rate limit, as one about a repository's limiter would
  chatty: () => [printed({ result: 'The rate limit lives in src/limit.ts.', structured_output: reply() }), '', 0],
  garbage: () => ['Done! Here is what I found:\n- nothing\n', '', 0],
  shapeless: () => [printed({ result: 'I found nothing to record.' }), '', 0],
  error: () => [printed({ subtype: 'error_during_execution', is_error: true, result: 'Execution error' }), '', 0],
  exit: () => ['', 'boom\n', 3],
  limit: () => [printed({ subtype: 'error', is_error: true, api_error_status: 429, result: 'API Error: Request rejected (429)' }), '', 1],
  usage: () => ['', 'Claude AI usage limit reached|1763150400\n', 1],
  slow: () => [printed({ structured_output: reply() }), '', 0],
};

function readPlan() {
  try {
    const plan = JSON.parse(fs.readFileSync(process.env.OBSERVE_FAKE_PLAN, 'utf8'));
    return Array.isArray(plan) && plan.length ? plan : null;
  } catch {
    return null;
  }
}

function runsSoFar(record) {
  try {
    return fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;

const record = process.env.OBSERVE_FAKE_RECORD;
const plan = readPlan();
const mode = plan ? plan[Math.min(record ? runsSoFar(record) : 0, plan.length - 1)] : process.env.OBSERVE_FAKE || 'good';

if (record) {
  const shown = (name) => name.startsWith('AGENTMASH_') || name === 'CLAUDE_PROJECT_DIR';
  const line = {
    pid: process.pid,
    mode,
    cwd: process.cwd(),
    held: fs.readdirSync(process.cwd()),
    argv: process.argv.slice(2),
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => shown(name))),
    envNames: Object.keys(process.env).sort(),
    stdin,
  };
  fs.appendFileSync(record, `${JSON.stringify(line)}\n`);
}

if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, Number(process.env.OBSERVE_FAKE_SLOW_MS) || 30_000));

const [stdout, stderr, code] = (ANSWERS[mode] ?? ANSWERS.garbage)();
if (stderr) process.stderr.write(stderr);
process.stdout.write(stdout, () => process.exit(code));
