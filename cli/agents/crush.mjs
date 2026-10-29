// Crush (charmbracelet/crush): the person's own user-level crush.json,
// $CRUSH_GLOBAL_CONFIG/crush.json when that is set, else
// $XDG_CONFIG_HOME/crush/crush.json, else ~/.config/crush/crush.json, on
// macOS and Windows too. One hook goes into its `hooks`, after theirs, and our
// MCP server into its `mcp`, beside theirs; both come out again by the script
// each one runs, from a .agentmash/hooks folder, and nothing else in the file
// is touched. The hook is the generic one (hooks/agent_hook.mjs) with --client
// crush, which reads Crush's payload and answers in its words
// (hooks/dialects/crush.mjs). Never the data file in ~/.local/share/crush,
// which Crush writes itself, and never a project's. Crush rewrites this one
// only to take out two settings it no longer reads
// (options.disable_notifications and notification_style), which keeps ours.
//
// Why the entries are what they are, from Crush's source (v0.63.0, where
// hooks began, to v0.97.1):
//
// - PreToolUse is the only event Crush has: nothing after a tool, at a prompt
//   or around a session. So the one hook goes before Crush's file tools, and
//   the dialect reports an edit once it sees the file change (see there):
//   Crush's prompts, sessions and shell commands are not reported.
// - Before a tool, a hook can refuse it, with a reason the model reads and
//   goes on from, or add a note for the model that arrives with the tool's
//   result, after it ran. So the warning before an edit is a refusal of the
//   first try at a file a teammate's agent is in, and the same edit again goes
//   through. A hook's "allow" would skip the person's permission prompt:
//   nothing of ours ever says it, and nothing here writes a permission or an
//   allowed_tools entry, so Crush asks before each call of our MCP tools as it
//   does for any server's.
// - The matcher is a regular expression Crush tests unanchored against the
//   tool's name, so it is anchored here: `edit` alone would match multiedit
//   and any MCP tool with edit in its name. The timeout is whole seconds.
// - Crush runs the command through a POSIX shell (sh -c before v0.67.0, its
//   own embedded one since), and expands $VAR, $(…), backticks and
//   backslashes in an MCP server's command and args as it starts one: a hooks
//   folder whose path has any of those, or a double quote, in it is not
//   written into either, and said.
// - crush.json is read as strict JSON: Crush does not start with comments or
//   a trailing comma in it, nor with a hook that has no command or a matcher
//   that does not compile. So a file that does not read is left exactly as it
//   is, and said, and what is written always reads.
// - Crush asks the person nothing before running a hook or a server from the
//   user's own configuration, and loads them as it starts: restarting a
//   running Crush picks them up.
// - A rewrite keeps the file's own indentation and line endings, so logout
//   leaves the person's file byte for byte as login found it.

import fs from 'node:fs';
import path from 'node:path';
import {
  PRIVATE,
  RUNS_OURS,
  SERVER_NAME,
  agentHookCommand,
  exists,
  isOurEntry,
  isOurServer,
  mergeEntries,
  missingScripts,
  outcome,
  removeEntries,
  removeFile,
  same,
  serverArgs,
  shown,
  which,
  writeFileSafely,
} from '../agent-kit.mjs';

const ID = 'crush';
const EVENT = 'PreToolUse';

/**
 * Crush's tools that change a file they name (internal/agent/tools), anchored.
 * Not bash, which names no file, and not lsp_rename, which changes files it
 * does not name.
 */
export const EDIT_MATCHER = '^(edit|multiedit|write|lsp_replace_symbol|download)$';
/** Seconds: the generic hook gives up on the room well inside this (1.5 s by default), and Crush lets the edit go on if it ever ran out. */
const TIMEOUT_S = 5;

/** The folder Crush reads its user-level configuration from (config.GlobalConfig, home.Config). */
function configDir(places) {
  if (process.env.CRUSH_GLOBAL_CONFIG) return path.resolve(process.env.CRUSH_GLOBAL_CONFIG);
  return path.join(process.env.XDG_CONFIG_HOME ? path.resolve(process.env.XDG_CONFIG_HOME) : path.join(places.home, '.config'), 'crush');
}

/** The folder Crush keeps its own state in once it has run (config.GlobalConfigData): only looked at, never written. */
function dataDir(places) {
  if (process.env.CRUSH_GLOBAL_DATA) return path.resolve(process.env.CRUSH_GLOBAL_DATA);
  if (process.env.XDG_DATA_HOME) return path.join(path.resolve(process.env.XDG_DATA_HOME), 'crush');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(places.home, 'AppData', 'Local'), 'crush');
  return path.join(places.home, '.local', 'share', 'crush');
}

export const configFile = (places) => path.join(configDir(places), 'crush.json');
const files = (places) => ({ config: configFile(places) });

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * What in a path Crush's shell would read as something else in the command's
 * double quotes, or in an MCP server's args: a variable, a command, a double
 * quote or an escape (on Windows a backslash is a separator, and stays one
 * unless two come together).
 */
const UNSAFE = process.platform === 'win32' ? /[$`"]|\\\\/ : /[$`"\\]/;

/**
 * What login registers with Crush: one hook, named so Crush's TUI says whose
 * it is, before the file tools. The same string every time for the same
 * folder: nothing in it changes from one version of agentmash to the next.
 */
export function crushHooks(hookDir) {
  return {
    [EVENT]: [{ name: 'agentmash-pre-edit', matcher: EDIT_MATCHER, command: agentHookCommand(hookDir, 'pre_edit', ID), timeout: TIMEOUT_S }],
  };
}

/** Our MCP server, as Crush's `mcp` names a stdio one (its type is required). */
const serverEntry = (hookDir) => ({ type: 'stdio', command: 'node', args: serverArgs(hookDir) });

// ── the configuration file ──────────────────────────────────────────────────

/** How a file is laid out: its indentation, its line ending, and whether it ends in one. */
function styleOf(text) {
  if (typeof text !== 'string' || !text.trim()) return { indent: 2, eol: '\n', end: true };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const first = /\n([ \t]+)\S/.exec(text);
  return { indent: first ? first[1] : text.trim().includes('\n') ? 2 : 0, eol, end: /\n$/.test(text) };
}

function format(value, style) {
  let out = JSON.stringify(value, null, style.indent);
  if (style.eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  return style.end ? out + style.eol : out;
}

/**
 * crush.json: { value, existed, text, style }, or { invalid } when it does
 * not read as a JSON object, as Crush reads it (or cannot be read at all: a
 * file that is there is never taken for one that is not, and written over).
 */
export function readConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' ? { value: {}, existed: false, style: styleOf('') } : { invalid: true, existed: true, text: '' };
  }
  if (!text.trim()) return { value: {}, existed: true, text, style: styleOf('') };
  try {
    const value = JSON.parse(text);
    if (isObject(value)) return { value, existed: true, text, style: styleOf(text) };
  } catch {
    // below
  }
  return { invalid: true, existed: true, text };
}

/** What in the person's file stops our server running: said on login and by doctor. */
function switchedOff(config, at) {
  const server = config?.mcp?.[SERVER_NAME];
  return isOurServer(server) && server.disabled === true ? [`the MCP server is switched off in ${at} ("disabled": true): Crush does not start it`] : [];
}

const DENY_ONCE =
  "Crush shows the model a hook's note only after the edit: its first edit of a file a teammate's agent is in is refused once, with the warning as the reason, and the same edit again goes through";
const REPORTS =
  'Crush has no hook after an edit, at a prompt or around a session: an edit is reported once the file changes, and prompts, sessions and shell commands are not';
const RESTART = 'Crush runs this hook from v0.63.0 on, and loads it as it starts: restart Crush if it is running';

export default {
  id: ID,
  name: 'Crush',
  order: 50,
  env: ['CRUSH_GLOBAL_CONFIG', 'CRUSH_GLOBAL_DATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'],
  files,
  hooks: crushHooks,
  detect(places) {
    const bin = which('crush', places.toolPath);
    let configured = false;
    try {
      configured = fs.readdirSync(configDir(places)).length > 0;
    } catch {
      // no folder of Crush's configuration
    }
    return { found: Boolean(bin) || configured || exists(dataDir(places)), bin };
  },
  connect(places, hookDir) {
    const file = configFile(places);
    const at = shown(file, places);
    if (UNSAFE.test(hookDir)) {
      return { status: 'skipped', why: `${hookDir} has a $, a backtick, a double quote or a backslash in its path, which Crush's shell would read as part of the command` };
    }
    const read = readConfig(file);
    if (read.invalid) return { status: 'skipped', why: `${at} is not valid JSON, which Crush needs to start at all — fix it, then run login again` };
    const config = read.value;
    if (config.hooks !== undefined && !isObject(config.hooks)) return { status: 'skipped', why: `${at} has a "hooks" that is not an object — fix it, then run login again` };
    const hooks = isObject(config.hooks) ? config.hooks : {};
    if (hooks[EVENT] !== undefined && !Array.isArray(hooks[EVENT])) {
      return { status: 'skipped', why: `${at} has a "hooks.${EVENT}" that is not a list — fix it, then run login again` };
    }
    const hooksChanged = mergeEntries(hooks, crushHooks(hookDir), isOurEntry);

    const notes = [];
    let servers = config.mcp;
    let serverChanged = false;
    if (servers !== undefined && !isObject(servers)) notes.push(`${at} has an "mcp" that is not an object: the MCP server was not added`);
    else if (servers?.[SERVER_NAME] && !isOurServer(servers[SERVER_NAME])) {
      notes.push(`a server called agentmash is in ${at} already, and not ours: left as it is`);
    } else {
      // ours, with anything the person set on it (disabled, a timeout) kept
      const current = servers?.[SERVER_NAME];
      const entry = isObject(current) ? { ...current, ...serverEntry(hookDir) } : serverEntry(hookDir);
      if (!same(current, entry)) {
        servers = { ...(servers ?? {}), [SERVER_NAME]: entry };
        serverChanged = true;
      }
    }

    if (hooksChanged || serverChanged) {
      const next = { ...config, hooks, ...(servers !== undefined ? { mcp: servers } : {}) };
      // MCP servers can carry tokens: a crush.json made here is private
      writeFileSafely(file, format(next, read.style), { mode: PRIVATE });
    }
    const status = hooksChanged || serverChanged ? 'connected' : 'already';
    notes.push(...switchedOff({ mcp: servers }, at));
    if (status === 'connected') notes.push(DENY_ONCE, REPORTS, RESTART);
    return { status, notes, where: at };
  },
  disconnect(places) {
    const file = configFile(places);
    const read = readConfig(file);
    if (read.invalid) return outcome([{ removed: false, invalid: !read.text || RUNS_OURS.test(read.text) }, file, places]);
    if (!read.existed) return outcome([{ removed: false }, file, places]);
    const config = read.value;
    const hooks = isObject(config.hooks) ? config.hooks : null;
    const hooksOut = hooks ? removeEntries(hooks, isOurEntry) : false;
    const servers = isObject(config.mcp) ? config.mcp : null;
    const serverOut = Boolean(servers && isOurServer(servers[SERVER_NAME]));
    if (!hooksOut && !serverOut) return outcome([{ removed: false }, file, places]);
    const next = { ...config };
    if (hooksOut && Object.keys(hooks).length === 0) delete next.hooks;
    if (serverOut) {
      const rest = { ...servers };
      delete rest[SERVER_NAME];
      if (Object.keys(rest).length) next.mcp = rest;
      else delete next.mcp;
    }
    if (Object.keys(next).length === 0) removeFile(file, '{}\n');
    else writeFileSafely(file, format(next, read.style), { mode: PRIVATE });
    return outcome([{ removed: true }, file, places]);
  },
  inspect(places) {
    const file = configFile(places);
    const at = shown(file, places);
    const read = readConfig(file);
    const config = read.value ?? {};
    const hooks = isObject(config.hooks) ? config.hooks : {};
    const ours = Object.values(hooks).flatMap((list) => (Array.isArray(list) ? list.filter(isOurEntry) : []));
    return {
      connected: ours.length > 0,
      invalid: Boolean(read.invalid),
      where: at,
      events: Object.keys(hooks).filter((e) => Array.isArray(hooks[e]) && hooks[e].some(isOurEntry)),
      missing: missingScripts(ours),
      mcp: isOurServer(config.mcp?.[SERVER_NAME]),
      // what stops our server running, for doctor to warn about
      warnings: switchedOff(config, at),
    };
  },
};
