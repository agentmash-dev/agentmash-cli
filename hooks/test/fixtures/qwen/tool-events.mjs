// PreToolUse and PostToolUse, as Qwen Code 0.24.7 writes them to a command
// hook's stdin. Recorded from its source at the v0.24.7 tag
// (github.com/QwenLM/qwen-code):
//   - the base fields: packages/core/src/hooks/hookEventHandler.ts,
//     createBaseInput (session_id, transcript_path, cwd = the working dir,
//     hook_event_name, an ISO timestamp, permission_mode; agent_id only in a
//     subagent, prompt_id only inside a prompt's context)
//   - the tool fields: firePreToolUseEvent and firePostToolUseEvent there:
//     permission_mode as the scheduler passes it, which is the raw approval
//     mode ("default", "auto-edit", "yolo", "plan"), tool_name, tool_input,
//     tool_use_id ("toolu_<ms>_<random>"), tool_call_id (the provider's call
//     id), and after the tool tool_response and duration_ms
//   - tool_input: the call's arguments as the tool declares them, after
//     packages/core/src/core/coreToolScheduler.ts makes the path absolute:
//     edit {file_path, old_string, new_string, replace_all?}
//     (packages/core/src/tools/edit.ts EditToolParams), write_file
//     {file_path, content} (write-file.ts), notebook_edit {notebook_path,
//     cell_id?, new_source?, cell_type?, edit_mode?} (notebook-edit.ts),
//     run_shell_command {command, is_background, description?} (shell.ts),
//     read_file {file_path, offset?, limit?} (read-file.ts)
//   - tool_response: { llmContent, returnDisplay } (coreToolScheduler.ts,
//     PostToolUse block), fired only when the tool did not fail. edit and
//     write_file give a FileDiff (packages/core/src/tools/tools.ts):
//     fileDiff a patch with 'Current'/'Proposed' headers for edit and
//     'Original'/'Written' for write_file, fileName the basename, filePath
//     as given, originalContent (null for a file edit made, '' for one
//     write_file made) and newContent; llmContent is the tool's own sentence
//     (edit.ts, write-file.ts). The shell's returnDisplay is its output as
//     text (hookEventHandler.ts normalizeHookDisplayResponse).
// The transcript path, the timestamps, the ids and the shell's output are
// examples of their form, and the session id is a test's own (Qwen Code's is
// a random UUID).

import path from 'node:path';

/** What every event has: createBaseInput's fields, as a session in `cwd` writes them. */
export const base = (cwd, session, hook_event_name, permission_mode = 'default') => ({
  session_id: session,
  transcript_path: `/home/someone/.qwen/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/chats/${session}.jsonl`,
  cwd,
  hook_event_name,
  timestamp: '2026-10-05T09:14:03.512Z',
  permission_mode,
});

/** One PreToolUse payload for `tool_name` with `tool_input`. */
export const preToolUse = (cwd, session, tool_name, tool_input, { permission_mode = 'default' } = {}) => ({
  ...base(cwd, session, 'PreToolUse', permission_mode),
  tool_name,
  tool_input,
  tool_use_id: 'toolu_1759655643512_k3j9x2',
  tool_call_id: 'call_7f3a9c21d4e84b0f',
});

/** One PostToolUse payload: the call, and what the tool returned. */
export const postToolUse = (cwd, session, tool_name, tool_input, tool_response) => ({
  ...base(cwd, session, 'PostToolUse'),
  tool_name,
  tool_input,
  tool_response,
  tool_use_id: 'toolu_1759655643512_k3j9x2',
  tool_call_id: 'call_7f3a9c21d4e84b0f',
  duration_ms: 14,
});

/** The patch createPatchSmart writes for a small change: one hunk over the whole file. */
function patch(fileName, before, after, oldHeader, newHeader) {
  const lines = (text) => (text ? text.replace(/\n$/, '').split('\n') : []);
  const a = lines(before);
  const b = lines(after);
  return [
    `Index: ${fileName}`,
    '===================================================================',
    `--- ${fileName}\t${oldHeader}`,
    `+++ ${fileName}\t${newHeader}`,
    `@@ -${a.length ? 1 : 0},${a.length} +1,${b.length} @@`,
    ...a.map((l) => `-${l}`),
    ...b.map((l) => `+${l}`),
    '',
  ].join('\n');
}

const stat = (added, removed) => ({
  model_added_lines: added,
  model_removed_lines: removed,
  model_added_chars: 0,
  model_removed_chars: 0,
  user_added_lines: 0,
  user_removed_lines: 0,
  user_added_chars: 0,
  user_removed_chars: 0,
});

export const USER_BEFORE = 'export interface User { id: string }\n';
export const USER_AFTER = 'export interface User {\n  id: string;\n  role: string;\n}\n';

// ── before ──────────────────────────────────────────────────────────────────

/** edit, the replace tool (ToolNames.EDIT): old_string becomes new_string, once unless replace_all. */
export const editBefore = (cwd, session, file = path.join(cwd, 'src', 'models', 'user.ts')) =>
  preToolUse(cwd, session, 'edit', { file_path: file, old_string: 'export interface User { id: string }', new_string: USER_AFTER.trimEnd() });

/** write_file: the whole new text of a file. */
export const writeBefore = (cwd, session, file = path.join(cwd, 'src', 'models', 'user.ts'), content = USER_AFTER) =>
  preToolUse(cwd, session, 'write_file', { file_path: file, content });

/** notebook_edit: a cell's new source, by Claude Code's NotebookEdit names. */
export const notebookBefore = (cwd, session, file = path.join(cwd, 'notebooks', 'explore.ipynb')) =>
  preToolUse(cwd, session, 'notebook_edit', { notebook_path: file, cell_id: 'c1', new_source: 'import pandas as pd\ndf = pd.read_csv("users.csv")', edit_mode: 'replace' });

/** read_file: what only a hook registered without a matcher would see. */
export const readBefore = (cwd, session, file = path.join(cwd, 'src', 'models', 'user.ts')) => preToolUse(cwd, session, 'read_file', { file_path: file });

/** run_shell_command (ToolNames.SHELL). */
export const shellBefore = (cwd, session, command = 'npm run build') =>
  preToolUse(cwd, session, 'run_shell_command', { command, description: 'Build the project', is_background: false });

// ── after ───────────────────────────────────────────────────────────────────

/** edit of an existing file, done. */
export const editAfter = (cwd, session, file = path.join(cwd, 'src', 'models', 'user.ts')) =>
  postToolUse(cwd, session, 'edit', { file_path: file, old_string: 'export interface User { id: string }', new_string: USER_AFTER.trimEnd() }, {
    llmContent: `The file: ${file} has been updated. Showing lines 1-4 of 4 from the edited file:\n\n---\n\n${USER_AFTER}`,
    returnDisplay: {
      fileDiff: patch(path.basename(file), USER_BEFORE, USER_AFTER, 'Current', 'Proposed'),
      fileName: path.basename(file),
      filePath: file,
      originalContent: USER_BEFORE,
      newContent: USER_AFTER,
      diffStat: stat(4, 1),
    },
  });

/** edit with an empty old_string, which made a new file (edit.ts isNewFile): originalContent null. */
export const editNewFile = (cwd, session, file = path.join(cwd, 'src', 'answer.ts'), content = 'export const answer = 42;\nexport const question = "?";\n') =>
  postToolUse(cwd, session, 'edit', { file_path: file, old_string: '', new_string: content }, {
    llmContent: `Created new file: ${file} with provided content.`,
    returnDisplay: {
      fileDiff: patch(path.basename(file), '', content, 'Current', 'Proposed'),
      fileName: path.basename(file),
      filePath: file,
      originalContent: null,
      newContent: content,
      diffStat: stat(2, 0),
    },
  });

/** write_file of a new file, done: originalContent ''. */
export const writeAfter = (cwd, session, file = path.join(cwd, 'src', 'new.ts'), content = 'export const answer = 42;\nexport const question = "?";\n') =>
  postToolUse(cwd, session, 'write_file', { file_path: file, content }, {
    llmContent: `Successfully created and wrote to new file: ${file}.`,
    returnDisplay: {
      fileDiff: patch(path.basename(file), '', content, 'Original', 'Written'),
      fileName: path.basename(file),
      filePath: file,
      originalContent: '',
      newContent: content,
      diffStat: stat(2, 0),
    },
  });

/** notebook_edit, done: a FileDiff of the notebook's JSON (notebook-edit.ts execute), shortened here. */
export const notebookAfter = (cwd, session, file = path.join(cwd, 'notebooks', 'explore.ipynb')) => {
  const source = 'import pandas as pd\ndf = pd.read_csv("users.csv")';
  const before = '{"cells":[{"id":"c1","cell_type":"code","source":["import pandas as pd"]}]}\n';
  const after = '{"cells":[{"id":"c1","cell_type":"code","source":["import pandas as pd\\n","df = pd.read_csv(\\"users.csv\\")"]}]}\n';
  return postToolUse(cwd, session, 'notebook_edit', { notebook_path: file, cell_id: 'c1', new_source: source, edit_mode: 'replace' }, {
    llmContent: `Notebook ${file} has been updated. replace cell c1.\n\nUpdated source:\n\n---\n\n${source}`,
    returnDisplay: {
      fileDiff: patch(path.basename(file), before, after, 'Current', 'Proposed'),
      fileName: path.basename(file),
      filePath: file,
      originalContent: before,
      newContent: after,
      diffStat: stat(1, 1),
    },
  });
};

/** run_shell_command, done: its output as text. */
export const shellAfter = (cwd, session, command = 'npm run build') =>
  postToolUse(cwd, session, 'run_shell_command', { command, description: 'Build the project', is_background: false }, {
    llmContent: `Command: ${command}\nDirectory: (root)\nOutput: built in 1.2s\nError: (none)\nExit Code: 0`,
    returnDisplay: 'built in 1.2s',
  });
