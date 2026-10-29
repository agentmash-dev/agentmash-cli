// Cline's hooks, read and answered: the VS Code extension
// (saoudrizwan.claude-dev, 4.1.11 on) and the Cline CLI (3.0.56 on), which
// both run an executable file named after the event from
// ~/Documents/Cline/Hooks (cli/agents/cline.mjs writes ours), with one JSON
// object on stdin, and read one JSON object back from stdout. The two
// runners send the same thing in two shapes (cline/cline v4.1.22 and
// cli-v3.0.68, apps/vscode/src/sdk/hooks-adapter.ts and
// sdk/packages/core/src/hooks/hook-file-hooks.ts):
//
//   VS Code  { hookName: "PreToolUse", taskId, workspaceRoots,
//              preToolUse: { toolName, parameters } }
//            every parameter a string (anything else JSON.stringify'd, a null
//            "null"), and, being proto3 JSON, any field left at its default
//            left out: no `parameters` when there are none, no `success` when
//            it is false.
//   CLI      { hookName: "tool_call", taskId, sessionContext: { rootSessionId },
//              workspaceRoots, tool_call: { id, name, input }, preToolUse }
//            `input` as the model sent it. After the tool, "tool_result",
//            with tool_result { input, output, error } beside postToolUse.
//
// UserPromptSubmit carries userPromptSubmit.prompt. VS Code runs it before
// every turn; the CLI ("prompt_submit") only for a message queued during a
// run, never for a prompt typed at it, and reads nothing it prints.
//
// What Cline does with the answer decides what this says:
//
//   - {"cancel":false,"contextModification":"…"} adds the text to what the
//     model reads, but only once the tool calls of that reply have run: so
//     the advice before an edit reaches the agent for its next step, after
//     the edit, and says so.
//   - {"cancel":true} refuses no single call. It stops the whole run, and its
//     reason goes to the person, never to the model. So nothing here ever
//     cancels, the room's strict mode included: strict mode's advice goes as
//     advice, without its "make the same edit again", which would repeat an
//     edit that has already run.
//   - a hook cannot approve anything in Cline, and nothing here tries.
//   - every answer is a JSON object, {"cancel":false} when there is nothing
//     to say: VS Code logs a warning for a hook that prints none.
//
// Cline's tools (sdk/packages/core/src/extensions/tools): `editor` ({path,
// old_text?, new_text, insert_line?}: replace old_text, insert before
// insert_line, or create the file) and `apply_patch` ({input: patch} or the
// patch alone) change files; `run_commands` runs shell commands, whose
// changes the working tree shows afterwards; write_to_file, replace_in_file
// and delete_file are older names VS Code still counts as edits. Anything
// else, a read, a search, an MCP tool, names no file it changes: nothing is
// asked before it and nothing is reported after it.
//
// After a tool, only a call that went through is reported. A rejected one
// comes with success false (left out, in VS Code). An edit that failed (its
// old_text was not in the file) comes as a success whose output says
// success: false, which the CLI hands on and VS Code does not (its `result`
// is "[object Object]"), so in VS Code such an edit is reported as tried.

import path from 'node:path';

/** What every answer is at least: go on, nothing to add. */
const NEUTRAL = '{"cancel":false}\n';
/** Cline cuts a hook's context at 50,000 characters; ours stays well inside. */
const MAX_CONTEXT = 49_000;

/** Which of Cline's hooks each of our events is, in each runner. */
const HOOK_NAMES = {
  pre_edit: ['PreToolUse', 'tool_call'],
  post_edit: ['PostToolUse', 'tool_result'],
  prompt: ['UserPromptSubmit', 'prompt_submit'],
};

/** Cline's tool names by what they do, v4's and the older ones VS Code still counts as edits. */
const TOOLS = {
  edit: ['editor', 'replace_in_file'],
  write: ['write_to_file'],
  patch: ['apply_patch'],
  command: ['run_commands'],
  read: ['read_files', 'search_codebase', 'fetch_web_content'],
};

/** Where strict mode's own instructions start, after the advice (lib.mjs, buildStrictBlock). */
const STRICT_MARK = '\n\nAgentMash strict mode blocked this edit.';

const AFTER_THE_EDIT =
  "AgentMash checked this just before your edit, and Cline passes a hook's note on only after the tool call, so the edit" +
  ' was not held back for it. Look at the file as it is now before you change it again.';
const AFTER_THE_EDIT_STRICT =
  'This room asks for an edit like this to wait until the collision is acknowledged, and Cline cannot hold back one edit,' +
  ' so yours was not stopped. Look at the file as it is now, and tell the user about the collision before you change it again.';

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' && v ? v : undefined);
const usablePath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 4096 && !/[\r\n\0]/.test(p);

/**
 * The session, and where it works: the CLI's root session for a subagent's
 * call, so a team of agents is one session; the first workspace root, which
 * is where Cline resolves a relative path (else where the hook was started).
 */
function whereOf(input) {
  const roots = (Array.isArray(input.workspaceRoots) ? input.workspaceRoots : []).filter((r) => typeof r === 'string' && path.isAbsolute(r));
  const info = input.workspaceInfo?.rootPath;
  const base = roots[0] ?? (typeof info === 'string' && path.isAbsolute(info) ? info : process.cwd());
  const n = { session_id: text(input.sessionContext?.rootSessionId) ?? text(input.taskId), cwd: base };
  // a subagent's own id, as Claude Code's subagents send theirs
  if (text(input.parent_agent_id) && text(input.agent_id)) n.agent_id = input.agent_id;
  return { n, roots, base };
}

/** The workspace root a file is in (the innermost), else the base. */
const rootOf = (file, roots, base) => roots.filter((r) => file === r || file.startsWith(r.endsWith(path.sep) ? r : r + path.sep)).sort((a, b) => b.length - a.length)[0] ?? base;

/**
 * The tool's input: the CLI's, as the model sent it, or else VS Code's
 * parameters, every one a string. `strings` says which.
 */
function inputOf(call, data) {
  if (isObject(call) && 'input' in call) return { value: call.input, strings: false };
  return { value: isObject(data?.parameters) ? data.parameters : {}, strings: true };
}

/** A value the model left out: missing, null, or VS Code's "null" for one. */
const absent = (v, strings) => v === undefined || v === null || (strings && v === 'null');

/** What one of Cline's tool calls changes, as normalized input: { files } or { patch } or { command }, or null. */
function changeOf(tool, { value, strings }, event) {
  if (tool === 'apply_patch') {
    const patch = typeof value === 'string' ? value : text(value?.input);
    return patch ? { patch } : null;
  }
  if (tool === 'run_commands') {
    if (event !== 'post_edit') return null;
    // the working tree says what a command changed; its words are only kept
    const command = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return { command: command.slice(0, 2000) };
  }
  if (!isObject(value) || !usablePath(value.path)) return null;
  const file = { path: value.path };
  const after = typeof value.new_text === 'string' ? value.new_text : undefined;
  if (tool === 'editor') {
    if (!absent(value.insert_line, strings)) {
      // lines put in before insert_line: an edit that removes nothing
      file.before = '';
      if (after !== undefined) file.after = after;
    } else if (!absent(value.old_text, strings) && typeof value.old_text === 'string') {
      file.before = value.old_text;
      if (after !== undefined) file.after = after;
    } else if (after !== undefined) {
      // no old_text: the file made with new_text
      file.after = after;
      file.action = 'write';
    }
    return { files: [file] };
  }
  if (tool === 'write_to_file') {
    if (typeof value.content === 'string') Object.assign(file, { after: value.content, action: 'write' });
    return { files: [file] };
  }
  if (tool === 'replace_in_file') return { files: [file] };
  if (tool === 'delete_file') return { files: [{ ...file, action: 'delete' }] };
  return null;
}

/** Whether a call reported after it ran did not go through: rejected, refused, or failed. */
function didNotGoThrough(input) {
  const data = isObject(input.postToolUse) ? input.postToolUse : {};
  const record = input.tool_result;
  if (isObject(record)) {
    // the CLI: an error, or the tool's own output saying it failed
    if (record.error || data.success === false) return true;
    let output = record.output;
    if (!isObject(output) && typeof data.result === 'string') {
      try {
        output = JSON.parse(data.result);
      } catch {
        output = null;
      }
    }
    return isObject(output) && output.success === false;
  }
  // VS Code: proto3 leaves success out when it is false
  return data.success !== true;
}

/** Cline's hook input as normalized input (see agent_hook.mjs); null when there is nothing in it for us. */
export function parseCline(event, input, { lib = null } = {}) {
  if (!isObject(input) || !HOOK_NAMES[event]) return null;
  if (typeof input.hookName === 'string' && input.hookName && !HOOK_NAMES[event].includes(input.hookName)) return null;
  const { n, roots, base } = whereOf(input);

  if (event === 'prompt') {
    const prompt = input.userPromptSubmit?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) return null;
    // the CLI's own reminders come in as user messages ("[SYSTEM] This run is not complete…"), and before
    // 3.0.63 so did what hooks add, ours among it ("<hook_context source=…>"): neither is the person's prompt
    if (/^\s*(?:\[SYSTEM\]|<hook_context[\s>])/.test(prompt)) return null;
    return { ...n, prompt };
  }

  const pre = event === 'pre_edit';
  const data = pre ? input.preToolUse : input.postToolUse;
  const call = pre ? input.tool_call : input.tool_result;
  const tool = text(isObject(call) ? call.name : undefined) ?? text(data?.toolName);
  if (!tool) return null;
  if (!pre && didNotGoThrough(input)) return null;
  const change = changeOf(tool, inputOf(call, data), event);
  if (!change) return { ...n, tool, files: [] };

  // a path as Cline resolves it: against the first workspace root
  const files = (change.files ?? []).map((f) => ({ ...f, path: path.resolve(base, f.path) }));
  const first = files[0]?.path ?? (change.patch ? lib?.filesInPatch?.(change.patch)?.[0]?.path : undefined);
  const cwd = typeof first === 'string' && path.isAbsolute(first) ? rootOf(first, roots, base) : base;
  return { ...n, cwd, tool, files, ...(change.patch ? { patch: change.patch } : {}), ...(change.command !== undefined ? { command: change.command } : {}) };
}

/** The advice before an edit, as it reaches the agent after the edit: strict mode's instructions left out. */
function afterTheEdit(result) {
  if (result.action !== 'deny') return `${result.text}\n\n${AFTER_THE_EDIT}`;
  const at = result.text.indexOf(STRICT_MARK);
  // strict mode's wording changed: its first line, the tag and who, and nothing that says to edit again
  const advice = at > 0 ? result.text.slice(0, at) : result.text.split('\n')[0];
  return `${advice}\n\n${AFTER_THE_EDIT_STRICT}`;
}

const say = (context) => ({
  stdout: JSON.stringify({ cancel: false, contextModification: context.length > MAX_CONTEXT ? `${context.slice(0, MAX_CONTEXT)}…` : context }) + '\n',
});

export default {
  name: 'cline',
  tools: TOOLS,
  parse: parseCline,
  answer(event, result) {
    const words = typeof result?.text === 'string' && result.text ? result.text : null;
    if (!words) return { stdout: NEUTRAL };
    if (event === 'pre_edit') return say(afterTheEdit({ ...result, text: words }));
    if (event === 'prompt') return say(words);
    return { stdout: NEUTRAL };
  },
  neutral() {
    return { stdout: NEUTRAL };
  },
};
