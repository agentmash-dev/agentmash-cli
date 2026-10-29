// kiro-cli V3 engine (@kiro/agent 0.66.0), PreToolUse before delete_file.
// Source: the argument schema {targetFile} from vshulcz/deja-vu issue #4506
// (@kiro/agent 0.66.0 session store), in Kiro's hook envelope
// (kiro.dev/docs/hooks/types); not a captured hook payload.

export default (cwd, session) => ({
  session_id: session,
  hook_event_name: 'PreToolUse',
  cwd,
  tool_name: 'delete_file',
  tool_input: { targetFile: 'src/models/user.ts' },
});
