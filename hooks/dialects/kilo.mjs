// Kilo Code's dialect. Kilo Code (the `kilo` CLI, and the VS Code and
// JetBrains extensions, which all run the same `kilo serve` backend, a fork
// of OpenCode) has no command hooks: it runs JS plugins in its own process.
// `npx agentmash login` writes one at user level (~/.config/kilo/agentmash.js,
// named in Kilo's global config, see cli/agents/kilo.mjs). That plugin hands
// each of Kilo's hook calls to agent_hook.mjs as it came, in an envelope, and
// reads back the answer this dialect gives:
//
//   {
//     "kilo": 1,
//     "hook": "tool.execute.before" | "tool.execute.after" | "chat.message"
//             | "session.deleted" | "dispose",
//     "directory": "/abs",   the plugin's PluginInput.directory: where Kilo
//                            works, and what a relative path in a call is under
//     "root": "ses_…",       optional: the session a subagent's session (the
//                            task tool's) was started from, at the top
//     "input": {…},          the hook's input as Kilo passed it: { tool,
//                            sessionID, callID, args? } for a tool, { sessionID,
//                            agent? } for a message, { sessionID } at an end
//     "output": {…}          before a tool, { args }; for a message, its text
//                            parts ({ type, text, synthetic?, ignored? }) and
//                            message.sessionID
//   }
//
// Its tools that change files (Kilo 7.8.3, packages/opencode/src/tool and
// src/kilocode/tool): `edit` { filePath, oldString, newString, replaceAll? },
// `write` { filePath, content }, and for GPT models in place of edit
// `apply_patch` { patchText }, whose files are named only inside the patch;
// with VS Code's native notebook tools switched on, `notebook_edit` { path,
// action, … }, which changes one cell of a notebook and names no text. `bash`
// { command, workdir? } names none. Each goes on to the scripts as the Claude
// Code call it is (Edit, Write, apply_patch, Bash), so the room is told
// "kilo:Edit" and so on. Any other tool (a read, a search, an MCP server's,
// one of Kilo's own) names no file it changes, whatever its arguments say,
// and is asked about and reported by nobody.
//
// Kilo hands a plugin a call's arguments before it checks them against the
// tool's schema, and refuses a malformed call itself (tool/tool.ts, as an
// InvalidArgumentsError, which it counts toward giving up on the model). A
// refusal of ours is a plain Error, which Kilo does not count, and which
// would restart that count: so a call that is not what its tool takes is
// never asked about, and goes on to be refused by Kilo alone.
//
// A plugin can add nothing to a call it lets through before it runs: what a
// tool.execute.before hook returns is ignored. It can refuse the call, by
// throwing, and the model reads the error as the tool's result and goes on
// with its turn (session/processor.ts, failToolCall; only a person's refusal
// or a question dismissed stops the turn). So the advice before an edit is
// deny-once's: the first try refused with the advice as the reason, the same
// edit again let through. Anything else deny-once says ({}, no opinion) is
// the plugin returning, which leaves the call to Kilo's own permission rules,
// asked after the plugin: it grants nothing.

import path from 'node:path';
import denyOnce from './deny-once.mjs';

/** Paths past this are not a file's. */
const MAX_PATH = 4096;
/** What notebook_edit does to a notebook (kilocode/tool/notebook-host.ts, EditParams). */
const NOTEBOOK_ACTIONS = new Set(['insert', 'replace', 'delete', 'create']);

const text = (value, max = 200) => (typeof value === 'string' && value && value.length <= max ? value : undefined);
const usablePath = (p) => typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH && !/[\r\n\0]/.test(p);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The edit fields of normalized input (agent_hook.mjs), from one of Kilo's
 * tool calls, at `cwd`: `cwd` itself changes for a command run in a `workdir`
 * of its own. A call whose arguments are not what its tool takes names nothing.
 */
function editOf(tool, args, cwd) {
  if (!isObject(args)) return { files: [] };
  if (tool === 'edit') {
    const { filePath, oldString, newString, replaceAll } = args;
    if (!usablePath(filePath) || typeof oldString !== 'string' || typeof newString !== 'string') return { files: [] };
    if (replaceAll !== undefined && typeof replaceAll !== 'boolean') return { files: [] };
    const input = { file_path: filePath, old_string: oldString, new_string: newString };
    if (replaceAll === true) input.replace_all = true;
    return { files: [filePath], call: { tool_name: 'Edit', tool_input: input } };
  }
  if (tool === 'write') {
    if (!usablePath(args.filePath) || typeof args.content !== 'string') return { files: [] };
    return { files: [args.filePath], call: { tool_name: 'Write', tool_input: { file_path: args.filePath, content: args.content } } };
  }
  if (tool === 'apply_patch') return typeof args.patchText === 'string' && args.patchText ? { files: [], patch: args.patchText } : { files: [] };
  if (tool === 'notebook_edit') {
    if (!usablePath(args.path) || !NOTEBOOK_ACTIONS.has(args.action)) return { files: [] };
    // a cell changed, of a notebook it names: an edit of that file whose size is not known
    return { files: [args.path], call: { tool_name: 'Edit', tool_input: { file_path: args.path } } };
  }
  if (tool === 'bash' && typeof args.command === 'string') {
    const out = { files: [], command: args.command };
    if (usablePath(args.workdir) && cwd) out.cwd = path.resolve(cwd, args.workdir);
    return out;
  }
  return { files: [] };
}

/** What the person typed: the message's own text parts, never one Kilo added (synthetic) or left out (ignored). */
function promptOf(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => isObject(p) && p.type === 'text' && typeof p.text === 'string' && p.synthetic !== true && p.ignored !== true)
    .map((p) => p.text)
    .join('\n');
}

/** The plugin's envelope (above) as normalized input; null when it is not one, or holds nothing to act on. */
export function parseKilo(event, envelope) {
  if (!isObject(envelope) || envelope.kilo !== 1) return null;
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
    // before a call its arguments are in the output; after it, in the input
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
  name: 'kilo',
  // Kilo 7.8.3's tool ids (packages/opencode/src/tool, src/kilocode/tool):
  // what each does to files, for lib.mjs (registerClientTools) when it reads a
  // call as Kilo's. read lists the ones that only look.
  tools: {
    edit: ['edit', 'notebook_edit'],
    write: ['write'],
    patch: ['apply_patch'],
    command: ['bash'],
    read: ['read', 'glob', 'grep', 'lsp', 'webfetch', 'websearch', 'skill', 'task', 'todowrite', 'question', 'plan_exit', 'notebook_read', 'invalid'],
  },
  parse: parseKilo,
  answer: denyOnce.answer,
  neutral: denyOnce.neutral,
};
