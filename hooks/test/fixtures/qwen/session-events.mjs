// SessionStart and SessionEnd, as Qwen Code 0.24.7 writes them to a command
// hook's stdin. Recorded from its source at the v0.24.7 tag
// (github.com/QwenLM/qwen-code):
//   - packages/core/src/hooks/hookEventHandler.ts, fireSessionStartEvent:
//     createBaseInput's fields, permission_mode, source ("startup",
//     "resume", "clear", "compact" or "branch"), model, and agent_type, left
//     out of the JSON when there is none
//   - fireSessionEndEvent: createBaseInput's fields and reason ("clear",
//     "logout", "prompt_input_exit", "bypass_permissions_disabled" or
//     "other"); the interactive UI fires it on exit and on /clear, an ACP
//     session as it shuts down, and a headless run (qwen -p) never
// The transcript path, the timestamp and the model are examples of their
// form, and the session id is a test's own.

import { base } from './tool-events.mjs';

export const sessionStart = (cwd, session, source = 'startup') => ({
  ...base(cwd, session, 'SessionStart'),
  source,
  model: 'qwen3-coder-plus',
});

export const sessionEnd = (cwd, session, reason = 'prompt_input_exit') => ({
  ...base(cwd, session, 'SessionEnd'),
  reason,
});
