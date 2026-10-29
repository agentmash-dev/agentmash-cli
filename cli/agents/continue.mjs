// Continue (continuedev/continue): its VS Code and JetBrains extensions and
// its `cn` CLI. None of them runs a hook. cn carries a hooks module that
// nothing calls (PR #11043, which would have wired it up, was closed
// unmerged), and the extensions have none; its makers have stopped work on it,
// and 2.0.0 (June 2026) was its last release. So login gives Continue our MCP
// server and nothing else: its agent can ask the room who is working on what,
// and is warned when it asks, but none of its edits or prompts reach the room.
//
// The server goes in ~/.continue/config.yaml ($CONTINUE_GLOBAL_DIR when that
// is set), under mcpServers, which the extensions and cn both read. Only into
// a config.yaml that is there: cn without one runs on a config it is given or
// asks for an API key to make one, and an extension that finds config.yaml
// empty writes its own over it. (The other place Continue reads servers from,
// ~/.continue/mcpServers/, is the extensions' alone.)
//
// config.yaml is YAML, often holding the person's API keys, and there is no
// YAML library here, so it is edited as lines: our server goes in as one list
// item of three lines, after the person's last server (or, with no
// mcpServers yet, as that key at the end of the file), and comes out again as
// exactly those lines, so logout leaves the file as login found it. A file
// that is anything but a plain mapping of keys at the top level is not read
// as one: it is left as it is, and login says why.
//
// Nothing here approves anything: Continue asks before each MCP tool call
// (the extensions' "allowedWithPermission", cn's "ask"), and login writes no
// permissions.yaml.

import path from 'node:path';
import { RUNS_OURS, SERVER_NAME, SERVER_SCRIPT, exists, outcome, peekText, readText, realTarget, serverArgs, shown, which, writeFileSafely } from '../agent-kit.mjs';

const KEY = 'mcpServers';

/**
 * Continue's folder: $CONTINUE_GLOBAL_DIR when it is an absolute path (a
 * relative one Continue reads from wherever it was started), else ~/.continue.
 */
function continueDir(places) {
  const given = process.env.CONTINUE_GLOBAL_DIR;
  return given && path.isAbsolute(given) ? given : path.join(places.home, '.continue');
}

const files = (places) => ({ config: path.join(continueDir(places), 'config.yaml') });

/** What login registers: our server, as one item of Continue's mcpServers. */
export function continueServer(hookDir) {
  return { name: SERVER_NAME, command: 'node', args: serverArgs(hookDir) };
}

/**
 * Our item as its lines, its dash `dash` columns in: the same three every
 * time for the same folder. The path is written as JSON, which YAML reads as
 * a double-quoted string, whatever is in it.
 */
export function continueItem(hookDir, dash = 2, eol = '\n') {
  const pad = ' '.repeat(dash);
  const { name, command, args } = continueServer(hookDir);
  return [`${pad}- name: ${name}`, `${pad}  command: ${command}`, `${pad}  args: ${JSON.stringify(args)}`].map((line) => line + eol).join('');
}

/** cn, when the command of that name is Continue's: npm links it into @continuedev/cli, and on Windows puts a .cmd beside it. */
function cnCommand(places) {
  const bin = which('cn', places.toolPath);
  if (!bin) return null;
  if (/[\\/]@continuedev[\\/]cli[\\/]/.test(realTarget(bin))) return bin;
  if (process.platform === 'win32' && exists(path.join(path.dirname(bin), 'node_modules', '@continuedev', 'cli'))) return bin;
  return null;
}

// ── config.yaml, as lines ──────────────────────────────────────────────────
//
// Read only as far as adding or taking out one item needs: the keys at the
// top, and under mcpServers, where each item's lines start and end and the
// name it gives. Everything else is the person's, and is never looked into.

/** A mapping key and what follows its colon. A key that needs more than this to read is not read. */
const KEY_LINE = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([A-Za-z0-9_$][\w$.\/-]*))[ \t]*:(?:[ \t]+(.*))?$/;
/** A line that starts a list item. */
const DASH = /^-(?:[ \t]|$)/;

/** The key a KEY_LINE match names. */
function keyOf(m) {
  if (m[1] !== undefined) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return undefined;
    }
  }
  return m[2] !== undefined ? m[2].replace(/''/g, "'") : m[3];
}

/** Whether what follows a colon leaves the value to the lines below (nothing, or a comment). */
const opensBlock = (after) => {
  const value = (after ?? '').trim();
  return value === '' || value.startsWith('#');
};

/** The string a scalar after a colon says, its comment left off, or undefined for anything that is not one. */
function scalarOf(after) {
  const written = (after ?? '').trim();
  let m = /^"((?:[^"\\]|\\.)*)"[ \t]*(?:#.*)?$/.exec(written);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return undefined;
    }
  }
  m = /^'((?:[^']|'')*)'[ \t]*(?:#.*)?$/.exec(written);
  if (m) return m[1].replace(/''/g, "'");
  const plain = written.replace(/(?:^|[ \t]+)#.*$/, '').trim();
  return /^[^'"[\]{},&*!|>%@`#]/.test(plain) ? plain : undefined;
}

/** A text's lines: where each starts and ends (after its line break), its indent, and whether it is blank, a comment or content. */
function linesOf(text) {
  const lines = [];
  for (let start = 0; start < text.length; ) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl + 1;
    const body = text.slice(start, nl === -1 ? end : nl).replace(/\r$/, '');
    const lead = /^[ \t]*/.exec(body)[0];
    const rest = body.slice(lead.length);
    lines.push({ start, end, body, rest, indent: lead.length, tabbed: lead.includes('\t'), kind: rest === '' ? 'blank' : rest.startsWith('#') ? 'comment' : 'content' });
    start = end;
  }
  return lines;
}

/**
 * config.yaml read as described above: { lines, eol, servers } where servers
 * is null (no mcpServers) or { at, dash, items }, each item { name, from, to,
 * start, end, text } (its first and last content lines, and the text between);
 * or { why } when it cannot be read that way for certain.
 */
function readConfig(text) {
  if (text.charCodeAt(0) === 0xfeff) return { why: 'it starts with a byte order mark' };
  const lines = linesOf(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let at = null;
  let keys = 0;
  let block = false;
  for (const [i, line] of lines.entries()) {
    if (line.kind !== 'content') continue;
    if (line.tabbed) return { why: `line ${i + 1} is indented with a tab` };
    if (line.indent > 0) {
      if (!keys) return { why: 'it does not start with a key' };
      continue;
    }
    // a document's start, before anything else; a second document is not read
    if (!keys && /^---[ \t]*(?:#.*)?$/.test(line.body)) continue;
    // a list under the key above, written at the left edge
    if (DASH.test(line.body) && block) continue;
    const m = KEY_LINE.exec(line.body);
    if (!m || keyOf(m) === undefined) return { why: `line ${i + 1} is not a plain key` };
    keys++;
    block = opensBlock(m[4]);
    if (keyOf(m) === KEY) {
      if (at !== null) return { why: `it has ${KEY} twice` };
      at = i;
    }
  }
  if (!keys) return { why: 'it has no settings in it' };
  if (at === null) return { lines, eol, servers: null };

  const after = KEY_LINE.exec(lines[at].body)[4];
  if (!opensBlock(after)) return { why: `its ${KEY} is written on one line (${after.trim()})` };
  // its lines: up to the next key at the left edge
  let end = at + 1;
  while (end < lines.length && !(lines[end].kind === 'content' && lines[end].indent === 0 && !DASH.test(lines[end].body))) end++;
  const items = [];
  let dash = null;
  for (let i = at + 1; i < end; i++) {
    const line = lines[i];
    if (line.kind !== 'content') continue;
    dash ??= line.indent;
    const starts = line.indent === dash && DASH.test(line.rest);
    if (line.indent < dash || (line.indent === dash && !starts)) return { why: `its ${KEY} is not a list` };
    if (starts) items.push({ from: i, to: i });
    else items.at(-1).to = i;
  }
  for (const item of items) {
    const first = lines[item.from];
    const inline = first.rest.replace(/^-[ \t]*/, '');
    let inner = inline ? first.indent + first.rest.length - inline.length : null;
    const consider = (rest) => {
      const m = KEY_LINE.exec(rest);
      if (m && keyOf(m) === 'name' && item.name === undefined) item.name = scalarOf(m[4]);
    };
    if (inline) consider(inline);
    for (let i = item.from + 1; i <= item.to; i++) {
      const line = lines[i];
      if (line.kind !== 'content') continue;
      inner ??= line.indent;
      if (line.indent === inner) consider(line.rest);
    }
    item.start = first.start;
    item.end = lines[item.to].end;
    item.text = text.slice(item.start, item.end);
  }
  return { lines, eol, servers: { at, dash: dash ?? 2, items } };
}

/** An item of ours: called agentmash, and running our MCP server's script. */
const isOurItem = (item) => item.name === SERVER_NAME && RUNS_OURS.test(item.text) && item.text.includes(SERVER_SCRIPT);
const namesOf = (read) => (read.servers?.items ?? []).map((item) => item.name ?? null);

/**
 * The text without any item of ours, and without mcpServers when ours was all
 * that was under it and it is written as login writes it (unless `keepKey`):
 * { text, removed } or { why } when it cannot be read.
 */
function configWithout(text, { keepKey = false } = {}) {
  const read = readConfig(text);
  if (read.why) return { why: read.why };
  const ours = (read.servers?.items ?? []).filter(isOurItem);
  if (!ours.length) return { text, removed: false };
  let next = text;
  for (const item of [...ours].reverse()) next = next.slice(0, item.start) + next.slice(item.end);
  let back = readConfig(next);
  const key = back.servers && back.lines[back.servers.at];
  if (!keepKey && key && back.servers.items.length === 0 && new RegExp(`^${KEY}:[ \\t]*$`).test(key.body)) {
    next = next.slice(0, key.start) + next.slice(key.end);
    back = readConfig(next);
  }
  // read back: everything of the person's still there
  const theirs = namesOf(read).filter((_, i) => !isOurItem(read.servers.items[i]));
  if (back.why || JSON.stringify(namesOf(back)) !== JSON.stringify(theirs)) return { why: 'our server could not be taken out without rewriting what is there' };
  return { text: next, removed: true };
}

/** The text with our server in it: { status: added | already | taken | invalid, text?, why? }. */
function configWith(text, hookDir) {
  const read = readConfig(text);
  if (read.why) return { status: 'invalid', why: read.why };
  const named = (read.servers?.items ?? []).filter((item) => item.name === SERVER_NAME);
  if (named.some((item) => !isOurItem(item))) return { status: 'taken' };
  // ours, running this hooks folder's server: already, whatever else the person changed in it (a full path to node, say)
  if (named.length === 1 && scriptOf(named[0]) === serverArgs(hookDir)[0]) return { status: 'already' };
  // ours from an earlier login, for another hooks folder: out first, keeping the key it is under
  const base = named.length ? configWithout(text, { keepKey: true }) : { text };
  if (base.why) return { status: 'invalid', why: base.why };
  const now = named.length ? readConfig(base.text) : read;
  if (now.why) return { status: 'invalid', why: now.why };
  const { lines, eol, servers } = now;
  let next;
  if (!servers) {
    // no mcpServers yet: the key, with ours under it, at the end
    const start = base.text === '' || base.text.endsWith('\n') ? '' : eol;
    next = `${base.text}${start}${KEY}:${eol}${continueItem(hookDir, 2, eol)}`;
  } else {
    // after the person's last server, or right under the key
    const after = lines[servers.items.length ? servers.items.at(-1).to : servers.at];
    const start = base.text[after.end - 1] === '\n' ? '' : eol;
    next = base.text.slice(0, after.end) + start + continueItem(hookDir, servers.dash, eol) + base.text.slice(after.end);
  }
  // read back: the person's servers as they were, then ours, once, as written
  const back = readConfig(next);
  const want = [...namesOf(now), SERVER_NAME];
  const ours = back.why ? [] : back.servers.items.filter(isOurItem);
  if (back.why || JSON.stringify(namesOf(back)) !== JSON.stringify(want) || ours.length !== 1) {
    return { status: 'invalid', why: 'the server could not be added without rewriting what is there' };
  }
  return { status: 'added', text: next };
}

/** The MCP server script an item of ours runs, from the args login wrote; null when it reads otherwise. */
function scriptOf(item) {
  const m = /^[ \t]*args:[ \t]*(\[.*\])[ \t]*$/m.exec(item.text);
  try {
    const args = JSON.parse(m?.[1] ?? 'null');
    return Array.isArray(args) ? (args.find((a) => typeof a === 'string' && a.endsWith(SERVER_SCRIPT)) ?? null) : null;
  } catch {
    return null;
  }
}

/** Our item in config.yaml, or null. */
function ourItem(file) {
  const text = peekText(file);
  const read = text === null ? null : readConfig(text);
  return read?.servers?.items.find(isOurItem) ?? null;
}

export default {
  id: 'continue',
  name: 'Continue',
  // after the agents with hooks: Continue gets the MCP server alone
  order: 60,
  env: ['CONTINUE_GLOBAL_DIR'],
  // it has no hooks that run: login registers its MCP server and nothing more
  mcpOnly: true,
  files,
  hooks: (hookDir) => ({ [KEY]: [continueServer(hookDir)] }),
  detect(places) {
    const bin = cnCommand(places);
    return { found: Boolean(bin) || exists(continueDir(places)), bin };
  },
  connect(places, hookDir) {
    const at = files(places);
    const where = shown(at.config, places);
    let text;
    try {
      text = readText(at.config);
    } catch (err) {
      return { status: 'skipped', why: `${where} could not be read (${err.code ?? err.message}): left as it is` };
    }
    if (text === null) {
      const legacy = path.join(path.dirname(at.config), 'config.json');
      if (exists(legacy)) return { status: 'skipped', why: `${shown(legacy, places)} is Continue's older config, which agentmash does not edit: move to config.yaml, then run login again` };
      return { status: 'skipped', why: `there is no ${where} to add the MCP server to: open Continue once (or run cn), then run login again` };
    }
    const result = configWith(text, hookDir);
    if (result.status === 'taken') return { status: 'skipped', why: `a server called agentmash is in ${where} already, and not ours: left as it is` };
    if (result.status === 'invalid') {
      return { status: 'skipped', why: `${where} could not be added to without rewriting it (${result.why}): left as it was` };
    }
    if (result.status === 'added') writeFileSafely(at.config, result.text);
    const status = result.status === 'added' ? 'connected' : 'already';
    const notes = [];
    if (status === 'connected') {
      notes.push("Continue runs no hooks: it gets AgentMash's MCP tools only, so it hears about teammates when it asks, and its edits do not show in the room");
      notes.push('Continue asks before each agentmash tool call, and starts the server the next time it loads its config (a new cn, or a reload of your editor)');
    }
    return { status, notes, where };
  },
  disconnect(places) {
    const at = files(places);
    let text;
    let result = { removed: false };
    try {
      text = readText(at.config);
    } catch {
      result = { removed: false, invalid: true }; // there, and may hold ours
    }
    if (typeof text === 'string') {
      const out = configWithout(text);
      // one that cannot be read may still hold ours
      if (out.why) result = { removed: false, invalid: RUNS_OURS.test(text) && text.includes(SERVER_SCRIPT) };
      else if (out.removed) {
        writeFileSafely(at.config, out.text);
        result = { removed: true };
      }
    }
    return outcome([result, at.config, places]);
  },
  inspect(places) {
    const at = files(places);
    const ours = ourItem(at.config);
    const script = ours ? scriptOf(ours) : null;
    return {
      connected: Boolean(ours),
      // YAML this cannot read is not therefore YAML Continue cannot: never said to be broken
      invalid: false,
      where: shown(at.config, places),
      events: [],
      missing: script && !exists(script) ? [script] : [],
      mcp: Boolean(ours),
    };
  },
};
