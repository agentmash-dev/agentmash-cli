// Amp's tool.call event for a create_file call (a new file, whole).
//
// Source: @ampcode/plugin 0.0.0-20261004010057-g91b9e0f, index.d.ts
// (ToolCallEvent); the tool's name from the `init` message on
// ampcode.com/docs/cli/streaming-json (read 2026-10-05, Amp CLI
// 0.0.1791146283-g5c3f72). Amp documents no field of create_file's input:
// path and content are unverified, and only the line count of the report
// depends on them; the file is the one Amp's helper names (`modifies`).

export default (project) => ({
  toolUseID: 'toolu_01CreateNewModuleBbbbbb',
  tool: 'create_file',
  input: { path: `${project}/src/new.ts`, content: 'export const b = 2;\n' },
  thread: { id: 'T-f9941a55-3765-421e-972f-05dc1138c3a3' },
});

/** amp.helpers.filesModifiedByToolCall's answer for it, as paths (see tool-call.edit_file.mjs). */
export const modifies = (project) => [`${project}/src/new.ts`];
