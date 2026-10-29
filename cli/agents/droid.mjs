// Factory Droid (the `droid` CLI): our hooks in ~/.factory/hooks.json, the
// file Droid reads its user-level hooks from, and our MCP server in
// ~/.factory/mcp.json, each beside the person's own and out again by the
// script it runs, from a .agentmash/hooks folder. Every hook is the generic
// one (hooks/agent_hook.mjs) with --client droid, which reads Droid's payloads
// and answers in its words (hooks/dialects/droid.mjs).
//
// Why the entries are what they are, from Factory's docs
// (docs.factory.com/harness/hooks.md and /harness/mcp.md, CLI 0.233.0) and
// what integrations tested against Droid have recorded:
//
// - hooks.json is the event map itself, keyed by event name. The {"hooks":
//   {...}} wrapper belongs only in settings.json; in hooks.json Droid ignores
//   it ("Ignoring unknown hook event keys"), so it is never written here.
// - While there is no hooks.json, Droid reads the same map from the "hooks"
//   key of ~/.factory/settings.json, and once there is one it reads that in
//   its place. So a hooks.json made here starts as a copy of the person's
//   settings.json hooks, theirs first, and settings.json is never written;
//   logout takes the file away again while it still holds just that copy.
//   Before 0.136.0 the file was ~/.factory/hooks/hooks.json, which Droid still
//   reads while there is no hooks.json: a person with only that one is asked
//   to let Droid move it (/hooks), not guessed at.
// - Before an edit Droid can only let a tool run or refuse it with a reason
//   the model reads: PreToolUse has no context for a call it lets through,
//   and its "allow" skips Droid's own approval. So the warning goes as a
//   refusal of the first try at a file a teammate's agent is in, and the same
//   edit again goes through (the dialect's deny-once); nothing ever says allow.
// - Droid runs each command through a shell, with $VARIABLES in it expanded,
//   so login refuses a hooks folder whose path has a $, a quote or a
//   backslash in it: a command a shell cannot parse exits 2, which before an
//   edit is a refusal of every edit. A node that is not there exits 127, which
//   Droid goes past, as it does a crash or a timeout: every hook fails open.
// - Its hooks and MCP files may hold comments (Droid reads them as JSONC),
//   which writing back as plain JSON would lose: a file with comments in it is
//   left exactly as it is, and said. A rewrite keeps the file's own
//   indentation and line endings, so logout leaves it byte for byte as login
//   found it.
// - The MCP server's entry is ours to update and the person's to switch off:
//   whatever they set on it (disabled, disabledTools, timeouts) stays.
//   Droid keeps "always allow" for a server's tools by its command and
//   arguments, which never change from one release to the next.

import fs from 'node:fs';
import path from 'node:path';
import {
  PRIVATE,
  RUNS_OURS,
  SERVER_NAME,
  SERVER_SCRIPT,
  agentHookCommand,
  commandsOf,
  exists,
  isOurEntry,
  isOurServer,
  missingScripts,
  outcome,
  removeFile,
  same,
  serverArgs,
  shown,
  which,
  writeFileSafely,
} from '../agent-kit.mjs';

const ID = 'droid';

/** Droid's file tools, as Factory's own docs match them; the dialect checks the exact name again. */
const EDIT_MATCHER = 'Create|Edit|ApplyPatch';
/** What is reported after it runs: the file tools, and a shell command, whose changes the working tree says (as Codex's Bash). */
const REPORT_MATCHER = 'Create|Edit|ApplyPatch|Execute';

const factoryDir = (places) => path.join(places.home, '.factory');
const files = (places) => ({ hooks: path.join(factoryDir(places), 'hooks.json'), mcp: path.join(factoryDir(places), 'mcp.json') });
const settingsFile = (places) => path.join(factoryDir(places), 'settings.json');
/** Where Droid kept its hooks before 0.136.0, still read while there is no hooks.json. */
const legacyFile = (places) => path.join(factoryDir(places), 'hooks', 'hooks.json');

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * What login registers with Droid: a matcher group per event, each running
 * the generic hook, with its time in seconds. The generic hook answers well
 * inside each: its own guard ends a check at the room's budget, 1.5 s by
 * default. The same strings on every run: nothing in them changes from one
 * version of agentmash to the next.
 */
export function droidHooks(hookDir) {
  const hook = (event, timeout) => ({ type: 'command', command: agentHookCommand(hookDir, event, ID), timeout });
  return {
    PreToolUse: [{ matcher: EDIT_MATCHER, hooks: [hook('pre_edit', 5)] }],
    PostToolUse: [{ matcher: REPORT_MATCHER, hooks: [hook('post_edit', 5)] }],
    UserPromptSubmit: [{ hooks: [hook('prompt', 5)] }],
    // the heads-up as a session starts waits up to 4.5 s on the room
    SessionStart: [{ hooks: [hook('session_start', 6)] }],
    // hands its report off at once
    SessionEnd: [{ hooks: [hook('session_end', 3)] }],
    // advisory only, as in Claude Code: a word for the person, never a block
    Stop: [{ hooks: [hook('stop', 5)] }],
  };
}

/** What in a path would be read as something else in a command: a variable, a quote, an escape. */
const UNSAFE = process.platform === 'win32' ? /[$`"%]/ : /[$`"\\]/;

// ── JSON with comments, as Droid reads it ───────────────────────────────────

/**
 * The text as plain JSON: without its // and /* *\/ comments and its
 * trailing commas, which Droid's reader allows, and whether it had any
 * comments. Anything in a string is text.
 */
export function plainJson(text) {
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
  // a comma with nothing but space before the } or ] that closes it
  let plain = '';
  inString = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inString) {
      plain += ch;
      if (ch === '\\') plain += out[++i] ?? '';
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === ',' && /^\s*[}\]]/.test(out.slice(i + 1))) continue;
    plain += ch;
  }
  return { text: plain, comments };
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
 * A JSON file of Droid's: { value, existed, text, comments, style }, or
 * { invalid } when it does not read as an object (or cannot be read at all:
 * a file that is there is never taken for one that is not, and written over).
 */
export function readJsonc(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' ? { value: {}, existed: false, style: styleOf('') } : { invalid: true, existed: true, text: '' };
  }
  if (!text.trim()) return { value: {}, existed: true, text, comments: false, style: styleOf('') };
  const plain = plainJson(text.replace(/^\uFEFF/, ''));
  try {
    const value = JSON.parse(plain.text);
    if (isObject(value)) return { value, existed: true, text, comments: plain.comments, style: styleOf(text) };
  } catch {
    // below
  }
  return { invalid: true, existed: true, text };
}

// ── our entries in hooks.json ───────────────────────────────────────────────

const hasOurs = (group) => isObject(group) && Array.isArray(group.hooks) && group.hooks.some(isOurEntry);
/** An entry of ours that runs as Droid's: one of Claude Code's that Droid imported runs without it. */
const runsAsDroid = (entry) => commandsOf(entry).some((c) => c.includes(`--client ${ID}`));
/** Every entry of ours in the event map, whichever agent's it is. */
const ourEntries = (map) =>
  Object.values(map ?? {})
    .flatMap((groups) => (Array.isArray(groups) ? groups.filter(hasOurs) : []))
    .flatMap((group) => group.hooks.filter(isOurEntry));

/**
 * An event's groups without anything of ours: a group of ours goes, and one
 * the person put a hook of ours into keeps theirs. Returns { kept, changed }.
 */
function withoutOurs(groups) {
  const kept = [];
  let changed = false;
  for (const group of groups) {
    if (!hasOurs(group)) {
      kept.push(group);
      continue;
    }
    changed = true;
    const theirs = group.hooks.filter((h) => !isOurEntry(h));
    if (theirs.length) kept.push({ ...group, hooks: theirs });
  }
  return { kept, changed };
}

/**
 * `want` merged into the event map, in place: every entry of ours, in any
 * event, comes out, and each event `want` names gets this version's, after
 * whatever is the person's. An event already holding exactly this version's,
 * wherever among theirs, is left alone, so a current install is never
 * rewritten. Returns whether anything changed.
 */
function mergeHooks(map, want) {
  let changed = false;
  for (const event of Object.keys(map)) {
    if (!Array.isArray(map[event]) || want[event]) continue;
    const { kept, changed: had } = withoutOurs(map[event]);
    if (!had) continue;
    changed = true;
    if (kept.length) map[event] = kept;
    else delete map[event];
  }
  for (const [event, groups] of Object.entries(want)) {
    const current = map[event] ?? [];
    if (same(current.filter(hasOurs), groups)) continue;
    map[event] = [...withoutOurs(current).kept, ...groups];
    changed = true;
  }
  return changed;
}

/** Every entry of ours out of the event map, in place; events left empty go. Returns whether any did. */
const removeHooks = (map) => mergeHooks(map, {});

/**
 * The hooks Droid would read with no hooks.json, from settings.json: { hooks }
 * (an event map, {} for none), or { unreadable } when settings.json is there
 * and does not read.
 */
function settingsHooks(places) {
  const read = readJsonc(settingsFile(places));
  if (read.invalid) return { unreadable: true };
  return { hooks: isObject(read.value.hooks) ? read.value.hooks : {}, settings: read.value };
}

/** What in Droid's own settings stops our hooks, or the room, being reached: said on login and by doctor. */
function whatStops(places, map) {
  const said = [];
  const { settings = {} } = settingsHooks(places);
  const where = [map?.hooksDisabled === true && shown(files(places).hooks, places), settings.hooksDisabled === true && shown(settingsFile(places), places)].filter(Boolean);
  if (where.length) said.push(`hooks are switched off in ${where.join(' and ')} (hooksDisabled is true): Droid runs none of them`);
  if (isObject(settings.sandbox) && settings.sandbox.enabled === true) {
    said.push(
      `Droid's sandbox is on in ${shown(settingsFile(places), places)}: hooks run inside it, and reach the AgentMash server only if its host is among the sandbox's allowed domains`
    );
  }
  // Droid can import Claude Code's hooks, and ours among them would report Droid's work as Claude Code's
  if (ourEntries(map).some((entry) => !runsAsDroid(entry))) {
    said.push(`${shown(files(places).hooks, places)} runs AgentMash hooks that are not Droid's (imported from Claude Code?), which report Droid's work as another agent's — run: npx agentmash login`);
  }
  return said;
}

// ── our server in mcp.json ──────────────────────────────────────────────────

/** Our server into mcp.json: { status: added | already | taken | invalid | comments }. */
function addOurServer(file, entry) {
  const read = readJsonc(file);
  if (read.invalid) return { status: 'invalid' };
  const config = read.value;
  if (config.mcpServers !== undefined && !isObject(config.mcpServers)) return { status: 'invalid' };
  const servers = config.mcpServers ?? {};
  const current = servers[SERVER_NAME];
  if (current !== undefined && !isOurServer(current)) return { status: 'taken' };
  // what the person set on ours (disabled, disabledTools, timeout, env) stays theirs
  const next = isObject(current) ? { ...current, ...entry } : entry;
  if (same(current, next)) return { status: 'already' };
  if (read.comments) return { status: 'comments' };
  writeFileSafely(file, format({ ...config, mcpServers: { ...servers, [SERVER_NAME]: next } }, read.style), { mode: PRIVATE });
  return { status: 'added' };
}

/** Our server out of mcp.json; the file goes when it is left holding nothing. { removed, invalid }. */
function removeOurServer(file) {
  const read = readJsonc(file);
  if (read.invalid) return { removed: false, invalid: !read.text || (RUNS_OURS.test(read.text) && read.text.includes(SERVER_SCRIPT)) };
  if (!read.existed) return { removed: false };
  const config = read.value;
  if (!isOurServer(config.mcpServers?.[SERVER_NAME])) return { removed: false };
  // ours is in a file with comments: taking it out would take theirs too
  if (read.comments) return { removed: false, invalid: true };
  const servers = { ...config.mcpServers };
  delete servers[SERVER_NAME];
  const rest = { ...config, mcpServers: servers };
  if (Object.keys(servers).length === 0) delete rest.mcpServers;
  if (Object.keys(rest).length === 0) removeFile(file, '{}\n');
  else writeFileSafely(file, format(rest, read.style), { mode: PRIVATE });
  return { removed: true };
}

const DENY_ONCE =
  "before an edit Droid can only let it run or refuse it: its first edit of a file a teammate's agent is in is refused once, with the warning as the reason, and the same edit again goes through";
const RESTART = 'Droid reads its hooks as a session starts: restart any droid already open, and review the change in /hooks if it asks';

export default {
  id: ID,
  name: 'Factory Droid',
  order: 50,
  // Droid's folder is always ~/.factory: it reads no variable that moves it
  env: [],
  files,
  hooks: droidHooks,
  detect(places) {
    // the installer's own folder for it, which it may not have put on PATH yet
    const installed = path.join(places.home, ...(process.platform === 'win32' ? ['bin'] : ['.local', 'bin']));
    const bin = which('droid', places.toolPath) ?? which('droid', installed);
    return { found: Boolean(bin) || exists(factoryDir(places)), bin };
  },
  connect(places, hookDir) {
    const at = files(places);
    const where = shown(at.hooks, places);
    if (UNSAFE.test(hookDir)) {
      return { status: 'skipped', why: `${hookDir} has a $, a quote or a backslash in its path, which Droid's shell would read as part of the command` };
    }
    const read = readJsonc(at.hooks);
    if (read.invalid) return { status: 'skipped', why: `${where} is not valid JSON — fix it, then run login again` };
    if (read.comments) return { status: 'skipped', why: `${where} has comments in it, which writing it back would lose — take them out, then run login again` };
    const notes = [];
    let map = read.value;
    let mode = 0o644;
    if (!read.existed) {
      if (exists(legacyFile(places))) {
        return {
          status: 'skipped',
          why: `Droid keeps its hooks in ${shown(legacyFile(places), places)}, where it did before 0.136.0 — open droid, type /hooks and save, which moves them to ${where}, then run login again`,
        };
      }
      // a hooks.json takes the place of settings.json's hooks: it starts as a copy of them
      const fallback = settingsHooks(places);
      if (fallback.unreadable) {
        return {
          status: 'skipped',
          why: `${shown(settingsFile(places), places)} could not be read, and Droid takes its hooks from there until there is a ${where} — fix it, then run login again`,
        };
      }
      map = structuredClone(fallback.hooks);
      if (Object.keys(map).length) {
        notes.push(`your hooks in ${shown(settingsFile(places), places)} are in ${where} too now, which Droid reads in their place; settings.json is as it was`);
        // their commands can carry a token: the copy is no more readable than what it was copied from
        try {
          mode = fs.statSync(settingsFile(places)).mode & 0o777 & 0o644;
        } catch {
          // read a moment ago: as written
        }
      }
    }
    const want = droidHooks(hookDir);
    const odd = Object.keys(want).filter((event) => map[event] !== undefined && !Array.isArray(map[event]));
    if (odd.length) return { status: 'skipped', why: `${where} has a ${odd.join(', ')} that is not a list — fix it, then run login again` };
    const hooksChanged = mergeHooks(map, want);
    if (hooksChanged) writeFileSafely(at.hooks, format(map, read.style), { mode });

    const server = addOurServer(at.mcp, { type: 'stdio', command: 'node', args: serverArgs(hookDir) });
    const mcp = shown(at.mcp, places);
    if (server.status === 'taken') notes.push(`a server called agentmash is in ${mcp} already, and not ours: left as it is`);
    if (server.status === 'invalid') notes.push(`${mcp} is not valid JSON: the MCP server was not added`);
    if (server.status === 'comments') notes.push(`${mcp} has comments in it, which writing it back would lose: the MCP server was not added`);
    const status = hooksChanged || server.status === 'added' ? 'connected' : 'already';
    notes.push(...whatStops(places, map));
    if (status === 'connected') notes.push(DENY_ONCE, RESTART, 'Droid runs these hooks from 0.202.0 on');
    return { status, notes, where };
  },
  disconnect(places) {
    const at = files(places);
    return outcome([removeOurHooks(places, at.hooks), at.hooks, places], [removeOurServer(at.mcp), at.mcp, places]);
  },
  inspect(places) {
    const at = files(places);
    const read = readJsonc(at.hooks);
    const map = read.value ?? {};
    const entries = ourEntries(map);
    const droids = (groups) => Array.isArray(groups) && groups.some((g) => hasOurs(g) && g.hooks.some((h) => isOurEntry(h) && runsAsDroid(h)));
    const connected = entries.some(runsAsDroid);
    return {
      connected,
      invalid: Boolean(read.invalid),
      where: shown(at.hooks, places),
      events: Object.keys(map).filter((e) => droids(map[e])),
      // an imported entry whose script is gone fails on every call too
      missing: missingScripts(entries),
      mcp: isOurServer(readJsonc(at.mcp).value?.mcpServers?.[SERVER_NAME]),
      // what stops them running, for doctor to warn about, and how Droid runs them, for it to say
      warnings: entries.length ? whatStops(places, map) : [],
      notes: connected ? [DENY_ONCE] : [],
    };
  },
};

/**
 * Our hooks out of hooks.json: { removed, invalid }. The file goes when what
 * is left of it is what Droid would read without it (nothing, or the copy of
 * settings.json's hooks login started it with), so Droid goes back to reading
 * those; else what is left is written back, in its own layout.
 */
function removeOurHooks(places, file) {
  const read = readJsonc(file);
  if (read.invalid) return { removed: false, invalid: !read.text || RUNS_OURS.test(read.text) };
  if (!read.existed) return { removed: false };
  const map = read.value;
  if (!removeHooks(map)) return { removed: false };
  // ours is in a file with comments: taking it out would take theirs too
  if (read.comments) return { removed: false, invalid: true };
  const fallback = settingsHooks(places);
  const asIfAbsent = !fallback.unreadable && !exists(legacyFile(places)) && same(map, fallback.hooks);
  // a symlink into someone's dotfiles stays, holding what Droid would read without it
  if (asIfAbsent) removeFile(file, format(map, read.style));
  else writeFileSafely(file, format(map, read.style));
  return { removed: true };
}
