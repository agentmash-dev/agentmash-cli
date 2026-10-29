// Qwen Code: the person's own ~/.qwen/settings.json ($QWEN_HOME/settings.json
// when that is set). Our hooks go into its `hooks`, one matcher group per
// event, after theirs, and our MCP server into its `mcpServers`, beside
// theirs; both come out again by the script each one runs, from a
// .agentmash/hooks folder, and nothing else in the file is touched. Every hook
// is the generic one (hooks/agent_hook.mjs) with --client qwen --dialect qwen,
// which reads Qwen Code's payloads and answers in its words
// (hooks/dialects/qwen.mjs).
//
// Qwen Code is a fork of the Gemini CLI, but its hooks are Claude Code's, not
// Gemini's: Claude Code's event names, its stdin, and its hookSpecificOutput.
// Why the entries are what they are, from Qwen Code's source (v0.24.7):
//
// - PreToolUse runs once the edit is approved, just before it runs
//   (core/coreToolScheduler.ts), and what a hook adds there as context never
//   reaches the model in 0.24.7 (later builds append it to the edit's result,
//   after the edit). What does reach it is a refusal: the reason comes back
//   as the tool's error and the turn goes on. So the warning before an edit
//   goes as a refusal of the first try at the file, and the same edit again
//   goes through (the dialect's deny-once). Nothing a hook says there grants
//   anything: Qwen Code has asked the person whatever it would have asked
//   before the hook runs.
// - UserPromptSubmit fires before every call to the model, a tool's result
//   among them; only one with `submitted_prompt` is something the person
//   typed, and the dialect lets every other one go at once.
// - A hook's `timeout` is in seconds from 0.23.4 and in milliseconds before
//   it; one of 1000 or more is read as milliseconds by both, so every
//   timeout here is.
// - Commands run with `bash -c`, and an exit other than 0 or 2 is a warning
//   for the person, never a refusal: a `node` that is not on the PATH Qwen
//   Code runs with lets every edit through. So the command is `node`, as for
//   Codex, and the same string from one version of agentmash to the next.
// - Qwen Code reads $VAR and ${VAR} anywhere in its settings as environment
//   variables, so no command here has a $ in it: login refuses a path that
//   would put one there.
// - User hooks need no approval, and run in a folder whether or not it is
//   trusted; a user MCP server needs no approval either. Hooks are read as
//   Qwen Code starts (or /hooks is opened), servers as the file changes.
// - Its settings are JSON with comments, and written back as plain JSON they
//   would lose them: a file with comments in it is left exactly as it is, and
//   said. Qwen Code does not start with a user settings file that does not
//   read, so one is never written that does not. A file made here carries
//   "$version": 4, so Qwen Code has no reason to rewrite it as it starts.
// - A rewrite keeps the file's own indentation, line endings and byte-order
//   mark, so logout leaves the person's file byte for byte as login found it.

import fs from 'node:fs';
import path from 'node:path';
import {
  PRIVATE,
  RUNS_OURS,
  SERVER_NAME,
  agentHookCommand,
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

const ID = 'qwen';

/** Its own edit tools, anchored (core/tools/tool-names.ts): a bare `edit` would match notebook_edit and any MCP tool with edit in its name. */
const EDIT_MATCHER = '^(edit|write_file|notebook_edit)$';
/** What is reported after it runs: the edit tools, and a shell command, whose changes the working tree says (as Codex's Bash). */
const REPORT_MATCHER = '^(edit|write_file|notebook_edit|run_shell_command)$';

/** The settings version Qwen Code 0.24.7 writes (cli/config/settings.ts SETTINGS_VERSION), put in a file made here. */
const VERSION_KEY = '$version';
const SETTINGS_VERSION = 4;

// ── where Qwen Code keeps its settings ──────────────────────────────────────

/**
 * QWEN_HOME's value from a .env file, as dotenv reads it (the last line
 * naming it wins; quotes come off; an unquoted value ends at a #), or null.
 */
function dotenvValue(file, key) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let value = null;
  const line = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*(?:=|:\\s)\\s*(.*)$`);
  for (const raw of text.split(/\r?\n/)) {
    const m = line.exec(raw);
    if (!m) continue;
    const quoted = /^(['"`])(.*?)\1/.exec(m[1]);
    value = quoted ? quoted[2] : m[1].split('#')[0].trim();
  }
  return value || null;
}

/**
 * The QWEN_HOME Qwen Code goes by: the environment's, else the one in
 * ~/.qwen/.env, else the one in ~/.env, read before anything else is
 * (cli/config/environment.ts, preResolveHomeEnvOverrides). One set to
 * nothing in the environment stops the files being read, and means ~/.qwen.
 */
function qwenHomeSetting(places) {
  if (Object.hasOwn(process.env, 'QWEN_HOME')) return process.env.QWEN_HOME || null;
  for (const file of [path.join(places.home, '.qwen', '.env'), path.join(places.home, '.env')]) {
    const value = dotenvValue(file, 'QWEN_HOME');
    if (value) return value;
  }
  return null;
}

/** Qwen Code's own folder: QWEN_HOME with ~ expanded and a relative path made absolute (core/config/storage.ts), or ~/.qwen. */
function qwenDir(places) {
  const set = qwenHomeSetting(places);
  if (!set) return path.join(places.home, '.qwen');
  if (set === '~' || set.startsWith('~/') || set.startsWith('~\\')) return path.join(places.home, ...set.slice(2).split(/[/\\]+/).filter(Boolean));
  return path.resolve(set);
}

const settingsFile = (places) => path.join(qwenDir(places), 'settings.json');
const files = (places) => ({ settings: settingsFile(places) });

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * What login registers with Qwen Code: a matcher group per event, each hook
 * named (agentmash-*) and given its time in milliseconds. The generic hook
 * answers well inside each: its own guard ends a check at the room's budget,
 * 1.5 s by default.
 */
export function qwenHooks(hookDir) {
  const hook = (name, event, timeout, description) => ({
    name,
    type: 'command',
    command: agentHookCommand(hookDir, event, ID, { dialect: ID }),
    description,
    timeout,
  });
  return {
    PreToolUse: [
      { matcher: EDIT_MATCHER, hooks: [hook('agentmash-pre-edit', 'pre_edit', 6000, "AgentMash: warns the agent before it edits a file a teammate's agent is in")] },
    ],
    PostToolUse: [
      { matcher: REPORT_MATCHER, hooks: [hook('agentmash-post-edit', 'post_edit', 5000, 'AgentMash: tells your team which files the agent changed')] },
    ],
    UserPromptSubmit: [
      { hooks: [hook('agentmash-prompt', 'prompt', 5000, 'AgentMash: tells your team what the agent is working on, and the agent who on the team is working near it')] },
    ],
    SessionStart: [
      { hooks: [hook('agentmash-session-start', 'session_start', 6000, 'AgentMash: tells the agent who on the team is working on the same branch')] },
    ],
    // fired as Qwen Code exits: this one hands its report off at once
    SessionEnd: [{ hooks: [hook('agentmash-session-end', 'session_end', 3000, "AgentMash: tells your team the agent's session has ended")] }],
  };
}

// ── the settings file ───────────────────────────────────────────────────────

/**
 * The text without its // and /* *\/ comments, as Qwen Code reads it
 * (strip-json-comments), and whether it had any. A // in a string is text.
 */
function withoutComments(text) {
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

/** How a file is laid out: its indentation, its line ending, whether it ends in one, and its byte-order mark. */
function styleOf(text) {
  if (typeof text !== 'string' || !text.trim()) return { indent: 2, eol: '\n', end: true, bom: false };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const first = /\n([ \t]+)\S/.exec(text);
  return { indent: first ? first[1] : text.trim().includes('\n') ? 2 : 0, eol, end: /\n$/.test(text), bom: text.startsWith('\uFEFF') };
}

function format(value, style) {
  let out = JSON.stringify(value, null, style.indent);
  if (style.eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  return (style.bom ? '\uFEFF' : '') + (style.end ? out + style.eol : out);
}

/**
 * The settings file: { value, existed, text, comments, style }, or { invalid }
 * when it does not read as an object (or cannot be read at all: a file that
 * is there is never taken for one that is not, and written over).
 */
function readSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' ? { value: {}, existed: false, style: styleOf('') } : { invalid: true, existed: true, text: '' };
  }
  const bare = text.replace(/^\uFEFF/, '');
  if (!bare.trim()) return { value: {}, existed: true, text, comments: false, style: styleOf(text) };
  const stripped = withoutComments(bare);
  try {
    const value = JSON.parse(stripped.text);
    if (isObject(value)) return { value, existed: true, text, comments: stripped.comments, style: styleOf(text) };
  } catch {
    // below
  }
  return { invalid: true, existed: true, text };
}

/** What in the settings stops our hooks running: said on login and by doctor. */
function switchedOff(config, at) {
  return config?.disableAllHooks === true ? [`hooks are switched off in ${at} (disableAllHooks is true): Qwen Code runs none of them`] : [];
}

/** The scripts our entries run that are not there, and the dialect beside the generic hook, without which every answer is nothing. */
function missingFiles(entries) {
  const missing = missingScripts(entries);
  const hooks = new Set(entries.map((h) => /"([^"]+agent_hook\.mjs)"/.exec(h?.command ?? '')?.[1]).filter(Boolean));
  for (const script of hooks) {
    const dialect = path.join(path.dirname(script), 'dialects', `${ID}.mjs`);
    if (exists(script) && !exists(dialect)) missing.push(dialect);
  }
  return missing;
}

/** What in a path would be read as something else in a command: a variable, a quote, an escape. */
const UNSAFE = process.platform === 'win32' ? /[$`"]/ : /[$`"\\]/;

const RESTART = 'Qwen Code reads its hooks as it starts: a session already running runs them once restarted (or once /hooks is opened in it)';
const DENY_ONCE =
  "Qwen Code runs a hook before an edit once the edit is approved, and it can then only let it run or refuse it: its first edit of a file a teammate's agent is in is refused once, with the warning as the reason, and the same edit again goes through (in its default mode, you approve it again)";
// hooks left experimental in 0.14.0; what the person typed, apart from what goes to the model, comes with a prompt from 0.21.1
const VERSIONS = 'Qwen Code runs these hooks from 0.14.0 on, and tells them the prompt you typed, which is what is reported, from 0.21.1 on';

export default {
  id: ID,
  name: 'Qwen Code',
  order: 50,
  env: ['QWEN_HOME'],
  files,
  hooks: qwenHooks,
  detect(places) {
    // the command, or its folder: nothing else keeps a ~/.qwen
    const bin = which('qwen', places.toolPath);
    return { found: Boolean(bin) || exists(qwenDir(places)), bin };
  },
  connect(places, hookDir) {
    const file = settingsFile(places);
    const at = shown(file, places);
    if (UNSAFE.test(hookDir)) {
      return { status: 'skipped', why: `${hookDir} has a $, a quote or a backslash in its path, which Qwen Code would read as part of the command` };
    }
    const read = readSettings(file);
    if (read.invalid) return { status: 'skipped', why: `${at} is not valid JSON — fix it, then run login again` };
    if (read.comments) return { status: 'skipped', why: `${at} has comments in it, which writing it back would lose — take them out, then run login again` };
    const config = read.value;
    if (config.hooks !== undefined && !isObject(config.hooks)) return { status: 'skipped', why: `${at} has a "hooks" that is not an object — fix it, then run login again` };
    const hooks = isObject(config.hooks) ? { ...config.hooks } : {};
    const hooksChanged = mergeEntries(hooks, qwenHooks(hookDir), isOurGroup);

    const notes = [];
    const entry = { command: 'node', args: serverArgs(hookDir) };
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
      const base = read.existed ? config : { [VERSION_KEY]: SETTINGS_VERSION };
      const next = { ...base, hooks, ...(servers !== undefined ? { mcpServers: servers } : {}) };
      // MCP servers can carry tokens: a settings file made here is private
      writeFileSafely(file, format(next, read.style), { mode: PRIVATE });
    }
    const status = hooksChanged || serverChanged ? 'connected' : 'already';
    notes.push(...switchedOff(config, at));
    if (status === 'connected') notes.push(RESTART, DENY_ONCE, VERSIONS);
    return { status, notes, where: at };
  },
  disconnect(places) {
    const file = settingsFile(places);
    const read = readSettings(file);
    if (read.invalid) return outcome([{ removed: false, invalid: !read.text || RUNS_OURS.test(read.text) }, file, places]);
    if (!read.existed) return outcome([{ removed: false }, file, places]);
    const config = read.value;
    const hooks = isObject(config.hooks) ? { ...config.hooks } : null;
    const hooksOut = hooks ? removeEntries(hooks, isOurGroup) : false;
    const servers = isObject(config.mcpServers) ? config.mcpServers : null;
    const serverOut = Boolean(servers && isOurServer(servers[SERVER_NAME]));
    if (!hooksOut && !serverOut) return outcome([{ removed: false }, file, places]);
    // ours is in a file with comments: taking it out would take theirs too
    if (read.comments) return outcome([{ removed: false, invalid: true }, file, places]);
    const next = { ...config };
    if (hooksOut) {
      if (Object.keys(hooks).length) next.hooks = hooks;
      else delete next.hooks;
    }
    if (serverOut) {
      const rest = { ...servers };
      delete rest[SERVER_NAME];
      if (Object.keys(rest).length) next.mcpServers = rest;
      else delete next.mcpServers;
    }
    // nothing left but the version a file made here starts with: the file goes (a link keeps what it points at)
    if (Object.keys(next).every((key) => key === VERSION_KEY)) removeFile(file, format(next, read.style));
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
      missing: missingFiles(entries),
      mcp: isOurServer(config.mcpServers?.[SERVER_NAME]),
      // what stops them running, for doctor to warn about
      warnings: groups.length ? switchedOff(config, at) : [],
    };
  },
};
