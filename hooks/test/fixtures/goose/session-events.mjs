// What goose sends a hook around a session and a prompt, as goose v1.53.0
// writes it (HookContext in crates/goose/src/hooks/mod.rs, unset fields left
// out, matcher_context always there):
//
//   UserPromptSubmit  agents/agent.rs reply_impl (the CLI's own loop, its
//                     default): no working_dir; agents/state_machine/
//                     ops_entry_hook.rs (goose Desktop, and the CLI with
//                     GOOSE_STATE_MACHINE=1): working_dir too. The prompt is
//                     in `message`, and copied to matcher_context.
//   SessionStart      goose-cli session/mod.rs as an interactive session opens
//                     (no working_dir), or ops_entry_hook.rs with the first
//                     prompt (working_dir).
//   SessionEnd        goose-cli session/mod.rs only: Desktop, `goose serve` and
//                     `goose acp` never send it.
//   Stop              at every turn's end, ops_stop_hook.rs; last_assistant_message
//                     is left out when it is empty.

/** UserPromptSubmit on the CLI's own loop: no working_dir, so the hook's cwd, goose's, is the folder. */
export const promptLegacy = ({ session_id, message }) => ({
  event: 'UserPromptSubmit',
  session_id,
  matcher_context: message,
  message,
});

/** UserPromptSubmit on goose Desktop's loop. */
export const promptDesktop = ({ session_id, message, working_dir }) => ({
  event: 'UserPromptSubmit',
  session_id,
  matcher_context: message,
  message,
  working_dir,
});

/** SessionStart as the goose CLI opens an interactive session. */
export const sessionStart = ({ session_id }) => ({ event: 'SessionStart', session_id, matcher_context: null });

/** SessionStart on goose Desktop's loop, with the first prompt. */
export const sessionStartDesktop = ({ session_id, working_dir }) => ({ event: 'SessionStart', session_id, matcher_context: null, working_dir });

/** SessionEnd as the goose CLI leaves a session. */
export const sessionEnd = ({ session_id }) => ({ event: 'SessionEnd', session_id, matcher_context: null });

/** Stop at a turn's end. */
export const stop = ({ session_id, working_dir, last_assistant_message = 'Added a role to User.' }) => ({
  event: 'Stop',
  session_id,
  matcher_context: null,
  last_assistant_message,
  working_dir,
});
