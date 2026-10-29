// Factory Droid's hooks (the `droid` CLI), as `npx agentmash login` registers
// them in ~/.factory/hooks.json (cli/agents/droid.mjs): PreToolUse,
// PostToolUse, UserPromptSubmit, SessionStart, SessionEnd and Stop, each a
// matcher group running the generic hook with --client droid. Droid sends
// Claude Code's shape, snake_case (session_id, cwd, permission_mode,
// hook_event_name, tool_name, tool_input, tool_response), and reads answers
// close to Claude Code's, with one difference that decides everything before
// an edit (docs.factory.com/harness/hooks.md, CLI 0.233.0):
//
//   pre_edit (PreToolUse)     PreToolUse has no way to add context to a call
//                             it lets through: only permissionDecision, whose
//                             "allow" skips the person's own approval and
//                             whose "ask" puts a prompt in front of them. A
//                             refusal is the one answer the model reads
//                             ("deny: blocks the tool call and sends the
//                             reason to Droid"). So the first try at a file a
//                             teammate's agent is in is refused, with the
//                             advice as permissionDecisionReason, and the same
//                             edit again goes through (deny-once.mjs's
//                             bookkeeping). Anything else is nothing at all,
//                             exit 0: Droid's own permission flow goes on as
//                             if there were no hook.
//   prompt (UserPromptSubmit), the heads-up as hookSpecificOutput.additionalContext
//   session_start             under the event's own name, which Droid adds to
//                             the model's context; anything for the person as
//                             systemMessage
//   stop                      the overlap note for the person, systemMessage
//   everything else           nothing
//
// The refusal is the JSON one, not exit 2 with the reason on stderr: Factory's
// docs say only of the JSON deny that the model is sent the reason (of exit 2
// before a tool they say it blocks the call), and it is the form verified
// live on 0.233.0 (cc-safety-net). A Droid that did not read it would take it
// as text for the transcript and run the edit as it would have anyway.
//
// Never said, to any event: "allow" or the old "approve" (both skip Droid's
// own approval of the edit, which at its default autonomy asks the person),
// "ask", updatedInput (it rewrites the call), "continue": false (it stops
// Droid), or exit 2, which after a prompt would erase the prompt. Nothing but
// JSON is printed either: Droid adds plain text after a prompt to the model's
// context as it is.
//
// The matchers login registers are Factory's own ("Create|Edit|ApplyPatch"),
// whose anchoring Droid does not document, so the tool is checked again here
// by its exact name: an MCP tool with Edit in its name is not an edit.
//
// What each tool sends is documented only for Create ({file_path, content}).
// Edit names its file in file_path too (Factory's own code-validation guide
// reads it there); its old and new text have no documented keys, so
// old_str/old_string and new_str/new_string are both read. ApplyPatch sends a
// patch in the apply_patch format in `patch` (Droid's ACP adapter; `input` and
// `diff` are read too), or, as that guide reads it, a file_path alone.

import { parseClaudeShaped } from './claude.mjs';
import denyOnce from './deny-once.mjs';

/** Droid's tools by what they do (docs.factory.com: Create, Edit, ApplyPatch; Execute; the read-only ones). */
const TOOLS = {
  write: ['Create'],
  edit: ['Edit'],
  patch: ['ApplyPatch'],
  command: ['Execute'],
  read: ['Read', 'LS', 'Glob', 'Grep', 'FetchUrl', 'WebSearch', 'Task'],
};
const EDITS = new Set([...TOOLS.write, ...TOOLS.edit, ...TOOLS.patch]);
/** Droid's own name for each event that can carry context for the model. */
const CONTEXT_EVENTS = { prompt: 'UserPromptSubmit', session_start: 'SessionStart' };

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const firstString = (...values) => values.find((v) => typeof v === 'string' && v);

/**
 * Droid's payload in snake_case. One third-party reference says Droid sends
 * camelCase; Factory's docs and two integrations tested against it say snake
 * case. Both are read, the snake_case field winning.
 */
function snakeCase(input) {
  const out = { ...input };
  const alias = { sessionId: 'session_id', toolName: 'tool_name', toolInput: 'tool_input', toolResponse: 'tool_response', hookEventName: 'hook_event_name', stopHookActive: 'stop_hook_active' };
  for (const [camel, snake] of Object.entries(alias)) if (out[snake] === undefined && input[camel] !== undefined) out[snake] = input[camel];
  if (typeof out.tool_input === 'string' && /^\s*\{/.test(out.tool_input)) {
    try {
      out.tool_input = JSON.parse(out.tool_input);
    } catch {
      // not arguments we can read
    }
  }
  return out;
}

/**
 * One edit tool's call as the call the hook scripts read: a patch in `patch`
 * whichever key it came in, an ApplyPatch with no patch as the edit of the
 * file it names, and after a Create or an Edit the absolute path the tool
 * says it wrote (tool_response.filePath), when it says one.
 */
function callOf(event, tool, input) {
  const args = isObject(input.tool_input) ? { ...input.tool_input } : {};
  if (tool === 'ApplyPatch') {
    const patch = firstString(args.patch, args.input, args.diff, args.command);
    if (patch) return { tool_name: tool, tool_input: { patch } };
    const file = firstString(args.file_path, args.path);
    return file ? { tool_name: 'Edit', tool_input: { file_path: file } } : { tool_name: tool, tool_input: {} };
  }
  const said = isObject(input.tool_response) ? input.tool_response.filePath : undefined;
  if (event === 'post_edit' && typeof said === 'string' && /^([\\/]|[A-Za-z]:[\\/])/.test(said)) args.file_path = said;
  return { tool_name: tool, tool_input: args };
}

/** Droid's payload as normalized input (see agent_hook.mjs), by way of Claude Code's shape, which it shares. */
function parse(event, input, context) {
  if (!isObject(input)) return null;
  const raw = snakeCase(input);
  if (event !== 'pre_edit' && event !== 'post_edit') return parseClaudeShaped(event, raw, context);
  const tool = typeof raw.tool_name === 'string' ? raw.tool_name : undefined;
  const nothing = { session_id: raw.session_id, cwd: raw.cwd, tool, files: [] };
  // a command is reported after it ran, by what it changed in the working tree; before it, nothing is asked
  const command = event === 'post_edit' && TOOLS.command.includes(tool);
  if (!EDITS.has(tool) && !command) return nothing;
  // a tool that failed changed nothing
  if (event === 'post_edit' && isObject(raw.tool_response) && raw.tool_response.success === false) return nothing;
  const call = command ? { tool_name: tool, tool_input: raw.tool_input } : callOf(event, tool, raw);
  return { ...parseClaudeShaped(event, { ...raw, ...call }, context), tool };
}

/** What the script waited for said (Claude Code's hook JSON), as Droid's answer for `event`: context, a word for the person, or nothing. */
function contextAnswer(event, stdout) {
  let out = null;
  try {
    out = typeof stdout === 'string' && stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    return '';
  }
  if (!isObject(out)) return '';
  const answer = {};
  const shown = out.systemMessage;
  if (typeof shown === 'string' && shown) answer.systemMessage = shown;
  const extra = out.hookSpecificOutput?.additionalContext;
  if (CONTEXT_EVENTS[event] && typeof extra === 'string' && extra) {
    answer.hookSpecificOutput = { hookEventName: CONTEXT_EVENTS[event], additionalContext: extra };
  }
  return Object.keys(answer).length ? JSON.stringify(answer) + '\n' : '';
}

/** deny-once's answer before an edit, said Droid's way: its refusal as permissionDecision "deny", else nothing at all. */
function beforeEdit(result) {
  let said = null;
  try {
    said = JSON.parse(denyOnce.answer('pre_edit', result).stdout);
  } catch {
    // nothing it said is a refusal
  }
  if (said?.decision === 'deny' && typeof said.reason === 'string' && said.reason) {
    const refusal = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: said.reason };
    return { stdout: JSON.stringify({ hookSpecificOutput: refusal }) + '\n' };
  }
  return { stdout: '' };
}

export default {
  name: 'droid',
  tools: TOOLS,
  parse,
  answer(event, result) {
    if (event === 'pre_edit') return beforeEdit(result);
    if (CONTEXT_EVENTS[event] || event === 'stop') return { stdout: contextAnswer(event, result?.stdout) };
    return { stdout: '' };
  },
  neutral() {
    return { stdout: '' };
  },
};
