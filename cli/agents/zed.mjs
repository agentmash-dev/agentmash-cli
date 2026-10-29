// Zed (zed-industries/zed). Its own agent has no hooks of any kind: nothing
// runs before or after a tool call, on a prompt, or as a thread starts or
// ends (checked in its source at v1.22.0, v1.23.1-pre and main; PR #52729,
// which would have added them, was closed unmerged). So login gives Zed our
// MCP server and nothing else: its agent can ask the room who is working on
// what, and is warned when it asks, but none of its edits or prompts reach
// the room.
//
// The server goes in `context_servers` in Zed's user settings, which Zed
// reads again as soon as the file changes:
//
//   ~/.config/zed/settings.json          macOS, every release channel
//   $XDG_CONFIG_HOME/zed/settings.json   Linux ($FLATPAK_XDG_CONFIG_HOME/zed in its Flatpak)
//   %APPDATA%\Zed\settings.json          Windows
//
// The file is JSON with comments and trailing commas, and the first one Zed
// writes has both, so it is edited as text: our server goes in as one member
// after the person's, laid out as theirs are, and comes out again to the
// byte, comments and all. Every edit is read back before it is written and
// must say exactly what was meant; a file that cannot be read the way Zed
// reads it is left as it is, and login says why.
//
// The entry is the flat shape Zed reads from 0.214 on (`command`, `args`).
// A key Zed adds to it itself, such as "enabled": false when the person
// switches the server off in the agent panel, stays through every login.
//
// Nothing here approves anything: Zed asks before each MCP tool call until
// the person picks "Always" for that tool, and login writes no
// tool_permissions. Zed also hands every server in this list to the external
// agents it hosts (Claude Agent, Codex and the rest), which get the same tools.

import path from 'node:path';
import {
  PRIVATE,
  RUNS_OURS,
  SERVER_NAME,
  SERVER_SCRIPT,
  exists,
  isOurServer,
  outcome,
  readText,
  realTarget,
  removeFile,
  same,
  serverArgs,
  shown,
  which,
  writeFileSafely,
} from '../agent-kit.mjs';

const KEY = 'context_servers';

/** Zed's config folder (paths::config_dir in crates/paths). */
function zedDir(places) {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(places.home, 'AppData', 'Roaming'), 'Zed');
  if (process.platform === 'darwin') return path.join(places.home, '.config', 'zed');
  const flatpak = process.env.FLATPAK_XDG_CONFIG_HOME;
  if (flatpak) return path.join(flatpak, 'zed');
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(places.home, '.config'), 'zed');
}

const files = (places) => ({ settings: path.join(zedDir(places), 'settings.json') });

/** What login registers: our server, as Zed runs a stdio one. */
export function zedServer(hookDir) {
  return { command: 'node', args: serverArgs(hookDir) };
}

/** Zed's apps, where its installer or Homebrew puts them. */
const MAC_APPS = ['Zed.app', 'Zed Preview.app', 'Zed Nightly.app'];
const LINUX_APPS = ['zed.app', 'zed-preview.app', 'zed-nightly.app'];

function zedApp(places) {
  if (process.platform === 'darwin') return Boolean(places.apps) && MAC_APPS.some((app) => exists(path.join(places.apps, app)));
  if (process.platform === 'win32') return false;
  return LINUX_APPS.some((app) => exists(path.join(places.home, '.local', app)));
}

/**
 * Zed's command: `zed` only where it is Zed's, a link into one of its apps
 * (the ZFS event daemon is a `zed` too, on a merged /usr/sbin), or `zeditor`,
 * the name some Linux packages give it.
 */
function zedCommand(places) {
  const zed = which('zed', places.toolPath);
  if (zed && /zed[^\\/]*\.app[\\/]|zed-editor/i.test(realTarget(zed))) return zed;
  return which('zeditor', places.toolPath);
}

// ── the settings, as JSON with comments ────────────────────────────────────
//
// Read as a tree of where each object starts and ends and where each member's
// key, colon and comma are, so one member can be added after the last, or
// taken out, and not one other byte moves. (amp.mjs and opencode.mjs keep
// editors of their own like this one.)

/**
 * JSONC as Zed reads its settings (comments, trailing commas): the root
 * object's node, `{ start, end, value, members }`, each member `{ key,
 * keyStart, colon, node, comma }` (comma: where the one after it is, or -1).
 * Throws on what is not.
 */
export function readJsonc(text) {
  let i = 0;
  const n = text.length;
  const bad = () => {
    throw new SyntaxError(`not JSON at character ${i}`);
  };
  const space = () => {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\uFEFF') i++;
      else if (c === '/' && text[i + 1] === '/') {
        const end = text.indexOf('\n', i);
        i = end === -1 ? n : end;
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end === -1) bad();
        i = end + 2;
      } else return;
    }
  };
  const string = () => {
    const start = i++;
    while (i < n) {
      const c = text[i];
      if (c === '\\') i += 2;
      else if (c === '"') {
        try {
          return JSON.parse(text.slice(start, ++i));
        } catch {
          i = start;
          return bad();
        }
      } else i++;
    }
    return bad();
  };
  const LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const value = () => {
    space();
    const start = i;
    if (text[i] === '{') {
      i++;
      const members = [];
      const object = {};
      for (;;) {
        space();
        if (text[i] === '}') break;
        if (text[i] !== '"') bad();
        const keyStart = i;
        const key = string();
        space();
        if (text[i] !== ':') bad();
        const colon = i++;
        const node = value();
        const member = { key, keyStart, colon, node, comma: -1 };
        members.push(member);
        Object.defineProperty(object, key, { value: node.value, enumerable: true, writable: true, configurable: true });
        space();
        if (text[i] === ',') member.comma = i++;
        else if (text[i] !== '}') bad();
      }
      i++;
      return { start, end: i, value: object, members };
    }
    if (text[i] === '[') {
      i++;
      const items = [];
      for (;;) {
        space();
        if (text[i] === ']') break;
        items.push(value().value);
        space();
        if (text[i] === ',') i++;
        else if (text[i] !== ']') bad();
      }
      i++;
      return { start, end: i, value: items };
    }
    if (text[i] === '"') return { start, value: string(), end: i };
    LITERAL.lastIndex = i;
    const m = LITERAL.exec(text);
    if (!m) bad();
    i += m[0].length;
    return { start, end: i, value: JSON.parse(m[0]) };
  };
  const root = value();
  space();
  if (i !== n) bad();
  if (!root.members) throw new SyntaxError('not a JSON object');
  return root;
}

/** An object node's member named `key`, or null. */
const memberOf = (node, key) => node?.members?.find((m) => m.key === key) ?? null;
/** Whether an object node names `key` more than once, which leaves which one Zed reads up to Zed. */
const twice = (node, key) => (node?.members?.filter((m) => m.key === key).length ?? 0) > 1;

/** The whitespace the line `at` is on starts with. */
const indentAt = (text, at) => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', at - 1) + 1))[0];
/** Whether nothing but spaces comes before `at` on its line. */
const startsLine = (text, at) => /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', at - 1) + 1, at));
/** `value` as JSON, `unit` deeper for each level, its lines after the first at `indent`. */
const pretty = (value, indent, unit) => JSON.stringify(value, null, unit).split('\n').join(`\n${indent}`);

/**
 * Past the comments after `at` on its line (/* *\/ ones closed on it, and a //
 * one to its end), so a member never goes in between a value and its comment.
 */
function lineEndPast(text, at) {
  const rest = /^(?:[ \t]*\/\*[^\n]*?\*\/)*(?:[ \t]*\/\/[^\n]*)?/.exec(text.slice(at));
  return at + rest[0].length;
}

/** Where the line a member starts on begins, when only space is between `from` and it; -1 when it shares its line. */
function lineStartBefore(text, from, keyStart) {
  const between = text.slice(from, keyStart);
  const nl = between.lastIndexOf('\n');
  return nl !== -1 && /^\s*$/.test(between.slice(nl)) ? from + nl : -1;
}

/**
 * `text` with `key`: `value` after the last member of the object `node`, laid
 * out as its members are: on a line of its own at their indent (a level
 * deeper than the object, when it has none), or, in an object written on one
 * line, on that line; after a trailing comma, with one of its own.
 */
function withMember(text, node, key, value) {
  const outer = indentAt(text, node.start);
  const first = node.members[0];
  const last = node.members.at(-1);
  if (last && !text.slice(node.start, node.end).includes('\n')) {
    const sp = text[first.colon + 1] === ' ' ? ' ' : '';
    const member = `${JSON.stringify(key)}:${sp}${JSON.stringify(value)}`;
    if (last.comma !== -1) return `${text.slice(0, last.comma + 1)}${sp}${member},${text.slice(last.comma + 1)}`;
    return `${text.slice(0, last.node.end)},${sp}${member}${text.slice(last.node.end)}`;
  }
  const indent = first && startsLine(text, first.keyStart) ? indentAt(text, first.keyStart) : `${outer}${outer.includes('\t') ? '\t' : '  '}`;
  const unit = indent.startsWith(outer) && indent.length > outer.length ? indent.slice(outer.length) : '  ';
  const member = `${JSON.stringify(key)}: ${pretty(value, indent, unit)}`;
  if (!last) {
    const open = node.start + 1;
    const at = lineEndPast(text, open);
    // braces on one line ({}) open onto lines of their own
    const close = text.slice(at, node.end - 1).includes('\n') ? '' : `\n${outer}`;
    return `${text.slice(0, at)}\n${indent}${member}${close}${text.slice(at)}`;
  }
  if (last.comma !== -1) {
    const at = lineEndPast(text, last.comma + 1);
    return `${text.slice(0, at)}\n${indent}${member},${text.slice(at)}`;
  }
  const at = lineEndPast(text, last.node.end);
  return `${text.slice(0, last.node.end)},${text.slice(last.node.end, at)}\n${indent}${member}${text.slice(at)}`;
}

/**
 * `text` without `member` of the object `node`: withMember undone to the
 * byte, and for a member put there some other way, the member, one comma
 * beside it, and the line it was on.
 */
function withoutMember(text, node, member) {
  const at = node.members.indexOf(member);
  const previous = node.members[at - 1];
  const next = node.members[at + 1];
  const from = previous ? previous.comma + 1 : node.start + 1;
  const line = lineStartBefore(text, from, member.keyStart);
  if (next) {
    return line !== -1 ? text.slice(0, line) + text.slice(member.comma + 1) : text.slice(0, member.keyStart) + text.slice(next.keyStart);
  }
  if (previous) {
    if (member.comma !== -1) return text.slice(0, line !== -1 ? line : from) + text.slice(member.comma + 1);
    return text.slice(0, previous.comma) + text.slice(previous.comma + 1, line !== -1 ? line : from) + text.slice(member.node.end);
  }
  const end = member.comma !== -1 ? member.comma + 1 : member.node.end;
  if (/^\s*$/.test(text.slice(from, member.keyStart))) {
    // braces that were on one line close up again
    const outer = indentAt(text, node.start);
    const after = text.startsWith(`\n${outer}`, end) ? end + 1 + outer.length : end;
    return text.slice(0, from) + text.slice(after);
  }
  return text.slice(0, line !== -1 ? line : member.keyStart) + text.slice(end);
}

/** A value with every object's keys in order: two settings are the same whatever order their keys are written in. */
const sorted = (v) =>
  Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
const sameValue = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** A settings file login made, with only our server in it. */
const made = (entry) => `${JSON.stringify({ [KEY]: { [SERVER_NAME]: entry } }, null, 2)}\n`;
/** What logout leaves of a file login made: one it takes away. */
const MADE_EMPTY = '{}\n';

/**
 * The settings: { text, root } read, { text, invalid, why } not, { text, root:
 * null } when there are none (or nothing in it). One that is there and cannot
 * be read at all is invalid, `unreadable`: never taken for none, and written over.
 */
function readSettings(file) {
  let text;
  try {
    text = readText(file);
  } catch (err) {
    return { text: null, invalid: true, unreadable: true, why: err.code ?? err.message };
  }
  if (text === null || !text.trim()) return { text, root: null };
  try {
    const root = readJsonc(text);
    if (twice(root, KEY)) return { text, invalid: true, why: `it has "${KEY}" twice` };
    if (twice(memberOf(root, KEY)?.node, SERVER_NAME)) return { text, invalid: true, why: `its "${KEY}" has "${SERVER_NAME}" twice` };
    return { text, root };
  } catch (err) {
    return { text, invalid: true, why: err.message };
  }
}

/** Where our server is in the settings: `context_servers` and the server called agentmash in it, each a member or null. */
function serverIn(root) {
  const servers = memberOf(root, KEY);
  return { servers, server: servers?.node.members ? memberOf(servers.node, SERVER_NAME) : null };
}

/** Whether a file that cannot be read may hold our server: it names our MCP server's script, or could not be read at all to say. */
const mayHoldOurs = (read) => Boolean(read.unreadable) || (typeof read.text === 'string' && RUNS_OURS.test(read.text) && read.text.includes(SERVER_SCRIPT));

/**
 * Our server into the settings: { status: added | already | taken | shape |
 * invalid, why?, off? }. `off`: the server is there switched off
 * ("enabled": false), which login leaves as the person set it.
 */
function addZedServer(file, entry) {
  const read = readSettings(file);
  if (read.invalid) return { status: 'invalid', why: read.why };
  if (!read.root) {
    writeFileSafely(file, made(entry), { mode: PRIVATE });
    return { status: 'added' };
  }
  const { text, root } = read;
  const { servers, server } = serverIn(root);
  if (servers && !servers.node.members) return { status: 'shape' };
  if (server && !isOurServer(server.node.value)) return { status: 'taken' };
  let want = entry;
  let next;
  if (server) {
    // ours from an earlier login: running this hooks folder's server, it is already, whatever else the person
    // changed in it (a full path to node, say); for another hooks folder, its args are this one's
    const current = server.node.value;
    if (same(current.args, entry.args)) return { status: 'already', off: current.enabled === false };
    want = { ...current, args: entry.args };
    if (typeof want.command !== 'string') want.command = entry.command;
    const indent = indentAt(text, server.keyStart);
    const outer = indentAt(text, servers.keyStart);
    const unit = indent.startsWith(outer) && indent.length > outer.length ? indent.slice(outer.length) : '  ';
    next = text.slice(0, server.node.start) + pretty(want, indent, unit) + text.slice(server.node.end);
  } else if (servers) {
    next = withMember(text, servers.node, SERVER_NAME, entry);
  } else {
    next = withMember(text, root, KEY, { [SERVER_NAME]: entry });
  }
  // read back: the same settings, and our server as meant, or nothing is written
  const expected = { ...root.value, [KEY]: { ...(servers?.node.value ?? {}), [SERVER_NAME]: want } };
  let back = null;
  try {
    back = readJsonc(next);
  } catch {
    back = null;
  }
  if (!back || !sameValue(back.value, expected)) return { status: 'invalid', why: 'the server could not be added without rewriting what is there' };
  writeFileSafely(file, next, { mode: PRIVATE });
  return { status: 'added', off: want.enabled === false };
}

/** The settings as they are once our server is out: `context_servers` with it when ours was all it held. */
function withoutOurs(value) {
  const servers = value?.[KEY];
  if (!servers || typeof servers !== 'object' || Array.isArray(servers) || !isOurServer(servers[SERVER_NAME])) return value;
  const rest = { ...servers };
  delete rest[SERVER_NAME];
  const out = { ...value, [KEY]: rest };
  if (Object.keys(rest).length === 0) delete out[KEY];
  return out;
}

/**
 * Our server out of the settings, and `context_servers` with it when nothing
 * else was in it; the file goes when it is left as login made it. { removed,
 * invalid }: invalid when it cannot be read and may still hold ours.
 */
function removeZedServer(file) {
  const read = readSettings(file);
  if (read.invalid) return { removed: false, invalid: mayHoldOurs(read) };
  if (!read.root) return { removed: false };
  const { servers, server } = serverIn(read.root);
  if (!server || !isOurServer(server.node.value)) return { removed: false };
  const next = servers.node.members.length === 1 ? withoutMember(read.text, read.root, servers) : withoutMember(read.text, servers.node, server);
  let back = null;
  try {
    back = next.trim() ? readJsonc(next) : null;
  } catch {
    back = null;
  }
  if (!back || !sameValue(back.value, withoutOurs(read.root.value))) return { removed: false, invalid: true };
  if (next === MADE_EMPTY) removeFile(file, MADE_EMPTY);
  else writeFileSafely(file, next);
  return { removed: true };
}

/** Our server's entry in the settings, or null. */
function ourEntry(file) {
  const read = readSettings(file);
  const value = read.root ? serverIn(read.root).server?.node.value : null;
  return isOurServer(value) ? value : null;
}

export default {
  id: 'zed',
  name: 'Zed',
  // after the agents with hooks: Zed gets the MCP server alone
  order: 60,
  // where Zed's config folder is off macOS and Windows (XDG_CONFIG_HOME every test sets itself)
  env: ['XDG_CONFIG_HOME', 'FLATPAK_XDG_CONFIG_HOME'],
  // it has no hooks: login registers its MCP server and nothing more
  mcpOnly: true,
  files,
  hooks: (hookDir) => ({ [KEY]: { [SERVER_NAME]: zedServer(hookDir) } }),
  detect(places) {
    const bin = zedCommand(places);
    return { found: Boolean(bin) || zedApp(places) || exists(zedDir(places)), bin };
  },
  connect(places, hookDir) {
    const at = files(places);
    const where = shown(at.settings, places);
    const server = addZedServer(at.settings, zedServer(hookDir));
    if (server.status === 'taken') return { status: 'skipped', why: `a server called agentmash is in ${where} already, and not ours: left as it is` };
    if (server.status === 'shape') return { status: 'skipped', why: `"${KEY}" in ${where} is not an object: left as it is` };
    if (server.status === 'invalid') return { status: 'skipped', why: `${where} could not be read as Zed reads it (${server.why}): left as it was` };
    const status = server.status === 'added' ? 'connected' : 'already';
    const notes = [];
    if (server.off) notes.push("agentmash is switched off in Zed's agent panel: left off");
    if (status === 'connected') {
      notes.push("Zed's agent has no hooks: it gets AgentMash's MCP tools only, so it hears about teammates when it asks, and its edits do not show in the room");
      notes.push('Zed asks before each agentmash tool call until you choose Always for it; login allows none');
    }
    return { status, notes, where };
  },
  disconnect(places) {
    const at = files(places);
    return outcome([removeZedServer(at.settings), at.settings, places]);
  },
  inspect(places) {
    const at = files(places);
    const read = readSettings(at.settings);
    const ours = ourEntry(at.settings);
    const script = Array.isArray(ours?.args) ? ours.args.find((a) => typeof a === 'string' && a.endsWith(SERVER_SCRIPT)) : null;
    return {
      connected: Boolean(ours),
      // a file Zed cannot read either starts none of its servers: said only when ours may be in it
      invalid: Boolean(read.invalid && mayHoldOurs(read)),
      where: shown(at.settings, places),
      events: [],
      missing: script && !exists(script) ? [script] : [],
      mcp: Boolean(ours),
    };
  },
};
