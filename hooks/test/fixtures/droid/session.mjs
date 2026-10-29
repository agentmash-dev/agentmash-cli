// UserPromptSubmit, SessionStart, SessionEnd and Stop, as Factory Droid (CLI
// 0.233.0) writes them to a command hook's stdin. Recorded from
// docs.factory.com/harness/hooks.md ("Hook input", as served 2026-10-05):
//   - UserPromptSubmit: prompt, has_images
//   - SessionStart: source, one of startup, resume, clear, compact
//   - SessionEnd: reason, one of clear, logout, prompt_input_exit, other,
//     with session_duration_ms and message_count; it also fires on /clear and
//     /new (changelog 0.57.10)
//   - Stop: stop_hook_active, tool_execution_count, elapsed_time
// each with the common fields (session_id, transcript_path, cwd,
// permission_mode, hook_event_name). The values are examples of their form.

const base = (cwd, session, hook_event_name) => ({
  session_id: session,
  transcript_path: `/Users/me/.factory/projects/-Users-me-project/${session}.jsonl`,
  cwd,
  permission_mode: 'off',
  hook_event_name,
});

export const userPromptSubmit = (cwd, session, prompt) => ({ ...base(cwd, session, 'UserPromptSubmit'), prompt, has_images: false });

export const sessionStart = (cwd, session, source = 'startup') => ({ ...base(cwd, session, 'SessionStart'), source });

export const sessionEnd = (cwd, session, reason = 'prompt_input_exit') => ({
  ...base(cwd, session, 'SessionEnd'),
  reason,
  session_duration_ms: 482113,
  message_count: 14,
});

export const stop = (cwd, session) => ({ ...base(cwd, session, 'Stop'), stop_hook_active: false, tool_execution_count: 6, elapsed_time: 51234 });
