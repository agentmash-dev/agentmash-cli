#!/usr/bin/env node
// AgentMash SessionEnd hook: tell the server this session is over, so the
// dashboard can stop showing someone as active after they've stopped working.
//
// This is the *only* moment a client can honestly say "I'm leaving", and it is
// not enough on its own: Claude Code fires SessionEnd when a session ends in an
// orderly way (exit, /clear, logout, prompt_input_exit), and never when a laptop
// lid closes, a terminal is killed, or the process crashes. Nothing runs on the
// developer's machine between hooks, so those cases send nothing at all and the
// server has to infer them by decay. What this hook owes the server is the
// cheap, certain half: report the end, and say *why* it ended, because "/clear"
// (same human, new session) and "logout" (human gone) mean different things.
//
// SessionEnd hooks share a small time budget, so this is even more
// aggressively fail-fast than the others — but the contract is the same:
// exit 0, silently, no matter what.

import {
  armExitGuard,
  clearSessionCache,
  finish,
  getDeveloper,
  getGitBranch,
  httpJson,
  resolveConfig,
  parseJson,
  readSessionCache,
  readStdin,
} from './lib.mjs';
// See the note in post_tool_use.mjs: guarded access for post-v0 helpers.
import * as lib from './lib.mjs';

const GLOBAL = process.argv.includes('--global');
// Which agent runs this hook: null for Claude Code, else the one `--client`
// names, as `npx agentmash login` registers it with Codex or Copilot.
const CLIENT = lib.hookClient?.() ?? null;
const DETACH = process.argv.includes('--detach');

armExitGuard(2500);

/** Claude Code's SessionEnd reasons, kept as a closed set so junk can't reach the board. */
const KNOWN_REASONS = new Set(['clear', 'logout', 'prompt_input_exit', 'exit', 'other']);

function endReason(input) {
  const raw = typeof input?.reason === 'string' ? input.reason.trim().toLowerCase() : '';
  if (!raw) return null;
  return KNOWN_REASONS.has(raw) ? raw : 'other';
}

async function main() {
  const raw = await readStdin();
  // A host that waits for every hook (Codex, Copilot) runs a report with
  // --detach: handed to a copy of this hook in the background, it costs the
  // agent nothing, as `async` does in Claude Code. A lib.mjs from before
  // that reports right here, as this hook always did.
  if (DETACH && lib.detach) {
    await lib.detach(raw);
    return;
  }
  const parsed = parseJson(raw);
  // Another agent's payload, read as Claude Code's (see normalizeHookInput).
  const input = lib.normalizeHookInput?.(parsed) ?? parsed;
  // Cursor runs this hook too, and reports its edits through its own adapter (see ranByCursor).
  if (lib.ranByCursor?.(input)) return;
  // and Droid, when it imported Claude Code's hooks: its own report it (see ranByDroid)
  if (lib.ranByDroid?.(input, CLIENT)) return;
  // and the Copilot CLI, when it loaded Claude Code's hooks beside its own: those report it (see ranByCopilotCli)
  if (lib.ranByCopilotCli?.(parsed, CLIENT)) return;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
  // Beside a repository's own install, the files are that install's to clear
  // (see user_prompt_submit.mjs). Run first and clearing them, this hook would
  // send the repository's session_end out with no prompt.
  if (GLOBAL && !CLIENT && lib.hasRepoInstall?.(projectDir)) return;
  const config = await resolveConfig(projectDir, { global: GLOBAL, client: CLIENT });
  const sessionId = input?.session_id || 'unknown';
  // The prompt the session was last on, read before its files go. A lib.mjs
  // older than the prompt file keeps it in the session cache.
  const taskHint = (lib.readPrompt?.(sessionId) ?? readSessionCache(sessionId)).task_hint || null;

  // Do this whether or not we can reach the server: the session is over either
  // way, and the temp files have nothing left to say.
  clearSessionCache(sessionId);

  if (config.disabled || !config.room) return;

  const body = {
    developer: getDeveloper(config, input?.cwd),
    session_id: sessionId,
    event_type: 'session_end',
    tool: lib.clientTool?.(CLIENT, null) ?? null,
    file_path: null,
    git_branch: getGitBranch(input?.cwd || projectDir),
    // AGENTMASH_HINTS=0 withholds the prompt here as on every other event: the
    // session ending is reported, what it was about stays on this machine
    task_hint: config.shareHints ? taskHint : null,
    // Older servers ignore unknown fields, so this stays safe to send.
    end_reason: endReason(input),
    timestamp: new Date().toISOString(),
  };
  // Through the path that logs a report that does not arrive; a lib.mjs from
  // before that log sends it the way this hook always did. Either way under
  // the advisory budget, the shortest there is.
  if (lib.reportEvent) {
    await lib.reportEvent(config, body, { hook: 'session_end', project: projectDir, timeoutMs: config.advisoryTimeoutMs });
    return;
  }
  await httpJson('POST', `${config.url}/events`, {
    room: config.room,
    token: config.token,
    user: config.user,
    dev: config.dev,
    timeoutMs: config.advisoryTimeoutMs,
    body,
  });
}

main()
  .catch(() => {})
  .finally(finish);
