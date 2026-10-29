// What Junie CLI sends its hooks around a session: SessionStart,
// UserPromptSubmit, Stop and SessionEnd. Junie is closed source, so each
// shape is from its docs (junie-cli-hooks.html as published 2026-10-01, the
// same text bundled with build 3419.26) or from a payload someone captured
// from a real Junie and published, named on each. Junie reports `cwd` as its
// own home (~/.junie), never the project; `project_path` is the project.
// Session ids look like session-YYMMDD-HHMMSS-xxxx.

/**
 * SessionStart: the fields junie-cli-hooks.html documents (session_id, cwd,
 * project_path, source: startup | resume | clear | compact), as ggshield's
 * Junie reader takes them (GitGuardian/ggshield rust/hook/src/payload.rs,
 * merged 2026-09-14). Junie runs it in the background and ignores its output.
 */
export const sessionStart = ({ session_id, junieHome, project_path, source = 'startup' }) => ({
  hook_event_name: 'SessionStart',
  session_id,
  cwd: junieHome,
  project_path,
  source,
});

/**
 * UserPromptSubmit, as captured on Junie 3419.7 (26.9.22) and published in
 * maj0rpain/orchestrator issue #202: session_id, cwd (Junie's home),
 * project_path and the prompt, with a typed /skill rewritten to $skill. Its
 * additionalContext reached the model there, wrapped in <additional_context>
 * (orchestrator PR #208). The TUI fires it; batch runs do not.
 */
export const userPromptSubmit = ({ session_id, junieHome, project_path, prompt = '$grill-with-docs probe test' }) => ({
  hook_event_name: 'UserPromptSubmit',
  session_id,
  cwd: junieHome,
  project_path,
  prompt,
});

/**
 * Stop: hook_event_name, stop_hook_active and last_assistant_message, and
 * nothing else: no session id on 26.8.3 (pragma-sh/pragma
 * packages/junie-plugin/AGENTS.md); junie-cli-hooks.html documents the same
 * three. `session_id` is added only when a test passes one, for a build that
 * sends it.
 */
export const stop = ({ session_id, last_assistant_message = 'Done: the user model has a role now.' } = {}) => ({
  hook_event_name: 'Stop',
  ...(session_id ? { session_id } : {}),
  stop_hook_active: false,
  last_assistant_message,
});

/**
 * SessionEnd: only the event and a reason, prompt_input_exit or other, with
 * no session and no project (captured on 26.8.31 for ggshield PR #1451; the
 * same on 26.8.3 per pragma-sh). login registers nothing for it.
 */
export const sessionEnd = ({ reason = 'prompt_input_exit' } = {}) => ({
  hook_event_name: 'SessionEnd',
  reason,
});
