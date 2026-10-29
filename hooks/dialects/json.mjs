// The result itself, as one line of JSON, every time: for a tool, a script or
// a wrapper of someone's own that reads it and decides what to do with it
// (agent_hook.mjs documents the fields). When anything fails it says allow,
// with nothing to read.

import { parseClaudeShaped } from './claude.mjs';

const said = (event, result) =>
  JSON.stringify({
    agentmash: 1,
    event,
    action: ['allow', 'advise', 'deny'].includes(result?.action) ? result.action : 'allow',
    level: typeof result?.level === 'string' ? result.level : null,
    text: typeof result?.text === 'string' && result.text ? result.text : null,
    files: Array.isArray(result?.files) ? result.files : [],
    strict: result?.strict === true,
  }) + '\n';

export default {
  name: 'json',
  parse: parseClaudeShaped,
  answer(event, result) {
    return { stdout: said(event, result) };
  },
  neutral(event) {
    return { stdout: said(event, null) };
  },
};
