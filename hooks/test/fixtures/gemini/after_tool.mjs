// AfterTool, as Gemini CLI 0.62.0 writes it to a command hook's stdin.
// Recorded from its source at the v0.62.0 tag:
//   - the fields: packages/core/src/hooks/hookEventHandler.ts,
//     fireAfterToolEvent, and AfterToolInput in packages/core/src/hooks/types.ts
//   - tool_response: { llmContent, returnDisplay, error } from
//     packages/core/src/core/coreToolHookTriggers.ts; error is undefined on
//     success, so JSON leaves it out
//   - write_file's result: packages/core/src/tools/write-file.ts (execute):
//     returnDisplay a FileDiff (packages/core/src/tools/tools.ts), its patch
//     from Diff.createPatch(fileName, old, new, 'Original', 'Written'),
//     filePath absolute after the tool's own path correction
//   - replace's: packages/core/src/tools/edit.ts (execute): a FileDiff with
//     'Current'/'Proposed' for an existing file, the string "Created <path>"
//     for one it made (old_string ""), and on failure a string and
//     { message, type } (packages/core/src/tools/tool-error.ts)
//   - run_shell_command's: a string result and no FileDiff
// AfterTool fires after the tool ran, failed or not; not when BeforeTool
// refused it or the person cancelled it. The llmContent wording is an
// example of its form.

import path from 'node:path';
import { beforeTool } from './before_tool.mjs';

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

/** A unified patch as Diff.createPatch writes it, for one changed hunk of a small file. */
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

function afterTool(cwd, session, tool_name, tool_input, tool_response) {
  return { ...beforeTool(cwd, session, tool_name, tool_input), hook_event_name: 'AfterTool', tool_response };
}

/** write_file of a new file, which worked. */
export function writeFile(cwd, session, file_path, content) {
  const filePath = path.resolve(cwd, file_path);
  return afterTool(cwd, session, 'write_file', { file_path, content }, {
    llmContent: `Successfully created and wrote to new file: ${filePath}. Here is the updated code:\n${content}`,
    returnDisplay: {
      fileDiff: patch(path.basename(filePath), '', content, 'Original', 'Written'),
      fileName: path.basename(filePath),
      filePath,
      originalContent: '',
      newContent: content,
      diffStat: stat(content.split('\n').length, 0),
      isNewFile: true,
      isBuildFile: false,
    },
  });
}

/**
 * replace in an existing file, which worked: `filePath` is where the tool
 * says it wrote, which can differ from the model's file_path (edit.ts
 * corrects a relative path, then resolves it).
 */
export function replace(cwd, session, file_path, old_string, new_string, { original, filePath = path.resolve(cwd, file_path) } = {}) {
  const updated = original.replace(old_string, new_string);
  return afterTool(cwd, session, 'replace', { file_path, instruction: 'Add a role field to the User interface.', old_string, new_string }, {
    llmContent: `Successfully modified file: ${filePath} (1 replacements). Here is the updated code:\n${updated}`,
    returnDisplay: {
      fileDiff: patch(path.basename(filePath), original, updated, 'Current', 'Proposed'),
      fileName: path.basename(filePath),
      filePath,
      originalContent: original,
      newContent: updated,
      diffStat: stat(new_string.split('\n').length, old_string.split('\n').length),
      isNewFile: false,
      isBuildFile: false,
    },
  });
}

/** replace whose old_string was not in the file: nothing changed. */
export function replaceFailed(cwd, session, file_path, old_string, new_string) {
  const message = `Failed to edit, 0 occurrences found for old_string (${old_string}). Original old_string was (${old_string}) in ${path.resolve(cwd, file_path)}. No edits made.`;
  return afterTool(cwd, session, 'replace', { file_path, old_string, new_string }, {
    llmContent: message,
    returnDisplay: 'Error: Failed to edit, could not find the string to replace.',
    error: { message, type: 'edit_no_occurrence_found' },
  });
}

/** replace with an empty old_string on a file that was not there: it made the file. */
export function replaceCreated(cwd, session, file_path, new_string) {
  return afterTool(cwd, session, 'replace', { file_path, old_string: '', new_string }, {
    llmContent: `Created new file: ${path.resolve(cwd, file_path)} with provided content. Here is the updated code:\n${new_string}`,
    returnDisplay: `Created ${file_path}`,
  });
}

/** run_shell_command, which ran. */
export function shell(cwd, session, command) {
  return afterTool(cwd, session, 'run_shell_command', { command, description: 'Run the build' }, {
    llmContent: `Command: ${command}\nDirectory: (root)\nOutput: (empty)\nError: (none)\nExit Code: 0`,
    returnDisplay: '',
  });
}
