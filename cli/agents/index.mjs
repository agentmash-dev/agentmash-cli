// Every coding agent `npx agentmash login` connects beside Claude Code, one
// module each in this folder, read from the folder itself: an agent added
// here is connected, listed by `tools`, checked by doctor and taken out by
// logout with no line written anywhere else. They come in the order each
// module gives (`order`, then id), which is the order they are listed and
// connected in; Claude Code's half is in agentmash.mjs and always comes first.
//
// Each module's default export is one agent:
//
//   id            its name on the command line (`tools add <id>`, --skip), the
//                 module's file name, and the --client its hooks run with
//   name          the name it goes by, as its maker spells it
//   order         where it comes in the list; the agents here before any
//                 other are 10, 20, 30 and 40, the ones with hooks added since
//                 are 50 (so they come by id), and the MCP-only ones 60
//   env           the environment variables it reads its folders from, which
//                 tests clear so a developer's own configuration never leaks in
//   scripts       optional: [source under clients/, name it is copied to beside
//                 the hooks] for an adapter of its own (Cursor's)
//   files(places) every file connecting it writes, by role, whether or not it is
//                 there: logout keeps the hooks folder while any still names it
//   hooks(hookDir)  what it registers, pure: the same strings on every run
//   detect(places)  { found, bin }: never looks anywhere `places` does not name
//   connect(places, hookDir)     { status: connected | already | skipped, why?, notes, where }
//   disconnect(places, hookDir)  { status: removed | absent, invalid }
//   inspect(places)              { connected, invalid, where, events, missing, mcp, approval? }
//   approvalHint  optional: what the person does before the agent runs our
//                 hooks ({ short, long, approvedIn }), when inspect counts approvals
//   readsClaude   optional: true when it runs Claude Code's hooks and has none of its own
//   optIn         optional: true when only `tools add <id>` or `login --tools` connects it; a
//                 plain login skips it until it is connected, then keeps it up to date
//   mcpOnly       optional: true when it has no hooks at all and login registers its MCP
//                 server alone (Continue, Zed); inspect's events are then []
//
// inspect may also give `warnings` (the agent's own settings switch ours off)
// and `notes` (what it needs besides, such as a folder it trusts), which
// doctor prints under the agent's line.
//
// A file whose name starts with _ is a helper some agents share, not an agent.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID = /^[a-z][a-z0-9-]{0,20}$/;
const NEEDS = ['files', 'hooks', 'detect', 'connect', 'disconnect', 'inspect'];

/** What is wrong with the agent a module exports, or null. A broken module is a packaging mistake, said by file. */
function problemOf(agent, file) {
  if (!agent || typeof agent !== 'object') return 'has no default export';
  if (!ID.test(agent.id ?? '')) return `id ${JSON.stringify(agent.id)} is not a short lowercase name`;
  if (`${agent.id}.mjs` !== file) return `id ${agent.id} is not its file's name`;
  if (typeof agent.name !== 'string' || !agent.name) return 'has no name';
  if (!Number.isFinite(agent.order)) return 'has no order';
  if (!Array.isArray(agent.env ?? [])) return 'env is not a list';
  const missing = NEEDS.filter((fn) => typeof agent[fn] !== 'function');
  if (missing.length) return `has no ${missing.join(', ')}`;
  return null;
}

const modules = fs
  .readdirSync(HERE)
  .filter((file) => file.endsWith('.mjs') && file !== 'index.mjs' && !file.startsWith('_'))
  .sort();
const loaded = await Promise.all(modules.map((file) => import(pathToFileURL(path.join(HERE, file)).href)));
const agents = loaded.map((module, i) => {
  const problem = problemOf(module.default, modules[i]);
  if (problem) throw new Error(`cli/agents/${modules[i]} ${problem}`);
  return module.default;
});
agents.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));

/** Each agent, by id, in order. */
export const AGENTS = Object.fromEntries(agents.map((agent) => [agent.id, agent]));
