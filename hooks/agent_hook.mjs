#!/usr/bin/env node
// AgentMash's generic hook: one script any coding agent with hooks can run,
// whatever its hooks send and whatever answer they read back.
//
//   node ~/.agentmash/hooks/agent_hook.mjs <event> --client <id>
//        [--dialect <name>] [--input auto|native|normalized] [--global]
//
//   <event>     pre_edit, post_edit, prompt, session_start, session_end or stop
//   --client    the agent, as its events name it (`tool: "<id>:Edit"`): a
//               short lowercase name, [a-z][a-z0-9-]{0,20}. Required.
//   --dialect   the answer the agent reads: a file in dialects/ (claude,
//               deny-once, plain, json, and any added since). Left out, the
//               one named like the client when there is one, else claude.
//   --input     how stdin is read: `native` by the dialect's parse, as the
//               agent sends it; `normalized` as the schema below; `auto`
//               (the default) normalized when it says "agentmash": 1, else
//               native.
//   --global    as for every other hook: the room is found for the checkout
//               by this machine's sign-in (`npx agentmash login`).
//
// It translates, and reimplements nothing. The input is normalized, then
// handed, as Claude Code would have sent it, to the script Claude Code runs
// at the same moment, with --client <id>: so the advice and its wording,
// strict mode, claims, symbols, the looks at the working tree, identity, and
// which room a checkout reports to are those scripts', and lib.mjs and the
// scripts know nothing of this file. What a script prints, Claude Code's hook
// JSON, is read back as a result, and the dialect says it.
//
//   pre_edit       pre_tool_use.mjs, waited for: the advice before an edit
//   post_edit      post_tool_use.mjs, in the background: the edit's report
//   prompt         user_prompt_submit.mjs in the background (the report),
//                  and prompt_note.mjs waited for (the heads-up)
//   session_start  session_start.mjs, waited for
//   session_end    session_end.mjs, in the background
//   stop           stop.mjs, waited for
//
// A report is handed to a script in the background and this returns at once,
// as `--detach` does for the other agents. A script waited for costs one more
// node start, a few tens of milliseconds, on top of its own budget.
//
// ── Normalized input ────────────────────────────────────────────────────────
//
//   {
//     "agentmash": 1,                    schema version; marks normalized input
//     "event": "pre_edit",               optional: the argument wins
//     "session_id": "…",                 the agent's own stable session id, ≤200
//                                        characters ("unknown" when missing)
//     "cwd": "/abs/path",                where the agent works; the repository is
//                                        found from here (this process's when missing)
//     "files": [                         pre_edit and post_edit: the files the call
//       {                                changes, at most 100 read, 8 acted on
//         "path": "src/a.ts",            absolute, or relative to cwd; a file outside
//                                        the repository is dropped before any
//                                        network call, and never named to the room
//         "before": "…", "after": "…",   optional: the text replaced and its
//                                        replacement (an Edit), or with `after`
//                                        alone the whole new file (a Write)
//         "edits": [{ "before", "after" }],  optional: several edits of the file
//         "action": "edit|write|delete"  optional
//       }
//     ],                                 a plain string is a file with only a path
//     "patch": "*** Begin Patch…",       optional: an apply_patch-format patch,
//                                        in place of `files`
//     "command": "npm run build",        optional, post_edit: a shell command the
//                                        agent ran; the working tree says what it
//                                        changed
//     "tool": "write_file",              optional, ≤60: the agent's own tool name,
//                                        kept in the result only; the room is told
//                                        "<client>:Edit", "<client>:Write" …
//     "prompt": "…",                     prompt: what the person typed
//     "agent_id": "…", "agent_type": "…",  optional: a subagent's, as Claude
//                                        Code's (only a crew agent's type is sent)
//     "end_reason": "exit",              optional, session_end, ≤50
//     "stop_hook_active": false          optional, stop
//   }
//
// Identity is never read from stdin: it is the git email, or the GitHub login
// the machine signed in with, as for every hook.
//
// ── The result, which a dialect says and --dialect json prints ─────────────
//
//   {
//     "agentmash": 1, "event": "pre_edit",
//     "action": "allow | advise | deny",   deny only in the room's strict mode
//     "level": "active | stale | parallel | recent | nearby | claimed | overlap" | null,
//     "text": "…" | null,                  the advice, for the agent
//     "files": ["/abs/…"],                 the files asked about or reported
//     "strict": false                      true when strict mode refused the edit
//   }
//
// A dialect also gets `stdout` (what the script printed, word for word),
// `client`, `session_id` and `cwd` on the result.
//
// ── Dialects ────────────────────────────────────────────────────────────────
//
// One file each in dialects/, `export default { name, parse?, answer,
// neutral, tools? }`:
//
//   parse(event, input, { client, lib })  the agent's own JSON as normalized
//                                         input (left out: Claude Code's shape)
//   answer(event, result)                 { stdout, stderr?, exitCode? }
//   neutral(event)                        { stdout }: what is said when anything
//                                         fails, which lets the agent go on
//   tools                                 optional: { edit, write, patch,
//                                         command, read }, the agent's tool
//                                         names, registered for --client before
//                                         parse runs (lib.mjs, registerClientTools)
//
// A file added there is picked up as it is: `npx agentmash login` copies
// every one, and nothing lists them.
//
// ── Failing open ────────────────────────────────────────────────────────────
//
// Anything going wrong (an unknown event or dialect, no --client, stdin that
// is not JSON, a script that crashes or says nothing it should, a room that
// is down or slow, AGENTMASH_DISABLE=1) is the dialect's neutral answer and
// exit 0, said once, synchronously. A guard says it too, and ends the process,
// when a script it waits for outlives its own budget. Nothing here ever
// approves what the person would otherwise be asked about.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const EVENT = ARGS[0];
const flag = (name) => {
  const at = ARGS.indexOf(name);
  return at === -1 ? null : (ARGS[at + 1] ?? null);
};
const CLIENT = flag('--client');
const GLOBAL = ARGS.includes('--global');
const INPUT = flag('--input') ?? 'auto';

const EVENTS = ['pre_edit', 'post_edit', 'prompt', 'session_start', 'session_end', 'stop'];
const NAME = /^[a-z][a-z0-9-]{0,20}$/;
const DIALECT_NAME = /^[a-z][a-z0-9-]{0,30}$/;

/** Files acted on from one call, at most: each is a check, or a report, of its own. */
const MAX_FILES = 8;
/** Files read from normalized input, at most. */
const MAX_LISTED = 100;
/** stdin past this is not a hook's payload. */
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
/** The advisory budget when there is no config to say otherwise (lib.mjs, ADVISORY_TIMEOUT_MS). */
const DEFAULT_BUDGET_MS = 1500;
/** How long the guard gives a script past its own deadline: node starting, and the answer coming back. */
const PARENT_SLACK_MS = 400;

/**
 * The scripts waited for, and how long each may take after it starts: its
 * own exit guard. pre_tool_use and stop guard at the advisory budget plus
 * 250 ms; prompt_note at 2.5 s; session_start at lib.mjs's HOOK_DEADLINE_MS.
 */
const WAITED = {
  pre_edit: { script: 'pre_tool_use.mjs', deadline: (budget) => budget + 250 },
  prompt: { script: 'prompt_note.mjs', deadline: () => 2500 },
  session_start: { script: 'session_start.mjs', deadline: () => 4500 },
  stop: { script: 'stop.mjs', deadline: (budget) => budget + 250 },
};
/** The scripts handed a report in the background. */
const REPORTED = { post_edit: 'post_tool_use.mjs', prompt: 'user_prompt_submit.mjs', session_end: 'session_end.mjs' };
/** Claude Code's name for each event, for the script's input. */
const CLAUDE_EVENT = {
  pre_edit: 'PreToolUse',
  post_edit: 'PostToolUse',
  prompt: 'UserPromptSubmit',
  session_start: 'SessionStart',
  session_end: 'SessionEnd',
  stop: 'Stop',
};
/** The advice's tag, as lib.mjs writes it at the start of the text, and the level it says. */
const LEVELS = {
  'ACTIVE COLLISION': 'active',
  'STALE READ': 'stale',
  'PARALLEL EDIT': 'parallel',
  'RECENT EDIT': 'recent',
  'NEARBY EDIT': 'nearby',
  CLAIMED: 'claimed',
  OVERLAP: 'overlap',
};

// ── saying it once ──────────────────────────────────────────────────────────
//
// Some agents treat a hook that says nothing, or half a line, as a refusal,
// so whatever happens exactly one answer is written, synchronously (stdout is
// a pipe, and a pipe write can still be pending when the process goes): the
// dialect's answer, or its neutral one from wherever this gives up.

let dialect = null;
let answered = false;
let waitedChild = null;
/** lib.mjs, once main() has loaded it: a JSON answer goes out in ASCII by its asciiJson. */
let hookLib = null;

function say(answer) {
  if (answered) return;
  answered = true;
  const { stdout = '', stderr = '', exitCode = 0 } = answer && typeof answer === 'object' ? answer : {};
  try {
    // a JSON answer in ASCII, so a PowerShell between the agent and this hook has nothing to re-encode
    const text = typeof stdout === 'string' && hookLib?.asciiJson ? hookLib.asciiJson(stdout) : stdout;
    if (typeof text === 'string' && text) fs.writeSync(1, text);
  } catch {
    // nowhere to write: the agent reads that as a hook that failed, and goes on
  }
  try {
    if (typeof stderr === 'string' && stderr) fs.writeSync(2, stderr);
  } catch {
    // as above
  }
  process.exitCode = Number.isInteger(exitCode) && exitCode >= 0 && exitCode < 256 ? exitCode : 0;
}

/** The dialect's neutral answer, or nothing at all when there is no dialect to give one. */
function neutral() {
  let answer = { stdout: '' };
  try {
    const given = dialect?.neutral?.(EVENT);
    if (given && typeof given.stdout === 'string') answer = { stdout: given.stdout };
  } catch {
    // a dialect that cannot say even this says nothing
  }
  say({ ...answer, exitCode: 0 });
}

let guard = null;
/** End the process `ms` from now, saying the neutral answer if nothing was said. */
function armGuard(ms) {
  clearTimeout(guard);
  guard = setTimeout(() => {
    neutral();
    try {
      waitedChild?.kill();
    } catch {
      // gone already
    }
    process.exit(process.exitCode ?? 0);
  }, ms);
  guard.unref?.();
}

process.on('uncaughtException', () => {
  neutral();
  process.exit(process.exitCode ?? 0);
});
process.on('unhandledRejection', () => {
  neutral();
  process.exit(process.exitCode ?? 0);
});

// Until the budget is known: stdin, the dialect and lib.mjs, and the room's
// budget for the script (whose own guard is the advisory budget past its start).
armGuard(DEFAULT_BUDGET_MS + 250 + PARENT_SLACK_MS);

// ── reading what the agent sent ─────────────────────────────────────────────

/** All of stdin, or null past MAX_INPUT_BYTES; what came within 2 s when it never ends. */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const done = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(Buffer.concat(chunks).toString('utf8')), 2000);
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) return done(null);
      chunks.push(chunk);
    });
    process.stdin.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => done(null));
  });
}

/** A dialect from dialects/, by name, or null. */
async function loadDialect(name) {
  if (typeof name !== 'string' || !DIALECT_NAME.test(name)) return null;
  const file = path.join(HERE, 'dialects', `${name}.mjs`);
  if (!fs.existsSync(file)) return null;
  const loaded = (await import(pathToFileURL(file).href)).default;
  return loaded && typeof loaded.answer === 'function' && typeof loaded.neutral === 'function' ? loaded : null;
}

/** The dialect asked for, or the one named like the client, or claude's. */
function dialectName() {
  const asked = flag('--dialect');
  if (asked) return asked;
  if (CLIENT && NAME.test(CLIENT) && fs.existsSync(path.join(HERE, 'dialects', `${CLIENT}.mjs`))) return CLIENT;
  return 'claude';
}

const text = (value, max) => (typeof value === 'string' && value && value.length <= max ? value : undefined);
/** A path that can be named in a patch's header and passed on: a string with no line break or NUL in it. */
const usablePath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 4096 && !/[\r\n\0]/.test(p);

/** One `files` entry, cleaned, or null. */
function cleanFile(entry) {
  const f = typeof entry === 'string' ? { path: entry } : entry;
  if (!f || typeof f !== 'object' || !usablePath(f.path)) return null;
  const out = { path: f.path };
  if (typeof f.before === 'string') out.before = f.before;
  if (typeof f.after === 'string') out.after = f.after;
  if (Array.isArray(f.edits)) {
    out.edits = f.edits
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({
        ...(typeof e.before === 'string' ? { before: e.before } : {}),
        ...(typeof e.after === 'string' ? { after: e.after } : {}),
      }));
  }
  if (['edit', 'write', 'delete'].includes(f.action)) out.action = f.action;
  return out;
}

/**
 * Input in the normalized schema (see the top), cleaned: what is not in the
 * schema goes, and what is the wrong type is left out. `call`, the agent's
 * own tool call a dialect's parse can hand on as it came, is kept only from
 * a parse, never from stdin.
 */
function normalized(value, { fromParse = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const n = {
    agentmash: 1,
    event: EVENT,
    session_id: text(value.session_id, 200) ?? 'unknown',
    cwd: typeof value.cwd === 'string' && path.isAbsolute(value.cwd) ? value.cwd : process.cwd(),
    files: (Array.isArray(value.files) ? value.files.slice(0, MAX_LISTED) : []).map(cleanFile).filter(Boolean),
  };
  if (typeof value.patch === 'string' && value.patch) n.patch = value.patch;
  if (typeof value.command === 'string') n.command = value.command;
  const tool = text(value.tool, 60);
  if (tool) n.tool = tool;
  if (typeof value.prompt === 'string') n.prompt = value.prompt;
  for (const [key, max] of [['agent_id', 200], ['agent_type', 200], ['end_reason', 50], ['source', 50]]) {
    const v = text(value[key], max);
    if (v) n[key] = v;
  }
  if (typeof value.stop_hook_active === 'boolean') n.stop_hook_active = value.stop_hook_active;
  const call = value.call;
  if (fromParse && call && typeof call === 'object' && typeof call.tool_name === 'string') {
    n.call = { tool_name: call.tool_name, tool_input: call.tool_input };
  }
  return n;
}

// ── what each script is handed ──────────────────────────────────────────────

/** One file's edit, as the Claude Code tool call it is. */
function fileCall(f) {
  if (f.edits) {
    return { tool_name: 'MultiEdit', tool_input: { file_path: f.path, edits: f.edits.map((e) => ({ old_string: e.before, new_string: e.after })) } };
  }
  const whole = f.action === 'write' || (f.action === undefined && f.before === undefined && f.after !== undefined);
  if (whole && typeof f.after === 'string') return { tool_name: 'Write', tool_input: { file_path: f.path, content: f.after } };
  // an edit of unknown size names its file and counts nothing: "+0/-0" would be a summary of nothing
  const input = { file_path: f.path };
  if (typeof f.before === 'string') input.old_string = f.before;
  if (typeof f.after === 'string' || (f.action === 'delete' && typeof f.before === 'string')) input.new_string = f.after ?? '';
  return { tool_name: 'Edit', tool_input: input };
}

/** Several files as a patch that only names them: how pre_tool_use asks about a patch's files, all at once. */
function namingPatch(files) {
  const verb = (f) => (f.action === 'delete' ? 'Delete' : f.action === 'write' ? 'Add' : 'Update');
  return ['*** Begin Patch', ...files.map((f) => `*** ${verb(f)} File: ${f.path}`), '*** End Patch'].join('\n');
}

/**
 * The tool calls an edit event hands its script: the agent's own when a
 * parse kept it, a patch, a command, one Claude Code edit per file after an
 * edit, or, before one, a single patch naming all of them.
 */
function toolCalls(event, n) {
  if (n.call) return [n.call];
  if (n.patch) return [{ tool_name: 'apply_patch', tool_input: { command: n.patch } }];
  if (event === 'post_edit' && typeof n.command === 'string') return [{ tool_name: 'Bash', tool_input: { command: n.command } }];
  const files = n.files.slice(0, MAX_FILES);
  if (files.length === 0) return [];
  if (files.length === 1 || event === 'post_edit') return files.map(fileCall);
  return [{ tool_name: 'apply_patch', tool_input: { command: namingPatch(files) } }];
}

/** The input a script reads, as Claude Code would have sent it. */
function claudeInput(event, n, call = null) {
  const input = { session_id: n.session_id, cwd: n.cwd, hook_event_name: CLAUDE_EVENT[event] };
  if (n.agent_id) input.agent_id = n.agent_id;
  if (n.agent_type) input.agent_type = n.agent_type;
  if (call) Object.assign(input, { tool_name: call.tool_name, tool_input: call.tool_input });
  if (event === 'prompt') input.prompt = n.prompt ?? '';
  if (event === 'session_start') input.source = n.source ?? 'startup';
  if (event === 'session_end') input.reason = n.end_reason ?? 'other';
  if (event === 'stop') input.stop_hook_active = n.stop_hook_active === true;
  return input;
}

const scriptArgs = () => ['--client', CLIENT, ...(GLOBAL ? ['--global'] : [])];

/** Hand `input` to a script in the background, and return once it is in the pipe. Never throws. */
function handOff(script, input) {
  return new Promise((resolve) => {
    try {
      const child = spawn(process.execPath, [path.join(HERE, script), ...scriptArgs()], {
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
      child.on('error', () => resolve(false));
      child.stdin.on('error', () => resolve(false));
      child.stdin.end(JSON.stringify(input), () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Run a script with `input` and wait: what it printed, or '' (it crashed, or never ran). Never throws. */
function runWaited(script, input) {
  return new Promise((resolve) => {
    try {
      const child = spawn(process.execPath, [path.join(HERE, script), ...scriptArgs()], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      waitedChild = child;
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        if (out.length < MAX_INPUT_BYTES) out += d;
      });
      child.on('error', () => resolve(''));
      child.on('close', (code) => resolve(code === 0 ? out : ''));
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
    } catch {
      resolve('');
    }
  });
}

/** What a script's Claude Code hook JSON says, as the result's action, text, level and strict. */
function readAnswer(stdout) {
  let out = null;
  try {
    out = stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    return { stdout: '' };
  }
  if (!out || typeof out !== 'object') return { stdout: '' };
  const said = out.hookSpecificOutput && typeof out.hookSpecificOutput === 'object' ? out.hookSpecificOutput : {};
  const denied = said.permissionDecision === 'deny' && typeof said.permissionDecisionReason === 'string';
  const words = denied ? said.permissionDecisionReason : [said.additionalContext, out.systemMessage].find((t) => typeof t === 'string' && t);
  if (!words) return { stdout };
  const tag = /^\[AgentMash: ([A-Z ]+)\]/.exec(words)?.[1];
  return { stdout, action: denied ? 'deny' : 'advise', text: words, level: LEVELS[tag] ?? null, strict: denied };
}

/** The files a normalized input is about, absolute. */
function filesOf(n, lib) {
  const named = n.files.map((f) => f.path);
  if (n.patch) named.push(...(lib.filesInPatch?.(n.patch) ?? []).map((f) => f.path));
  return [...new Set(named.filter(usablePath).map((p) => path.resolve(n.cwd, p)))];
}

async function main() {
  dialect = await loadDialect(dialectName());
  // No dialect, no way to answer in it: nothing is said, which is the most any
  // agent can be sure of reading as "go on".
  if (!dialect) return say({ stdout: '' });
  if (!EVENTS.includes(EVENT) || typeof CLIENT !== 'string' || !NAME.test(CLIENT)) return neutral();
  if (process.env.AGENTMASH_DISABLE === '1') return neutral();

  const raw = await readStdin();
  let parsed = null;
  try {
    // without the byte order mark PowerShell can put in front of what it pipes in (lib.mjs parseJson)
    parsed = raw ? JSON.parse(raw.replace(/^\uFEFF/, '')) : null;
  } catch {
    return neutral();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return neutral();

  const lib = await import(pathToFileURL(path.join(HERE, 'lib.mjs')).href);
  hookLib = lib;
  if (dialect.tools) lib.registerClientTools?.(CLIENT, dialect.tools);
  const asNormalized = INPUT === 'normalized' || (INPUT !== 'native' && parsed.agentmash === 1);
  let n;
  if (asNormalized) n = normalized(parsed);
  else {
    const parse = typeof dialect.parse === 'function' ? dialect.parse : (await loadDialect('claude'))?.parse;
    n = typeof parse === 'function' ? normalized(parse(EVENT, parsed, { client: CLIENT, lib }), { fromParse: true }) : null;
  }
  if (!n) return neutral();

  // the room's own budget for the check, as the script will read it, and AGENTMASH_DISABLE in a .env
  const config = lib.loadConfig?.(n.cwd);
  if (config?.disabled) return neutral();
  const budget = Number.isFinite(config?.advisoryTimeoutMs) ? config.advisoryTimeoutMs : DEFAULT_BUDGET_MS;

  const result = {
    agentmash: 1,
    event: EVENT,
    action: 'allow',
    level: null,
    text: null,
    files: filesOf(n, lib),
    strict: false,
    stdout: '',
    client: CLIENT,
    session_id: n.session_id,
    cwd: n.cwd,
  };
  const calls = EVENT === 'pre_edit' || EVENT === 'post_edit' ? toolCalls(EVENT, n) : null;
  if (n.call && result.files.length === 0) {
    // a call the scripts read themselves names its files as they would
    result.files = [...new Set((lib.editedFiles?.(n.call.tool_name, n.call.tool_input) ?? []).filter(usablePath).map((p) => path.resolve(n.cwd, p)))];
  }

  // the report first, in the background, so nothing it does waits on the advice
  const reporter = REPORTED[EVENT];
  if (reporter) {
    const inputs = calls ? calls.map((call) => claudeInput(EVENT, n, call)) : [claudeInput(EVENT, n)];
    await Promise.all(inputs.map((input) => handOff(reporter, input)));
  }

  const waited = WAITED[EVENT];
  // a call that names no file it changes (a read, a command) has nothing to ask about before it runs
  if (waited && !(EVENT === 'pre_edit' && (calls.length === 0 || result.files.length === 0))) {
    armGuard(waited.deadline(budget) + PARENT_SLACK_MS);
    const out = await runWaited(waited.script, claudeInput(EVENT, n, calls?.[0] ?? null));
    Object.assign(result, readAnswer(out));
  }

  let answer;
  try {
    answer = dialect.answer(EVENT, result);
  } catch {
    return neutral();
  }
  if (!answer || typeof answer.stdout !== 'string') return neutral();
  say(answer);
}

main()
  .catch(() => neutral())
  .finally(() => {
    // stdin left open by an agent that never closes it would hold the process
    try {
      process.stdin.destroy();
    } catch {
      // already closed
    }
  });
