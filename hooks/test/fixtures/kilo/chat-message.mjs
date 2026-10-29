// What Kilo Code hands a plugin's chat.message hook as a person's message
// arrives, before it is saved and before the model sees it, recorded from
// Kilo Code 7.8.3's source (Kilo-Org/kilocode, tag v7.8.3), not from a live
// run:
//
//   packages/opencode/src/session/prompt.ts L1382-1392   (input { sessionID, agent, model, messageID, variant },
//                                                        output { message, parts }), waited for before the model
//                                                        is called
//   packages/opencode/src/session/prompt.ts L940-990     a part: { id, sessionID, messageID, type, … }; a text
//                                                        part's synthetic is Kilo's own text added to the message
//                                                        (an MCP resource read, a file's contents), and ignored is
//                                                        text the model is not sent
//
// It runs for the task tool's subagents too: their sessions have a parentID,
// and their "prompt" is what the parent agent wrote.

import { SESSION } from './tool-execute.mjs';

export const MESSAGE = 'msg_e1a57c2b7001Lp4YwRn9tUzMyB';

/** chat.message's two arguments, for `text` typed in `sessionID`, with a file attached. */
export function chatMessage(text, { sessionID = SESSION } = {}) {
  const model = { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4.5' };
  const part = (id, rest) => ({ id, sessionID, messageID: MESSAGE, ...rest });
  return [
    { sessionID, agent: 'code', model, messageID: MESSAGE, variant: undefined },
    {
      message: { id: MESSAGE, sessionID, role: 'user', time: { created: 1759622400000 }, agent: 'code', model },
      parts: [
        part('prt_e1a57c2b7002AaBbCcDdEeFf', { type: 'text', text }),
        part('prt_e1a57c2b7003GgHhIiJjKkLl', { type: 'file', mime: 'image/png', filename: 'screen.png', url: 'data:image/png;base64,iVBORw0KGgo=' }),
        part('prt_e1a57c2b7004MmNnOoPpQqRr', { type: 'text', synthetic: true, text: 'Called the Read tool with the following input: {"filePath":"src/models/user.ts"}' }),
      ],
    },
  ];
}
