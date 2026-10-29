// goose (aaif-goose/goose, once block/goose): a plugin folder of our own,
// ~/.agents/plugins/agentmash, holding hooks/hooks.json and the MCP server in
// .mcp.json. goose finds every folder under ~/.agents/plugins as a plugin,
// with no approval and no manifest needed, in each session it starts (the
// CLI, goose Desktop and `goose acp` alike); the folder's name is how goose
// names us when a hook refuses a call. Checked against goose v1.53.0's source
// (crates/goose/src/hooks/mod.rs, plugins/discovery.rs, plugins/mcp_servers.rs).
//
// Nothing here touches goose's own config.yaml: goose rewrites that file
// whole, so a key of ours could only go in by rewriting the person's file,
// and the plugin's .mcp.json gives the same server with nothing of theirs at
// stake. goose notes each plugin it finds in config.yaml itself
// (plugins: {<folder>: {enabled: true}}); that line is goose's, and stays
// after logout, keeping a person's `enabled: false` for the next login.
//
// goose runs each hook as `sh -c <command>`, on every OS, and reads exit
// status 2 as a refusal of the call: a command the shell cannot parse would
// refuse every edit. So the hooks folder's path goes into one only when
// nothing in it means anything to the shell inside double quotes.

import fs from 'node:fs';
import path from 'node:path';
import {
  addServer,
  agentHookCommand,
  commandsOf,
  exists,
  hasServer,
  isOurGroup,
  mergeEntries,
  missingScripts,
  outcome,
  readJsonObject,
  realTarget,
  removeFromHooksFile,
  removeServer,
  serverArgs,
  shown,
  which,
  writeJson,
} from '../agent-kit.mjs';

/** The plugin folder's name, which goose says when one of our hooks refuses a call. */
const PLUGIN = 'agentmash';

/**
 * Where goose looks for plugins at user level: the home folder on every OS,
 * or GOOSE_PATH_ROOT when that is an absolute path (goose ignores it otherwise).
 */
const root = () => {
  const given = process.env.GOOSE_PATH_ROOT;
  return given && path.isAbsolute(given) ? given : null;
};
const pluginsDir = (places) => path.join(root() ?? places.home, '.agents', 'plugins');

/**
 * goose's own folders, for finding it (config/paths.rs): config.yaml once it
 * has been set up, its sessions once it has run.
 */
function gooseDirs(places) {
  if (root()) return [path.join(root(), 'config'), path.join(root(), 'data')];
  if (process.platform === 'win32') {
    const block = path.join(process.env.APPDATA || path.join(places.home, 'AppData', 'Roaming'), 'Block', 'goose');
    return [path.join(block, 'config'), path.join(block, 'data')];
  }
  return [
    path.join(process.env.XDG_CONFIG_HOME || path.join(places.home, '.config'), 'goose'),
    path.join(process.env.XDG_DATA_HOME || path.join(places.home, '.local', 'share'), 'goose'),
  ];
}

const files = (places) => {
  const plugin = path.join(pluginsDir(places), PLUGIN);
  return { hooks: path.join(plugin, 'hooks', 'hooks.json'), mcp: path.join(plugin, '.mcp.json') };
};

/**
 * Tools that write a file, by their name after any `<extension>__`: goose's
 * own categorize_tool (agents/agent.rs), which also decides when it sends
 * AfterFileEdit. A matcher is a regular expression, unanchored, tried on the
 * tool's name.
 */
const FILE_TOOLS = '(^|__)(write|edit|patch|write_file|edit_file)$';
/** Its developer extension's shell, and any extension's tool of that name. */
const SHELL_TOOLS = '(^|__)shell$';

/**
 * What login registers with goose: the generic hook in goose's dialect, for
 * each of goose's events it reads. Before an edit, the advice (goose can only
 * refuse a call, so it refuses the first try: see hooks/dialects/goose.mjs);
 * after one, its report, and after a shell command the files it changed; the
 * prompt, the session's start (a banner for the person, in the goose CLI)
 * and its end (sent by the goose CLI only). No Stop: what it would say is for
 * the person, and goose can only show a Stop hook's words to the model, by
 * keeping the turn going. No on_failure anywhere: left out, a hook that fails
 * lets the call through, and it must.
 */
export function gooseHooks(hookDir) {
  const run = (event) => ({ type: 'command', command: agentHookCommand(hookDir, event, 'goose', { dialect: 'goose' }), timeout: 5 });
  return {
    SessionStart: [{ hooks: [run('session_start')] }],
    UserPromptSubmit: [{ hooks: [run('prompt')] }],
    PreToolUse: [{ matcher: FILE_TOOLS, hooks: [run('pre_edit')] }],
    AfterFileEdit: [{ hooks: [run('post_edit')] }],
    PostToolUse: [{ matcher: SHELL_TOOLS, hooks: [run('post_edit')] }],
    SessionEnd: [{ hooks: [run('session_end')] }],
  };
}

/** What in a path would mean something to `sh -c` inside double quotes, or turn a backslash into an escape. */
const UNQUOTABLE = process.platform === 'win32' ? /["`$\r\n]|\\\\/ : /["`$\\\r\n]/;

/** The groups of ours in a hooks object. */
const oursIn = (hooks) => Object.values(hooks).flatMap((groups) => (Array.isArray(groups) ? groups.filter(isOurGroup) : []));

/** A goose command that is goose's: brew's block-goose-cli or the app's, or one goose's own installer put in ~/.local/bin. */
function isGooseCommand(bin, places) {
  if (!bin) return false;
  if (/block-goose|Goose\.app/i.test(realTarget(bin))) return true;
  return path.dirname(bin) === path.join(places.home, '.local', 'bin');
}

export default {
  id: 'goose',
  name: 'goose',
  order: 50,
  // XDG_DATA_HOME: where its sessions are, off Windows (XDG_CONFIG_HOME every test sets itself)
  env: ['GOOSE_PATH_ROOT', 'XDG_DATA_HOME'],
  files,
  hooks: gooseHooks,
  detect(places) {
    // pressly/goose, the database migration tool, is a `goose` command too:
    // a command by that name counts only where it is goose's, or beside goose's folder or app
    const bin = which('goose', places.toolPath);
    const found =
      gooseDirs(places).some(exists) ||
      Boolean(places.apps && exists(path.join(places.apps, 'Goose.app'))) ||
      isGooseCommand(bin, places);
    return { found, bin: found ? bin : null };
  },
  connect(places, hookDir) {
    const at = files(places);
    if (UNQUOTABLE.test(hookDir)) {
      return { status: 'skipped', why: `goose runs hooks through sh, and ${shown(hookDir, places)} cannot be quoted for it safely` };
    }
    const read = readJsonObject(at.hooks);
    if (read.invalid) return { status: 'skipped', why: `${shown(at.hooks, places)} is not valid JSON — fix it, then run login again` };
    const config = read.value;
    const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks) ? config.hooks : {};
    const changed = mergeEntries(hooks, gooseHooks(hookDir), isOurGroup);
    if (changed) writeJson(at.hooks, { ...config, hooks });
    const server = addServer(at.mcp, 'mcpServers', { command: 'node', args: serverArgs(hookDir), env: {} });
    const notes = [];
    if (server.status === 'taken') notes.push(`a server called agentmash is in ${shown(at.mcp, places)} already, and not ours: left as it is`);
    if (server.status === 'invalid') notes.push(`${shown(at.mcp, places)} is not valid JSON: the MCP server was not added`);
    const status = changed || server.status === 'added' ? 'connected' : 'already';
    if (status === 'connected') {
      notes.push(
        'goose shows the agent a warning by refusing its first edit of a file a teammate is in, and calls that a policy denial; the same edit again goes through'
      );
      notes.push('goose runs these from the next session it starts; one open now keeps the hooks it started with');
      if (process.platform === 'win32') notes.push('goose runs hooks with sh, which Windows has with Git Bash: without it, they do not run');
    }
    return { status, notes, where: shown(at.hooks, places) };
  },
  disconnect(places) {
    const at = files(places);
    const hooks = removeFromHooksFile(at.hooks, isOurGroup, ['hooks']);
    const server = removeServer(at.mcp, 'mcpServers');
    // the folders made for them, when nothing else is in them
    for (const dir of [path.dirname(at.hooks), path.dirname(at.mcp)]) {
      try {
        fs.rmdirSync(dir);
      } catch {
        // not empty, or not there
      }
    }
    return outcome([hooks, at.hooks, places], [server, at.mcp, places]);
  },
  inspect(places) {
    const at = files(places);
    const read = readJsonObject(at.hooks);
    const hooks = read.value?.hooks && typeof read.value.hooks === 'object' ? read.value.hooks : {};
    const ours = oursIn(hooks);
    const entries = ours.flatMap((group) => group.hooks);
    // the generic hook answers goose in goose's dialect, a file beside it: without it, every hook says nothing
    const missing = missingScripts(entries);
    for (const script of new Set(entries.flatMap(commandsOf).map((c) => /"([^"]*agent_hook\.mjs)"/.exec(c)?.[1]).filter(Boolean))) {
      const dialect = path.join(path.dirname(script), 'dialects', 'goose.mjs');
      if (exists(script) && !exists(dialect)) missing.push(dialect);
    }
    return {
      connected: ours.length > 0,
      invalid: Boolean(read.invalid),
      where: shown(at.hooks, places),
      events: Object.keys(hooks).filter((e) => Array.isArray(hooks[e]) && hooks[e].some(isOurGroup)),
      missing,
      mcp: hasServer(at.mcp, 'mcpServers'),
    };
  },
};
