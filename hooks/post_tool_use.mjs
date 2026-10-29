#!/usr/bin/env node
// AgentMash PostToolUse hook (Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell,
// and Devin's write|edit|apply_patch): report what the tool changed to the
// coordination server. An edit tool names its file, and a patch names each of
// its files in its text. A Bash or PowerShell command does not, so for those the hook reads
// the working tree and reports the files that moved (see "edits the edit tools
// never see" in lib.mjs). Fire-and-forget — always exits 0, and silent but for
// one line, in Claude Code, when teammate requests start waiting for this
// person (sayInboxNews); a report that does not arrive leaves a line in this
// machine's log instead.

import path from 'node:path';
import {
  armExitGuard,
  composeSummary,
  finish,
  getDeveloper,
  getGitBranch,
  httpJson,
  resolveConfig,
  parseJson,
  readSessionCache,
  readStdin,
  summarizeChange,
  takeOverrideNote,
  toRepoRelative,
  writeSessionCache,
} from './lib.mjs';
// Namespace import for anything added after v0: hooks and lib.mjs are vendored
// into the repo and can drift apart in a partial merge. A missing *named*
// import is a module-link error — a non-zero exit and a stack trace in the
// agent's transcript, which is exactly what these hooks promise never to do.
import * as lib from './lib.mjs';

const GLOBAL = process.argv.includes('--global');
// Which agent runs this hook: null for Claude Code, else the one `--client`
// names, as `npx agentmash login` registers it with Codex or Copilot.
const CLIENT = lib.hookClient?.() ?? null;
const DETACH = process.argv.includes('--detach');

/**
 * The tools that change files without naming them: Claude Code's and
 * Codex's Bash, Claude Code's PowerShell, the Copilot CLI's bash and
 * powershell, and Copilot's run_in_terminal in VS Code.
 */
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell', 'bash', 'powershell', 'run_in_terminal']);

/** The payload as it came, before normalizeHookInput: clientTool reads which agent sent it from its format. */
let rawInput = null;

/** What an event's `tool` says: the tool's name, and which agent's (see clientTool). */
const toolOf = (name) => lib.clientTool?.(CLIENT, name ?? null, rawInput) ?? name ?? null;

let exitGuard = armExitGuard();

/**
 * Let the report's own budget end a slow report, not the guard. A vendored
 * lib.mjs from before extendExitGuard keeps the 4 s guard it always had.
 */
function holdExitGuard(budgetMs) {
  exitGuard = lib.extendExitGuard?.(exitGuard, budgetMs) ?? exitGuard;
}

/**
 * Send one event, through the path that logs a report that does not arrive.
 * A lib.mjs from before that log sends it the way this hook always did. What
 * the room answers of requests waiting for this person is kept for this
 * hook's next run to say (keepInboxNote, sayInboxNews).
 */
async function report(config, body, projectDir) {
  const answer = lib.reportEvent
    ? await lib.reportEvent(config, body, { hook: 'post_tool_use', project: projectDir })
    : await httpJson('POST', `${config.url}/events`, {
        room: config.room,
        token: config.token,
        user: config.user,
        dev: config.dev,
        timeoutMs: config.reportTimeoutMs,
        body,
      });
  lib.keepInboxNote?.(body.session_id, answer);
  return answer;
}

/**
 * Teammate requests waiting for this person, in the room's one line, when an
 * edit's report heard of new ones since the session was last told (inboxNews
 * in lib.mjs): said to the agent after this tool, from a file, with no wait on
 * the network, so it can mention them before the person's next prompt. Only
 * in Claude Code's own run of this hook, which hands its agent what the hook
 * adds after a tool. Saying it marks it told, and the prompt's heads-up then
 * leaves it out, so a host not yet seen to hand it on keeps the line for its
 * next prompt, as before: another agent's run (--client), and Devin's, which
 * runs these same hooks with none. Never a word of the requests themselves.
 */
function sayInboxNews(input) {
  if (CLIENT || process.env.AGENTMASH_DISABLE === '1') return;
  // Devin's edits, named its own (see clientTool)
  if (String(toolOf(input?.tool_name) ?? '').startsWith('devin:')) return;
  const sessionId = input?.session_id;
  const news = typeof sessionId === 'string' && sessionId ? (lib.inboxNews?.(sessionId) ?? null) : null;
  if (news) lib.emitAndExit?.({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: news } });
}

/**
 * Where the edited file sits in this repository, or null when it is not in it
 * (see locateInRepo). A vendored lib.mjs from before locateInRepo has only
 * toRepoRelative, which hands a file outside the project back as its absolute
 * path: exactly what must never reach the room, so that answer is refused
 * here, and the file is placed at the project's top as it always was.
 */
function locate(projectDir, filePath, cwd) {
  if (lib.locateInRepo) return lib.locateInRepo(projectDir, filePath, { cwd });
  const rel = toRepoRelative(projectDir, filePath);
  return rel && !/^(?:[A-Za-z]:|\/|~(?:\/|$)|\.\.(?:\/|$))/.test(rel) ? { rel, top: projectDir } : null;
}

/**
 * The prompt this edit was made under (see promptForEdit): the one a subagent
 * started under, pinned when it first reached for a file, or else the
 * session's. A vendored lib.mjs from before the prompt file has the session
 * cache's hint and no id, which is what this hook always sent.
 */
function promptFor(sessionId, agentId) {
  return (
    lib.promptForEdit?.(sessionId, agentId) ?? { task_hint: readSessionCache(sessionId).task_hint || null, prompt_id: null }
  );
}

/**
 * A Bash or PowerShell command: the files in this repository that moved
 * since the session's last look at its working tree, and that no hook here,
 * this session's or another's, has reported as they are now, reported as the
 * command's edits, under the prompt it ran for. Only this repository's: the
 * look is of the checkout the session's project is in, whatever else the
 * command touched. A lib.mjs from before the look reports nothing here, as
 * this hook never did.
 */
async function reportCommand(input, config, projectDir, sessionId, prompt, timestamp) {
  await Promise.all([reportLook(input, config, projectDir, sessionId, prompt, timestamp), reportNewCommits(input, config, projectDir, sessionId)]);
}

/**
 * A commit the command made (git commit, a cherry-pick), as the git client
 * reports one, when HEAD moved on its branch (see commitCatchUp in lib.mjs):
 * a teammate's agent is told of the work by its commit from then on, and
 * checks its own history for it. Read from the reflog, never a pull, a merge
 * or a rebase. Nothing where the git client is installed, which reports it
 * itself, and nothing beside a lib.mjs from before.
 */
async function reportNewCommits(input, config, projectDir, sessionId) {
  if (!lib.commitCatchUp) return;
  holdExitGuard(config.reportTimeoutMs);
  await lib.commitCatchUp(config, sessionId, projectDir, { developer: getDeveloper(config, input?.cwd), hook: 'post_tool_use' });
}

/** The files the command changed in the working tree (see reportCommand's note above). */
async function reportLook(input, config, projectDir, sessionId, prompt, timestamp) {
  if (!lib.worktreeLook) return;
  const look = await lib.worktreeLook(sessionId, projectDir);
  // The first look in a session has nothing to compare with: what is dirty
  // now may be days old, and is not this command's doing. The prompt hook
  // reports that as work from before, even when this look got in ahead of it.
  if (!look || look.first || look.changed.length === 0) return;
  // this command's now, so another session's next look does not claim them too
  lib.noteWorktreeFiles?.(look, look.changed);
  // and this session's, for the heads-up at the next prompt (see noteTouched)
  lib.noteTouched?.(sessionId, look.changed);
  holdExitGuard(config.reportTimeoutMs);
  await lib.reportChangedFiles(
    config,
    look.changed,
    {
      developer: getDeveloper(config, input?.cwd),
      session_id: sessionId,
      tool: toolOf(input.tool_name),
      git_branch: getGitBranch(look.top),
      checkout_id: lib.checkoutId?.(look.top) ?? null,
      task_hint: config.shareHints ? prompt.task_hint || null : null,
      prompt_id: prompt.prompt_id ?? null,
      symbols: null,
      agent_type: lib.crewAgentOf?.(input?.agent_type) ?? null,
      timestamp,
    },
    { summary: `changed by a ${input.tool_name} command`, hook: 'post_tool_use', project: projectDir }
  );
}

/**
 * One call that changed several files, a patch (apply_patch: Codex's,
 * Devin's, Copilot's) or one of Copilot's edits across files: each file in
 * this repository reported as an edit of its own, at most
 * WORKTREE_MAX_REPORTS of them, `named` as { path, summary }. No symbols and
 * no diff: a patch carries hunks, not the file, and the names in them are a
 * guess.
 */
async function reportFiles(input, named, projectDir, sessionId, prompt, timestamp) {
  const files = [];
  for (const file of named) {
    const where = locate(projectDir, file.path, input?.cwd);
    if (where && !files.some((f) => f.where.rel === where.rel)) files.push({ file, where });
  }
  if (files.length === 0) return;
  // nobody waits on this hook, so it may ask again whether a repository nobody
  // connected is connected yet (background, in resolveConfig)
  const config = await resolveConfig(projectDir, { global: GLOBAL, client: CLIENT, background: true });
  if (config.disabled || !config.room) return;
  // a file git ignores is never merged, and nobody else's business (see gitIgnored)
  const ignored = (await lib.gitIgnored?.(files.map((f) => f.where), { sessionId })) ?? new Set();
  const merged = files.filter((f) => !ignored.has(f.where));
  if (merged.length === 0) return;
  holdExitGuard(config.reportTimeoutMs);
  const developer = getDeveloper(config, input?.cwd);
  const shown = merged.slice(0, lib.WORKTREE_MAX_REPORTS ?? 10);
  for (const { where } of shown) lib.noteWorktreeEdit?.(where.top, where.rel);
  lib.noteTouched?.(sessionId, shown.map(({ where }) => where.rel));
  await Promise.all(
    shown.map(({ file, where }) =>
      report(
        config,
        {
          developer,
          session_id: sessionId,
          event_type: 'edit',
          tool: toolOf(input.tool_name),
          file_path: where.rel,
          git_branch: getGitBranch(where.top),
          checkout_id: lib.checkoutId?.(where.top) ?? null,
          task_hint: config.shareHints ? prompt.task_hint || null : null,
          prompt_id: prompt.prompt_id ?? null,
          change_summary: composeSummary(file.summary, null),
          symbols: null,
          agent_type: lib.crewAgentOf?.(input?.agent_type) ?? null,
          timestamp,
        },
        projectDir
      )
    )
  );
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
  rawInput = parsed;
  // Another agent's payload, read as Claude Code's (see normalizeHookInput).
  const input = lib.normalizeHookInput?.(parsed) ?? parsed;
  // Cursor runs this hook too, and reports its edits through its own adapter (see ranByCursor).
  if (lib.ranByCursor?.(input)) return;
  // and Droid, when it imported Claude Code's hooks: its own report it (see ranByDroid)
  if (lib.ranByDroid?.(input, CLIENT)) return;
  // and the Copilot CLI, when it loaded Claude Code's hooks beside its own: those report it (see ranByCopilotCli)
  if (lib.ranByCopilotCli?.(parsed, CLIENT)) return;
  // teammate requests an earlier report heard of, before anything here waits on the network
  sayInboxNews(input);
  const toolInput = input?.tool_input;
  // The files the tool names: a notebook cell's by notebook_path, a Devin
  // edit's by path, Copilot's by filePath, and every file of a patch (see
  // editedFiles). A lib.mjs from before editedFiles knows Claude Code's own.
  const named = lib.editedFiles
    ? lib.editedFiles(input?.tool_name, toolInput)
    : [toolInput?.file_path || toolInput?.notebook_path].filter(Boolean);
  const filePath = named[0];
  const command = COMMAND_TOOLS.has(input?.tool_name);
  if (!filePath && !command) return;

  // When the edit happened and what it was for, taken before anything that
  // can wait on the network (a --global hook looks its room up first): a
  // prompt submitted in the meantime did not cause this edit.
  const timestamp = new Date().toISOString();
  const sessionId = input?.session_id || 'unknown';
  const prompt = promptFor(sessionId, input?.agent_id);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();

  if (command) {
    const config = await resolveConfig(projectDir, { global: GLOBAL, client: CLIENT, background: true });
    if (config.disabled || !config.room) return;
    return reportCommand(input, config, projectDir, sessionId, prompt, timestamp);
  }

  const patched = lib.patchOf?.(input?.tool_name, toolInput);
  if (patched) {
    // a move's other end, as the room knows it, or not at all when it is outside the repository
    const place = (p) => locate(projectDir, p, input?.cwd)?.rel ?? null;
    const files = patched.map((file) => ({ path: file.path, summary: lib.summarizePatchedFile(file, place) }));
    return reportFiles(input, files, projectDir, sessionId, prompt, timestamp);
  }
  if (named.length > 1) {
    const files = named.map((p) => ({ path: p, summary: `one of ${named.length} files one ${input.tool_name} changed` }));
    return reportFiles(input, files, projectDir, sessionId, prompt, timestamp);
  }

  // A file in another repository, a scratchpad or ~/.claude is not this
  // room's. It is dropped before the room is even looked up, so it costs a
  // --global hook no lookup either.
  const where = locate(projectDir, filePath, input?.cwd);
  if (!where) return;

  const config = await resolveConfig(projectDir, { global: GLOBAL, client: CLIENT, background: true });
  if (config.disabled || !config.room) return;
  // A file git ignores (.env, a scratch folder) is never merged: no teammate
  // can collide with what is in it, and it is nobody else's business. A Bash
  // command's changes to one were never reported either (see gitIgnored).
  if ((await lib.gitIgnored?.([where], { sessionId }))?.has(where)) return;
  holdExitGuard(config.reportTimeoutMs);

  const cache = readSessionCache(sessionId);
  const file = where.rel;
  // This file is reported here, so the next look at the working tree, after a
  // Bash command, say, or by another session in this checkout, does not
  // report it again as that command's, or as work from before.
  lib.noteWorktreeEdit?.(where.top, file);
  // A teammate at work in it is this session's business at its next prompt,
  // whatever branch they are on (see noteTouched).
  lib.noteTouched?.(sessionId, [file]);

  // If strict mode was overridden for this file, the reason rides out here, on
  // the existing event stream — so the teammate who was overridden sees it in
  // their own advisory, and the room sees it on the dashboard. No new call, no
  // new field, and this hook is async, so it costs the edit nothing.
  const override = takeOverrideNote(cache, file);
  if (override) writeSessionCache(sessionId, cache);
  // Another agent's edit, read as the Claude Code edit it is (see asClaudeEdit).
  const edit = lib.asClaudeEdit?.(input?.tool_name, toolInput) ?? { tool: input?.tool_name, input: toolInput };
  const summary = composeSummary(summarizeChange(edit.tool, edit.input), override);
  // The changed text, only when this developer allows it and the room said
  // yes to this very edit, before it (see passDiff in lib.mjs). Absent
  // otherwise, and an older vendored lib.mjs cannot send it at all.
  const diff = config.streamDiffs ? (lib.diffForEdit?.(edit.tool, edit.input) ?? null) : null;
  const diffPassed = Boolean(diff && lib.takeDiffPass?.(sessionId, file, diff));

  await report(
    config,
    {
      developer: getDeveloper(config, input?.cwd),
      session_id: sessionId,
      event_type: 'edit',
      tool: toolOf(input?.tool_name || null),
      file_path: file,
      // The branch of the checkout the file is in: another worktree has its
      // own, and where the agent happens to be standing says nothing about it.
      git_branch: getGitBranch(where.top),
      // Which checkout, as an id that names neither the machine nor the
      // folder (see checkoutId): a teammate's agent on a branch of the same
      // name in a clone of its own is told this write is not in its tree.
      checkout_id: lib.checkoutId?.(where.top) ?? null,
      // The prompt this edit was made under, which by now may not be the
      // session's newest. Its id goes with hints off too: it is random, and
      // says only which edits one prompt caused.
      task_hint: config.shareHints ? prompt.task_hint || null : null,
      prompt_id: prompt.prompt_id ?? null,
      change_summary: summary || null,
      // read from the file where it is, not where the agent's path would put
      // it from this process's folder: Devin's are relative to its cwd
      symbols: lib.symbolsForEdit?.(path.join(where.top, file), edit.tool, edit.input) ?? null,
      // Which crew agent made the edit, when a crew agent did: a catalog
      // name and nothing else. Any other agent's name, its id and its prompt
      // stay on this machine.
      agent_type: lib.crewAgentOf?.(input?.agent_type) ?? null,
      diff: diffPassed ? diff : undefined,
      timestamp,
    },
    projectDir
  );
}

main()
  .catch(() => {})
  .finally(finish);
