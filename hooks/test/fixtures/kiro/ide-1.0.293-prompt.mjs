// Kiro IDE 1.0.293 and later (kiro-cli V3 2.14.2 and later), UserPromptSubmit.
// Source: kiro.dev/docs/hooks/types (field `prompt`); the empty-prompt bug was
// fixed in IDE 1.0.293 (kirodotdev/Kiro #10346, member comment) and kiro-cli
// 2.14.2 (#10308); #10346 shows the IDE sending hook_event_name
// "UserPromptSubmit". What the hook prints on exit 0 is added to the turn.

export default (cwd, session) => ({
  session_id: session,
  hook_event_name: 'UserPromptSubmit',
  cwd,
  prompt: 'give the user a role',
});
