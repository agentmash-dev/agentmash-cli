#!/usr/bin/env node
// AgentMash observe hook, the capture half: one thing an agent did comes in
// on stdin, one small file under ~/.agentmash/observe/spool goes out, and
// that is all that happens here (docs/plans/enrichment-step1-observer.md).
//
//   node observe_spool.mjs <kind> [--client <id>]
//
//   prompt   UserPromptSubmit: what the person asked
//   tool     PostToolUse: a tool call and how it went
//   fail     PostToolUseFailure: a tool call that failed, with its error
//   stop     Stop: the end of a turn, with the agent's closing message
//
// It runs after every tool call, so it does only what fits in a few tens of
// milliseconds: read stdin, mask secrets and cut every field
// (observe.spoolEvent), write one file (observe.writeSpool). No network call,
// no git subprocess, no model. Turning what was spooled into observations is
// the worker's (observe_worker.mjs), one per machine. This hook only makes
// sure one is alive: a pid that answers is left alone, and otherwise a worker
// is started, detached, and never waited for.
//
// Observing is off until this machine turns it on (`agentmash observe on`),
// and off wherever AGENTMASH_DISABLE is on: the observer's own headless
// sessions run with it set, and must not be observed in their turn.
//
// The contract is every hook's: exit 0, silently, whatever happens. And this
// one prints nothing at all, ever: what a prompt hook prints is added to the
// agent's context, and a line from here would be read as part of the prompt.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { armExitGuard, envSwitch, finish, parseJson, readStdin } from './lib.mjs';
// See the note in post_tool_use.mjs: guarded access for post-v0 helpers.
import * as lib from './lib.mjs';
import * as observe from './observe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const KINDS = new Set(['prompt', 'tool', 'fail', 'stop']);
const KIND = process.argv[2];
// Which agent this is: Claude Code runs the hook as it is, and any other
// agent's hooks name it with `--client`, as for every other script here.
const CLIENT = lib.hookClient?.() ?? 'claude-code';

// A run takes a few tens of milliseconds. This is for the one that does not:
// stdin an agent never closes (readStdin gives up on it after 2 s, and what
// came by then is still spooled), a disk that hangs.
armExitGuard(2500);

/**
 * Whether there is nothing to do: AGENTMASH_DISABLE read as loadConfig reads
 * it (any word but an off one switches AgentMash off), or observing never
 * turned on for this machine.
 */
function switchedOff() {
  const said = envSwitch(process.env.AGENTMASH_DISABLE);
  if (said !== undefined && said !== false) return true;
  return !observe.isEnabled();
}

/**
 * Whether a worker holds the lock: the pid in its lock folder answers a
 * signal that does nothing. No file, a pid that is no positive number (0
 * would signal this hook's own process group, and answer), a process that is
 * gone, or one this user may not signal (the pid of a worker long dead, since
 * given to somebody else's process): none of those is a worker of ours.
 */
function workerAlive() {
  try {
    const pid = Number(fs.readFileSync(path.join(observe.observePaths().lock, 'pid'), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts the worker and lets go of it: detached, nothing of this hook's
 * stdio, unref'd, so the hook ends while it runs. Two hooks can both get
 * here at once and both start one. That is harmless: a worker takes the lock
 * itself, and the one that finds it taken leaves.
 *
 * The worker is observe_worker.mjs beside this file, or the script
 * AGENTMASH_OBSERVE_WORKER names; `off` starts none (the tests, which watch
 * the spool themselves). It is started in the observe folder, not where the
 * agent works: it outlives the session, and a worktree that is deleted under
 * a process leaves it with no current folder.
 */
function startWorker() {
  const named = process.env.AGENTMASH_OBSERVE_WORKER;
  if (named === 'off') return;
  const script = named || path.join(HERE, 'observe_worker.mjs');
  // an install from before the worker shipped: nothing to start, every time
  if (!fs.existsSync(script)) return;
  const child = spawn(process.execPath, [script], {
    cwd: observe.observePaths().dir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  // a spawn that fails says so on the child, later: without a listener that is a crash
  child.on('error', () => {});
  child.unref();
}

async function main() {
  // Before stdin is read: switched off, this costs a node start and nothing else.
  if (!KINDS.has(KIND) || switchedOff()) return;
  const parsed = parseJson(await readStdin());
  // Another agent's payload, read as Claude Code's (see normalizeHookInput).
  const input = lib.normalizeHookInput?.(parsed) ?? parsed;
  // stdin that is not a JSON object is not an event, and nothing is spooled for it
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  observe.writeSpool(observe.spoolEvent(KIND, input, { client: CLIENT }));
  if (!workerAlive()) startWorker();
}

main()
  .catch(() => {})
  .finally(finish);
