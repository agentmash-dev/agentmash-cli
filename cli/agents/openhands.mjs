// OpenHands: the generic hook (hooks/agent_hook.mjs) in OpenHands' dialect
// (hooks/dialects/openhands.mjs), for the two OpenHands that run hooks, each
// where it reads them at user level. Both run on the OpenHands Software Agent
// SDK, whose hooks are a hooks.json of Claude Code's shape; they differ in
// where they look for one. Checked against the SDK's source at v1.21.0 and
// v1.51.0, the CLI's at 1.16.0 and Agent Canvas's at 1.24.0:
//
// - The OpenHands CLI (PyPI `openhands`, 1.12.0 on; no longer maintained,
//   1.16.0 its last release) reads ~/.openhands/hooks.json, in the home
//   folder whatever OPENHANDS_PERSISTENCE_DIR says, and its MCP servers from
//   mcp.json in that persistence folder. It reads the hooks.json of the
//   folder it works in instead, when there is one: the first file found wins,
//   with no merge, so a repository with its own .openhands/hooks.json runs
//   only those.
// - Agent Canvas, its successor, reads no user hooks.json at all. It loads
//   every plugin folder under ~/.openhands/plugins (OH_PERSISTENCE_DIR when
//   set) into each new conversation, with no approval: login writes one,
//   agentmash-openhands, holding .plugin/plugin.json, hooks/hooks.json and
//   the MCP server in .mcp.json. Not "agentmash": goose's plugin folder of
//   that name, in ~/.agents/plugins, is one Agent Canvas loads too, and
//   finds first, and a second plugin of the same name would never load.
//
// Login writes for the one it finds on the machine (both, when it cannot tell
// them apart), and keeps up whatever of ours is already there.
//
// What is registered, and why:
//
//   PreToolUse        on the edit tools of every preset (file_editor,
//                     planning_file_editor, edit, write_file, apply_patch):
//                     the advice before an edit. OpenHands reads nothing a
//                     hook adds to a call it lets run, so the warning goes as
//                     a refusal of the first try (see the dialect), which the
//                     model reads; the same edit again goes through.
//   PostToolUse       on the same tools and `terminal`: the report. A command
//                     names no file, and the working tree says what it changed.
//   UserPromptSubmit  the prompt's report, and the heads-up as context the
//                     model reads with the prompt
//   SessionEnd        the session's end, for the board
//
// Not SessionStart, whose output reaches no model (and whose heads-up would
// count as the session's, so the first prompt would not give it), and not
// Stop, where anything but silence keeps the agent going.
//
// A matcher with a | in it is a regular expression OpenHands matches against
// the whole tool name; "*" is every call, and the only matcher an event with
// no tool matches. Timeouts are whole seconds. Every command is the same
// string from one version of agentmash to the next (as for Codex), run by
// `sh -c` in the workspace: a hooks folder whose path the shell would read
// something into inside double quotes is never written into one.
//
// hooks.json is read the way OpenHands reads it: events at the top, or under
// "hooks" (the only form with room for any other key), each in snake_case or
// PascalCase but never both, and nothing else. One OpenHands would refuse is
// left as it is and said; ours goes in under the spelling the file already
// uses. Every file is written back laid out as the person had it, so logout
// gives it back byte for byte.

import fs from 'node:fs';
import path from 'node:path';
import {
  PRIVATE,
  RUNS_OURS,
  SERVER_NAME,
  agentHookCommand,
  commandsOf,
  exists,
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

const ID = 'openhands';
/** The plugin folder's name, and the plugin's, in Agent Canvas's list of local plugins. */
const PLUGIN = 'agentmash-openhands';

/** The edit tools of every preset (openhands-tools at v1.51.0): file_editor's view comes too, and is read as a read. */
const EDIT_MATCHER = 'file_editor|planning_file_editor|edit|write_file|apply_patch';
/** What is reported after it runs: the edits, and a shell command, whose changes the working tree says (as Codex's Bash). */
const REPORT_MATCHER = `${EDIT_MATCHER}|terminal`;

/** An absolute folder from the environment, or null: a relative one would be relative to wherever OpenHands started. */
const envDir = (name) => {
  const given = process.env[name];
  return given && path.isAbsolute(given) ? given : null;
};
/** ~/.openhands: where the CLI's SDK reads the user hooks.json (Path.home(), at SDK 1.21.0). */
const userDir = (places) => path.join(places.home, '.openhands');
/** The CLI's own folder: mcp.json, agent_settings.json, cli_config.json. */
const cliDir = (places) => envDir('OPENHANDS_PERSISTENCE_DIR') ?? userDir(places);
/** Agent Canvas's: its agent server's plugins/, and the app's own agent-canvas/. */
const canvasDir = (places) => envDir('OH_PERSISTENCE_DIR') ?? userDir(places);
const pluginDir = (places) => path.join(canvasDir(places), 'plugins', PLUGIN);

const files = (places) => ({
  hooks: path.join(userDir(places), 'hooks.json'),
  mcp: path.join(cliDir(places), 'mcp.json'),
  pluginHooks: path.join(pluginDir(places), 'hooks', 'hooks.json'),
  pluginMcp: path.join(pluginDir(places), '.mcp.json'),
  manifest: path.join(pluginDir(places), '.plugin', 'plugin.json'),
});

/** What login registers with OpenHands: the generic hook, in OpenHands' dialect, for four of its events. */
export function openhandsHooks(hookDir) {
  const run = (event) => ({ type: 'command', command: agentHookCommand(hookDir, event, ID, { dialect: ID }), timeout: 5 });
  return {
    PreToolUse: [{ matcher: EDIT_MATCHER, hooks: [run('pre_edit')] }],
    PostToolUse: [{ matcher: REPORT_MATCHER, hooks: [run('post_edit')] }],
    UserPromptSubmit: [{ matcher: '*', hooks: [run('prompt')] }],
    SessionEnd: [{ matcher: '*', hooks: [run('session_end')] }],
  };
}

/** The plugin's manifest: fixed, so a second login finds it as it left it. Its version is the plugin's layout, not agentmash's. */
export const PLUGIN_MANIFEST = {
  name: PLUGIN,
  version: '1.0.0',
  description:
    "AgentMash: warns the agent before it edits a file a teammate's agent is in, and tells your team what it changed. Added by npx agentmash login; npx agentmash logout takes it out.",
};

/** What in a path would mean something to `sh -c` inside double quotes, or turn a backslash into an escape. */
const UNQUOTABLE = process.platform === 'win32' ? /["`$\r\n]|\\\\/ : /["`$\\\r\n]/;

// ── the person's JSON, as they laid it out ──────────────────────────────────

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** How a JSON file is laid out: its indent (0 for all on one line), its line ends, and whether it ends with one. */
function layoutOf(text) {
  if (typeof text !== 'string' || !text.trim()) return { indent: 2, eol: '\n', last: true };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = text.trim().includes('\n') ? (/\n([ \t]+)"/.exec(text)?.[1] ?? 2) : 0;
  return { indent, eol, last: /\r?\n$/.test(text) };
}

/** `value` written to `file` laid out like `text`, what it held; `mode` is for a file that is new. */
function writeLike(file, value, text, { mode = 0o644 } = {}) {
  const layout = layoutOf(text);
  // a newline inside a string is written \n by JSON.stringify: every one left is the layout's
  const body = JSON.stringify(value, null, layout.indent).replace(/\n/g, layout.eol);
  writeFileSafely(file, body + (layout.last ? layout.eol : ''), { mode });
}

/** Whether a file that does not read as JSON has anything of ours in it, to be said by logout: one that cannot be read at all may. */
function mentionsOurs(file) {
  try {
    return RUNS_OURS.test(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return err?.code !== 'ENOENT';
  }
}

// ── hooks.json, as OpenHands reads it ───────────────────────────────────────

/** Each event's two spellings (hooks/config.py): PascalCase, and snake_case. */
const SNAKE = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  UserPromptSubmit: 'user_prompt_submit',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  Stop: 'stop',
};
const PASCAL = Object.fromEntries(Object.entries(SNAKE).map(([pascal, snake]) => [snake, pascal]));

/**
 * A hooks.json: { events, wrapped, value, text } with `events` a copy of the
 * object the events are in; { invalid } when it is not JSON; { problem } when
 * OpenHands would refuse it, which is said, and the file left alone.
 */
function readHooks(file) {
  const read = readJsonObject(file);
  if (read.invalid) return { invalid: true };
  const value = read.value;
  // {"hooks": {...}} is unwrapped, and any other key beside it ignored; anything else is the events themselves
  const wrapped = 'hooks' in value;
  if (wrapped && !isObject(value.hooks)) return { problem: 'its "hooks" is not an object' };
  const events = { ...(wrapped ? value.hooks : value) };
  for (const [key, entries] of Object.entries(events)) {
    if (!SNAKE[key] && !PASCAL[key]) return { problem: `"${key}" in it is not an event OpenHands knows` };
    if (SNAKE[key] && SNAKE[key] in events) return { problem: `it has both ${key} and ${SNAKE[key]}` };
    if (!Array.isArray(entries)) return { problem: `its "${key}" is not a list` };
  }
  return { events, wrapped: wrapped || Object.keys(value).length === 0, value, text: read.text };
}

/** `want`'s events under the spelling the file uses: the event's own when it is there, else the file's. */
function spelled(events, want) {
  const snake = Object.keys(events).some((key) => PASCAL[key]);
  return Object.fromEntries(
    Object.entries(want).map(([event, groups]) => {
      const key = event in events ? event : SNAKE[event] in events ? SNAKE[event] : snake ? SNAKE[event] : event;
      return [key, groups];
    })
  );
}

/** Our hooks into a hooks.json: { status: changed | already | skipped, why }. */
function addHooks(file, want, places) {
  const read = readHooks(file);
  if (read.invalid) return { status: 'skipped', why: `${shown(file, places)} is not valid JSON — fix it, then run login again` };
  if (read.problem) return { status: 'skipped', why: `${shown(file, places)} is not one OpenHands can load: ${read.problem} — fix it, then run login again` };
  const { events } = read;
  if (!mergeEntries(events, spelled(events, want), isOurGroup)) return { status: 'already' };
  writeLike(file, read.wrapped ? { ...read.value, hooks: events } : events, read.text);
  return { status: 'changed' };
}

/** Our hooks out of a hooks.json; events left empty go, then "hooks", then the file. */
function removeHooks(file) {
  const read = readJsonObject(file);
  if (read.invalid) return { removed: false, invalid: mentionsOurs(file) };
  if (!read.existed) return { removed: false };
  const wrapped = isObject(read.value.hooks);
  const events = { ...(wrapped ? read.value.hooks : read.value) };
  if (!removeEntries(events, isOurGroup)) return { removed: false };
  const rest = wrapped ? { ...read.value, hooks: events } : events;
  if (wrapped && Object.keys(events).length === 0) delete rest.hooks;
  if (Object.keys(rest).length === 0) removeFile(file, '{}\n');
  else writeLike(file, rest, read.text);
  return { removed: true };
}

/** The groups of ours in a hooks.json, and the events they are in. */
function oursIn(file) {
  const read = readJsonObject(file);
  const value = read.value ?? {};
  const events = isObject(value.hooks) ? value.hooks : value;
  const groups = [];
  const named = [];
  for (const [key, list] of Object.entries(events)) {
    const mine = Array.isArray(list) ? list.filter(isOurGroup) : [];
    if (mine.length) named.push(PASCAL[key] ?? key);
    groups.push(...mine);
  }
  return { invalid: Boolean(read.invalid), groups, events: named };
}

// ── MCP servers ─────────────────────────────────────────────────────────────

/** The CLI's entry, as `openhands mcp add agentmash --transport stdio node -- <server>` writes one. */
const cliServer = (hookDir) => ({ command: 'node', args: serverArgs(hookDir), env: {}, transport: 'stdio' });
/** The plugin's, as a Claude Code plugin's .mcp.json has it. */
const pluginServer = (hookDir) => ({ command: 'node', args: serverArgs(hookDir) });

/** Our server into a file of mcpServers: added, already, taken (an agentmash of someone else's) or invalid. */
function addOurServer(file, entry) {
  const read = readJsonObject(file);
  if (read.invalid) return { status: 'invalid' };
  const config = read.value;
  if (config.mcpServers !== undefined && !isObject(config.mcpServers)) return { status: 'invalid' };
  const servers = config.mcpServers ?? {};
  const current = servers[SERVER_NAME];
  if (current && !isOurServer(current)) return { status: 'taken' };
  // `openhands mcp disable agentmash` writes enabled: false, and that is the person's to keep
  const want = isObject(current) && 'enabled' in current ? { ...entry, enabled: current.enabled } : entry;
  if (current && same(current, want)) return { status: 'already' };
  // MCP servers can carry tokens: a file made here is private
  writeLike(file, { ...config, mcpServers: { ...servers, [SERVER_NAME]: want } }, read.text, { mode: PRIVATE });
  return { status: 'added' };
}

/** Our server out of a file of mcpServers; the file goes when nothing else is in it. */
function removeOurServer(file) {
  const read = readJsonObject(file);
  if (read.invalid) return { removed: false, invalid: mentionsOurs(file) };
  if (!read.existed || !isOurServer(read.value.mcpServers?.[SERVER_NAME])) return { removed: false };
  const servers = { ...read.value.mcpServers };
  delete servers[SERVER_NAME];
  const rest = { ...read.value, mcpServers: servers };
  if (Object.keys(servers).length === 0) delete rest.mcpServers;
  if (Object.keys(rest).length === 0) removeFile(file, '{}\n');
  else writeLike(file, rest, read.text);
  return { removed: true };
}

const hasOurServer = (file) => isOurServer(readJsonObject(file).value?.mcpServers?.[SERVER_NAME]);

// ── the two OpenHands ───────────────────────────────────────────────────────

/** Which OpenHands are on this machine: the CLI by its command or its settings, Agent Canvas by its command, app or folder. */
function found(places) {
  const cli =
    Boolean(which('openhands', places.toolPath)) ||
    exists(path.join(cliDir(places), 'agent_settings.json')) ||
    exists(path.join(cliDir(places), 'cli_config.json'));
  const canvas =
    Boolean(which('agent-canvas', places.toolPath)) ||
    Boolean(places.apps && exists(path.join(places.apps, 'OpenHands Agent Canvas.app'))) ||
    exists(path.join(canvasDir(places), 'agent-canvas'));
  return { cli, canvas };
}

/** Where login writes: each OpenHands found, each that holds ours already, and both when neither is told apart. */
function routes(places) {
  const at = files(places);
  const { cli, canvas } = found(places);
  const want = {
    cli: cli || oursIn(at.hooks).groups.length > 0 || hasOurServer(at.mcp),
    canvas: canvas || oursIn(at.pluginHooks).groups.length > 0 || hasOurServer(at.pluginMcp),
  };
  return want.cli || want.canvas ? want : { cli: true, canvas: true };
}

/** The plugin's manifest: written when there is none, and left as it is when someone has changed it. */
function writeManifest(file) {
  const read = readJsonObject(file);
  if (read.existed) return { status: same(read.value, PLUGIN_MANIFEST) ? 'already' : 'kept' };
  writeLike(file, PLUGIN_MANIFEST, '');
  return { status: 'added' };
}

/** The plugin's folders, once nothing of ours is left in them: the manifest when it is ours, then whatever is empty. */
function removePluginShell(places) {
  const at = files(places);
  if (exists(at.pluginHooks) || exists(at.pluginMcp)) return;
  const manifest = readJsonObject(at.manifest);
  if (manifest.existed && !manifest.invalid && same(manifest.value, PLUGIN_MANIFEST)) fs.rmSync(at.manifest, { force: true });
  for (const dir of [path.dirname(at.manifest), path.dirname(at.pluginHooks), pluginDir(places)]) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // not empty, or not there
    }
  }
}

const DENY_ONCE =
  "before an edit OpenHands can only let it run or refuse it: its first edit of a file a teammate's agent is in is refused once, with the warning as the reason, and the same edit again goes through";
const CLI_NOTE =
  'the OpenHands CLI runs these from 1.12.0 on, in new conversations, and not in a folder with a .openhands/hooks.json of its own: it reads that one instead';
const CANVAS_NOTE = `Agent Canvas loads the ${PLUGIN} plugin into each new conversation its agent server runs on this machine`;

export default {
  id: ID,
  name: 'OpenHands',
  order: 50,
  env: ['OPENHANDS_PERSISTENCE_DIR', 'OH_PERSISTENCE_DIR'],
  files,
  hooks: openhandsHooks,
  detect(places) {
    // the version `tools` asks for is the CLI's: agent-canvas starts a server when run
    const bin = which('openhands', places.toolPath);
    const { cli, canvas } = found(places);
    return { found: cli || canvas || exists(userDir(places)), bin };
  },
  connect(places, hookDir) {
    if (UNQUOTABLE.test(hookDir)) {
      return { status: 'skipped', why: `OpenHands runs hooks through sh, and ${shown(hookDir, places)} cannot be quoted for it safely` };
    }
    const at = files(places);
    const want = routes(places);
    const hooks = openhandsHooks(hookDir);
    const notes = [];
    const where = [];
    const skipped = [];
    let changed = false;

    const server = (file, entry) => {
      const result = addOurServer(file, entry);
      if (result.status === 'taken') notes.push(`a server called agentmash is in ${shown(file, places)} already, and not ours: left as it is`);
      if (result.status === 'invalid') notes.push(`${shown(file, places)} is not valid JSON: the MCP server was not added`);
      return result.status === 'added';
    };

    if (want.cli) {
      const result = addHooks(at.hooks, hooks, places);
      if (result.status === 'skipped') skipped.push(result.why);
      else {
        where.push(shown(at.hooks, places));
        if (result.status === 'changed') changed = true;
        if (server(at.mcp, cliServer(hookDir))) changed = true;
      }
    }
    if (want.canvas) {
      const result = addHooks(at.pluginHooks, hooks, places);
      if (result.status === 'skipped') skipped.push(result.why);
      else {
        where.push(shown(pluginDir(places), places));
        if (result.status === 'changed') changed = true;
        if (server(at.pluginMcp, pluginServer(hookDir))) changed = true;
        if (writeManifest(at.manifest).status === 'added') changed = true;
      }
    }

    if (where.length === 0) return { status: 'skipped', why: skipped.join('; ') };
    notes.unshift(...skipped);
    if (changed) {
      notes.push(DENY_ONCE);
      if (where.includes(shown(at.hooks, places))) notes.push(CLI_NOTE);
      if (where.includes(shown(pluginDir(places), places))) notes.push(CANVAS_NOTE);
    }
    return { status: changed ? 'connected' : 'already', notes, where: where.join(' and ') };
  },
  disconnect(places) {
    const at = files(places);
    const results = [
      [removeHooks(at.hooks), at.hooks, places],
      [removeOurServer(at.mcp), at.mcp, places],
      [removeHooks(at.pluginHooks), at.pluginHooks, places],
      [removeOurServer(at.pluginMcp), at.pluginMcp, places],
    ];
    removePluginShell(places);
    return outcome(...results);
  },
  inspect(places) {
    const at = files(places);
    const cli = oursIn(at.hooks);
    const plugin = oursIn(at.pluginHooks);
    const entries = [...cli.groups, ...plugin.groups].flatMap((group) => group.hooks);
    // OpenHands' dialect, beside the generic hook: without it every answer is Claude Code's, which OpenHands does not read
    const missing = missingScripts(entries);
    for (const script of new Set(entries.flatMap(commandsOf).map((c) => /"([^"]*agent_hook\.mjs)"/.exec(c)?.[1]).filter(Boolean))) {
      const dialect = path.join(path.dirname(script), 'dialects', `${ID}.mjs`);
      if (exists(script) && !exists(dialect)) missing.push(dialect);
    }
    // where to look: a file that does not read, else where ours is, else where the CLI's would be
    const invalid = [cli.invalid && at.hooks, plugin.invalid && at.pluginHooks].filter(Boolean);
    const connected = [cli.groups.length > 0 && at.hooks, plugin.groups.length > 0 && pluginDir(places)].filter(Boolean);
    const where = invalid.length ? invalid : connected.length ? connected : [at.hooks];
    return {
      connected: connected.length > 0,
      invalid: invalid.length > 0,
      where: where.map((file) => shown(file, places)).join(' and '),
      events: [...new Set([...cli.events, ...plugin.events])],
      missing,
      mcp: hasOurServer(at.mcp) || hasOurServer(at.pluginMcp),
    };
  },
};
