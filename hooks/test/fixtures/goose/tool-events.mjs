// What goose sends a hook around a tool call, as goose v1.53.0 writes it:
// HookContext in crates/goose/src/hooks/mod.rs, serialized with every unset
// Option left out and matcher_context always there, filled in by
// run_pre_tool_hooks / with_post_tool_hooks (agents/state_machine/
// ops_toolcalling.rs) and, on the CLI's own loop, dispatch_tool_call and
// with_post_tool_hook (agents/agent.rs). The tools' inputs are the developer
// extension's (agents/platform_extensions/developer/edit.rs: `write` {path,
// content}, `edit` {path, before, after}; developer/mod.rs: `shell`
// {command}), unprefixed; any other extension's tools come as
// `<extension>__<tool>` (here the reference filesystem MCP server's
// read_file and write_file, as goose would name them). Each builder takes
// what differs from one test to the next: the session (goose's own form,
// YYYYMMDD_N) and the folder goose works in.

/** PreToolUse before goose's own `edit`: matcher_context is the tool's name, and the path may be relative. */
export const preEdit = ({ session_id, working_dir, path = 'src/models/user.ts', before = 'id: string', after = 'id: string;\n  role: string' }) => ({
  event: 'PreToolUse',
  session_id,
  matcher_context: 'edit',
  tool_call_id: 'toolu_01GooseEditCall',
  tool_name: 'edit',
  tool_input: { path, before, after },
  working_dir,
});

/** PreToolUse before goose's own `write`: the whole new file. */
export const preWrite = ({ session_id, working_dir, path = 'src/models/user.ts', content = 'export interface User { id: string; role: string }\n' }) => ({
  event: 'PreToolUse',
  session_id,
  matcher_context: 'write',
  tool_call_id: 'toolu_01GooseWriteCall',
  tool_name: 'write',
  tool_input: { path, content },
  working_dir,
});

/** PreToolUse before another extension's tool: `<extension>__<tool>`, its own input. */
export const preExtension = ({ session_id, working_dir, tool, input }) => ({
  event: 'PreToolUse',
  session_id,
  matcher_context: tool,
  tool_call_id: 'toolu_01GooseExtensionCall',
  tool_name: tool,
  tool_input: input,
  working_dir,
});

/** PreToolUse before goose's own `shell`: names no file. */
export const preShell = ({ session_id, working_dir, command = 'cat src/models/user.ts' }) => ({
  event: 'PreToolUse',
  session_id,
  matcher_context: 'shell',
  tool_call_id: 'toolu_01GooseShellCall',
  tool_name: 'shell',
  tool_input: { command },
  working_dir,
});

/**
 * AfterFileEdit after a successful `edit`: matcher_context is the path as the
 * tool was given it, and there is no tool_call_id and no tool_output (with_tool_output
 * has no caller in v1.53.0).
 */
export const afterEdit = ({ session_id, working_dir, path = 'src/models/user.ts', before = 'id: string', after = 'id: string;\n  role: string' }) => ({
  event: 'AfterFileEdit',
  session_id,
  matcher_context: path,
  tool_name: 'edit',
  tool_input: { path, before, after },
  working_dir,
});

/** AfterFileEdit after a successful `write`. */
export const afterWrite = ({ session_id, working_dir, path = 'src/new.ts', content = 'export const a = 1;\n' }) => ({
  event: 'AfterFileEdit',
  session_id,
  matcher_context: path,
  tool_name: 'write',
  tool_input: { path, content },
  working_dir,
});

/** PostToolUse after `shell`: matcher_context is the tool's name, and it carries tool_call_id. */
export const afterShell = ({ session_id, working_dir, command }) => ({
  event: 'PostToolUse',
  session_id,
  matcher_context: 'shell',
  tool_call_id: 'toolu_01GooseShellCall',
  tool_name: 'shell',
  tool_input: { command },
  working_dir,
});
