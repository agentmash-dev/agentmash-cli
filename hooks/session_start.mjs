#!/usr/bin/env node
// AgentMash SessionStart hook: before the first prompt, the heads-up the
// prompt hook gives (see prompt_note.mjs): the teammates' agents at work now
// on this branch, or in a file this session changed, in a few lines. Reports
// nothing; the prompt hook does that.
//
// For SessionStart, what this script prints is added to the agent's context,
// so it prints nothing but that one note, as hook JSON, and nothing at all
// when nobody is there; but for the person, the first time this machine
// reports to a room, the one line on what leaves it (see sharingNote in
// lib.mjs). Claude Code runs it in the background as the session
// opens and holds the agent's first reply until it is done, so nobody waits
// on it to type. It runs again after /clear and after a compaction, when what
// the agent was told before is gone, so it says what it finds whether or not
// that was said before. And it counts as the session's look at the team: the
// first prompt neither asks again nor says it again.

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
// The heads-up came after v0, and resolveConfig and buildTeamContext too:
// see the note in post_tool_use.mjs. This script is new to repositories, and
// a CLI of 0.4.0 or older setting one up again puts its own lib.mjs back
// beside it; a repository had no SessionStart then, and says nothing now.
import * as lib from './lib.mjs';

const GLOBAL = process.argv.includes('--global');
// Which agent runs this hook: null for Claude Code, else the one `--client`
// names, as `npx agentmash login` registers it with Codex or Copilot.
const CLIENT = lib.hookClient?.() ?? null;

// Moved once /team's budget is known (see below); this covers the room lookup.
let exitGuard = armExitGuard();
/** Kept between /team's own abort and the guard: the slack extendExitGuard gives a budget. */
const ABORT_MARGIN_MS = 500;

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
  const sessionId = input?.session_id || 'unknown';
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
  if (!lib.resolveConfig) return;
  // Beside a repository's own install, that install's session_start speaks,
  // and keeps the session's state (resolveConfig turns this one away too).
  // One committed before prompts had ids has no session_start to speak with,
  // and its edits lose their prompts: the person is told, as the session
  // starts, and not again after a compaction (see staleInstallNote).
  if (GLOBAL && !CLIENT && lib.hasRepoInstall?.(projectDir)) {
    const stale = input?.source === 'compact' ? null : lib.staleInstallNote?.(projectDir);
    if (stale) emitAndExit({ systemMessage: stale });
    return;
  }
  const config = await lib.resolveConfig(projectDir, { global: GLOBAL, client: CLIENT });
  // Paused until this machine signs in again: said as the session starts, and
  // kept, so its prompts do not say it again (see prompt_note.mjs).
  const paused = lib.pausedNote?.(config);
  if (paused) {
    lib.writeNoteState?.(sessionId, { ...lib.readNoteState?.(sessionId), checked_at: Date.now(), paused: true });
    emitAndExit({ systemMessage: paused, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: paused } });
    return;
  }
  if (config.disabled || !config.room) return;

  // What leaves this machine for the room, said once per machine and room,
  // as a line for the person (sharingNote in lib.mjs): beside whatever else
  // the session starts with, and kept as told only once it is said. Claude
  // Code's own run says it: another agent shows its agent's note, not this.
  // Nor a run nobody watches (`claude -p`, the SDK, a GitHub action, which
  // Claude Code names in CLAUDE_CODE_ENTRYPOINT): said there, it would be kept
  // as told, and the person's own first session would never say it.
  const entry = process.env.CLAUDE_CODE_ENTRYPOINT ?? '';
  const unwatched = /^sdk-/.test(entry) || entry === 'claude-code-github-action';
  const sharing = CLIENT || unwatched ? null : (lib.sharingNote?.(config) ?? null);
  const done = (payload = null) => {
    if (!payload && !sharing) return;
    if (sharing) lib.noteSharingTold?.(config);
    const said = sharing ? [payload?.systemMessage, sharing].filter(Boolean).join('\n') : payload?.systemMessage;
    emitAndExit({ ...payload, ...(said ? { systemMessage: said } : {}) });
  };

  // The look the first prompt would take, taken now: kept before the request
  // goes, so a prompt sent while this waits does not ask as well.
  const asked = Date.now();
  lib.writeNoteState?.(sessionId, { ...lib.readNoteState?.(sessionId), checked_at: asked });

  const developer = getDeveloper(config, input?.cwd);
  // /team gets the advisory budget, or what a slow room lookup left of the
  // hook's five seconds, and the exit guard goes after it, so the abort lands
  // and its socket closes before process.exit could cut into it (see finish
  // in lib.mjs). A flat 4 s guard put the two at the same moment in a room
  // whose timeout_ms is 4000. Whole milliseconds, which is all
  // AbortSignal.timeout takes. A lib.mjs from before that deadline keeps the
  // flat guard, and the budget, it always had.
  let timeoutMs = config.advisoryTimeoutMs;
  if (lib.extendExitGuard && lib.HOOK_DEADLINE_MS) {
    exitGuard = lib.extendExitGuard(exitGuard, timeoutMs);
    timeoutMs = Math.min(timeoutMs, Math.floor(lib.HOOK_DEADLINE_MS - ABORT_MARGIN_MS - performance.now()));
    if (timeoutMs <= 0) return done();
  }
  const asking = {
    room: config.room,
    token: config.token,
    user: config.user,
    dev: config.dev,
    timeoutMs,
  };
  const teamUrl = `${config.url}/team?developer=${encodeURIComponent(developer)}`;
  const branch = getGitBranch(input?.cwd || projectDir);
  // what the session has changed so far, after a compaction; empty for a
  // new session, and after /clear or on a resume too: session_end cleared
  // the session's files when it last ended
  const touched = lib.readTouched?.(sessionId);
  // The whole answer where the lib gives it, so a room that turned the key
  // away for being in a public repository, or the sign-in beside it for being
  // too old, can be said once, as the session starts: every report this
  // session makes is turned away the same way. Beside it, at the same time,
  // the lobby's block, where the room gives one (see lobbyContext in lib.mjs).
  const [answer, lobby] = await Promise.all([
    lib.httpStatus ? lib.httpStatus('GET', teamUrl, asking) : null,
    lib.lobbyContext ? lib.lobbyContext(config, { developer, sessionId, branch, touched, timeoutMs }) : null,
  ]);
  const keyPublic = lib.keyPublicNote?.(answer, config);
  if (keyPublic) {
    emitAndExit({ systemMessage: keyPublic, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: keyPublic } });
    return;
  }
  // A lobby room words the whole note itself; the session's prompts ask it again (prompt_note.mjs).
  if (lobby) {
    lib.writeNoteState(sessionId, { checked_at: asked, said: lib.lobbySaid(lobby.version) });
    return done(lobby.text ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lobby.text } } : null);
  }
  const team = lib.httpStatus
    ? answer && answer.status >= 200 && answer.status < 300
      ? answer.json
      : null
    : await httpJson('GET', teamUrl, asking);

  // A lib.mjs from before the heads-up tells the whole team, as this hook always did.
  if (!lib.headsUp) {
    const note = lib.buildTeamContext?.(team, { showHints: config.shareHints });
    return done(note ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } } : null);
  }
  if (!team) return done();
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
  // The lobby did not answer this once (null, not false): the heads-up speaks now, and the session's
  // prompts ask the lobby again (prompt_note.mjs), so one slow answer doesn't cost the session its block.
  const said = lobby === null && lib.lobbyContext && lib.lobbySaid ? lib.lobbySaid('') : signature;
  // Teammate requests waiting for this person, in the room's own one line
  // (inboxNoteOf in lib.mjs), after the heads-up: said as the session starts,
  // and at a prompt only once it changes.
  const inbox = lib.inboxNoteOf?.(team) ?? null;
  lib.writeNoteState(sessionId, { checked_at: asked, said, inbox });
  const note = [text, inbox].filter(Boolean).join('\n');
  done(note ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } } : null);
}

main()
  .catch(() => {})
  .finally(finish);
