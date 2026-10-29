// What OpenHands writes to a command hook's stdin for the events that are not
// a tool call, as the OpenHands Software Agent SDK does it (HookEvent.
// model_dump_json(), openhands-sdk/openhands/sdk/hooks/types.py at v1.51.0;
// the same fields at v1.21.0, which the OpenHands CLI 1.16.0 runs):
//
//   - UserPromptSubmit: `message` is the user's message, its TextContent
//     parts joined (hooks/manager.py run_user_prompt_submit); tool_name and
//     the rest null. Its additionalContext is the one a model reads, added to
//     that message (conversation_hooks.py _handle_user_prompt_submit).
//   - SessionEnd: run by conversation.close(), and again, followed by
//     SessionStart, when plugins load into a running conversation
//     (local_conversation.py _merge_runtime_plugin_hooks). metadata may carry
//     a reason; nothing sets one for SessionEnd at v1.51.0.
//   - SessionStart: run before the first prompt; what a hook says is not
//     passed to the model, which is why login registers none.
//
// Recorded from the source, not from a live run (see tool-events.mjs).

const envelope = (event_type, { session_id, working_dir, message = null, metadata = {} }) => ({
  event_type,
  tool_name: null,
  tool_input: null,
  tool_response: null,
  message,
  session_id,
  working_dir,
  metadata,
});

/** UserPromptSubmit with what the person typed. */
export const prompt = ({ session_id, working_dir, message = 'add a role to the user model' }) => envelope('UserPromptSubmit', { session_id, working_dir, message });

/** SessionEnd, as conversation.close() runs it. */
export const sessionEnd = ({ session_id, working_dir }) => envelope('SessionEnd', { session_id, working_dir });

/** SessionStart, which login does not register (its output reaches no model). */
export const sessionStart = ({ session_id, working_dir }) => envelope('SessionStart', { session_id, working_dir });
