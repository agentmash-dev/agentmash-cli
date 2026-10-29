// Crush's hooks (charmbracelet/crush), read and answered: what login registers
// in ~/.config/crush/crush.json (cli/agents/crush.mjs), the generic hook with
// --client crush before each of Crush's file edits. Checked against its source
// at v0.63.0, where hooks began, and v0.97.1: internal/hooks/{hooks,input,
// runner}.go and internal/agent/hooked_tool.go, which is the same file in both.
//
// What Crush sends: one event only, PreToolUse, and one line of JSON on stdin,
//
//   {"event":"PreToolUse","session_id":"…","cwd":"/abs/project",
//    "tool_name":"edit","tool_input":{…the model's own arguments…}}
//
// with no hook_event_name, transcript or permission mode. Its file tools take
// Claude Code's field names: edit {file_path, old_string, new_string,
// replace_all?}, multiedit {file_path, edits[]}, write {file_path, content};
// lsp_replace_symbol {symbol, file_path, replacement?, action?} and download
// {url, file_path} change one file in a way the call does not spell out.
// file_path is the model's, absolute or relative to cwd.
//
// What Crush reads back, from a hook that exits 0: nothing, or JSON with no
// decision, is no opinion, and Crush asks the person whatever it would have
// asked. {"decision":"deny","reason":"…"} refuses the call before it runs: the
// model gets "Tool call blocked by hook. Reason: …" as the tool's result, and
// its turn goes on. {"context":"…"} is added for the model, but to the tool's
// result, after the tool has run. And {"decision":"allow"} is not "go on": it
// approves the call and skips the person's permission prompt, so it is never
// said here, to any event, and neither is updated_input (it rewrites the
// call), halt (it ends the person's turn), or exit 2 or 49.
//
// So the warning before an edit goes as a refusal of the first try at a file
// a teammate's agent is in, with the advice as the reason, and the same edit
// tried again goes through (deny-once.mjs keeps the refusals, once per session
// and file in ten minutes, and refuses only once one is written down); the
// room's strict mode refuses every try until the agent acknowledges the
// collision, as everywhere. Advice that was not given as a refusal (the
// refusal could not be written down) goes as context, which the model reads
// with the edit's result. Everything else, and every failure, is nothing.
//
// Crush has no hook after a tool runs, and none for a prompt or a session, so
// an edit is reported once it has happened, seen from here: a call that was
// not refused hands its payload to a watcher in the background (this file,
// run as `node crush.mjs --agentmash-watch`), which takes a fingerprint of the
// call's file before Crush runs the tool and reports the edit, as the generic
// hook's post_edit, once that file changes. An edit that fails, or that the
// person turns down at Crush's prompt, changes nothing, and is never reported:
// not for a change that comes after it either. Each call is written down as
// the newest for its session and file (~/.agentmash/crush-watch, a file per
// hash of them), with the file's fingerprint as the call found it, and a
// watcher whose file had not changed by the time a newer call was asked
// about leaves the change to that call's watcher; and an edit, multiedit or
// write is reported only while its own new text is in the file, so a change
// the person makes in their editor after turning the call down is not the
// call's. A watcher that sees no change in WATCH_MS gives up. The watcher is
// detached from the hook, with nothing of Crush's on its stdout or stderr, so
// Crush never waits for it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseClaudeShaped } from './claude.mjs';
import denyOnce from './deny-once.mjs';

const NOTHING = { stdout: '' };
/** The tools whose call names the one file it changes but not what it writes there: reported by file alone. */
const FILE_ONLY = new Set(['lsp_replace_symbol', 'download']);
/** The tools a fingerprint is taken for: every one that names its file. */
const WATCHED = new Set(['edit', 'multiedit', 'write', ...FILE_ONLY]);

/** How long a watcher waits for its file to change, unless AGENTMASH_CRUSH_WATCH_MS says (a person can take a while at Crush's prompt). */
export const WATCH_MS = 5 * 60_000;
const MIN_WATCH_MS = 100;
const MAX_WATCH_MS = 30 * 60_000;
/** Files watched for one call, at most: Crush's file tools change one each. */
const MAX_WATCHED = 8;
/** A file past this is fingerprinted by its size and time, not its text: a hook reads it before every edit. */
const MAX_HASHED_BYTES = 2 * 1024 * 1024;
/** The flag that makes this file the watcher, when it is run rather than imported. */
const WATCH_FLAG = '--agentmash-watch';
const NAME = /^[a-z][a-z0-9-]{0,20}$/;

const SELF = fileURLToPath(import.meta.url);
/** The generic hook beside the dialects, which the watcher hands an edit's report to. */
const AGENT_HOOK = path.join(path.dirname(path.dirname(SELF)), 'agent_hook.mjs');

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// ── what Crush sent ─────────────────────────────────────────────────────────

/**
 * The payload of the call being asked about, kept from parse for answer in
 * the same run of the generic hook: what the watcher reports once the edit
 * has happened.
 */
let asked = null;

/** Whether a payload says it is PreToolUse, Crush's one event, in any of the spellings Crush accepts. */
const isPreToolUse = (event) => typeof event !== 'string' || event.replace(/_/g, '').toLowerCase() === 'pretooluse';

/** Crush's payload as normalized input (see agent_hook.mjs), by way of Claude Code's shape, which its file tools share. */
function parse(event, input, context) {
  if (!isObject(input) || !isPreToolUse(input.event)) return null;
  if (event !== 'pre_edit' && event !== 'post_edit') return parseClaudeShaped(event, input, context);
  const tool = input.tool_name;
  const args = isObject(input.tool_input) ? input.tool_input : {};
  if (event === 'pre_edit') asked = WATCHED.has(tool) ? input : null;
  if (FILE_ONLY.has(tool)) {
    // a whole symbol replaced, or a download written: the file, and no lines to count
    const file = typeof args.file_path === 'string' && args.file_path ? args.file_path : null;
    return { session_id: input.session_id, cwd: input.cwd, tool, files: file ? [{ path: file }] : [] };
  }
  return parseClaudeShaped(event, input, context);
}

// ── the watcher ─────────────────────────────────────────────────────────────

/** A file's size and time, or null when it is not there: a cheap look between fingerprints. */
function statOf(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${st.mtimeMs}:${st.isFile() ? 'f' : 'o'}`;
  } catch {
    return null;
  }
}

/** A file's fingerprint: its text's hash, its size and time when it is big, null when it is not there. */
function fingerprintOf(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return `other:${st.mtimeMs}`;
    if (st.size > MAX_HASHED_BYTES) return `size:${st.size}:${st.mtimeMs}`;
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** Where each session and file's newest call is written down: a small file each, named by a hash of them. */
const marksDir = () => path.join(process.env.AGENTMASH_HOME || os.homedir(), '.agentmash', 'crush-watch');
/** A mark's name: which agent, session and file, as a hash, so the folder names none of them. */
const markOf = (client, session, file) => crypto.createHash('sha256').update(`${client}\0${session}\0${file}`).digest('hex').slice(0, 32);

/**
 * Write the job down as the newest call for each of its files, with the
 * fingerprint it found there, each mark whole (a temporary file, then a
 * rename): true only once every one is on disk. Never throws.
 */
function markNewest(job) {
  try {
    const dir = marksDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const file of job.files) {
      const target = path.join(dir, file.mark);
      const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify({ id: job.id, at: job.at, fingerprint: file.fingerprint }), { mode: 0o600 });
        fs.renameSync(tmp, target);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a newer call to one of the job's files was asked about while the
 * file was still as this job found it: the change since is that call's, or a
 * later one's, to report, never this one's (it failed, or was turned down).
 * When the file had changed by then, the change was this call's, and it is
 * reported however late it is seen. With no marks (a home that could not be
 * written), nothing is known to be newer.
 */
function superseded(job) {
  if (job.marked !== true) return false;
  return job.files.some((file) => {
    try {
      const mark = JSON.parse(fs.readFileSync(path.join(marksDir(), file.mark), 'utf8'));
      return isObject(mark) && mark.id !== job.id && Number.isFinite(mark.at) && mark.at >= job.at && mark.fingerprint === file.fingerprint;
    } catch {
      return false;
    }
  });
}

/**
 * Whether the call's own new text is in its file: an edit's new_string, the
 * last of a multiedit's (the one no later edit of the call rewrites), a
 * write's content. A change without it is not the call's edit, but the
 * person's own, made after they turned the call down. A call whose new text
 * is nothing (an edit that deletes), or that does not say it (a symbol
 * replaced, a download), or a file too big to read, is taken at its change.
 */
function landed(job) {
  const tool = job.payload?.tool_name;
  const args = isObject(job.payload?.tool_input) ? job.payload.tool_input : {};
  const edits = Array.isArray(args.edits) ? args.edits : [];
  const text = tool === 'edit' ? args.new_string : tool === 'multiedit' ? edits[edits.length - 1]?.new_string : tool === 'write' ? args.content : null;
  if (typeof text !== 'string' || !text || job.files.length !== 1) return true;
  try {
    const st = fs.statSync(job.files[0].path);
    if (!st.isFile() || st.size > MAX_HASHED_BYTES) return true;
    // line endings as either side wrote them
    return fs.readFileSync(job.files[0].path, 'utf8').replace(/\r/g, '').includes(text.replace(/\r/g, ''));
  } catch {
    return false; // gone: whatever changed it, it holds no edit of this call's
  }
}

/** Marks older than any watcher can be, gone: from a watcher, once it is done. Never throws. */
function sweepMarks() {
  try {
    const dir = marksDir();
    const old = Date.now() - MAX_WATCH_MS - 60_000;
    for (const name of fs.readdirSync(dir)) {
      try {
        if (fs.statSync(path.join(dir, name)).mtimeMs < old) fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        // gone already, or not ours to take
      }
    }
  } catch {
    // no marks
  }
}

/** How long a watcher waits, from the environment it runs in. */
function watchMs() {
  const set = Number(process.env.AGENTMASH_CRUSH_WATCH_MS);
  return Number.isFinite(set) && set > 0 ? Math.min(Math.max(set, MIN_WATCH_MS), MAX_WATCH_MS) : WATCH_MS;
}

/**
 * Hand the call being asked about to a watcher in the background, with each
 * of its files' fingerprints as they are now, before Crush runs the tool.
 * Only from the generic hook's pre_edit, and only for a call that names a
 * file. Never throws, and never waits.
 */
function watchFor(result) {
  try {
    const payload = asked;
    asked = null;
    if (!payload || path.basename(process.argv[1] ?? '') !== 'agent_hook.mjs' || process.argv[2] !== 'pre_edit') return;
    if (typeof result?.client !== 'string' || !NAME.test(result.client) || !fs.existsSync(AGENT_HOOK)) return;
    const files = (Array.isArray(result.files) ? result.files : []).filter((f) => typeof f === 'string' && path.isAbsolute(f)).slice(0, MAX_WATCHED);
    if (files.length === 0) return;
    const session = typeof payload.session_id === 'string' ? payload.session_id : '';
    const job = {
      id: crypto.randomBytes(8).toString('hex'),
      at: Date.now(),
      client: result.client,
      global: process.argv.includes('--global'),
      payload,
      files: files.map((file) => ({ path: file, stat: statOf(file), fingerprint: fingerprintOf(file), mark: markOf(result.client, session, file) })),
      until: Date.now() + watchMs(),
    };
    job.marked = markNewest(job);
    const child = spawn(process.execPath, [SELF, WATCH_FLAG], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(job));
    child.unref();
  } catch {
    // no watcher: the edit goes unreported, and Crush goes on as it would have
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The job on stdin, checked, or null. */
function readJob() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const done = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 5000);
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) return done(null);
      chunks.push(chunk);
    });
    process.stdin.on('error', () => done(null));
    process.stdin.on('end', () => {
      try {
        const job = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const ok =
          isObject(job) &&
          typeof job.client === 'string' &&
          NAME.test(job.client) &&
          isObject(job.payload) &&
          Number.isFinite(job.until) &&
          Array.isArray(job.files) &&
          job.files.length > 0 &&
          job.files.length <= MAX_WATCHED &&
          job.files.every((f) => isObject(f) && typeof f.path === 'string' && path.isAbsolute(f.path) && (f.mark === undefined || /^[0-9a-f]{32}$/.test(f.mark)));
        done(ok ? job : null);
      } catch {
        done(null);
      }
    });
  });
}

/**
 * Whether any file's text is not what it was: a new size or time alone, with
 * the same text, is not an edit. `thorough` reads the text even when the size
 * and time are the same: an edit of the same size, in the same tick of a
 * file system's clock as the look before it, changes neither.
 */
function changed(files, thorough) {
  let any = false;
  for (const file of files) {
    const stat = statOf(file.path);
    if (stat === file.stat && !thorough) continue;
    file.stat = stat;
    const now = fingerprintOf(file.path);
    if (now !== file.fingerprint) any = true;
  }
  return any;
}

/** Wait while the files are still being written (Crush writes in place), two looks apart, at most two seconds. */
async function settled(files) {
  const deadline = Date.now() + 2000;
  let last = files.map((f) => statOf(f.path)).join('|');
  while (Date.now() < deadline) {
    await sleep(100);
    const now = files.map((f) => statOf(f.path)).join('|');
    if (now === last) return;
    last = now;
  }
}

/** The edit's report: the generic hook's post_edit, given the call as Crush sent it, in the background. Resolves once it is in the pipe. */
function report(job) {
  return new Promise((resolve) => {
    try {
      const args = [AGENT_HOOK, 'post_edit', '--client', job.client, ...(job.global === true ? ['--global'] : [])];
      const child = spawn(process.execPath, args, { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      child.on('error', () => resolve());
      child.stdin.on('error', () => resolve());
      child.stdin.end(JSON.stringify(job.payload), () => {
        child.unref();
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

/** Watch the job's files until one changes, then report the call; or give up at its time. */
async function watch() {
  const job = await readJob();
  if (!job) return;
  const started = Date.now();
  const deadline = Math.min(job.until, started + MAX_WATCH_MS);
  let wait = 50;
  while (Date.now() < deadline) {
    await sleep(Math.min(wait, Math.max(0, deadline - Date.now())));
    wait = Math.min(Math.round(wait * 1.5), 2000);
    // the first seconds, while a clock a second coarse could still hide an edit, by the text
    if (!changed(job.files, Date.now() - started < 5000)) continue;
    await settled(job.files);
    // a change that is a newer call's, or the person's own, is not this call's edit
    if (!superseded(job) && landed(job)) await report(job);
    break;
  }
  sweepMarks();
}

/** Whether this process was started to run this file, through any link to it. */
function runAsWatcher() {
  if (process.argv[2] !== WATCH_FLAG || !process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF);
  } catch {
    return false;
  }
}

if (runAsWatcher()) {
  // anything going wrong in a watcher ends it, and nothing else
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  watch()
    .catch(() => {})
    .finally(() => process.exit(0));
}

// ── the answer ──────────────────────────────────────────────────────────────

/** deny-once's answer when it refuses, as Crush's refusal and nothing else; null when it lets the call go on. */
function refusal(said) {
  try {
    const out = JSON.parse(said?.stdout ?? '');
    if (out?.decision === 'deny' && typeof out.reason === 'string' && out.reason) return JSON.stringify({ decision: 'deny', reason: out.reason }) + '\n';
  } catch {
    // not one
  }
  return null;
}

export default {
  name: 'crush',
  // Crush's own tools (internal/agent/tools at v0.97.1), for the vocabulary
  // (lib.mjs, registerClientTools): the matcher sends only the file tools
  // here, and the rest are named so that a read is never taken for an edit
  // when the matcher is taken off by hand. lsp_rename changes files it does
  // not name, and is left out: it names nothing, so it asks nothing.
  tools: {
    edit: ['edit', 'multiedit', 'lsp_replace_symbol', 'download'],
    write: ['write'],
    command: ['bash'],
    read: [
      'view',
      'ls',
      'glob',
      'grep',
      'fetch',
      'web_fetch',
      'web_search',
      'agentic_fetch',
      'sourcegraph',
      'lsp_diagnostics',
      'lsp_references',
      'lsp_definition',
      'lsp_symbols',
      'lsp_call_hierarchy',
      'lsp_restart',
      'job_output',
      'job_kill',
      'todos',
      'question',
      'crush_info',
      'crush_logs',
      'list_mcp_resources',
      'read_mcp_resource',
      'agent',
    ],
  },
  parse,
  answer(event, result) {
    if (event !== 'pre_edit') return NOTHING;
    const refused = refusal(denyOnce.answer(event, result));
    if (refused) {
      asked = null;
      return { stdout: refused };
    }
    watchFor(result);
    // advice that could not be a refusal: with the edit's result, which is the only other place Crush shows the model a hook's words
    if (result?.action === 'advise' && typeof result.text === 'string' && result.text) return { stdout: JSON.stringify({ context: result.text }) + '\n' };
    return NOTHING;
  },
  neutral() {
    return NOTHING;
  },
};
