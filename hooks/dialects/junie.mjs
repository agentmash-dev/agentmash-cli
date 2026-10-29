// Junie's hooks, as its CLI runs them from ~/.junie/config.json (see
// cli/agents/junie.mjs): Claude Code's shape, read with three differences, and
// answered in Junie's own words.
//
// Read:
//
//   - `cwd` is Junie's own home (~/.junie), never the project, and the hook
//     runs from there too, so neither ever stands for where the agent works.
//     `project_path` does. SessionStart and UserPromptSubmit send it;
//     PreToolUse may not (it sent no session and no project before 26.9.22,
//     and may still leave the project out), so the project each session works
//     in is kept as those two say it, in ~/.agentmash/junie.json. A call that
//     names no project, from a session not known here, goes by the checkout an
//     absolute path is in; a relative path with none of these is asked about
//     nowhere.
//   - an edit's fields are not documented. Its path is read from file_path or
//     path, the text it replaces from old_string and new_string or search and
//     replace, and a patch in its input names its files.
//   - there is no hook after a tool runs. So each edit asked about before it
//     runs is written down with what its file was then, and reported once the
//     file is seen to have changed: at the agent's next edit, or as its task
//     ends (Stop). A file that did not change was refused, or the edit failed,
//     and nothing is reported. What a cancelled task changed, which no Stop
//     sees, is left to the next prompt: its look at the working tree reports
//     it (user_prompt_submit.mjs), under no prompt, which is the truth of it.
//
// Answered:
//
//   pre_edit, advice       {"additionalContext":"<advice>"}: Junie adds it to the
//                          model's context for that step, and runs the edit
//   pre_edit, strict mode  {"decision":"block","reason":"<why>","hookSpecificOutput":
//                          {"hookEventName":"PreToolUse","permissionDecision":"deny",…}}:
//                          the shape seen refusing an edit on Junie 26.9.22
//   prompt, a heads-up     {"additionalContext":"<heads-up>"}, which Junie puts
//                          in front of the prompt
//   anything else          nothing at all, which Junie reads as "go on"
//
// Never "allow", "ask" or updatedInput: whether Junie's "allow" also skips its
// own permission dialog is not documented, "ask" stops for the person, and
// updatedInput changes what the tool does. Nothing is ever said at
// SessionStart (Junie ignores it, and session_start.mjs would count it as the
// session's heads-up, which the first prompt would then not give) or at Stop
// (anything said there sends the agent round once more).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseClaudeShaped } from './claude.mjs';

/** The hooks folder: this file's parent's, where post_tool_use.mjs is too. */
const HOOKS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Sessions kept, at most, and for how long after they last said where they work: one can be resumed days later. */
const SESSIONS_KEPT = 200;
const SESSION_FOR_MS = 30 * 24 * 60 * 60_000;
/** How often a session already known is written down again, at most: every prompt would otherwise be a write. */
const SESSION_REFRESH_MS = 60 * 60_000;
/** Edits waiting to be seen to land, at most, and for how long. */
const WAITING_KEPT = 50;
export const WAITING_FOR_MS = 10 * 60_000;
/**
 * How long an edit whose file has not changed is still waited for once its
 * session has moved on to another edit: Junie may run calls side by side, and
 * one asked about a moment ago may not have run yet.
 */
export const BESIDE_MS = 2000;
/** Files hashed whole up to this size; past it, a change of size or time says it changed. */
const HASHED_UP_TO = 8 * 1024 * 1024;
/** The text an edit replaces, and its replacement, kept to say its size, each at most this; past it, the file alone. */
const TEXT_KEPT = 64 * 1024;
/** A file written whole is read back to say what it defines, at most this much of it. */
const READ_BACK = 1024 * 1024;
/** Files written down from one call, at most: as many as the generic hook acts on. */
const FILES_PER_CALL = 8;
/** Paths read from one patch, at most. */
const PATCH_FILES = 100;

const NOTHING = { stdout: '' };
const ABSENT = 'absent';

const stateFile = () => path.join(process.env.AGENTMASH_HOME || os.homedir(), '.agentmash', 'junie.json');

const text = (value, max) => (typeof value === 'string' && value && value.length <= max ? value : null);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** What a file is now, to tell later whether it changed: its hash, its size and time when large, or absent. Never throws. */
export function fingerprint(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return ABSENT;
    if (stat.size > HASHED_UP_TO) return `size:${stat.size}:${stat.mtimeMs}`;
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return ABSENT;
  }
}

/** One edit written down, as it must be to be acted on; anything else in the file is dropped. */
const usableWaiting = (w) =>
  isObject(w) &&
  typeof w.session === 'string' &&
  typeof w.root === 'string' &&
  path.isAbsolute(w.root) &&
  typeof w.file === 'string' &&
  path.isAbsolute(w.file) &&
  typeof w.print === 'string' &&
  Number.isFinite(w.at) &&
  (w.kind === 'edit' || w.kind === 'write');

/**
 * What is kept: { sessions: { <id>: { root, at } }, waiting: [ … ] }, with
 * what is past its time, or dated after now (a clock that went back), left
 * out. Never throws: a file that cannot be read is nothing kept.
 */
export function readState(now = Date.now()) {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    // nothing kept yet, or a file caught mid-write: nothing kept
  }
  const sessions = Object.fromEntries(
    Object.entries(isObject(saved?.sessions) ? saved.sessions : {})
      .filter(([id, s]) => text(id, 200) && isObject(s) && typeof s.root === 'string' && path.isAbsolute(s.root) && Number.isFinite(s.at) && s.at <= now && now - s.at < SESSION_FOR_MS)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, SESSIONS_KEPT)
  );
  const waiting = (Array.isArray(saved?.waiting) ? saved.waiting : [])
    .filter((w) => usableWaiting(w) && w.at <= now && now - w.at < WAITING_FOR_MS)
    .slice(-WAITING_KEPT);
  return { sessions, waiting };
}

/** How long a hook waits for another to be done with junie.json, and how old a lock is before it is a dead hook's. */
const LOCK_WAIT_MS = 500;
const LOCK_STALE_MS = 10_000;

/**
 * Hold junie.json for one read, change and write (a folder beside it, which
 * only one process can make): two hooks at once, as Junie runs calls side by
 * side, would otherwise both report one landed edit, and the second write
 * would lose what the first waits for. A lock older than LOCK_STALE_MS is a
 * hook that died holding it, and is taken. The release, or null when the lock
 * could not be had in LOCK_WAIT_MS: then nothing is written, and the edits
 * left unreported are the next prompt's look's (user_prompt_submit.mjs).
 * Never throws.
 */
function lockState() {
  const lock = `${stateFile()}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
  } catch {
    return null;
  }
  for (;;) {
    try {
      fs.mkdirSync(lock);
      return () => {
        try {
          fs.rmdirSync(lock);
        } catch {
          // taken as stale since: another's now
        }
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') return null;
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
        fs.rmdirSync(lock);
        continue;
      }
    } catch {
      continue; // let go of a moment ago
    }
    if (Date.now() >= deadline) return null;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

/** Write what is kept, whole and private: true only once it is on disk. Never throws. */
function writeKept(state) {
  const file = stateFile();
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ sessions: state.sessions, waiting: state.waiting.slice(-WAITING_KEPT) }), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing was made
    }
    return false;
  }
}

/** Note where a session works; whether that changed what is kept. */
function remember(state, session, root, now) {
  if (!session || !root) return false;
  const was = state.sessions[session];
  if (was?.root === root && now - was.at < SESSION_REFRESH_MS) return false;
  state.sessions[session] = { root, at: now };
  const newest = Object.entries(state.sessions).sort((a, b) => b[1].at - a[1].at).slice(0, SESSIONS_KEPT);
  state.sessions = Object.fromEntries(newest);
  return true;
}

// ── an edit's call, as Junie sends it ───────────────────────────────────────

/** The patch an edit's input carries in place of a path, or ''. */
function patchText(input) {
  for (const key of ['patch', 'diff', 'input', 'command']) {
    if (typeof input[key] === 'string' && input[key]) return input[key];
  }
  return '';
}

/**
 * The files a unified diff changes, as it names them (`--- a/x`, `+++ b/x`):
 * the new path, or the old one for a file it deletes; the a/ and b/ git puts
 * in front only when both sides have them.
 */
export function filesInDiff(diff) {
  const files = [];
  const lines = diff.split(/\r?\n/);
  for (let i = 1; i < lines.length && files.length < PATCH_FILES; i++) {
    const plus = /^\+\+\+ (.+?)(?:\t.*)?$/.exec(lines[i])?.[1];
    const minus = /^--- (.+?)(?:\t.*)?$/.exec(lines[i - 1])?.[1];
    if (!plus || !minus) continue;
    const git = (minus === '/dev/null' || minus.startsWith('a/')) && (plus === '/dev/null' || plus.startsWith('b/'));
    const named = plus === '/dev/null' ? minus : plus;
    if (named === '/dev/null') continue;
    const file = git ? named.replace(/^[ab]\//, '') : named;
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

/**
 * An edit or a write as Junie sends it, read: { input, files, patch?, diff? },
 * the input with the text it replaces under Claude Code's names, the files it
 * names (as named: absolute, or relative to the project), and the patch, or
 * that a diff named them, when that is how they are named.
 */
export function junieCall(tool, toolInput, client, lib) {
  const input = isObject(toolInput) ? { ...toolInput } : {};
  const kind = lib?.clientToolKind?.(client, tool) ?? null;
  if (kind === 'read' || kind === 'command') return { input, files: [] };
  if (input.old_string === undefined && typeof input.search === 'string') input.old_string = input.search;
  if (input.new_string === undefined && typeof input.replace === 'string') input.new_string = input.replace;
  const named = lib?.editedFiles?.(tool, input, client) ?? [];
  if (named.length) return { input, files: named };
  const patch = patchText(input);
  if (!patch) return { input, files: [] };
  if (patch.includes('*** Begin Patch')) return { input, files: (lib?.filesInPatch?.(patch) ?? []).map((f) => f.path), patch };
  return { input, files: filesInDiff(patch), diff: true };
}

// ── edits, reported once they land ──────────────────────────────────────────

/**
 * Take out of `state` every edit that has landed, and every one that never
 * will: an edit of `session` (of any session, when it is null: a Stop names
 * none) whose file has not changed though the session has moved on, by
 * `beside` ms, was refused or failed. Another session's is still waited for,
 * until its time is up. Returns the landed ones.
 */
export function settle(state, session, now, beside) {
  const landed = [];
  state.waiting = state.waiting.filter((w) => {
    const print = fingerprint(w.file);
    if (print !== w.print) {
      // a file gone since was not made by an edit or a write
      if (print !== ABSENT) landed.push(w);
      return false;
    }
    return !((session === null || w.session === session) && now - w.at >= beside);
  });
  return landed;
}

/**
 * The edits one call makes, written down with what each file is now, in
 * place of any of the session's earlier ones of the same file. Only files in
 * the project's repository: no other is ever reported, so none is kept.
 * Whether any was.
 */
function wait(state, { session, root, tool, kind, call, now, lib }) {
  const files = [...new Set(call.files.map((f) => path.resolve(root, f)))]
    .slice(0, FILES_PER_CALL)
    .filter((file) => !lib?.locateInRepo || lib.locateInRepo(root, file));
  const one = files.length === 1 && call.files.length === 1;
  for (const file of files) {
    const entry = { session, root, file, print: fingerprint(file), tool: text(tool, 60) ?? 'Edit', kind, at: now };
    if (one && kind === 'edit' && !call.patch && !call.diff) {
      const before = typeof call.input.old_string === 'string' && call.input.old_string.length <= TEXT_KEPT ? call.input.old_string : null;
      const after = typeof call.input.new_string === 'string' && call.input.new_string.length <= TEXT_KEPT ? call.input.new_string : null;
      if (before !== null && after !== null) Object.assign(entry, { before, after });
    }
    state.waiting = [...state.waiting.filter((w) => !(w.session === session && w.file === file)), entry];
  }
  return files.length > 0;
}

/** A file written whole, as it is now, or null when it is too large or cannot be read. */
function readBack(file) {
  try {
    if (fs.statSync(file).size > READ_BACK) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** A landed edit as the Claude Code tool call post_tool_use reads: a Write with what it wrote, or an Edit, with its text when kept. */
function landedCall(w) {
  if (w.kind === 'write') {
    const content = readBack(w.file);
    if (content !== null) return { tool_name: 'Write', tool_input: { file_path: w.file, content } };
  }
  const input = { file_path: w.file };
  if (typeof w.before === 'string' && typeof w.after === 'string') Object.assign(input, { old_string: w.before, new_string: w.after });
  return { tool_name: 'Edit', tool_input: input };
}

/**
 * Report each landed edit, as post_tool_use.mjs would have right after it, in
 * the background, one each. The file is noted as reported first (lib.mjs,
 * noteWorktreeEdit), so a look at the working tree, this session's or
 * another's, does not report it again as a command's. A file outside the
 * project's repository is never named to anyone. Never throws.
 */
function reportLanded(landed, client, lib) {
  const global = process.argv.includes('--global');
  for (const w of landed) {
    try {
      const where = lib?.locateInRepo?.(w.root, w.file);
      if (!where) continue;
      lib.noteWorktreeEdit?.(where.top, where.rel);
      const call = landedCall(w);
      const input = { session_id: w.session, cwd: w.root, hook_event_name: 'PostToolUse', ...call };
      const child = spawn(process.execPath, [path.join(HOOKS_DIR, 'post_tool_use.mjs'), '--client', client, ...(global ? ['--global'] : [])], {
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
      child.on('error', () => {});
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
      child.unref();
    } catch {
      // this one goes unreported, and the next prompt's look reports its file
    }
  }
}

// ── read and answered ───────────────────────────────────────────────────────

/** Junie's hook input as normalized input (see agent_hook.mjs), or null for one that has nothing to ask or report. */
function parse(event, input, context = {}) {
  const raw = context.lib?.normalizeHookInput?.(input) ?? input;
  if (!isObject(raw)) return null;
  const release = lockState();
  try {
    return parseHeld(event, raw, context, release !== null);
  } finally {
    release?.();
  }
}

/** parse, with junie.json held (`held`), or read only, when another hook would not let go of it. */
function parseHeld(event, raw, { client = 'junie', lib = null } = {}, held) {
  const writeState = (state) => held && writeKept(state);
  const session = text(raw.session_id, 200);
  const named = typeof raw.project_path === 'string' && path.isAbsolute(raw.project_path) ? raw.project_path : null;
  const now = Date.now();
  const state = readState(now);
  let changed = remember(state, session, named, now);
  const projectOf = () => named ?? (session ? state.sessions[session]?.root : null) ?? null;
  const inProject = (n) => {
    const root = projectOf();
    return n && root ? { ...n, session_id: session ?? undefined, cwd: root } : null;
  };

  if (event === 'session_start') {
    // a session begun again or resumed: what it was waiting for was the turn before's
    const before = state.waiting.length;
    state.waiting = state.waiting.filter((w) => w.session !== session);
    if (changed || state.waiting.length !== before) writeState(state);
    return null;
  }
  if (event === 'stop') {
    // Junie's Stop names no session: its task is over, and every other session's call has had a moment to run
    const before = state.waiting.length;
    const landed = settle(state, session, now, session ? 0 : BESIDE_MS);
    if ((changed || state.waiting.length !== before) && writeState(state)) reportLanded(landed, client, lib);
    return null;
  }
  if (event === 'prompt') {
    // the turn before is over: what it changed that no Stop saw is the prompt hook's look's to report
    const before = state.waiting.length;
    state.waiting = state.waiting.filter((w) => w.session !== (session ?? 'unknown'));
    if (changed || state.waiting.length !== before) writeState(state);
    return inProject(parseClaudeShaped(event, raw, { client, lib }));
  }
  if (event !== 'pre_edit') return inProject(parseClaudeShaped(event, raw, { client, lib }));

  const tool = text(raw.tool_name, 200);
  const call = tool ? junieCall(tool, raw.tool_input, client, lib) : { input: {}, files: [] };
  // no project said, and no session known: the checkout of a file named in full
  let root = projectOf();
  if (!root) {
    const full = call.files.find((f) => typeof f === 'string' && path.isAbsolute(f));
    root = full ? (lib?.gitCheckout?.(path.dirname(full))?.top ?? null) : null;
  }
  const before = state.waiting.length;
  const landed = settle(state, session ?? 'unknown', now, BESIDE_MS);
  if (state.waiting.length !== before) changed = true;
  if (root && call.files.length) {
    const kind = lib?.clientToolKind?.(client, tool) === 'write' ? 'write' : 'edit';
    if (wait(state, { session: session ?? 'unknown', root, tool, kind, call, now, lib })) changed = true;
  }
  if (changed && writeState(state)) reportLanded(landed, client, lib);
  if (!root || !call.files.length) return null;

  const n = { session_id: session ?? undefined, cwd: root, tool };
  if (call.patch) return { ...n, patch: call.patch };
  if (call.diff || call.files.length > 1) return { ...n, files: call.files };
  return { ...parseClaudeShaped(event, { ...raw, tool_input: call.input }, { client, lib }), ...n };
}

const said = (words) => ({ stdout: JSON.stringify({ additionalContext: words }) + '\n' });

export default {
  name: 'junie',
  // Junie's tools as its hooks name them (junie-cli-hooks.html: "Bash, Write,
  // Read, Edit, Glob, Grep"; `open_entire_file` keeps a name of its own). Only
  // Edit and Write reach the hook, by its matcher; the rest are named so that
  // nothing that only reads is ever taken for an edit.
  tools: {
    edit: ['Edit'],
    write: ['Write'],
    read: ['Read', 'Glob', 'Grep', 'open', 'open_entire_file'],
    command: ['Bash'],
  },
  parse,
  answer(event, result) {
    const words = typeof result?.text === 'string' && result.text ? result.text : null;
    if (!words) return NOTHING;
    if (event === 'pre_edit') {
      if (result.action === 'deny') {
        return {
          stdout:
            JSON.stringify({
              decision: 'block',
              reason: words,
              hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: words },
            }) + '\n',
        };
      }
      return result.action === 'advise' ? said(words) : NOTHING;
    }
    // a prompt is never refused: whatever it is told is context
    if (event === 'prompt') return said(words);
    return NOTHING;
  },
  neutral() {
    return NOTHING;
  },
};
