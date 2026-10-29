// Cline: the VS Code extension (saoudrizwan.claude-dev, in VS Code or any of
// its forks) and the Cline CLI (`cline`), which read the same user-level hooks
// folder and the same MCP settings file.
//
// Cline has no hooks file to add entries to. A hook is an executable file
// named after its event in ~/Documents/Cline/Hooks, so ours are three small
// sh scripts of our own there, each running the generic hook (agent_hook.mjs)
// with --client cline, answered in the cline dialect (hooks/dialects/cline.mjs):
//
//   PreToolUse        before each tool call: the advice about a teammate in
//                     the file. Cline hands a hook's note to the model only
//                     after the call has run, so it is for the agent's next
//                     step; a hook's only refusal stops the whole run, and
//                     nothing here ever uses it.
//   PostToolUse       after each tool call: the report, handed off at once
//   UserPromptSubmit  the prompt's report and the heads-up about who is at
//                     work (VS Code only: the CLI sends none for a typed prompt)
//
// Not TaskStart, which VS Code runs before every turn, just ahead of the
// prompt's own; not TaskComplete, whose answer nobody reads; and no session
// end, which VS Code does not have.
//
// The folder is the one place both runners look: VS Code in
// <Documents>/Cline/Hooks, the CLI in $HOME/Documents/Cline/Hooks and
// ~/.cline/hooks. Nothing goes in ~/.cline/hooks too, or the CLI would run
// each hook twice. Each file is a real file, mode 0755, with no extension:
// VS Code runs only an executable named exactly after the event, the CLI no
// symlink. A file there by that name that is not ours is the person's, and
// is left alone, with its event; so is a file of ours they switched off in
// Cline's settings (Cline takes its execute bit away), whose mode a login
// keeps. On Linux, VS Code takes Documents to be what `xdg-user-dir
// DOCUMENTS` says, which can be another folder than the CLI's, so the hooks
// go in both there. On Windows, Cline runs only PowerShell hooks, which
// login does not write yet: there it registers the MCP server alone.
//
// ~/Documents is a folder macOS asks the person before a terminal may look
// in, so nothing here looks there on a machine with no other sign of Cline:
// login, logout, `tools` and doctor would otherwise ask everyone.
//
// The MCP server goes in ~/.cline/data/settings/cline_mcp_settings.json
// (CLINE_MCP_SETTINGS_PATH, else $CLINE_DATA_DIR/settings, else
// $CLINE_DIR/data/settings), which VS Code, the CLI and JetBrains share and
// validate whole, so it is written as Cline writes it: under Cline's own lock
// (<file>.lock), whole, by a rename, and never into a file that does not read.
//
// Cline asks nobody before running a hook, and a hook cannot approve anything
// in it; nothing here writes an auto-approve for the server's tools.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_HOOK_SCRIPT,
  OURS,
  PRIVATE,
  SERVER_NAME,
  SERVER_SCRIPT,
  exists,
  outcome,
  readJsonObject,
  removeFile,
  same,
  serverArgs,
  shown,
  which,
  writeFileSafely,
  writeJson,
} from '../agent-kit.mjs';

const CLIENT = 'cline';
/** Cline's hook files we write, each the event the generic hook is run for. */
const EVENTS = { PreToolUse: 'pre_edit', PostToolUse: 'post_edit', UserPromptSubmit: 'prompt' };
const WHEN = { PreToolUse: 'before each tool call', PostToolUse: 'after each tool call', UserPromptSubmit: 'as each prompt is sent' };
/** The line that says a hook file is ours: with a script from a .agentmash/hooks folder in it. */
const MARK = '# agentmash:';
/** A hook file bigger than this is nobody's sh wrapper of ours. */
const MAX_HOOK_BYTES = 64 * 1024;
/** The VS Code extension, as its folders are named. */
const EXTENSION = 'saoudrizwan.claude-dev';
/** Where VS Code and its forks keep their extensions, under the home. */
const EDITORS = ['.vscode', '.vscode-insiders', '.vscode-oss', '.cursor', '.windsurf'];

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Cline's own folder: $CLINE_DIR, else ~/.cline. */
const clineDir = (places) => (process.env.CLINE_DIR?.trim() ? path.resolve(process.env.CLINE_DIR.trim()) : path.join(places.home, '.cline'));

/** The MCP settings file, as Cline finds it (sdk/packages/shared/src/storage/paths.ts, resolveMcpSettingsPath). */
function mcpFile(places) {
  const explicit = process.env.CLINE_MCP_SETTINGS_PATH?.trim();
  if (explicit) return path.resolve(explicit);
  const data = process.env.CLINE_DATA_DIR?.trim() ? path.resolve(process.env.CLINE_DATA_DIR.trim()) : path.join(clineDir(places), 'data');
  return path.join(data, 'settings', 'cline_mcp_settings.json');
}

/** Whether the VS Code extension is in any editor's extensions, or has left its storage in VS Code's. */
function extensionInstalled(places) {
  for (const editor of EDITORS) {
    try {
      if (fs.readdirSync(path.join(places.home, editor, 'extensions')).some((name) => name.toLowerCase().startsWith(`${EXTENSION}-`))) return true;
    } catch {
      // no such editor
    }
  }
  return exists(path.join(places.vscodeUser, 'globalStorage', EXTENSION));
}

/** Cline on this machine, found without looking in ~/Documents (see the top). */
function present(places) {
  const bin = which('cline', places.toolPath);
  return { found: Boolean(bin) || exists(clineDir(places)) || exists(mcpFile(places)) || extensionInstalled(places), bin };
}

/**
 * Where VS Code's Cline on Linux takes Documents to be: what `xdg-user-dir
 * DOCUMENTS` prints, which is the home itself when user-dirs.dirs names no
 * Documents folder; ~/Documents when there is no xdg-user-dir.
 */
function linuxDocuments(places, env) {
  if (!which('xdg-user-dir', places.toolPath)) return path.join(places.home, 'Documents');
  let dirs = '';
  try {
    dirs = fs.readFileSync(path.join(env.XDG_CONFIG_HOME || path.join(places.home, '.config'), 'user-dirs.dirs'), 'utf8');
  } catch {
    // none: xdg-user-dir says the home
  }
  const said = /^\s*XDG_DOCUMENTS_DIR\s*=\s*"([^"]*)"\s*$/m.exec(dirs)?.[1];
  const dir = said?.replace(/^\$HOME(?=\/|$)/, places.home);
  return dir && path.isAbsolute(dir) ? dir : places.home;
}

/**
 * The folders the hooks go in: the one both runners read, and on Linux the
 * one VS Code reads when it is another. None on Windows, and, unless login
 * was told to connect Cline (`always`), none on a machine with no other sign
 * of it.
 */
export function hooksDirs(places, { platform = process.platform, env = process.env, always = false } = {}) {
  if (platform === 'win32' || !(always || present(places).found)) return [];
  const dirs = [path.join(places.home, 'Documents', 'Cline', 'Hooks')];
  if (platform === 'linux') {
    const vscode = path.join(linuxDocuments(places, env), 'Cline', 'Hooks');
    if (!dirs.includes(vscode)) dirs.push(vscode);
  }
  return dirs;
}

/** A path in double quotes for sh, with what is special inside them escaped. */
const shQuoted = (p) => `"${p.replace(/[\\"$`]/g, '\\$&')}"`;

/**
 * One hook file: node, then the generic hook for its event. The node that ran
 * login comes first, since VS Code started from the Dock may have no node on
 * its PATH; then whichever is on the PATH, when that one has gone (a node
 * upgraded since); and when there is none, the answer that lets Cline go on.
 * Nothing in it changes from one version of agentmash to the next.
 */
function hookFile(hookDir, name) {
  return [
    '#!/bin/sh',
    `${MARK} Cline runs this ${WHEN[name]}. \`npx agentmash login\` wrote it and \`npx agentmash logout\` takes it out.`,
    `node=${shQuoted(process.execPath)}`,
    `[ -x "$node" ] || node=$(command -v node) || { echo '{"cancel":false}'; exit 0; }`,
    `exec "$node" ${shQuoted(path.join(hookDir, AGENT_HOOK_SCRIPT))} ${EVENTS[name]} --global --client ${CLIENT}`,
    '',
  ].join('\n');
}

/** What login writes in each hooks folder, by file name: the same text on every run. */
export function clineHooks(hookDir) {
  return Object.fromEntries(Object.keys(EVENTS).map((name) => [name, hookFile(hookDir, name)]));
}

/** A hook file's text is ours: our line, and a script from a .agentmash/hooks folder. */
const isOurHookText = (text) => typeof text === 'string' && text.startsWith('#!') && text.includes(`\n${MARK} `) && OURS.test(text);

/** What is at a hook's path: none, ours ({ text, mode }), or the person's. */
function readHook(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return { state: 'none' };
  }
  // a link, a folder, or something too big to be ours: theirs
  if (!stat.isFile() || stat.size > MAX_HOOK_BYTES) return { state: 'theirs' };
  try {
    const text = fs.readFileSync(file, 'utf8');
    return isOurHookText(text) ? { state: 'ours', text, mode: stat.mode & 0o7777 } : { state: 'theirs' };
  } catch {
    return { state: 'theirs' };
  }
}

/** The script one of our hook files runs, as the file names it. */
function scriptOf(text) {
  const quoted = /"((?:[^"\\]|\\.)*[\\/]\.agentmash[\\/]hooks[\\/](?:[^"\\]|\\.)+)"/.exec(text)?.[1];
  return quoted ? quoted.replace(/\\(.)/g, '$1') : null;
}

const files = (places) => {
  const at = {};
  hooksDirs(places).forEach((dir, i) => {
    for (const name of Object.keys(EVENTS)) at[i ? `vscode:${name}` : name] = path.join(dir, name);
  });
  at.mcp = mcpFile(places);
  return at;
};

const listed = (names) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// ── the MCP settings file, as Cline writes it ──────────────────────────────
//
// Cline's settings writers take a lock first: a folder, <file>.lock, made by
// renaming a folder that already holds an owner file into place, so it is
// never empty; given back by deleting the owner file, then the folder; taken
// over when it is ten seconds old, which only an owner that died leaves
// (sdk/packages/core/src/extensions/mcp/config-loader.ts). The same here, for
// the few milliseconds of a read and a write; when another writer holds it
// for longer than LOCK_WAIT_MS, the server is left for the next login.

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 25;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** `fn()` under Cline's lock on `file`, or undefined when it could not be had. */
function withSettingsLock(file, fn) {
  const lockDir = `${file}.lock`;
  const token = `${process.pid}.${Date.now()}.${crypto.randomUUID()}`;
  const owner = path.join(lockDir, `owner.${token}`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (;;) {
    const staging = `${lockDir}.tmp.${token}`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, `owner.${token}`), token, { flag: 'wx' });
    try {
      fs.renameSync(staging, lockDir);
      break;
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      if (!exists(lockDir)) throw err;
    }
    let age = 0;
    try {
      age = Date.now() - fs.statSync(lockDir).mtimeMs;
    } catch {
      continue; // given back meanwhile
    }
    if (age >= LOCK_STALE_MS) {
      const stale = `${lockDir}.stale.${token}`;
      try {
        fs.renameSync(lockDir, stale);
        fs.rmSync(stale, { recursive: true, force: true });
      } catch {
        // somebody else took it over first
      }
      continue;
    }
    if (Date.now() > deadline) return undefined;
    Atomics.wait(sleeper, 0, 0, LOCK_POLL_MS);
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(owner);
      fs.rmdirSync(lockDir);
    } catch {
      // taken over since: theirs to give back
    }
  }
}

/** The command and arguments an MCP entry runs, in Cline's flat shape or its nested one. */
const runsOf = (entry) => (isObject(entry?.transport) ? entry.transport : entry);
/** An entry of ours: it runs a hooks folder's mcp_server.mjs. */
const isOurServerEntry = (entry) => {
  const runs = runsOf(entry);
  return [runs?.command, ...(Array.isArray(runs?.args) ? runs.args : [])].some((c) => typeof c === 'string' && OURS.test(c) && c.includes(SERVER_SCRIPT));
};

/** The settings as read: { config, servers } or { invalid } when Cline would not read them either. */
function readSettings(file) {
  const read = readJsonObject(file);
  if (read.invalid) return { invalid: true };
  const config = read.value;
  if (config.mcpServers !== undefined && !isObject(config.mcpServers)) return { invalid: true };
  return { config, servers: config.mcpServers ?? {}, existed: read.existed };
}

/**
 * Our server into Cline's MCP settings: { status: added | already | taken |
 * invalid | busy }. One of ours from another hooks folder is pointed at this
 * one with the rest of it kept: the person may have switched it off, or set
 * its timeout, in Cline.
 */
function registerServer(places, hookDir) {
  const file = mcpFile(places);
  const args = serverArgs(hookDir);
  const decide = (read) => {
    if (read.invalid) return { status: 'invalid' };
    const current = read.servers[SERVER_NAME];
    if (current === undefined) return { status: 'added', entry: { type: 'stdio', command: 'node', args, disabled: false } };
    if (!isOurServerEntry(current)) return { status: 'taken' };
    const runs = runsOf(current);
    if (runs.command === 'node' && same(runs.args, args)) return { status: 'already' };
    const entry = isObject(current.transport) ? { ...current, transport: { ...current.transport, command: 'node', args } } : { ...current, command: 'node', args };
    return { status: 'added', entry };
  };
  const first = decide(readSettings(file));
  if (first.status !== 'added') return first;
  return (
    withSettingsLock(file, () => {
      // read again under the lock: Cline may have written it since
      const read = readSettings(file);
      const now = decide(read);
      if (now.status === 'added') writeJson(file, { ...read.config, mcpServers: { ...read.servers, [SERVER_NAME]: now.entry } }, { mode: PRIVATE });
      return { status: now.status };
    }) ?? { status: 'busy' }
  );
}

/**
 * Our server out of Cline's MCP settings: { removed, invalid }. mcpServers
 * stays, empty if need be (Cline will not read a settings file without it);
 * the file goes when nothing else was ever in it.
 */
function unregisterServer(places) {
  const file = mcpFile(places);
  const read = readSettings(file);
  if (read.invalid) return { removed: false, invalid: true };
  if (!read.existed || !isOurServerEntry(read.servers[SERVER_NAME])) return { removed: false };
  return (
    withSettingsLock(file, () => {
      const now = readSettings(file);
      if (now.invalid) return { removed: false, invalid: true };
      if (!isOurServerEntry(now.servers[SERVER_NAME])) return { removed: false };
      const servers = { ...now.servers };
      delete servers[SERVER_NAME];
      const rest = { ...now.config, mcpServers: servers };
      if (Object.keys(servers).length === 0 && Object.keys(rest).length === 1) removeFile(file, '{\n  "mcpServers": {}\n}\n');
      else writeJson(file, rest, { mode: PRIVATE });
      return { removed: true };
    }) ?? { removed: false } // Cline holds the file: ours stays, and so do the scripts it runs (logout keeps them)
  );
}

const hasServer = (places) => {
  const read = readSettings(mcpFile(places));
  return !read.invalid && isOurServerEntry(read.servers[SERVER_NAME]);
};

export default {
  id: CLIENT,
  name: 'Cline',
  order: 50,
  env: ['CLINE_DIR', 'CLINE_DATA_DIR', 'CLINE_MCP_SETTINGS_PATH'],
  files,
  hooks: clineHooks,
  detect: present,
  connect(places, hookDir) {
    const notes = [];
    const want = clineHooks(hookDir);
    // found, or named with --tools: either way the person wants it connected
    const dirs = hooksDirs(places, { always: true });
    let changed = false;
    const ours = new Set();
    const theirs = [];
    const off = new Set();
    for (const dir of dirs) {
      try {
        for (const [name, text] of Object.entries(want)) {
          const file = path.join(dir, name);
          const now = readHook(file);
          if (now.state === 'theirs') {
            theirs.push(file);
            continue;
          }
          if (now.state === 'ours' && !(now.mode & 0o111)) off.add(name);
          if (now.state !== 'ours' || now.text !== text) {
            // a new one is executable; one of ours keeps the mode it has, on or off
            writeFileSafely(file, text, { mode: 0o755 });
            changed = true;
          }
          ours.add(name);
        }
      } catch (err) {
        // macOS asks before a terminal may write in ~/Documents; a "no" is this, and the MCP server can still go in
        notes.push(
          `${shown(dir, places)} could not be written (${err.code ?? err.message}): no hooks there` +
            (process.platform === 'darwin' ? ' — let your terminal use the Documents folder (System Settings › Privacy & Security › Files and Folders), then run login again' : '')
        );
      }
    }
    for (const file of theirs) notes.push(`${shown(file, places)} is a hook of your own: left as it is, and agentmash's ${path.basename(file)} with it`);
    if (off.size) notes.push(`${listed([...off])} ${off.size === 1 ? 'is' : 'are'} switched off in Cline's hooks settings: left that way`);
    if (process.platform === 'win32') notes.push('Cline on Windows runs only PowerShell hooks, which agentmash does not write yet: the MCP server only');

    const at = mcpFile(places);
    const server = registerServer(places, hookDir);
    if (server.status === 'taken') notes.push(`a server called agentmash is in ${shown(at, places)} already, and not ours: left as it is`);
    if (server.status === 'invalid') notes.push(`${shown(at, places)} is not valid JSON: the MCP server was not added`);
    if (server.status === 'busy') notes.push(`Cline was writing ${shown(at, places)}: the MCP server was not added — run login again`);

    const where = dirs.length ? shown(dirs[0], places) : shown(at, places);
    if (ours.size === 0 && !['added', 'already'].includes(server.status)) {
      return { status: 'skipped', why: notes.join('; ') || 'nothing of Cline to connect on this machine', notes: [], where };
    }
    const status = changed || server.status === 'added' ? 'connected' : 'already';
    if (status === 'connected' && ours.has('PreToolUse')) {
      notes.push("Cline gives the agent a hook's warning only after the edit it is about has run: it hears of a teammate in that file for its next step");
    }
    if (status === 'connected' && changed) notes.push("VS Code runs these while Cline's Enable Hooks setting is on (its default); a Cline CLI session already open, from its next start");
    return { status, notes, where };
  },
  disconnect(places) {
    const results = [];
    for (const dir of hooksDirs(places)) {
      let removed = false;
      for (const name of Object.keys(EVENTS)) {
        const file = path.join(dir, name);
        if (readHook(file).state !== 'ours') continue;
        try {
          fs.rmSync(file, { force: true });
          removed = true;
        } catch {
          // a folder that cannot be written: ours stays, and so do the scripts it runs (logout keeps them)
        }
      }
      if (removed) {
        // the folders, when they held only ours: Cline makes them again when it needs them
        for (const folder of [dir, path.dirname(dir)]) {
          try {
            fs.rmdirSync(folder);
          } catch {
            break; // something else is in it, or it is a link
          }
        }
      }
      results.push([{ removed }, dir, places]);
    }
    results.push([unregisterServer(places), mcpFile(places), places]);
    return outcome(...results);
  },
  inspect(places) {
    const dir = hooksDirs(places)[0];
    const hooks = dir ? Object.keys(EVENTS).map((name) => [name, readHook(path.join(dir, name))]).filter(([, h]) => h.state === 'ours') : [];
    const scripts = [...new Set(hooks.map(([, h]) => scriptOf(h.text)).filter(Boolean))];
    return {
      // where no hooks are written (Windows), connected is the server being there
      connected: hooks.length > 0 || (!dir && hasServer(places)),
      invalid: false,
      where: dir ? shown(dir, places) : shown(mcpFile(places), places),
      events: hooks.map(([name]) => name),
      missing: scripts.filter((script) => !exists(script)),
      mcp: hasServer(places),
    };
  },
};
