#!/usr/bin/env node
// AgentMash client for Cursor's agent hooks.
//
// Cursor is the one non-Claude-Code tool whose extension point is a near-exact
// analogue of the one AgentMash already uses: `afterFileEdit` hands a spawned
// process the same JSON-on-stdin shape, with `file_path` and an `edits` array of
// {old_string, new_string}. So this adapter is the Claude Code PostToolUse hook
// with a different envelope, and it reports into the same room, with the same
// identity, under the same reliability contract.
//
// Verified against https://cursor.com/docs/hooks — see docs/ADAPTERS.md.
//
// One script handles four events, dispatched on `hook_event_name`:
//   beforeSubmitPrompt → cache the prompt as this conversation's task hint
//   afterFileEdit      → report the edit
//   sessionEnd         → close the session out
//   preToolUse         → the advisory, before an edit (see adviseBeforeEdit)
//
// Two ways in. Committed to a repository, its .cursor/hooks.json runs it as
// docs/ADAPTERS.md shows, with that repository's room. And `npx agentmash
// login` runs it from ~/.cursor/hooks.json for every workspace, with
// --global: then the room is the one the workspace's repository carries, or
// else the one it is connected to on the website, as this machine (see
// configFor); and in a repository that runs this script itself, that copy
// reports and this one only advises. With --detach, a report is handed to a
// copy of this script in the background, so Cursor never waits on it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Installed next to lib.mjs (see docs/ADAPTERS.md); in this checkout lib.mjs
// lives in hooks/. Try both rather than keeping a second copy in sync.
const lib = await import(new URL('./lib.mjs', import.meta.url).href).catch(() =>
  import(new URL('../../hooks/lib.mjs', import.meta.url).href)
);
const {
  armExitGuard,
  finish,
  getDeveloper,
  getGitBranch,
  httpJson,
  loadConfig,
  parseJson,
  readSessionCache,
  readStdin,
  summarizeChange,
  toRepoRelative,
  truncate,
  writeSessionCache,
} = lib;

const GLOBAL = process.argv.includes('--global');
const DETACH = process.argv.includes('--detach');

armExitGuard();

// ── the answer a permission hook owes ───────────────────────────────────────
//
// preToolUse is a permission hook, and Cursor blocks the tool when one prints
// anything but a JSON answer: no output, half a line, a stack trace. A crash
// or a timeout fails open, but an empty exit 0 does not. So once the event is
// known to be one, an answer is always written, exactly once, synchronously
// (stdout is a pipe, and on macOS a pipe write can still be pending when the
// process goes): the advice, or an allow from wherever this hook gives up,
// the exit guard included.

const ALLOW = { permission: 'allow' };
let owesAnswer = false;
let answered = false;

function answer(payload) {
  if (answered) return;
  answered = true;
  try {
    // in ASCII, as the Claude Code hooks answer (asciiJson): nothing for a PowerShell between to re-encode
    const json = JSON.stringify(payload);
    fs.writeSync(1, (lib.asciiJson?.(json) ?? json) + '\n');
  } catch {
    // nowhere to write: Cursor treats a hook it cannot read as failed, which fails open
  }
}

process.on('exit', () => {
  if (owesAnswer) answer(ALLOW);
});

/**
 * The room for this workspace. Committed (no --global): the repository's
 * config. At user level: a repository that carries a room of its own
 * reports there, with its key (a repository install registers no Cursor
 * hooks, so this is the one it has), and any other finds its room as this
 * machine's sign-in does (resolveConfig). `background` for a report nobody
 * waits on: it asks again sooner whether a repository nobody connected is
 * connected yet, as the Claude Code hooks' reports do; the check before an
 * edit goes by the longer answer (ROOM_MISSING_TTL_MS in lib.mjs).
 */
async function configFor(projectDir, { background = false } = {}) {
  if (!GLOBAL || lib.hasRepoInstall?.(projectDir) || !lib.resolveConfig) {
    // with this machine's sign-in beside the key, as the hooks send it (lib.withSignIn)
    return lib.withSignIn?.(loadConfig(projectDir)) ?? loadConfig(projectDir);
  }
  return lib.resolveConfig(projectDir, { global: true, client: 'cursor', background });
}

/** Whether the workspace's repository runs this adapter from its own .cursor/hooks.json. */
function repositoryRunsAdapter(projectDir) {
  try {
    return fs.readFileSync(path.join(projectDir, '.cursor', 'hooks.json'), 'utf8').includes('after_file_edit');
  } catch {
    return false;
  }
}

// ── the advisory, before an edit ────────────────────────────────────────────
//
// Cursor drops a hook's additional_context: what reaches the agent from a
// preToolUse hook is the agent_message of a refusal. So the first time this
// conversation reaches for a file a teammate is in, the edit is refused once,
// with the advisory as the message, and the same edit again is let through:
// once per conversation and file in ADVISED_FOR_MS, the advisory's own
// cooldown. What is kept for that is a few hundred entries in
// ~/.agentmash/cursor-advised.json, each forgotten when it is old.

const ADVISED_FOR_MS = 10 * 60_000;
const ADVISED_MAX = 300;
/** Cursor's tools that only read or run something: never an edit of a file. */
const NOT_EDITS = new Set(['Read', 'Grep', 'Shell', 'Task', 'LS', 'Glob']);

function advisedFile() {
  return path.join(process.env.AGENTMASH_HOME || os.homedir(), '.agentmash', 'cursor-advised.json');
}

/** Whether this key was advised inside the window; records it when it was not. Never throws. */
function adviseOnce(key) {
  const file = advisedFile();
  const now = Date.now();
  let advised = {};
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))?.advised;
    if (saved && typeof saved === 'object') advised = saved;
  } catch {
    // never advised on this machine, or a file caught mid-write: told once more, at worst
  }
  const fresh = Object.entries(advised).filter(([, at]) => Number.isFinite(at) && now - at < ADVISED_FOR_MS && at <= now);
  if (fresh.some(([k]) => k === key)) return false;
  const kept = Object.fromEntries([...fresh.sort((a, b) => b[1] - a[1]).slice(0, ADVISED_MAX - 1), [key, now]]);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ advised: kept }));
    fs.renameSync(tmp, file);
  } catch {
    // unwritable: the retry is refused too, and the one after that is a person's call
  }
  return true;
}

/** The answer to a preToolUse: a refusal carrying the advisory, once, or an allow. */
async function adviseBeforeEdit(input, projectDir) {
  if (NOT_EDITS.has(input.tool_name) || String(input.tool_name || '').startsWith('MCP:')) return ALLOW;
  const named = input.tool_input?.path ?? input.tool_input?.file_path ?? input.tool_input?.target_file;
  if (typeof named !== 'string' || !named || !lib.locateInRepo) return ALLOW;
  const where = lib.locateInRepo(projectDir, named, { cwd: input.cwd });
  if (!where) return ALLOW;
  const config = await configFor(projectDir);
  if (config.disabled || !config.room) return ALLOW;
  const conversation = input.conversation_id || input.session_id || 'unknown';
  // A file git ignores is never merged, so no teammate's edit to it can
  // conflict with this one: the room is not asked, as the Claude Code hooks
  // do not ask it (see gitIgnored in lib.mjs).
  if ((await lib.gitIgnored?.([where], { sessionId: conversation }))?.has(where)) return ALLOW;
  const developer = getDeveloper(config, projectDir);
  // as the Claude Code hook asks (pre_tool_use.mjs, checkFile): another file
  // bears on this one only through what this one imports
  const abs = path.join(where.top, where.rel);
  const bound = lib.bindingsForFile ? lib.bindingsForFile(abs) : null;
  const symbols = lib.bindingsForFile ? (bound?.symbols ?? null) : (lib.symbolsForFile?.(abs) ?? null);
  const imports = bound?.imports ?? null;
  const result = await httpJson(
    'GET',
    `${config.url}/check?file_path=${encodeURIComponent(where.rel)}&developer=${encodeURIComponent(developer)}` +
      (symbols?.length ? `&symbols=${encodeURIComponent(symbols.join(','))}` : '') +
      (imports ? `&imports=${encodeURIComponent(imports.join(','))}` : ''),
    { room: config.room, token: config.token, user: config.user, dev: config.dev, timeoutMs: config.advisoryTimeoutMs }
  );
  const holders = Array.isArray(result?.holders) ? result.holders : [];
  const claims = Array.isArray(result?.claims) ? result.claims : [];
  const advice = holders.length
    ? lib.buildCollisionAdvice?.({
        file: where.rel,
        holders,
        branch: getGitBranch(where.top),
        checkout: lib.checkoutId?.(where.top) ?? null,
        showHints: config.shareHints,
      })
    : (lib.buildClaimAdvice?.({ file: where.rel, claims, showHints: config.shareHints }) ?? null);
  if (!advice?.text) return ALLOW;
  if (!adviseOnce(`${conversation}\u0000${where.top}\u0000${where.rel}`)) return ALLOW;
  // what it quotes of teammates is said to be quoted, as under the Claude Code
  // hook's advisory; a lib.mjs from before the note says the advice alone
  const told =
    `${lib.withQuotedNote?.(advice.text) ?? advice.text}\n\nAgentMash stopped this edit once so that you read the above first. It is advice, not a refusal:` +
    ` if the edit still has to happen, make the same edit again and it goes through.`;
  // The Cursor CLI (2026.10.01) hands the agent user_message, as the tool's
  // error, and never agent_message: a short line for the person there told
  // the agent only that someone was in the file. So both carry the advice.
  return { permission: 'deny', agent_message: told, user_message: told };
}

async function main() {
  const raw = await readStdin();
  const input = parseJson(raw);
  if (!input || typeof input !== 'object') {
    // Unreadable, it may be a preToolUse, and Cursor blocks the tool on
    // anything but a JSON answer: so the answer is an allow. A run with
    // --detach is only ever a report, which answers nothing.
    if (!DETACH) {
      owesAnswer = true;
      answer(ALLOW);
    }
    return;
  }
  const event = input.hook_event_name;

  // Cursor can have several roots open at once. The first is the room's; a file
  // under another root is reported only when that root is the same repository
  // (a folder of it, another worktree of it). Anything else is dropped below.
  const projectDir = input.workspace_roots?.[0] || process.env.CURSOR_PROJECT_DIR || input.cwd || process.cwd();

  if (event === 'preToolUse') {
    owesAnswer = true;
    answer(await adviseBeforeEdit(input, projectDir));
    return;
  }

  // A report Cursor need not wait for: a copy of this script in the background makes it.
  if (DETACH && lib.detach) {
    await lib.detach(raw);
    return;
  }

  // At user level, beside a repository that runs this adapter itself, that one reports.
  if (GLOBAL && repositoryRunsAdapter(projectDir)) return;
  // a prompt, an edit, a session's end: reports Cursor does not wait on (with --detach, made in the background)
  const config = await configFor(projectDir, { background: true });
  if (config.disabled || !config.room) return;

  // `conversation_id` is Cursor's stable per-thread id — the same role Claude
  // Code's session_id plays, so it becomes one row on the dashboard. It is
  // documented as a base field on every hook payload, but `sessionEnd` is
  // documented with a `session_id` of its own: if that is what a given Cursor
  // build sends, falling back keeps the end on the session it belongs to
  // instead of ending a phantom `unknown` one and leaving the real one active.
  const sessionId = input.conversation_id || input.session_id || 'unknown';
  const cache = readSessionCache(sessionId);

  // The payload carries `user_email` (the Cursor account), but identity has to
  // match whatever the same person's Claude Code hooks and git commits send, or
  // one teammate shows up as two. getDeveloper is that common value: the login
  // this machine is signed in as, else git config user.email.
  const developer = getDeveloper(config, projectDir);

  const body = {
    developer,
    session_id: sessionId,
    git_branch: getGitBranch(projectDir),
    timestamp: new Date().toISOString(),
  };
  // The credentials the hooks send: the room's key, and the developer token
  // this machine holds for the room, which a room that requires them will not
  // take an event without.
  const post = (extra) =>
    httpJson('POST', `${config.url}/events`, {
      room: config.room,
      token: config.token,
      user: config.user,
      dev: config.dev,
      timeoutMs: config.reportTimeoutMs,
      body: { ...body, ...extra },
    });
  // AGENTMASH_HINTS=0 (or share_hints false) keeps this developer's prompts on
  // this machine, as it does in the Claude Code hooks: every event still goes
  // out, so they are seen working, only without what they asked for. The
  // prompt is still kept here, where it never leaves the machine.
  const hintOf = (hint) => (config.shareHints ? hint || null : null);

  if (event === 'beforeSubmitPrompt') {
    // What the person typed, as the Claude Code prompt hook reads it: the
    // wrappers a harness puts around a turn taken out (userPromptText), a
    // secret pasted into it masked (redactSecrets), then its first
    // PROMPT_CHARS, the 500 every hook sends. A lib.mjs from before those
    // reads the prompt as it came, cut to the 200 this adapter sent then.
    const typed = lib.userPromptText?.({ prompt: input.prompt }) ?? (typeof input.prompt === 'string' ? input.prompt : '');
    const hint = truncate(lib.redactSecrets?.(typed) ?? typed, lib.PROMPT_CHARS ?? 200);
    if (!hint) return;
    cache.task_hint = hint;
    writeSessionCache(sessionId, cache);
    await post({ event_type: 'prompt', tool: 'beforeSubmitPrompt', task_hint: hintOf(hint) });
    return;
  }

  if (event === 'sessionEnd') {
    await post({ event_type: 'session_end', tool: 'sessionEnd', task_hint: hintOf(cache.task_hint) });
    return;
  }

  if (event !== 'afterFileEdit' || !input.file_path) return;

  // Only a file in the room's repository belongs in its room; a path from
  // another repository would mean nothing there and name this machine's
  // folders to the team. A lib.mjs installed beside this adapter before
  // locateInRepo existed answers such a file with its absolute path, which is
  // refused here the same way.
  let where = null;
  if (lib.locateInRepo) where = lib.locateInRepo(projectDir, input.file_path);
  else {
    const rel = toRepoRelative(projectDir, input.file_path);
    if (rel && !/^(?:[A-Za-z]:|\/|~(?:\/|$)|\.\.(?:\/|$))/.test(rel)) where = { rel, top: projectDir };
  }
  if (!where) return;
  // A file git ignores (.env, a scratch folder) is never merged: no teammate
  // can collide with what is in it, and it is nobody else's business.
  if ((await lib.gitIgnored?.([where], { sessionId }))?.has(where)) return;

  await post({
    event_type: 'edit',
    tool: 'afterFileEdit',
    file_path: where.rel,
    git_branch: getGitBranch(where.top),
    // which checkout, by an id that names neither machine nor folder (lib.mjs, checkoutId)
    checkout_id: lib.checkoutId?.(where.top) ?? null,
    task_hint: hintOf(cache.task_hint),
    // Cursor's `edits` is shaped exactly like Claude Code's MultiEdit input, so
    // the same summarizer produces the same "+12/-3 lines, touching X".
    change_summary: summarizeChange('MultiEdit', { edits: input.edits || [] }),
  });
}

main()
  .catch(() => {})
  .finally(finish);
