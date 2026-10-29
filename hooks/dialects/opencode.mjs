// OpenCode's dialect. OpenCode has no command hooks: it runs JS plugins in its
// own process, and `npx agentmash login` writes one at user level
// (~/.config/opencode/plugin/agentmash.js, see cli/agents/opencode.mjs). That
// plugin hands each of OpenCode's hook calls to agent_hook.mjs as it came,
// in an envelope, and reads back the answer this dialect gives:
//
//   {
//     "opencode": 1,
//     "hook": "tool.execute.before" | "tool.execute.after" | "chat.message"
//             | "session.deleted" | "dispose",
//     "directory": "/abs",   the plugin's PluginInput.directory: where OpenCode
//                            works, and what a relative path in a call is under
//     "root": "ses_…",       optional: the session a subagent's session (the
//                            task tool's) was started from, at the top
//     "input": {…},          the hook's input as OpenCode passed it: { tool,
//                            sessionID, callID, args? } for a tool, { sessionID,
//                            agent? } for a message, { sessionID } at an end
//     "output": {…}          before a tool, { args }; for a message, its text
//                            parts ({ type, text, synthetic?, ignored? }) and
//                            message.sessionID (OpenCode 1.0.0 sent an empty input)
//   }
//
// Its tools (OpenCode 1.18.34, packages/opencode/src/tool): `edit` { filePath,
// oldString, newString, replaceAll? }, `write` { filePath, content }, and for
// GPT models in their place `apply_patch` { patchText }, whose files are named
// only inside the patch; `bash` { command, workdir? } names none. Each goes on
// to the scripts as the Claude Code call it is (Edit, Write, apply_patch,
// Bash), so the room is told "opencode:Edit" and so on. Any other tool (a
// read, a search, an MCP server's) names no file it changes, whatever its
// arguments say, and is asked about and reported by nobody.
//
// A plugin can add nothing to a call it lets through before it runs: what a
// tool.execute.before hook returns is ignored. It can refuse the call, by
// throwing, and the model reads the error as the tool's result and goes on
// with its turn (session/processor.ts, failToolCall). So the advice before an
// edit is deny-once's: the first try refused with the advice as the reason,
// the same edit again let through. Anything else deny-once says ({}, no
// opinion) is the plugin returning, which leaves the call to OpenCode's own
// permission rules: it grants nothing.

import path from 'node:path';
import denyOnce from './deny-once.mjs';

/** Paths past this are not a file's. */
const MAX_PATH = 4096;

const text = (value, max = 200) => (typeof value === 'string' && value && value.length <= max ? value : undefined);
const usablePath = (p) => typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH && !/[\r\n\0]/.test(p);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The edit fields of normalized input (agent_hook.mjs), from one of
 * OpenCode's tool calls, at `cwd`: `cwd` itself changes for a command run in
 * a `workdir` of its own.
 */
function editOf(tool, args, cwd) {
  if (!isObject(args)) return { files: [] };
  if (tool === 'edit' && usablePath(args.filePath)) {
    const input = { file_path: args.filePath };
    if (typeof args.oldString === 'string') input.old_string = args.oldString;
    if (typeof args.newString === 'string') input.new_string = args.newString;
    if (args.replaceAll === true) input.replace_all = true;
    return { files: [args.filePath], call: { tool_name: 'Edit', tool_input: input } };
  }
  if (tool === 'write' && usablePath(args.filePath)) {
    const input = { file_path: args.filePath };
    if (typeof args.content === 'string') input.content = args.content;
    return { files: [args.filePath], call: { tool_name: 'Write', tool_input: input } };
  }
  if (tool === 'apply_patch' && typeof args.patchText === 'string' && args.patchText) return { files: [], patch: args.patchText };
  if (tool === 'bash' && typeof args.command === 'string') {
    const out = { files: [], command: args.command };
    if (usablePath(args.workdir) && cwd) out.cwd = path.resolve(cwd, args.workdir);
    return out;
  }
  return { files: [] };
}

/** What the person typed: the message's own text parts, never one OpenCode added (synthetic) or left out (ignored). */
function promptOf(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => isObject(p) && p.type === 'text' && typeof p.text === 'string' && p.synthetic !== true && p.ignored !== true)
    .map((p) => p.text)
    .join('\n');
}

/** The plugin's envelope (above) as normalized input; null when it is not one, or holds nothing to act on. */
export function parseOpencode(event, envelope) {
  if (!isObject(envelope) || envelope.opencode !== 1) return null;
  const input = isObject(envelope.input) ? envelope.input : {};
  const output = isObject(envelope.output) ? envelope.output : {};
  const session = text(input.sessionID) ?? text(output.message?.sessionID);
  const root = text(envelope.root);
  const cwd = typeof envelope.directory === 'string' && path.isAbsolute(envelope.directory) ? envelope.directory : undefined;
  const n = { session_id: root ?? session, cwd };
  // a subagent's call goes on as Claude Code's do: the session it is part of, and itself
  if (root && session && session !== root) n.agent_id = session;
  const tool = text(input.tool, 60);
  if (tool) n.tool = tool;

  if (event === 'pre_edit' || event === 'post_edit') {
    // before a call its arguments are in the output, which a plugin may change; after it, in the input
    const args = event === 'pre_edit' ? (output.args ?? input.args) : (input.args ?? output.args);
    return { ...n, ...editOf(tool, args, cwd) };
  }
  if (event === 'prompt') {
    // a subagent's prompt is the task its parent wrote for it, not the person's
    if (n.agent_id) return null;
    const prompt = promptOf(output.parts);
    return prompt.trim() ? { ...n, prompt } : null;
  }
  if (event === 'session_end') return { ...n, end_reason: envelope.hook === 'dispose' ? 'exit' : 'other' };
  return n;
}

export default {
  name: 'opencode',
  // OpenCode 1.18.34's tool ids (packages/opencode/src/tool/*.ts): what each
  // does to files, for lib.mjs (registerClientTools) when it reads a call as
  // OpenCode's. read lists the ones that only look.
  tools: {
    edit: ['edit'],
    write: ['write'],
    patch: ['apply_patch'],
    command: ['bash'],
    read: ['read', 'glob', 'grep', 'lsp', 'webfetch', 'websearch', 'skill', 'task', 'todowrite', 'question', 'plan_exit', 'invalid'],
  },
  parse: parseOpencode,
  answer: denyOnce.answer,
  neutral: denyOnce.neutral,
};
