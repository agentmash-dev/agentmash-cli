// What every coding agent's connector is built from: finding the agent on the
// machine, the command a hook entry runs, and writing the agent's own
// configuration files without disturbing anything of the person's in them.
// Each agent is a module of its own in agents/ (see agents/index.mjs), and
// takes what it needs from here; tools.mjs puts them together.
//
// Nothing here imports an agent, or tools.mjs: the agents import this, and
// tools.mjs imports the agents, so a helper that lived in tools.mjs would be
// a circular import whose constants an agent could read before they were set.

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** A command of ours: it runs a script from a .agentmash/hooks folder. */
export const OURS = /[\\/]\.agentmash[\\/]hooks[\\/]/;
export const SERVER_NAME = 'agentmash';
export const SERVER_SCRIPT = 'mcp_server.mjs';
/** The generic hook any agent with hooks can run, in the dialect it speaks (hooks/agent_hook.mjs). */
export const AGENT_HOOK_SCRIPT = 'agent_hook.mjs';

/**
 * Where the agents keep their configuration on this machine, and where to
 * look for their commands. The agents connected first each have a key here;
 * an agent added since works out its own folder from `home` and the
 * environment, in its own module, so this never grows a key per agent.
 */
export function agentPlaces() {
  const home = os.homedir();
  const vscodeUser =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Code', 'User')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User')
        : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Code', 'User');
  return {
    home,
    // AGENTMASH_TOOL_PATH: where to look for the agents' commands, when it is not PATH (tests)
    toolPath: process.env.AGENTMASH_TOOL_PATH ?? process.env.PATH ?? '',
    // AGENTMASH_APPS_DIR: where macOS apps are installed, when it is not /Applications (tests)
    apps: process.env.AGENTMASH_APPS_DIR ?? (process.platform === 'darwin' ? '/Applications' : null),
    claude: process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    codex: process.env.CODEX_HOME || path.join(home, '.codex'),
    cursor: path.join(home, '.cursor'),
    copilot: process.env.COPILOT_HOME || path.join(home, '.copilot'),
    vscodeUser,
  };
}

/** A command's full path on `toolPath`, or null. */
export function which(name, toolPath) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of String(toolPath || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext.toLowerCase());
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

/** What cmd.exe reads as its own: each is escaped with ^ in a command line handed to it. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument of a command line for a `.cmd` or `.bat`, so the program the
 * script runs reads it back exactly: quoted as a C runtime reads quotes
 * (backslashes before a quote, and at the end, doubled), then every character
 * cmd.exe would act on escaped with ^, twice: once for the shell the line is
 * run in, and once more for the script's own `%*`, which passes the arguments
 * on as they were typed and has the shell read them again. npm's shims and
 * VS Code's `code.cmd` all do that.
 */
export function cmdArgument(arg) {
  const quoted = `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META, '^^^$1');
}

/**
 * Run one of the agents' own commands, briefly: { ok, stdout, stderr }. A
 * `.cmd` or `.bat` on Windows, which Node runs only through a shell, goes as
 * one command line quoted for it (cmdArgument): handed to a shell as a list,
 * the arguments would be joined with spaces as they are, which takes the JSON
 * `code --add-mcp` reads apart, and Node 24 warns about it on every login
 * (DEP0190).
 */
export function runTool(file, args, places, timeout = 20_000) {
  const options = { encoding: 'utf8', timeout, env: { ...process.env, PATH: places.toolPath }, windowsHide: true };
  const res =
    process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
      ? spawnSync([`"${file}"`, ...args.map(cmdArgument)].join(' '), { ...options, shell: true })
      : spawnSync(file, args, options);
  return { ok: res.status === 0, stdout: res.stdout || '', stderr: res.stderr || res.error?.message || '' };
}

/** The first line `<command> --version` prints, or null. Only for `tools`, never on the hooks' path. */
export function versionOf(file, places) {
  if (!file) return null;
  const res = runTool(file, ['--version'], places, 5000);
  const line = `${res.stdout}`.split('\n').map((l) => l.trim()).find(Boolean);
  return res.ok && line ? line.slice(0, 60) : null;
}

/**
 * The command a hook entry runs: node and a script in the hooks folder, the
 * path quoted for a shell, then fixed arguments. The same string every time
 * for the same folder: Codex keys a person's approval of a hook to a hash of
 * its definition (see agents/codex.mjs), so no version, date or anything else
 * that changes between releases ever goes in one.
 */
export function nodeCommand(hookDir, script, args = []) {
  return [`node "${path.join(hookDir, script)}"`, ...args].join(' ');
}

/**
 * The command that runs the generic hook for one of an agent's events:
 * `event` is pre_edit, post_edit, prompt, session_start, session_end or stop,
 * `client` the agent's id, and `dialect` the answer it reads (a file in
 * hooks/dialects; the hook picks the one named like the client when this is
 * left out). As stable as nodeCommand, for the same reason.
 */
export function agentHookCommand(hookDir, event, client, { dialect = null, input = null } = {}) {
  return nodeCommand(hookDir, AGENT_HOOK_SCRIPT, [
    event,
    '--global',
    '--client',
    client,
    ...(dialect ? ['--dialect', dialect] : []),
    ...(input ? ['--input', input] : []),
  ]);
}

/** What an MCP entry for our server runs, after `node`. */
export const serverArgs = (hookDir) => [path.join(hookDir, SERVER_SCRIPT)];

// ── JSON files ──────────────────────────────────────────────────────────────

/**
 * A file's text, or null when there is no file. Any other failure to read it
 * (no permission to, as a file a sudo run left root's has; a folder where the
 * file should be) is thrown: a file that is there is never taken for one that
 * is not, and written over with the person's settings in it lost.
 */
export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/** readText for a look only, where a file that cannot be read is as good as none: nothing is written from it. */
export function peekText(file) {
  try {
    return readText(file);
  } catch {
    return null;
  }
}

/**
 * A JSON file's object, {} when there is none, or { invalid } when it cannot
 * be read as one, or cannot be read at all (`unreadable`, why).
 */
export function readJsonObject(file) {
  let text;
  try {
    text = readText(file);
  } catch (err) {
    return { invalid: true, existed: true, unreadable: err?.code || 'unreadable' };
  }
  if (text === null) return { value: {}, existed: false };
  if (!text.trim()) return { value: {}, existed: true };
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return { value, existed: true, text };
  } catch {
    // below
  }
  return { invalid: true, existed: true };
}

// ── writing someone else's file ────────────────────────────────────────────
//
// Every file written here is the person's, or sits among theirs, so it is
// written the way they left it: through a symlink to what it points at (a
// dotfile kept by stow or chezmoi stays a link), with the mode it had (an
// mcp.json holding a token stays 0600; one made here starts that way), and
// whole, by a temporary file beside it with a name no other run shares, then
// a rename, so nothing ever reads it half-written.
//
// The first time agentmash writes a file of the person's, what it held is
// kept beside it as <file>.before-agentmash, so taking agentmash out is never
// a guess. Once, and only what was there before agentmash: never a file that
// runs our hooks already (a command in it runs a script from
// ~/.agentmash/hooks: an earlier run wired it, so it no longer holds only what
// the person had), and never one of ours by its place (anything in
// ~/.agentmash, or a file named after us). A file that only names agentmash
// (Claude Code's settings with the crew's plugin in them, a checkout of ours
// Codex trusts) is still theirs, and is kept. The copy stays beside the file,
// with its mode, and nothing reads it after: the one look at the file is for
// our hooks' folder, never parsed and never sent anywhere.
//
// The copy holds whatever the file held: a settings file can hold a token or
// a key of the person's (an MCP server's, a provider's), and then the copy
// does too. So it keeps the file's mode, logout leaves it there, as the
// README says, and none is made where it would land in a dotfiles repository
// (the agent's folder is a link: see inLinkedFolder). An agent's own sign-in
// file (auth.json, .credentials.json and the like) is never written, copied
// or removed here: agentmash never touches a vendor's credentials, and no
// agent keeps its settings in one.

/** What a file kept from before agentmash is called: the file's own name, then this. */
export const BEFORE = '.before-agentmash';

/**
 * A file that holds a sign-in or a key, by its name: Claude Code's
 * ~/.claude.json among them (it can hold a key), a .env (Qwen Code reads one
 * from ~/.qwen), and .netrc, _netrc on Windows.
 */
const SIGN_IN_FILE =
  /^(?:\.?credentials(?:\.json)?|auth\.json|oauth_creds\.json|google_accounts\.json|secrets\.(?:json|ya?ml)|\.claude\.json|\.env|[._]netrc|.+\.(?:key|pem))$/i;

/** Whether `file` (or what it links to) is a file that holds a sign-in or a key. */
export const holdsSignIn = (file) => [file, realTarget(file)].some((f) => SIGN_IN_FILE.test(path.basename(f)));

/**
 * A command of ours in a file's text: our hooks' folder, as OURS has it, with
 * a Windows path's backslashes doubled too, the way JSON, TOML and a plugin's
 * JSON.stringify write them. OURS is for a command read out of a file; what
 * looks in the file's text itself uses this, or on Windows it finds nothing
 * of ours in a file full of it.
 */
export const RUNS_OURS = /[\\/]+\.agentmash[\\/]+hooks[\\/]+/;

/** A file of ours by where it is: in a .agentmash folder, or named after agentmash (a plugin, our hooks file). */
const oursByPlace = (file) => file.split(/[\\/]/).includes('.agentmash') || /^agentmash\b/i.test(path.basename(file));

/**
 * Whether a copy beside `file` would land in somebody's dotfiles: its folder,
 * or one above it inside the home folder, is a link to somewhere else (stow
 * links an agent's whole folder when it can), and a copy there would sit in
 * that repository for a `git add -A` to take, tokens and all. A file that is
 * a link itself is fine: its copy is beside the link, outside them.
 */
function inLinkedFolder(file) {
  const home = path.resolve(os.homedir());
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) return true;
    } catch {
      // not there
    }
    const up = path.dirname(dir);
    if (up === dir || !up.startsWith(home + path.sep)) return false;
    dir = up;
  }
}

/** Keep what `file` held before agentmash beside it, once (see above); `target` is what it links to, `mode` its mode. */
function keepBefore(file, target, mode) {
  const backup = `${file}${BEFORE}`;
  if (oursByPlace(file) || oursByPlace(target) || fs.existsSync(backup) || inLinkedFolder(file)) return;
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch {
    return; // nothing there yet: nothing was there before agentmash
  }
  if (RUNS_OURS.test(text)) return;
  try {
    fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err?.code === 'EEXIST') return; // another run kept it a moment ago
    throw err;
  }
  fs.chmodSync(backup, mode);
}

/** The file a path names, through any symlinks, even one to a file not made yet. */
export function realTarget(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    // not there, or a link to something not there yet: follow what links there are
    try {
      return path.resolve(path.dirname(file), fs.readlinkSync(file));
    } catch {
      return file;
    }
  }
}

/** Write `content` to `file` as described above; `mode` is for a file that is new. */
export function writeFileSafely(file, content, { mode = 0o644 } = {}) {
  if (holdsSignIn(file)) throw new Error(`${file} holds a sign-in: agentmash never writes it`);
  const target = realTarget(file);
  let keep = mode;
  try {
    keep = fs.statSync(target).mode & 0o7777;
  } catch {
    // new: the mode asked for
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  keepBefore(file, target, keep);
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.agentmash-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { mode: keep });
    fs.chmodSync(tmp, keep); // the umask had its say on the line above
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * A file of ours left with nothing in it, gone: or, when it is a symlink into
 * somebody's dotfiles, `empty` written to what it points at, so the link they
 * manage stays.
 */
export function removeFile(file, empty) {
  if (holdsSignIn(file)) return;
  let link = false;
  try {
    link = fs.lstatSync(file).isSymbolicLink();
  } catch {
    return;
  }
  if (link) writeFileSafely(file, empty);
  else fs.rmSync(file, { force: true });
}

/** MCP configurations can hold a server's tokens: a new one is private. */
export const PRIVATE = 0o600;

export function writeJson(file, value, { mode = 0o644 } = {}) {
  writeFileSafely(file, JSON.stringify(value, null, 2) + '\n', { mode });
}

export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const commandsOf = (entry) =>
  [entry?.command, entry?.bash, entry?.powershell, ...(Array.isArray(entry?.args) ? entry.args : [])].filter((c) => typeof c === 'string');
export const isOurEntry = (entry) => commandsOf(entry).some((c) => OURS.test(c));
export const isOurGroup = (group) => Array.isArray(group?.hooks) && group.hooks.some(isOurEntry);
export const isOurServer = (server) => commandsOf(server).some((c) => OURS.test(c) && c.includes(SERVER_SCRIPT));

/**
 * `want` merged into a hooks object, in place: every entry of ours, in any
 * event, comes out, and each event `want` names gets this version's, after
 * whatever is the person's. An event already holding exactly this version's,
 * wherever among theirs, is left alone, so a current install is never
 * rewritten (for Codex, that keeps where our groups are, which its approvals
 * are keyed to). `isOurs`
 * tells an entry of ours (a matcher group, or a flat command). Returns
 * whether anything changed.
 */
export function mergeEntries(hooks, want, isOurs) {
  let changed = false;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event]) || want[event]) continue;
    const kept = hooks[event].filter((e) => !isOurs(e));
    if (kept.length !== hooks[event].length) {
      changed = true;
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
  }
  for (const [event, entries] of Object.entries(want)) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) continue; // not ours to rearrange
    const current = hooks[event] ?? [];
    const ours = current.filter(isOurs);
    if (same(ours, entries)) continue;
    hooks[event] = [...current.filter((e) => !isOurs(e)), ...entries];
    changed = true;
  }
  return changed;
}

/** Every entry of ours out of a hooks object, in place; events left empty go. Returns whether any did. */
export function removeEntries(hooks, isOurs) {
  let changed = false;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = hooks[event].filter((e) => !isOurs(e));
    if (kept.length === hooks[event].length) continue;
    changed = true;
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  return changed;
}

/**
 * Take our entries out of a hooks file; the file goes when nothing but an
 * empty shell of it is left. `invalid` when it cannot be read, and so still
 * holds whatever of ours it held.
 */
export function removeFromHooksFile(file, isOurs, shell = ['hooks']) {
  const read = readJsonObject(file);
  if (read.invalid) return { removed: false, invalid: true };
  if (!read.existed) return { removed: false };
  const config = read.value;
  const hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
  if (!removeEntries(hooks, isOurs)) return { removed: false };
  const keys = Object.keys(config).filter((k) => !shell.includes(k));
  if (keys.length === 0 && Object.keys(hooks).length === 0) removeFile(file, '{}\n');
  else writeJson(file, { ...config, hooks });
  return { removed: true };
}

/** Our server into a JSON file of servers (`key`: mcpServers, or VS Code's servers). */
export function addServer(file, key, entry) {
  const read = readJsonObject(file);
  if (read.invalid) return { status: 'invalid' };
  const config = read.value;
  const servers = config[key] && typeof config[key] === 'object' ? config[key] : {};
  const current = servers[SERVER_NAME];
  if (current && !isOurServer(current)) return { status: 'taken' };
  if (current && same(current, entry)) return { status: 'already' };
  writeJson(file, { ...config, [key]: { ...servers, [SERVER_NAME]: entry } }, { mode: PRIVATE });
  return { status: 'added' };
}

/**
 * Our server out of a JSON file of servers; the file goes when it is left
 * holding nothing. `invalid` when it cannot be read (VS Code's mcp.json may
 * hold comments, which only VS Code reads), and may still hold ours.
 */
export function removeServer(file, key) {
  const read = readJsonObject(file);
  if (read.invalid) return { removed: false, invalid: true };
  if (!read.existed) return { removed: false };
  const config = read.value;
  if (!isOurServer(config[key]?.[SERVER_NAME])) return { removed: false };
  const servers = { ...config[key] };
  delete servers[SERVER_NAME];
  const rest = { ...config, [key]: servers };
  if (Object.keys(servers).length === 0) delete rest[key];
  if (Object.keys(rest).length === 0) removeFile(file, '{}\n');
  else writeJson(file, rest, { mode: PRIVATE });
  return { removed: true };
}

export const hasServer = (file, key) => isOurServer(readJsonObject(file).value?.[key]?.[SERVER_NAME]);

/** The scripts our entries in a hooks file run that are not there: an entry that fails on every call. */
export function missingScripts(entries) {
  const gone = new Set();
  for (const entry of entries) {
    for (const command of commandsOf(entry)) {
      const script = /"([^"]*[\\/]\.agentmash[\\/]hooks[\\/][^"]+)"/.exec(command)?.[1];
      if (script && !exists(script)) gone.add(script);
    }
  }
  return [...gone];
}

/**
 * Whether a file's text names `dir` in any way an agent's file can: as it is
 * (YAML, a TOML literal string), as a JSON or TOML string writes it, with
 * every backslash of a Windows path doubled, or with forward slashes. Logout
 * keeps the hooks folder while any file does, or every call there would fail.
 */
export function namesFolder(text, dir) {
  return [dir, JSON.stringify(dir).slice(1, -1), dir.replace(/\\/g, '/')].some((form) => text.includes(form));
}

/** "~/.codex/hooks.json", for saying where. */
export function shown(file, places = agentPlaces()) {
  return file.startsWith(places.home + path.sep) ? `~${file.slice(places.home.length)}` : file;
}

/**
 * What a disconnect did, from what each file's removal did: removed, absent,
 * and `invalid`, the files that could not be read and so may still hold ours.
 * Each argument is [result, file, places].
 */
export function outcome(...results) {
  const invalid = results.filter(([r]) => r.invalid).map(([, file, places]) => shown(file, places));
  const removed = results.some(([r]) => r.removed);
  return { status: removed ? 'removed' : 'absent', invalid };
}
