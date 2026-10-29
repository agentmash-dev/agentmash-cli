// Junie, JetBrains' coding agent, as its CLI runs it: the generic hook
// (hooks/agent_hook.mjs) in Junie's own dialect (hooks/dialects/junie.mjs),
// in the `hooks` of ~/.junie/config.json ($JUNIE_HOME), and our MCP server in
// ~/.junie/mcp/mcp.json. User level only: Junie ignores the hooks in a
// project's own .junie/config.json, and nothing goes into a repository anyway.
// Hooks there need no approval and no trust prompt; Junie reads them as a
// session starts. Its docs still call hooks early access, though they run in
// its stable builds.
//
// Four of Junie's seven events, and why:
//
//   SessionStart       runs in the background, and Junie ignores what it says:
//                      only to note which project a session works in, which a
//                      batch run, with no prompt hook, says nowhere else
//   UserPromptSubmit   the prompt's report, and the heads-up, which Junie puts
//                      in front of the prompt as context
//   PreToolUse         on Edit|Write: the advice before an edit, as context
//                      Junie adds to the model's for that step, without
//                      refusing it (a refusal only in the room's strict mode)
//   Stop               Junie has no hook after a tool runs, so an edit is
//                      reported once its file is seen to have changed: at the
//                      next edit, or here, as the task ends. It says nothing,
//                      ever: anything said at Stop sends the agent round again
//
// Not SessionEnd, which names no session and no project, and never
// PermissionRequest, where a hook that says nothing approves the action.
// Every command is the same string from one version of agentmash to the next,
// as for Codex: nothing in them changes but the hooks folder.
//
// Junie's config.json is read strictly (no comments, no trailing commas), so
// one that does not parse is left alone and said; and what is written back is
// laid out as the person had it, so that logout gives them back their file
// byte for byte.

import fs from 'node:fs';
import path from 'node:path';
import {
  PRIVATE,
  RUNS_OURS,
  SERVER_NAME,
  agentHookCommand,
  exists,
  hasServer,
  isOurGroup,
  isOurServer,
  mergeEntries,
  missingScripts,
  outcome,
  readJsonObject,
  removeEntries,
  removeFile,
  same,
  serverArgs,
  shown,
  which,
  writeFileSafely,
} from '../agent-kit.mjs';

/** Junie's home: its config.json, mcp/, sessions/ and the rest. */
const junieHome = (places) => process.env.JUNIE_HOME || path.join(places.home, '.junie');
/** Where the CLI keeps its builds; ~/.junie alone is no sign of it, since Junie in the IDE makes one too, and runs no hooks. */
const junieData = (places) => process.env.JUNIE_DATA || path.join(places.home, '.local', 'share', 'junie');

const files = (places) => ({
  config: path.join(junieHome(places), 'config.json'),
  mcp: path.join(junieHome(places), 'mcp', 'mcp.json'),
});

/** What login registers with Junie: the generic hook for four of its events, in Junie's dialect. */
export function junieHooks(hookDir) {
  const run = (event) => ({ type: 'command', command: agentHookCommand(hookDir, event, 'junie', { dialect: 'junie' }), timeout: 5 });
  return {
    SessionStart: [{ hooks: [run('session_start')] }],
    UserPromptSubmit: [{ hooks: [run('prompt')] }],
    // the documented edit tools; a matcher Junie cannot match is refused as an error
    PreToolUse: [{ matcher: 'Edit|Write', hooks: [run('pre_edit')] }],
    Stop: [{ hooks: [run('stop')] }],
  };
}

// ── the person's JSON, as they laid it out ──────────────────────────────────

/** How a JSON file is laid out: its indent (0 for all on one line), its line ends, and whether it ends with one. */
function layoutOf(text) {
  if (typeof text !== 'string' || !text.trim()) return { indent: 2, eol: '\n', last: true };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = text.trim().includes('\n') ? (/\n([ \t]+)"/.exec(text)?.[1] ?? 2) : 0;
  return { indent, eol, last: /\r?\n$/.test(text) };
}

/** `value` written to `file` laid out like `text`, what it held; `mode` is for a file that is new. */
function writeLike(file, value, text, { mode = PRIVATE } = {}) {
  const layout = layoutOf(text);
  // a newline inside a string is written \n by JSON.stringify: every one left is the layout's
  const body = JSON.stringify(value, null, layout.indent).replace(/\n/g, layout.eol);
  writeFileSafely(file, body + (layout.last ? layout.eol : ''), { mode });
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Whether a file that does not read as JSON has anything of ours in it, to be said by logout: one that cannot be read at all may. */
function mentionsOurs(file) {
  try {
    return RUNS_OURS.test(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return err?.code !== 'ENOENT';
  }
}

/** Our hooks out of config.json; `hooks` goes with them when they leave it empty, and the file when nothing else is in it. */
function removeHooks(file) {
  const read = readJsonObject(file);
  if (read.invalid) return { removed: false, invalid: mentionsOurs(file) };
  if (!read.existed || !isObject(read.value.hooks)) return { removed: false };
  const hooks = { ...read.value.hooks };
  if (!removeEntries(hooks, isOurGroup)) return { removed: false };
  const rest = { ...read.value, hooks };
  if (Object.keys(hooks).length === 0) delete rest.hooks;
  if (Object.keys(rest).length === 0) removeFile(file, '{}\n');
  else writeLike(file, rest, read.text);
  return { removed: true };
}

/** Our server into mcp.json: added, already, taken (an agentmash of someone else's) or invalid. */
function addOurServer(file, entry) {
  const read = readJsonObject(file);
  if (read.invalid) return { status: 'invalid' };
  const config = read.value;
  if (config.mcpServers !== undefined && !isObject(config.mcpServers)) return { status: 'invalid' };
  const servers = config.mcpServers ?? {};
  const current = servers[SERVER_NAME];
  if (current && !isOurServer(current)) return { status: 'taken' };
  if (current && same(current, entry)) return { status: 'already' };
  writeLike(file, { ...config, mcpServers: { ...servers, [SERVER_NAME]: entry } }, read.text);
  return { status: 'added' };
}

/** Our server out of mcp.json; the file goes when nothing else is in it, and mcp/ when that leaves it empty. */
function removeOurServer(file) {
  const read = readJsonObject(file);
  if (read.invalid) return { removed: false, invalid: mentionsOurs(file) };
  if (!read.existed || !isOurServer(read.value.mcpServers?.[SERVER_NAME])) return { removed: false };
  const servers = { ...read.value.mcpServers };
  delete servers[SERVER_NAME];
  const rest = { ...read.value, mcpServers: servers };
  if (Object.keys(servers).length === 0) delete rest.mcpServers;
  if (Object.keys(rest).length > 0) {
    writeLike(file, rest, read.text);
    return { removed: true };
  }
  removeFile(file, '{}\n');
  try {
    fs.rmdirSync(path.dirname(file)); // mcp/, when it held only ours
  } catch {
    // somebody else's is in it, or it is not there
  }
  return { removed: true };
}

export default {
  id: 'junie',
  name: 'Junie',
  order: 50,
  env: ['JUNIE_HOME', 'JUNIE_DATA'],
  files,
  hooks: junieHooks,
  detect(places) {
    const bin = which('junie', places.toolPath);
    return { found: Boolean(bin) || exists(junieData(places)), bin };
  },
  connect(places, hookDir) {
    const at = files(places);
    const read = readJsonObject(at.config);
    if (read.invalid) return { status: 'skipped', why: `${shown(at.config, places)} is not valid JSON — fix it, then run login again` };
    const config = read.value;
    if (config.hooks !== undefined && !isObject(config.hooks)) {
      return { status: 'skipped', why: `"hooks" in ${shown(at.config, places)} is not an object — fix it, then run login again` };
    }
    const hooks = { ...(config.hooks ?? {}) };
    const changed = mergeEntries(hooks, junieHooks(hookDir), isOurGroup);
    if (changed) writeLike(at.config, { ...config, hooks }, read.text);
    const server = addOurServer(at.mcp, { command: 'node', args: serverArgs(hookDir) });
    const notes = [];
    if (server.status === 'taken') notes.push(`a server called agentmash is in ${shown(at.mcp, places)} already, and not ours: left as it is`);
    if (server.status === 'invalid') notes.push(`${shown(at.mcp, places)} is not valid JSON: the MCP server was not added`);
    const status = changed || server.status === 'added' ? 'connected' : 'already';
    if (status === 'connected') {
      notes.push('start a new Junie session: Junie reads its hooks as a session starts');
      notes.push('Junie asks before each agentmash MCP tool call, unless you allow them (brave mode, or a rule in ~/.junie/allowlist.json); login adds no such rule');
    }
    return { status, notes, where: shown(at.config, places) };
  },
  disconnect(places) {
    const at = files(places);
    return outcome([removeHooks(at.config), at.config, places], [removeOurServer(at.mcp), at.mcp, places]);
  },
  inspect(places) {
    const at = files(places);
    const read = readJsonObject(at.config);
    const hooks = isObject(read.value?.hooks) ? read.value.hooks : {};
    const ours = Object.values(hooks).flatMap((groups) => (Array.isArray(groups) ? groups.filter(isOurGroup) : []));
    const missing = missingScripts(ours.flatMap((g) => g.hooks));
    // Junie's dialect, beside the generic hook: without it every answer is silence, and nothing is reported
    for (const script of new Set(ours.flatMap((g) => g.hooks.map((h) => /"([^"]+agent_hook\.mjs)"/.exec(h?.command ?? '')?.[1]).filter(Boolean)))) {
      const dialect = path.join(path.dirname(script), 'dialects', 'junie.mjs');
      if (exists(script) && !exists(dialect)) missing.push(dialect);
    }
    return {
      connected: ours.length > 0,
      invalid: Boolean(read.invalid),
      where: shown(at.config, places),
      events: Object.keys(hooks).filter((e) => Array.isArray(hooks[e]) && hooks[e].some(isOurGroup)),
      missing,
      mcp: hasServer(at.mcp, 'mcpServers'),
    };
  },
};
