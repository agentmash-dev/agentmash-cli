// kiro-cli V3 engine (@kiro/agent 0.66.0), PreToolUse before fs_append.
// Source: the argument schema {path, text} from vshulcz/deja-vu issue #4506
// (@kiro/agent 0.66.0 session store), in Kiro's hook envelope
// (kiro.dev/docs/hooks/types); not a captured hook payload.

export default (cwd, session) => ({
  session_id: session,
  hook_event_name: 'PreToolUse',
  cwd,
  tool_name: 'fs_append',
  tool_input: { path: 'src/models/user.ts', text: 'export const ROLES = ["admin"];\n' },
});
