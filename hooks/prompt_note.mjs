#!/usr/bin/env node
// AgentMash UserPromptSubmit hook, the half Claude Code waits on: a short
// heads-up for this agent when a teammate's agent is at work on its branch,
// or in a file this session changed, and nothing at all otherwise.
//
// Claude Code holds the prompt until every UserPromptSubmit hook that is not
// async has finished, and adds what it prints to the agent's context. So the
// prompt is reported by user_prompt_submit.mjs, in the background, and this
// hook does the one thing a prompt waits for. Once in ten minutes at most it
// asks the room who is at work (GET /team), under a budget of its own, and it
// speaks only when that is news (see "the heads-up at a prompt" in lib.mjs).
// Every other prompt costs node starting and a file read, and no prompt ever
// waits on the report.
//
// Registered with `timeout: 3`. A hook that reaches its timeout is cancelled
// with a notice in the transcript, so the exit guard goes well before it.

import {
  armExitGuard,
  emitAndExit,
  finish,
  getDeveloper,
  getGitBranch,
  httpJson,
  parseJson,
  readStdin,
} from './lib.mjs';
// Everything the heads-up needs came after v0, resolveConfig too: see the
// note in post_tool_use.mjs. This script is new to repositories, and a CLI
// of 0.4.0 or older setting one up again puts its own lib.mjs back beside it.
import * as lib from './lib.mjs';

const GLOBAL = process.argv.includes('--global');
// Which agent runs this hook: null for Claude Code, else the one `--client`
// names, as `npx agentmash login` registers it with Codex or Copilot.
const CLIENT = lib.hookClient?.() ?? null;

// Inside the three seconds, with node's start and a room lookup and /team:
// counted from the moment the process started, as extendExitGuard counts in
// lib.mjs, so node starting and lib.mjs loading on a busy machine come out of
// it too, and not out of the half second left before Claude Code's timeout.
// Whole milliseconds: AbortSignal.timeout refuses a fraction, and /team's
// budget can be what is left of this.
const GUARD_MS = 2500;
const guardAt = Date.now() + Math.max(0, Math.floor(GUARD_MS - performance.now()));
armExitGuard(guardAt - Date.now());
/**
 * Kept between /team's own abort and the guard, so the abort lands and its
 * socket closes before process.exit could cut into it (see finish in lib.mjs).
 */
const ABORT_MARGIN_MS = 250;

/**
 * The heads-up's lines on teammates' work not merged yet in the files this
 * session changed: { text, signature }, both '' when there is none, or when
 * the lib.mjs beside this hook has no way to say it.
 */
async function unmergedLines(team, touched, cwd, sessionId, config) {
  const none = { text: '', signature: '' };
  if (!lib.unmergedNote || !(touched instanceof Set) || touched.size === 0 || !Array.isArray(team?.unmerged)) return none;
  const top = lib.gitCheckout?.(cwd)?.top ?? null;
  const asked = { touched, checkout: top ? (lib.checkoutId?.(top) ?? null) : null, showHints: config.shareHints };
  const first = lib.unmergedNote(team, asked);
  if (!first.text || first.shas.length === 0 || !lib.inHistory || !top) return first;
  const budgetMs = Math.min(400, guardAt - Date.now() - ABORT_MARGIN_MS);
  if (budgetMs <= 0) return first;
  return lib.unmergedNote(team, { ...asked, history: await lib.inHistory(top, first.shas, { budgetMs, sessionId }) });
}

async function main() {
  const parsed = parseJson(await readStdin());
  // Another agent's payload, read as Claude Code's (see normalizeHookInput).
  const input = lib.normalizeHookInput?.(parsed) ?? parsed;
  // Cursor runs this hook too, and reports its edits through its own adapter (see ranByCursor).
  if (lib.ranByCursor?.(input)) return;
  // and Droid, when it imported Claude Code's hooks: its own report it (see ranByDroid)
  if (lib.ranByDroid?.(input, CLIENT)) return;
  // and the Copilot CLI, when it loaded Claude Code's hooks beside its own: those report it (see ranByCopilotCli)
  if (lib.ranByCopilotCli?.(parsed, CLIENT)) return;
  // A lib.mjs from before the heads-up has nothing to say it with: nothing
  // is asked, and the prompt waits on nothing more.
  if (!lib.headsUp || !lib.readNoteState || !lib.userPromptText || !lib.resolveConfig) return;
  // A turn the harness sent is nobody's prompt, and no moment to tell the
  // agent about its team (see userPromptText).
  if (!lib.userPromptText(input)) return;

  const sessionId = input?.session_id || 'unknown';
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
  // Beside a repository's own install, that install's heads-up speaks, and
  // keeps the session's state; two would say everything twice.
  if (GLOBAL && !CLIENT && lib.hasRepoInstall?.(projectDir)) return;

  // The room turned this session's reports away because the team's plan has
  // no seat for this developer (a 402; noteRefusal in lib.mjs): the server's
  // words, said once, to the developer and the agent, whatever the heads-up's
  // ten minutes. One file read on every other prompt, which fails fast.
  const refused = lib.refusalNote?.(sessionId);
  if (refused) {
    emitAndExit({ systemMessage: refused, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: refused } });
    return;
  }

  const state = lib.readNoteState(sessionId);
  const now = Date.now();
  // A last look dated after now is a clock that went back since, and holds
  // nothing off: waited out, it would keep the agent from hearing anything
  // for as long as the clock moved.
  if (now >= state.checked_at && now - state.checked_at < lib.NOTE_INTERVAL_MS) return;
  // Kept before anything can wait on the network: a room that is slow to
  // answer, or not there, costs one prompt in ten minutes, not every one.
  lib.writeNoteState(sessionId, { ...state, checked_at: now });

  const config = await lib.resolveConfig(projectDir, { global: GLOBAL, client: CLIENT });
  // Paused until this machine signs in again: one line, once a session, for a
  // session already running when it happened (session_start says it to a new
  // one). Its prompts after that cost the look they always did, and say nothing.
  const paused = lib.pausedNote?.(config);
  if (paused) {
    if (state.paused) return;
    lib.writeNoteState(sessionId, { ...state, checked_at: now, paused: true });
    emitAndExit({ systemMessage: paused, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: paused } });
    return;
  }
  if (config.disabled || !config.room) return;
  const developer = getDeveloper(config, input?.cwd);
  const branch = getGitBranch(input?.cwd || projectDir);
  const touched = lib.readTouched?.(sessionId);
  // A room lookup that took its time (a login's first prompt in a checkout)
  // leaves /team what the guard has left, so its abort still comes first.
  let left = guardAt - Date.now() - ABORT_MARGIN_MS;
  if (left <= 0) return;
  // A session the lobby's block was given (session_start.mjs) asks the lobby
  // again, and says it again only when it changed. A room that stopped giving
  // it gets the heads-up, as before the lobby, in what is left of the budget.
  // A room that did not answer this once (slow, a 5xx, a 429) says nothing now
  // and stays a lobby room: the session asks the lobby again at its next look.
  if (lib.lobbyContext && lib.lobbySaid && typeof state.said === 'string' && state.said.startsWith('lobby:')) {
    const lobby = await lib.lobbyContext(config, {
      developer,
      sessionId,
      branch,
      touched,
      timeoutMs: Math.min(config.advisoryTimeoutMs, lib.NOTE_TIMEOUT_MS, left),
    });
    if (lobby) {
      const said = lib.lobbySaid(lobby.version);
      lib.writeNoteState(sessionId, { checked_at: now, said });
      if (lobby.text && said !== state.said) {
        emitAndExit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lobby.text } });
      }
      return;
    }
    // no answer (null), as opposed to the room turning it off (false): state.said keeps the lobby's marker
    if (lobby === null) return;
    left = guardAt - Date.now() - ABORT_MARGIN_MS;
    if (left <= 0) return;
  }
  const team = await httpJson('GET', `${config.url}/team?developer=${encodeURIComponent(developer)}`, {
    room: config.room,
    token: config.token,
    user: config.user,
    dev: config.dev,
    timeoutMs: Math.min(config.advisoryTimeoutMs, lib.NOTE_TIMEOUT_MS, left),
  });
  if (!team) return;

  const top = lib.gitCheckout?.(input?.cwd || projectDir)?.top ?? null;
  const { text, signature } = lib.headsUp(team, {
    branch,
    touched,
    showHints: config.shareHints,
    // only a repository that registers the MCP server gives the agent the
    // tool to send it to; a login gives it none
    tool: !GLOBAL && lib.registersMcpServer?.(projectDir) === true,
    // this checkout, to tell a teammate in it from one in a clone of their
    // own, whose edits re-reading a file here cannot show
    checkout: top ? (lib.checkoutId?.(top) ?? null) : null,
  });
  // And teammates' work not merged yet in a file this session changed, as
  // /team's `unmerged` has it, whenever it was written (unmergedNote in
  // lib.mjs): the commits it names are looked for in this checkout's history
  // first, with what the guard leaves, and what is there already is not said.
  const memory = await unmergedLines(team, touched, input?.cwd || projectDir, sessionId, config);
  // The agent has what was said last: the same teammates, there for the same
  // reasons, are not news, and nor are fewer of them. Somebody new, somebody
  // back, or a new reason to name somebody is. Who is there now is kept
  // either way, so a teammate who goes quiet and comes back is news again.
  // The room's line about teammate requests waiting for this person
  // (inboxNoteOf in lib.mjs) is news when it changed: a new request, or one
  // fewer. Gone, it is forgotten, so the next one is news again.
  const inbox = lib.inboxNoteOf?.(team) ?? null;
  const said = [signature, memory.signature].filter(Boolean).join('\n');
  lib.writeNoteState(sessionId, { checked_at: now, said, inbox });
  const news = [
    text && lib.isNews(signature, state.said) ? text : '',
    memory.text && lib.isNews(memory.signature, state.said) ? memory.text : '',
    inbox && inbox !== state.inbox ? inbox : '',
  ]
    .filter(Boolean)
    .join('\n');
  if (news) {
    emitAndExit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: news } });
  }
}

main()
  .catch(() => {})
  .finally(finish);
