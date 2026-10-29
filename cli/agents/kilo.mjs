// Kilo Code (Kilo-Org/kilocode): the `kilo` CLI, and the VS Code and
// JetBrains extensions, which since 7.0 all run the same backend, `kilo
// serve`, a fork of OpenCode. It has no command hooks: it runs JS plugins in
// its own process, with no approval step. So login writes one plugin of ours
// at user level, ~/.config/kilo/agentmash.js, that hands each of Kilo's hook
// calls to the generic hook (hooks/agent_hook.mjs, --client kilo, in the kilo
// dialect) as a process of its own, and names it, with our MCP server, in
// Kilo's own global config. One install covers the CLI and both extensions.
// Nothing goes in a repository.
//
// Why it is built the way it is (Kilo 7.8.3's source, and what was checked
// against older tags):
//
//   - The plugin is named in the global config ("plugin": ["file:///…"]), and
//     not dropped into ~/.config/kilo/plugin/. Kilo loads every file in a
//     config folder's plugin/ too, but a folder that holds one gets an npm
//     install of @kilocode/plugin into it, run again after every Kilo update,
//     and Kilo loads no plugin at all until that install is done or has
//     failed: offline, until the network times out (config/config.ts, the
//     directories loop; kilocode/config/plugin-deps.ts). A plugin named in the
//     global config costs none of that.
//   - Kilo reads kilo.jsonc and kilo.json from 7.0.28 on, so that is how old a
//     Kilo this works with (opencode.jsonc, when that is the file there is,
//     from 7.0.26).
//   - Kilo merges its five global files, config.json < kilo.json < kilo.jsonc
//     < opencode.json < opencode.jsonc, later ones winning, and a list in a
//     later file replaces one in an earlier file (remeda's mergeDeep): so our
//     plugin goes in the `plugin` list of the last file that has one, and,
//     when none has, with our server, in the file Kilo itself writes to, the
//     first there is of kilo.jsonc, kilo.json, opencode.jsonc, opencode.json
//     and config.json (globalConfigFile), a new kilo.jsonc when none is there.
//     A list the person starts in another file since hides ours, or ours
//     hides theirs (`kilo plugin --global` writes opencode.json): the next
//     login moves ours into their list and takes a list of ours alone away,
//     and while ours is the one hidden, inspect says Kilo is not connected.
//   - The plugin file sits beside the config, not among our hooks: deleting
//     ~/.agentmash by hand leaves Kilo a plugin that runs nothing, rather than
//     a config naming a file that is not there.
//   - One named export, a function: Kilo before 7.3 calls every export of a
//     plugin file, and 7.8.3 still takes a function export as a plugin.
//   - The plugin does no work of its own in Kilo's process: everything is a
//     node process the plugin waits on with a deadline, or does not wait on at
//     all. Kilo waits on a plugin hook with no timeout, and a hook that throws
//     refuses the call, so every hook catches everything, and only the
//     refusal it means to make is thrown.
//   - `node` from PATH, as every other agent's hooks run it: VS Code and the
//     JetBrains IDEs start Kilo's backend with the person's shell environment.
//   - The config is JSONC (Kilo reads comments and trailing commas in every
//     one of its config files), so our two entries go in, and come out, as
//     text: added after the person's, laid out as theirs are, and taken out
//     again to the byte, comments and all.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
  same,
  shown,
  which,
  writeFileSafely,
} from '../agent-kit.mjs';

const ID = 'kilo';
/** Our plugin, beside Kilo's global config and outside its plugin/ folder (see above). */
const PLUGIN_FILE = 'agentmash.js';
/** Kilo's global config files, in the order it merges them: a later one wins (config/config.ts, loadGlobal). */
const MERGE_ORDER = ['config.json', 'kilo.json', 'kilo.jsonc', 'opencode.json', 'opencode.jsonc'];
/** The order Kilo picks the global file it writes to (config/config.ts, globalConfigFile). */
const WRITE_ORDER = ['kilo.jsonc', 'kilo.json', 'opencode.jsonc', 'opencode.json', 'config.json'];
const SCHEMA_URL = 'https://app.kilo.ai/config.json';
/** The first line of the plugin: with a path into .agentmash/hooks, what says a plugin file is ours. */
const MARKER = '// AgentMash for Kilo Code.';
/** A plugin entry of ours, in any home: a file URL to an agentmash.js in a kilo config folder. */
const OUR_SPEC = /^file:\/\/.*\/kilo\/agentmash\.js$/;

/** Kilo's global config folder: $XDG_CONFIG_HOME/kilo, else ~/.config/kilo, on every OS (core/src/global.ts, xdg-basedir). */
const configDir = (places) => path.join(process.env.XDG_CONFIG_HOME || path.join(places.home, '.config'), 'kilo');
/** Kilo's data folder, made the first time any of its front ends runs: $XDG_DATA_HOME/kilo, else ~/.local/share/kilo. */
const dataDir = (places) => path.join(process.env.XDG_DATA_HOME || path.join(places.home, '.local', 'share'), 'kilo');

const files = (places) => {
  const dir = configDir(places);
  return {
    plugin: path.join(dir, PLUGIN_FILE),
    kiloJsonc: path.join(dir, 'kilo.jsonc'),
    kiloJson: path.join(dir, 'kilo.json'),
    opencodeJsonc: path.join(dir, 'opencode.jsonc'),
    opencodeJson: path.join(dir, 'opencode.json'),
    configJson: path.join(dir, 'config.json'),
  };
};

/** The entry that names our plugin in Kilo's config: its file, as a URL. */
const pluginSpec = (at) => pathToFileURL(at.plugin).href;

/**
 * What the plugin runs for each of Kilo's hooks, with node: the generic hook,
 * for Kilo, in its own dialect, reading Kilo's calls as they come. The same
 * arguments every time, and no version among them. A session's end is run
 * for session.deleted, and for each session still open when Kilo closes (the
 * plugin's dispose).
 */
export function kiloHooks(hookDir) {
  const run = (event) => [path.join(hookDir, AGENT_HOOK_SCRIPT), event, '--global', '--client', ID, '--dialect', ID, '--input', 'native'];
  return {
    'tool.execute.before': run('pre_edit'),
    'tool.execute.after': run('post_edit'),
    'chat.message': run('prompt'),
    'session.deleted': run('session_end'),
  };
}

/** Our MCP server, as Kilo's config takes a local one (core/src/v1/config/mcp.ts). */
export const kiloServer = (hookDir) => ({ type: 'local', command: ['node', path.join(hookDir, SERVER_SCRIPT)], enabled: true });

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isOurServer = (server) =>
  isObject(server) && Array.isArray(server.command) && server.command.some((c) => typeof c === 'string' && OURS.test(c) && c.includes(SERVER_SCRIPT));
const isOurSpec = (spec) => typeof spec === 'string' && OUR_SPEC.test(spec);
const isOurPlugin = (text) => typeof text === 'string' && text.startsWith(MARKER) && RUNS_OURS.test(text);

// ── the plugin ──────────────────────────────────────────────────────────────
//
// Written whole by login, from the template below: `__HOOKS__` is where it
// runs the hooks from, `__RUNS__` kiloHooks as JSON, on a line of its own
// (inspect reads it back). The template is raw text: no backtick and no
// dollar-brace in it.

const PLUGIN_TEMPLATE = String.raw`// AgentMash for Kilo Code. Written by "npx agentmash login", which names it in
// Kilo Code's global config, and taken out with that line by "npx agentmash
// logout"; the next login writes it again as it is here, so a change made to
// it does not last.
//
// Kilo Code runs this file in its own process: the kilo CLI's, or the backend
// its VS Code or JetBrains extension starts. It does no work there: each of
// Kilo's calls below goes to AgentMash's generic hook, a node process of its
// own, run from __HOOKS__
//
//   before edit, write, apply_patch     asks whether a teammate's agent is in
//   or notebook_edit                    the file; when one is, the first try is
//                                       refused with what they did as the
//                                       reason, which the model reads, and the
//                                       same edit again goes through
//   after an edit or a shell command    reports the change, in the background
//   a prompt                            reports it, as what the session is for
//   a session deleted, Kilo closing     reports the session's end
//
// It fails open: whatever goes wrong, and an answer later than WAIT_MS, lets
// the call go on as it would have without this file. It never changes a
// call's arguments, and never answers a permission question: what Kilo Code
// would ask the person about, it still asks, after this.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** What each hook runs, with node. */
const RUNS = __RUNS__;
const NODE = 'node';
/** The tools that change a file they name: asked about before they run. */
const EDITS = new Set(['edit', 'write', 'apply_patch', 'notebook_edit']);
/** The tools reported after they ran: the edits, and a shell command, whose changes the working tree shows. */
const REPORTED = new Set(['edit', 'write', 'apply_patch', 'notebook_edit', 'bash']);
/** The longest an edit waits for its answer; the hook's own deadline comes well before. */
const WAIT_MS = 5000;
const MAX_ANSWER = 65536;
/** Sessions remembered, at most. */
const KEPT = 1000;

/** Whether a hook's script is there: with the hooks folder gone, nothing is started at all. */
function present(argv) {
  try {
    return existsSync(argv[0]);
  } catch {
    return false;
  }
}

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
      if (!present(argv)) return finish('');
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
      if (!present(argv)) return resolve(false);
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
  /** The top sessions that did anything here: each one's end is reported when Kilo closes. */
  const open = new Set();

  const rootOf = (session) => {
    let at = session;
    for (let i = 0; i < 20 && parents.has(at); i++) at = parents.get(at);
    return at;
  };
  /** What the hook reads: Kilo's own input and output, and where it works (the kilo dialect). */
  const envelope = (hook, input, output) => {
    const said = { kilo: 1, hook, directory, input };
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
        const args = output && output.args;
        if (input && EDITS.has(input.tool) && args && typeof args === 'object') {
          const said = await ask(
            RUNS['tool.execute.before'],
            envelope('tool.execute.before', { tool: input.tool, sessionID: input.sessionID, callID: input.callID }, { args })
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

    // Kilo does not wait on this one, so nothing in it may ever reject
    event: async (arg) => {
      try {
        const event = arg && arg.event;
        const props = (event && event.properties) || {};
        const info = props.info || {};
        const id = typeof info.id === 'string' ? info.id : props.sessionID;
        if (event.type === 'session.created' || event.type === 'session.updated') {
          if (typeof id === 'string' && typeof info.parentID === 'string') {
            parents.set(id, info.parentID);
            trim(parents);
          }
        } else if (event.type === 'session.deleted') {
          if (typeof id !== 'string') return;
          const child = parents.has(id) || typeof info.parentID === 'string';
          parents.delete(id);
          open.delete(id);
          if (!child) void tell(RUNS['session.deleted'], envelope('session.deleted', { sessionID: id }));
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
export function kiloPlugin(hookDir) {
  // replaced by functions: a $ in a path is not a pattern
  return PLUGIN_TEMPLATE.replace('__HOOKS__', () => hookDir.replace(/[\r\n]/g, ' ')).replace('__RUNS__', () => JSON.stringify(kiloHooks(hookDir)));
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

// ── Kilo's config, as JSONC ─────────────────────────────────────────────────

/**
 * A JSONC text (JSON with comments and trailing commas, as Kilo reads its
 * config files) read for editing: its root object's node, `{ kind, start,
 * end, value, entries }`, each entry of an object or a list `{ key?, at,
 * colon?, node, comma }` (at: where it starts, its key or its value; comma:
 * where the one after it is, or -1), so one entry can be added or taken out
 * without a byte of anything else moving. null when it is not a JSONC object.
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
  /** The entries of an object or a list, up to its closing bracket; each read by `entry`. */
  const entries = (close, entry) => {
    const list = [];
    for (;;) {
      space();
      if (text[i] === close) break;
      const e = entry();
      list.push(e);
      space();
      if (text[i] === ',') e.comma = i++;
      else if (text[i] !== close) bad();
    }
    i++;
    return list;
  };
  const value = () => {
    space();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i++;
      const object = {};
      const list = entries('}', () => {
        if (text[i] !== '"') bad();
        const at = i;
        const key = string();
        space();
        if (text[i] !== ':') bad();
        const colon = i++;
        const node = value();
        Object.defineProperty(object, key, { value: node.value, enumerable: true, writable: true, configurable: true });
        return { key, at, colon, node, comma: -1 };
      });
      return { kind: 'object', start, end: i, value: object, entries: list };
    }
    if (c === '[') {
      i++;
      const list = entries(']', () => {
        const node = value();
        return { at: node.start, node, comma: -1 };
      });
      return { kind: 'array', start, end: i, value: list.map((e) => e.node.value), entries: list };
    }
    if (c === '"') {
      const parsed = string();
      return { kind: 'scalar', start, end: i, value: parsed };
    }
    for (const [word, literal] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return { kind: 'scalar', start, end: i, value: literal };
      }
    }
    NUMBER.lastIndex = i;
    const number = NUMBER.exec(text);
    if (!number) bad();
    i += number[0].length;
    return { kind: 'scalar', start, end: i, value: Number(number[0]) };
  };
  try {
    const root = value();
    space();
    return i === n && root.kind === 'object' ? root : null;
  } catch {
    // not JSONC, or nested deeper than the stack goes
    return null;
  }
}

/** An object node's member named `key`: the last, as a JSON reader takes it. */
const memberOf = (node, key) => (node?.kind === 'object' ? (node.entries.findLast((m) => m.key === key) ?? null) : null);

/** The whitespace the line `at` is on starts with. */
const indentAt = (text, at) => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', at - 1) + 1))[0];
/** Whether nothing but spaces comes before `at` on its line. */
const startsLine = (text, at) => /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', at - 1) + 1, at));

/** `value` as JSON, `unit` deeper for each level, its lines after the first at `indent`. */
const pretty = (value, indent, unit) => JSON.stringify(value, null, unit).split('\n').join(`\n${indent}`);

/**
 * Where an entry goes in at `at`: there, or, when the rest of its line is a
 * // comment, at the end of the line, so the comment stays with what it was
 * written beside.
 */
function lineEndPast(text, at) {
  const rest = /^[ \t]*\/\/[^\n]*/.exec(text.slice(at));
  return rest ? at + rest[0].length : at;
}

/**
 * Where the line an entry starts on begins, when nothing but space is between
 * that and the entry: from `from`, the first place it could. -1 when the
 * entry does not start a line.
 */
function lineStartBefore(text, from, at) {
  const between = text.slice(from, at);
  const nl = between.lastIndexOf('\n');
  return nl !== -1 && /^\s*$/.test(between.slice(nl)) ? from + nl : -1;
}

/** The space a one-line object or list puts after its commas: as the person does, else as after its colons. */
function inlineSpace(text, node) {
  const comma = node.entries.find((e, k) => e.comma !== -1 && node.entries[k + 1]);
  if (comma) return text[comma.comma + 1] === ' ' ? ' ' : '';
  if (node.kind === 'object') return text[node.entries[0].colon + 1] === ' ' ? ' ' : '';
  return ' ';
}

/**
 * `text` with `value` added to the object or list `node` (as `key`, for an
 * object), after its last entry, laid out as its entries are: on a line of
 * its own, indented as they are (a level deeper than the node, when it has
 * none), or, in one written on one line, on that line.
 */
function withEntry(text, node, key, value) {
  const object = node.kind === 'object';
  const outer = indentAt(text, node.start);
  const first = node.entries[0];
  const last = node.entries.at(-1);
  if (last && !text.slice(node.start, node.end).includes('\n')) {
    const sp = inlineSpace(text, node);
    const colon = object && text[first.colon + 1] === ' ' ? ' ' : '';
    const entry = object ? `${JSON.stringify(key)}:${colon}${JSON.stringify(value)}` : JSON.stringify(value);
    if (last.comma !== -1) return `${text.slice(0, last.comma + 1)}${sp}${entry},${text.slice(last.comma + 1)}`;
    return `${text.slice(0, last.node.end)},${sp}${entry}${text.slice(last.node.end)}`;
  }
  const indent = first && startsLine(text, first.at) ? indentAt(text, first.at) : `${outer}${outer.includes('\t') ? '\t' : '  '}`;
  const unit = indent.startsWith(outer) && indent.length > outer.length ? indent.slice(outer.length) : '  ';
  const entry = object ? `${JSON.stringify(key)}: ${pretty(value, indent, unit)}` : pretty(value, indent, unit);
  if (!last) {
    const open = node.start + 1;
    const at = lineEndPast(text, open);
    // brackets on one line ({} or []) open onto lines of their own
    const close = at === open ? `\n${outer}` : '';
    return `${text.slice(0, at)}\n${indent}${entry}${close}${text.slice(at)}`;
  }
  // after a trailing comma, ours gets one too, as the person writes them
  if (last.comma !== -1) {
    const at = lineEndPast(text, last.comma + 1);
    return `${text.slice(0, at)}\n${indent}${entry},${text.slice(at)}`;
  }
  const at = lineEndPast(text, last.node.end);
  return `${text.slice(0, last.node.end)},${text.slice(last.node.end, at)}\n${indent}${entry}${text.slice(at)}`;
}

/**
 * `text` without `entry` of the object or list `node`: withEntry undone to
 * the byte, and for an entry put there some other way, the entry, one comma
 * beside it, and the line it was on.
 */
function withoutEntry(text, node, entry) {
  const k = node.entries.indexOf(entry);
  const previous = node.entries[k - 1];
  const next = node.entries[k + 1];
  const from = previous ? previous.comma + 1 : node.start + 1;
  const line = lineStartBefore(text, from, entry.at);
  if (next) {
    return line !== -1 ? text.slice(0, line) + text.slice(entry.comma + 1) : text.slice(0, entry.at) + text.slice(next.at);
  }
  if (previous) {
    if (entry.comma !== -1) return text.slice(0, line !== -1 ? line : from) + text.slice(entry.comma + 1);
    return text.slice(0, previous.comma) + text.slice(previous.comma + 1, line !== -1 ? line : from) + text.slice(entry.node.end);
  }
  const end = entry.comma !== -1 ? entry.comma + 1 : entry.node.end;
  if (/^\s*$/.test(text.slice(from, entry.at))) {
    // brackets that were on one line close up again
    const outer = indentAt(text, node.start);
    const after = text.startsWith(`\n${outer}`, end) ? end + 1 + outer.length : end;
    return text.slice(0, from) + text.slice(after);
  }
  return text.slice(0, line !== -1 ? line : entry.at) + text.slice(end);
}

/** `text` with the value `node` replaced by `value`, laid out at the indent of the line it starts on. */
function withValue(text, node, value) {
  const indent = indentAt(text, node.start);
  return text.slice(0, node.start) + pretty(value, indent, '  ') + text.slice(node.end);
}

/** What login starts a config file with when there is none: what Kilo itself would (config.ts, loadGlobal). */
const NEW_CONFIG = `${JSON.stringify({ $schema: SCHEMA_URL }, null, 2)}\n`;
/** What logout leaves of a file login made: one it takes away. */
const EMPTIED = NEW_CONFIG;

/** Where a config's servers are, and the one called agentmash among them. */
function serverIn(root) {
  const mcp = memberOf(root, 'mcp');
  return { mcp, server: mcp?.node.kind === 'object' ? memberOf(mcp.node, SERVER_NAME) : null };
}

/**
 * A config's value with what is ours taken out: our server, our plugin entry,
 * and `mcp` and `plugin` when that leaves them empty. What every edit here is
 * checked against: the same before and after, or the edit moved something of
 * the person's.
 */
function withoutOurs(value) {
  if (!isObject(value)) return value;
  const out = { ...value };
  if (isObject(out.mcp) && isOurServer(out.mcp[SERVER_NAME])) {
    const mcp = { ...out.mcp };
    delete mcp[SERVER_NAME];
    out.mcp = mcp;
  }
  if (isObject(out.mcp) && Object.keys(out.mcp).length === 0) delete out.mcp;
  if (Array.isArray(out.plugin)) {
    out.plugin = out.plugin.filter((spec) => !isOurSpec(spec));
    if (out.plugin.length === 0) delete out.plugin;
  }
  return out;
}

/**
 * Kilo's global config files, in its merge order: each one's text, its root
 * when it reads as JSONC, and whether it does not. One that is there and
 * cannot be read at all is invalid too, `unreadable`: never taken for none,
 * and a new config written over it.
 */
function readConfigs(dir) {
  return MERGE_ORDER.map((name) => {
    const file = path.join(dir, name);
    let text;
    try {
      text = readText(file);
    } catch {
      return { file, text: null, root: null, invalid: true, unreadable: true };
    }
    const root = text !== null && text.trim() ? readJsonc(text) : null;
    return { file, text, root, invalid: Boolean(text !== null && text.trim() && !root) };
  });
}

/** The file whose `plugin` list Kilo uses (the last in its merge order with one), or null when none has one. */
const pluginHolder = (configs) => configs.findLast((c) => c.root && memberOf(c.root, 'plugin')) ?? null;

/** Whether a config's `plugin` list holds nothing but ours: one login made, where there was no list. */
function oursOnly(config) {
  const node = memberOf(config.root, 'plugin')?.node;
  return node?.kind === 'array' && node.entries.length > 0 && node.entries.every((e) => isOurSpec(e.node.value));
}

/**
 * What login changes in Kilo's config, worked out and checked, nothing yet
 * written: { status: 'ok', plugin, server, serverFile, writes: [[file, text]] },
 * plugin and server each added or already, or the server taken (an
 * agentmash of someone else's is in one of the files) or shape (`mcp` is not
 * an object); or a status that stops login for Kilo: invalid (a file that is
 * not JSONC), list (`plugin` is not a list), unsafe (an edit that would have
 * moved something of the person's). `file` says which.
 */
function planConfig(at, hookDir) {
  const dir = path.dirname(at.plugin);
  const configs = readConfigs(dir);
  const bad = configs.find((c) => c.invalid);
  if (bad) return { status: 'invalid', file: bad.file, unreadable: Boolean(bad.unreadable) };
  // the list Kilo uses, of the person's: a list of ours alone, made by an earlier login where there was
  // none, comes out of any file once they have one, so that it never hides theirs
  const lists = configs.filter((c) => c.root && memberOf(c.root, 'plugin'));
  const holder = lists.filter((c) => !oursOnly(c)).at(-1) ?? lists.at(-1) ?? null;
  if (holder && memberOf(holder.root, 'plugin').node.kind !== 'array') return { status: 'list', file: holder.file };
  const target = WRITE_ORDER.map((name) => configs.find((c) => c.file === path.join(dir, name))).find((c) => c.text !== null) ?? configs[MERGE_ORDER.indexOf('kilo.jsonc')];
  const texts = new Map(configs.map((c) => [c.file, c.text]));
  const textOf = (file) => {
    const text = texts.get(file);
    return text === null || !text.trim() ? NEW_CONFIG : text;
  };

  // the plugin, in the list Kilo uses, or in a new one
  const spec = pluginSpec(at);
  const pluginFile = holder ? holder.file : target.file;
  let plugin = 'already';
  {
    const text = textOf(pluginFile);
    const root = readJsonc(text);
    const member = memberOf(root, 'plugin');
    if (!member) texts.set(pluginFile, withEntry(text, root, 'plugin', [spec]));
    else if (!member.node.entries.some((e) => e.node.value === spec)) {
      // one of ours from a home this one has moved from points at nothing: it becomes this one
      const stale = member.node.entries.find((e) => isOurSpec(e.node.value));
      texts.set(pluginFile, stale ? withValue(text, stale.node, spec) : withEntry(text, member.node, null, spec));
    }
    for (const c of lists) {
      if (c === holder || !oursOnly(c)) continue;
      texts.set(c.file, withoutEntry(c.text, c.root, memberOf(c.root, 'plugin')));
    }
    if (configs.some((c) => texts.get(c.file) !== c.text)) plugin = 'added';
  }

  // the server: ours wherever it is already, made this one; else beside where Kilo writes its own
  const entry = kiloServer(hookDir);
  let server = 'already';
  let serverFile = target.file;
  const current = configs.map((c) => {
    const text = texts.get(c.file);
    return { file: c.file, text, root: text !== null && text.trim() ? readJsonc(text) : null };
  });
  const there = current.filter((r) => r.root && serverIn(r.root).server);
  const theirs = there.find((r) => !isOurServer(serverIn(r.root).server.node.value));
  if (theirs) {
    server = 'taken';
    serverFile = theirs.file;
  } else if (there.length) {
    serverFile = there[0].file;
    for (const r of there) {
      const node = serverIn(r.root).server.node;
      if (same(node.value, entry)) continue;
      texts.set(r.file, withValue(r.text, node, entry));
      server = 'added';
    }
  } else {
    const text = textOf(target.file);
    const { mcp } = serverIn(readJsonc(text));
    if (mcp && mcp.node.kind !== 'object') server = 'shape';
    else {
      texts.set(target.file, mcp ? withEntry(text, mcp.node, SERVER_NAME, entry) : withEntry(text, readJsonc(text), 'mcp', { [SERVER_NAME]: entry }));
      server = 'added';
    }
  }

  // every file changed reads back as what was meant: the same config, with our plugin and server
  const writes = [];
  for (const c of configs) {
    const text = texts.get(c.file);
    if (text === c.text) continue;
    const back = readJsonc(text);
    const before = readJsonc(c.text === null || !c.text.trim() ? NEW_CONFIG : c.text);
    if (!back || !same(withoutOurs(back.value), withoutOurs(before.value))) return { status: 'unsafe', file: c.file };
    if (c.file === pluginFile && !back.value.plugin?.includes(spec)) return { status: 'unsafe', file: c.file };
    if (server === 'added' && serverIn(back).server && !same(serverIn(back).server.node.value, entry)) return { status: 'unsafe', file: c.file };
    writes.push([c.file, text]);
  }
  return { status: 'ok', plugin, server, serverFile, writes };
}

/**
 * Our server and our plugin entry out of one of Kilo's config files, and
 * `mcp` or `plugin` with them when ours was all it held; the file goes when
 * nothing of the person's is left in it. `invalid` when it cannot be read as
 * JSONC, and so may still hold ours.
 */
function unregister(file) {
  let text;
  try {
    text = readText(file);
  } catch {
    return { removed: false, invalid: true }; // there, and may hold ours
  }
  if (text === null || !text.trim()) return { removed: false };
  let next = text;
  // the server first, then the plugin: login's two edits undone in the order opposite to theirs.
  // A second one of ours (a key given twice, an entry listed twice) comes out too.
  for (let tries = 0; tries < 10; tries++) {
    const root = readJsonc(next);
    if (!root) return { removed: false, invalid: true };
    const { mcp, server } = serverIn(root);
    if (!server || !isOurServer(server.node.value)) break;
    next = mcp.node.entries.length === 1 ? withoutEntry(next, root, mcp) : withoutEntry(next, mcp.node, server);
  }
  for (let tries = 0; tries < 10; tries++) {
    const root = readJsonc(next);
    if (!root) return { removed: false, invalid: true };
    const member = memberOf(root, 'plugin');
    const item = member?.node.kind === 'array' ? member.node.entries.find((e) => isOurSpec(e.node.value)) : null;
    if (!item) break;
    next = member.node.entries.length === 1 ? withoutEntry(next, root, member) : withoutEntry(next, member.node, item);
  }
  if (next === text) return { removed: false };
  const back = readJsonc(next);
  if (!back || !same(withoutOurs(back.value), withoutOurs(readJsonc(text).value))) return { removed: false, invalid: true };
  if (next === EMPTIED) removeFile(file, EMPTIED);
  else writeFileSafely(file, next);
  return { removed: true };
}

/** Take a folder away when it is empty: one this made, or one that held only what this took out. */
function removeIfEmpty(dir) {
  try {
    fs.rmdirSync(dir);
  } catch {
    // not empty, or not there
  }
}

/** Whether VS Code has Kilo Code 7 or later installed: the first with the backend this connects to. */
function hasExtension(places) {
  try {
    return fs.readdirSync(path.join(places.home, '.vscode', 'extensions')).some((name) => {
      const major = /^kilocode\.kilo-code-(\d+)\./i.exec(name)?.[1];
      return major !== undefined && Number(major) >= 7;
    });
  } catch {
    return false;
  }
}

/** Kilo's own flag for running with no plugins at all (core/src/flag/flag.ts). */
const pure = () => /^(1|true)$/i.test(process.env.KILO_PURE ?? '');

export default {
  id: ID,
  name: 'Kilo Code',
  order: 50,
  // its config folder is under XDG_CONFIG_HOME and its data under XDG_DATA_HOME when they are set,
  // on every OS; KILO_PURE switches every plugin off
  env: ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KILO_PURE'],
  files,
  hooks: kiloHooks,
  detect(places) {
    // npm puts both kilo and kilocode on PATH, brew and the install script kilo
    const bin = which('kilo', places.toolPath) ?? which('kilocode', places.toolPath);
    return { found: Boolean(bin) || exists(configDir(places)) || exists(dataDir(places)) || hasExtension(places), bin };
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
      return { status: 'skipped', why: `${shown(at.plugin, places)} is a file of somebody else's: left as it is` };
    }
    const plan = planConfig(at, hookDir);
    const where = plan.file ? shown(plan.file, places) : '';
    if (plan.status === 'invalid') return { status: 'skipped', why: `${where} ${plan.unreadable ? 'could not be read' : 'is not valid JSON'} — fix it, then run login again` };
    if (plan.status === 'list') return { status: 'skipped', why: `"plugin" in ${where} is not a list, so Kilo Code could load no plugin of ours from it — fix it, then run login again` };
    if (plan.status === 'unsafe') return { status: 'skipped', why: `${where} could not be changed without moving something of yours in it: left as it is` };
    const want = kiloPlugin(hookDir);
    const changed = current !== want;
    // the plugin before the config that names it, so Kilo never reads a config naming a file not there yet
    if (changed) writeFileSafely(at.plugin, want);
    for (const [file, text] of plan.writes) writeFileSafely(file, text, { mode: PRIVATE });
    const notes = [];
    const serverWhere = shown(plan.serverFile, places);
    if (plan.server === 'taken') notes.push(`a server called agentmash is in ${serverWhere} already, and not ours: left as it is`);
    if (plan.server === 'shape') notes.push(`"mcp" in ${serverWhere} is not an object: the MCP server was not added`);
    const status = changed || plan.plugin === 'added' || plan.server === 'added' ? 'connected' : 'already';
    if (status === 'connected') {
      notes.push('Kilo Code shows the agent a warning by refusing its first edit of a file a teammate is in; the same edit again goes through');
      notes.push('Kilo Code loads plugins as it starts: restart it, or reload the editor window it runs in');
    }
    if (pure()) notes.push('KILO_PURE is set here: Kilo Code loads no plugin while it is, this one included');
    return { status, notes, where: shown(at.plugin, places) };
  },
  disconnect(places) {
    const at = files(places);
    const dir = configDir(places);
    const configs = MERGE_ORDER.map((name) => path.join(dir, name)).map((file) => [unregister(file), file, places]);
    // a config that could not be read may still name the plugin: it stays, and runs what it did
    let plugin = { removed: false };
    if (!configs.some(([r]) => r.invalid) && isOurPlugin(peekText(at.plugin))) {
      removeFile(at.plugin, '');
      plugin = { removed: true };
    }
    const result = outcome([plugin, at.plugin, places], ...configs);
    if (result.status === 'removed') removeIfEmpty(dir);
    return result;
  },
  inspect(places) {
    const at = files(places);
    const text = peekText(at.plugin);
    const ours = isOurPlugin(text);
    const configs = readConfigs(configDir(places));
    // a config Kilo cannot read stops all of Kilo, and our plugin with it: said once ours is there to stop
    const bad = ours ? configs.find((c) => c.invalid) : null;
    // named in the list Kilo uses: one in a file whose list a later file's replaces is never loaded
    const list = memberOf(pluginHolder(configs)?.root, 'plugin')?.node;
    const listed = list?.kind === 'array' && list.value.includes(pluginSpec(at));
    const runs = ours ? runsIn(text) : {};
    const scripts = new Set(Object.values(runs).map((argv) => (Array.isArray(argv) ? argv[0] : null)).filter((s) => typeof s === 'string'));
    const missing = [...scripts].filter((script) => !exists(script));
    // the generic hook answers Kilo in Kilo's dialect, a file beside it: without it, every call goes unasked and unreported
    for (const script of scripts) {
      const dialect = path.join(path.dirname(script), 'dialects', `${ID}.mjs`);
      if (exists(script) && !exists(dialect)) missing.push(dialect);
    }
    return {
      connected: ours && listed,
      invalid: Boolean(bad),
      where: shown(bad ? bad.file : at.plugin, places),
      events: Object.keys(runs),
      missing,
      mcp: configs.some((c) => c.root && isOurServer(serverIn(c.root).server?.node.value)),
    };
  },
};
