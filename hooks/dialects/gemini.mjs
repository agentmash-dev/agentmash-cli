// Gemini CLI's hooks, as `npx agentmash login` registers them in its
// settings.json (cli/agents/gemini.mjs): BeforeTool, AfterTool, BeforeAgent,
// SessionStart and SessionEnd, each a matcher group running the generic hook
// with --client gemini. Read and answered the way Gemini CLI reads them (its
// source, v0.62.0: core/src/hooks/types.ts, scheduler/hook-utils.ts,
// core/coreToolHookTriggers.ts, hooks/hookRunner.ts):
//
//   pre_edit (BeforeTool)     {"decision":"deny","reason":"<advice>…"} for the
//                             first try at a file a teammate's agent is in,
//                             as deny-once says it; {} otherwise. The model
//                             reads the reason as the tool's error ("Tool
//                             execution blocked: …"), and the turn goes on.
//                             BeforeTool has no way to add context to a call
//                             it lets through, so this is the only way the
//                             warning reaches the model before the edit.
//   prompt (BeforeAgent),     the heads-up as hookSpecificOutput.additionalContext
//   session_start             under the event's own name, which the model
//                             reads; anything for the person as systemMessage
//   everything else           {}
//
// Never said, to any event: "continue": false, which ends the agent's whole
// loop; hookSpecificOutput.tool_input, which rewrites the call; "ask", which
// puts a dialog in front of the person even in YOLO mode; a decision after a
// tool ran, which replaces its result; and "allow". {} lets the call go on as
// it would have without the hook, and Gemini CLI still asks the person
// whatever it would have asked: a hook's answer grants nothing there.

import path from 'node:path';
import { parseClaudeShaped } from './claude.mjs';
import denyOnce from './deny-once.mjs';

const NOTHING = '{}\n';
/** Its own two edit tools: a write of a whole file, and a replace in one. */
const EDIT_TOOLS = new Set(['write_file', 'replace']);
/** Gemini CLI's own name for each event that can carry context for the model. */
const CONTEXT_EVENTS = { prompt: 'BeforeAgent', session_start: 'SessionStart' };
/**
 * Where what Gemini CLI added to a prompt starts: files the person named with
 * @ (core/src/utils/constants.ts REFERENCE_CONTENT_START), and its note about
 * agents they picked (cli/src/ui/hooks/atCommandProcessor.ts). The prompt
 * BeforeAgent sends has them in it; only what the person typed is theirs.
 */
const ADDED_TO_PROMPT = ['--- Content from referenced files ---', '<system_note>'];

/** What the person typed, without the files and notes Gemini CLI put after it. */
function typed(prompt) {
  const cut = Math.min(...ADDED_TO_PROMPT.map((marker) => prompt.indexOf(marker)).filter((at) => at !== -1), prompt.length);
  return prompt.slice(0, cut).trimEnd();
}

/**
 * The call an AfterTool reports, as the edit that happened: none when the
 * tool failed (AfterTool fires for those too), the file it says it wrote
 * (returnDisplay.filePath: absolute, after its own path correction) when it
 * says one, and a replace that made a new file as the write it was.
 */
function editDone(input) {
  const response = isObject(input.tool_response) ? input.tool_response : {};
  if (response.error) return null;
  const args = isObject(input.tool_input) ? { ...input.tool_input } : {};
  const display = response.returnDisplay;
  if (isObject(display) && typeof display.filePath === 'string' && path.isAbsolute(display.filePath)) args.file_path = display.filePath;
  if (input.tool_name === 'replace' && args.old_string === '' && typeof args.new_string === 'string') {
    return { ...input, tool_name: 'write_file', tool_input: { file_path: args.file_path, content: args.new_string } };
  }
  return { ...input, tool_input: args };
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Gemini CLI's payload as normalized input (see agent_hook.mjs), by way of Claude Code's shape, which it shares. */
function parse(event, input, context) {
  if (!isObject(input)) return null;
  let call = input;
  if (event === 'post_edit' && EDIT_TOOLS.has(input.tool_name)) {
    call = editDone(input);
    if (!call) return { session_id: input.session_id, cwd: input.cwd, files: [] };
  }
  if (event === 'prompt' && typeof input.prompt === 'string') call = { ...input, prompt: typed(input.prompt) };
  return parseClaudeShaped(event, call, context);
}

/** What the script waited for said (Claude Code's hook JSON), as Gemini CLI's answer for `event`. */
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

/** deny-once's answer when it refuses, as a refusal and nothing else; null when it lets the call go on. */
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
  name: 'gemini',
  // its tools' names (core/src/tools/definitions/base-declarations.ts): the
  // matchers send only the edits and the shell here, and the rest are named so
  // a read is never taken for an edit when a matcher is left off by hand
  tools: {
    write: ['write_file'],
    edit: ['replace'],
    command: ['run_shell_command'],
    read: [
      'read_file',
      'read_many_files',
      'list_directory',
      'glob',
      'grep_search',
      'search_file_content',
      'google_web_search',
      'web_fetch',
      'save_memory',
      'write_todos',
      'get_internal_docs',
      'activate_skill',
      'ask_user',
    ],
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
