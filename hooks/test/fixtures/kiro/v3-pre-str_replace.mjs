// kiro-cli V3 engine (@kiro/agent 0.66.0), PreToolUse before str_replace.
// Source: the tool call's argument schema {path, oldStr, newStr}, read from
// @kiro/agent 0.66.0's session store by vshulcz/deja-vu (issue #4506). It is
// that schema in Kiro's hook envelope (kiro.dev/docs/hooks/types), not a
// captured hook payload: no str_replace PreToolUse stdin has been published.
// deja-vu's fixture used an absolute path; Kiro's own prose uses relative.

export default (cwd, session) => ({
  session_id: session,
  hook_event_name: 'PreToolUse',
  cwd,
  tool_name: 'str_replace',
  tool_input: { path: `${cwd}/src/models/user.ts`, oldStr: 'id: string', newStr: 'id: string;\n  role: string' },
});
