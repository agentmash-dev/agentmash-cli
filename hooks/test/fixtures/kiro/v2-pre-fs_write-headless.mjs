// kiro-cli V2 engine (2.22.0, --no-interactive), preToolUse before fs_write.
// Source: aws/amazon-q-developer-cli v1.19.7 (crates/chat-cli/src/cli/agent/
// hook.rs and the fs_write tool), the V2 runner Kiro inherited, and the
// payloads vshulcz/deja-vu captured on kiro-cli 2.22.0 (#4304): camelCase
// event, fs_write's {command, path, old_str, new_str}, and no session_id.
// Login registers nothing V2 is known to run; this is read all the same.

export default (cwd) => ({
  hook_event_name: 'preToolUse',
  cwd,
  tool_name: 'fs_write',
  tool_input: { command: 'str_replace', path: `${cwd}/src/models/user.ts`, old_str: 'id: string', new_str: 'id: string;\n  role: string' },
});
