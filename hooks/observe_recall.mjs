#!/usr/bin/env node
// AgentMash observe hook, the recall half: what earlier sessions found out
// about a repository, said to a session at the two moments it can use it
// (docs/plans/enrichment-step1-observer.md). This machine's sessions, and
// where the repository's room shares, the team's beside them
// (docs/plans/enrichment-step2-room.md, "Team recall").
//
//   node observe_recall.mjs session_start|pre_tool
//
//   session_start   SessionStart: the index, up to eight observations of this
//                   repository, the current branch's first (observe.recallIndex),
//                   the team's among them under the name of who found each
//   pre_tool        PreToolUse, before any tool call (a read too): first, once,
//                   the briefing picked for the session's last prompt
//                   (observe.briefBefore), the findings that bear on its
//                   task, said by one hook of a turn's parallel calls
//                   (observe.claimBrief) and never to a subagent. Then,
//                   before a file is edited, or a command that names it
//                   runs, and before no other tool, what this machine knows
//                   about that file
//                   (observe.recallBefore), once per file and once per
//                   finding per session. The repository is the one the call
//                   works in: an edit's file's, or the one a command `cd`s
//                   into, which is often not the one the session started in.
//                   Nothing before a command that only stages, commits or
//                   pushes.
//
// What this prints is added to the agent's context, so it is one line of
// hook JSON or nothing: nothing outside a repository, for a repository
// nobody observed, for a file with no observations, and for a file this
// session was already told about. The text says of itself that it is
// information and not instructions; observe.mjs words it.
//
// It never prints a permission decision and never blocks. Whether an edit
// goes ahead is for the person's own rules and for pre_tool_use.mjs.
//
// Plain files under ~/.agentmash/observe are all it reads: no network call,
// no subprocess (the branch comes from .git/HEAD). What the team found is
// the file the worker's last sync left (observe_sync.mjs), as old as that
// sync, and never asked for here. Off until this machine
// turns observing on, and off wherever AGENTMASH_DISABLE is on. Exit 0,
// whatever happens, inside about a second.
//
// Whatever it says, it writes down that it said it: one line of the ledger
// (observe.ledgerLine) with the hook, the kind of note, the session, how
// many characters went into the agent's context and the ids of the findings
// in them; and for a briefing the prompt it was made for and the call's own,
// which call of the turn it came before and how long after the prompt. No
// word of the note itself, and nothing when it says nothing. The ledger is
// this machine's, and is sent nowhere.

import { armExitGuard, emitAndExit, envSwitch, finish, getGitBranch, parseJson, readStdin } from './lib.mjs';
// See the note in post_tool_use.mjs: guarded access for post-v0 helpers.
import * as lib from './lib.mjs';
import * as observe from './observe.mjs';

const EVENT = process.argv[2];

// The agent waits for this hook before every tool call. A run is a
// few file reads; a second is the most one may ever cost, and past it the
// session is told nothing, which is what it would have been told anyway
// most of the time.
armExitGuard(1000);

/** As in observe_spool.mjs: AGENTMASH_DISABLE as loadConfig reads it, or observing never turned on. */
function switchedOff() {
  const said = envSwitch(process.env.AGENTMASH_DISABLE);
  if (said !== undefined && said !== false) return true;
  return !observe.isEnabled();
}

/** The text as the hook JSON that adds it to the agent's context, and nothing more: no decision. */
const told = (hookEventName, additionalContext) => ({ hookSpecificOutput: { hookEventName, additionalContext } });

/** What is about to be said, in the ledger: which hook, what kind of note, to which session, how long, about which findings. Never throws (hooks from before the ledger have none, and write nothing). */
function noted(kind, session, text, ids, more = {}) {
  try {
    observe.ledgerLine?.({ what: 'note', hook: EVENT, kind, session, chars: String(text).length, ids, ...more });
  } catch {
    // the note is said all the same
  }
}

async function main() {
  // Before stdin is read: switched off, this costs a node start and nothing else.
  if ((EVENT !== 'session_start' && EVENT !== 'pre_tool') || switchedOff()) return null;
  const parsed = parseJson(await readStdin());
  // Another agent's payload, read as Claude Code's (see normalizeHookInput).
  const input = lib.normalizeHookInput?.(parsed) ?? parsed;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();

  if (EVENT === 'session_start') {
    // Where the session starts is all there is to go by yet.
    const top = observe.findTop(cwd);
    if (!top) return null;
    const ids = [];
    const index = observe.recallIndex(observe.repoKey(top), { branch: getGitBranch(top), top, ids });
    if (!index) return null;
    noted('index', input.session_id || 'unknown', index, ids);
    return told('SessionStart', index);
  }

  // The repository is the one the call works in, as the worker found it for
  // what it logged (observe.batchTop): the same folder, the same key.
  const session = input.session_id || 'unknown';
  let heard = observe.readTold(session);
  // What was picked for the session's prompt comes first, before whatever its next call is: it bears on the
  // task, not on a file, and is said once (observe.briefBefore). Not to a subagent: its calls carry the
  // session's id (lib.mjs tells them apart by agent_id), and what it is told stays in its own context, so the
  // agent the person asked would never hear it.
  const briefing = input.agent_id ? null : observe.briefBefore?.({ ...input, cwd }, { told: heard });
  if (briefing) {
    // The hooks of one turn's parallel calls all get here before any has marked a thing: the one that makes
    // the claim says the briefing, and the others say nothing of it (observe.claimBrief). What was picked and
    // is gone since is marked with it, so no later call looks for it again.
    const ids = [...briefing.ids, ...(briefing.gone ?? [])];
    const mine = observe.claimBrief?.(session, briefing) === true;
    observe.markToldIds(session, ids);
    if (mine) {
      // where the turn stands as it is said: before which call, under which prompt, how long after the prompt it was made for
      const at = observe.briefedAt?.(session, briefing, { prompt_id: input.prompt_id ?? null }) ?? { call: null, same: null };
      noted('briefing', session, briefing.text, briefing.ids, {
        prompt: briefing.prompt ?? null,
        call_prompt: input.prompt_id ?? null,
        same_prompt: at.same,
        call: at.call,
        since_prompt_s: Number.isFinite(briefing.ts) ? Math.round((Date.now() - briefing.ts) / 10) / 100 : null,
      });
      return told('PreToolUse', briefing.text);
    }
    heard = { files: heard.files, ids: [...heard.ids, ...ids] };
  }
  const note = observe.recallBefore({ ...input, cwd }, { told: heard });
  // Marked as told only when there is something to tell, and told once: the
  // second edit of the file in this session gets nothing, and neither does
  // another file of a finding the session has heard.
  if (!note || !observe.markTold(session, note.file, note.ids)) return null;
  noted('file', session, note.text, note.ids);
  return told('PreToolUse', note.text);
}

main()
  .then((payload) => {
    if (payload) emitAndExit(payload);
    else finish();
  })
  .catch(finish);
