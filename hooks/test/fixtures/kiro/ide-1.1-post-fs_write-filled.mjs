// Kiro IDE 1.0.309 and later, PostToolUse after fs_write with its input.
// Source: awslabs/aidlc-workflows issue #763 (populated PostToolUse inputs on
// 1.0.309, reported, not measured), with fs_write's input as measured before
// the call on 1.1.14 ({path, text}) and its measured prose.

export default (cwd, session) => ({
  session_id: session,
  hook_event_name: 'PostToolUse',
  cwd,
  tool_name: 'fs_write',
  tool_input: { path: 'src/new.ts', text: 'export const answer = 42;\n' },
  tool_response: 'Created the src/new.ts file.',
});
