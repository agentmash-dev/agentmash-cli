#!/usr/bin/env node
// AgentMash UserPromptSubmit hook, the report: tell the room about the prompt
// (it is what every teammate's agent and the live view will see this
// developer working on), and keep it as the prompt this session's next edits
// are for.
//
// Registered async, in a repository install and in the one `npx agentmash
// login` makes alike: Claude Code does not wait for it, and what an async hook
// prints reaches the agent on the next turn, if at all. So it prints nothing.
// The heads-up on what teammates' agents are doing is prompt_note.mjs's, the
// one prompt hook that runs in line.
//
// It also looks at the working tree, for the files no edit hook reported:
// at a session's first prompt, work that was already uncommitted, and after
// that, whatever changed between prompts (see catchUp below).

import {
  armExitGuard,
  finish,
  getDeveloper,
  getGitBranch,
  httpJson,
  parseJson,
  PROMPT_CHARS,
  readSessionCache,
  readStdin,
  resolveConfig,
  truncate,
  writeSessionCache,
} from './lib.mjs';
// Namespace import for anything added after v0: hooks and lib.mjs are vendored
// into the repo and can drift apart in a partial merge, and a missing *named*
// import is a module-link error (see post_tool_use.mjs).
import * as lib from './lib.mjs';

const GLOBAL = process.argv.includes('--global');
// Which agent runs this hook: null for Claude Code, else the one `--client`
// names, as `npx agentmash login` registers it with Codex or Copilot.
const CLIENT = lib.hookClient?.() ?? null;
const DETACH = process.argv.includes('--detach');

let exitGuard = armExitGuard();

/** Let the report budget, not the guard, end a slow report (see post_tool_use.mjs). */
function holdExitGuard(budgetMs) {
  exitGuard = lib.extendExitGuard?.(exitGuard, budgetMs) ?? exitGuard;
}

/** Send one event through the path that logs a report that does not arrive, or, with an older lib.mjs, as always. */
function report(config, body, projectDir) {
  if (lib.reportEvent) return lib.reportEvent(config, body, { hook: 'user_prompt_submit', project: projectDir });
  return httpJson('POST', `${config.url}/events`, {
    room: config.room,
    token: config.token,
    user: config.user,
    dev: config.dev,
    timeoutMs: config.reportTimeoutMs,
    body,
  });
}

/**
 * The files in this repository that changed without any hook reporting
 * them, reported as edits under no prompt, since none of them is this one's.
 * At a session's first prompt: the tracked files that were already
 * uncommitted, a hand edit or a session that ran without hooks, work nobody
 * else could see. After that: what changed between prompts, by hand or by a
 * command still running in the background after its own hook. Each goes out
 * as of now, so a teammate about to edit it is warned (see
 * reportChangedFiles), and says when its file was last written, so an
 * hour-old change never reads as one made a moment ago. What another session
 * in this checkout reported, under its own prompt, stays that report.
 *
 * The look is taken either way, since it is what the next Bash command is
 * compared with; AGENTMASH_WORKTREE=0 or share_worktree false withholds what
 * it finds, which is noted all the same, so another session's command does
 * not send it as its own. A lib.mjs from before the look has none to take.
 */
async function catchUp(input, config, projectDir, sessionId, developer) {
  if (!lib.worktreeLook) return;
  const look = await lib.worktreeLook(sessionId, projectDir, { baseline: true });
  if (!look) return;
  const files = look.baseline ? look.uncommitted : look.changed;
  if (files.length === 0) return;
  lib.noteWorktreeFiles?.(look, files);
  if (config.shareWorktree === false) return;
  holdExitGuard(config.reportTimeoutMs);
  await lib.reportChangedFiles(
    config,
    files,
    {
      developer: developer ?? getDeveloper(config, input?.cwd),
      session_id: sessionId,
      tool: lib.clientTool?.(CLIENT, 'worktree') ?? 'worktree',
      git_branch: getGitBranch(look.top),
      checkout_id: lib.checkoutId?.(look.top) ?? null,
      task_hint: null,
      prompt_id: null,
      symbols: null,
      agent_type: null,
      timestamp: new Date().toISOString(),
    },
    {
      summary: look.baseline ? 'uncommitted before this session started' : 'changed between prompts, by hand or in the background',
      hook: 'user_prompt_submit',
      project: projectDir,
      written: look.written,
    }
  );
}

/**
 * What only this machine can tell the room about work on branches, with the
 * git it takes, here, where nobody waits (see "work on teammates' branches
 * that isn't merged yet" in lib.mjs): a commit made since the session last
 * looked, by hand or by the agent, reported as the git client reports one
 * (commitCatchUp); then, side by side, this developer's own branches that
 * have merged or gone, at most once in half an hour (ownerMergeCheck), and the
 * commits this session was told about that are in the default branch now
 * (mergedCheck). A lib.mjs from before has none of it. First of all, a note
 * that the branches are looked at here (noteBranchLook), for a claim the
 * agent makes before the owner's check gets to note its own.
 */
async function branchWork(config, projectDir, sessionId, developer) {
  if (!lib.commitCatchUp) return;
  if (developer) {
    try {
      lib.noteBranchLook?.(projectDir);
    } catch {
      // a note not kept is a claim for its TTL, as before
    }
  }
  holdExitGuard(config.reportTimeoutMs);
  await lib.commitCatchUp(config, sessionId, projectDir, { developer, hook: 'user_prompt_submit' });
  await Promise.all([
    lib.ownerMergeCheck?.(config, projectDir, { developer, sessionId }),
    lib.mergedCheck?.(config, projectDir, sessionId, { developer }),
  ]);
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
  // Only what the developer wrote. A turn Claude Code sent on its own (a
  // background task's notification, another session's message, a CI event, a
  // wakeup) comes back empty: nothing is cached, so the edits after it keep
  // the prompt they are really about, and no prompt is reported (prompt_note
  // tells the agent nothing for it either). Around a typed prompt, the
  // harness's context is left out.
  // It is cleaned before it is cut: the wrappers are found by their lines,
  // which truncate() folds together. A lib.mjs older than the cleaner gets the
  // turn as it came, which is what this hook always sent.
  const typed =
    lib.userPromptText?.(input) ??
    (typeof input?.prompt === 'string'
      ? input.prompt
      : typeof input?.user_prompt === 'string'
        ? input.user_prompt
        : '');
  // And a secret pasted into it is masked, before it is cut too: what is kept
  // here is what every edit after it reports (redactSecrets in lib.mjs).
  const hint = truncate(lib.redactSecrets?.(typed) ?? typed, PROMPT_CHARS);

  const sessionId = input?.session_id || 'unknown';
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
  // Installed by `npx agentmash login` and working in a repository that has
  // its own install, this hook runs beside the repository's for every prompt.
  // That one reports the prompt, so it keeps it: a second writer would put an
  // id of its own in the prompt file, one no prompt event carries, and every
  // edit after it would name a prompt the room never heard. resolveConfig
  // turns this hook away there in any case; it just leaves before writing.
  if (GLOBAL && !CLIENT && lib.hasRepoInstall?.(projectDir)) return;

  // A turn nobody typed is still a moment the working tree can have moved:
  // a background command's notification comes right after its files were
  // written. Those are caught up on, and nothing else happens. This hook runs
  // in the background in both installs, so nobody waits on the look. (A login
  // install used to run it in line, and let a turn nobody typed go by at once,
  // leaving what moved to the next prompt somebody typed.)
  if (!hint) {
    if (!lib.worktreeLook) return;
    // nobody waits on this hook, so it may ask again whether a repository nobody
    // connected is connected yet (background, in resolveConfig)
    const config = await resolveConfig(projectDir, { global: GLOBAL, client: CLIENT, background: true });
    if (config.disabled || !config.room) return;
    const developer = getDeveloper(config, input?.cwd);
    await Promise.all([catchUp(input, config, projectDir, sessionId, developer), branchWork(config, projectDir, sessionId, developer)]);
    return;
  }

  // From here on the session's edits are this prompt's, under its own id,
  // until the next one; a subagent already at work keeps the prompt that
  // started it (see pinAgentPrompt). A lib.mjs older than the prompt file
  // keeps it in the session cache, as it always did, and has no id to send.
  let promptId = null;
  if (lib.writePrompt) {
    promptId = lib.writePrompt(sessionId, hint).prompt_id;
  } else {
    const cache = readSessionCache(sessionId);
    cache.task_hint = hint;
    writeSessionCache(sessionId, cache);
  }

  const config = await resolveConfig(projectDir, { global: GLOBAL, client: CLIENT, background: true });
  if (config.disabled || !config.room) return;
  holdExitGuard(config.reportTimeoutMs);

  const developer = getDeveloper(config, input?.cwd);
  await Promise.all([
    report(
      config,
      {
        developer,
        session_id: sessionId,
        event_type: 'prompt',
        // null from Claude Code, as always; another agent's name from it
        tool: lib.clientTool?.(CLIENT, null) ?? null,
        file_path: null,
        git_branch: getGitBranch(input?.cwd || projectDir),
        // AGENTMASH_HINTS=0 still reports that this developer is working — it
        // withholds only what they are working on, which is the verbatim prompt.
        task_hint: config.shareHints ? hint : null,
        // Random, so it says which edits this prompt caused and nothing about
        // what it says: it goes with hints off too.
        prompt_id: promptId,
        timestamp: new Date().toISOString(),
      },
      projectDir
    ),
    // alongside the report, so the hook is done as soon as the slower of these
    catchUp(input, config, projectDir, sessionId, developer),
    branchWork(config, projectDir, sessionId, developer),
  ]);
}

main()
  .catch(() => {})
  .finally(finish);
