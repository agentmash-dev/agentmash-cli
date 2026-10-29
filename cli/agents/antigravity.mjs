// Antigravity (Google): the Antigravity CLI, agy, reads its hooks from
// ~/.gemini/config/hooks.json and its MCP servers from
// ~/.gemini/config/mcp_config.json, files the Antigravity app and the
// Antigravity IDE read too (https://antigravity.google/docs/hooks/, /docs/mcp/).
// Its hooks run the generic hook (hooks/agent_hook.mjs) in Antigravity's own
// dialect (hooks/dialects/antigravity.mjs), which says why each answer is
// what it is. Nothing here is checked against a live agy yet: it is built
// from Antigravity's docs and from what others have recorded of it.
//
// Connected only when asked for (`npx agentmash tools add antigravity`), not
// by every login, for as long as that is so: `optIn`.
//
// What is registered, under a hook name of our own, "agentmash":
//
//   PostToolUse    after agy writes or edits a file, or runs a command: the
//                  report, in the background
//   PreInvocation  before each model call: at a turn's first, the prompt is
//                  reported, and the agent is told who of the team is at
//                  work on its branch or in its files (a note it reads, which
//                  holds nothing up)
//
// and no PreToolUse. Antigravity's hook before a tool can only let it run or
// refuse it: it cannot add a word to a call it lets through. Letting it run is
// "allow", which the docs say approves the call outright (that it does not
// today is a bug, antigravity-cli#1053), or "ask", whose effect on an edit
// the person's rules would have let through is unrecorded; and a hook there
// that fails in any way, a missing script or a slow machine included, refuses
// the call, so one broken install would stop every edit. The advice comes at
// the start of each turn instead.
//
// The hooks file: every top-level key is a hook name, mapping events to
// handlers. PostToolUse takes {matcher, hooks:[...]} groups, PreInvocation a
// flat list of handlers; a grouped entry on a flat event, or one key that is
// not a hook at all, makes agy drop the whole file, the person's hooks with
// it (antigravity-cli#925). So nothing but our hook goes in, in that shape,
// and a file that does not read as JSON is never written to. Ours is added
// as one block of text after theirs, and taken out as exactly that block, so
// the file is byte for byte what it was; when Antigravity has rewritten it
// since, it goes back through JSON. `enabled` is the person's switch (/hooks
// in agy): login never turns it back on.
//
// The command runs through `sh -c` in the folder of the hooks file, so the
// script is named by its whole path; on Windows agy splits the command on
// spaces and keeps the quotes, so the path goes bare there, and a hooks
// folder with a space in its path is not connected at all.

import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_HOOK_SCRIPT,
  RUNS_OURS,
  addServer,
  agentHookCommand,
  commandsOf,
  exists,
  hasServer,
  isOurEntry,
  isOurGroup,
  outcome,
  removeFile,
  removeServer,
  same,
  serverArgs,
  shown,
  which,
  writeFileSafely,
  writeJson,
} from '../agent-kit.mjs';

const ID = 'antigravity';
/** Our hook's name in hooks.json: one key of its own among the person's. */
export const HOOK_NAME = 'agentmash';
/** The tools that change files, and the one that runs commands (https://antigravity.google/docs/hooks/, "Supported tools"). */
const CHANGES = '^(write_to_file|replace_file_content|multi_replace_file_content|run_command)$';
/** Seconds; agy's default is 30. Ours answers in about three at most, its own guard included. */
const TIMEOUT = 10;

const files = (places) => {
  const config = path.join(places.home, '.gemini', 'config');
  return { hooks: path.join(config, 'hooks.json'), mcp: path.join(config, 'mcp_config.json') };
};

const WINDOWS = process.platform === 'win32';

/** The command for one event: agentHookCommand's, with the path bare on Windows (see the top). */
function command(hookDir, event) {
  if (!WINDOWS) return agentHookCommand(hookDir, event, ID);
  return ['node', path.join(hookDir, AGENT_HOOK_SCRIPT), event, '--global', '--client', ID].join(' ');
}

/** What login registers with Antigravity: one hook of ours, by name, in the shape each event takes. */
export function antigravityHooks(hookDir) {
  const handler = (event) => ({ type: 'command', command: command(hookDir, event), timeout: TIMEOUT });
  return {
    [HOOK_NAME]: {
      enabled: true,
      PostToolUse: [{ matcher: CHANGES, hooks: [handler('post_edit')] }],
      PreInvocation: [handler('prompt')],
    },
  };
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isOurs = (entry) => isOurEntry(entry) || isOurGroup(entry);
/** Every handler or group of ours in one hook name's events. */
const oursIn = (hook) => (isObject(hook) ? Object.values(hook).flatMap((v) => (Array.isArray(v) ? v.filter(isOurs) : [])) : []);
const eventsIn = (hook) => (isObject(hook) ? Object.keys(hook).filter((e) => Array.isArray(hook[e]) && hook[e].some(isOurs)) : []);

/**
 * hooks.json: { value, text, existed }, or { invalid, mentionsOurs } when it
 * is not a JSON object, or is there and cannot be read at all (which may hold
 * ours as well as any, and is never taken for no file, and written over).
 */
function readHooks(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' ? { value: {}, text: '', existed: false } : { invalid: true, existed: true, mentionsOurs: true };
  }
  if (!text.trim()) return { value: {}, text, existed: true };
  try {
    const value = JSON.parse(text);
    if (isObject(value)) return { value, text, existed: true };
  } catch {
    // below
  }
  return { invalid: true, existed: true, mentionsOurs: RUNS_OURS.test(text) };
}

/** Our hook as the text login adds after the person's last hook. */
const blockOf = (hook) => `,\n  ${JSON.stringify(HOOK_NAME)}: ${JSON.stringify(hook, null, 2).replace(/\n/g, '\n  ')}`;

/** `text` with `hook` added after its last key, when that reads back as exactly `expected`; else null. */
function appended(text, hook, expected) {
  const close = text.lastIndexOf('}');
  let at = close;
  while (at > 0 && /\s/.test(text[at - 1])) at -= 1;
  const next = text.slice(0, at) + blockOf(hook) + text.slice(at);
  try {
    return same(JSON.parse(next), expected) ? next : null;
  } catch {
    return null;
  }
}

/** `text` with our block, as login added it for `hook`, cut out, when that reads back as exactly `expected`; else null. */
function cut(text, hook, expected) {
  const block = blockOf(hook);
  const at = text.lastIndexOf(block);
  if (at === -1) return null;
  const next = text.slice(0, at) + text.slice(at + block.length);
  try {
    return same(JSON.parse(next), expected) ? next : null;
  } catch {
    return null;
  }
}

/** The person's hooks with every handler of ours out of them, and any hook left with no event of its own gone. */
function withoutOurs(config) {
  const out = {};
  for (const [name, hook] of Object.entries(config)) {
    if (!isObject(hook) || oursIn(hook).length === 0) {
      out[name] = hook;
      continue;
    }
    const kept = {};
    for (const [key, value] of Object.entries(hook)) {
      if (!Array.isArray(value)) kept[key] = value;
      else if (value.some((e) => !isOurs(e))) kept[key] = value.filter((e) => !isOurs(e));
    }
    if (Object.values(kept).some(Array.isArray)) out[name] = kept;
  }
  return out;
}

/** Every hook but the one called `name`, in order. */
const without = (config, name) => Object.fromEntries(Object.entries(config).filter(([key]) => key !== name));

/** The person's hooks with ours where it was, or after them all. */
function placed(config, theirs, hook) {
  const out = {};
  for (const name of Object.keys(config)) {
    if (name === HOOK_NAME) out[name] = hook;
    else if (Object.hasOwn(theirs, name)) out[name] = theirs[name];
  }
  if (!Object.hasOwn(out, HOOK_NAME)) out[HOOK_NAME] = hook;
  return out;
}

/** A value with every object's keys in order: two hooks that differ only in how agy ordered them are the same. */
const canonical = (v) =>
  Array.isArray(v) ? v.map(canonical) : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;

export default {
  id: ID,
  name: 'Antigravity',
  order: 50,
  // agy reads its files from the home folder alone: no variable moves them
  env: [],
  // connected by `tools add antigravity` (or `login --tools`), not by every login: see the top
  optIn: true,
  files,
  hooks: antigravityHooks,
  detect(places) {
    // the installer's place, which need not be on PATH, and Homebrew's, which is
    const installed = WINDOWS ? path.join(places.home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe') : path.join(places.home, '.local', 'bin', 'agy');
    const bin = which('agy', places.toolPath) ?? (exists(installed) ? installed : null);
    // agy's own folder, the IDE's, and the apps; not ~/.gemini/config, which other tools write to as well
    const gemini = path.join(places.home, '.gemini');
    const found =
      Boolean(bin) ||
      exists(path.join(gemini, 'antigravity-cli')) ||
      exists(path.join(gemini, 'antigravity-ide')) ||
      Boolean(places.apps && (exists(path.join(places.apps, 'Antigravity.app')) || exists(path.join(places.apps, 'Antigravity IDE.app'))));
    return { found, bin };
  },
  connect(places, hookDir) {
    const at = files(places);
    if (WINDOWS && /\s/.test(hookDir)) {
      return { status: 'skipped', why: `agy on Windows cannot run a script from ${hookDir}: it splits a hook's command at every space` };
    }
    const read = readHooks(at.hooks);
    if (read.invalid) {
      return {
        status: 'skipped',
        why: `${shown(at.hooks, places)} is not valid JSON, and Antigravity drops the whole of a hooks file it cannot read — fix it, then run: npx agentmash tools add ${ID}`,
      };
    }
    const config = read.value;
    const current = config[HOOK_NAME];
    if (current !== undefined && oursIn(current).length === 0) {
      return { status: 'skipped', why: `a hook called ${HOOK_NAME} is in ${shown(at.hooks, places)} already, and not ours: left as it is` };
    }
    // the person's switch, as /hooks left it, and any handler of theirs they put in our hook, first
    const off = isObject(current) && current.enabled === false;
    const want = antigravityHooks(hookDir)[HOOK_NAME];
    const hook = off ? { ...want, enabled: false } : { ...want };
    const added = isObject(current) ? withoutOurs({ [HOOK_NAME]: current })[HOOK_NAME] : undefined;
    for (const [event, list] of Object.entries(added ?? {})) if (Array.isArray(list)) hook[event] = [...list, ...(want[event] ?? [])];
    // theirs, with anything of ours that found its way into a hook of theirs taken out of it
    const theirs = withoutOurs(without(config, HOOK_NAME));
    const changed = !same(theirs, without(config, HOOK_NAME)) || !same(canonical(current), canonical(hook));
    if (changed) {
      // as text after theirs, when what is there is theirs as they wrote it and ours as login wrote it, if at all
      let text = null;
      if (Object.keys(theirs).length > 0) {
        const base = current === undefined ? read.text : cut(read.text, current, theirs);
        if (base !== null) text = appended(base, hook, { ...theirs, [HOOK_NAME]: hook });
      }
      if (text !== null) writeFileSafely(at.hooks, text);
      else writeJson(at.hooks, placed(config, theirs, hook));
    }
    const server = addServer(at.mcp, 'mcpServers', { command: 'node', args: serverArgs(hookDir) });
    const notes = [];
    if (server.status === 'taken') notes.push(`a server called agentmash is in ${shown(at.mcp, places)} already, and not ours: left as it is`);
    if (server.status === 'invalid') notes.push(`${shown(at.mcp, places)} is not valid JSON: the MCP server was not added`);
    if (off) notes.push("agentmash's hooks are switched off in Antigravity (/hooks): left off");
    const status = changed || server.status === 'added' ? 'connected' : 'already';
    if (status === 'connected') {
      notes.push('Antigravity reads its hooks when it starts: restart agy');
      notes.push(
        'the agent hears who of your team is at work on its branch or in its files at the start of each turn, not before each edit: ' +
          'Antigravity can add nothing to an edit it lets through'
      );
    }
    return { status, notes, where: shown(at.hooks, places) };
  },
  disconnect(places) {
    const at = files(places);
    const read = readHooks(at.hooks);
    let hooks = { removed: false };
    // a file that does not read is said only when it names our scripts: one login never wrote to is not ours to mention
    if (read.invalid) hooks = { removed: false, invalid: read.mentionsOurs };
    else if (Object.values(read.value).some((hook) => oursIn(hook).length > 0)) {
      const rest = withoutOurs(read.value);
      const current = read.value[HOOK_NAME];
      // our block cut out as login wrote it, when that leaves exactly theirs; else back through JSON
      const text = isObject(current) ? cut(read.text, current, rest) : null;
      if (Object.keys(rest).length === 0) removeFile(at.hooks, '{}\n');
      else if (text !== null) writeFileSafely(at.hooks, text);
      else writeJson(at.hooks, rest);
      hooks = { removed: true };
    }
    const server = removeServer(at.mcp, 'mcpServers');
    return outcome([hooks, at.hooks, places], [server, at.mcp, places]);
  },
  inspect(places) {
    const at = files(places);
    const read = readHooks(at.hooks);
    const hooks = Object.values(read.value ?? {});
    const ours = hooks.flatMap(oursIn);
    return {
      connected: ours.length > 0,
      invalid: Boolean(read.invalid && read.mentionsOurs),
      where: shown(at.hooks, places),
      events: [...new Set(hooks.flatMap(eventsIn))],
      missing: missingScripts(ours.flatMap((e) => (Array.isArray(e.hooks) ? e.hooks : [e]))),
      mcp: hasServer(at.mcp, 'mcpServers'),
    };
  },
};

/** The scripts our handlers run that are not there, the path quoted or (on Windows) bare. */
function missingScripts(handlers) {
  const gone = new Set();
  for (const handler of handlers) {
    for (const line of commandsOf(handler)) {
      const script = /"([^"]*[\\/]\.agentmash[\\/]hooks[\\/][^"]+)"/.exec(line)?.[1] ?? /^node (\S*[\\/]\.agentmash[\\/]hooks[\\/]\S+)/.exec(line)?.[1];
      if (script && !exists(script)) gone.add(script);
    }
  }
  return [...gone];
}
