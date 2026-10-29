#!/usr/bin/env node
// AgentMash PreToolUse hook (Write|Edit|MultiEdit|NotebookEdit, Devin's
// write|edit|apply_patch, and Bash and PowerShell for the files a command
// writes): ask the coordination server whether a teammate's agent recently
// touched this file (each of a patch's or a command's files), and if so inject
// a message shaped to change what this agent does next.
//
// Advisory mode (default): exit 0 with hookSpecificOutput.additionalContext —
// the agent sees the heads-up but the edit proceeds through the normal
// permission flow. Strict mode (AGENTMASH_STRICT=1): permissionDecision
// "deny", plus an acknowledge protocol the agent can complete on its own.
//
// The wording, the severity rule and the acknowledge protocol all live in
// lib.mjs; this file is the plumbing around them.
//
// Anything going wrong — server down, slow, misconfigured — is a silent
// exit 0 within the advisory budget (AGENTMASH_TIMEOUT_MS, default 1500 ms).

import path from 'node:path';
import {
  ACK_TTL_MS,
  ADVISORY_TIMEOUT_MS,
  ackFile,
  armExitGuard,
  buildCollisionAdvice,
  buildStrictBlock,
  emitAndExit,
  finish,
  getDeveloper,
  getGitBranch,
  httpJson,
  resolveConfig,
  parseJson,
  readAcks,
  readSessionCache,
  readStdin,
  resolveAck,
  scratchDir,
  toRepoRelative,
  writeSessionCache,
} from './lib.mjs';
// See the note in post_tool_use.mjs: guarded access for post-v0 helpers.
import * as lib from './lib.mjs';

const GLOBAL = process.argv.includes('--global');
// Which agent runs this hook: null for Claude Code, else the one `--client`
// names, as `npx agentmash login` registers it with Codex or Copilot.
const CLIENT = lib.hookClient?.() ?? null;

// A server that is *unreachable* rather than down — a firewall, a hung
// instance — accepts nothing and refuses nothing, so the AbortSignal fires on
// schedule but the connecting socket keeps the event loop alive and this guard
// is the only thing that ends the process. Sized from the advisory budget
// instead of a flat 4 s, because strict mode deliberately has no cooldown (see
// below) and so every single edit pays this in full.
const EXIT_GUARD_SLACK_MS = 250;
let exitGuard = armExitGuard(ADVISORY_TIMEOUT_MS + EXIT_GUARD_SLACK_MS);

// Don't re-inject the same advisory for the same file for a while; the agent
// already knows, and repeated context is noise.
//
// Strict mode gets no such cooldown, and that is the point: a cooldown there
// would be a ten-minute pass earned by one block, which is the rubber stamp the
// acknowledge protocol exists to prevent. The acknowledgement *is* strict
// mode's cooldown — scoped to one collision, and paid for with a reason.
const ADVISORY_COOLDOWN_MS = 10 * 60_000;

// The cooldown is for the teammates the agent was told about, not for the
// file: a teammate who reaches it since, or a claim made on it, is news the
// agent has not heard. So inside the cooldown the file is still asked about,
// once a minute at most, and only who is new to it is said. The rest of its
// edits there cost what they always did: a node start and no round trip.
const ADVISORY_RECHECK_MS = 60_000;

/**
 * What this session was told about one file, from the session cache:
 * { at, asked, seen } — when the advisory was last given, when the room was
 * last asked about the file, and who it named (see heardKey) — or null when
 * nothing was. Hooks from before `seen` kept only the time, which reads as
 * an advisory that named nobody in particular.
 */
function advisedEntry(cache, rel) {
  const saved = cache.advised?.[rel];
  if (Number.isFinite(saved)) return { at: saved, asked: saved, seen: null };
  if (!saved || typeof saved !== 'object' || !Number.isFinite(saved.at)) return null;
  return {
    at: saved.at,
    asked: Number.isFinite(saved.asked) ? saved.asked : saved.at,
    seen: Array.isArray(saved.seen) ? saved.seen.filter((k) => typeof k === 'string') : null,
  };
}

/**
 * Who a /check answer names, as `seen` keeps them: a teammate by name, a
 * claim by its id, and this developer's own other session (`yours`, see
 * checkFile) apart from both, so hearing of one never quiets the other.
 */
const heardKey = {
  holder: (h) => (h?.yours === true ? `yours:${h?.developer ?? ''}` : String(h?.developer ?? '')),
  claim: (c) => (typeof c?.id === 'string' && c.id ? c.id : `claim:${c?.developer ?? ''}`),
};

/**
 * A /check answer without whoever `told` (see advisedEntry) says the agent
 * already heard about for this file. The whole answer when nothing was told.
 */
function unheard(result, told) {
  if (!result || !told) return result;
  const seen = new Set(told.seen ?? []);
  return {
    ...result,
    holders: (Array.isArray(result.holders) ? result.holders : []).filter((h) => !seen.has(heardKey.holder(h))),
    claims: (Array.isArray(result.claims) ? result.claims : []).filter((c) => !seen.has(heardKey.claim(c))),
  };
}

/**
 * The advisory as the agent gets it: what it quotes of teammates (their names,
 * branches, files and task text) said to be quoted, not instructions to it
 * (withQuotedNote). A lib.mjs from before the note says the advisory alone.
 */
function advisory(context) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: lib.withQuotedNote?.(context) ?? context } };
}

/** Where the file sits in this repository, or null. See the note on locate in post_tool_use.mjs. */
function locate(projectDir, filePath, cwd) {
  if (lib.locateInRepo) return lib.locateInRepo(projectDir, filePath, { cwd });
  const rel = toRepoRelative(projectDir, filePath);
  return rel && !/^(?:[A-Za-z]:|\/|~(?:\/|$)|\.\.(?:\/|$))/.test(rel) ? { rel, top: projectDir } : null;
}

/**
 * Change the session cache as it is on disk now, not as this hook read it.
 * The copy read before /check is up to the advisory budget old by the time
 * the answer comes, and other hooks write the cache meanwhile: the prompt
 * hook, another subagent's PreToolUse. Written back whole, that copy would
 * put their changes back.
 */
function patchCache(sessionId, change) {
  const cache = readSessionCache(sessionId);
  change(cache);
  writeSessionCache(sessionId, cache);
}

/**
 * Strict mode, second half. An acknowledgement buys passage, not silence: the
 * full advisory still goes into the agent's context, and the reason is parked
 * for the reporting hook to publish. Note what is deliberately *not* returned —
 * permissionDecision "allow" — because getting past AgentMash must not also get
 * past the user's own permission rules.
 */
function strictOutcome(advice, sessionId, file, taskHint) {
  // The reason is read against the collision the agent was just shown and
  // against what the agent itself is working on — see resolveAck.
  const verdict = resolveAck(readAcks(sessionId), advice.token, {
    grounding: advice.grounding,
    taskHint,
  });
  const firstUsed = readSessionCache(sessionId).acks?.[advice.token];

  if (verdict.ok && (!firstUsed || Date.now() - firstUsed < ACK_TTL_MS)) {
    patchCache(sessionId, (cache) => {
      cache.acks = { ...(cache.acks || {}), [advice.token]: firstUsed || Date.now() };
      cache.overrides = {
        ...(cache.overrides || {}),
        [file]: { developer: advice.developer, reason: verdict.reason, at: Date.now() },
      };
    });
    return advisory(
      `${advice.text}\n\nYou acknowledged this collision: "${verdict.reason}". Proceeding — ` +
        `that acknowledgement is recorded and rides out with your next reported edit.`
    );
  }

  // An expired acknowledgement is a rejection with a specific cause, so say so
  // rather than letting the agent re-run a command that already worked once.
  const rejected = verdict.ok ? 'expired' : verdict.rejected;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: buildStrictBlock(advice, {
        ackDir: scratchDir(),
        ackPath: ackFile(sessionId),
        rejected,
      }),
    },
  };
}

/** At most this many files of one patch are asked about: each is a request, all at once. */
const MAX_FILES_CHECKED = 8;

/**
 * Claude Code's and the Copilot CLI's shells: they change files without naming
 * them in a field. PowerShell is Claude Code's tool on Windows, and powershell
 * the Copilot CLI's, the same input with its command in `command`, and its
 * words read as its own.
 */
const SHELL_TOOLS = new Map([
  ['Bash', 'bash'],
  ['bash', 'bash'],
  ['PowerShell', 'powershell'],
  ['powershell', 'powershell'],
]);

/**
 * Ask the room about one file: /check's answer, or null when there was none
 * (an error, a timeout). `abs` is the file where it is on disk, for the
 * symbols it is bound to; `edit`, the one edit about to be made to it
 * ({ tool, input }), or null for a patch's several files; `session`, the
 * id this session's edits are reported with, or null for none.
 */
function checkFile(config, developer, file, abs, top, edit = null, source = null, session = null) {
  // What this file is bound to — its imports and its own exports — and, apart,
  // what it imports, by the names the files it imports from give them (see
  // bindingsForFile). The server matches the first against teammates' edits of
  // this file and only the second against their edits of other files, so a
  // signature change in another file still reaches us, and a file that only
  // declares the same name (every Next.js route's GET) does not. Old servers
  // ignore both; a lib.mjs from before bindingsForFile sends symbols alone.
  // Of the file's own exports, only the ones this edit is about to change,
  // when that can be told (symbolsBeforeEdit): bob's agent fixing deleteUser
  // is not changing the createUser alice just changed in the same file.
  // A file this call creates is not on disk to read yet: what it imports is in
  // the text it is about to be given (`source`, see newFileSource).
  const editing = edit ? (lib.symbolsBeforeEdit?.(abs, edit.tool, edit.input) ?? null) : null;
  const bound = lib.bindingsForFile ? lib.bindingsForFile(abs, { editing, source }) : null;
  const symbols = lib.bindingsForFile ? (bound?.symbols ?? null) : (lib.symbolsForFile?.(abs) ?? null);
  const imports = bound?.imports ?? null;
  // And with a lib.mjs that can check its own history (inHistory), this
  // checkout's branch and id, and memory=1: teammates' work on other branches
  // that isn't merged yet comes back as `unmerged`, to be looked for here
  // before it is said. Read by the server, and kept nowhere.
  const memory = typeof lib.buildUnmergedAdvice === 'function' && typeof lib.inHistory === 'function';
  const checkout = memory ? (lib.checkoutId?.(top) ?? null) : null;
  // With AGENTMASH_WARN_SELF, the room leaves out this session's own edits
  // and claims alone, by the id post_tool_use.mjs reports them with, and not
  // everything this developer did: their other sessions (a second terminal,
  // codex beside claude) come back as a teammate's would, marked `yours`. An
  // older server ignores both, and leaves all of them out as it always did.
  // In a session the desktop app started, the app's session too: the MCP
  // server holds the claims of an agent that is not Claude Code under it
  // (see lobbySession in mcp_server.mjs), and they are this session's own.
  const lobby = config.warnSelf && session ? (lib.lobbySessionId?.() ?? null) : null;
  const own =
    (config.warnSelf && session ? `&self=session&session_id=${encodeURIComponent(session)}` : '') +
    (lobby ? `&lobby_session=${encodeURIComponent(lobby)}` : '');
  const url =
    `${config.url}/check?file_path=${encodeURIComponent(file)}` +
    `&developer=${encodeURIComponent(developer)}` +
    (symbols?.length ? `&symbols=${encodeURIComponent(symbols.join(','))}` : '') +
    (imports ? `&imports=${encodeURIComponent(imports.join(','))}` : '') +
    (memory
      ? `&branch=${encodeURIComponent(getGitBranch(top))}` +
        (checkout ? `&checkout_id=${encodeURIComponent(checkout)}` : '') +
        '&memory=1'
      : '') +
    own;
  return httpJson('GET', url, {
    room: config.room,
    token: config.token,
    user: config.user,
    dev: config.dev,
    timeoutMs: config.advisoryTimeoutMs,
  });
}

/**
 * What to tell the agent about one file, from its /check answer and the
 * teammates' unmerged work on it not said yet this session (`unmerged`,
 * checked against `history`): { advice, memoryAdvice, claimAdvice, text } or
 * null. A write in the window, the unmerged work, a claim: one message, in
 * that order. A write from another checkout whose commit `history` says this
 * one has (pulled, merged) is in this tree already, and is not said at all.
 */
function adviseOn(file, top, result, config, unmerged = [], history = null) {
  const branch = getGitBranch(top);
  // which checkout this is, for the advisory to tell it from a teammate's on
  // a branch of the same name (see checkoutId)
  const checkout = lib.checkoutId?.(top) ?? null;
  const holders = (Array.isArray(result?.holders) ? result.holders : []).filter(
    (h) => !lib.pulledHere?.(h, { file, branch, checkout, history })
  );
  // Claims are teammates' stated intent for this file — see buildClaimAdvice.
  // An older server never sends them, and the guarded access keeps an older
  // vendored lib.mjs from throwing on a newer server.
  const claims = Array.isArray(result?.claims) ? result.claims : [];
  if (holders.length === 0 && claims.length === 0 && unmerged.length === 0) return null;

  const advice = holders.length
    ? buildCollisionAdvice({ file, holders, branch, checkout, showHints: config.shareHints })
    : null;
  // What strict mode stops for: a teammate's write, never this developer's
  // own other session (`yours`), which they asked to be warned about, not
  // stopped for, and which has nobody to see an acknowledgement. Beside a
  // teammate's, the block is about the teammate's.
  const theirs = holders.filter((h) => h?.yours !== true);
  const blocks =
    theirs.length === holders.length
      ? advice
      : theirs.length
        ? buildCollisionAdvice({ file, holders: theirs, branch, checkout, showHints: config.shareHints })
        : null;
  const memoryAdvice = unmerged.length
    ? (lib.buildUnmergedAdvice?.({ file, entries: unmerged, branch, history, showHints: config.shareHints }) ?? null)
    : null;
  const claimAdvice = claims.length
    ? (lib.buildClaimAdvice?.({ file, claims, showHints: config.shareHints }) ?? null)
    : null;
  if (!advice && !memoryAdvice && !claimAdvice) return null;

  // A collision, unmerged work and a claim on the same file are one message, not three.
  const text = [advice?.text, memoryAdvice?.text, claimAdvice?.text].filter(Boolean).join('\n\n');
  const seen = [...holders.map(heardKey.holder), ...claims.map(heardKey.claim)];
  return { file, advice, blocks, memoryAdvice, claimAdvice, text, seen };
}

/**
 * The commits the answers name (`commits`, one list per checked file: their
 * unmerged work's, and the ones that have their holders' writes), looked for
 * in each checkout's history (lib.inHistory), inside what is left of this
 * hook's budget: 400 ms at most, and never past the exit guard. A Map of each
 * commit to true, false or null (not looked for in time: the advisory hedges,
 * and a holder is said as it always was). A lib.mjs without inHistory asked
 * for no memory, and has none to check.
 */
async function historyOf(checked, commits, sessionId, guardMs) {
  const history = new Map();
  if (typeof lib.inHistory !== 'function') return history;
  const byTop = new Map();
  checked.forEach((t, i) => {
    for (const sha of commits[i]) byTop.set(t.top, [...(byTop.get(t.top) ?? []), sha]);
  });
  for (const [top, shas] of byTop) {
    const budgetMs = Math.min(400, guardMs - performance.now() - 100);
    if (budgetMs <= 0) break;
    for (const [sha, known] of await lib.inHistory(top, shas, { budgetMs, sessionId })) history.set(sha, known);
  }
  return history;
}

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
  // The files this call is about to change: a notebook cell's by
  // notebook_path, a Devin edit's by path, a patch's every file (see
  // editedFiles). A lib.mjs from before editedFiles knows Claude Code's own.
  const toolInput = input?.tool_input;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
  // A shell command names no file in a field: the ones its text says it writes
  // (see filesACommandWrites), and none for a command that only reads, which
  // then asks the room nothing. A lib.mjs from before it asks about none.
  const shell = SHELL_TOOLS.get(input?.tool_name);
  const named = shell
    ? (lib.filesACommandWrites?.(toolInput?.command, { cwd: input?.cwd || projectDir, projectDir, shell }) ?? [])
    : lib.editedFiles
      ? lib.editedFiles(input?.tool_name, toolInput)
      : [toolInput?.file_path || toolInput?.notebook_path].filter(Boolean);
  if (named.length === 0) return null;

  const sessionId = input?.session_id || 'unknown';
  // the id this session's edits are reported with, when it has one of its own (see checkFile)
  const ownSession = typeof input?.session_id === 'string' && input.session_id ? input.session_id : null;
  // Beside a repository's own install, that install's hooks own the session's
  // files, pins included (see user_prompt_submit.mjs), and resolveConfig turns
  // this one away anyway.
  if (GLOBAL && !CLIENT && lib.hasRepoInstall?.(projectDir)) return null;

  // A subagent reaching for its first file is, as near as this hook can tell,
  // still on the prompt that started it. Pinned now, before anything here
  // waits, its edits are reported with that prompt however many the developer
  // sends in the meantime (see pinAgentPrompt for where that falls short).
  // The main agent pins nothing, and a lib.mjs older than the pin reports
  // every edit with the session's newest prompt, as it always did.
  lib.pinAgentPrompt?.(sessionId, input?.agent_id);

  // Nobody in this room can have touched a file that is not in its repository,
  // so there is nothing to ask, nothing to advise and, in strict mode, nothing
  // to block. Decided before any network call, so none of the budget goes on it.
  const targets = [];
  for (const filePath of named) {
    const where = locate(projectDir, filePath, input?.cwd);
    if (where && !targets.some((t) => t.rel === where.rel)) targets.push(where);
  }
  if (targets.length === 0) return null;

  const config = await resolveConfig(projectDir, { global: GLOBAL, client: CLIENT });
  if (config.disabled || !config.room) return null;

  // A distant server may be given a longer budget; the guard has to outlive it.
  if (config.advisoryTimeoutMs > ADVISORY_TIMEOUT_MS) {
    clearTimeout(exitGuard);
    exitGuard = armExitGuard(config.advisoryTimeoutMs + EXIT_GUARD_SLACK_MS);
  }

  // Read for the cooldown and the room's diff answer. Everything written
  // after /check goes through patchCache, never this copy.
  const cache = readSessionCache(sessionId);

  // Each file, with what this session was told about it while its cooldown
  // holds (strict mode keeps none). Inside the cooldown, a file the room was
  // asked about in the last minute is not asked about again, unless the room
  // streamed when last asked and this developer lets it: only this edit's own
  // answer lets its text go (see passDiff in lib.mjs).
  const now = Date.now();
  const streaming = config.streamDiffs && cache.stream_diffs === true && Boolean(lib.passDiff);
  const asked = [];
  for (const t of targets) {
    const entry = config.strict ? null : advisedEntry(cache, t.rel);
    const told = entry && now - entry.at < ADVISORY_COOLDOWN_MS ? entry : null;
    if (told && now - told.asked < ADVISORY_RECHECK_MS && !streaming) continue;
    asked.push({ ...t, told });
  }
  if (asked.length === 0) return null;

  // A file git ignores is never merged, so no teammate's edit to it can
  // conflict with this one: the room is not asked about it, and nothing is
  // said (see gitIgnored). Asked after the cooldown, so an edit inside it
  // asks git nothing either. git's time is not the room's: the guard gives
  // the room its whole budget from here, short of the host's own deadline.
  if (lib.gitIgnored) {
    const ignored = await lib.gitIgnored(asked, { sessionId });
    for (let i = asked.length - 1; i >= 0; i--) if (ignored.has(asked[i])) asked.splice(i, 1);
    if (asked.length === 0) return null;
    clearTimeout(exitGuard);
    const left = (lib.HOOK_DEADLINE_MS ?? 4500) - performance.now();
    exitGuard = armExitGuard(Math.max(0, Math.min(config.advisoryTimeoutMs + EXIT_GUARD_SLACK_MS, left)));
  }

  const developer = getDeveloper(config, input?.cwd);
  // One file, as a Claude Code edit always is, or a patch's several at once:
  // each its own request, side by side, so a patch waits no longer than an edit.
  const checked = asked.slice(0, MAX_FILES_CHECKED);
  // A Claude Code edit is one file, and what it is about to change in it can
  // be read before it is made; another agent's, read as the edit it is (see
  // asClaudeEdit). A patch's several files are asked about whole.
  const edit = named.length === 1 ? (lib.asClaudeEdit?.(input?.tool_name, toolInput) ?? { tool: input?.tool_name, input: toolInput }) : null;
  const results = await Promise.all(
    checked.map((t) => {
      const abs = path.join(t.top, t.rel);
      const source = lib.newFileSource?.(abs, input?.tool_name, toolInput, { client: CLIENT, cwd: input?.cwd || projectDir, shell }) ?? null;
      return checkFile(config, developer, t.rel, abs, t.top, edit, source, ownSession);
    })
  );
  // The room says whether edits here may carry their text to the live view.
  // The last answer is kept for the session, so that an edit inside a file's
  // cooldown asks again while the room streams. A missing field (older
  // server) means no.
  const result = results.find(Boolean);
  if (result && (result.stream_diffs === true) !== (cache.stream_diffs === true)) {
    patchCache(sessionId, (fresh) => {
      fresh.stream_diffs = result.stream_diffs === true;
    });
  }
  // And the yes this one edit's text goes out on, by what its diff is: an
  // answer of no takes back every yes not used yet, and no answer changes
  // nothing (see passDiff).
  if (result && result.stream_diffs !== true) lib.forgetDiffPasses?.(sessionId);
  else if (result && config.streamDiffs && named.length === 1) {
    const edit = lib.asClaudeEdit?.(input?.tool_name, toolInput) ?? { tool: input?.tool_name, input: toolInput };
    const diff = lib.diffForEdit?.(edit.tool, edit.input);
    if (diff) lib.passDiff?.(sessionId, checked[0].rel, diff);
  }

  // Teammates' work on other branches that isn't merged yet, each said once a
  // session (lib.untold), and none of it that this checkout has already: the
  // commits it names are looked for in HEAD's history first (historyOf).
  // So are the commits that have teammates' writes in the window: one this
  // checkout has (pulled, merged) puts their version in its tree.
  // Inside a file's cooldown, only the teammates and claims not named yet (unheard).
  const pending = checked.map((_, i) => lib.untold?.(cache, results[i]?.unmerged) ?? []);
  const heard = checked.map((t, i) => unheard(results[i], t.told));
  const commits = checked.map((_, i) =>
    [...pending[i], ...(Array.isArray(heard[i]?.holders) ? heard[i].holders : [])]
      .map((x) => x?.commit)
      .filter((sha) => typeof sha === 'string' && sha)
  );
  const history = commits.some((list) => list.length > 0)
    ? await historyOf(checked, commits, sessionId, config.advisoryTimeoutMs + EXIT_GUARD_SLACK_MS)
    : null;

  const advised = checked
    .map((t, i) => adviseOn(t.rel, t.top, heard[i], config, pending[i], history))
    .filter(Boolean);

  // Strict mode blocks on writes that happened; a claim alone is intent, and
  // intent gets the advisory path in every mode, and so does work not merged
  // yet, which this checkout may have in a way its history cannot show (a
  // squash, a cherry-pick). Of a patch's files, the first a teammate wrote to
  // is the one to acknowledge; the next is stopped for on the next try.
  const blocking = config.strict ? advised.find((a) => a.blocks && !a.blocks.memory) : null;
  if (blocking) {
    // What this agent is working on, which a subagent's reason is read against
    // too: the prompt that started it, not whatever the developer asked since.
    const taskHint = (
      lib.promptForEdit?.(sessionId, input?.agent_id) ?? { task_hint: readSessionCache(sessionId).task_hint }
    ).task_hint;
    return strictOutcome(blocking.blocks, sessionId, blocking.file, taskHint);
  }

  // A file advised on starts its cooldown again, naming everyone it has named
  // in it; one asked about again with nobody new keeps its cooldown, and the
  // minute until it is asked again starts now, answer or none.
  const rechecked = checked.filter((t) => t.told);
  if (advised.length || rechecked.length) {
    patchCache(sessionId, (fresh) => {
      const at = Date.now();
      const kept = { ...(fresh.advised || {}) };
      for (const t of checked) {
        const a = advised.find((x) => x.file === t.rel);
        const entry = advisedEntry(fresh, t.rel);
        const holds = entry && at - entry.at < ADVISORY_COOLDOWN_MS ? entry : null;
        if (a) kept[t.rel] = { at, asked: at, seen: [...new Set([...(holds?.seen ?? []), ...a.seen])].sort() };
        else if (t.told && holds) kept[t.rel] = { ...holds, asked: at };
      }
      fresh.advised = kept;
      // said once a session, and the commits it named looked for in the default branch at the next prompt
      for (const a of advised) if (a.memoryAdvice) lib.rememberTold?.(fresh, a.memoryAdvice);
    });
  }
  if (advised.length === 0) return null;
  return advisory(advised.map((a) => a.text).join('\n\n'));
}

main()
  .then((payload) => {
    if (payload) emitAndExit(payload);
    else finish();
  })
  .catch(finish);
