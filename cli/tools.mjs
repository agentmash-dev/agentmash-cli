// The coding agents `npx agentmash login` connects, beside Claude Code, and
// what connecting each one writes. Everything here is at user level, in the
// agent's own configuration in the home directory: nothing goes into any
// repository, so nothing is committed, and `npx agentmash logout` takes out
// exactly what was put in, by recognising it, and nothing else.
//
// Each agent is a module of its own in agents/, which says what it writes and
// why (agents/index.mjs reads them all, in order); the helpers they share,
// for finding an agent and for writing someone else's file, are in
// agent-kit.mjs. This file is what the CLI imports: the registry, and the
// few things it asks of all the agents at once.
//
// Each agent runs the scripts login copies to ~/.agentmash/hooks. Ours is
// recognised by the path each command runs a script from, under a
// .agentmash/hooks folder, as the entries login puts in Claude Code's
// settings are; a server called agentmash is ours when it starts that
// folder's mcp_server.mjs. Anything else in these files is the person's, and
// is left as it was.

import { AGENTS } from './agents/index.mjs';

export { AGENTS };
export { agentHookCommand, agentPlaces, namesFolder, nodeCommand, shown, versionOf, which, writeFileSafely } from './agent-kit.mjs';
export { codexHooks, codexServerBlock } from './agents/codex.mjs';
export { CURSOR_SCRIPT, cursorHooks } from './agents/cursor.mjs';
export { copilotHooks } from './agents/copilot.mjs';

/** Every file login writes for the agents other than Claude Code, whether or not it is there. */
export function agentFiles(places) {
  return Object.values(AGENTS).flatMap((agent) => Object.values(agent.files(places) ?? {}));
}

/**
 * The scripts the agents run that are not hooks: each agent's own adapter, as
 * [source under clients/, name it is copied to beside the hooks].
 */
export function agentScripts() {
  return Object.values(AGENTS).flatMap((agent) => agent.scripts ?? []);
}
