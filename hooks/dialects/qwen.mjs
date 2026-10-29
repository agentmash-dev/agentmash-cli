// Qwen Code's hooks, as `npx agentmash login` registers them in its
// settings.json (cli/agents/qwen.mjs): PreToolUse, PostToolUse,
// UserPromptSubmit, SessionStart and SessionEnd, each a matcher group running
// the generic hook with --client qwen --dialect qwen. Qwen Code forked the
// Gemini CLI but took Claude Code's hooks: its payloads are Claude Code's
// shape with its own tool names, and its answers are hookSpecificOutput. Read
// and answered the way Qwen Code reads them (its source, v0.24.7:
// core/hooks/hookEventHandler.ts, hooks/types.ts, hooks/hookRunner.ts,
// hooks/hookAggregator.ts, core/toolHookTriggers.ts):
//
//   pre_edit (PreToolUse)    {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//                            "permissionDecision":"deny","permissionDecisionReason":
//                            "<advice>…"}} for the first try at a file a
//                            teammate's agent is in, as deny-once says it; {}
//                            otherwise. The model reads the reason as the
//                            tool's error, and the turn goes on. Context added
//                            to a call it lets through never reaches the model
//                            in 0.24.7 (later builds append it to the edit's
//                            result, after the edit ran), so this is the only
//                            way the warning reaches the model before the edit.
//                            The refusal is hookSpecificOutput's, not a
//                            top-level decision, which another hook's "allow"
//                            would outrank.
//   prompt (UserPromptSubmit), the heads-up as hookSpecificOutput.additionalContext
//   session_start            under the event's own name, which the model reads;
//                            anything for the person as systemMessage
//   everything else          {}
//
// UserPromptSubmit fires before every call to the model, a tool's result
// among them (core/client.ts); only one that carries `submitted_prompt` is
// something the person typed, and every other one is let go at once: neither
// reported nor asked about. Qwen Code sends submitted_prompt from 0.21.1; an
// older one reports no prompt at all, rather than a tool's result as one.
//
// Never said, to any event: "continue": false, which ends the turn;
// "decision": "block", which stops a prompt being sent; "ask", which puts the
// edit in front of the person again, or refuses it outright in a headless run;
// and "allow". {} lets the call go on as it would have without the hook, and
// is said on stdout rather than nothing, so that a word a node prints on
// stderr is never shown to the person in its place.

import { parseClaudeShaped } from './claude.mjs';
import denyOnce from './deny-once.mjs';

const NOTHING = '{}\n';
/** Qwen Code's own name for each event that can carry context for the model. */
const CONTEXT_EVENTS = { prompt: 'UserPromptSubmit', session_start: 'SessionStart' };
/**
 * The tools a call before or after is read from (core/tools/tool-names.ts):
 * its three that edit a file, edit's old name `replace`, and the shell. Any
 * other, a read, an MCP tool, names no file it changes, whatever its input
 * says, should a matcher be left off by hand.
 */
const CHANGING_TOOLS = new Set(['edit', 'replace', 'write_file', 'notebook_edit', 'run_shell_command']);

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * The call as the edit it is: notebook_edit takes Claude Code's NotebookEdit
 * input word for word, so it goes on under that name, and an edit after it
 * ran with an empty old_string made a new file (edit.ts: on an existing file
 * that is an error, and an error fires PostToolUseFailure, not this), so it
 * goes on as the write it was.
 */
function asEdit(event, input) {
  if (input.tool_name === 'notebook_edit') return { ...input, tool_name: 'NotebookEdit' };
  const args = isObject(input.tool_input) ? input.tool_input : null;
  if (event === 'post_edit' && input.tool_name === 'edit' && args?.old_string === '' && typeof args.new_string === 'string') {
    return { ...input, tool_name: 'write_file', tool_input: { file_path: args.file_path, content: args.new_string } };
  }
  return input;
}

/** Qwen Code's payload as normalized input (see agent_hook.mjs), by way of Claude Code's shape, which it shares; null to let it go. */
function parse(event, input, context) {
  if (!isObject(input)) return null;
  let call = input;
  if (event === 'prompt') {
    const typed = input.submitted_prompt;
    if (typeof typed !== 'string' || !typed.trim()) return null;
    call = { ...input, prompt: typed };
  }
  if (event === 'pre_edit' || event === 'post_edit') {
    if (!CHANGING_TOOLS.has(input.tool_name)) return { session_id: input.session_id, cwd: input.cwd, files: [] };
    call = asEdit(event, input);
  }
  return parseClaudeShaped(event, call, context);
}

/** What the script waited for said (Claude Code's hook JSON), as Qwen Code's answer for `event`. */
function contextAnswer(event, stdout) {
  let out = null;
  try {
    out = typeof stdout === 'string' && stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    return NOTHING;
  }
  const extra = out?.hookSpecificOutput?.additionalContext;
  const shown = out?.systemMessage;
  const answer = {};
  if (typeof shown === 'string' && shown) answer.systemMessage = shown;
  if (typeof extra === 'string' && extra) answer.hookSpecificOutput = { hookEventName: CONTEXT_EVENTS[event], additionalContext: extra };
  return Object.keys(answer).length ? JSON.stringify(answer) + '\n' : NOTHING;
}

/** deny-once's answer when it refuses, as Qwen Code's refusal and nothing else; null when it lets the call go on. */
function refusal(said) {
  try {
    const out = JSON.parse(said?.stdout ?? '');
    if (out?.decision === 'deny' && typeof out.reason === 'string' && out.reason) {
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: out.reason } }) + '\n';
    }
  } catch {
    // not one
  }
  return null;
}

export default {
  name: 'qwen',
  // what each of its changing tools does, so the scripts are handed Claude
  // Code's Edit and Write (notebook_edit goes as NotebookEdit, above)
  tools: {
    edit: ['edit', 'replace'],
    write: ['write_file'],
    command: ['run_shell_command'],
  },
  parse,
  answer(event, result) {
    if (event === 'pre_edit') return { stdout: refusal(denyOnce.answer(event, result)) ?? NOTHING };
    if (CONTEXT_EVENTS[event]) return { stdout: contextAnswer(event, result?.stdout) };
    return { stdout: NOTHING };
  },
  neutral() {
    return { stdout: NOTHING };
  },
};
