// Cursor: ~/.cursor/hooks.json and ~/.cursor/mcp.json, the Cursor adapter
// (clients/cursor/after_file_edit.mjs) with --global, which login copies
// beside the hooks as cursor_hook.mjs. Cursor drops a hook's
// additional_context, so the adapter speaks Cursor's own permission answers
// itself (see the adapter).

import path from 'node:path';
import {
  addServer,
  exists,
  hasServer,
  isOurEntry,
  mergeEntries,
  missingScripts,
  nodeCommand,
  outcome,
  readJsonObject,
  removeFromHooksFile,
  removeServer,
  serverArgs,
  shown,
  which,
  writeJson,
} from '../agent-kit.mjs';

/** The Cursor adapter, as login copies it beside the hooks. */
export const CURSOR_SCRIPT = 'cursor_hook.mjs';

const files = (places) => ({ hooks: path.join(places.cursor, 'hooks.json'), mcp: path.join(places.cursor, 'mcp.json') });

/** What login registers with Cursor: the Cursor adapter at user level. */
export function cursorHooks(hookDir) {
  const run = (extra = []) => nodeCommand(hookDir, CURSOR_SCRIPT, ['--global', ...extra]);
  return {
    // a permission hook: it always answers, and lets the edit through whenever it cannot ask
    preToolUse: [{ command: run(), matcher: 'Write', timeout: 5 }],
    afterFileEdit: [{ command: run(['--detach']), timeout: 5 }],
    beforeSubmitPrompt: [{ command: run(['--detach']), timeout: 5 }],
    sessionEnd: [{ command: run(['--detach']), timeout: 5 }],
  };
}

export default {
  id: 'cursor',
  name: 'Cursor',
  order: 20,
  env: [],
  // [source under clients/, the name login copies it to beside the hooks]
  scripts: [['cursor/after_file_edit.mjs', CURSOR_SCRIPT]],
  files,
  hooks: cursorHooks,
  detect(places) {
    const bin = which('cursor', places.toolPath);
    return { found: Boolean(bin) || exists(places.cursor) || Boolean(places.apps && exists(path.join(places.apps, 'Cursor.app'))), bin };
  },
  connect(places, hookDir) {
    const at = files(places);
    const read = readJsonObject(at.hooks);
    if (read.invalid) return { status: 'skipped', why: `${shown(at.hooks, places)} is not valid JSON — fix it, then run login again` };
    const config = read.value;
    const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks) ? config.hooks : {};
    const changed = mergeEntries(hooks, cursorHooks(hookDir), isOurEntry) || config.version !== 1;
    if (changed) writeJson(at.hooks, { version: 1, ...config, hooks });
    const server = addServer(at.mcp, 'mcpServers', { command: 'node', args: serverArgs(hookDir) });
    const notes = [];
    if (server.status === 'taken') notes.push(`a server called agentmash is in ${shown(at.mcp, places)} already, and not ours: left as it is`);
    if (server.status === 'invalid') notes.push(`${shown(at.mcp, places)} is not valid JSON: the MCP server was not added`);
    const status = changed || server.status === 'added' ? 'connected' : 'already';
    if (status === 'connected') {
      notes.push('Cursor shows the agent a warning by refusing its first edit of a file a teammate is in; the same edit again goes through');
    }
    return { status, notes, where: shown(at.hooks, places) };
  },
  disconnect(places) {
    const at = files(places);
    const hooks = removeFromHooksFile(at.hooks, isOurEntry, ['hooks', 'version']);
    const server = removeServer(at.mcp, 'mcpServers');
    return outcome([hooks, at.hooks, places], [server, at.mcp, places]);
  },
  inspect(places) {
    const at = files(places);
    const read = readJsonObject(at.hooks);
    const hooks = read.value?.hooks && typeof read.value.hooks === 'object' ? read.value.hooks : {};
    const ours = Object.values(hooks).flatMap((entries) => (Array.isArray(entries) ? entries.filter(isOurEntry) : []));
    return {
      connected: ours.length > 0,
      invalid: Boolean(read.invalid),
      where: shown(at.hooks, places),
      events: Object.keys(hooks).filter((e) => Array.isArray(hooks[e]) && hooks[e].some(isOurEntry)),
      missing: missingScripts(ours),
      mcp: hasServer(at.mcp, 'mcpServers'),
    };
  },
};
