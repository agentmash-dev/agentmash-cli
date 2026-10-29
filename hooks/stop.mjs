#!/usr/bin/env node
// AgentMash Stop hook: a word, once, as a session finishes having changed a
// file a teammate changed too.
//
// As the agent is about to end its turn, ask the room whether any file this
// session edited was also edited by someone else. If so, say so, as a message
// for the person at the keyboard: which files, whose change each meets, and
// what each side was for. That is the moment a person can still decide how the
// two come together, before either lands.
//
// It only ever advises. It never blocks the finish (no decision "block", no
// exit 2) and never asks for a fetch, a branch, a commit, a push or a pull
// request. It used to: it blocked with a brief to reconcile first, which ended
// a headless run as an error, and an agent with broad permissions pushed a
// branch and opened a pull request on its own, for a teammate's change nobody
// had pushed. Every reconcile_mode the room may have is advice now; 'off'
// still means say nothing.
//
// Guards:
//   - once per collision per session: the key is file + developers, so the
//     same overlap is not said at every turn's end.
//   - stop_hook_active: Claude Code sets this when the agent is continuing
//     because of a Stop hook (somebody else's); nothing is asked then.
//   - a session that has changed no file yet: nothing is asked either.
//   - the same fail-open contract as every other hook: unreachable, slow, or
//     odd server → exit 0, say nothing, the agent finishes normally.

import {
  ADVISORY_TIMEOUT_MS,
  armExitGuard,
  emitAndExit,
  finish,
  getDeveloper,
  httpJson,
  resolveConfig,
  parseJson,
  readSessionCache,
  readStdin,
  writeSessionCache,
} from './lib.mjs';
// Guarded access: an older vendored lib.mjs may predate the brief builder.
import * as lib from './lib.mjs';

const GLOBAL = process.argv.includes('--global');
// Which agent runs this hook: null for Claude Code, else the one `--client`
// names, as `npx agentmash login` registers it with Codex or Copilot.
const CLIENT = lib.hookClient?.() ?? null;

const EXIT_GUARD_SLACK_MS = 250;
const exitGuard = armExitGuard(ADVISORY_TIMEOUT_MS + EXIT_GUARD_SLACK_MS);

async function main() {
  const parsed = parseJson(await readStdin());
  // Another agent's payload, read as Claude Code's (see normalizeHookInput).
  const input = lib.normalizeHookInput?.(parsed) ?? parsed;
  // Cursor runs this hook too, and reports its edits through its own adapter (see ranByCursor).
  if (lib.ranByCursor?.(input)) return null;
  // and Droid, when it imported Claude Code's hooks: its own report it (see ranByDroid)
  if (lib.ranByDroid?.(input, CLIENT)) return null;
  // and the Copilot CLI, when it loaded Claude Code's hooks beside its own: those report it (see ranByCopilotCli)
  if (lib.ranByCopilotCli?.(parsed, CLIENT)) return null;
  if (!input || input.stop_hook_active === true) return null;

  const sessionId = input.session_id || 'unknown';
  // A session that changed no file has no file a teammate changed too, and
  // the room reads a session's overlaps off its own edits alone: so it is not
  // asked, and the turn ends without waiting on it, where every turn used to,
  // edits or not. What the session changed is what its edit hooks noted
  // (noteTouched in lib.mjs), the list the heads-up goes by too: what its
  // agent changed. A file the working tree had changed before it, or by hand
  // between prompts, is not this session's doing, and is not asked about on
  // its own. A lib.mjs from before that list asks at every turn, as it did.
  if (lib.readTouched && lib.readTouched(sessionId).size === 0) return null;

  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const config = await resolveConfig(projectDir, { global: GLOBAL, client: CLIENT });
  if (config.disabled || !config.room) return null;

  if (config.advisoryTimeoutMs > ADVISORY_TIMEOUT_MS) {
    clearTimeout(exitGuard);
    armExitGuard(config.advisoryTimeoutMs + EXIT_GUARD_SLACK_MS);
  }

  const developer = getDeveloper(config, input.cwd);
  // advisory=1: this hook only advises, so the server may say what the room's
  // reconcile mode is. To a hook that does not say so, one from before, which
  // blocks on any mode but 'off', the server answers 'off'.
  // memory=1, with a lib.mjs that can look in this checkout's history: every
  // teammate's unmerged work on another branch that meets this session's
  // files, for this hook to leave out what HEAD has already (below). Without,
  // the server sends the newest of it, as to a hook from before.
  const memory = typeof lib.inHistory === 'function';
  const url =
    `${config.url}/collisions?developer=${encodeURIComponent(developer)}` +
    `&session_id=${encodeURIComponent(sessionId)}&advisory=1${memory ? '&memory=1' : ''}`;
  const result = await httpJson('GET', url, {
    room: config.room,
    token: config.token,
    user: config.user,
    dev: config.dev,
    timeoutMs: config.advisoryTimeoutMs,
  });
  const mode = typeof result?.reconcile_mode === 'string' ? result.reconcile_mode : 'approve';
  const all = Array.isArray(result?.collisions) ? result.collisions : [];
  if (mode === 'off' || all.length === 0) return null;

  const cache = readSessionCache(sessionId);
  const prompted = cache.reconcile_prompted && typeof cache.reconcile_prompted === 'object' ? cache.reconcile_prompted : {};
  let fresh = all.filter((c) => typeof c?.key === 'string' && !prompted[c.key]);
  if (fresh.length === 0) return null;

  // A teammate's unmerged work whose commit is in this checkout's history,
  // and that they have not changed since, is no overlap here: it is already
  // under this session's own changes.
  const named = fresh.flatMap((c) => (c.kind === 'branch' ? (c.theirs ?? []).map((t) => t?.commit).filter(Boolean) : []));
  // inside what the exit guard leaves, and never more than 400 ms
  const guardMs = Math.max(config.advisoryTimeoutMs, ADVISORY_TIMEOUT_MS) + EXIT_GUARD_SLACK_MS;
  const budgetMs = Math.min(400, guardMs - performance.now() - 100);
  if (memory && named.length > 0 && budgetMs > 0) {
    const history = await lib.inHistory(projectDir, named, { budgetMs, sessionId });
    const had = (t) => typeof t?.commit === 'string' && history.get(t.commit.toLowerCase()) === true && !t.changed_since_commit && !t.uncommitted;
    fresh = fresh.filter((c) => c.kind !== 'branch' || !(c.theirs ?? []).every(had));
    if (fresh.length === 0) return null;
  }

  // A lib.mjs from before the note says nothing, rather than block as the
  // brief it had once did.
  const note = lib.buildOverlapNote?.({ collisions: fresh, showHints: config.shareHints });
  if (!note) return null;

  for (const c of fresh) prompted[c.key] = Date.now();
  cache.reconcile_prompted = prompted;
  writeSessionCache(sessionId, cache);

  // systemMessage is shown to the person and decides nothing: no `decision`,
  // so the turn ends as it was going to.
  return { systemMessage: note };
}

main()
  .then((payload) => {
    if (payload) emitAndExit(payload);
    else finish();
  })
  .catch(finish);
