// BeforeTool, as Gemini CLI 0.62.0 writes it to a command hook's stdin.
// Recorded from its source at the v0.62.0 tag:
//   - the base fields: packages/core/src/hooks/hookEventHandler.ts,
//     createBaseInput (session_id, transcript_path, cwd = the working dir,
//     hook_event_name, an ISO timestamp)
//   - the tool fields: fireBeforeToolEvent there, and BeforeToolInput in
//     packages/core/src/hooks/types.ts; mcp_context only for MCP tools,
//     original_request_name only for tail calls, so neither is here
//   - tool_input: the invocation's params as they are
//     (packages/core/src/scheduler/hook-utils.ts, `{ ...invocation.params }`),
//     named as in packages/core/src/tools/definitions/base-declarations.ts.
//     file_path is the model's own argument: absolute, or relative to cwd.
// The transcript path and the timestamp are examples of their form, and the
// session id is a test's own (Gemini CLI's is a random UUID).

/** One BeforeTool payload for `tool_name` with `tool_input`. */
export function beforeTool(cwd, session, tool_name, tool_input) {
  return {
    session_id: session,
    transcript_path: `/home/someone/.gemini/tmp/3f9a1c/chats/session-2026-10-05T09-14-${String(session).slice(0, 8)}.json`,
    cwd,
    hook_event_name: 'BeforeTool',
    timestamp: '2026-10-05T09:14:03.512Z',
    tool_name,
    tool_input,
  };
}

/** write_file: the whole new text of a file (WRITE_FILE_PARAM_CONTENT). */
export const writeFile = (cwd, session, file_path, content) => beforeTool(cwd, session, 'write_file', { file_path, content });

/** replace, the edit tool (EDIT_TOOL_NAME): old_string becomes new_string, once unless allow_multiple. */
export const replace = (cwd, session, file_path, old_string, new_string) =>
  beforeTool(cwd, session, 'replace', {
    file_path,
    instruction: 'Add a role field to the User interface.',
    old_string,
    new_string,
  });

/** read_file: what only a hook registered without a matcher would see. */
export const readFile = (cwd, session, file_path) => beforeTool(cwd, session, 'read_file', { file_path });

/** read_many_files: its include patterns, never a file_path. */
export const readManyFiles = (cwd, session) => beforeTool(cwd, session, 'read_many_files', { include: ['src/**/*.ts'] });

/** run_shell_command (SHELL_TOOL_NAME): a command, with the description the model gives it. */
export const shell = (cwd, session, command) => beforeTool(cwd, session, 'run_shell_command', { command, description: 'Run the build' });
