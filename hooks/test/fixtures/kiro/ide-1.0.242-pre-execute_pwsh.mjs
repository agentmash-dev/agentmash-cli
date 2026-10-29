// Kiro IDE 1.0.242 (Windows), PreToolUse before a shell command.
// Source: measured live by awslabs/aidlc-workflows,
// docs/reference/kiro-ide-hook-payload.md: tool execute_pwsh, input
// {command, cwd, run_in_background, timeout}; 1.1.14 sent the same. A shell
// command names no file it changes, so nothing is asked before it.

export default (cwd, session) => ({
  session_id: session,
  hook_event_name: 'PreToolUse',
  cwd,
  tool_name: 'execute_pwsh',
  tool_input: { command: "sed -i 's/id/key/' src/models/user.ts", cwd, run_in_background: false, timeout: 60 },
});
