// Amp's tool.call event for a shell command.
//
// Source: @ampcode/plugin 0.0.0-20261004010057-g91b9e0f, index.d.ts
// (ToolCallEvent; ShellCommandFromToolCall: "Extracts the shell command from a
// Bash or shell_command tool call", as { command, dir? }); the tool's name from
// the `init` message on ampcode.com/docs/cli/streaming-json, and its input's
// `cmd` from Amp's tool-level permissions (ampcode.com/news/tool-level-permissions,
// `{ "tool": "Bash", "matches": { "cmd": "*git commit*" } }`), read 2026-10-05,
// Amp CLI 0.0.1791146283-g5c3f72. The plugin reads the command through the
// helper, never the input's fields.

export default (project, command = 'ls src') => ({
  toolUseID: 'toolu_01RunAShellCommandCcccc',
  tool: 'Bash',
  input: { cmd: command, cwd: project },
  thread: { id: 'T-f9941a55-3765-421e-972f-05dc1138c3a3' },
});

/** amp.helpers.filesModifiedByToolCall's answer for a command that edits nothing in place. */
export const modifies = () => null;

/** amp.helpers.shellCommandFromToolCall's answer for it. */
export const shell = (project, command = 'ls src') => ({ command, dir: project });
