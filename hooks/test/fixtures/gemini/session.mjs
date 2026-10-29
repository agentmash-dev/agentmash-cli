// SessionStart and SessionEnd, as Gemini CLI 0.62.0 writes them to a command
// hook's stdin. Recorded from its source at the v0.62.0 tag:
// SessionStartInput (`source`: startup, resume or clear) and SessionEndInput
// (`reason`: exit, clear, logout, prompt_input_exit or other) in
// packages/core/src/hooks/types.ts, with the base fields of every event
// (packages/core/src/hooks/hookEventHandler.ts, createBaseInput). Of the
// reasons, only exit (packages/cli/src/gemini.tsx, ui/AppContainer.tsx) and
// clear (ui/commands/clearCommand.ts, which then starts a new session id with
// SessionStart "clear") are fired by 0.62.0; an interactive exit can fire
// SessionEnd twice for one session.

import { beforeTool } from './before_tool.mjs';

const base = (cwd, session) => {
  const { tool_name, tool_input, ...rest } = beforeTool(cwd, session, '', {});
  return rest;
};

export const sessionStart = (cwd, session, source = 'startup') => ({ ...base(cwd, session), hook_event_name: 'SessionStart', source });

export const sessionEnd = (cwd, session, reason = 'exit') => ({ ...base(cwd, session), hook_event_name: 'SessionEnd', reason });
