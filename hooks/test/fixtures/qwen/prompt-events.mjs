// UserPromptSubmit, as Qwen Code 0.24.7 writes it to a command hook's stdin.
// Recorded from its source at the v0.24.7 tag (github.com/QwenLM/qwen-code):
//   - the fields: packages/core/src/hooks/hookEventHandler.ts,
//     fireUserPromptSubmitEvent: createBaseInput's (permission_mode there is
//     the hook enum, "default" or "auto_edit"), `prompt`, and
//     `submitted_prompt` only when one is given and is not blank (first in
//     v0.21.1: v0.21.0 and before send `prompt` alone)
//   - when it fires: packages/core/src/core/client.ts fires it before every
//     send to the model but a retry, a steer, a cron, a notification, a
//     teammate's or a goal's: a tool's result going back is one. Only a
//     UserQuery carries submitted_prompt, what the person typed; `prompt` is
//     the text bound for the model, which for a typed prompt has the files
//     the person named with @ read into it, and for a tool's result going back
//     is that result
// The transcript path, the timestamp and the texts are examples of their
// form, and the session id is a test's own.

import { base } from './tool-events.mjs';

/** A prompt the person typed: what they typed, and the same with the file they named read into it. */
export const typed = (cwd, session, text = 'add a role to the user model') => ({
  ...base(cwd, session, 'UserPromptSubmit'),
  prompt: `${text} @src/models/user.ts\n--- Content from referenced files ---\nContent from @src/models/user.ts:\nexport interface User { id: string }\n--- End of content ---`,
  submitted_prompt: `${text} @src/models/user.ts`,
});

/** The send that takes a tool's result back to the model: no submitted_prompt. */
export const continuation = (cwd, session) => ({
  ...base(cwd, session, 'UserPromptSubmit'),
  prompt: 'The file: /repo/src/models/user.ts has been updated. Showing lines 1-4 of 4 from the edited file',
});
