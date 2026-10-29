// Amp (ampcode.com): a plugin of ours in Amp's own plugins folder, and its
// MCP server in Amp's user settings, both at user level.
//
//   ~/.config/amp/plugins/agentmash.ts   ($XDG_CONFIG_HOME/amp/plugins when set)
//       clients/amp/plugin.mjs, with the one line that names the hooks folder
//       filled in. Amp has no hook commands; a plugin is how it lets anything
//       see a tool call before it runs, and this one hands each moment to the
//       generic hook with --client amp (see the plugin). Amp loads it at its
//       next start, or at Ctrl+O, "plugins: reload". The file is ours whole,
//       and known for ours by the hooks folder its line names.
//   ~/.config/amp/settings.json          "amp.mcpServers": { "agentmash": … }
//       The person's own settings, in JSON with comments (Amp reads both
//       settings.json and settings.jsonc). Our server goes in, and comes out,
//       as text: one member added after theirs, or taken out, and nothing
//       else rewritten, so their comments, tabs and order stay as they were
//       and logout leaves the file byte for byte as login found it. A server
//       in the user's settings needs no approval in Amp.
//
// The settings file is found where the plugins folder is: the plugins folder
// follows XDG_CONFIG_HOME (measured by a third party on 2026-09-15); that the
// settings do too is a guess Amp's docs neither make nor rule out, and the
// two are the same folder unless XDG_CONFIG_HOME says otherwise.
//
// Nothing here approves anything: Amp asks the person before no tool since
// Neo (0.0.1779896748, 2026-05-27), and where its old permission rules are on
// the plugin answers no tool call at all (see the plugin).

import fs from 'node:fs';
import path from 'node:path';
import {
  OURS,
  PRIVATE,
  RUNS_OURS,
  SERVER_NAME,
  exists,
  isOurServer,
  outcome,
  peekText,
  readText,
  removeFile,
  same,
  serverArgs,
  shown,
  which,
  writeFileSafely,
} from '../agent-kit.mjs';

/** The plugin's file name in Amp's plugins folder: Amp names a plugin by it. */
export const AMP_PLUGIN_FILE = 'agentmash.ts';
/** The one line of the plugin login writes, naming the hooks folder. */
const HOOKS_LINE = /^const HOOKS_DIR = (.*); \/\/ agentmash:hooks-dir$/m;
/** The events the plugin listens to (clients/amp/plugin.mjs, EVENTS). */
const PLUGIN_EVENTS = ['agent.start', 'tool.call', 'tool.result', 'agent.end'];
/** The scripts the plugin runs, in the hooks folder: the generic hook, and the dialect it answers Amp in. */
const PLUGIN_RUNS = ['agent_hook.mjs', path.join('dialects', 'amp.mjs')];
/** What a plugin of ours that is a symlink into someone's dotfiles is left holding: a plugin that does nothing. */
const NO_PLUGIN = '// agentmash: taken out by `npx agentmash logout`\nexport default function () {}\n';
const SERVERS = 'amp.mcpServers';
/** A settings file login made, with our server taken out of it again. */
const MADE_EMPTY = '{\n}\n';

/** Amp's folder: $XDG_CONFIG_HOME/amp when that is set, else ~/.config/amp (%USERPROFILE%\.config\amp on Windows). */
function ampDir(places) {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && path.isAbsolute(xdg) ? path.join(xdg, 'amp') : path.join(places.home, '.config', 'amp');
}

/** settings.json, or settings.jsonc when that is the one there is. */
function settingsFile(dir) {
  const json = path.join(dir, 'settings.json');
  const jsonc = path.join(dir, 'settings.jsonc');
  return !exists(json) && exists(jsonc) ? jsonc : json;
}

const files = (places) => {
  const dir = ampDir(places);
  return { plugin: path.join(dir, 'plugins', AMP_PLUGIN_FILE), settings: settingsFile(dir) };
};

/** The CLI found on PATH, or where Amp's installer puts it ($AMP_HOME/bin, ~/.amp/bin by default). */
function ampBin(places) {
  const onPath = which('amp', places.toolPath);
  if (onPath) return onPath;
  const installed = path.join(process.env.AMP_HOME || path.join(places.home, '.amp'), 'bin', process.platform === 'win32' ? 'amp.exe' : 'amp');
  return exists(installed) ? installed : null;
}

// ── the plugin ──────────────────────────────────────────────────────────────

/** The plugin's source, from this checkout's clients/ or the copy bundled with the package, or null. */
function pluginSource() {
  for (const candidate of ['../../clients/amp/plugin.mjs', '../clients/amp/plugin.mjs']) {
    try {
      return fs.readFileSync(new URL(candidate, import.meta.url), 'utf8');
    } catch {
      // not here
    }
  }
  return null;
}

/** The plugin as login writes it for `hookDir`: the source with its one line filled in, or null. */
export function ampPlugin(hookDir, source = pluginSource()) {
  if (typeof source !== 'string' || source.match(new RegExp(HOOKS_LINE.source, 'gm'))?.length !== 1) return null;
  return source.replace(HOOKS_LINE, () => `const HOOKS_DIR = ${JSON.stringify(hookDir)}; // agentmash:hooks-dir`);
}

/** The hooks folder a plugin of ours names, or null for a file that is not one. */
function pluginHooksDir(text) {
  const m = typeof text === 'string' ? HOOKS_LINE.exec(text) : null;
  if (!m) return null;
  try {
    const dir = JSON.parse(m[1]);
    return typeof dir === 'string' && OURS.test(`${dir}${path.sep}`) ? dir : null;
  } catch {
    return null;
  }
}

/** A folder left empty, gone: Amp's plugins folder, and Amp's own, when this made them. */
function removeIfEmpty(dir) {
  try {
    if (!fs.lstatSync(dir).isDirectory() || fs.readdirSync(dir).length) return;
    fs.rmdirSync(dir);
  } catch {
    // not there, not empty, or not ours to take
  }
}

// ── the settings, as text ───────────────────────────────────────────────────
//
// JSON with comments, read as a tree of where each object starts and ends and
// where each member's key starts and its value ends, so that one member can
// be added after the last, or taken out, and not one other byte moves. Every
// edit is read again before it is written, and must say exactly what was
// meant: the same settings, with our server, or without it.

/** JSONC as { value, start, end, members } for an object, { value, start, end } for anything else. Throws on what is not. */
export function scanJsonc(text) {
  let i = 0;
  const fail = () => {
    throw new Error(`not JSON at character ${i}`);
  };
  const skip = () => {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\uFEFF') i++;
      else if (c === '/' && text[i + 1] === '/') {
        const end = text.indexOf('\n', i);
        i = end === -1 ? text.length : end;
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end === -1) fail();
        i = end + 2;
      } else return;
    }
  };
  const string = () => {
    const start = i++;
    for (;;) {
      if (i >= text.length) fail();
      const c = text[i];
      if (c === '\\') i += 2;
      else if (c === '"') break;
      else if (c < ' ') fail();
      else i++;
    }
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const node = () => {
    skip();
    const start = i;
    if (text[i] === '{') {
      i++;
      const members = [];
      const value = {};
      for (;;) {
        skip();
        if (text[i] === '}') break;
        if (members.length) {
          if (text[i] !== ',') fail();
          i++;
          skip();
          if (text[i] === '}') break;
        }
        if (text[i] !== '"') fail();
        const keyStart = i;
        const key = string();
        skip();
        if (text[i] !== ':') fail();
        i++;
        const inner = node();
        members.push({ key, keyStart, end: inner.end, node: inner });
        Object.defineProperty(value, key, { value: inner.value, enumerable: true, writable: true, configurable: true });
      }
      i++;
      return { value, start, end: i, members };
    }
    if (text[i] === '[') {
      i++;
      const items = [];
      for (;;) {
        skip();
        if (text[i] === ']') break;
        if (items.length) {
          if (text[i] !== ',') fail();
          i++;
          skip();
          if (text[i] === ']') break;
        }
        items.push(node().value);
      }
      i++;
      return { value: items, start, end: i };
    }
    if (text[i] === '"') return { value: string(), start, end: i };
    LITERAL.lastIndex = i;
    const m = LITERAL.exec(text);
    if (!m) fail();
    i += m[0].length;
    return { value: JSON.parse(m[0]), start, end: i };
  };
  const root = node();
  skip();
  if (i !== text.length) fail();
  return root;
}

/**
 * The settings file: { existed, text, root } read, { existed, invalid, why }
 * not, { existed: false } when there is none. One that is there and cannot be
 * read at all is invalid, `unreadable`: never taken for none, and written over.
 */
function readSettings(file) {
  let text;
  try {
    text = readText(file);
  } catch (err) {
    return { existed: true, invalid: true, unreadable: true, why: err.code ?? err.message };
  }
  if (text === null) return { existed: false };
  if (!text.trim()) return { existed: true, text, root: null };
  try {
    const root = scanJsonc(text);
    if (!root.members) return { existed: true, invalid: true, text, why: 'it is not a JSON object' };
    return { existed: true, text, root };
  } catch (err) {
    return { existed: true, invalid: true, text, why: err.message };
  }
}

/** The whitespace before a member's key, from its line's start: what one more member at that depth starts with. */
function leadOf(text, at) {
  let from = at;
  while (from > 0 && /[ \t]/.test(text[from - 1])) from--;
  return text[from - 1] === '\n' ? `\n${text.slice(from, at)}` : ' ';
}

/** `text` with `member` ('"key": value') after the last member of the object `obj`. */
function addMember(text, obj, member) {
  const last = obj.members[obj.members.length - 1];
  if (last) return `${text.slice(0, last.end)},${leadOf(text, last.keyStart)}${member}${text.slice(last.end)}`;
  return `${text.slice(0, obj.start + 1)} ${member}${text.slice(obj.start + 1)}`;
}

/** Where the comma after a value at `at` is, past any space and comments, or -1. */
function commaAfter(text, at) {
  let i = at;
  for (;;) {
    if (/\s/.test(text[i] ?? '')) i++;
    else if (text.startsWith('//', i)) i = text.includes('\n', i) ? text.indexOf('\n', i) : text.length;
    else if (text.startsWith('/*', i)) i = text.includes('*/', i + 2) ? text.indexOf('*/', i + 2) + 2 : text.length;
    else return text[i] === ',' ? i : -1;
  }
}

/**
 * `text` without the member at `k` of the object `obj`: with the comma before
 * it, or for the first, the line it is on through its comma; so a member
 * added by addMember comes out leaving exactly what was there before, and
 * anything the person wrote after it since, a comment above the next member
 * of theirs included, stays.
 */
function cutMember(text, obj, k) {
  const m = obj.members[k];
  if (k > 0) return text.slice(0, obj.members[k - 1].end) + text.slice(m.end);
  if (k + 1 < obj.members.length) {
    const comma = commaAfter(text, m.end);
    // its own line, from the end of the one before, when nothing but space is before it on it
    const before = text.slice(obj.start + 1, m.keyStart);
    const nl = before.lastIndexOf('\n');
    if (comma !== -1 && nl !== -1 && /^\s*$/.test(before.slice(nl))) return text.slice(0, obj.start + 1 + nl) + text.slice(comma + 1);
    return text.slice(0, m.keyStart) + text.slice(obj.members[k + 1].keyStart);
  }
  // the only one: a trailing comma after it goes with it
  const after = /^\s*,/.exec(text.slice(m.end));
  return text.slice(0, obj.start + 1) + text.slice(m.end + (after ? after[0].length : 0));
}

/** The settings without our server, as login would leave them: `amp.mcpServers` gone once nothing is left in it. */
function withoutOurs(value) {
  const servers = value?.[SERVERS];
  if (!servers || typeof servers !== 'object' || Array.isArray(servers) || !isOurServer(servers[SERVER_NAME])) return value;
  const rest = { ...servers };
  delete rest[SERVER_NAME];
  const out = { ...value, [SERVERS]: rest };
  if (Object.keys(rest).length === 0) delete out[SERVERS];
  return out;
}

/** A value with every object's keys in order: two settings are the same whatever order their keys are written in. */
const sorted = (v) =>
  Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
const sameValue = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

const serverText = (entry) => `{ ${Object.entries(entry).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`;

/** The text, and its tree, without the server called agentmash, and `amp.mcpServers` with it when that leaves it empty. */
function textWithout(text, root) {
  const at = (tree) => tree.members.findIndex((m) => m.key === SERVERS);
  const servers = root.members[at(root)]?.node;
  const k = servers?.members ? servers.members.findIndex((m) => m.key === SERVER_NAME) : -1;
  if (k === -1) return { text, root };
  let next = cutMember(text, servers, k);
  let tree = scanJsonc(next);
  if (tree.members[at(tree)].node.members?.length === 0) {
    next = cutMember(next, tree, at(tree));
    tree = scanJsonc(next);
  }
  return { text: next, root: tree };
}

/** The text with our server after the person's, in an `amp.mcpServers` of its own, indented as theirs, when there is none. */
function textWith(text, root, entry) {
  const ours = `${JSON.stringify(SERVER_NAME)}: ${serverText(entry)}`;
  const servers = root.members.find((m) => m.key === SERVERS)?.node;
  if (servers?.members) return addMember(text, servers, ours);
  const lead = root.members.length ? leadOf(text, root.members[root.members.length - 1].keyStart) : ' ';
  const lines = lead.startsWith('\n');
  const unit = lines ? (lead.includes('\t') ? '\t' : lead.slice(1) || '  ') : '';
  return addMember(text, root, `${JSON.stringify(SERVERS)}: {${lines ? lead + unit : ' '}${ours}${lines ? lead : ' '}}`);
}

/** The settings text with our server in place of any server of ours: the new text, or null when it does not read as exactly that. */
function settingsWith(text, root, entry) {
  const out = textWithout(text, root);
  const next = textWith(out.text, out.root, entry);
  // read again: the same settings, and our server, or nothing is written
  const rest = withoutOurs(root.value);
  const wanted = { ...rest, [SERVERS]: { ...(rest[SERVERS] ?? {}), [SERVER_NAME]: entry } };
  return sameValue(scanJsonc(next).value, wanted) ? next : null;
}

/** Our server into the settings: { status: added | already | taken | invalid, why? }. */
function addAmpServer(file, entry) {
  const read = readSettings(file);
  if (read.invalid) return { status: 'invalid', why: read.why };
  if (!read.existed || !read.root) {
    // made here: what is left of it once our server is out again is MADE_EMPTY, and logout takes the file
    writeFileSafely(file, `${JSON.stringify({ [SERVERS]: { [SERVER_NAME]: entry } }, null, 2)}\n`, { mode: PRIVATE });
    return { status: 'added' };
  }
  const servers = read.root.value[SERVERS];
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) {
    return { status: 'invalid', why: `its ${SERVERS} is not an object` };
  }
  const current = servers?.[SERVER_NAME];
  if (current !== undefined && !isOurServer(current)) return { status: 'taken' };
  if (current !== undefined && same(current, entry)) return { status: 'already' };
  let next = null;
  try {
    next = settingsWith(read.text, read.root, entry);
  } catch {
    next = null;
  }
  if (next === null) return { status: 'invalid', why: 'the server could not be added without rewriting what is there' };
  writeFileSafely(file, next, { mode: PRIVATE });
  return { status: 'added' };
}

/**
 * Our server out of the settings, and `amp.mcpServers` with it when nothing
 * else is left in it; the file goes when nothing at all is. { removed,
 * invalid }: invalid when it cannot be read and may still hold ours.
 */
function removeAmpServer(file) {
  const read = readSettings(file);
  if (read.invalid) {
    // one that cannot be read at all may hold ours as well as any
    const text = read.text ?? '';
    return { removed: false, invalid: Boolean(read.unreadable) || (RUNS_OURS.test(text) && text.includes(serverArgs('')[0])) };
  }
  if (!read.root || !isOurServer(read.root.value[SERVERS]?.[SERVER_NAME])) return { removed: false };
  try {
    const out = textWithout(read.text, read.root);
    if (!sameValue(out.root.value, withoutOurs(read.root.value))) return { removed: false, invalid: true };
    // left as a file login made leaves it (see addAmpServer): gone; an empty object of the person's stays
    if (out.text === MADE_EMPTY) removeFile(file, '{}\n');
    else writeFileSafely(file, out.text, { mode: PRIVATE });
    return { removed: true };
  } catch {
    return { removed: false, invalid: true };
  }
}

const hasAmpServer = (file) => {
  const read = readSettings(file);
  return Boolean(read.root && isOurServer(read.root.value[SERVERS]?.[SERVER_NAME]));
};

/** Whether the settings turn on Amp's old permission rules, which make the plugin only report. */
function oldPermissions(file) {
  const value = readSettings(file).root?.value ?? {};
  return value['amp.permissions'] !== undefined || value['amp.dangerouslyAllowAll'] === false || value['amp.guardedFiles.allowlist'] !== undefined;
}

export default {
  id: 'amp',
  name: 'Amp',
  order: 50,
  // the plugins folder follows XDG_CONFIG_HOME, and the installer AMP_HOME
  env: ['AMP_HOME', 'XDG_CONFIG_HOME'],
  files,
  /** What login registers: the plugin, named by its file, with the line that names the hooks folder. */
  hooks: (hookDir) => ({
    plugin: { file: AMP_PLUGIN_FILE, line: `const HOOKS_DIR = ${JSON.stringify(hookDir)}; // agentmash:hooks-dir`, events: [...PLUGIN_EVENTS] },
  }),
  detect(places) {
    const bin = ampBin(places);
    return { found: Boolean(bin) || exists(ampDir(places)), bin };
  },
  connect(places, hookDir) {
    const at = files(places);
    const want = ampPlugin(hookDir);
    if (!want) return { status: 'skipped', why: 'this copy of agentmash has no Amp plugin in it (clients/amp/plugin.mjs): install it again' };
    const plugins = path.dirname(at.plugin);
    let current;
    try {
      current = readText(at.plugin);
    } catch (err) {
      return { status: 'skipped', why: `${shown(at.plugin, places)} is there and could not be read (${err.code ?? err.message}): left as it is` };
    }
    if (current !== null && !pluginHooksDir(current)) {
      return { status: 'skipped', why: `${shown(at.plugin, places)} is there already, and not ours: left as it is` };
    }
    for (const other of ['agentmash.js', 'agentmash']) {
      if (exists(path.join(plugins, other))) return { status: 'skipped', why: `${shown(path.join(plugins, other), places)} is a plugin of that name already: left as it is` };
    }
    const changed = current !== want;
    if (changed) writeFileSafely(at.plugin, want, { mode: 0o644 });

    const notes = [];
    const server = addAmpServer(at.settings, { command: 'node', args: serverArgs(hookDir) });
    if (server.status === 'taken') notes.push(`a server called agentmash is in ${shown(at.settings, places)} already, and not ours: left as it is`);
    if (server.status === 'invalid') notes.push(`${shown(at.settings, places)} could not be read (${server.why}): the MCP server was not added, and the file was left as it was`);
    const status = changed || server.status === 'added' ? 'connected' : 'already';
    if (status === 'connected') notes.push('Amp loads the plugin when it next starts; in an Amp already running: Ctrl+O, then plugins: reload');
    if (oldPermissions(at.settings)) {
      notes.push(
        "your Amp settings turn on its permission rules (amp.permissions): there AgentMash reports Amp's edits, " +
          'and answers no tool call, so it says nothing before an edit'
      );
    } else if (status === 'connected') {
      notes.push("Amp shows the agent a warning by refusing its first edit of a file a teammate's agent is in; the same edit again goes through");
    }
    return { status, notes, where: shown(at.plugin, places) };
  },
  disconnect(places) {
    const at = files(places);
    let plugin = { removed: false };
    if (pluginHooksDir(peekText(at.plugin))) {
      removeFile(at.plugin, NO_PLUGIN);
      plugin = { removed: true };
    }
    const server = removeAmpServer(at.settings);
    // the folders, when this made them and they hold nothing else now
    removeIfEmpty(path.dirname(at.plugin));
    removeIfEmpty(ampDir(places));
    return outcome([plugin, at.plugin, places], [server, at.settings, places]);
  },
  inspect(places) {
    const at = files(places);
    const dir = pluginHooksDir(peekText(at.plugin));
    return {
      connected: Boolean(dir),
      // the plugin is code, and Amp reads it whatever the settings say
      invalid: false,
      where: shown(at.plugin, places),
      events: dir ? [...PLUGIN_EVENTS] : [],
      missing: dir ? PLUGIN_RUNS.map((f) => path.join(dir, f)).filter((f) => !exists(f)) : [],
      mcp: hasAmpServer(at.settings),
    };
  },
};
