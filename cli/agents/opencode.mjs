// OpenCode (anomalyco/opencode, once sst/opencode). It has no command hooks:
// it runs JS plugins in its own process, every .js file in a config folder's
// plugin/ at startup, with no approval step. So login writes one plugin of
// ours at user level, ~/.config/opencode/plugin/agentmash.js, that hands
// each of OpenCode's hook calls to the generic hook (hooks/agent_hook.mjs,
// --client opencode, in the opencode dialect) as a process of its own, and
// adds the MCP server to OpenCode's own global config file. Nothing goes in a
// repository.
//
// Why it is built the way it is (OpenCode 1.18.34's source, and what was
// checked against older tags):
//
//   - plugin/, singular. OpenCode reads {plugin,plugins}/*.{ts,js} today, but
//     from 1.0.0 to 1.0.218 a config folder holding plugins/ stops the config
//     loading at all; plugin/ is read by every version from 0.14 on. .mjs is
//     never read.
//   - One named export, a function: an older OpenCode calls every export of a
//     plugin file, and drops the whole file when one is not a function.
//   - The plugin does no work of its own in OpenCode's process: everything is
//     a node process the plugin waits on with a deadline, or does not wait on
//     at all. OpenCode waits on a plugin hook with no timeout, and a hook that
//     throws refuses the call, so every hook catches everything, and only the
//     refusal it means to make is thrown.
//   - `node` from PATH, as every other agent's hooks run it: the desktop app
//     starts its server with the person's login shell's environment.
//   - The config is JSONC (OpenCode reads comments and trailing commas in every
//     one of its config files), so our server goes in, and comes out, as text:
//     one member added after the person's, laid out as theirs are, and taken
//     out again to the byte, comments and all.

import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_HOOK_SCRIPT,
  OURS,
  PRIVATE,
  RUNS_OURS,
  SERVER_NAME,
  SERVER_SCRIPT,
  exists,
  outcome,
  peekText,
  readText,
  removeFile,
  shown,
  which,
  writeFileSafely,
} from '../agent-kit.mjs';

const ID = 'opencode';
/** Our plugin, in the folder every OpenCode reads (see above). */
const PLUGIN = path.join('plugin', 'agentmash.js');
/** OpenCode's global config files, in the order it picks the one it writes to (config.ts, globalConfigFile). */
const CONFIG_FILES = ['opencode.jsonc', 'opencode.json', 'config.json'];
const SCHEMA_URL = 'https://opencode.ai/config.json';
/** The first line of the plugin: with a path into .agentmash/hooks, what says a plugin file is ours. */
const MARKER = '// AgentMash for OpenCode.';

/** OpenCode's global config folder: $XDG_CONFIG_HOME/opencode, else ~/.config/opencode, on every OS (core/src/global.ts). */
const configDir = (places) => path.join(process.env.XDG_CONFIG_HOME || path.join(places.home, '.config'), 'opencode');

const files = (places) => {
  const dir = configDir(places);
  return {
    plugin: path.join(dir, PLUGIN),
    config: path.join(dir, CONFIG_FILES[0]),
    configJson: path.join(dir, CONFIG_FILES[1]),
    configLegacy: path.join(dir, CONFIG_FILES[2]),
  };
};
const configFiles = (at) => [at.config, at.configJson, at.configLegacy];

/**
 * What the plugin runs for each of OpenCode's hooks, with node: the generic
 * hook, for OpenCode, in its own dialect, reading OpenCode's calls as they
 * come. The same arguments every time, and no version among them. A session's
 * end is run for session.deleted, and for each session still open when
 * OpenCode closes (the plugin's dispose).
 */
export function opencodeHooks(hookDir) {
  const run = (event) => [path.join(hookDir, AGENT_HOOK_SCRIPT), event, '--global', '--client', ID, '--dialect', ID, '--input', 'native'];
  return {
    'tool.execute.before': run('pre_edit'),
    'tool.execute.after': run('post_edit'),
    'chat.message': run('prompt'),
    'session.deleted': run('session_end'),
  };
}

/** Our MCP server, as OpenCode's config takes a local one (core/src/v1/config/mcp.ts). */
export const opencodeServer = (hookDir) => ({ type: 'local', command: ['node', path.join(hookDir, SERVER_SCRIPT)], enabled: true });

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isOurServer = (server) =>
  isObject(server) && Array.isArray(server.command) && server.command.some((c) => typeof c === 'string' && OURS.test(c) && c.includes(SERVER_SCRIPT));
const isOurPlugin = (text) => typeof text === 'string' && text.startsWith(MARKER) && RUNS_OURS.test(text);

// ── the plugin ──────────────────────────────────────────────────────────────
//
// Written whole by login, from the template below: `__HOOKS__` is where it
// runs the hooks from, `__RUNS__` opencodeHooks as JSON, on a line of its
// own (inspect reads it back). The template is raw text: no backtick and no
// dollar-brace in it.

const PLUGIN_TEMPLATE = String.raw`// AgentMash for OpenCode. Written by "npx agentmash login" and taken out by
// "npx agentmash logout"; the next login writes it over, so a change made to
// it does not last.
//
// OpenCode runs this file in its own process. It does no work there: each of
// OpenCode's calls below goes to AgentMash's generic hook, a node process of
// its own, run from __HOOKS__
//
//   before edit, write or apply_patch   asks whether a teammate's agent is in
//                                       the file; when one is, the first try is
//                                       refused with what they did as the
//                                       reason, which the model reads, and the
//                                       same edit again goes through
//   after an edit or a shell command    reports the change, in the background
//   a prompt                            reports it, as what the session is for
//   a session deleted, OpenCode closing reports the session's end
//
// It fails open: whatever goes wrong, and an answer later than WAIT_MS, lets
// the call go on as it would have without this file. It never changes a
// call's arguments, and never answers a permission question: what OpenCode
// would ask the person about, it still asks.

import { spawn } from 'node:child_process';

/** What each hook runs, with node. */
const RUNS = __RUNS__;
const NODE = 'node';
/** The tools that change a file they name: asked about before they run. */
const EDITS = new Set(['edit', 'write', 'apply_patch']);
/** The tools reported after they ran: the edits, and a shell command, whose changes the working tree shows. */
const REPORTED = new Set(['edit', 'write', 'apply_patch', 'bash']);
/** The longest an edit waits for its answer; the hook's own deadline comes well before. */
const WAIT_MS = 5000;
const MAX_ANSWER = 65536;
/** Sessions remembered, at most. */
const KEPT = 1000;

/** Run a hook and wait: what it printed, or '' when it failed or took too long. Never throws. */
function ask(argv, payload) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let child = null;
    let timer = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    try {
      const body = JSON.stringify(payload);
      timer = setTimeout(() => {
        try {
          if (child) child.kill();
        } catch {}
        finish('');
      }, WAIT_MS);
      child = spawn(NODE, argv, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      child.on('error', () => finish(''));
      child.on('close', (code) => finish(code === 0 ? out : ''));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        if (out.length < MAX_ANSWER) out += d;
      });
      child.stdin.on('error', () => {});
      child.stdin.end(body);
    } catch {
      finish('');
    }
  });
}

/** Hand a report to a hook in the background: resolves once it is handed over. Never throws. */
function tell(argv, payload) {
  return new Promise((resolve) => {
    try {
      const body = JSON.stringify(payload);
      const child = spawn(NODE, argv, { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      child.on('error', () => resolve(false));
      child.stdin.on('error', () => resolve(false));
      child.stdin.end(body, () => resolve(true));
      child.unref();
    } catch {
      resolve(false);
    }
  });
}

/** Keep at most KEPT of a Map or a Set, the oldest going first. */
function trim(kept) {
  while (kept.size > KEPT) kept.delete(kept.keys().next().value);
}

export const AgentMash = async (context) => {
  const directory = context && typeof context.directory === 'string' ? context.directory : process.cwd();
  /** A subagent's session (the task tool's), and the session it was started from. */
  const parents = new Map();
  /** The top sessions that did anything here: each one's end is reported when OpenCode closes. */
  const open = new Set();

  const rootOf = (session) => {
    let at = session;
    for (let i = 0; i < 20 && parents.has(at); i++) at = parents.get(at);
    return at;
  };
  /** What the hook reads: OpenCode's own input and output, and where it works (the opencode dialect). */
  const envelope = (hook, input, output) => {
    const said = { opencode: 1, hook, directory, input };
    const session = input && input.sessionID;
    const root = typeof session === 'string' ? rootOf(session) : null;
    if (root && root !== session) said.root = root;
    if (output) said.output = output;
    return said;
  };
  const busy = (session) => {
    if (typeof session !== 'string') return;
    open.add(rootOf(session));
    trim(open);
  };

  return {
    'tool.execute.before': async (input, output) => {
      let reason = null;
      try {
        if (input && EDITS.has(input.tool)) {
          const said = await ask(
            RUNS['tool.execute.before'],
            envelope('tool.execute.before', { tool: input.tool, sessionID: input.sessionID, callID: input.callID }, { args: output && output.args })
          );
          const answer = said.trim() ? JSON.parse(said) : null;
          if (answer && answer.decision === 'deny' && typeof answer.reason === 'string' && answer.reason) reason = answer.reason;
        }
      } catch {
        reason = null;
      }
      // the one way a plugin has of telling the model before an edit: refusing it, with the reason
      if (reason) throw new Error(reason);
    },

    'tool.execute.after': async (input) => {
      try {
        if (!input || !REPORTED.has(input.tool)) return;
        busy(input.sessionID);
        void tell(
          RUNS['tool.execute.after'],
          envelope('tool.execute.after', { tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: input.args })
        );
      } catch {}
    },

    'chat.message': async (input, output) => {
      try {
        const message = output && output.message;
        const session = (input && input.sessionID) || (message && message.sessionID);
        // a subagent's prompt is the task its parent wrote for it, not the person's
        if (typeof session !== 'string' || parents.has(session)) return;
        const parts = (output && Array.isArray(output.parts) ? output.parts : [])
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => ({ type: 'text', text: p.text, synthetic: p.synthetic === true, ignored: p.ignored === true }));
        if (parts.length === 0) return;
        busy(session);
        void tell(RUNS['chat.message'], envelope('chat.message', { sessionID: session, agent: input && input.agent }, { message: { sessionID: session }, parts }));
      } catch {}
    },

    // OpenCode does not wait on this one, so nothing in it may ever reject
    event: async (arg) => {
      try {
        const event = arg && arg.event;
        const props = (event && event.properties) || {};
        const info = props.info || {};
        if (event.type === 'session.created' || event.type === 'session.updated') {
          if (typeof info.id === 'string' && typeof info.parentID === 'string') {
            parents.set(info.id, info.parentID);
            trim(parents);
          }
        } else if (event.type === 'session.deleted') {
          const session = typeof info.id === 'string' ? info.id : props.sessionID;
          if (typeof session !== 'string') return;
          const child = parents.has(session) || typeof info.parentID === 'string';
          parents.delete(session);
          open.delete(session);
          if (!child) void tell(RUNS['session.deleted'], envelope('session.deleted', { sessionID: session }));
        }
      } catch {}
    },

    dispose: async () => {
      try {
        const ending = [...open];
        open.clear();
        await Promise.all(ending.map((session) => tell(RUNS['session.deleted'], envelope('dispose', { sessionID: session }))));
      } catch {}
    },
  };
};
`;

/** The plugin login writes, for the hooks in `hookDir`: the same text every time. */
export function opencodePlugin(hookDir) {
  // replaced by functions: a $ in a path is not a pattern
  return PLUGIN_TEMPLATE.replace('__HOOKS__', () => hookDir.replace(/[\r\n]/g, ' ')).replace('__RUNS__', () => JSON.stringify(opencodeHooks(hookDir)));
}

/** What a plugin of ours runs, read back from it: {} when it says nothing we can read. */
function runsIn(text) {
  try {
    const runs = JSON.parse(/^const RUNS = (.*);$/m.exec(text)?.[1] ?? 'null');
    return isObject(runs) ? runs : {};
  } catch {
    return {};
  }
}

// ── OpenCode's config, as JSONC ─────────────────────────────────────────────

/**
 * A JSONC text (JSON with comments and trailing commas, as OpenCode reads its
 * config files, config/parse.ts) read for editing: the root object's node,
 * `{ start, end, value, members }`, each member `{ key, keyStart, node, comma }`
 * (comma: where the one after it is, or -1), so one member can be added or
 * taken out without a byte of anything else moving. null when it is not a
 * JSONC object.
 */
export function readJsonc(text) {
  let i = 0;
  const n = text.length;
  const bad = () => {
    throw new SyntaxError('not JSONC');
  };
  const space = () => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff) i++;
      else if (c === 47 && text.charCodeAt(i + 1) === 47) {
        const end = text.indexOf('\n', i);
        i = end === -1 ? n : end;
      } else if (c === 47 && text.charCodeAt(i + 1) === 42) {
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
      else if (c === '"') return JSON.parse(text.slice(start, ++i));
      else i++;
    }
    return bad();
  };
  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const value = () => {
    space();
    const start = i;
    const c = text[i];
    if (c === '{') {
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
    if (c === '[') {
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
    if (c === '"') {
      const parsed = string();
      return { start, end: i, value: parsed };
    }
    for (const [word, literal] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return { start, end: i, value: literal };
      }
    }
    NUMBER.lastIndex = i;
    const number = NUMBER.exec(text);
    if (!number) bad();
    i += number[0].length;
    return { start, end: i, value: Number(number[0]) };
  };
  try {
    const root = value();
    space();
    return i === n && root.members ? root : null;
  } catch {
    // not JSONC, or nested deeper than the stack goes
    return null;
  }
}

/** An object node's member named `key`: the last, as a JSON reader takes it. */
const memberOf = (node, key) => node?.members?.findLast((m) => m.key === key) ?? null;

/** The whitespace the line `at` is on starts with. */
const indentAt = (text, at) => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', at - 1) + 1))[0];
/** Whether nothing but spaces comes before `at` on its line. */
const startsLine = (text, at) => /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', at - 1) + 1, at));

/** `value` as JSON, `unit` deeper for each level, its lines after the first at `indent`. */
const pretty = (value, indent, unit) => JSON.stringify(value, null, unit).split('\n').join(`\n${indent}`);

/**
 * Where a member goes in at `at`: there, or, when the rest of its line is a
 * // comment, at the end of the line, so the comment stays with what it was
 * written beside.
 */
function lineEndPast(text, at) {
  const rest = /^[ \t]*\/\/[^\n]*/.exec(text.slice(at));
  return rest ? at + rest[0].length : at;
}

/**
 * Where the line a member starts on begins, when nothing but space is
 * between that and the member: from `from`, the first place it could. -1
 * when the member does not start a line.
 */
function lineStartBefore(text, from, keyStart) {
  const between = text.slice(from, keyStart);
  const nl = between.lastIndexOf('\n');
  return nl !== -1 && /^\s*$/.test(between.slice(nl)) ? from + nl : -1;
}

/**
 * `text` with `key`: `value` added to the object `node`, after its last
 * member, laid out as its members are: on a line of its own, indented as they
 * are (a level deeper than the object, when it has none), or, in an object
 * written on one line, on that line.
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
    const close = at === open ? `\n${outer}` : '';
    return `${text.slice(0, at)}\n${indent}${member}${close}${text.slice(at)}`;
  }
  // after a trailing comma, ours gets one too, as the person writes them
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

/** A config file login made, with only our server in it. */
const newConfig = (server) => `${JSON.stringify({ $schema: SCHEMA_URL, mcp: { [SERVER_NAME]: server } }, null, 2)}\n`;
/** What logout leaves of a file login made: one it takes away. */
const EMPTIED = `${JSON.stringify({ $schema: SCHEMA_URL }, null, 2)}\n`;

/** Where a config's servers are, and the one called agentmash among them. */
function serverIn(root) {
  const mcp = memberOf(root, 'mcp');
  return { mcp, server: mcp?.node.members ? memberOf(mcp.node, SERVER_NAME) : null };
}

/**
 * Our server into OpenCode's global config: `added`, `already`, `taken` (an
 * agentmash of someone else's is in one of its files), `invalid` (a file
 * that cannot be read as JSONC; `file` says which) or `shape` (its `mcp` is
 * not an object). OpenCode merges its three global files, so a server of ours
 * in any of them is ours; a new one goes in the file OpenCode itself writes
 * to, the first there is of opencode.jsonc, opencode.json and config.json.
 */
function registerServer(at, entry) {
  const read = [];
  for (const file of configFiles(at)) {
    try {
      read.push({ file, text: readText(file) });
    } catch (err) {
      // there, and not to be read: never taken for no config, and a new one written over it
      return { status: 'invalid', file, unreadable: err.code ?? err.message };
    }
  }
  for (const r of read.filter((r) => r.text !== null)) {
    r.root = r.text.trim() ? readJsonc(r.text) : null;
    if (r.text.trim() && !r.root) return { status: 'invalid', file: r.file };
  }
  const there = read.filter((r) => r.root && serverIn(r.root).server);
  const theirs = there.find((r) => !isOurServer(serverIn(r.root).server.node.value));
  if (theirs) return { status: 'taken', file: theirs.file };
  if (there.length) {
    // ours from an earlier login: its value replaced where it is, when it is not this one
    const r = there[0];
    const { mcp, server } = serverIn(r.root);
    if (JSON.stringify(server.node.value) === JSON.stringify(entry)) return { status: 'already', file: r.file };
    const indent = indentAt(r.text, server.keyStart);
    const outer = indentAt(r.text, mcp.keyStart);
    const unit = indent.startsWith(outer) && indent.length > outer.length ? indent.slice(outer.length) : '  ';
    return writeConfig(r.file, r.text.slice(0, server.node.start) + pretty(entry, indent, unit) + r.text.slice(server.node.end), entry);
  }
  const target = read.find((r) => r.text !== null) ?? read[0];
  if (!target.root) return writeConfig(target.file, newConfig(entry), entry);
  const { mcp } = serverIn(target.root);
  if (mcp && !mcp.node.members) return { status: 'shape', file: target.file };
  const text = mcp ? withMember(target.text, mcp.node, SERVER_NAME, entry) : withMember(target.text, target.root, 'mcp', { [SERVER_NAME]: entry });
  return writeConfig(target.file, text, entry);
}

/** Write a config holding `entry` as our server, once it reads back so: a new file is private. */
function writeConfig(file, text, entry) {
  const back = readJsonc(text);
  const server = back && serverIn(back).server;
  if (!server || JSON.stringify(server.node.value) !== JSON.stringify(entry)) return { status: 'invalid', file };
  writeFileSafely(file, text, { mode: PRIVATE });
  return { status: 'added', file };
}

/** Our server out of one of OpenCode's config files, and `mcp` with it when ours was all it held. */
function unregisterServer(file) {
  let text;
  try {
    text = readText(file);
  } catch {
    return { removed: false, invalid: true }; // there, and may hold ours
  }
  if (text === null || !text.trim()) return { removed: false };
  let next = text;
  // a server of ours a second time over (a key given twice) comes out too
  for (let tries = 0; tries < 10; tries++) {
    const root = readJsonc(next);
    if (!root) return { removed: false, invalid: true };
    const { mcp, server } = serverIn(root);
    if (!server || !isOurServer(server.node.value)) break;
    next = mcp.node.members.length === 1 ? withoutMember(next, root, mcp) : withoutMember(next, mcp.node, server);
  }
  if (next === text) return { removed: false };
  if (!readJsonc(next)) return { removed: false, invalid: true };
  if (next === EMPTIED) removeFile(file, EMPTIED);
  else writeFileSafely(file, next);
  return { removed: true };
}

const hasServer = (file) => {
  const text = peekText(file);
  const root = text ? readJsonc(text) : null;
  return Boolean(root && isOurServer(serverIn(root).server?.node.value));
};

/** Take a folder away when it is empty: one this made, or one that held only what this took out. */
function removeIfEmpty(dir) {
  try {
    fs.rmdirSync(dir);
  } catch {
    // not empty, or not there
  }
}

export default {
  id: ID,
  name: 'OpenCode',
  order: 50,
  // OpenCode's config folder is under XDG_CONFIG_HOME when it is set, on every OS
  env: ['XDG_CONFIG_HOME'],
  files,
  hooks: opencodeHooks,
  detect(places) {
    // npm, brew and the rest put opencode on PATH; the install script puts it in ~/.opencode/bin, and no further
    const installed = path.join(places.home, '.opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    const bin = which('opencode', places.toolPath) ?? (exists(installed) ? installed : null);
    const app = Boolean(places.apps && exists(path.join(places.apps, 'OpenCode.app')));
    return { found: Boolean(bin) || exists(configDir(places)) || exists(path.join(places.home, '.opencode')) || app, bin };
  },
  connect(places, hookDir) {
    const at = files(places);
    let current;
    try {
      current = readText(at.plugin);
    } catch (err) {
      return { status: 'skipped', why: `${shown(at.plugin, places)} is there and could not be read (${err.code ?? err.message}): left as it is` };
    }
    if (current !== null && !isOurPlugin(current)) {
      return { status: 'skipped', why: `${shown(at.plugin, places)} is a plugin of somebody else's: left as it is` };
    }
    const want = opencodePlugin(hookDir);
    const changed = current !== want;
    if (changed) writeFileSafely(at.plugin, want);
    const server = registerServer(at, opencodeServer(hookDir));
    const notes = [];
    const where = server.file ? shown(server.file, places) : '';
    if (server.status === 'taken') notes.push(`a server called agentmash is in ${where} already, and not ours: left as it is`);
    if (server.status === 'invalid') notes.push(`${where} ${server.unreadable ? `could not be read (${server.unreadable})` : 'is not valid JSON'}: the MCP server was not added`);
    if (server.status === 'shape') notes.push(`"mcp" in ${where} is not an object: the MCP server was not added`);
    const status = changed || server.status === 'added' ? 'connected' : 'already';
    if (status === 'connected') {
      notes.push('OpenCode shows the agent a warning by refusing its first edit of a file a teammate is in; the same edit again goes through');
      notes.push('OpenCode loads plugins as it starts: restart it');
    }
    return { status, notes, where: shown(at.plugin, places) };
  },
  disconnect(places) {
    const at = files(places);
    let plugin = { removed: false };
    if (isOurPlugin(peekText(at.plugin))) {
      removeFile(at.plugin, '');
      plugin = { removed: true };
      removeIfEmpty(path.dirname(at.plugin));
    }
    const servers = configFiles(at).map((file) => [unregisterServer(file), file, places]);
    const result = outcome([plugin, at.plugin, places], ...servers);
    if (result.status === 'removed') removeIfEmpty(configDir(places));
    return result;
  },
  inspect(places) {
    const at = files(places);
    const text = peekText(at.plugin);
    const ours = isOurPlugin(text);
    const runs = ours ? runsIn(text) : {};
    const scripts = new Set(Object.values(runs).map((argv) => (Array.isArray(argv) ? argv[0] : null)).filter((s) => typeof s === 'string'));
    return {
      connected: ours,
      // the plugin is ours, whole, and never a file to fail reading; a config OpenCode cannot read stops only the MCP server
      invalid: false,
      where: shown(at.plugin, places),
      events: Object.keys(runs),
      missing: [...scripts].filter((script) => !exists(script)),
      mcp: configFiles(at).some(hasServer),
    };
  },
};
