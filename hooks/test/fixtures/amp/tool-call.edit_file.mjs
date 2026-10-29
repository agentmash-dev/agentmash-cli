// Amp's tool.call event for an edit_file call, as the Plugin API hands it to
// a plugin's handler (`amp.on('tool.call', (event, ctx) => …)`).
//
// Source: @ampcode/plugin 0.0.0-20261004010057-g91b9e0f, index.d.ts
// (ToolCallEvent extends ToolCall: toolUseID "toolu_xxx", tool, input, and
// thread.id, a `T-${string}`); the tool's name from Amp's own tool list in the
// `init` message on ampcode.com/docs/cli/streaming-json, and the id formats
// from the example output there (both read 2026-10-05, Amp CLI
// 0.0.1791146283-g5c3f72). Amp documents no field of edit_file's input: path,
// old_str and new_str are what third-party plugins (git-ai's) read, and are
// unverified, which is why the plugin takes the file from Amp's own helper
// (`modifies`, below) and the input only for the text an edit replaced.

export default (project) => ({
  toolUseID: 'toolu_01EditUserModelForRoleAa',
  tool: 'edit_file',
  input: { path: `${project}/src/models/user.ts`, old_str: 'id: string', new_str: 'id: string;\n  role: string' },
  thread: { id: 'T-f9941a55-3765-421e-972f-05dc1138c3a3' },
});

/**
 * What amp.helpers.filesModifiedByToolCall answers for it, as paths (the
 * helper returns file URIs; filePathFromURI makes them paths). index.d.ts:
 * "Returns an array of file URIs modified by a tool call, or null if the tool
 * doesn't modify files. Supports edit/create/apply_patch tools and sed
 * in-place shell commands."
 */
export const modifies = (project) => [`${project}/src/models/user.ts`];
