// What OpenCode hands a plugin's chat.message hook as a person's message
// arrives, before it is saved and before the model sees it, recorded from
// OpenCode 1.18.34's source (anomalyco/opencode, tag v1.18.34), not from a
// live run:
//
//   packages/opencode/src/session/prompt.ts L999-1009   (input { sessionID, agent, model, messageID, variant },
//                                                       output { message, parts }); OpenCode 1.0.0 passed {} as
//                                                       the input, so message.sessionID is where an older one says it
//   packages/schema/src/v1/session.ts L80-116           a part: { id, sessionID, messageID, type, … }; a text part's
//                                                       synthetic is OpenCode's own text added to the message, and
//                                                       ignored is text the model is not sent (message-v2.ts L210)
//
// It runs for the task tool's subagents too: their sessions have a parentID
// (tool/task.ts L159), and their "prompt" is what the parent agent wrote.

import { SESSION } from './tool-execute.mjs';

export const MESSAGE = 'msg_d0957f1b6001Kp3XvQm8sTzLyA';

/** chat.message's two arguments, for `text` typed in `sessionID`, with a file attached. */
export function chatMessage(text, { sessionID = SESSION } = {}) {
  const model = { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' };
  const part = (id, rest) => ({ id, sessionID, messageID: MESSAGE, ...rest });
  return [
    { sessionID, agent: 'build', model, messageID: MESSAGE, variant: undefined },
    {
      message: { id: MESSAGE, sessionID, role: 'user', time: { created: 1759622400000 }, agent: 'build', model },
      parts: [
        part('prt_d0957f1b6002AaBbCcDdEeFf', { type: 'text', text }),
        part('prt_d0957f1b6003GgHhIiJjKkLl', { type: 'file', mime: 'image/png', filename: 'screen.png', url: 'data:image/png;base64,iVBORw0KGgo=' }),
        part('prt_d0957f1b6004MmNnOoPpQqRr', { type: 'text', synthetic: true, text: 'Called the Read tool with the following input: {"filePath":"src/models/user.ts"}' }),
      ],
    },
  ];
}

/** The same message as OpenCode 1.0.0 passed it: an empty input. */
export function chatMessageV1(text, options) {
  const [, output] = chatMessage(text, options);
  return [{}, output];
}
