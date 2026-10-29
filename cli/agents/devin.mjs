// Devin: nothing of its own. It runs the hooks login puts in Claude Code's
// own settings (~/.claude/settings.json), which is why it is only ever
// "already" connected, and why `tools` and doctor say so instead of looking
// for files of its own.

import path from 'node:path';
import { exists, which } from '../agent-kit.mjs';

export default {
  id: 'devin',
  name: 'Devin',
  order: 40,
  env: [],
  readsClaude: true,
  files: () => ({}),
  hooks: () => ({}),
  detect(places) {
    const bin = which('devin', places.toolPath);
    return { found: Boolean(bin) || exists(path.join(places.home, '.config', 'devin')), bin };
  },
  connect() {
    return { status: 'already', notes: ["it runs the hooks login put in Claude Code's own settings (~/.claude/settings.json): nothing of its own to add"] };
  },
  disconnect() {
    return { status: 'absent' };
  },
  inspect() {
    return { connected: true, events: [], missing: [], readsClaude: true };
  },
};
