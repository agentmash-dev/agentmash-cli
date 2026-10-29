// What OpenHands writes to a command hook's stdin around a tool call, as the
// OpenHands Software Agent SDK does it: the SDK runs the hooks for both the
// OpenHands CLI (1.16.0, on SDK 1.21.0) and Agent Canvas (1.24.0, on its
// agent-server, SDK 1.49.6). Recorded from the SDK's source:
//
//   - the envelope: HookEvent.model_dump_json() (openhands-sdk/openhands/sdk/
//     hooks/types.py at v1.51.0, the same fields at v1.21.0): every field, in
//     declaration order, null ones included. No tool-call id, no timestamp.
//     session_id is str(the conversation's UUID); working_dir the workspace.
//   - tool_input: action.model_dump(), with the computed `kind` (hooks/
//     conversation_hooks.py, _handle_pre_tool_use / _handle_post_tool_use)
//   - tool_response: observation.model_dump(), after the tool ran; PostToolUse
//     fires for a tool that failed too (is_error true), never for an action a
//     hook refused
//   - the tools' fields: openhands-tools/openhands/tools/file_editor/
//     definition.py (FileEditorAction / FileEditorObservation), gemini/edit
//     and gemini/write_file/definition.py, apply_patch/definition.py, at
//     v1.51.0. Each tool's name is its class name in snake case less _tool
//     (sdk/tool/tool.py): file_editor, planning_file_editor, edit, write_file,
//     apply_patch, terminal.
//   - terminal's fields (command, is_input, timeout, reset) are TerminalAction's
//     as the SDK's terminal tool declares them; only `command` is read.
//
// Each builder takes what differs from one test to the next: the session (a
// test's own; OpenHands' is a UUID) and the folder OpenHands works in. Nothing
// here was captured from a live run (none was possible without a model): the
// shapes are the source's, and checks.json in the research names what a live
// run would still confirm (TextContent's extra fields inside `content`).

const envelope = (event_type, { session_id, working_dir, tool_name = null, tool_input = null, tool_response = null, message = null }) => ({
  event_type,
  tool_name,
  tool_input,
  tool_response,
  message,
  session_id,
  working_dir,
  metadata: {},
});

/** FileEditorAction as model_dump() writes it: every field, `kind` last. */
const editorAction = ({ command, path, file_text = null, old_str = null, new_str = null, insert_line = null, view_range = null }) => ({
  command,
  path,
  file_text,
  old_str,
  new_str,
  insert_line,
  view_range,
  kind: 'FileEditorAction',
});

/** FileEditorObservation: the whole file before and after (editor.py), and whether it failed. */
const editorObservation = ({ command, path, old_content = null, new_content = null, prev_exist = true, is_error = false, text = '' }) => ({
  content: [{ type: 'text', text }],
  is_error,
  command,
  path,
  prev_exist,
  old_content,
  new_content,
  kind: 'FileEditorObservation',
});

/** PreToolUse before file_editor's str_replace (the default preset's edit): `path` is absolute. */
export const preStrReplace = ({ session_id, working_dir, path, old_str = 'id: string', new_str = 'id: string;\n  role: string', tool_name = 'file_editor' }) =>
  envelope('PreToolUse', { session_id, working_dir, tool_name, tool_input: editorAction({ command: 'str_replace', path, old_str, new_str }) });

/** PreToolUse before file_editor's create: the whole new file in file_text. */
export const preCreate = ({ session_id, working_dir, path, file_text = 'export const b = 2;\n' }) =>
  envelope('PreToolUse', { session_id, working_dir, tool_name: 'file_editor', tool_input: editorAction({ command: 'create', path, file_text }) });

/** PreToolUse before file_editor's insert: new_str goes in after insert_line. */
export const preInsert = ({ session_id, working_dir, path, insert_line = 1, new_str = 'export type Role = string;\n' }) =>
  envelope('PreToolUse', { session_id, working_dir, tool_name: 'file_editor', tool_input: editorAction({ command: 'insert', path, insert_line, new_str }) });

/** PreToolUse before file_editor's view: the matcher sends it here, and it changes nothing. */
export const preView = ({ session_id, working_dir, path, tool_name = 'file_editor' }) =>
  envelope('PreToolUse', { session_id, working_dir, tool_name, tool_input: editorAction({ command: 'view', path, view_range: [1, 40] }) });

/** PreToolUse before the gemini preset's `edit`: file_path, relative to the workspace when the model says so. */
export const preGeminiEdit = ({ session_id, working_dir, file_path, old_string = 'id: string', new_string = 'id: string; role: string' }) =>
  envelope('PreToolUse', {
    session_id,
    working_dir,
    tool_name: 'edit',
    tool_input: { file_path, old_string, new_string, expected_replacements: 1, kind: 'EditAction' },
  });

/** PreToolUse before the gpt5 preset's `apply_patch`: only the patch, its paths relative to the workspace. */
export const preApplyPatch = ({ session_id, working_dir, patch }) =>
  envelope('PreToolUse', { session_id, working_dir, tool_name: 'apply_patch', tool_input: { patch, kind: 'ApplyPatchAction' } });

/** PreToolUse before `terminal`: what a hook registered by hand without a matcher would see. */
export const preTerminal = ({ session_id, working_dir, command = "sed -i '' s/id/key/ src/models/user.ts" }) =>
  envelope('PreToolUse', {
    session_id,
    working_dir,
    tool_name: 'terminal',
    tool_input: { command, is_input: false, timeout: null, reset: false, kind: 'TerminalAction' },
  });

/** PostToolUse after a str_replace that worked: tool_response has the file before and after. */
export const postStrReplace = ({ session_id, working_dir, path, old_str, new_str, before, after, is_error = false }) =>
  envelope('PostToolUse', {
    session_id,
    working_dir,
    tool_name: 'file_editor',
    tool_input: editorAction({ command: 'str_replace', path, old_str, new_str }),
    tool_response: editorObservation({
      command: 'str_replace',
      path,
      old_content: is_error ? null : before,
      new_content: is_error ? null : after,
      is_error,
      text: is_error ? `ERROR:\nNo replacement was performed, old_str \`${old_str}\` did not appear verbatim in ${path}.` : `The file ${path} has been edited.`,
    }),
  });

/** PostToolUse after a create: prev_exist false for a new file. */
export const postCreate = ({ session_id, working_dir, path, file_text }) =>
  envelope('PostToolUse', {
    session_id,
    working_dir,
    tool_name: 'file_editor',
    tool_input: editorAction({ command: 'create', path, file_text }),
    tool_response: editorObservation({ command: 'create', path, old_content: null, new_content: file_text, prev_exist: false, text: `File created successfully at: ${path}` }),
  });

/** PostToolUse after a view: nothing changed. */
export const postView = ({ session_id, working_dir, path, content }) =>
  envelope('PostToolUse', {
    session_id,
    working_dir,
    tool_name: 'file_editor',
    tool_input: editorAction({ command: 'view', path }),
    tool_response: editorObservation({ command: 'view', path, text: content }),
  });

/** PostToolUse after the gemini preset's write_file. */
export const postWriteFile = ({ session_id, working_dir, file_path, content, is_new_file = true }) =>
  envelope('PostToolUse', {
    session_id,
    working_dir,
    tool_name: 'write_file',
    tool_input: { file_path, content, kind: 'WriteFileAction' },
    tool_response: {
      content: [{ type: 'text', text: `Successfully wrote to ${file_path}` }],
      is_error: false,
      file_path,
      is_new_file,
      old_content: null,
      new_content: content,
      kind: 'WriteFileObservation',
    },
  });

/** PostToolUse after the gemini preset's edit; old_string "" makes a new file (its definition.py). */
export const postGeminiEdit = ({ session_id, working_dir, file_path, old_string, new_string, resolved = null, is_error = false }) =>
  envelope('PostToolUse', {
    session_id,
    working_dir,
    tool_name: 'edit',
    tool_input: { file_path, old_string, new_string, expected_replacements: 1, kind: 'EditAction' },
    tool_response: {
      content: [{ type: 'text', text: is_error ? 'Error: old_string not found' : `Successfully edited ${file_path}` }],
      is_error,
      file_path: resolved ?? file_path,
      is_new_file: old_string === '',
      replacements_made: is_error ? 0 : 1,
      old_content: null,
      new_content: null,
      kind: 'EditObservation',
    },
  });

/** PostToolUse after apply_patch: the patch, and the tool's own account of it. */
export const postApplyPatch = ({ session_id, working_dir, patch }) =>
  envelope('PostToolUse', {
    session_id,
    working_dir,
    tool_name: 'apply_patch',
    tool_input: { patch, kind: 'ApplyPatchAction' },
    tool_response: { content: [{ type: 'text', text: 'Done!' }], is_error: false, message: 'Done!', fuzz: 0, commit: null, kind: 'ApplyPatchObservation' },
  });

/** PostToolUse after `terminal`: a command names no file; the working tree says what it changed. */
export const postTerminal = ({ session_id, working_dir, command = 'npm run build' }) =>
  envelope('PostToolUse', {
    session_id,
    working_dir,
    tool_name: 'terminal',
    tool_input: { command, is_input: false, timeout: null, reset: false, kind: 'TerminalAction' },
    tool_response: { content: [{ type: 'text', text: '' }], is_error: false, command, exit_code: 0, kind: 'TerminalObservation' },
  });
