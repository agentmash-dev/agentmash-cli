// For an agent that adds whatever its hook prints to the model's context, as
// text: the advice, or the heads-up, as it is, and nothing at all otherwise.
// It can refuse nothing, so the room's strict mode reaches it as its reason,
// to read.

import { parseClaudeShaped } from './claude.mjs';

export default {
  name: 'plain',
  parse: parseClaudeShaped,
  answer(event, result) {
    return { stdout: typeof result?.text === 'string' && result.text ? `${result.text}\n` : '' };
  },
  neutral() {
    return { stdout: '' };
  },
};
