// OpenHands' hooks, as the OpenHands Software Agent SDK runs them for both
// the OpenHands CLI (from ~/.openhands/hooks.json) and Agent Canvas (from the
// plugin login writes; see cli/agents/openhands.mjs). Each is a command run
// with `sh -c` in the workspace, given the SDK's HookEvent JSON on stdin
// (hooks/test/fixtures/openhands/ has each shape, with its source), and read
// back as one flat JSON object: decision, reason, additionalContext. Checked
// against the SDK's source at v1.21.0 (the CLI's) and v1.51.0 (hooks/
// executor.py, manager.py, conversation_hooks.py):
//
//   pre_edit (PreToolUse)   {"decision":"deny","reason":"<advice>…"} for the
//                           first try at a file a teammate's agent is in, per
//                           conversation and file (deny-once's rule); nothing
//                           otherwise. The model reads the reason as the tool's
//                           result ("Action rejected: <reason>"), and its turn
//                           goes on. PreToolUse has no way to add anything for
//                           the model to a call it lets through: its
//                           additionalContext goes to the event log only, the
//                           docs notwithstanding. So the warning is a refusal
//                           of the first try, and the same edit again goes
//                           through. In the room's strict mode, every try.
//   prompt                  {"additionalContext":"<heads-up>"}, which OpenHands
//   (UserPromptSubmit)      adds to the person's message: the one event whose
//                           context the model reads
//   everything else         nothing at all
//
// What OpenHands does with an answer, and why only those two are ever said:
//
//   - stdout is read as JSON whatever the exit status, and a deny there
//     refuses the call even if the script then fails: so nothing is printed
//     until the answer is whole (agent_hook.mjs says it once, synchronously),
//     and every way of failing prints nothing, which lets the call go on.
//   - exit status 2 refuses the call, and any other failure (a node that is
//     not there, a script that crashed, a timeout) is logged and the call
//     goes on. The generic hook always exits 0.
//   - "allow", or nothing, lets a call go on as it would have without the
//     hook: OpenHands' own confirmation (the CLI asks the person before every
//     action unless told not to) reads no hook's answer, so nothing here
//     approves anything. Nothing is said rather than "allow" all the same.
//   - "continue": false refuses a call too, and a refusal at UserPromptSubmit
//     drops the person's message: neither is ever said.
//
// In the CLI's default mode, where the person confirms each action, an edit
// refused here is still put to them first: confirmed, the model reads the
// warning; rejected, it reads the person's rejection instead, and the same
// edit again goes through. Nothing is lost that the person did not choose.
//
// Read: file_editor and planning_file_editor change a file only by their
// command (create, str_replace, insert, undo_edit; view reads), so each tool
// is read here by what it is, and the vocabulary in lib.mjs, which goes by
// tool name alone, is not used. A tool that failed is not reported. An edit
// made in `terminal` names no file: after it runs, the working tree says what
// it changed, as for Codex's Bash; before it, nothing is asked.

import path from 'node:path';
import denyOnce from './deny-once.mjs';

const NOTHING = '';

/** file_editor's commands that change the file, and the one that only reads it. */
const EDITOR_TOOLS = new Set(['file_editor', 'planning_file_editor']);
const EDITOR_CHANGES = new Set(['create', 'str_replace', 'insert', 'undo_edit']);

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v ? v : undefined);
const absolute = (p) => (typeof p === 'string' && path.isAbsolute(p) ? p : undefined);

/** The normalized `files` entry for one file_editor call, or null for one that changes nothing. */
function editorFile(args) {
  const file = str(args.path);
  if (!file || !EDITOR_CHANGES.has(args.command)) return null;
  if (args.command === 'create') return { path: file, action: 'write', ...(typeof args.file_text === 'string' ? { after: args.file_text } : {}) };
  // new_str left out of a str_replace replaces old_str with nothing
  if (args.command === 'str_replace' && typeof args.old_str === 'string') return { path: file, before: args.old_str, after: str(args.new_str) ?? '' };
  // an insert adds new_str and takes nothing away
  if (args.command === 'insert' && typeof args.new_str === 'string') return { path: file, before: '', after: args.new_str };
  // undo_edit, or an edit whose text is not there: the file, and no count of lines
  return { path: file, action: 'edit' };
}

/** The gemini preset's edit: old_string "" writes a new file (its definition.py). */
function geminiEditFile(args, response) {
  // after it ran, the path it resolved against the workspace
  const file = absolute(response?.file_path) ?? str(args.file_path);
  if (!file) return null;
  if (args.old_string === '' && typeof args.new_string === 'string') return { path: file, action: 'write', after: args.new_string };
  if (typeof args.old_string === 'string') return { path: file, before: args.old_string, after: str(args.new_string) ?? '' };
  return { path: file, action: 'edit' };
}

function writeFileFile(args, response) {
  const file = absolute(response?.file_path) ?? str(args.file_path);
  if (!file) return null;
  return { path: file, action: 'write', ...(typeof args.content === 'string' ? { after: args.content } : {}) };
}

/**
 * OpenHands' HookEvent as normalized input (see agent_hook.mjs), or null when
 * it is not one. The session and the workspace come from the payload, or from
 * the environment OpenHands gives every hook.
 */
export function parseOpenHands(event, input) {
  if (!isObject(input)) return null;
  const base = {
    session_id: str(input.session_id) ?? str(process.env.OPENHANDS_SESSION_ID),
    cwd: absolute(input.working_dir) ?? absolute(process.env.OPENHANDS_PROJECT_DIR),
  };
  if (event === 'prompt') return { ...base, prompt: typeof input.message === 'string' ? input.message : '' };
  if (event === 'session_end') {
    const reason = isObject(input.metadata) ? str(input.metadata.reason) : undefined;
    return reason ? { ...base, end_reason: reason } : base;
  }
  if (event !== 'pre_edit' && event !== 'post_edit') return base;

  const tool = str(input.tool_name);
  const args = isObject(input.tool_input) ? input.tool_input : {};
  const response = isObject(input.tool_response) ? input.tool_response : null;
  const call = { ...base, tool, files: [] };
  // a tool that failed changed nothing to report (PostToolUse runs for it all the same)
  if (event === 'post_edit' && response?.is_error === true) return call;
  let file = null;
  if (EDITOR_TOOLS.has(tool)) file = editorFile(args);
  else if (tool === 'edit') file = geminiEditFile(args, response);
  else if (tool === 'write_file') file = writeFileFile(args, response);
  else if (tool === 'apply_patch') return typeof args.patch === 'string' && args.patch ? { ...call, patch: args.patch } : call;
  else if (tool === 'terminal') return event === 'post_edit' && typeof args.command === 'string' ? { ...call, command: args.command } : call;
  return file ? { ...call, files: [file] } : call;
}

/** What the script waited for at a prompt said (Claude Code's hook JSON), as OpenHands' additionalContext. */
function promptContext(stdout) {
  let out = null;
  try {
    out = typeof stdout === 'string' && stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    return NOTHING;
  }
  const context = out?.hookSpecificOutput?.additionalContext;
  return typeof context === 'string' && context ? JSON.stringify({ additionalContext: context }) + '\n' : NOTHING;
}

/** deny-once's answer when it refuses, as OpenHands' refusal and nothing else; null when it lets the call go on. */
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
  name: 'openhands',
  parse: parseOpenHands,
  answer(event, result) {
    if (event === 'pre_edit') return { stdout: refusal(denyOnce.answer(event, result)) ?? NOTHING };
    if (event === 'prompt') return { stdout: promptContext(result?.stdout) };
    return { stdout: NOTHING };
  },
  neutral() {
    return { stdout: NOTHING };
  },
};
