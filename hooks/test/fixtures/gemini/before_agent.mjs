// BeforeAgent, as Gemini CLI 0.62.0 writes it to a command hook's stdin.
// Recorded from its source at the v0.62.0 tag: BeforeAgentInput in
// packages/core/src/hooks/types.ts, the base fields as for every event
// (packages/core/src/hooks/hookEventHandler.ts, createBaseInput), fired once
// per prompt from packages/core/src/core/client.ts with
// prompt = partToString(request). In the interactive CLI that request is the
// query after @-processing (packages/cli/src/ui/hooks/atCommandProcessor.ts):
// what the person typed, then, when they named files with @, the header
// REFERENCE_CONTENT_START (packages/core/src/utils/constants.ts) and the
// files' text. The file text's own layout here is an example of its form.

import { beforeTool } from './before_tool.mjs';

export function beforeAgent(cwd, session, prompt) {
  const { tool_name, tool_input, ...base } = beforeTool(cwd, session, '', {});
  return { ...base, hook_event_name: 'BeforeAgent', prompt };
}

/** A prompt naming a file with @, as BeforeAgent carries it: what was typed, then the file. */
export function withReferencedFile(typed, file, text) {
  return `${typed}\n--- Content from referenced files ---\nContent from @${file}:\n${text}\n--- End of content ---`;
}
