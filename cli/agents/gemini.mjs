// Gemini CLI: the person's own ~/.gemini/settings.json ($GEMINI_CLI_HOME/.gemini
// when that is set). Our hooks go into its `hooks`, one matcher group per
// event, after theirs, and our MCP server into its `mcpServers`, beside
// theirs; both come out again by the script each one runs, from a
// .agentmash/hooks folder, and nothing else in the file is touched. Every hook
// is the generic one (hooks/agent_hook.mjs) with --client gemini, which reads
// Gemini CLI's payloads and answers in its words (hooks/dialects/gemini.mjs).
//
// Why the entries are what they are, from Gemini CLI's source (v0.62.0):
//
// - BeforeTool can let a tool run or refuse it, with a reason the model reads
//   as the tool's error, and the turn goes on; it has no way to add anything
//   for the model to a call it lets through. So the warning before an edit
//   goes as a refusal of the first try at the file, and the same edit again
//   goes through (the dialect's deny-once). Nothing a hook says there grants
//   anything: Gemini CLI asks the person whatever it would have asked.
// - Gemini CLI runs a command with `bash -c`, and reads output that is not
//   JSON, from a command that exits with anything but 0 or 1, as a refusal:
//   bash's "No such file or directory" and 127, for a node that is no longer
//   where the command says, would refuse every edit. So the command names
//   node by its full path (Gemini CLI may run without the person's shell
//   PATH) and sends its stderr nowhere: a node that has gone makes a hook
//   that failed, which Gemini CLI goes past with a warning, and doctor names
//   it. On Windows it runs PowerShell, which says a missing command with exit
//   1, a warning: there the command is `node`, as for every other agent.
// - Gemini CLI reads $VAR and ${VAR} anywhere in its settings as environment
//   variables, so no command here has a $ in it: login refuses a path that
//   would put one there.
// - Every hook in its settings files, and every MCP server, runs only in a
//   folder Gemini CLI trusts: in one the person told it not to trust, it runs
//   none of them. Said on login, and by doctor.
// - Its settings are JSON with comments, and written back as plain JSON they
//   would lose them: a file with comments in it is left exactly as it is, and
//   said. Gemini CLI does not start at all with a settings file that does not
//   read, so one is never written that does not.
// - A rewrite keeps the file's own indentation and line endings, so logout
//   leaves the person's file byte for byte as login found it.

import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_HOOK_SCRIPT,
  OURS,
  PRIVATE,
  RUNS_OURS,
  SERVER_NAME,
  agentHookCommand,
  agentPlaces,
  commandsOf,
  exists,
  isOurEntry,
  isOurGroup,
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

const ID = 'gemini';

/** Its own two edit tools (definitions/base-declarations.ts), anchored: a bare `replace` would match an MCP tool with replace in its name. */
const EDIT_MATCHER = '^(write_file|replace)$';
/** What is reported after it runs: the two edit tools, and a shell command, whose changes the working tree says (as Codex's Bash). */
const REPORT_MATCHER = '^(write_file|replace|run_shell_command)$';

/** The folder Gemini CLI takes for the home: GEMINI_CLI_HOME when set (core/utils/paths.ts homedir). */
const geminiHome = (places) => (process.env.GEMINI_CLI_HOME ? path.resolve(process.env.GEMINI_CLI_HOME) : places.home);
const settingsFile = (places) => path.join(geminiHome(places), '.gemini', 'settings.json');
const files = (places) => ({ settings: settingsFile(places) });

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * The node a command names: on Windows `node` (see the top); elsewhere the
 * node on the person's PATH when it is the very node running this, by the
 * path they reach it by (a Homebrew or version manager's link, which outlives
 * an upgrade, where this process's own path would not), else this one.
 */
export function nodeFor(places) {
  if (process.platform === 'win32') return 'node';
  const onPath = which('node', places.toolPath);
  try {
    if (onPath && fs.realpathSync(onPath) === fs.realpathSync(process.execPath)) return onPath;
  } catch {
    // a link that goes nowhere: this process's own
  }
  return process.execPath;
}

/** What in a path would be read as something else in a command: a variable, a quote, an escape. */
const UNSAFE = process.platform === 'win32' ? /[$`"]/ : /[$`"\\]/;

/**
 * The command for one event: the generic hook with --global --client gemini.
 * The same string every time for the same node and folder: nothing in it
 * changes from one version of agentmash to the next.
 */
export function geminiCommand(hookDir, event, node) {
  if (node === 'node') return agentHookCommand(hookDir, event, ID);
  return `"${node}" "${path.join(hookDir, AGENT_HOOK_SCRIPT)}" ${event} --global --client ${ID} 2>/dev/null`;
}

/**
 * What login registers with Gemini CLI: a matcher group per event, each hook
 * named (agentmash-*, which `/hooks disable` and hooksConfig.disabled go by)
 * and given its time in milliseconds. The generic hook answers well inside
 * each: its own guard ends a check at the room's budget, 1.5 s by default.
 */
export function geminiHooks(hookDir, node = nodeFor(agentPlaces())) {
  const hook = (name, event, timeout, description) => ({ name, type: 'command', command: geminiCommand(hookDir, event, node), description, timeout });
  return {
    BeforeTool: [
      {
        matcher: EDIT_MATCHER,
        hooks: [hook('agentmash-pre-edit', 'pre_edit', 6000, "AgentMash: warns the agent before it edits a file a teammate's agent is in")],
      },
    ],
    AfterTool: [
      { matcher: REPORT_MATCHER, hooks: [hook('agentmash-post-edit', 'post_edit', 5000, 'AgentMash: tells your team which files the agent changed')] },
    ],
    BeforeAgent: [
      {
        hooks: [hook('agentmash-prompt', 'prompt', 5000, 'AgentMash: tells your team what the agent is working on, and the agent who on the team is working near it')],
      },
    ],
    SessionStart: [
      { hooks: [hook('agentmash-session-start', 'session_start', 6000, 'AgentMash: tells the agent who on the team is working on the same branch')] },
    ],
    // fired as Gemini CLI exits, which waits for it: this one hands its report off at once
    SessionEnd: [{ hooks: [hook('agentmash-session-end', 'session_end', 3000, "AgentMash: tells your team the agent's session has ended")] }],
  };
}

/** Our hooks' names, as hooksConfig.disabled and `/hooks disable` name them. */
const HOOK_NAMES = ['agentmash-pre-edit', 'agentmash-post-edit', 'agentmash-prompt', 'agentmash-session-start', 'agentmash-session-end'];

// ── the settings file ───────────────────────────────────────────────────────

/**
 * The text without its // and /* *\/ comments, as Gemini CLI reads it
 * (strip-json-comments), and whether it had any. A // in a string is text.
 */
export function withoutComments(text) {
  let out = '';
  let comments = false;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      comments = true;
      const end = text.indexOf('\n', i);
      i = (end === -1 ? text.length : end) - 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      comments = true;
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      out += ' ';
    } else out += ch;
  }
  return { text: out, comments };
}

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
 * The settings file: { value, existed, text, comments, style }, or { invalid }
 * when it does not read as an object (or cannot be read at all: a file that
 * is there is never taken for one that is not, and written over).
 */
export function readSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' ? { value: {}, existed: false, style: styleOf('') } : { invalid: true, existed: true, text: '' };
  }
  if (!text.trim()) return { value: {}, existed: true, text, comments: false, style: styleOf('') };
  const bare = withoutComments(text);
  try {
    const value = JSON.parse(bare.text);
    if (isObject(value)) return { value, existed: true, text, comments: bare.comments, style: styleOf(text) };
  } catch {
    // below
  }
  return { invalid: true, existed: true, text };
}

/** What in the settings stops our hooks running: said on login and by doctor. */
function switchedOff(config, at) {
  const said = [];
  const switches = isObject(config?.hooksConfig) ? config.hooksConfig : {};
  if (switches.enabled === false) said.push(`hooks are switched off in ${at} (hooksConfig.enabled is false): Gemini CLI runs none of them`);
  const disabled = Array.isArray(switches.disabled) ? switches.disabled : [];
  const off = HOOK_NAMES.filter((name) => disabled.includes(name));
  if (off.length) said.push(`${off.join(', ')} ${off.length === 1 ? 'is' : 'are'} switched off in ${at} (hooksConfig.disabled)`);
  return said;
}

/** The node our entries name that is not there: every call of theirs fails (with a warning, not a refusal). */
function missingNodes(entries) {
  const gone = new Set();
  for (const command of entries.flatMap(commandsOf)) {
    const node = /^"([^"]+)"/.exec(command)?.[1];
    if (node && !OURS.test(node) && path.isAbsolute(node) && !exists(node)) gone.add(node);
  }
  return [...gone];
}

const TRUST =
  'Gemini CLI runs these hooks and the MCP server only in a folder it trusts: in one you told it not to trust, it runs none of them';
const DENY_ONCE =
  "before an edit Gemini CLI can only let it run or refuse it: its first edit of a file a teammate's agent is in is refused once, with the warning as the reason, and the same edit again goes through";

export default {
  id: ID,
  name: 'Gemini CLI',
  order: 50,
  env: ['GEMINI_CLI_HOME'],
  files,
  hooks: geminiHooks,
  detect(places) {
    // the command, never ~/.gemini alone: Antigravity keeps its own things there too
    const bin = which('gemini', places.toolPath);
    return { found: Boolean(bin), bin };
  },
  connect(places, hookDir) {
    const file = settingsFile(places);
    const at = shown(file, places);
    const node = nodeFor(places);
    if (UNSAFE.test(node) || UNSAFE.test(hookDir)) {
      return { status: 'skipped', why: `${node} or ${hookDir} has a $, a quote or a backslash in its path, which Gemini CLI would read as part of the command` };
    }
    const read = readSettings(file);
    if (read.invalid) return { status: 'skipped', why: `${at} is not valid JSON — fix it, then run login again` };
    if (read.comments) return { status: 'skipped', why: `${at} has comments in it, which writing it back would lose — take them out, then run login again` };
    const config = read.value;
    if (config.hooks !== undefined && !isObject(config.hooks)) return { status: 'skipped', why: `${at} has a "hooks" that is not an object — fix it, then run login again` };
    const hooks = isObject(config.hooks) ? config.hooks : {};
    const hooksChanged = mergeEntries(hooks, geminiHooks(hookDir, node), isOurGroup);

    const notes = [];
    const entry = { command: node, args: serverArgs(hookDir) };
    let servers = config.mcpServers;
    let serverChanged = false;
    if (servers !== undefined && !isObject(servers)) notes.push(`${at} has an "mcpServers" that is not an object: the MCP server was not added`);
    else if (servers?.[SERVER_NAME] && !isOurServer(servers[SERVER_NAME])) {
      notes.push(`a server called agentmash is in ${at} already, and not ours: left as it is`);
    } else if (!same(servers?.[SERVER_NAME], entry)) {
      servers = { ...(servers ?? {}), [SERVER_NAME]: entry };
      serverChanged = true;
    }

    if (hooksChanged || serverChanged) {
      const next = { ...config, hooks, ...(servers !== undefined ? { mcpServers: servers } : {}) };
      // MCP servers can carry tokens: a settings file made here is private
      writeFileSafely(file, format(next, read.style), { mode: PRIVATE });
    }
    const status = hooksChanged || serverChanged ? 'connected' : 'already';
    notes.push(...switchedOff(config, at));
    if (status === 'connected') notes.push(TRUST, DENY_ONCE, 'Gemini CLI runs these hooks from 0.26.0 on');
    return { status, notes, where: at };
  },
  disconnect(places) {
    const file = settingsFile(places);
    const read = readSettings(file);
    if (read.invalid) return outcome([{ removed: false, invalid: !read.text || RUNS_OURS.test(read.text) }, file, places]);
    if (!read.existed) return outcome([{ removed: false }, file, places]);
    const config = read.value;
    const hooks = isObject(config.hooks) ? config.hooks : null;
    const hooksOut = hooks ? removeEntries(hooks, isOurGroup) : false;
    const servers = isObject(config.mcpServers) ? config.mcpServers : null;
    const serverOut = Boolean(servers && isOurServer(servers[SERVER_NAME]));
    if (!hooksOut && !serverOut) return outcome([{ removed: false }, file, places]);
    // ours is in a file with comments: taking it out would take theirs too
    if (read.comments) return outcome([{ removed: false, invalid: true }, file, places]);
    const next = { ...config };
    if (hooksOut && Object.keys(hooks).length === 0) delete next.hooks;
    if (serverOut) {
      const rest = { ...servers };
      delete rest[SERVER_NAME];
      if (Object.keys(rest).length) next.mcpServers = rest;
      else delete next.mcpServers;
    }
    if (Object.keys(next).length === 0) removeFile(file, '{}\n');
    else writeFileSafely(file, format(next, read.style), { mode: PRIVATE });
    return outcome([{ removed: true }, file, places]);
  },
  inspect(places) {
    const file = settingsFile(places);
    const at = shown(file, places);
    const read = readSettings(file);
    const config = read.value ?? {};
    const hooks = isObject(config.hooks) ? config.hooks : {};
    const groups = Object.values(hooks).flatMap((list) => (Array.isArray(list) ? list.filter(isOurGroup) : []));
    const entries = groups.flatMap((g) => g.hooks.filter(isOurEntry));
    return {
      connected: groups.length > 0,
      invalid: Boolean(read.invalid),
      where: at,
      events: Object.keys(hooks).filter((e) => Array.isArray(hooks[e]) && hooks[e].some(isOurGroup)),
      missing: [...missingNodes(entries), ...missingScripts(entries)],
      mcp: isOurServer(config.mcpServers?.[SERVER_NAME]),
      // what stops them running, for doctor to warn about, and how Gemini CLI runs them, for it to say
      warnings: groups.length ? switchedOff(config, at) : [],
      notes: groups.length ? [TRUST] : [],
    };
  },
};
