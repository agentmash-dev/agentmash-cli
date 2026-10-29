// Kiro IDE 1.0.309 and later, PostToolUse after str_replace with its input.
// Source: awslabs/aidlc-workflows issue #763, cited in
// docs/reference/kiro-ide-hook-payload.md: 1.0.309 "populated ... PostToolUse
// inputs as well" (reported there, not measured); the input is str_replace's
// schema {path, oldStr, newStr} (vshulcz/deja-vu #4506) and the response its
// measured prose.

export default (cwd, session) => ({
  session_id: session,
  hook_event_name: 'PostToolUse',
  cwd,
  tool_name: 'str_replace',
  tool_input: { path: 'src/models/user.ts', oldStr: 'id: string', newStr: 'id: string;\n  role: string' },
  tool_response: 'Replaced text in src/models/user.ts',
});
