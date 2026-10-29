// Kiro's hooks, read and answered: the Kiro IDE (1.x) and kiro-cli on its V3
// engine, which run every file in ~/.kiro/hooks (cli/agents/kiro.mjs writes
// ours). Each hook gets one JSON object on stdin, snake_case:
//
//   { session_id: "sess_<uuid>", hook_event_name: "PreToolUse", cwd,
//     tool_name, tool_input, tool_response?, prompt? }
//
// and the answer is read from how the hook exits, not from what it prints:
//
//   PreToolUse   exit 0 lets the tool run, as it would have without the hook
//                (Kiro's own approval card still comes after it); exit 2
//                refuses it, and the model is told what is on STDERR. Nothing
//                on stdout reaches the model at all: measured on IDE 1.1.14,
//                where even {"decision":"block"} and permissionDecision did
//                nothing, and said in kiro-cli's docs. Any other exit lets the
//                tool run and shows stderr to the person as a warning.
//   UserPromptSubmit, SessionStart   what exit 0 prints is added to the
//                model's context, as text.
//   anything else  stdout is thrown away.
//
// So Kiro cannot be told about a teammate before an edit and still make it:
// the advice goes as a refusal of the agent's first try at a file, with the
// advice as the reason, and the same edit tried again goes through (the
// deny-once dialect's bookkeeping, said Kiro's way: stderr and exit 2). The
// model reads the refusal as the tool's result and carries on with its turn.
// Before a prompt, the heads-up about who is at work goes in as plain text.
// Nothing here ever prints on stdout before a tool: kiro-cli's V3 engine keeps
// an undocumented ask/continue result per hook, and an answer it might read as
// one is not ours to give.
//
// The tools are Kiro's (kiro.dev/docs/tools.md). Its writes are fs_write
// ({path, text}: create or overwrite), fs_append ({path, text}), str_replace
// ({path, oldStr, newStr}) and delete_file ({targetFile}); anything else, a
// read, a shell command, an MCP tool ("@server/tool") or Kiro's background
// `memory`, names no file it changes, so nothing is asked and nothing is
// reported. Some IDE builds (1.0.165, 1.0.242) send a write's tool_input empty
// after it ran, and say which file only in tool_response's prose, so the path
// is read from there when it is nowhere else. kiro-cli's V2 engine, inherited
// from the Amazon Q CLI, sends fs_write as {command: create | str_replace |
// insert | append, path, file_text | old_str/new_str}: read too, though login
// registers nothing that engine is known to run.

import denyOnce from './deny-once.mjs';

/** Kiro's tool names by what they do (kiro.dev/docs/tools.md, with the aliases it lists). */
const TOOLS = {
  write: ['fs_write', 'write'],
  edit: ['str_replace', 'fs_append', 'delete_file'],
  read: ['read_file', 'fs_read', 'read_files', 'list_directory', 'file_search', 'glob', 'grep_search', 'grep', 'code', 'read_code'],
  command: ['execute_bash', 'shell', 'execute_cmd', 'execute_pwsh'],
};

/** Where each write's tool_response names its file, when its tool_input does not (IDE 1.0.x, workspace-relative). */
const SAID_DONE = {
  fs_write: /^Created the (.+) file\.$/,
  str_replace: /^Replaced text in (.+?)(?: \(\d+ occurrences?\))?\.?$/,
  fs_append: /^Appended the text to the (.+) file\.$/,
};

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const firstString = (...values) => values.find((v) => typeof v === 'string');

/** The file a write's input names: `path`, or delete_file's `targetFile`. */
const pathIn = (args) => firstString(args.path, args.targetFile, args.target_file, args.file_path, args.filePath);

/** One write's file, as normalized input's `files` entry (see agent_hook.mjs), from its input; null when it names none. */
function fileFrom(tool, args) {
  const file = pathIn(args);
  if (!file) return null;
  if (tool === 'delete_file') return { path: file, action: 'delete' };
  // an append adds to the end of the file, and replaces nothing in it
  if (tool === 'fs_append') return { path: file, before: '', after: firstString(args.text, args.content) ?? '', action: 'edit' };
  const before = firstString(args.oldStr, args.old_str);
  const after = firstString(args.newStr, args.new_str);
  const replaced = { path: file, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}), action: 'edit' };
  if (tool === 'str_replace' || args.command === 'str_replace') return replaced;
  // fs_write: V2's insert and append add text; V2's TUI may send a replacement; else the whole new file
  if (args.command === 'insert' || args.command === 'append') return { path: file, before: '', after: after ?? '', action: 'edit' };
  if (before !== undefined) return replaced;
  const text = firstString(args.text, args.file_text, args.content);
  return text !== undefined ? { path: file, after: text, action: 'write' } : { path: file };
}

/** The file a write's tool_response says it changed, from its prose; null when it says no such thing. */
function fileFromProse(tool, response) {
  if (typeof response !== 'string') return null;
  const named = SAID_DONE[tool]?.exec(response.trim())?.[1];
  return named ? { path: named } : null;
}

/** The files one of Kiro's tool calls changes, as normalized input's `files`: [] for anything but a write. */
function filesOf(event, input) {
  if (![...TOOLS.write, ...TOOLS.edit].includes(input.tool_name)) return [];
  const tool = input.tool_name === 'write' ? 'fs_write' : input.tool_name;
  // a write that failed changed nothing (V2 says so; the IDE only in prose, which is not read for it)
  if (event === 'post_edit' && isObject(input.tool_response) && input.tool_response.success === false) return [];
  const args = isObject(input.tool_input) ? input.tool_input : {};
  const file = fileFrom(tool, args) ?? (event === 'post_edit' ? fileFromProse(tool, input.tool_response) : null);
  return file ? [file] : [];
}

/** Kiro's hook input as normalized input (see agent_hook.mjs); null when it is not one. */
function parse(event, input) {
  if (!isObject(input)) return null;
  const n = { session_id: input.session_id, cwd: input.cwd, tool: input.tool_name };
  if (event === 'prompt') n.prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (event === 'pre_edit' || event === 'post_edit') n.files = filesOf(event, input);
  return n;
}

/** deny-once's answer before an edit, said Kiro's way: its refusal's reason on stderr and exit 2, else nothing at all. */
function beforeEdit(result) {
  let said = null;
  try {
    said = JSON.parse(denyOnce.answer('pre_edit', result).stdout);
  } catch {
    // nothing it said is a refusal
  }
  if (said?.decision === 'deny' && typeof said.reason === 'string' && said.reason) {
    return { stdout: '', stderr: `${said.reason}\n`, exitCode: 2 };
  }
  return { stdout: '' };
}

export default {
  name: 'kiro',
  tools: TOOLS,
  parse,
  answer(event, result) {
    if (event === 'pre_edit') return beforeEdit(result);
    // what goes into the model's context: the heads-up before a prompt, as text
    if ((event === 'prompt' || event === 'session_start') && typeof result?.text === 'string' && result.text) {
      return { stdout: `${result.text}\n` };
    }
    return { stdout: '' };
  },
  neutral() {
    return { stdout: '' };
  },
};
