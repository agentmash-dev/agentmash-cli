#!/usr/bin/env node
// AgentMash CLI — Node built-ins only, and so is everything it installs into a
// repo, the MCP server included: the package has no dependencies at all.
//
//   npx agentmash init      create a room and wire this repo up
//   npx agentmash join ID   point this repo at an existing room
//   npx agentmash doctor    explain exactly what is and isn't working
//   npx agentmash status    who is working on what, right now
//   npx agentmash connect [owner/name]  connect this repo, on the website, to the room it carries
//   npx agentmash git-hook  install or remove the post-commit client
//   npx agentmash uninstall remove the hooks from this repo
//   npx agentmash crew      install agents from the agentmash crew as a named team (once `team`)
//   npx agentmash mcp       serve the MCP tools on stdio (the server .mcp.json starts)
//   npx agentmash token     personal API tokens for /api/v1 (token.mjs)
//   npx agentmash ask       send a teammate a request for their agent (inbox.mjs)
//   npx agentmash inbox     the requests teammates sent you, and yours to them (inbox.mjs)
//   npx agentmash hook      the generic hook's command line, for any agent's hook settings (hook.mjs)
//   npx agentmash digest    the room's week, to the terminal, Slack or Telegram (digest.mjs)

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENTS, agentFiles, agentPlaces, agentScripts, namesFolder, shown, versionOf, which, writeFileSafely } from './tools.mjs';
import { KEY_OPENS, checkVisibility, isOrganization, repoVisibility } from './visibility.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER = (process.env.AGENTMASH_SERVER || 'https://agentmash.dev').replace(/\/+$/, '');
const HOOK_FILES = [
  'lib.mjs',
  'pre_tool_use.mjs',
  'post_tool_use.mjs',
  'user_prompt_submit.mjs',
  'prompt_note.mjs',
  'session_start.mjs',
  'session_end.mjs',
  'stop.mjs',
];
// Not a hook, but it installs like one: dependency-free, copied into the repo,
// committed, and picked up by a teammate's `git pull`.
const MCP_LAUNCHER = 'mcp_launcher.mjs';
// The MCP server the launcher starts, and its two helpers: plain Node like the
// hooks, beside the lib.mjs they import, so a teammate needs no npm install.
const MCP_SERVER_FILES = ['mcp_server.mjs', 'mcp_coordination.mjs', 'mcp_render.mjs'];
const INSTALLED_FILES = [...HOOK_FILES, MCP_LAUNCHER, ...MCP_SERVER_FILES];
const MCP_SERVER_NAME = 'agentmash';
// Non-Claude-Code clients of the same protocol, copied in beside the hooks so
// they travel with the repo too. [source path under clients/, installed name]
const CLIENT_FILES = [['git/post_commit.mjs', 'git_post_commit.mjs']];
const REQUEST_TIMEOUT_MS = 10_000;

// Colour for a person at a terminal, and only then: piped into a file, a CI
// log or another program, the escape codes are noise in the text, and
// NO_COLOR (https://no-color.org), set to anything, says no in any case.
const COLOUR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (s) => (COLOUR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: paint(1),
  dim: paint(2),
  green: paint(32),
  red: paint(31),
  yellow: paint(33),
  cyan: paint(36),
};
const ok = (s) => console.log(`  ${c.green('✓')} ${s}`);
const bad = (s) => console.log(`  ${c.red('✗')} ${s}`);
const warn = (s) => console.log(`  ${c.yellow('!')} ${s}`);
const info = (s) => console.log(`  ${c.dim('·')} ${s}`);

/** What die() throws: a command that cannot go on, in words for the person who ran it. */
class Stop extends Error {}

/**
 * End the command here: the message is printed where the command is run
 * (main), and the process ends with exit code 1. Never process.exit(): called
 * while a socket or a child process is still closing, as it is right after a
 * request, it crashes Node on Windows ("Assertion failed: !(handle->flags &
 * UV_HANDLE_CLOSING)"), which reads as a CLI bug and loses the exit code.
 */
function die(message) {
  throw new Stop(message);
}

/** Say why a command failed, and fail it: exit code 1 once whatever is still open has closed. */
function failed(err) {
  console.error(`\n${c.red('error')} ${err instanceof Stop ? err.message : err?.stack || String(err)}\n`);
  process.exitCode = 1;
}

// ── locations ──────────────────────────────────────────────────────────────

function findRepoRoot(start = process.cwd()) {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const realPath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * Whether `dir` is the home directory, or a folder whose .claude/ is Claude
 * Code's own configuration (CLAUDE_CONFIG_DIR). Either way its
 * .claude/settings.json is Claude Code's settings for every project on this
 * machine, where a sign-in registers its hooks, and not one repository's.
 */
function isMachineConfigDir(dir) {
  const real = realPath(dir);
  return real === realPath(os.homedir()) || path.join(real, '.claude') === realPath(path.dirname(claudeSettingsFile()));
}

/**
 * The repository a command that writes into one works on: --repo, or the git
 * repository the command was run in. Never the home directory, even when it is
 * a git repository itself (a dotfiles checkout): see isMachineConfigDir. Dies,
 * saying what to do instead, when there is no repository to work on; `instead`
 * is the command's own word on what to run in its place.
 *
 * init, join and git-hook have always taken --repo as given. The commands that
 * used to fall back to whatever folder they were run in (`strict`) want it to
 * be inside a git repository as well: that fallback is how uninstall, run in
 * the home directory, rewrote Claude Code's settings and deleted
 * ~/.claude/agentmash.
 */
function targetRepo(args, { strict = false, instead = "run this in your team's repo, or pass --repo <path>", also = '' } = {}) {
  const repo = args.repo ? path.resolve(args.repo) : findRepoRoot();
  if (!repo) die(`not inside a git repository — ${instead}${also ? `\n        ${also}` : ''}`);
  // --repo is what was given, so it is not the thing to suggest
  if (strict && args.repo && !findRepoRoot(repo)) {
    die(`${repo} is not a git repository — give --repo a folder inside the repository, or run this in it${also ? `\n        ${also}` : ''}`);
  }
  if (isMachineConfigDir(repo)) {
    const what = realPath(repo) === realPath(os.homedir()) ? 'is your home directory' : 'holds Claude Code\'s own configuration (CLAUDE_CONFIG_DIR)';
    die(
      `${repo} ${what}, not a project: its .claude/ is Claude Code's configuration for every project on ` +
        `this machine, so agentmash leaves it alone, git repository or not — ${instead}${also ? `\n        ${also}` : ''}`
    );
  }
  return repo;
}

/**
 * Hook sources: the repo checkout in dev, or the copy bundled with the
 * published package. The checkout comes first because `sync-hooks.mjs` leaves a
 * vendored copy in cli/hooks/ that goes stale the moment anyone edits hooks/,
 * and installing yesterday's hooks is worse than not finding them.
 */
function hookSourceDir() {
  for (const candidate of [path.join(HERE, '..', 'hooks'), path.join(HERE, 'hooks')]) {
    if (INSTALLED_FILES.every((f) => fs.existsSync(path.join(candidate, f)))) return candidate;
  }
  die('could not locate the hook scripts to install (broken package?)');
}

/**
 * Client sources, in the same order as the hooks' and for the same reason:
 * the checkout's clients/ first, then the copy bundled with the package,
 * which in a checkout is yesterday's.
 */
function clientSourceDir() {
  for (const candidate of [path.join(HERE, '..', 'clients'), path.join(HERE, 'clients')]) {
    if (CLIENT_FILES.every(([src]) => fs.existsSync(path.join(candidate, src)))) return candidate;
  }
  return null;
}

/** One client's source (`src` under clients/), from the checkout or the bundled copy, or null. */
function clientSource(src) {
  for (const candidate of [path.join(HERE, '..', 'clients'), path.join(HERE, 'clients')]) {
    if (fs.existsSync(path.join(candidate, src))) return path.join(candidate, src);
  }
  return null;
}

const meshDir = (repo) => path.join(repo, '.claude', 'agentmash');
const configPath = (repo) => path.join(meshDir(repo), 'config.json');
const settingsPath = (repo) => path.join(repo, '.claude', 'settings.json');
const mcpJsonPath = (repo) => path.join(repo, '.mcp.json');

/**
 * Whether the hooks committed in `repo` are older than prompt ids: their
 * lib.mjs keeps no prompt under an id (writePrompt). A machine signed in with
 * login steps aside for them, as for any install in a repository (two would
 * report everything twice), so they are what reports, and their edits name
 * no prompt id. After a turn the harness sent, the server gives such an edit
 * the prompt its session had before it (see staleInstallNote in
 * hooks/lib.mjs). False where nothing is committed.
 */
function committedHooksPredatePrompts(repo) {
  try {
    return !/export function writePrompt\b/.test(fs.readFileSync(path.join(meshDir(repo), 'lib.mjs'), 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Whether the hooks committed in `repo` are from before a room could ask for
 * a sign-in beside its key: their lib.mjs says nothing of sign_in_required.
 * Those from before cli 0.9 send no sign-in at all, so once the room asks,
 * every report they make is turned away, signed in or not; the later ones
 * send it, but a session they start says nothing of why one is turned away.
 * False where nothing is committed.
 */
function committedHooksPredateSignIn(repo) {
  try {
    return !fs.readFileSync(path.join(meshDir(repo), 'lib.mjs'), 'utf8').includes('sign_in_required');
  } catch {
    return false;
  }
}

/** What status, doctor and login say of hooks committedHooksPredatePrompts finds. */
const STALE_HOOKS =
  'the hooks committed in .claude/agentmash are from an older agentmash, and send edits without the id of the ' +
  'prompt they came from — run: npx agentmash init, then commit .claude';

function readConfig(repo) {
  try {
    return JSON.parse(fs.readFileSync(configPath(repo), 'utf8'));
  } catch {
    return null;
  }
}

// ── http ───────────────────────────────────────────────────────────────────

/**
 * Node races the addresses a hostname resolves to and gives each attempt 250 ms
 * by default. A TCP connect to a server a continent away takes longer than that,
 * so every attempt is abandoned, fetch rejects with ETIMEDOUT in ~300 ms, and the
 * caller sees a dead server that curl reaches fine. Give each attempt half the
 * request's own budget instead: a slow-but-working first address gets to finish,
 * and a blackholed one still leaves the other half for the next family.
 */
function widenConnectAttempts(timeoutMs) {
  try {
    net.setDefaultAutoSelectFamilyAttemptTimeout(Math.max(250, Math.floor(timeoutMs / 2)));
  } catch {
    // Node older than 18.18 has no such knob, and no such 250 ms default to undo
  }
}

/**
 * This machine's sign-in, for a request made with a room key to the server
 * it signed in to, and to no other: a key committed to a public repository
 * opens its room only beside the sign-in of someone who can push there
 * (room_key_public), and everywhere else the server goes by the key alone.
 */
function signInBesideKey(url, room) {
  if (!String(room || '').startsWith('mash_')) return '';
  const login = readUserLogin();
  const base = String(login?.url || '').replace(/\/+$/, '').toLowerCase();
  return base && String(url).toLowerCase().startsWith(`${base}/`) && login.token.startsWith('amu_') ? login.token : '';
}

/**
 * How to sign this machine in for a room key on `server`: npx agentmash
 * login, or, when it is signed in to another server already (a config from
 * before the domain moved names the old one), what puts the two together:
 * the sign-in goes beside a key to its own server only (signInBesideKey).
 */
function signInFixFor(server) {
  const login = readUserLogin();
  if (!login || !server || sameServer(login.url, server)) return 'npx agentmash login';
  return (
    `this machine is signed in to ${login.url}, and the room is on ${server}: npx agentmash login --server ${server}, ` +
    `or point "url" in .claude/agentmash/config.json at ${login.url}`
  );
}

async function api(method, url, { room, token, poll, user, body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const started = Date.now();
  user = user || signInBesideKey(url, room);
  try {
    widenConnectAttempts(timeoutMs);
    const res = await fetch(url, {
      method,
      // Short-lived CLI: don't leave keep-alive sockets open for exit to race.
      // Credentials go in headers, never in the URL — query strings end up in
      // access logs, shell history and browser referrers.
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-agentmash-room': room || '',
        ...(token ? { 'x-agentmash-token': token } : {}),
        ...(poll ? { 'x-agentmash-poll': poll } : {}),
        ...(user ? { 'x-agentmash-user': user } : {}),
        connection: 'close',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON response */
    }
    return { ok: res.ok, status: res.status, json, text, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: 0, json: null, text: unreached(err), ms: Date.now() - started };
  }
}

/**
 * Why a request got no answer, in the system's words. fetch says only "fetch
 * failed", and what failed is its cause: connect ECONNREFUSED 127.0.0.1:8787,
 * getaddrinfo ENOTFOUND …, with the code to search for. A name that resolves
 * to two addresses, as localhost does, fails with one cause for each.
 */
function unreached(err) {
  const cause = err?.cause;
  const said = cause?.message || (cause?.errors ?? []).map((e) => e?.message).filter(Boolean).join(', ') || cause?.code;
  return String(said || err?.message || err);
}

/**
 * Ask the server about the room this repo points at, with the key in a header.
 * `GET /rooms/:id` puts a working credential in the URL, so it lands verbatim
 * in the server's log, in every proxy in between, and in shell history — and
 * `doctor` runs it constantly. Servers older than /rooms/self answer that path
 * from their `:id` route with a 404 that carries no `code`, which is the signal
 * to fall back so a new CLI still works against an old server.
 */
async function lookupRoom(url, room, token) {
  const res = await api('GET', `${url}/rooms/self`, { room, token });
  if (res.status === 404 && !res.json?.code) return api('GET', `${url}/rooms/${room}`, { room, token });
  return res;
}

// ── per-machine credentials ────────────────────────────────────────────────
// Developer tokens are personal: they live in the user's home directory, mode
// 0600, and never in the repo. Keyed by server + the room's non-secret ref, so
// rotating the room key leaves them intact.

function credentialsPath() {
  const home = process.env.AGENTMASH_HOME || os.homedir();
  return path.join(home, '.agentmash', 'credentials.json');
}

function readCredentials() {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { version: 1, tokens: {} };
  } catch {
    return { version: 1, tokens: {} };
  }
}

function credentialKey(url, roomRef) {
  return `${url.replace(/\/+$/, '')}|${roomRef}`;
}

function readToken(url, roomRef) {
  if (!roomRef) return '';
  const entry = readCredentials().tokens?.[credentialKey(url, roomRef)];
  return typeof entry?.token === 'string' ? entry.token : '';
}

function writeToken(url, roomRef, entry) {
  const file = credentialsPath();
  const store = readCredentials();
  store.version = 1;
  store.tokens = store.tokens ?? {};
  store.tokens[credentialKey(url, roomRef)] = entry;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
}

/** The room this repo is wired to, plus whatever credentials we hold for it. */
function connection(repo) {
  const config = readConfig(repo);
  const url = (process.env.AGENTMASH_URL || config?.url || '').replace(/\/+$/, '');
  const room = process.env.AGENTMASH_ROOM || config?.room || '';
  const roomRef = process.env.AGENTMASH_ROOM_REF || config?.room_ref || '';
  return { config, url, room, roomRef, token: process.env.AGENTMASH_TOKEN || readToken(url, roomRef) };
}

// ── install ────────────────────────────────────────────────────────────────

// A committed hook runs on a teammate's machine as it is, with `node` on its
// PATH or not. Run as node and the script (`command` and `args`, which Claude
// Code starts with no shell), a machine without it failed every hook, an
// error at every prompt and edit, and nothing said why. So each one is a line
// for the shell Claude Code runs a hook's command in: sh (bash, zsh, Git Bash
// on Windows), or PowerShell on Windows without Git Bash. Both read it:
//
//   set `# <#` >/dev/null; command -v node >/dev/null 2>&1 || { exit 0; }; exec node "${CLAUDE_PROJECT_DIR}/.claude/agentmash/x.mjs" #>; if (Get-Command node -ErrorAction Ignore) { node "$env:CLAUDE_PROJECT_DIR/.claude/agentmash/x.mjs"; exit $LASTEXITCODE }; exit 0
//
// sh takes `# <#` in the backquotes for a comment, so `set` gets nothing and
// lists its variables into /dev/null; then it runs node, or, with none, exits
// 0 at once, and never gets as far as the `#>`, a comment to it as well.
// PowerShell takes `` `# `` for a # escaped, a name for `set` (Set-Variable),
// then a block comment from `<#` to `#>` that holds all of sh's part, and
// after it runs its own. With no node, the session start says so, each time, in a
// line for the person (NO_NODE_MESSAGE); every other hook says nothing and
// exits 0. The web installer writes the same line, byte for byte
// (server/src/install-plan.ts), and a test runs it under sh and PowerShell,
// with node and without. A sign-in's hooks run on the machine that signed in,
// with node, and keep the plain form (machineHookEntry).
//
// On Windows without Git Bash, Claude Code runs the line in PowerShell, and
// says so once per session ("Git Bash wasn't found, so a SessionStart hook
// ran in PowerShell"): the hooks still run, the notice is Claude Code's.
const HOOK_DIR = '.claude/agentmash';
const NO_NODE_MESSAGE =
  '{"systemMessage":"AgentMash needs Node.js 18.12 or newer on your PATH, and reports nothing from this session without it. Install it from https://nodejs.org"}';
const committedCommand = (script) => {
  const said = script === 'session_start.mjs' ? `echo '${NO_NODE_MESSAGE}'; ` : '';
  return (
    'set `# <#` >/dev/null; ' +
    `command -v node >/dev/null 2>&1 || { ${said}exit 0; }; ` +
    `exec node "\${CLAUDE_PROJECT_DIR}/${HOOK_DIR}/${script}" #>; ` +
    `if (Get-Command node -ErrorAction Ignore) { node "$env:CLAUDE_PROJECT_DIR/${HOOK_DIR}/${script}"; exit $LASTEXITCODE }; ` +
    `${said}exit 0`
  );
};
// Claude Code counts a hook's timeout from the moment it starts the shell, and
// the hooks count their own deadline from the moment node starts
// (HOOK_DEADLINE_MS in hooks/lib.mjs, prompt_note's guard), half a second
// short of it. A shell before node takes a few tens of milliseconds in sh, but
// up to most of a second in PowerShell 5.1, which ate that half second: on a
// slow room, Claude Code killed the hook before it could end itself. So a
// committed hook gets a second more than a sign-in's plain one
// (machineHookEntry). The hooks still end at the same point; only a slow
// shell uses the second.
const SHELL_START_S = 1;
const hookCommand = (script, { timeout = 5, ...extra } = {}) => ({
  type: 'command',
  command: committedCommand(script),
  timeout: timeout + SHELL_START_S,
  ...extra,
});
/** The script a hook entry of ours runs: `x.mjs`, out of its command or its args. */
const hookScriptOf = (hook) =>
  [hook?.command, ...(Array.isArray(hook?.args) ? hook.args : [])]
    .map((part) => (typeof part === 'string' ? /agent(?:mash|mesh)[\\/]([\w.-]+\.mjs)/.exec(part)?.[1] : null))
    .find(Boolean) ?? null;

// Which tools the edit hooks follow: exact names joined by |, never a pattern.
// Claude Code compares a matcher made of nothing but letters, digits, _ and |
// name by name, and reads anything else as a regex, where "Write" would match
// TodoWrite too. The advisory speaks before a file edit, a notebook cell's
// included. The report follows every tool that can change a file: a Bash or
// PowerShell command names none, so post_tool_use reads the working tree.
//
// Devin reads these hooks from .claude/settings.json too, and its edit tools
// are lowercase: write, edit and apply_patch (whose files are in its patch
// text; see editedFiles in hooks/lib.mjs). Claude Code has no tools by those
// names, so to it they change nothing; Devin reads a matcher as a regex, which
// finds its own names in it. An install from before them is brought up to
// date by `init` (mergeHookEntries) and `login`, and `doctor` says it is out
// of date until then.
const EDIT_TOOLS = 'Write|Edit|MultiEdit|NotebookEdit|write|edit|apply_patch';
const CHANGE_TOOLS = `${EDIT_TOOLS}|Bash|PowerShell`;
// The check before an edit also sees a shell command, for the files its text
// says it writes (`sed -i`, a heredoc into a file, a script that opens one, or
// PowerShell's Set-Content): an agent allowed to run anything edits that way
// as often as with Edit, and on Windows its shell may be the PowerShell tool.
// A command that only reads costs a node start and asks the room nothing.
const CHECK_TOOLS = `${EDIT_TOOLS}|Bash|PowerShell`;

// Reporting hooks run with async: true — Claude Code doesn't wait for them, so
// a distant server costs the agent nothing. The ones it waits on are the ones
// whose whole purpose is to speak in time: the advisory before an edit, the
// heads-up at a session's start and at a prompt, and the stop hook.
const HOOK_ENTRIES = {
  // In the background as the session opens; the agent's first reply waits for it.
  SessionStart: { hooks: [hookCommand('session_start.mjs')] },
  // Claude Code holds a prompt until every hook here that is not async is
  // done, so the prompt is reported in the background, and only the heads-up
  // runs in line: it asks the room once in ten minutes at most, and ends well
  // inside its three seconds.
  UserPromptSubmit: {
    hooks: [hookCommand('user_prompt_submit.mjs', { async: true }), hookCommand('prompt_note.mjs', { timeout: 3 })],
  },
  PreToolUse: { matcher: CHECK_TOOLS, hooks: [hookCommand('pre_tool_use.mjs')] },
  PostToolUse: { matcher: CHANGE_TOOLS, hooks: [hookCommand('post_tool_use.mjs', { async: true })] },
  // SessionEnd hooks share a short budget, and the process is going away, so
  // this one stays synchronous with a little more room than the default.
  SessionEnd: { hooks: [hookCommand('session_end.mjs', { timeout: 4 })] },
  // Synchronous on purpose: its whole job is to speak before the turn ends.
  Stop: { hooks: [hookCommand('stop.mjs')] },
};

// Claude Code reads project-scoped MCP servers from .mcp.json, in the folder a
// session starts in and in every folder above it, and starts each server in
// that folder: the repo root, or a subfolder of it just as often. It expands
// ${VAR} and ${VAR:-default} in `command` and `args` from its own environment,
// where CLAUDE_PROJECT_DIR is unset (it sets that only in the server's), so
// `${CLAUDE_PROJECT_DIR:-.}/.claude/agentmash/mcp_launcher.mjs`, what this
// entry used to be, always ran as `./.claude/agentmash/mcp_launcher.mjs`,
// relative to the session's folder. From a subfolder that is a file that is not
// there, and a session with no AgentMash tools at all.
//
// So the entry is a few statements of Node that walk up from that folder to
// the first .claude/agentmash/mcp_launcher.mjs and start it: the same command
// from any folder, with no `${` in it for Claude Code to expand, single quotes
// only, so it reads in .mcp.json as it runs, and one argument each however many
// spaces the path has, since `command` and `args` never go through a shell. The
// launcher then finds its repository from where it is installed.
//
// The walk goes no higher than the folder whose .mcp.json registered the
// server, or a repository's own root (a .git folder), whichever it reaches
// first. Above those, a launcher is code nobody in this repository put there:
// on Windows any local user can make C:\.claude\agentmash\, the way git once
// found a C:\.git (CVE-2022-24765), and a clone inside a folder AgentMash is
// installed in (~/work, say) would be served that folder's room. So a
// repository that registers the server with no .claude/agentmash of its own,
// because .claude is ignored or was deleted to turn AgentMash off, fails the
// way the entry this one replaced did, naming the folder it started from. A
// .git file is a linked worktree's or a submodule's, and the walk goes on past
// it: a session in a worktree Claude Code made in .claude/worktrees/, from a
// commit before AgentMash was installed, still finds the main checkout's.
//
// `doctor` starts this same command from the root and from a subfolder, so a
// wrong belief here fails out loud; it skips a subfolder this walk stops at
// (walkStopsAt), so a change to where it stops goes there too. The web
// installer writes the same entry, byte for byte (server/src/install-plan.ts),
// and a test diffs the two.
const MCP_BOOTSTRAP = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import { pathToFileURL } from 'node:url';",
  "const start = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? '');",
  'for (let dir = start; ; dir = path.dirname(dir)) {',
  "const launcher = path.join(dir, '.claude', 'agentmash', 'mcp_launcher.mjs');",
  'if (fs.existsSync(launcher)) { await import(pathToFileURL(launcher).href); break; }',
  "let registers = false; try { registers = fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8').includes('mcp_launcher'); } catch {}",
  "let repoRoot = false; try { repoRoot = fs.statSync(path.join(dir, '.git')).isDirectory(); } catch {}",
  "if (registers || repoRoot || path.dirname(dir) === dir) { console.error('[agentmash-mcp] no .claude/agentmash/mcp_launcher.mjs from ' + start + ' up to ' + dir + ': run npx agentmash init'); process.exit(1); }",
  '}',
].join(' ');
const MCP_SERVER_ENTRY = { command: 'node', args: ['--input-type=module', '-e', MCP_BOOTSTRAP] };

/**
 * An entry of ours, from this version or an older one: it starts
 * mcp_launcher.mjs out of .claude/agentmash/ (or .claude/agentmesh/, the
 * folder's old name). Running init again brings an older one up to date, and
 * replacing it is never replacing somebody else's server.
 */
const isOurMcpEntry = (entry) =>
  Array.isArray(entry?.args) &&
  entry.args.some((arg) => typeof arg === 'string' && /agent(?:mash|mesh)\W+mcp_launcher\.mjs/.test(arg));

/**
 * This version's entry: what it runs, whatever else is beside it. A `type`
 * that `claude mcp add-json` writes, or an `env` a developer added, does not
 * make it an older version's.
 */
const isCurrentMcpEntry = (entry) =>
  entry?.command === MCP_SERVER_ENTRY.command && JSON.stringify(entry?.args) === JSON.stringify(MCP_SERVER_ENTRY.args);

/**
 * Merge our server into whatever .mcp.json the repo already has. Null when
 * nothing changes. An older entry of ours keeps the keys someone added to it,
 * and only what it runs is brought up to date; somebody else's server by our
 * name is replaced whole.
 */
function mergeMcpJson(existing) {
  let config = {};
  if (existing && existing.trim()) {
    try {
      config = JSON.parse(existing);
    } catch {
      throw new Error('is not valid JSON');
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('must contain a JSON object at the top level');
    }
  }
  config.mcpServers = config.mcpServers ?? {};
  const current = config.mcpServers[MCP_SERVER_NAME];
  if (isCurrentMcpEntry(current)) return null;
  config.mcpServers[MCP_SERVER_NAME] = isOurMcpEntry(current) ? { ...current, ...MCP_SERVER_ENTRY } : MCP_SERVER_ENTRY;
  return JSON.stringify(config, null, 2) + '\n';
}

/**
 * The same script either way. core.autocrlf, the Windows default, checks the
 * committed scripts out with CRLF line endings, and git sees no change in
 * them; neither does init, or every re-run there would say it brought them
 * up to date and ask for a commit of nothing.
 */
function sameScript(have, want) {
  return have.equals(want) || have.toString('utf8').replace(/\r\n/g, '\n') === want.toString('utf8').replace(/\r\n/g, '\n');
}

/** Put this version's hook scripts in the repo; returns how many were not already that, line endings aside. */
function copyHooks(repo) {
  const source = hookSourceDir();
  fs.mkdirSync(meshDir(repo), { recursive: true });
  const pairs = INSTALLED_FILES.map((file) => [path.join(source, file), path.join(meshDir(repo), file)]);
  const clients = clientSourceDir();
  if (clients) {
    for (const [src, dest] of CLIENT_FILES) pairs.push([path.join(clients, src), path.join(meshDir(repo), dest)]);
  }
  let changed = 0;
  for (const [from, to] of pairs) {
    const want = fs.readFileSync(from);
    let have = null;
    try {
      have = fs.readFileSync(to);
    } catch {
      // not installed yet
    }
    if (have && sameScript(have, want)) continue;
    fs.copyFileSync(from, to);
    changed += 1;
  }
  return changed;
}

// ── git client ─────────────────────────────────────────────────────────────
// The post-commit hook is the only way a room ever sees a teammate who edits by
// hand, or in an editor with no extension point. It lives in .git/hooks, which
// is NOT committed — so unlike the Claude Code hooks it does not arrive with a
// `git pull`, and every developer installs it on their own machine.

const GIT_HOOK_MARKER = 'agentmash-git-hook';

/**
 * Never blocks, never fails, never speaks. It backgrounds the worker and returns
 * immediately, which is the git equivalent of the reporting hooks' `async: true`
 * — the developer's `git commit` finishes at exactly the speed it did before.
 */
const GIT_HOOK_SCRIPT = `#!/bin/sh
# ${GIT_HOOK_MARKER} — installed by \`agentmash git-hook install\`.
#
# Reports which files this commit touched to your team's AgentMash room, in the
# background. It cannot slow down or fail your commit: it starts a detached
# process and exits 0 immediately.
#
# Any post-commit hook that was already here was moved to post-commit.local and
# still runs first, unchanged. Removing this file (or \`agentmash git-hook
# uninstall\`) restores it.

hook_dir=$(dirname "$0")
if [ -x "$hook_dir/post-commit.local" ]; then
  "$hook_dir/post-commit.local" "$@" </dev/null
fi

# The checkout's top, the commit this hook runs for and the branch it was made
# on, from one git, now: the worker starts in the background, and by the time
# it reads HEAD a second commit or a checkout may have moved it.
nl='
'
here=$(git rev-parse --show-toplevel HEAD --symbolic-full-name HEAD 2>/dev/null) ||
  here=$(git rev-parse --show-toplevel 2>/dev/null) || here=""
root="$here"; sha=""; ref=""
case $here in
  *"$nl"*"$nl"*)
    root=\${here%%"$nl"*}; rest=\${here#*"$nl"}
    sha=\${rest%%"$nl"*}; ref=\${rest#*"$nl"}
    ;;
esac
[ -n "$root" ] || root="$PWD"
worker="$root/.claude/agentmash/git_post_commit.mjs"

# Hooks run under a non-login shell that never reads your profile, so a node
# installed by nvm/volta/fnm is not on PATH — that is every commit made from a
# GUI client. Look where those put it before giving up. Globs and [ -x ] are
# shell builtins: no subprocess, no measurable cost.
node_bin=""
if command -v node >/dev/null 2>&1; then
  node_bin=node
else
  for candidate in "$HOME"/.volta/bin/node /opt/homebrew/bin/node /usr/local/bin/node \
                   "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then node_bin="$candidate"; break; fi
  done
fi

if [ -f "$worker" ] && [ -n "$node_bin" ]; then
  "$node_bin" "$worker" "$root" "$sha" "$ref" </dev/null >/dev/null 2>&1 &
fi

exit 0
`;

const contains = (parent, child) => child === parent || child.startsWith(parent + path.sep);

/**
 * Where git will actually look for hooks, and what kind of place that is.
 *
 * core.hooksPath must be honoured — git runs hooks from there and nowhere else,
 * so writing to .git/hooks when it is set produces a hook that is never run.
 * But *where* it points changes what installing means: a `.githooks/` or
 * `.husky/_` directory is inside the working tree, and a file written there is
 * a tracked file modified plus an untracked sibling created — see installGitHook.
 * Linked worktrees are the other case: their hooks live in the common git dir.
 */
function resolveHooksDir(repo) {
  const ask = (args) => {
    try {
      return execFileSync('git', args, { cwd: repo, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      return '';
    }
  };
  const gitDir = path.resolve(repo, ask(['rev-parse', '--git-common-dir']) || '.git');
  const workTree = path.resolve(ask(['rev-parse', '--show-toplevel']) || repo);
  const configured = ask(['config', '--get', 'core.hooksPath']);
  if (!configured) {
    return { dir: path.join(gitDir, 'hooks'), gitDir, configured: null, insideWorkTree: false, outsideRepo: false, shared: false };
  }
  // git resolves a relative core.hooksPath against the top of the working tree.
  const dir = path.resolve(workTree, configured);
  const inGitDir = contains(gitDir, dir);
  const outsideRepo = !inGitDir && !contains(workTree, dir);
  // Which config set it: this repository's own (local, worktree), or one every
  // repository on the machine reads (global, system). --show-scope is git
  // 2.26; before it, a value this repository's own config does not hold came
  // from one of the others. The file it is in is for saying so.
  const scoped = ask(['config', '--show-scope', '--get', 'core.hooksPath']).split('\t')[0];
  const scope = ['local', 'worktree', 'global', 'system', 'command'].includes(scoped)
    ? scoped
    : ask(['config', '--local', '--get', 'core.hooksPath']) === configured
      ? 'local'
      : 'global';
  const origin = ask(['config', '--show-origin', '--get', 'core.hooksPath']).split('\t')[0].replace(/^file:/, '');
  return {
    dir,
    gitDir,
    configured,
    insideWorkTree: !inGitDir && contains(workTree, dir),
    outsideRepo,
    // a folder every repository on the machine runs its hooks from: a hook
    // written there runs for all of them, and is gone for all of them when it goes
    shared: outsideRepo && scope !== 'local' && scope !== 'worktree',
    scope,
    origin,
  };
}

/** "your global git config (~/.gitconfig)", for saying where a core.hooksPath came from. */
function hooksPathSource(hooks) {
  const which = { global: 'your global git config', system: 'the system git config', command: 'the git command line' }[hooks.scope] ?? 'a git config';
  return hooks.origin ? `${which} (${hooks.origin})` : which;
}

/**
 * The note, in this repository's own git directory, that `git-hook install
 * --force-hooks-path` put our hook into a shared core.hooksPath for it: the
 * only thing that lets an uninstall here take it out again. Never committed;
 * git directories are not.
 */
const sharedHookNote = (hooks) => path.join(hooks.gitDir, 'agentmash-shared-hook.json');

function installedHereShared(hooks) {
  try {
    return JSON.parse(fs.readFileSync(sharedHookNote(hooks), 'utf8'))?.dir === hooks.dir;
  } catch {
    return false;
  }
}

const gitHooksDir = (repo) => resolveHooksDir(repo).dir;
const gitHookPath = (repo) => path.join(gitHooksDir(repo), 'post-commit');
const chainedHookPath = (repo) => path.join(gitHooksDir(repo), 'post-commit.local');

/**
 * What is at a path, *without* following symlinks — the whole point.
 * fs.existsSync() answers false for a dangling symlink, and writing to that
 * path then creates the file at the link's target, wherever that is.
 */
function pathKind(file) {
  let stat;
  try {
    stat = fs.lstatSync(file, { throwIfNoEntry: false });
  } catch {
    return 'unreadable'; // no permission on the directory, EIO, a path with a non-directory in it
  }
  if (!stat) return 'missing';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  return 'something else'; // fifo, socket, device
}

// O_NOFOLLOW closes the gap between the lstat above and the open below: if the
// path became a symlink in between, the open fails instead of following it.
// Windows has neither the flag nor the symlink-in-.git/hooks case; 0 there.
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Write the shim to a path we have just established is a plain file (or nothing). */
function writeHookFile(file, { replacing }) {
  const { O_WRONLY, O_CREAT, O_TRUNC, O_EXCL } = fs.constants;
  const flags = replacing ? O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW : O_WRONLY | O_CREAT | O_EXCL;
  const fd = fs.openSync(file, flags, 0o755);
  try {
    fs.writeFileSync(fd, GIT_HOOK_SCRIPT);
    // O_CREAT's mode is masked by umask, and git ignores a non-executable hook.
    fs.fchmodSync(fd, 0o755);
  } finally {
    fs.closeSync(fd);
  }
}

function isOurGitHook(file) {
  if (pathKind(file) !== 'file') return false;
  try {
    return fs.readFileSync(file, 'utf8').includes(GIT_HOOK_MARKER);
  } catch {
    return false;
  }
}

/**
 * Returns { ok, message }. Never throws: a checkout where the hooks directory
 * cannot be written still gets a working install of everything else.
 *
 * Two refusals matter more than the install:
 *
 * 1. Anything at post-commit that is not a plain file we may replace. A dangling
 *    symlink is the sharp case — `existsSync` says false, the write then lands
 *    at the link's target, and the chmod makes it executable. That is an
 *    arbitrary executable file anywhere on the filesystem, from a command we ask
 *    every developer on a team to run.
 * 2. A hooks directory inside the working tree (core.hooksPath = .githooks,
 *    .husky/_, lefthook). Writing there modifies a tracked file, and the next
 *    `git add -A` commits AgentMash to everybody. The whole argument for
 *    installing by default is that .git/hooks is never committed; where that is
 *    not true, the argument is not either, so we stop and ask.
 */
function installGitHook(repo, { forceHooksPath = false } = {}) {
  const hooks = resolveHooksDir(repo);
  const file = path.join(hooks.dir, 'post-commit');
  const chained = path.join(hooks.dir, 'post-commit.local');
  const shown = path.relative(repo, hooks.dir) || hooks.dir;

  if (hooks.insideWorkTree && !forceHooksPath) {
    return {
      ok: false,
      message:
        `this repo runs hooks from ${shown}/ (core.hooksPath), which is inside the working tree —\n` +
        `    installing there would modify a tracked file and commit AgentMash to your whole team.\n` +
        `    Re-run with --force-hooks-path if that is what you want.`,
    };
  }

  // A core.hooksPath from the global or system config is every repository's
  // hooks folder. Written there, our hook would run for every repository on
  // the machine, a post-commit of the owner's would be moved aside for all of
  // them, and an uninstall in any one would take it out of all of them. So
  // not unasked: --force-hooks-path, the same opt-in as for a folder in the
  // working tree, says yes, and this repository notes that it did.
  // Ours is there already, from another repository's opt-in or from before
  // opt-ins were noted: it runs for this repository too, and that is said.
  if (hooks.shared && !forceHooksPath && isOurGitHook(file)) {
    return {
      ok: true,
      message:
        `git post-commit hook already installed in ${hooks.dir} (core.hooksPath from ${hooksPathSource(hooks)}),\n` +
        `    shared by every repository on this machine; it reports from those with a room, this one among them`,
    };
  }
  if (hooks.shared && !forceHooksPath) {
    const theirs = pathKind(file) === 'file' && !isOurGitHook(file) ? ', and holds a post-commit of its own' : '';
    return {
      ok: false,
      message:
        `git post-commit client not installed: core.hooksPath is set in ${hooksPathSource(hooks)} to\n` +
        `    ${hooks.dir}${theirs}. git runs every repository's hooks from there, so a hook written\n` +
        `    there would run for every repository on this machine.\n` +
        `    Re-run with --force-hooks-path to install it there anyway (git-hook uninstall here takes it out).`,
    };
  }

  try {
    fs.mkdirSync(hooks.dir, { recursive: true });

    const kind = pathKind(file);
    if (kind === 'symlink') {
      return {
        ok: false,
        message:
          `${file} is a symlink — leaving it alone.\n` +
          `    Writing through it would create an executable file wherever it points.`,
      };
    }
    if (kind === 'unreadable') return { ok: false, message: `cannot inspect ${file} — leaving it alone` };
    if (kind !== 'missing' && kind !== 'file') {
      return { ok: false, message: `${file} is not a regular file (${kind}) — leaving it alone` };
    }

    if (kind === 'file' && !isOurGitHook(file)) {
      // Somebody's existing hook. Step aside politely: move it to
      // post-commit.local, which our script runs first, so their behaviour is
      // byte-for-byte what it was.
      const chainedKind = pathKind(chained);
      if (chainedKind !== 'missing') {
        return { ok: false, message: `post-commit.local already exists (${chainedKind}) — leaving ${file} alone` };
      }
      // rename, never chmod: making a non-executable hook executable would
      // start running something git was ignoring
      fs.renameSync(file, chained);
      writeHookFile(file, { replacing: false });
      noteSharedInstall(hooks);
      return {
        ok: true,
        message: hooks.shared
          ? `git post-commit hook installed in ${hooks.dir} (core.hooksPath from ${hooksPathSource(hooks)}), ` +
            'in front of the one already there, which it still runs first — for every repository on this machine'
          : 'git post-commit hook installed alongside the one already there',
      };
    }

    writeHookFile(file, { replacing: kind === 'file' });
    noteSharedInstall(hooks);
    const where = hooks.shared
      ? ` in ${hooks.dir} (core.hooksPath from ${hooksPathSource(hooks)}) — it runs for every repository on this machine, and reports from those with a room`
      : hooks.outsideRepo
        ? ` in ${hooks.dir} (core.hooksPath — shared with every repository that uses it)`
        : hooks.insideWorkTree
          ? ` in ${shown}/ (core.hooksPath, inside the working tree — do not commit it)`
          : '';
    return {
      ok: true,
      message: (kind === 'file' ? 'git post-commit hook updated' : 'git post-commit hook installed') + where,
    };
  } catch (err) {
    return { ok: false, message: `could not write ${file} — ${err.message}` };
  }
}

/**
 * Bring our post-commit shim up to this version's, when the one installed is
 * ours and is not: it lives in .git/hooks, which no pull reaches, so re-running
 * init is the only way it catches up. A hook of anyone else's, one in a folder
 * every repository on the machine shares, and one inside the working tree
 * (a tracked file) are left exactly as they are, as installGitHook leaves
 * them. Whether it wrote the shim. Never throws.
 */
function refreshGitHook(repo) {
  try {
    const hooks = resolveHooksDir(repo);
    if (hooks.shared || hooks.insideWorkTree) return false;
    const file = path.join(hooks.dir, 'post-commit');
    if (!isOurGitHook(file) || fs.readFileSync(file, 'utf8') === GIT_HOOK_SCRIPT) return false;
    writeHookFile(file, { replacing: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the installed shim will actually do anything. The shim needs two
 * things: the worker beside it, and a `node` that a non-login `/bin/sh` can
 * find. The second is the one that surprises people — `git commit` from
 * SourceTree, VS Code or JetBrains runs with a PATH that never saw nvm.
 */
function workerCanRun(repo) {
  if (!fs.existsSync(path.join(meshDir(repo), 'git_post_commit.mjs'))) {
    return { ok: false, message: 'the hook is installed but the worker is not — run: agentmash git-hook install' };
  }
  let found = '';
  try {
    found = execFileSync('/bin/sh', ['-c', 'command -v node'], { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // no node on PATH at all, or no /bin/sh (Windows) — say nothing rather than
    // guess; the shim itself is inert-and-silent in that case by design
    return { ok: true };
  }
  if (/[/\\](\.nvm|\.volta|\.fnm|\.asdf|fnm_multishells|\.nodenv)[/\\]/.test(found)) {
    return {
      ok: false,
      message:
        `node comes from a version manager (${found}), which a GUI git client's PATH will not have.\n` +
        `    The hook looks in the usual version-manager locations too, but commits made outside a\n` +
        `    terminal are the case to check if your commits never show up.`,
    };
  }
  return { ok: true };
}

/** Remember, in this repository's git directory, that it put our hook into a shared core.hooksPath. */
function noteSharedInstall(hooks) {
  if (!hooks.shared) return;
  try {
    fs.writeFileSync(sharedHookNote(hooks), JSON.stringify({ dir: hooks.dir, at: new Date().toISOString() }) + '\n');
  } catch {
    // a git directory that cannot be written: an uninstall here then leaves the hook, which is the safe way round
  }
}

function uninstallGitHook(repo, { forceHooksPath = false } = {}) {
  const hooks = resolveHooksDir(repo);
  const file = path.join(hooks.dir, 'post-commit');
  const chained = path.join(hooks.dir, 'post-commit.local');
  try {
    const kind = pathKind(file);
    if (kind === 'missing') return { ok: true, message: 'no git post-commit hook to remove' };
    // A symlink is never ours even if what it points at contains our marker:
    // somebody else made that link, and removing it is their decision.
    if (kind === 'symlink') return { ok: false, message: `${file} is a symlink, not ours — leaving it alone` };
    if (!isOurGitHook(file)) return { ok: false, message: `${file} is not ours — leaving it alone` };
    // Every repository on the machine runs this one. Only the repository that
    // put it there, with --force-hooks-path, takes it out: from any other, an
    // uninstall would take the client out of all of them.
    // --force-hooks-path, the opt-in that put it there, takes it out from
    // anywhere: the one way out for a hook installed before opt-ins were noted.
    if (hooks.shared && !installedHereShared(hooks) && !forceHooksPath) {
      return {
        ok: true,
        message:
          `the git post-commit hook in ${hooks.dir} (core.hooksPath from ${hooksPathSource(hooks)}) runs for every ` +
          'repository on this machine, and was not installed there for this repository — left alone. To take it out ' +
          'for all of them: npx agentmash git-hook uninstall --force-hooks-path',
      };
    }
    if (hooks.shared) fs.rmSync(sharedHookNote(hooks), { force: true });
    fs.rmSync(file, { force: true });
    if (pathKind(chained) === 'file') {
      fs.renameSync(chained, file);
      return { ok: true, message: 'git post-commit hook removed, the one it replaced is back in place' };
    }
    return { ok: true, message: 'git post-commit hook removed' };
  } catch (err) {
    return { ok: false, message: `could not remove ${file} — ${err.message}` };
  }
}

/**
 * Check we'll be able to write the files we merge into before doing anything
 * remote — otherwise a broken settings file leaves an orphan room on the server.
 */
function assertSettingsUsable(repo) {
  for (const file of [settingsPath(repo), mcpJsonPath(repo)]) {
    if (!fs.existsSync(file)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      die(`${file} is not valid JSON — fix or move it, then re-run.`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      die(`${file} must contain a JSON object at the top level.`);
    }
  }
}

/** A hook command of ours: it runs a script from .claude/agentmash/, or from .claude/agentmesh/, the folder's old name. */
const OUR_HOOK_DIR = /\.claude[\\/]agent(?:mash|mesh)[\\/]/;
const hookParts = (hook) => [hook?.command, ...(Array.isArray(hook?.args) ? hook.args : [])].filter((p) => typeof p === 'string');
const isOurHook = (hook) => hookParts(hook).some((part) => OUR_HOOK_DIR.test(part));
const hasOurHook = (group) => Array.isArray(group?.hooks) && group.hooks.some(isOurHook);

/**
 * Our entries merged into a settings file's `hooks`, in place; returns how
 * many events changed. Ours are replaced, not skipped, so running init again
 * brings an older install up to date: every hook of ours in an event this
 * version registers goes, in whichever group it is (a narrower matcher, the
 * folder's old name), and the event gets this version's group, once. A hook
 * of anyone else's stays where it is, even in a group it shared with one of
 * ours. An event that already holds exactly this version's group, and nothing
 * else of ours, is left as it is, so a current install is never rewritten.
 *
 * An event this version does not register is not touched at all: a hook of
 * ours there is a newer version's, and init run from an older checkout must
 * not take it out. Every event any version has registered is in HOOK_ENTRIES;
 * one ever dropped from it has to be cleaned up by name.
 */
function mergeHookEntries(hooks) {
  let changed = 0;
  for (const [event, want] of Object.entries(HOOK_ENTRIES)) {
    // something other than a list of groups is not ours to rearrange
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) continue;
    const groups = hooks[event] ?? [];
    const ours = groups.filter(hasOurHook);
    if (ours.length === 1 && JSON.stringify(ours[0]) === JSON.stringify(want)) continue;
    const kept = [];
    for (const group of groups) {
      if (!hasOurHook(group)) kept.push(group);
      else if (group.hooks.some((h) => !isOurHook(h))) kept.push({ ...group, hooks: group.hooks.filter((h) => !isOurHook(h)) });
    }
    hooks[event] = [...kept, want];
    changed += 1;
  }
  return changed;
}

/** Merge our entries into settings.json without disturbing anything else there. Returns how many events changed. */
function mergeSettings(repo) {
  const file = settingsPath(repo);
  let settings = {};
  const existed = fs.existsSync(file);
  if (existed) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      die(`${file} is not valid JSON — fix or move it, then re-run.`);
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      die(`${file} must contain a JSON object at the top level.`);
    }
  }
  settings.hooks = settings.hooks ?? {};
  const changed = mergeHookEntries(settings.hooks);
  if (changed === 0 && existed) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return changed;
}

/** Register the MCP server in .mcp.json, keeping any servers the team added. */
function mergeMcpFile(repo) {
  const file = mcpJsonPath(repo);
  let existing = null;
  if (fs.existsSync(file)) existing = fs.readFileSync(file, 'utf8');
  // A server already called "agentmash" that is not ours gets overwritten by
  // the merge. Narrow, but silently replacing someone's server is not ours to
  // do quietly, so say what was there. An older entry of our own is just brought
  // up to date.
  let replaced = null;
  try {
    const before = existing && existing.trim() ? JSON.parse(existing) : {};
    const current = before?.mcpServers?.[MCP_SERVER_NAME];
    if (current && !isCurrentMcpEntry(current) && !isOurMcpEntry(current)) {
      replaced = current;
    }
  } catch {
    /* mergeMcpJson reports an unparseable file */
  }
  let merged;
  try {
    merged = mergeMcpJson(existing);
  } catch (err) {
    die(`${file} ${err.message} — fix or move it, then re-run.`);
  }
  if (merged === null) return { changed: false, replaced: null };
  fs.writeFileSync(file, merged);
  return { changed: true, replaced };
}

/**
 * Bring an older .mcp.json entry of ours up to date, for `init` run again in
 * a connected repo; true when it did. Only ours: no entry means someone took
 * it out, and one that is not ours is not ours to replace without the warning
 * a first init gives. A file that will not parse is left for doctor to name.
 */
function upgradeMcpEntry(repo) {
  try {
    const current = JSON.parse(fs.readFileSync(mcpJsonPath(repo), 'utf8'))?.mcpServers?.[MCP_SERVER_NAME];
    if (!isOurMcpEntry(current) || isCurrentMcpEntry(current)) return false;
  } catch {
    return false;
  }
  return mergeMcpFile(repo).changed;
}

function writeConfig(repo, config) {
  fs.mkdirSync(meshDir(repo), { recursive: true });
  fs.writeFileSync(configPath(repo), JSON.stringify(config, null, 2) + '\n');
}

function wire(repo, config, { gitHook = true, forceHooksPath = false } = {}) {
  copyHooks(repo);
  const added = mergeSettings(repo);
  const mcp = mergeMcpFile(repo);
  writeConfig(repo, config);
  // Installed by default, and argued for in docs/ADAPTERS.md: it is local-only
  // (nothing is committed, so it cannot surprise a teammate), it cannot affect a
  // commit, and `uninstall` puts everything back. An opt-in flag nobody
  // discovers would leave exactly the people this is for invisible.
  return {
    added,
    mcp: mcp.changed,
    replaced: mcp.replaced,
    git: gitHook ? installGitHook(repo, { forceHooksPath }) : null,
  };
}

/**
 * The files of a repository install that are there, as git names them:
 * relative to the repository, with forward slashes. What init writes, and
 * what a teammate's pull has to bring.
 */
function installPaths(repo) {
  const mesh = [...INSTALLED_FILES, ...CLIENT_FILES.map(([, dest]) => dest), 'config.json'].map((f) => `.claude/agentmash/${f}`);
  return ['.claude/settings.json', ...mesh, '.mcp.json'].filter((rel) => fs.existsSync(path.join(repo, ...rel.split('/'))));
}

/**
 * The files of `paths` a commit would leave out: ignored by a .gitignore,
 * .git/info/exclude or the global excludes file, and not tracked already (git
 * commits a tracked file whatever ignores it, and check-ignore leaves those
 * out). Many repositories ignore .claude/, and then an install never reaches
 * a teammate, or reaches them as a settings.json whose every hook fails on a
 * script that is not there. [{ file, rule }], the rule as check-ignore -v
 * names it; [] when nothing is, or git cannot say. `tracked`: tracked files
 * too, every file a rule covers.
 */
function ignoredByGit(repo, paths, { tracked = false } = {}) {
  if (paths.length === 0) return [];
  let out;
  try {
    out = execFileSync('git', ['check-ignore', '-v', '-z', ...(tracked ? ['--no-index'] : []), '--stdin'], {
      cwd: repo,
      input: paths.join('\0'),
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    }).toString();
  } catch {
    // exit 1 is "none of them", and anything else is no answer
    return [];
  }
  const fields = out.split('\0');
  const found = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [source, line, pattern, file] = fields.slice(i, i + 4);
    // -v names a file a !pattern lets back in, too: that one is not ignored
    if (pattern.startsWith('!')) continue;
    const where = path.isAbsolute(source) && !path.relative(repo, source).startsWith('..') ? path.relative(repo, source).split(path.sep).join('/') : source;
    found.push({ file, rule: `${where}:${line}: ${pattern}` });
  }
  return found;
}

/**
 * Say which files of this install git ignores, and by which rule, with `say`
 * (warn, or bad in doctor). With `command`, also the one that commits them
 * anyway: git takes an ignored file named with -f, and tracks it from then on.
 */
function sayIgnored(ignored, { say = warn, command = true } = {}) {
  const files = ignored.map((i) => i.file);
  const halfWired = !files.includes('.claude/settings.json') && files.some((f) => f.endsWith('.mjs'));
  say(
    `git ignores ${files.length === 1 ? 'a file' : `${files.length} files`} of this install, so a commit leaves ` +
      `${files.length === 1 ? 'it' : 'them'} out: ${
        halfWired ? 'teammates get settings.json without the scripts it runs, and every hook fails' : 'teammates never get them'
      }`
  );
  const byRule = new Map();
  for (const { file, rule } of ignored) byRule.set(rule, [...(byRule.get(rule) ?? []), file]);
  for (const [rule, some] of byRule) {
    const named = some.length > 3 ? `${some.slice(0, 2).join(', ')} and ${some.length - 2} more` : andList(some);
    info(`${named}  ${c.dim(`ignored by ${rule}`)}`);
  }
  if (command) info(`commit them by name, with -f: ${c.bold(`git add -f -- ${files.join(' ')}`)}`);
  else info('the commit below names them, with -f, which takes an ignored file all the same');
  // Our scripts and config.json are ours whole. These two are merged into,
  // and a repository that ignores one may keep in it what it never meant to
  // commit: another MCP server's token, an env block. -f takes it all.
  const shared = files.filter((f) => f === '.claude/settings.json' || f === '.mcp.json');
  if (shared.length) {
    info(
      `-f commits ${andList(shared)} whole, with whatever else is in ${shared.length === 1 ? 'it' : 'them'}: if that is ` +
        `anything private (another server's token, an env block), look before you commit: ${c.bold(`git diff --cached -- ${shared.join(' ')}`)}`
    );
  }
  info(`the rule stays, so ${c.bold('npx agentmash doctor')} names any file a later version adds that it keeps out`);
}

/**
 * A commit and its push, one command to a line. Windows PowerShell 5.1, the
 * one Windows comes with, has no `&&`, so a chained line fails at its first
 * `&&` and runs nothing; each line alone runs in every shell.
 */
function sayCommitSteps(add, message) {
  for (const step of [add, `git commit -m "${message}"`, 'git push']) console.log(c.dim(`    ${step}`));
  console.log('');
}

/**
 * The git add that stages `paths`: `plain` (a folder, say), or each file named
 * with -f when an ignore rule covers any of them. Git refuses a path under a
 * rule, and exits 1 with its "paths are ignored" error, even as it stages a
 * tracked file's change there; -f takes it quietly.
 */
function stageCommand(repo, paths, plain) {
  return ignoredByGit(repo, paths, { tracked: true }).length ? `git add -f -- ${paths.join(' ')}` : plain;
}

/**
 * `signIn`: the room's key opens it only beside a sign-in that can push (the
 * server's sign_in_required). `dashboard`: its link (dashboardLink).
 */
function printJoined(repo, config, { added, mcp, replaced, git }, { signIn = false, dashboard }) {
  console.log(`\n${c.bold('AgentMash is wired up.')}\n`);
  ok(`hooks installed  ${c.dim(path.relative(repo, meshDir(repo)))}`);
  ok(added > 0 ? `settings.json updated (${added} hook events)` : 'settings.json already had the hooks');
  ok(mcp ? 'MCP server registered  .mcp.json' : 'MCP server already registered in .mcp.json');
  if (replaced) {
    warn(
      '.mcp.json already had a server called "agentmash" and it has been replaced:\n' +
        `      ${c.dim(JSON.stringify(replaced))}\n` +
        '      Put it back under another name if you still need it.'
    );
  }
  if (git?.ok) ok(git.message);
  else if (git) warn(git.message);
  ok(`room  ${c.cyan(config.room)}`);
  // git add .claude names a folder, which git refuses whole when it is
  // ignored: then the commit names every file, with -f
  const ignored = ignoredByGit(repo, installPaths(repo));
  if (ignored.length) sayIgnored(ignored, { command: false });
  console.log(`\n  ${c.bold('Dashboard')}  ${c.cyan(dashboard)}\n`);
  console.log(`  ${c.bold('To bring in your team — commit and push:')}`);
  sayCommitSteps(stageCommand(repo, installPaths(repo), 'git add .claude .mcp.json'), 'add agentmash');
  if (signIn) {
    // the key travels with the repo, and opens the room only beside a pusher's sign-in
    console.log(`  Teammates pull, and sign in once on their machine: ${c.bold('npx agentmash login')}.`);
    console.log('  The room key opens the room only beside the sign-in of someone who can');
    console.log('  push to the repository, so a copy of it anywhere else opens nothing.\n');
  } else {
    console.log('  Teammates just pull. The hooks and room travel with the repo,');
    console.log('  so their next Claude Code session joins automatically.\n');
  }
  // what the committed hooks and the MCP server run on; without it a session
  // says so as it starts, and reports nothing (committedCommand)
  console.log(`  ${c.bold('Teammates need Node.js 18.12 or newer on their PATH.')} The hooks and the MCP`);
  console.log('  server run on it: without it, a session says so as it starts, and reports nothing.\n');
  console.log(`  ${c.bold('Each teammate approves the MCP server once.')}`);
  console.log('  Claude Code asks before it runs a server a repo brought with it, and');
  console.log('  AgentMash does not answer that on anyone else\'s behalf. The hooks work');
  console.log(`  either way; ${c.bold('npx agentmash doctor')} says what a machine is missing.\n`);
  console.log('  The git post-commit client is local to this checkout — .git/hooks is not');
  console.log(`  committed — so each teammate runs ${c.bold('npx agentmash git-hook install')} once.\n`);
  console.log(c.dim('  (Already have Claude Code open? It picks up new hooks on its own,\n') +
    c.dim('   but restarting the session is the sure thing.)\n'));
}

/**
 * Open a link in the person's browser, when there is a person: stdout is a
 * terminal, this is not CI, and they did not say --no-open. The platform's
 * own opener, detached, so a browser that takes its time never holds the
 * command open. Returns whether anything was launched.
 */
function openInBrowser(url, args = {}) {
  if (args.noOpen || !process.stdout.isTTY || process.env.CI) return false;
  const [cmd, cmdArgs] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Two lines, for someone who typed `npx agentmash` in a repo that is not wired up. */
function nudge() {
  console.log(`\n  This repo is not connected yet.  ${c.bold('npx agentmash init')} wires it up in one command.`);
  console.log(`  Want to see it first?  ${c.cyan('https://agentmash.dev/how')} plays a made-up team.  ${c.dim('(--help for everything else)')}\n`);
}

// ── commands ───────────────────────────────────────────────────────────────

async function cmdInit(args) {
  const repo = targetRepo(args);
  assertSettingsUsable(repo);
  const server = (args.server || DEFAULT_SERVER).replace(/\/+$/, '');

  const existing = readConfig(repo);
  if (existing?.room && !args.force) {
    console.log(`\n${c.yellow('This repo is already connected.')}`);
    info(`room ${c.cyan(existing.room)} on ${existing.url}`);
    info(`dashboard ${c.cyan(await dashboardLink(existing))}`);
    // Running init again is how an install catches up with this version: the
    // hook scripts, the MCP server beside them, their entries in settings.json
    // (a wider matcher, an entry the folder's old name left behind) and our
    // entry in .mcp.json become this version's, and so does our own git
    // post-commit hook, which no pull brings (refreshGitHook). The room and
    // config.json stay exactly as they are.
    const scripts = copyHooks(repo);
    const events = mergeSettings(repo);
    const mcp = upgradeMcpEntry(repo);
    const shim = refreshGitHook(repo);
    if (shim) ok(`git post-commit hook brought up to date  ${c.dim('in .git/hooks, on this machine only')}`);
    if (scripts || events || mcp) {
      ok(
        `hooks brought up to date  ${c.dim(
          `${scripts} script(s), ${events} settings.json event(s)${mcp ? ', the server entry in .mcp.json' : ''}`
        )}`
      );
      const plain = mcp ? '.claude .mcp.json' : '.claude';
      const add = stageCommand(repo, installPaths(repo), `git add ${plain}`);
      info(
        add.startsWith('git add -f')
          ? `commit them by name, with -f, so your teammates get them with their next pull: ${c.bold(add)}`
          : `commit ${c.bold(plain)} so your teammates get them with their next pull`
      );
    } else if (!shim) {
      ok('hooks already up to date');
    }
    // up to date here, and still never committed if git ignores it
    const ignored = ignoredByGit(repo, installPaths(repo));
    if (ignored.length) sayIgnored(ignored);
    console.log(`\n  Re-run with ${c.bold('--force')} to create a new room, or use ${c.bold('agentmash join <id>')}.\n`);
    return;
  }

  // A machine signed in to this server finds its room by the repository. One
  // connected on the website has a room already, and whoever can push to it
  // reports there: making another here is how a repository ends up with two.
  // Every GitHub repository this checkout has a remote for is asked about: in
  // a fork, origin is the developer's and upstream the team's.
  const login = readUserLogin();
  const signedIn = login && sameServer(login.url, server) ? login : null;
  const remotes = signedIn ? await checkoutRemotes(repo) : [];
  const slugs = githubReposOf(remotes);
  // asked with --force too: which of them GitHub lists as a fork is what
  // says whether the room can open by sign-in (signInRoom)
  const found = await Promise.all(
    slugs.map((slug) => api('GET', `${server}/api/lookup?repo=${encodeURIComponent(slug)}`, { user: signedIn.token }))
  );
  if (slugs.length && !args.force) {
    const at = found.findIndex((res) => res.ok && res.json?.room_ref);
    if (at !== -1) {
      const slug = slugs[at];
      console.log(`\n${c.yellow(`${slug} is already connected`)}  ${c.dim(`→ ${server}/r/${found[at].json.room_ref}`)}`);
      info('everyone signed in who can push to it reports there already: there is no room to make');
      info(`a room committed to the repository all the same: ${c.bold('--force')}, then ${c.bold(`${connectCommand(remotes)} --replace`)}\n`);
      return;
    }
    // A sign-in whose push access has gone stale cannot see whether the
    // repository has a room, and a room made on that guess is a second one.
    if (found.some(isReauth)) {
      die(
        `${REAUTH_PAUSED}, then init again\n` +
          `        (whether ${slugs.join(' or ')} has a room already is what it cannot tell until then; --force makes one regardless)`
      );
    }
  }

  // the key init commits is anyone's in a public repository (guardPublicKey)
  const publicKey = await guardPublicKey(repo, args, server, 'init');
  // and anyone's who can read the repository at all: a read-only
  // collaborator, a fork, a CI log. So the room asks for a sign-in
  // (signInRoom), and the machine that makes it signs in first: it is the
  // sign-in that connects the room to the repository below, which a room
  // has to be before it can ask (askSignIn).
  const only = onlyRepoOf(remotes);
  const fork = only && found[slugs.indexOf(only)]?.json?.fork === true ? only : null;
  const signIn = await signInRoom(server, args, { publicKey, slugs: signedIn ? slugs : githubReposOf(await checkoutRemotes(repo)), fork });
  if (signIn && !signedIn) {
    die(
      `a room init makes opens to its key only beside the sign-in of someone who can push to the repository, so a copy\n` +
        `        of the key (a fork, a CI log, a read-only collaborator) opens nothing. sign this machine in first, then init again:\n\n` +
        `          npx agentmash login${server === DEFAULT_SERVER ? '' : ` --server ${server}`}\n\n` +
        `        a room its key alone opens, as rooms made before this did: npx agentmash init --key-only`
    );
  }

  const label = args.label || path.basename(repo);
  console.log(`\ncreating a room on ${c.dim(server)} …`);
  const res = await api('POST', `${server}/rooms`, { body: { label, ...(publicKey ? { allow_public_key: true } : {}) } });
  if (!res.ok) {
    if (res.status === 0) {
      die(
        `could not reach ${server}\n        ${c.dim(res.text)}\n\n` +
          `        Is the address right, and the server up? Another server: --server <url>.\n` +
          `        Running your own: https://agentmash.dev/docs/self-host`
      );
    }
    die(`server refused to create a room (HTTP ${res.status}) ${res.json?.error ?? ''}`);
  }

  const config = { url: res.json.server_url || server, room: res.json.room, label };
  // Older servers don't have refs; the field is simply absent then.
  if (res.json.room_ref) config.room_ref = res.json.room_ref;
  const budget = await measuredBudget(config.url);
  if (budget) config.timeout_ms = budget;
  const result = wire(repo, config, { gitHook: !args.noGitHook, forceHooksPath: args.forceHooksPath });
  // born one room: the repository opens the room it now carries, on the website too
  const connected = slugs.length && sameServer(signedIn.url, config.url) ? await connectNewRoom(config, remotes, signedIn) : false;
  // and only then does it ask for a sign-in beside its key: a room connected
  // to no repository opens to nobody's sign-in, so asking first would leave
  // it opening to nobody at all. A server from before rooms asked for a
  // sign-in says nothing of it when it makes one (sign_in_required).
  const asks = signIn && typeof res.json.sign_in_required === 'boolean';
  const gated = asks && connected ? await askSignIn(config, signedIn) : false;
  const dashboard = await dashboardLink(config, { repo: connected ? onlyRepoOf(remotes) : null });
  printJoined(repo, config, result, { signIn: gated, dashboard });
  if (signIn && !asks) info(`${server} does not ask for a sign-in beside a room's key yet: this room opens to its key alone\n`);
  else if (signIn && !gated) {
    // never a room that opens to nobody: one not connected yet opens to its key, as rooms made before this did
    warn(
      connected
        ? `this room opens to its key alone, to anyone who holds it, until it asks for a sign-in beside it: ${c.bold('npx agentmash secure sign-in')}\n`
        : 'this room opens to its key alone, to anyone who holds it, until it is connected and asks for a sign-in beside it: ' +
            `${c.bold(connectCommand(remotes))}, then ${c.bold('npx agentmash secure sign-in')}\n`
    );
  }
  if (budget) {
    info(`this server is ${budget}ms away, so the advisory budget was set to match`);
  }
  if (openInBrowser(dashboard, args)) info('opened the dashboard in your browser (--no-open to skip)\n');
}

/**
 * A room's dashboard link. By its ref, which a browser signed in with GitHub
 * opens for the pushers of the repository the room is connected to, so no
 * room key rides in a URL, where browser history, a screen share or a
 * proxy's log keeps it. By the key where a sign-in could not open the ref: a
 * server too old to give rooms refs, one that signs nobody in
 * (serverSignsIn), or a room connected to no repository, which a ref opens
 * for nobody until they paste its key on /rooms, and one that asks for a
 * sign-in, not even then. `repo`: the repository the room is connected to,
 * or null, when the caller knows; asked of the server (/rooms/self) when not.
 */
async function dashboardLink(config, { repo } = {}) {
  const { url, room, room_ref: ref } = config;
  if (!ref || !(await serverSignsIn(url))) return `${url}/r/${room}`;
  const connected = repo !== undefined ? repo : await connectedRepoOf(config);
  return connected ? `${url}/r/${ref}` : `${url}/r/${room}`;
}

/**
 * The repository a room is connected to, or null: /rooms/self's `repo`, which
 * a key turned away for want of a sign-in beside it names too. Asked briefly,
 * as serverSignsIn is: a bare `npx agentmash` asks it for its one line.
 */
async function connectedRepoOf({ url, room }) {
  const res = await api('GET', `${url}/rooms/self`, { room, timeoutMs: 3000 });
  return typeof res.json?.repo === 'string' ? res.json.repo : null;
}

/**
 * Whether a room key may be committed to this checkout's repository, as
 * `init` and `join` do beside the hooks, and `rotate` writes its new one to
 * be. Not to a public GitHub repository: everyone who reads it would hold
 * the key, and with it the room. So GitHub is asked about every GitHub
 * remote (visibility.mjs; a key goes wherever it is pushed), and about every
 * one through an SSH host alias named for GitHub (git@github-work:…, which
 * is GitHub's as often as not), and a public one stops the command, pointing
 * at a room that opens by GitHub sign-in instead, unless --allow-public-key
 * says commit it all the same. A checkout with no remote that is GitHub's,
 * or a GitHub that does not answer, cannot be judged: the command goes ahead
 * and says so in a line. Returns whether the key goes to a public repository
 * on purpose, which a room is told when it is made (allow_public_key), so its
 * key keeps opening it.
 */
async function guardPublicKey(repo, args, server, verb) {
  const remotes = await checkoutRemotes(repo);
  const slugs = [...new Set([...githubReposOf(remotes), ...remotes.filter((r) => r.githubAlias).map((r) => r.repo)])];
  if (!slugs.length) {
    warn(
      remotes.length
        ? "no remote of this checkout is GitHub's for sure (another host, or an SSH host alias whose name does not say GitHub), " +
            'so whether it is public cannot be told: if it is, whoever reads it holds the room key'
        : 'this checkout has no GitHub remote, so whether it is public cannot be told: if it is, whoever reads it holds the room key'
    );
    return false;
  }
  const seen = await checkVisibility(slugs);
  for (const { slug, why } of seen.unknown) {
    warn(`could not ask GitHub whether ${slug} is public (${why}): if it is, whoever reads it holds the room key`);
  }
  if (!seen.public.length) return false;
  const named = `${seen.public.join(' and ')} ${seen.public.length > 1 ? 'are' : 'is'} public on GitHub`;
  if (!args.allowPublicKey) {
    die(
      `${named}, so ${verb} will not commit a room key to it: anyone who reads the repository could read the room and write to it.\n\n` +
        `        Sign in and connect the repository on the website instead. Only people who can push to it get in,\n` +
        `        and nothing is committed:\n\n` +
        `          npx agentmash login\n` +
        `          ${server}/install\n\n` +
        `        To commit the key all the same, opening the room to anyone who reads the repository:\n` +
        `          npx agentmash ${verb === 'join' ? 'join <room>' : verb} --allow-public-key`
    );
  }
  warn(`${named}, and --allow-public-key commits the room key to it all the same.`);
  info(`anyone who reads it holds the key, and ${KEY_OPENS}`);
  return true;
}

/**
 * Whether the room init makes asks for a sign-in (the server's
 * sign_in_required): its key opens it only beside the sign-in of someone who
 * can push to the repository, so a copy of the key in a fork, a CI log or a
 * read-only collaborator's clone opens nothing. Not when --key-only or
 * --allow-public-key says the key alone, as rooms made before this did; not
 * on a server that signs nobody in (serverSignsIn); and not where no sign-in
 * could open it: a checkout with no GitHub remote, or one whose only GitHub
 * repository is a fork, which the server connects to no room a key names.
 * Said in a line whenever the key alone is what opens it.
 */
async function signInRoom(server, args, { publicKey, slugs, fork }) {
  if (args.keyOnly || publicKey) return false;
  if (!(await serverSignsIn(server))) return false;
  if (!slugs.length) {
    info("this checkout has no GitHub remote, so nobody's sign-in can open the room by it: its key alone opens it");
    return false;
  }
  if (fork) {
    info(`${fork} is a fork on GitHub, and the server connects no fork to a room a key names: this room's key alone opens it`);
    return false;
  }
  return true;
}

// server -> whether it signs people in with GitHub, asked once a command
const signsIn = new Map();

/**
 * Whether `server` signs people in with GitHub (its /api/config's oauth),
 * which every room that opens by sign-in needs. A server that does not
 * answer, or answers something else, is taken to sign nobody in. Asked
 * briefly: a bare `npx agentmash` asks it for its one line.
 */
async function serverSignsIn(server) {
  if (!signsIn.has(server)) {
    const res = await api('GET', `${server}/api/config`, { timeoutMs: 3000 });
    signsIn.set(server, res.ok && res.json?.oauth === true);
  }
  return signsIn.get(server);
}

/**
 * After init on a signed-in machine: connect the repository to the room just
 * made, as `npx agentmash connect` would, so login and the website open the
 * room its checkouts report to from the start. Only when this checkout's
 * remotes all name one GitHub repository: with more, which is the team's is
 * for whoever runs connect to say. Whatever stops it is said in a line, never
 * a failed init: the room is made and wired either way. Whether it connected.
 */
async function connectNewRoom(config, remotes, login) {
  const slug = onlyRepoOf(remotes);
  if (!slug) {
    info(
      `this checkout has remotes for ${repoNamesOf(remotes).join(' and ')}: to connect this room on the website, ` +
        `name your team's repository: ${c.bold('npx agentmash connect <owner/name>')}\n`
    );
    return false;
  }
  const res = await api('POST', `${config.url}/api/connect/room`, {
    room: config.room,
    user: login.token,
    body: { repo: slug },
  });
  if (res.ok) {
    ok(`${slug} → ${res.json.dashboard_url}  ${c.dim('connected on the website too: login and the website open this room')}`);
  } else if (res.json?.code === 'repo_taken') {
    warn(`${slug} is connected on the website to another room, which has history of its own  ${c.dim(`${config.url}/r/${res.json.connected_ref}`)}`);
    info(`to make this one the room for both: ${c.bold('npx agentmash connect --replace')}`);
  } else if (res.json?.code === 'fork') {
    // the server connects no fork to the room a key names, this one included:
    // offering connect would only send them to the same refusal
    info(`${slug} is a fork on GitHub, so this room is not connected on the website: its checkouts report to it by the key in config.json`);
  } else if (res.json?.code === 'reauth') {
    // What this machine can push to is what GitHub said when it signed in,
    // and connecting needs that recent: connect asks GitHub again itself.
    info(`not connected on the website yet: run ${c.bold('npx agentmash connect')}, which has GitHub say again that you can push to ${slug}`);
  } else if (planRefusal(res)) {
    // The plan's own words say what it covers and where to upgrade. Its code
    // alone said "(repo_limit)", beside a connect that is refused the same way.
    warn(`not connected on the website: ${planRefusal(res)}`);
    info('this checkout reports to the new room by the key in .claude/agentmash/config.json all the same');
  } else {
    const why = res.json?.error || (res.status ? `HTTP ${res.status}` : res.text);
    info(`not connected on the website yet ${c.dim(`(${why})`)}: ${c.bold('npx agentmash connect')} does it`);
  }
  console.log('');
  return res.ok;
}

/**
 * After init connected its new room: have the room's key open it only beside
 * the sign-in of someone who can push to the repository (signInRoom), as
 * `npx agentmash secure sign-in` does, with this machine's sign-in beside the
 * key. The server takes that only for a connected room and a pusher's
 * sign-in, so it shuts out neither the room nor whoever asked. Whether the
 * room asks now; what stopped it, if anything, is said in a line, and init
 * says what to run.
 */
async function askSignIn(config, login) {
  const res = await api('POST', `${config.url}/rooms/settings`, {
    room: config.room,
    user: login.token,
    body: { sign_in_required: true },
  });
  if (res.ok && res.json?.sign_in_required === true) return true;
  const why = res.json?.error || (res.status ? `HTTP ${res.status}` : res.text);
  info(`the room did not ask for a sign-in beside its key ${c.dim(`(${why})`)}`);
  return false;
}

/**
 * The derivation lives in hooks/lib.mjs next to the constants it is derived
 * from, so that changing one cannot quietly leave the other behind. Loaded from
 * whichever copy of the hooks this invocation would install.
 *
 * Returns null rather than dying if the hooks cannot be loaded: `doctor` is the
 * command you run when the install is broken, and it has better things to say
 * about that than a stack trace about a timeout formula.
 */
async function budgetMath() {
  return hooksLib();
}

/** The hooks' own lib.mjs, from the copy this invocation would install; null when it will not load. */
async function hooksLib() {
  try {
    return await import(pathToFileURL(path.join(hookSourceDir(), 'lib.mjs')).href);
  } catch {
    return null;
  }
}

/**
 * Size the advisory timeout to the network actually in front of us. Each hook
 * is a fresh process paying TCP + TLS setup, so a distant server needs a
 * bigger budget than a local one or its warnings never arrive.
 */
async function measuredBudget(url) {
  await api('GET', `${url}/healthz`); // warm: ignore idle wake-up cost
  const probe = await api('GET', `${url}/healthz`);
  if (!probe.ok) return null;
  const math = await budgetMath();
  if (!math) return null;
  const budget = math.budgetForRoundTrip(probe.ms);
  return budget > 1500 ? budget : null; // the default is already comfortable
}

async function cmdJoin(args) {
  const target = args._[0];
  if (!target) die('usage: agentmash join <room-id | dashboard-url>');
  const repo = targetRepo(args);
  assertSettingsUsable(repo);

  // Accept a bare room id or a full dashboard URL.
  let room = target;
  let server = args.server || DEFAULT_SERVER;
  const asUrl = target.match(/^(https?:\/\/[^/]+)\/r\/(mash_[A-Za-z0-9_-]+)/);
  if (asUrl) {
    server = asUrl[1];
    room = asUrl[2];
  }
  server = server.replace(/\/+$/, '');
  // A room's ref is what status, login and the dashboard's address bar show,
  // so it is what gets pasted here. It names the room and opens nothing, and
  // "does not look like a room id" sent people looking for another id.
  const ref = target.match(/(?:^|\/r\/)(rm_[A-Za-z0-9_-]+)/)?.[1];
  if (ref) {
    die(
      `${ref} is the room's ref, not its key: it names the room, and join takes the key (mash_…).\n` +
        `        if the room is connected to this repository on the website: npx agentmash login, and nothing is committed\n` +
        `        if its key is committed to this repository: pull, and .claude/agentmash/config.json has it\n` +
        `        otherwise ask whoever set the room up for its key`
    );
  }
  if (!/^mash_[A-Za-z0-9_-]{16,64}$/.test(room)) die(`"${target}" does not look like a room id`);

  const res = await lookupRoom(server, room);
  if (res.status === 404) {
    die(
      res.json?.deleted
        ? `that room was deleted on ${server}`
        : res.json?.rotated
          ? `that room key has been rotated or revoked on ${server} — ask for the current one`
          : `room ${room} does not exist on ${server}`
    );
  }
  if (!res.ok && res.status === 0) die(`could not reach ${server}\n        ${c.dim(res.text)}`);
  // join commits the key beside the hooks, as init does
  await guardPublicKey(repo, args, server, 'join');

  const config = { url: server, room, label: res.json?.label ?? null };
  if (res.json?.room_ref) config.room_ref = res.json.room_ref;
  // what the server said of the room names the repository it is connected to, if any
  const dashboard = await dashboardLink(config, { repo: res.json?.repo ?? null });
  printJoined(
    repo,
    config,
    wire(repo, config, { gitHook: !args.noGitHook, forceHooksPath: args.forceHooksPath }),
    // a room that asks for a sign-in beside its key: said, or turned this machine's key away for it
    { signIn: res.json?.sign_in_required === true || res.json?.code === 'sign_in_required', dashboard }
  );
  if (openInBrowser(dashboard, args)) info('opened the dashboard in your browser (--no-open to skip)\n');
}

function identity(repo) {
  if (process.env.AGENTMASH_DEV) return { who: process.env.AGENTMASH_DEV, from: 'AGENTMASH_DEV' };
  try {
    const email = execFileSync('git', ['config', 'user.email'], {
      cwd: repo,
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (email) return { who: email, from: 'git config user.email' };
  } catch {
    /* fall through */
  }
  return { who: os.userInfo?.().username ?? 'unknown', from: 'OS username (fallback)' };
}

/**
 * Expand `${VAR}` and `${VAR:-default}` the way Claude Code expands them in
 * .mcp.json. An unset variable with no default is left in the string verbatim —
 * that is the documented behaviour, and it is how a registration turns into a
 * server that never starts.
 */
function expandMcpValue(value, env) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name, fallback) => {
    const set = env[name];
    // Shell semantics, which is what the syntax borrows: `${VAR}` expands to
    // whatever VAR holds and is left verbatim when it is unset, while `:-`
    // falls back for unset *and* empty.
    if (fallback === undefined) return set === undefined ? whole : set;
    return set === undefined || set === '' ? fallback : set;
  });
}

/**
 * The command Claude Code will actually run for our server, read out of
 * .mcp.json and expanded the way Claude Code expands it.
 *
 * CLAUDE_PROJECT_DIR is deliberately removed before expanding: Claude Code sets
 * it in the spawned server's environment, not in its own, so at expansion time
 * it is unset and an older entry's `${CLAUDE_PROJECT_DIR:-.}` resolves through
 * its default. A doctor that expanded with the variable set would prove a path
 * no teammate takes. Returns null when nothing is registered under our name.
 */
function mcpLaunchCommand(repo) {
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(mcpJsonPath(repo), 'utf8'))?.mcpServers?.[MCP_SERVER_NAME];
  } catch {
    return null;
  }
  if (!entry || typeof entry.command !== 'string') return null;
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  return {
    command: expandMcpValue(entry.command, env),
    args: (Array.isArray(entry.args) ? entry.args : []).map((arg) => expandMcpValue(arg, env)),
  };
}

/**
 * Start the MCP server exactly as Claude Code starts it — the command and args
 * out of .mcp.json, expanded, spawned with no shell in `cwd`, the folder a
 * session started in, with that folder as CLAUDE_PROJECT_DIR in the child's
 * environment — and ask it for its tools.
 *
 * Hand-rolled rather than using the MCP SDK, because the CLI has no
 * dependencies to use one from, and three messages of newline-delimited JSON
 * are all it takes.
 */
function probeMcpServer(cwd, launch, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    let serverInfo = null;
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve({ ...result, ms: Date.now() - started, stderr: stderr.trim() });
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: `no answer within ${timeoutMs}ms` }),
      timeoutMs
    );
    const send = (payload) => {
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
      } catch {
        /* the exit handler reports it */
      }
    };

    child.on('error', (err) => finish({ ok: false, error: String(err?.message || err) }));
    child.on('exit', (code) => finish({ ok: false, error: `exited ${code} without answering` }));
    // EPIPE, from a server that died before it read: the exit handler says so
    child.stdin.on('error', () => {});
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1 && message.result) {
          serverInfo = message.result.serverInfo ?? {};
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2 && message.result) {
          finish({
            ok: true,
            // The launcher's fallback server answers, but only to say it cannot.
            degraded: String(serverInfo?.version ?? '').endsWith('-unavailable'),
            tools: message.result.tools ?? [],
            serverInfo,
          });
        } else if (message.error) {
          finish({ ok: false, error: message.error.message ?? 'JSON-RPC error' });
        }
      }
    });

    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'agentmash-doctor', version: '0.2.0' },
      },
    });
  });
}

/**
 * Whether the walk up in .mcp.json (MCP_BOOTSTRAP) ends at `dir` instead of
 * going on above it: `dir` has a launcher of its own, which the walk starts,
 * or a .mcp.json that registers the server, or a .git folder, a repository's
 * own root, where it stops.
 */
function walkStopsAt(dir) {
  if (fs.existsSync(path.join(dir, '.claude', 'agentmash', MCP_LAUNCHER))) return true;
  try {
    if (fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8').includes('mcp_launcher')) return true;
  } catch {
    // no .mcp.json there
  }
  try {
    return fs.statSync(path.join(dir, '.git')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A folder a session might start in, below the repository's root, from which
 * the walk up reaches this install's launcher: its first folder that is not
 * hidden, not node_modules and not one the walk stops at by design, else
 * .claude, which init made. A clone kept inside the repository has a .git
 * folder of its own, and a session started there is that clone's business,
 * so a start from it that fails says nothing about this install. A name
 * relative to the root.
 */
function sessionSubfolder(repo) {
  try {
    const found = fs
      .readdirSync(repo, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort()
      .find((name) => !walkStopsAt(path.join(repo, name)));
    if (found) return found;
  } catch {
    // an unreadable root: .claude is there if anything is
  }
  return '.claude';
}

/** The command as it runs, each argument clipped: the walk-up script in .mcp.json is a paragraph. */
function shownCommand(launch) {
  return [launch.command, ...launch.args]
    .map((arg) => (arg.length > 72 ? `${arg.slice(0, 69)}...` : arg))
    .map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))
    .join(' ');
}

/** The version stamped into a copy of the MCP server (`// agentmash:version`); null when there is none to read. */
function serverVersionOf(file) {
  try {
    return fs.readFileSync(file, 'utf8').match(/^export const VERSION = '([^']*)'; \/\/ agentmash:version/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Whether version `a` comes before `b`, by major, minor and patch. Anything unreadable is not older. */
function olderVersion(a, b) {
  const parts = (v) => String(v).split(/[.-]/).slice(0, 3).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/**
 * Run the MCP server on stdio: the same server init commits beside the hooks,
 * from the copy this invocation would install. The launcher's layer 2 reaches
 * it through npx, on a machine that opted into that.
 */
async function cmdMcp() {
  const module = await import(pathToFileURL(path.join(hookSourceDir(), 'mcp_server.mjs')).href);
  await module.start();
}

const DAY_MS = 24 * 60 * 60_000;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const andList = (items, and = 'and') => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${and} ${items.at(-1)}`);

/**
 * Our hook entries in this repo's settings that cannot do their job. One whose
 * script is not there (the folder's old name, a half-finished uninstall) fails
 * on every tool call it matches, and an async one says so nowhere. One from an
 * older install leaves tools this version follows unwatched. `init` fixes both.
 */
function brokenHookEntries(repo) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath(repo), 'utf8'));
  } catch {
    return { missing: [], outdated: [] }; // the registration check has said so already
  }
  const missing = new Map();
  const outdated = [];
  for (const [event, groups] of Object.entries(settings?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups.filter(hasOurHook)) {
      let gone = false;
      for (const part of group.hooks.filter(isOurHook).flatMap(hookParts)) {
        const script = part.match(/\.claude[\\/]agent(?:mash|mesh)[\\/][^\s"'\\/]+/)?.[0];
        if (script && !fs.existsSync(path.join(repo, script))) {
          const shown = script.replace(/\\/g, '/');
          missing.set(`${event} ${shown}`, { event, script: shown });
          gone = true;
        }
      }
      // A group whose script is gone has said all there is to say. No
      // matcher, or "*", matches every tool: nothing is left out.
      if (gone) continue;
      const want = HOOK_ENTRIES[event]?.matcher;
      if (!want || typeof group.matcher !== 'string' || !/^[A-Za-z0-9_|]+$/.test(group.matcher)) continue;
      const lacking = want.split('|').filter((tool) => !group.matcher.split('|').includes(tool));
      if (lacking.length) outdated.push({ event, matcher: group.matcher, lacking });
    }
  }
  return { missing: [...missing.values()], outdated };
}

/**
 * What doctor says about a Claude Code session started in a subfolder of
 * this repository (`cd web && claude`), or null when one reports as a session
 * at the root does. Claude Code reads a repository's hooks only from the
 * folder a session starts in, so the committed ones do not run there, though
 * the MCP server does (its entry walks up). This machine's own hooks, from
 * `npx agentmash login`, report from such a session, to the room the
 * repository carries, once they are a version that knows to (installAbove in
 * hooks/lib.mjs).
 */
function subfolderSessions() {
  if (machineHookEntries().length === 0) {
    return (
      'a Claude Code session started in a subfolder of this repository runs none of its hooks, so it reports nothing\n' +
      `      Start Claude Code at the repository root, or run ${c.bold('npx agentmash login')}: its hooks report from any folder.`
    );
  }
  let lib = '';
  try {
    lib = fs.readFileSync(path.join(machineHookDir(), 'lib.mjs'), 'utf8');
  } catch {
    // no copy to read: login puts one there
  }
  if (/\bfunction installAbove\(/.test(lib)) return null;
  return (
    "this machine's hooks are from before they reported a session started in a subfolder of a repository, so one reports nothing\n" +
    `      Run ${c.bold('npx agentmash login')} again to bring them up to date, or start Claude Code at the repository root.`
  );
}

/** "just now", "12 min ago", "3 h ago", "2 days ago" */
function agoText(at) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / (24 * 60))} days ago`;
}

/**
 * What a report that failed this way means, and what to do about it, in one
 * line. `budgetMs` is the timeout_ms the hooks run with here, if any, and
 * `lib` the hooks' own, for the deadline no timeout_ms goes past.
 */
function reportFix(f, { repoInstall, budgetMs = 0, lib = null }) {
  if (f.outcome === 'refused') {
    switch (f.code) {
      case 'token_required':
      case 'token_unverified':
        return repoInstall
          ? 'this room wants a developer token from this machine: npx agentmash login --room'
          : 'this machine has to sign in again: npx agentmash login';
      case 'room_unauthorized':
        return repoInstall
          ? 'the room key in .claude/agentmash/config.json is unknown here or was rotated away: pull the repo for the current one'
          : 'this machine\'s sign-in is not accepted any more: npx agentmash login';
      case 'reauth':
        return 'GitHub has to say again what this machine can push to: npx agentmash login';
      case 'room_key_public':
        return (
          'the room key is in a repository that is public on GitHub, so it opens the room only beside the sign-in ' +
          `of someone who can push there: ${signInFixFor(f.url)} (hooks committed before this version need npx agentmash init again, committed)`
        );
      case 'sign_in_required':
        return `this room opens to its key only beside the sign-in of someone who can push to its repository: ${signInFixFor(f.url)}`;
      case 'room_deleted':
        return 'the room was deleted: connect the repo to a new one with npx agentmash init --force';
      case 'file_path_not_relative':
        return 'an older hook sent a path from outside the repository: update the hooks with npx agentmash init';
      // where to upgrade is the server's to say, and the hooks log what it said:
      // an address built here would be one the server may not serve
      case 'seat_limit':
        return `the team's plan has no seat left for this developer this period: ${f.upgrade_url || 'upgrade it'}`;
      default:
        return f.status >= 500
          ? 'the server failed on its side; if it keeps happening, tell whoever runs it'
          : `the server turned them away (HTTP ${f.status})`;
    }
  }
  if (f.outcome === 'cut_off' || f.error === 'timeout') {
    // Claude Code stops a hook at its `timeout: 5`, so the hooks end
    // themselves just before: past that, a bigger timeout_ms changes nothing
    const deadline = lib?.HOOK_DEADLINE_MS ?? 4500;
    if (budgetMs >= (lib?.MAX_REPORT_BUDGET_MS ?? deadline - 500)) {
      return (
        `the server did not answer within the ${deadline / 1000} s a hook has before Claude Code stops it, ` +
        `which is as long as any timeout_ms can make it: the network to ${f.url || 'it'}, or the server, is too slow from here`
      );
    }
    return repoInstall
      ? 'the server did not answer in time: on a slow network, raise "timeout_ms" in .claude/agentmash/config.json'
      : 'the server did not answer in time: on a slow network, set AGENTMASH_TIMEOUT_MS higher';
  }
  return `the server could not be reached: check ${f.url || 'it'} is up and this machine can get to it`;
}

/**
 * The reports that never reached the room from this checkout in the last
 * week, one line per cause, with what to do. The hooks run in the background,
 * so this log is the only place those failures were ever written down.
 * Returns how many problems that makes: a warning, but for a plan that
 * turned reports away in the last day.
 */
async function doctorReports(repo, { repoInstall, budgetMs }) {
  const lib = await hooksLib();
  const failures = lib?.readReportFailures?.({ sinceMs: Date.now() - 7 * DAY_MS, repo }) ?? [];
  if (failures.length === 0) return 0;
  const groups = new Map();
  for (const f of failures) {
    const label =
      f.outcome === 'refused'
        ? `refused (${[f.status, f.code].filter(Boolean).join(' ')})`
        : f.outcome === 'cut_off'
          ? 'cut off'
          : `no reply (${f.error || 'unknown'})`;
    const group = groups.get(label) ?? { label, count: 0, last: f };
    group.count += 1;
    if (Date.parse(f.at) >= Date.parse(group.last.at)) group.last = f;
    groups.set(label, group);
  }
  warn(
    `${plural(failures.length, 'report')} from this machine never reached the room in the last 7 days\n` +
      '      (the hooks run in the background, so nothing said so at the time):'
  );
  for (const g of [...groups.values()].sort((a, b) => Date.parse(b.last.at) - Date.parse(a.last.at))) {
    console.log(`      ${g.count}× ${g.label}, last ${agoText(g.last.at)} — ${reportFix(g.last, { repoInstall, budgetMs, lib })}`);
  }
  info(`the log: ${c.dim(lib.reportLogPath())}`);
  // A plan with no seat for this developer turns away every report, and only
  // the reports: the room, the key and the server all check out, so this is
  // the one place doctor sees the edits are not being shared. Turned away in
  // the last day, that is now, not what happened once.
  const unpaid = failures.filter((f) => f.outcome === 'refused' && f.status === 402 && Date.parse(f.at) >= Date.now() - DAY_MS);
  if (unpaid.length === 0) return 0;
  const last = unpaid.at(-1);
  bad(`reports from this machine are being turned away: ${reportFix(last, { repoInstall })}  ${c.dim(`(last ${agoText(last.at)})`)}`);
  return 1;
}

/** One line when reports from this machine have failed lately: otherwise a quiet board looks like a quiet team. */
async function warnFailedReports(repo) {
  const lib = await hooksLib();
  const failures = lib?.readReportFailures?.({ sinceMs: Date.now() - DAY_MS, repo }) ?? [];
  if (failures.length === 0) return false;
  warn(
    `${plural(failures.length, 'report')} from this machine never reached the room in the last 24 hours — ` +
      `${c.bold('npx agentmash doctor')} says why`
  );
  return true;
}

async function cmdDoctor(args) {
  const repo = args.repo ? path.resolve(args.repo) : findRepoRoot() || process.cwd();
  console.log(`\n${c.bold('AgentMash doctor')}  ${c.dim(repo)}\n`);
  let problems = 0;

  // 18.12, the first of 18's long-term releases, is the floor the package's
  // engines and every page that names one say
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major >= 20) ok(`node ${process.versions.node}`);
  else if (major > 18 || (major === 18 && minor >= 12)) warn(`node ${process.versions.node} — works, but 20+ recommended`);
  else {
    bad(`node ${process.versions.node} — too old; agentmash needs Node.js 18.12 or newer`);
    problems++;
  }

  // A checkout with no room of its own, on a machine signed in with `npx
  // agentmash login`, is reported by the hooks in Claude Code's own settings:
  // the files a room-key install puts in a repository are not missing here.
  const conn = connection(repo);
  if (!conn.url || !conn.room) {
    const login = readUserLogin();
    if (login || machineHookEntries().length) return doctorMachine(repo, { login, problems });
  }

  if (findRepoRoot(repo)) ok('inside a git repository');
  else {
    warn('not a git repository — identity falls back to your OS username');
  }

  const installed = HOOK_FILES.filter((f) => fs.existsSync(path.join(meshDir(repo), f)));
  if (installed.length === HOOK_FILES.length) ok(`hook scripts present (${installed.length})`);
  else {
    bad(`hook scripts missing from .claude/agentmash (${installed.length}/${HOOK_FILES.length}) — run: agentmash init`);
    problems++;
  }
  if (committedHooksPredatePrompts(repo)) warn(STALE_HOOKS);

  let registered = 0;
  // a file that is there and does not read, said as init says it, since init
  // will not write to it either: not "no hooks registered", with init to fix it
  let unreadable = null;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath(repo), 'utf8'));
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      unreadable = 'must contain a JSON object at the top level';
    }
    for (const event of Object.keys(HOOK_ENTRIES)) {
      if (JSON.stringify(settings?.hooks?.[event] ?? []).includes('.claude/agentmash/')) registered++;
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') unreadable = 'is not valid JSON';
  }
  const eventCount = Object.keys(HOOK_ENTRIES).length;
  if (unreadable) {
    bad(`.claude/settings.json ${unreadable}, so Claude Code runs none of its hooks — fix or move it, then run: agentmash init`);
    problems++;
  } else if (registered === eventCount) {
    ok(`hooks registered in .claude/settings.json (${eventCount} events)`);
    // this machine's node is checked above; a teammate's is theirs to have
    info('teammates need Node.js 18.12 or newer on their PATH too: these hooks and the MCP server run on it');
    const below = subfolderSessions();
    if (below) warn(below);
  } else {
    bad(`only ${registered}/${eventCount} hook events registered in settings.json — run: agentmash init`);
    problems++;
  }

  const broken = brokenHookEntries(repo);
  for (const { event, script } of broken.missing) {
    bad(`${event} runs ${script}, which does not exist — every call to it fails — run: agentmash init`);
    problems++;
  }
  for (const { event, matcher, lacking } of broken.outdated) {
    warn(
      `${event} is registered for ${matcher}, from an older install: ${andList(lacking)} ` +
        `${lacking.length === 1 ? 'goes' : 'go'} unwatched — run: agentmash init`
    );
  }

  const launcher = path.join(meshDir(repo), MCP_LAUNCHER);
  const serverMissing = MCP_SERVER_FILES.filter((f) => !fs.existsSync(path.join(meshDir(repo), f)));
  const committed = serverVersionOf(path.join(meshDir(repo), MCP_SERVER_FILES[0]));
  if (!fs.existsSync(launcher)) {
    bad(`${MCP_LAUNCHER} missing from .claude/agentmash — run: agentmash init`);
    problems++;
  } else if (serverMissing.length) {
    // Whether the launcher still finds a server elsewhere (this machine's
    // login, an AgentMash checkout) is for the start below to say.
    warn(
      `MCP launcher present, but not the server it starts: ${andList(serverMissing)} ` +
        `${serverMissing.length === 1 ? 'is' : 'are'} missing from .claude/agentmash — run: agentmash init`
    );
  } else {
    ok(`MCP launcher present, with its server  ${c.dim(`.claude/agentmash/${MCP_SERVER_FILES[0]} ${committed ?? ''}`)}`);
    if (committed && olderVersion(committed, version())) {
      warn(
        `the MCP server committed here is ${committed}, older than this CLI (${version()}), and says reconciliation is ` +
          `switched off whatever the room is set to — run: agentmash init, and commit .claude`
      );
    }
  }

  let mcpEntry;
  try {
    mcpEntry = JSON.parse(fs.readFileSync(mcpJsonPath(repo), 'utf8'))?.mcpServers?.[MCP_SERVER_NAME];
  } catch {
    /* reported below */
  }
  if (isCurrentMcpEntry(mcpEntry)) ok('MCP server registered in .mcp.json');
  else if (isOurMcpEntry(mcpEntry)) {
    // What that costs, starting it from a subfolder, is the start below's to show.
    warn('.mcp.json registers the MCP server the way an older version did — run: agentmash init');
  } else {
    bad('.mcp.json does not register the agentmash MCP server — run: agentmash init');
    problems++;
  }

  // Approval is a statement about this machine, not a fault in the install:
  // AgentMash no longer writes it, because whether to run a server a repo
  // brought with it belongs to whoever owns the machine.
  let approved = false;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath(repo), 'utf8'));
    approved =
      settings?.enableAllProjectMcpServers === true ||
      (Array.isArray(settings?.enabledMcpjsonServers) &&
        settings.enabledMcpjsonServers.includes(MCP_SERVER_NAME));
  } catch {
    /* the file may not exist yet; the hook checks above already said so */
  }
  // Said only where there is a server to approve: a repository whose .mcp.json
  // registers ours. Anywhere else Claude Code asks nobody anything.
  const registers = Boolean(findRepoRoot(repo)) && (isCurrentMcpEntry(mcpEntry) || isOurMcpEntry(mcpEntry));
  if (registers && approved)
    info(
      `this repo's settings already approve the MCP server  ${c.dim('enabledMcpjsonServers')}\n` +
        '      Claude Code honours that only once you have trusted this folder yourself.'
    );
  else if (registers)
    info(
      'Claude Code will ask you once to approve the agentmash MCP server in .mcp.json.\n' +
        '      Until you do, its tools are absent from your sessions — the hooks are unaffected.'
    );

  const launch = mcpLaunchCommand(repo);
  if (launch) {
    const shown = shownCommand(launch);
    // A cold `npx` fetch is the only thing here that can take tens of seconds,
    // and only a machine that opted into it pays that.
    const budget = process.env.AGENTMASH_MCP_NPX === '1' ? 30_000 : 10_000;
    const probe = await probeMcpServer(repo, launch, budget);
    // Claude Code starts the server in the folder a session started in, so it
    // has to start from below the root as well as from it.
    const sub = probe.ok && !probe.degraded ? sessionSubfolder(repo) : null;
    const deeper = sub ? await probeMcpServer(path.join(repo, sub), launch, budget) : null;
    if (deeper?.ok && !deeper.degraded) {
      ok(
        `the command in .mcp.json starts and answers tools/list  ${c.dim(
          `${probe.tools.length} tools · ${probe.serverInfo?.version ?? 'unversioned'} · ${probe.ms}ms`
        )}`
      );
      info(`and from ${sub}/ too, where a session started in a subfolder runs it`);
      info(c.dim(shown));
      if (probe.ms > 5000) info('a first run downloads the package; later starts are fast');
    } else if (deeper) {
      bad(
        `the command in .mcp.json starts from the root of the repository but not from ${sub}/  ` +
          `${c.dim(deeper.error ?? 'only as the stand-in that cannot answer')}\n` +
          `      ${c.dim(shown)}\n` +
          '      A session started in a subfolder gets no AgentMash tools at all — run: agentmash init'
      );
      problems++;
    } else if (probe.ok) {
      bad(
        'MCP server started in degraded mode — its tools answer "unavailable" instead of reporting\n' +
          `      who is working. ${c.dim(probe.stderr.split('\n').pop() || '')}\n` +
          '      Fix: run agentmash init here and commit .claude. The server is plain Node, committed\n' +
          '      beside the launcher, so every teammate has it after their next pull.'
      );
      problems++;
    } else {
      bad(
        `the command in .mcp.json did not start  ${c.dim(probe.error)}\n` +
          `      ${c.dim(shown)}\n` +
          '      That is the command Claude Code runs, expanded the way Claude Code expands it.\n' +
          '      While it fails, every session has no AgentMash tools at all — run: agentmash init'
      );
      problems++;
    }
  }

  const { config, url, room } = conn;
  if (config) ok(`config.json found  ${c.dim(`${config.url} · ${config.room}`)}`);
  else {
    bad('no .claude/agentmash/config.json — run: agentmash init (or join <id>)');
    problems++;
  }
  // present here and fine here, and missing from every teammate's checkout
  const ignored = ignoredByGit(repo, installPaths(repo));
  if (ignored.length) {
    sayIgnored(ignored, { say: bad });
    problems++;
  }
  if (process.env.AGENTMASH_URL) info(`AGENTMASH_URL env overrides config → ${process.env.AGENTMASH_URL}`);
  if (process.env.AGENTMASH_ROOM) info(`AGENTMASH_ROOM env overrides config → ${process.env.AGENTMASH_ROOM}`);
  if (process.env.AGENTMASH_DISABLE === '1') warn('AGENTMASH_DISABLE=1 — hooks are no-ops right now');
  if (process.env.AGENTMASH_STRICT === '1') info('AGENTMASH_STRICT=1 — conflicting edits will be blocked, not advised');
  if (process.env.AGENTMASH_WARN_SELF === '1') info('AGENTMASH_WARN_SELF=1 — your own sessions warn each other before an edit');

  // A warning, never a problem: the git client is optional, and .git/hooks is
  // not committed, so a teammate who only pulled will always be missing it.
  const hooksInfo = resolveHooksDir(repo);
  const gitHookFile = path.join(hooksInfo.dir, 'post-commit');
  const hookKind = pathKind(gitHookFile);
  if (isOurGitHook(gitHookFile)) {
    const chained = pathKind(chainedHookPath(repo)) === 'file' ? ' (chained after post-commit.local)' : '';
    ok(`git post-commit client installed${chained}  ${c.dim(path.relative(repo, gitHookFile))}`);
    // Installed is not the same as working: hooks run under a non-login shell
    // that never reads a profile, so a node from a version manager is not on
    // PATH when git is driven from a GUI client.
    const nodeCheck = workerCanRun(repo);
    if (!nodeCheck.ok) warn(nodeCheck.message);
  } else if (hookKind !== 'missing' && hookKind !== 'file') {
    warn(`${gitHookFile} is a ${hookKind}, not a hook — the git client is not installed here`);
  } else if (hooksInfo.shared) {
    // every repository's hooks folder: installing there is for its owner to choose
    warn(
      `no git post-commit client: core.hooksPath is set in ${hooksPathSource(hooksInfo)} to ${hooksInfo.dir},` +
        `${hookKind === 'file' ? ' which holds a post-commit of its own;' : ''} every repository on this machine runs its hooks from there`
    );
    info(`run ${c.bold('agentmash git-hook install --force-hooks-path')} only if you want it there, for all of them`);
  } else if (hookKind === 'file') {
    warn('a post-commit hook is installed but is not ours — run: agentmash git-hook install');
  } else if (hooksInfo.insideWorkTree) {
    warn(`no git post-commit client: this repo runs hooks from ${path.relative(repo, hooksInfo.dir)}/ (core.hooksPath),`);
    info('which is inside the working tree — installing there would commit AgentMash to the team.');
    info(`run ${c.bold('agentmash git-hook install --force-hooks-path')} only if that is what you want`);
  } else {
    warn('no git post-commit client — teammates not using Claude Code stay invisible');
    info(`install it with ${c.bold('agentmash git-hook install')} (local to this checkout)`);
  }

  await doctorCrew(repo);

  // who the hooks report as (getDeveloper in hooks/lib.mjs): AGENTMASH_DEV,
  // else the login this machine is signed in as for this server, else git's email
  const me = identity(repo);
  const signedIn = readUserLogin();
  const login = String(signedIn?.login || '').trim().toLowerCase();
  const asLogin = !process.env.AGENTMASH_DEV && url && signedIn && sameServer(signedIn.url, url) && /^[a-z0-9][a-z0-9-]{0,38}$/.test(login);
  // the one name the rest of doctor goes by, as the hooks report it
  const who = asLogin ? login : me.who;
  if (asLogin) ok(`you are ${c.cyan(login)}  ${c.dim('(the GitHub login this machine is signed in as)')}`);
  else ok(`you are ${c.cyan(me.who)}  ${c.dim(`(${me.from})`)}`);

  // Before the connection checks, which a machine signed in with `login` and
  // no install here never gets past: its hooks log failures all the same.
  problems += await doctorReports(findRepoRoot(repo) || repo, {
    repoInstall: Boolean(config),
    budgetMs: Number(process.env.AGENTMASH_TIMEOUT_MS || config?.timeout_ms) || 0,
  });

  if (!url || !room) {
    console.log(`\n${c.red('Not connected')} — fix the items above, then re-run doctor.\n`);
    // exitCode, not exit(): tearing the process down while a socket is still
    // closing crashes Node on Windows (0xC0000409), which reads as a CLI bug.
    process.exitCode = 1;
    return;
  }

  // Measure a second time: the first call to an idle server pays wake-up cost,
  // and reporting what a steady-state hook will see is more useful.
  const first = await api('GET', `${url}/healthz`);
  const health = first.ok ? await api('GET', `${url}/healthz`) : first;
  if (health.ok) ok(`server reachable  ${c.dim(`${url} · ${health.ms}ms`)}`);
  else {
    bad(`cannot reach ${url}  ${c.dim(health.text || `HTTP ${health.status}`)}`);
    problems++;
  }

  const budget = Number(process.env.AGENTMASH_TIMEOUT_MS || config?.timeout_ms) || 1500;
  // What a hook pays is not this round trip. `agentmash doctor` runs in one warm
  // process; every hook is a cold one that pays TCP, TLS and the request before
  // an answer can arrive. Comparing the raw round trip against the budget is how
  // a config that drops every advisory passes a health check — so compare
  // against what a cold process actually needs instead.
  const math = await budgetMath();
  const cold = health.ok && math ? math.coldCheckCostMs(health.ms) : 0;
  if (cold > budget) {
    bad(
      `round trip ${health.ms}ms costs a cold hook about ${Math.round(cold)}ms, over the ${budget}ms advisory\n` +
        `      budget — conflict warnings will be silently skipped. Raise it in\n` +
        `      .claude/agentmash/config.json:  "timeout_ms": ${math.budgetForRoundTrip(health.ms)}`
    );
    problems++;
  } else if (cold > budget * 0.7) {
    warn(
      `round trip ${health.ms}ms costs a cold hook about ${Math.round(cold)}ms, close to the ${budget}ms ` +
        `advisory budget — raise "timeout_ms" in config.json if warnings go missing`
    );
  }

  if (health.ok) {
    const roomRes = await lookupRoom(url, room, conn.token);
    if (roomRes.ok) {
      ok(`room valid  ${c.cyan(room)}${roomRes.json?.label ? c.dim(` · ${roomRes.json.label}`) : ''}`);
      if (roomRes.json?.key_expires_at) {
        warn(
          `this room key expires ${roomRes.json.key_expires_at} — it has been rotated. ` +
            `Pull the repo to pick up the new one.`
        );
      }
      const reconcile = roomRes.json?.reconcile_mode ?? 'approve';
      info(
        `reconciliation ${reconcile}: ${
          reconcile === 'off'
            ? 'nothing is said as a session finishes; overlaps show on the board'
            : 'a session that overlaps a teammate\'s tells the person as it finishes, and a person decides'
        }`
      );
      info(
        roomRes.json?.stream_diffs === true
          ? 'diff streaming on: edits carry their changed text to the live view (memory only on the server)'
          : 'diff streaming off: the live view shows presence and summaries, never code — `agentmash diffs on` to change'
      );
      // a server from before rooms asked for a sign-in says nothing of it
      if (roomRes.json?.sign_in_required === true) {
        ok('the room key opens this room only beside the sign-in of someone who can push to its repository');
      } else if (roomRes.json?.sign_in_required === false) {
        info('the room key alone opens this room, to anyone who holds it: `npx agentmash secure sign-in` makes it need a sign-in beside it');
      }
      const mode = roomRes.json?.token_mode ?? 'off';
      if (mode === 'off') info('this room accepts any writer holding the room key (token_mode off)');
      else if (conn.token) ok(`developer token present  ${c.dim(`(token_mode ${mode})`)}`);
      else {
        // a token for this room, from this machine: a bare login signs the machine in for the website's rooms
        bad(`this room requires a developer token (token_mode ${mode}) — run: agentmash login --room`);
        problems++;
      }
    } else if (roomRes.status === 404) {
      bad(roomGone(roomRes.json));
      problems++;
    } else if (roomRes.json?.code === 'room_key_public') {
      // the key was committed to a public repository: it opens the room only beside a pusher's sign-in
      bad(
        `the room key is in ${roomRes.json.repo || 'a repository'}, which is public on GitHub, so the key alone no longer ` +
          `opens the room — sign this machine in as someone who can push to it: ${signInFixFor(url)}`
      );
      problems++;
    } else if (roomRes.json?.code === 'sign_in_required') {
      // the room asks for a sign-in beside its key (secure sign-in, or a room init made)
      bad(
        roomRes.json.repo
          ? `this room opens to its key only beside the sign-in of someone who can push to ${roomRes.json.repo}, ` +
              `and this machine has none that can — ${signInFixFor(url)}`
          : `this room opens to its key only beside the sign-in of someone who can push to the repository it is connected to, ` +
              `and it is connected to none yet: npx agentmash login, then npx agentmash connect`
      );
      problems++;
    } else if (isReauth(roomRes)) {
      // the same key, beside a sign-in too old for the server to say who can push
      bad('the room key opens the room only beside a recent sign-in, and GitHub has to say again what this machine can push to: npx agentmash login');
      problems++;
    } else {
      bad(`room check failed (HTTP ${roomRes.status})`);
      problems++;
    }

    // named, so the room says which names on the board are this person's (`you`): the login a
    // signed-in machine's work shows under, or one its git email is known to be
    const activity = await api('GET', `${url}/activity?developer=${encodeURIComponent(who)}`, { room, token: conn.token });
    if (activity.ok) {
      const sessions = activity.json?.sessions ?? [];
      const mine = new Set([who, me.who, ...(Array.isArray(activity.json?.you) ? activity.json.you : [])].map((n) => String(n).toLowerCase()));
      const others = sessions.filter((s) => !mine.has(String(s.developer).toLowerCase()));
      ok(`activity readable  ${c.dim(`${sessions.length} session(s) in the last hour`)}`);
      if (others.length === 0) info('no teammates seen yet in this room');
      else for (const s of others) info(`teammate: ${c.cyan(s.developer)}  ${c.dim(agoText(s.last_touched))}`);
    }

    // the room this checkout reports to, against the room its repository is connected to
    if (sayRoomSplit(await roomSplit(findRepoRoot(repo) || repo, conn, { self: roomRes })) === true) problems++;
  }

  console.log(
    problems === 0
      ? `\n${c.green('All good.')} Your agent's edits are being shared with this room.\n`
      : `\n${c.red(`${problems} problem(s) found.`)} Fix the ✗ lines above.\n`
  );
  if (problems > 0) process.exitCode = 1;
}

const PRESENCE_TAG = {
  active: 'working',
  idle: 'idle',
  stale: 'no signal',
  ended: 'session ended',
};

async function cmdStatus(args) {
  const repo = args.repo ? path.resolve(args.repo) : findRepoRoot() || process.cwd();
  const conn = connection(repo);
  const { url, room } = conn;
  if (!url || !room) {
    // Outside a repository there is no room to show, whatever the sign-in
    // says: that is the first thing to fix, so it is the first thing said.
    if (!findRepoRoot(repo)) return statusOutsideRepo(repo);
    return statusMachine(findRepoRoot(repo));
  }

  const res = await api('GET', `${url}/activity`, { room, token: conn.token });
  if (!res.ok) {
    // the server's words, never its JSON
    die((await keyTurnedAway(res, conn)) ?? `could not read activity from ${url} ${c.dim(res.json?.error || res.text || `HTTP ${res.status}`)}`);
  }

  const { sessions = [], hot_files = [] } = res.json ?? {};
  console.log(`\n${c.bold('AgentMash')} ${c.dim(`· room ${room}`)}\n`);
  const root = findRepoRoot(repo) || repo;
  if (sayRoomSplit(await roomSplit(root, conn)) !== null) console.log('');
  if (committedHooksPredatePrompts(root)) {
    warn(STALE_HOOKS);
    console.log('');
  }
  if (await warnFailedReports(root)) console.log('');
  if (sessions.length === 0) console.log(c.dim('  nobody active in the last hour\n'));
  for (const s of sessions) {
    // Presence, when the server is new enough to send it: a name with no state
    // beside it reads as "here", which is the thing this board must stop implying.
    const mins = Math.round((Date.now() - (s.last_seen_ts || Date.parse(s.last_touched))) / 60000);
    const state = PRESENCE_TAG[s.presence] ?? '';
    console.log(
      `  ${c.cyan(c.bold(s.developer))} ${c.dim(`· ${state ? `${state} · ` : ''}${mins}m ago${s.git_branch ? ` · ${s.git_branch}` : ''}`)}`
    );
    // Each file goes with the prompt it was edited under, where the server
    // says (an older one sends only the session's). Once the developer has
    // asked for something since, their newest prompt is said as that, and
    // not as the reason for files it came after.
    const files = s.files.slice(0, 5);
    const hintOf = (f) => (f.task_hint !== undefined ? f.task_hint || null : s.task_hint || null);
    const split = files.some((f) => hintOf(f) !== (s.task_hint || null));
    if (s.task_hint) console.log(`    ${split ? 'now: ' : ''}${s.task_hint}`);
    for (const f of files) {
      const hint = hintOf(f);
      const why = !split || hint === (s.task_hint || null) ? '' : hint ? ` · "${hint}"` : ' · no prompt on record';
      console.log(c.dim(`    ${f.file_path}${why}`));
    }
    console.log('');
  }
  if (hot_files.length) {
    console.log(`  ${c.bold(c.red('hot files'))} ${c.dim('· touched by 2+ people')}`);
    for (const h of hot_files) console.log(`    ${c.red(h.file_path)} ${c.dim(h.developers.join(', '))}`);
    console.log('');
  }
  console.log(c.dim(`  dashboard: ${await dashboardLink({ url, room, room_ref: res.json?.room_ref || conn.roomRef })}\n`));
}

function cmdUninstall(args) {
  const repo = targetRepo(args, {
    strict: true,
    instead: 'uninstall takes AgentMash out of one repository: run it in that repository, or pass --repo <path>.',
    also: 'To take it off this machine, the hooks npx agentmash login installed: npx agentmash logout',
  });
  const file = settingsPath(repo);
  if (fs.existsSync(file)) {
    try {
      const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const event of Object.keys(HOOK_ENTRIES)) {
        if (!Array.isArray(settings?.hooks?.[event])) continue;
        settings.hooks[event] = settings.hooks[event].filter(
          (g) => !JSON.stringify(g).includes('.claude/agentmash/')
        );
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
      // `init` no longer writes this, but an install from an earlier version
      // did, and leaving an approval behind for a server that is being removed
      // would outlive the thing it approves.
      if (Array.isArray(settings.enabledMcpjsonServers)) {
        settings.enabledMcpjsonServers = settings.enabledMcpjsonServers.filter(
          (name) => name !== MCP_SERVER_NAME
        );
        if (settings.enabledMcpjsonServers.length === 0) delete settings.enabledMcpjsonServers;
      }
      // A `hooks` with nothing in it is what taking ours out leaves, so it
      // goes; and a file left holding nothing at all held only what init put
      // in it (a developer's own setting, hook or permission would still be
      // there), so it goes too, as .mcp.json does, rather than staying behind
      // as an untracked {"hooks": {}}.
      if (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) && Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
      if (settings && typeof settings === 'object' && !Array.isArray(settings) && Object.keys(settings).length === 0) {
        fs.rmSync(file, { force: true });
      } else fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    } catch {
      warn('could not clean settings.json — remove the agentmash entries by hand');
    }
  }
  removeMcpEntry(repo);
  const git = uninstallGitHook(repo, { forceHooksPath: args.forceHooksPath });
  fs.rmSync(meshDir(repo), { recursive: true, force: true });
  // and the .claude/ those were in, when nothing else is there either
  try {
    fs.rmdirSync(path.dirname(meshDir(repo)));
  } catch {
    // something of theirs is in it (a crew team, settings of their own): kept
  }
  console.log(`\n${c.bold('AgentMash removed')} from ${repo}\n`);
  if (git.ok) info(git.message);
  else warn(git.message);
  // Crew teams need no room and are not part of what init installed, so they
  // stay. Said out loud, or "removed" reads as "everything agentmash wrote".
  if (pathKind(path.join(repo, CREW_MANIFEST)) !== 'missing') {
    info(`crew teams stay installed — remove them with ${c.bold('npx agentmash crew remove <name>')}`);
  }
  info('your teammates still have it until they pull this change\n');
}

/**
 * Take our server out of .mcp.json and nothing else. The file is deleted only
 * when it is left holding nothing at all — a team that registered its own MCP
 * servers there keeps them, and keeps the file.
 */
function removeMcpEntry(repo) {
  const file = mcpJsonPath(repo);
  if (!fs.existsSync(file)) return;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    warn('could not clean .mcp.json — remove the agentmash entry by hand');
    return;
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return;
  if (config.mcpServers && typeof config.mcpServers === 'object') {
    delete config.mcpServers[MCP_SERVER_NAME];
    if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
  }
  if (Object.keys(config).length === 0) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

async function cmdGitHook(args) {
  const repo = targetRepo(args);
  const action = args._[0] || 'install';
  if (!['install', 'uninstall', 'status'].includes(action)) {
    die('usage: agentmash git-hook [install|uninstall|status]');
  }

  if (action === 'status') {
    const file = gitHookPath(repo);
    if (isOurGitHook(file)) ok(`installed  ${c.dim(file)}`);
    else if (fs.existsSync(file)) warn(`a post-commit hook is installed but is not ours  ${c.dim(file)}`);
    else info(`not installed  ${c.dim(file)}`);
    return;
  }

  if (action === 'uninstall') {
    const result = uninstallGitHook(repo, { forceHooksPath: args.forceHooksPath });
    (result.ok ? ok : warn)(result.message);
    return;
  }

  const worker = path.join(meshDir(repo), 'git_post_commit.mjs');
  // The shim is inert without the worker beside it, so put it there first. In
  // a repository with no room committed (one connected on the website), the
  // worker and the lib beside it are this checkout's alone, left by an earlier
  // install, so they are brought up to date as well: one from before the
  // worker looked the room up for a signed-in machine reports nothing there.
  // Not where git tracks any of them: those are the team's, and init's to change.
  if (!fs.existsSync(worker) || (!readConfig(repo) && !tracksInstall(repo))) copyHooks(repo);
  if (!fs.existsSync(worker)) {
    // Only reachable from a broken install of the CLI itself, and worth saying:
    // an inert hook that reports nothing is exactly what nobody notices.
    warn('the worker script is missing from this agentmash install — the hook would report nothing');
    return;
  }
  const result = installGitHook(repo, { forceHooksPath: args.forceHooksPath });
  (result.ok ? ok : warn)(result.message);
  if (!result.ok || readConfig(repo)) return;
  // The room the worker reads before it looks one up (loadConfig): AGENTMASH_ROOM,
  // from the environment or a .env here, which it reports to with its key.
  if ((await hooksLib())?.loadConfig?.(repo)?.room) {
    const where = process.env.AGENTMASH_ROOM ? 'in your environment' : 'in a .env here';
    ok(`this repo's commits go to the room AGENTMASH_ROOM names (${where}), not one looked up by its GitHub repository`);
  } else await sayGitHookRoom(repo);
}

/**
 * What doctor says of the git client in `root`, a checkout connected on the
 * website, where its hook is ours and still reports nothing, or null. With
 * no worker in this checkout (a linked worktree shares the hook, not the
 * worker, which isn't committed), the hook starts nothing. A worker an
 * install left from before it looked the room up (0.13.2 and older) reads
 * config.json alone, which there is none of, while the login's hooks leave
 * commits to it. git-hook install fixes either. Files git tracks are the
 * team's, and their own install's to bring up to date: nothing is said of them.
 */
function quietGitClient(root) {
  if (!isOurGitHook(path.join(resolveHooksDir(root).dir, 'post-commit'))) return null;
  const read = (file) => {
    try {
      return fs.readFileSync(path.join(meshDir(root), file), 'utf8');
    } catch {
      return null;
    }
  };
  const worker = read('git_post_commit.mjs');
  const fix = `run: ${c.bold('npx agentmash git-hook install')}`;
  if (worker === null) {
    return `the git client's hook is installed in this repository, but its worker isn't in this checkout, so commits made here by hand reach no one — ${fix}`;
  }
  const looksUp = worker.includes('lib.resolveConfig') && Boolean(read('lib.mjs')?.includes('export async function resolveConfig'));
  if (looksUp || tracksInstall(root)) return null;
  return `the git client in this checkout is from an older agentmash, which reports nothing in a repository connected on the website — ${fix}`;
}

/**
 * Whether git tracks anything in this checkout's .claude/agentmash: files
 * someone committed, which a change to shows up for the team. When git can't
 * be asked, they are taken to be tracked, and left as they are.
 */
function tracksInstall(repo) {
  try {
    const listed = execFileSync('git', ['ls-files', '-z', '--', '.claude/agentmash'], {
      cwd: repo,
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return listed.length > 0;
  } catch {
    return true;
  }
}

/**
 * Where the git client's commits go in a repository that commits no room of
 * its own, found as the worker finds it (clients/git/post_commit.mjs): on a
 * machine signed in with `npx agentmash login`, the room its GitHub
 * repository is connected to on the website, under the sign-in. Anywhere
 * else they go nowhere, and this says what gives them a room.
 */
async function sayGitHookRoom(repo) {
  const login = readUserLogin();
  if (!login?.token?.startsWith('amu_')) {
    warn('this repo has no room of its own, and this machine is not signed in, so its commits reach no one yet');
    info(`run ${c.bold('npx agentmash login')} if the repository is connected on the website, or ${c.bold('npx agentmash init')} to give it a room`);
    return;
  }
  const slug = (await hooksLib())?.repoSlug?.(repo) ?? null;
  if (!slug) {
    warn('this repo has no room of its own, and no GitHub remote to look one up by, so its commits reach no one yet');
    info(`run ${c.bold('npx agentmash init')} to give it a room`);
    return;
  }
  // the server the worker asks: the hooks' AGENTMASH_URL, else the one this machine signed in to (resolveConfig)
  const url = (process.env.AGENTMASH_URL || login.url).replace(/\/+$/, '');
  const found = await api('GET', `${url}/api/lookup?repo=${encodeURIComponent(slug)}`, { user: login.token });
  if (found.ok && typeof found.json?.room_ref === 'string') {
    ok(`this repo's commits go to the room ${c.bold(slug)} is connected to, under this machine's sign-in  ${c.dim(url)}`);
  } else if (isReauth(found)) warn(REAUTH_PAUSED);
  else if (found.json?.code === 'not_connected') {
    warn(`${c.bold(slug)} is not connected to a room, so its commits reach no one yet — connect it at ${c.cyan(`${url}/install`)}`);
    // the server says that too of one this sign-in couldn't push to: what may hide it, as status and doctor say
    await sayLookupMiss(slug, found, url, repo);
  } else {
    warn(`could not look ${slug} up on ${url}, so whether its commits reach a room is not known  ${c.dim(found.json?.error || (found.status ? `HTTP ${found.status}` : found.text))}`);
  }
}

// ── security commands ──────────────────────────────────────────────────────

function requireConnection(repo) {
  const conn = connection(repo);
  if (!conn.url || !conn.room) die('this repo is not connected — run: agentmash init');
  return conn;
}

/**
 * What a room key the server opens no room to is, in doctor's words, from
 * what /rooms/self said of it (describeRoom): one rotated or revoked away
 * from, which a pull replaces, a room deleted, or a key this server never had.
 */
function roomGone(json) {
  if (json?.rotated) return 'this room key has been rotated or revoked — pull the repo for the new one';
  if (json?.deleted) return 'this room was deleted — its audit trail is all that is left: npx agentmash audit';
  return 'this room does not exist on this server — it may have been reset';
}

/**
 * roomGone's words when the server turned this repository's room key away,
 * or null. Every route but /rooms/self answers such a key with a 401 that
 * asks for the x-agentmash-room header the CLI did send, so /rooms/self is
 * asked which kind of key it is; its own 404 says so with a code, which a
 * server from before the codes never sent.
 */
async function keyTurnedAway(res, conn) {
  const said =
    res.status === 401 && res.json?.code === 'room_unauthorized'
      ? await api('GET', `${conn.url}/rooms/self`, { room: conn.room, token: conn.token })
      : res;
  return said.status === 404 && ['room_rotated', 'room_unknown', 'room_deleted'].includes(said.json?.code) ? roomGone(said.json) : null;
}

/** Every one of these needs a server that knows the endpoint, and a key it still opens the room to; say so plainly. */
async function assertSupported(res, what, conn) {
  const gone = await keyTurnedAway(res, conn);
  if (gone) die(gone);
  // These routes never 404 for a live room, so a 404 means the route is absent.
  if (res.status === 404) {
    die(`this server is too old to ${what} — upgrade the coordination server first`);
  }
  if (res.status === 0) die(`could not reach the server\n        ${c.dim(res.text)}`);
}

async function cmdRotate(args) {
  // the new key reaches the team only in a commit of this repository's config.json
  const repo = targetRepo(args, { strict: true });
  const conn = requireConnection(repo);
  // A number, or a refusal: Number('abc') is NaN, which JSON sends as null,
  // and the server read null as 0 minutes, so every old key stopped at once.
  const typed = args['grace-minutes'];
  if (typed !== undefined && !/^\d+(\.\d+)?$/.test(typed)) {
    die(`--grace-minutes takes a number of minutes, such as 60 (0 ends the old key now), not ${JSON.stringify(typed)}`);
  }
  const grace = typed !== undefined ? Number(typed) : undefined;
  // The new key is written to be committed, as init's is: not to a public
  // repository, where it would be anyone's again as soon as it is pushed.
  // Asked before the server rotates, so a refusal leaves the old key working.
  await guardPublicKey(repo, args, conn.url, 'rotate');

  const res = await api('POST', `${conn.url}/rooms/rotate`, {
    room: conn.room,
    token: conn.token,
    body: grace === undefined ? {} : { grace_minutes: grace },
  });
  await assertSupported(res, 'rotate room keys', conn);
  if (!res.ok) die(`rotation refused (HTTP ${res.status}) ${res.json?.error ?? ''}`);

  const config = { ...(conn.config ?? {}), url: conn.url, room: res.json.room };
  if (res.json.room_ref) config.room_ref = res.json.room_ref;
  writeConfig(repo, config);

  console.log(`\n${c.bold('Room key rotated.')}\n`);
  ok(`new room key written to ${c.dim('.claude/agentmash/config.json')}`);
  ok(`the old key keeps working until ${c.cyan(res.json.previous_expires_at)} ${c.dim(`(${res.json.grace_minutes} min grace)`)}`);
  if (res.json.repo) {
    info(
      `the room also opens to everyone who can push to ${res.json.repo}, which a new key does not change — ` +
        `if that is not your team's repository: ${c.bold('npx agentmash disconnect')}`
    );
  }
  console.log(`\n  ${c.bold('Commit and push — that is what hands the new key to your team:')}`);
  // config.json is all a rotation changes: named with -f where .claude/ is ignored
  sayCommitSteps(stageCommand(repo, ['.claude/agentmash/config.json'], 'git add .claude'), 'Rotate the agentmash room key');
  console.log('  Teammates just pull, as usual. Anyone who has not pulled by the end of');
  console.log('  the grace period stops reporting — silently, as hooks always do — until');
  console.log(`  they do. Cut the grace short with ${c.bold('agentmash revoke')}.\n`);
}

async function cmdRevoke(args) {
  const repo = args.repo ? path.resolve(args.repo) : findRepoRoot() || process.cwd();
  const conn = requireConnection(repo);
  if (args.developer !== undefined) return revokeDeveloper(conn, args.developer);
  const res = await api('POST', `${conn.url}/rooms/revoke`, { room: conn.room, token: conn.token });
  await assertSupported(res, 'revoke room keys', conn);
  if (!res.ok) die(`revocation refused (HTTP ${res.status}) ${res.json?.error ?? ''}`);
  console.log(`\n${c.bold('Revoked.')} ${res.json.revoked} old key(s) stopped working just now.`);
  console.log(`  Anyone still on an old key is cut off until they pull.\n`);
}

/**
 * `revoke --developer <name>`: stop every token that name holds in this room.
 * A name proved by first use is bound to the machine that claimed it, and the
 * server tells a second machine to revoke that token first: this is how, where
 * nothing in the CLI or on the site used to call the route.
 */
async function revokeDeveloper(conn, developer) {
  const res = await api('POST', `${conn.url}/rooms/tokens/revoke`, { room: conn.room, token: conn.token, body: { developer } });
  await assertSupported(res, 'revoke developer tokens', conn);
  if (!res.ok) die(`revocation refused (HTTP ${res.status}) ${res.json?.error ?? ''}`);
  console.log(`\n${c.bold('Revoked.')} ${res.json.revoked} token(s) of ${c.cyan(developer)} stopped working just now.`);
  if (res.json.revoked) {
    console.log(`  ${developer} signs in again, from whichever machine is theirs now, with: npx agentmash login --room\n`);
  } else {
    info(`${developer} held no live token in this room — npx agentmash secure lists the ones it has issued\n`);
  }
}

// ── signed in on this machine ──────────────────────────────────────────────
// `npx agentmash login` is the whole setup for a developer: sign in with
// GitHub once, and this machine's Claude Code reports every repository they
// can push to that anyone on their team has connected on the website. The
// hooks go in the developer's own Claude Code settings (never a repository),
// run with --global, and find the room for each checkout themselves.

/**
 * The hooks a machine sign-in installs: a repository install's, less the MCP
 * launcher. The MCP server goes with them, though a sign-in registers no
 * server: a repository's launcher starts this copy when it is newer than the
 * one committed beside it, so a repo that ran init long ago does not hold this
 * developer back. And the generic hook (agent_hook.mjs) that an agent whose
 * hooks speak another dialect runs: at user level only, never committed.
 */
const MACHINE_HOOK_FILES = [...HOOK_FILES, ...MCP_SERVER_FILES, 'agent_hook.mjs'];
/**
 * The generic hook's dialects, one file each in the hooks' dialects/ folder:
 * every one there is copied, so a new one needs no line here.
 */
const DIALECTS_DIR = 'dialects';

/** MACHINE_HOOK_FILES and the dialects in `source`, as paths under it. */
function machineHookFiles(source) {
  let dialects = [];
  try {
    dialects = fs
      .readdirSync(path.join(source, DIALECTS_DIR))
      .filter((f) => f.endsWith('.mjs'))
      .sort()
      .map((f) => `${DIALECTS_DIR}/${f}`);
  } catch {
    // a hooks folder from before the dialects
  }
  return [...MACHINE_HOOK_FILES, ...dialects];
}

const agentmashHome = () => path.join(process.env.AGENTMASH_HOME || os.homedir(), '.agentmash');
const userLoginFile = () => path.join(agentmashHome(), 'user.json');
const machineHookDir = () => path.join(agentmashHome(), 'hooks');
/** Claude Code's own settings for this user: CLAUDE_CONFIG_DIR when set, as Claude Code reads it. */
const claudeSettingsFile = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

/**
 * What a machine can push to is what GitHub said when it signed in, and the
 * server stops going by that after a while: then every lookup and every room
 * request from the machine is turned away with `reauth`, and its hooks report
 * nowhere until it signs in again.
 */
const REAUTH_PAUSED =
  'GitHub has to say again what you can push to: AgentMash is paused for your repositories on this machine until you run npx agentmash login';
const isReauth = (res) => res?.status === 401 && res.json?.code === 'reauth';

function readUserLogin() {
  try {
    const parsed = JSON.parse(fs.readFileSync(userLoginFile(), 'utf8'));
    return typeof parsed?.token === 'string' && typeof parsed?.url === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function writeUserLogin(entry) {
  fs.mkdirSync(agentmashHome(), { recursive: true });
  fs.writeFileSync(userLoginFile(), JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(userLoginFile(), 0o600);
  } catch {
    // Windows has no mode bits; the file is in the user's own profile
  }
  // what the hooks looked up belongs to whoever was signed in before
  fs.rmSync(path.join(agentmashHome(), 'rooms.json'), { force: true });
}

/** Whether a settings entry is one of ours: its command runs a script from ~/.agentmash/hooks. */
function isMachineHookEntry(entry) {
  return (entry?.hooks ?? []).some((h) =>
    [h?.command, ...(Array.isArray(h?.args) ? h.args : [])].some(
      (part) => typeof part === 'string' && /[\\/]\.agentmash[\\/]hooks[\\/]/.test(part)
    )
  );
}

function readClaudeSettings() {
  const file = claudeSettingsFile();
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    die(`${file} is not valid JSON — fix it, then run: npx agentmash login`);
  }
}

function writeClaudeSettings(settings) {
  const file = claudeSettingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // through a symlink, with its mode, whole, and what was there before
  // agentmash kept beside it the first time, as every agent's file is (see
  // writeFileSafely)
  writeFileSafely(file, JSON.stringify(settings, null, 2) + '\n');
}

/**
 * A repository install's entry for one event (HOOK_ENTRIES), as a sign-in
 * registers it: each script run from ~/.agentmash/hooks, with --global. The
 * same events, matchers, timeouts and async flags, so the two installs never
 * register a hook differently: the prompt's report in the background and its
 * heads-up in line, in both.
 */
function machineHookEntry(want) {
  return {
    ...(want.matcher ? { matcher: want.matcher } : {}),
    // node and the script, with no shell between: a machine signed in with
    // node has it, and this is the form a sign-in always wrote (see hookCommand),
    // with the timeout it always had: no shell to start, no second for one
    hooks: want.hooks.map(({ type, command, timeout, ...rest }) => ({
      type,
      command: 'node',
      args: [path.join(machineHookDir(), hookScriptOf({ command })), '--global'],
      timeout: timeout - SHELL_START_S,
      ...rest,
    })),
  };
}

/**
 * Copy the scripts every connected agent runs to ~/.agentmash/hooks: the
 * hooks, the MCP server and its helpers, the generic hook and its dialects,
 * and each agent's own adapter (Cursor's), beside the lib.mjs they all share.
 */
function copyMachineHookFiles() {
  const source = hookSourceDir();
  fs.mkdirSync(machineHookDir(), { recursive: true });
  // each whole, by rename: an agent may be running one of them right now
  const copy = (from, to) => writeFileSafely(to, fs.readFileSync(from));
  for (const file of machineHookFiles(source)) copy(path.join(source, file), path.join(machineHookDir(), file));
  for (const [src, name] of agentScripts()) {
    const from = clientSource(src);
    if (from) copy(from, path.join(machineHookDir(), name));
  }
  writeFileSafely(path.join(machineHookDir(), 'package.json'), '{ "type": "module" }\n');
}

/**
 * Put the hooks in Claude Code's user settings, replacing any earlier ones.
 * Returns whether the settings changed: written only when they did.
 */
function installClaudeHooks() {
  const settings = readClaudeSettings();
  const before = JSON.stringify(settings);
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const [event, want] of Object.entries(HOOK_ENTRIES)) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((entry) => !isMachineHookEntry(entry));
    kept.push(machineHookEntry(want));
    hooks[event] = kept;
  }
  settings.hooks = hooks;
  if (JSON.stringify(settings) === before) return false;
  writeClaudeSettings(settings);
  return true;
}

/** Take our hooks back out of Claude Code's user settings; anything else there is left as it was. Returns whether any were there. */
function removeClaudeHooks() {
  const file = claudeSettingsFile();
  if (!fs.existsSync(file)) return { removed: false };
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { removed: false, invalid: true };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { removed: false, invalid: true };
  if (!settings.hooks || typeof settings.hooks !== 'object') return { removed: false };
  let removed = false;
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !isMachineHookEntry(entry));
    if (kept.length !== entries.length) removed = true;
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!removed) return { removed: false };
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeClaudeSettings(settings);
  return { removed: true };
}

/**
 * Take everything login put on this machine back out: every agent's entries,
 * then the scripts they ran. A file that cannot be read keeps whatever of ours
 * it held, and while any file still names the scripts they stay, or every
 * call there would fail on a missing script: { invalid, kept }, the files of
 * each kind, to be said.
 */
function removeMachineHooks() {
  const places = agentPlaces();
  const invalid = [];
  for (const agent of Object.values(allAgents())) {
    try {
      invalid.push(...(agent.disconnect(places, machineHookDir()).invalid ?? []));
    } catch (err) {
      invalid.push(`${agent.name}'s settings (${err.message})`);
    }
  }
  const kept = [claudeSettingsFile(), ...agentFiles(places)].filter((file) => {
    try {
      return namesFolder(fs.readFileSync(file, 'utf8'), machineHookDir());
    } catch {
      return false;
    }
  });
  if (kept.length === 0) fs.rmSync(machineHookDir(), { recursive: true, force: true });
  return { invalid, kept: kept.map((file) => shown(file, places)) };
}

/** What logout or `tools remove` could not take out, said, with what to do about it. */
function sayLeftBehind({ invalid = [], kept = [] }) {
  for (const file of invalid) {
    const what = file.endsWith('.toml') ? 'could not be read as TOML' : /\.ya?ml$/.test(file) ? 'could not be changed safely' : 'is not valid JSON';
    warn(`${file} ${what}: agentmash is still in it — fix the file, then run this again, or take agentmash out by hand`);
  }
  if (kept.length) {
    warn(
      `kept ${shown(machineHookDir())}: ${andList(kept)} still ${kept.length === 1 ? 'runs' : 'run'} scripts from it, ` +
        'and every call would fail without them'
    );
  }
}

// ── every agent on the machine ─────────────────────────────────────────────
// Claude Code's half is here (its settings are the ones init and login always
// wrote); the other agents' are in agents/, one module each (see tools.mjs).

const CLAUDE = {
  name: 'Claude Code',
  detect(places) {
    const bin = which('claude', places.toolPath);
    return { found: Boolean(bin) || fs.existsSync(places.claude), bin };
  },
  connect() {
    return { status: installClaudeHooks() ? 'connected' : 'already', notes: [], where: shown(claudeSettingsFile()) };
  },
  disconnect() {
    const result = removeClaudeHooks();
    return { status: result.removed ? 'removed' : 'absent', invalid: result.invalid ? [shown(claudeSettingsFile())] : [] };
  },
  inspect() {
    const entries = machineHookEntries();
    return { connected: entries.length > 0, events: [...new Set(entries.map((e) => e.event))], missing: [], where: shown(claudeSettingsFile()) };
  },
};

/** Every agent, Claude Code first, by the id `tools` and the flags name it by. */
const allAgents = () => ({ claude: CLAUDE, ...AGENTS });
const AGENT_IDS = () => Object.keys(allAgents());

/** A list of agent ids from a flag (--skip codex,cursor), each checked. */
function agentList(value, flag) {
  if (value === undefined || value === null || value === true) return null;
  const ids = String(value).split(',').map((id) => id.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !AGENT_IDS().includes(id));
  if (unknown.length) die(`${flag} ${unknown.join(',')}: the agents are ${AGENT_IDS().join(', ')}`);
  return ids;
}

/**
 * Every agent, Claude Code first, as `tools` finds it on this machine (its
 * detect) and finds it connected (its inspect): { id, agent, found, state,
 * connected, fix }, `fix` the id `tools add` connects it by. One that runs
 * Claude Code's hooks and has none of its own (Devin) says it is connected
 * wherever it is asked, so it counts as connected only when it is here and
 * Claude Code is, and Claude Code's id is what connects it.
 */
function agentsHere(places = agentPlaces()) {
  const rows = Object.entries(allAgents()).map(([id, agent]) => ({ id, agent, found: agent.detect(places).found, state: agent.inspect(places) }));
  const claude = rows.some((row) => row.id === 'claude' && row.state.connected);
  return rows.map((row) => ({
    ...row,
    connected: row.agent.readsClaude ? row.found && claude : Boolean(row.state.connected),
    fix: row.agent.readsClaude ? 'claude' : row.id,
  }));
}

/**
 * Connect the agents on this machine, with the scripts copied first: those
 * named (`only`), detected or not, or else every one detected (Claude Code
 * always: Devin runs its hooks too), leaving out `skip`. One row each.
 */
function connectAgents({ only = null, skip = [] } = {}) {
  const places = agentPlaces();
  copyMachineHookFiles();
  const rows = [];
  for (const [id, agent] of Object.entries(allAgents())) {
    if (skip.includes(id)) {
      rows.push({ id, agent, status: 'skipped', why: 'left out with --skip' });
      continue;
    }
    // an agent connected only when asked for by name (its module's optIn), until it is: then every login keeps it up to date
    if (!only && agent.optIn && !agent.inspect(places).connected) {
      if (agent.detect(places).found) rows.push({ id, agent, status: 'skipped', why: `connected only when asked for: npx agentmash tools add ${id}` });
      continue;
    }
    if (only ? !only.includes(id) : id !== 'claude' && !agent.detect(places).found) {
      if (!only) rows.push({ id, agent, status: 'skipped', why: 'not found on this machine' });
      continue;
    }
    try {
      rows.push({ id, agent, ...agent.connect(places, machineHookDir()) });
    } catch (err) {
      rows.push({ id, agent, status: 'skipped', why: `could not write its settings — ${err.message}` });
    }
  }
  return rows;
}

/** One line per agent, and what the person has to do, under it. */
function sayAgents(rows) {
  const width = Math.max(...rows.map((r) => r.agent.name.length)) + 2;
  for (const row of rows) {
    const name = row.agent.name.padEnd(width);
    if (row.status === 'connected') ok(`${name}connected  ${c.dim(row.where ?? '')}`);
    else if (row.status === 'already') ok(`${name}already connected  ${c.dim(row.where ?? '')}`);
    else info(`${name}skipped — ${row.why}`);
    for (const note of row.notes ?? []) console.log(`      ${c.dim('·')} ${note}`);
  }
}

/** Open a URL in the default browser, quietly; the URL is printed either way. */
function openBrowser(url) {
  try {
    const [cmd, argv] =
      process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    const child = spawn(cmd, argv, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no browser to open: the printed link still works
  }
}

async function cmdLoginMachine(args) {
  const server = (args.server || process.env.AGENTMASH_SERVER || readUserLogin()?.url || DEFAULT_SERVER).replace(/\/+$/, '');
  // a settings file we could not write back is found out before anyone signs in
  readClaudeSettings();
  console.log(`\n${c.bold('agentmash login')} ${c.dim(`· ${server}`)}\n`);
  const only = agentList(args.tools, '--tools');
  const skip = agentList(args.skip, '--skip') ?? [];
  // Signed in from a checkout, its repositories are asked after by name: a
  // remote that still names a repository by the name it had before it was
  // renamed or transferred is never found by this machine's hooks, which look
  // rooms up by the remote, and the sign-in is where GitHub can say so.
  const here = findRepoRoot();
  const remotes = here && !isMachineConfigDir(here) ? await checkoutRemotes(here) : [];
  const ready = await signInMachine(server, args, { repos: githubReposOf(remotes) });

  console.log('');
  ok(`signed in as ${c.cyan(ready.developer)}`);
  for (const [from, to] of Object.entries(ready.moved ?? {})) sayMoved(here, remotes, from, to);
  // every coding agent on the machine, at user level: nothing goes into a repository
  console.log(`\n  ${c.bold('the coding agents on this machine')}`);
  const rows = connectAgents({ only, skip });
  sayAgents(rows);
  console.log('');
  const connected = Array.isArray(ready.connected) ? ready.connected : [];
  if (connected.length) {
    ok(`connected repositories you can push to:`);
    for (const r of connected) console.log(`      ${c.bold(r.repo)} ${c.dim(`→ ${server}/r/${r.room_ref}`)}`);
  } else {
    warn(`none of your repositories is connected yet — connect one at ${c.cyan(`${server}/install`)}`);
  }
  // What the hooks send, said where the person signed in: Claude Code's first
  // session in a room says it too (sharingNote in hooks/lib.mjs), but not
  // every agent shows a hook's line to the person. PROMPT_CHARS there.
  info(
    "what your agents send to a connected repository's room: the first 500 characters of each prompt, and the names\n" +
      '    of the files and functions changed, which your teammates and their agents see. AGENTMASH_HINTS=0 keeps your prompts here.'
  );
  // A checkout that carries a room of its own reports there, and this
  // machine's hooks step aside for it: the room just listed for its
  // repository has to be that one, or this list is not where the work goes.
  if (here && readConfig(here)?.room) {
    sayRoomSplit(await roomSplit(here, connection(here)));
    // and its own hooks are what report there: this machine's step aside for them
    if (committedHooksPredatePrompts(here)) warn(STALE_HOOKS);
  }
  sayRestart(rows);
  console.log(c.dim(`  to undo it all: npx agentmash logout\n`));
}

/** How long a sign-in's code works, in seconds, when the server does not say: what it always has been. */
const SIGN_IN_CODE_SECONDS = 600;

/** A sign-in code's lifetime, from the server's expires_in, in seconds. */
const codeSeconds = (started) =>
  Number.isFinite(started?.expires_in) && started.expires_in > 0 ? started.expires_in : SIGN_IN_CODE_SECONDS;

/** "10 minutes", for a lifetime in seconds. */
function lifetime(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * The command this process was started as, to give back to someone whose
 * sign-in ran out: `npx agentmash connect` when connect signed in, never a
 * login they did not run.
 */
function rerunCommand() {
  return ['npx agentmash', ...process.argv.slice(2).map(shellQuote)].join(' ');
}

/** What a sign-in whose code ran out says. */
const codeExpired = (seconds) => `this sign-in code expired: it works for ${lifetime(seconds)} — run: ${rerunCommand()}`;

/**
 * What login ends on: the agents it connected, by name, since each reads its
 * hooks and starts our MCP server as a session starts, and a session already
 * open goes on without them. Someone who connected Codex alone is told about
 * Codex, not Claude Code. One that runs Claude Code's hooks (Devin) is named
 * only when they are there. An agent that runs nothing until the person
 * approves it (Codex, in /hooks) is said again here, the last thing they read.
 */
function sayRestart(rows) {
  const on = (row) => row.status === 'connected' || row.status === 'already';
  const claude = rows.some((row) => row.id === 'claude' && on(row));
  const named = rows.filter((row) => on(row) && (!row.agent.readsClaude || claude));
  if (named.length === 0) {
    console.log('');
    warn(`no coding agent was connected — ${c.bold('npx agentmash tools')} lists them, and how to connect one`);
    return;
  }
  const names = named.map((row) => row.agent.name);
  console.log(`\n  ${c.bold(`restart any ${andList(names, 'or')} session that is already open`)} so it picks this up.`);
  const places = agentPlaces();
  for (const row of named) {
    const approval = row.agent.approvalHint ? row.agent.inspect(places).approval : null;
    if (approval && approval.approved < approval.total) {
      console.log(`  ${c.bold(row.agent.approvalHint.long)}: ${row.agent.name} runs none of its hooks until you do.`);
    }
  }
}

/**
 * The code the terminal shows, as the line to act on: the browser asks for it
 * after GitHub and issues nothing until it is typed there, so a link someone
 * else sent cannot sign their machine in as you. And how long it works, which
 * is all the time there is to get to the browser.
 */
function sayCode(code, seconds = SIGN_IN_CODE_SECONDS) {
  console.log(`\n  ${c.bold(`type this code in your browser: ${code}`)}`);
  console.log(`  ${c.dim(`this code works for ${lifetime(seconds)}`)}\n`);
}

/**
 * Die on a poll the server answered with anything but a token. Turned down in
 * the browser (cancelled there, a code that was not this one) or closed to
 * new people, the server's own words say which, and they are all that is
 * said: "sign-in failed (HTTP 403)" in front of them only hid them. Where they
 * say to run login again, it is the command that was run, which may be
 * connect. A code that ran out (404: the server has forgotten it) is said as
 * that, with how long one works and the command to run again.
 */
function refuseSignIn(polled, seconds = SIGN_IN_CODE_SECONDS) {
  if (polled.ok) return;
  if (polled.status === 403 && polled.json?.error && ['cancelled', 'denied', 'closed'].includes(polled.json?.code)) {
    die(String(polled.json.error).replace(/npx agentmash login(?: again)?/, rerunCommand()));
  }
  const plan = planRefusal(polled);
  if (plan) die(plan);
  if (polled.status === 404) die(codeExpired(seconds));
  die(`sign-in failed (HTTP ${polled.status}) ${polled.json?.error ?? ''}`);
}

/**
 * The server's own words when the team's plan has no room for what was
 * asked: a seat for this developer (seat_limit) or another private
 * repository (repo_limit), and where to upgrade. Null for any other answer.
 */
function planRefusal(res) {
  return res?.status === 402 && typeof res.json?.message === 'string' && res.json.message ? res.json.message : null;
}

/**
 * Poll `server` for what a sign-in started in the browser issues, until it
 * comes or its code runs out, and return the server's answer; die on any
 * other. A poll that gets no answer at all is the network, not the sign-in:
 * polling goes on through it, since the code works for as long as it does,
 * and it is said as it happens, and at the end when it is why nothing came.
 */
async function waitForSignIn(server, pollToken, seconds) {
  const deadline = Date.now() + seconds * 1000;
  let unreachable = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const polled = await api('POST', `${server}/auth/cli/token`, { poll: pollToken });
    if (polled.status === 0) {
      if (!unreachable) warn(`cannot reach ${server} right now ${c.dim(polled.text)} — still waiting, for as long as the code works`);
      unreachable = polled;
      continue;
    }
    if (unreachable) info(`reached ${server} again`);
    unreachable = null;
    if (polled.status === 202) continue;
    refuseSignIn(polled, seconds);
    return polled.json;
  }
  if (unreachable) {
    die(
      `could not reach ${server} while waiting for the sign-in ${c.dim(unreachable.text)} — ` +
        `check this machine's network, then run: ${rerunCommand()}`
    );
  }
  die(codeExpired(seconds));
}

/**
 * The browser half of signing a machine in: start it, wait while the person
 * signs in with GitHub, and keep the token. The server reads what they can
 * push to on the way, which is why `connect` comes back here when what it
 * has is too old to open a room to a repository. Returns the server's answer.
 */
async function signInMachine(server, args, { repos = [] } = {}) {
  const started = await api('POST', `${server}/auth/cli/start`, {
    // `repos`, the checkout's: GitHub is asked after each by name while the
    // server holds the sign-in's token, and one that moved comes back as `moved`
    body: { global: true, alias: os.userInfo().username, ...(repos.length ? { repos } : {}) },
  });
  if (started.status === 0) die(`could not reach ${server}\n        ${c.dim(started.text)}`);
  if (started.status === 503) die('GitHub sign-in is not set up on this server');
  // too many started from here, or waiting on the server: it says which, and when to try again
  if (started.status === 429) die(started.json?.error || 'too many sign-ins on this server right now; try again later');
  if (!started.ok || !started.json?.verify_url) {
    die(`this server cannot sign a machine in (HTTP ${started.status}) — it may be older than this CLI`);
  }

  const seconds = codeSeconds(started.json);
  console.log(`  ${c.bold('sign in with GitHub')} in your browser:`);
  console.log(`  ${c.cyan(started.json.verify_url)}`);
  sayCode(started.json.code, seconds);
  info('waiting for you to finish');
  if (!args.noOpen) openBrowser(started.json.verify_url);

  const ready = await waitForSignIn(server, started.json.poll_token, seconds);
  if (!ready?.token) die(codeExpired(seconds));

  writeUserLogin({ url: server, token: ready.token, login: ready.developer, created_at: new Date().toISOString() });
  return ready;
}

async function cmdLogout(args = {}) {
  const login = readUserLogin();
  // A sign-in ends when the server forgets it, or after 90 days unused. One
  // the server did not confirm it forgot still works there, so it is kept
  // here, the one copy that can end it, for a logout once the server answers.
  // --all: every machine signed in as this login, the others too.
  const ended = login
    ? await api('POST', `${login.url}/api/logout`, { user: login.token, ...(args.all ? { body: { all: true } } : {}) })
    : null;
  const left = removeMachineHooks();
  if (!login || ended.ok) fs.rmSync(userLoginFile(), { force: true });
  fs.rmSync(path.join(agentmashHome(), 'rooms.json'), { force: true });
  // the developer tokens login --room kept, one a room, which a committed
  // install's hooks sign every edit in that room with: signed out, they go too
  const roomTokens = Object.keys(readCredentials().tokens ?? {}).length;
  fs.rmSync(credentialsPath(), { force: true });
  console.log('');
  const agents = Object.values(allAgents()).map((a) => a.name).join(', ');
  const everyAgent = `every agent on this machine ${c.dim(`(${agents})`)}`;
  const clean = left.invalid.length === 0 && left.kept.length === 0;
  const nothing = !login && roomTokens === 0;
  if (clean) {
    if (nothing) ok(`nothing was signed in; agentmash is out of ${everyAgent}`);
    else if (login && ended.ok) ok(`signed out ${c.cyan(login.login || '')} and took agentmash out of ${everyAgent}`);
    else ok(`took agentmash out of ${everyAgent}`);
  } else {
    if (nothing) ok('nothing was signed in');
    else if (login && ended.ok) ok(`signed out ${c.cyan(login.login || '')}`);
    sayLeftBehind(left);
  }
  if (roomTokens) {
    ok(`removed the developer ${roomTokens === 1 ? 'token' : 'tokens'} npx agentmash login --room kept for ${plural(roomTokens, 'room')}`);
  }
  if (login && ended.ok && args.all) sayLoggedOutEverywhere(login, ended.json);
  if (login && !ended.ok) {
    const who = login.login || 'this machine';
    bad(
      ended.status
        ? `${login.url} answered HTTP ${ended.status} when asked to sign ${who} out, so the sign-in may still work on that server`
        : `could not reach ${login.url} to sign ${who} out there, so the sign-in still works on that server  ${c.dim(ended.text)}`
    );
    info(
      `it is kept on this machine: run npx agentmash logout again once it answers ` +
        c.dim(`(if that server is gone for good, delete ${shown(userLoginFile())})`)
    );
    process.exitCode = 1;
  }
  console.log('');
}

/**
 * What `logout --all` did with the other machines signed in as `login`: the
 * server's count of them (this one among them), or, from a server that
 * signs out one machine at a time and says no count, that the others are
 * still signed in. A sign-in that had ended already names no machines.
 */
function sayLoggedOutEverywhere(login, said) {
  const who = login.login || 'this login';
  if (typeof said?.revoked !== 'number') {
    warn(`${login.url} signs out one machine at a time: every other machine signed in as ${who} still is, until npx agentmash logout runs on it`);
    process.exitCode = 1;
  } else if (said.ok === false && said.revoked === 0) {
    warn(
      `this machine's sign-in had ended already, so it could not say which others are ${who}'s: ` +
        `sign them out at ${login.url}/keys, or sign in and run npx agentmash logout --all again`
    );
  } else {
    ok(`signed out ${plural(said.revoked, 'machine')} signed in as ${c.cyan(who)}, this one with them`);
  }
}

/**
 * `npx agentmash tools`: every agent agentmash can connect, whether it is on
 * this machine, and whether it is connected; `tools add <id>` and `tools
 * remove <id>` connect or disconnect one at a time, signed in or not (a
 * repository that carries a room of its own needs no sign-in).
 */
async function cmdTools(args) {
  const [action = 'list', ...ids] = args._;
  const places = agentPlaces();
  if (action === 'add' || action === 'remove') {
    const named = agentList(ids.join(','), `tools ${action}`) ?? [];
    if (named.length === 0) die(`usage: agentmash tools ${action} <${AGENT_IDS().join('|')}>`);
    console.log('');
    if (action === 'add') {
      sayAgents(connectAgents({ only: named }));
      if (!readUserLogin()) {
        info(
          `this machine is not signed in: these hooks report only in repositories that carry a room of their own — ` +
            `${c.bold('npx agentmash login')} for every repository you can push to`
        );
      }
    } else {
      for (const id of named) {
        const agent = allAgents()[id];
        const result = agent.disconnect(places, machineHookDir());
        (result.status === 'removed' ? ok : info)(`${agent.name}  ${result.status === 'removed' ? 'disconnected' : 'was not connected'}`);
        sayLeftBehind({ invalid: result.invalid });
      }
    }
    console.log('');
    return;
  }
  if (action !== 'list') die(`usage: agentmash tools [add|remove <${AGENT_IDS().join('|')}>]`);
  const login = readUserLogin();
  console.log(`\n${c.bold('agentmash tools')}  ${c.dim(login ? `signed in as ${login.login || '?'} · ${login.url}` : 'not signed in')}\n`);
  // columns as wide as the longest id and name, and never narrower than they always were
  const idWidth = Math.max(8, ...AGENT_IDS().map((id) => id.length + 1));
  const nameWidth = Math.max(15, ...Object.values(allAgents()).map((agent) => agent.name.length + 1));
  for (const [id, agent] of Object.entries(allAgents())) {
    const found = agent.detect(places);
    const version = found.bin ? versionOf(found.bin, places) : null;
    const seen = found.found ? `found${version ? ` · ${version}` : ''}` : 'not found';
    const state = agent.inspect(places);
    let said = state.connected ? (agent.mcpOnly ? 'connected · MCP only' : 'connected') : 'not connected';
    if (agent.readsClaude) said = 'runs Claude Code\'s hooks';
    if (state.connected && state.warnings?.length) said += ' · switched off in part (npx agentmash doctor)';
    if (state.connected && state.approval && state.approval.approved < state.approval.total) {
      said += ` · hooks not approved yet (${agent.approvalHint?.short ?? 'approve them in the agent'})`;
    } else if (state.connected && state.approval?.total) said += ' · hooks approved';
    console.log(`  ${id.padEnd(idWidth)} ${agent.name.padEnd(nameWidth)} ${seen.padEnd(36)} ${state.connected || agent.readsClaude ? c.green(said) : c.dim(said)}`);
  }
  console.log(c.dim(`\n  connect one: npx agentmash tools add <id> · take one out: npx agentmash tools remove <id>\n`));
}

/** Status run in a folder that is no repository, with no room configured: the folder first, then the sign-in. */
async function statusOutsideRepo(folder) {
  console.log(`\n${c.bold('agentmash')}\n`);
  bad(`${folder} is not inside a git repository — run status in your team's repository, or pass --repo <path>`);
  process.exitCode = 1;
  const login = readUserLogin();
  if (login) ok(`this machine is signed in as ${c.cyan(login.login || '?')} ${c.dim(`· ${login.url}`)}`);
  else info(`this machine is not signed in either: ${c.bold('npx agentmash login')} signs it in for every repository you can push to`);
  console.log('');
}

/**
 * What is wrong with the agents connected here as a whole (agentsHere), or
 * null: { id, text }, `id` the agent the line is about. Claude Code not
 * connected is a problem only where it is installed, or where no agent is
 * connected at all: someone who connected Codex alone, on a machine with no
 * Claude Code, is set up, and login could not change a line that said they
 * were not.
 */
function connectionProblem(rows) {
  if (!rows.some((row) => row.connected)) {
    // a settings file that cannot be read names its own fix (sayAgentsHere, doctor): login could not change it
    if (rows.some((row) => row.state.invalid)) return null;
    return { id: null, text: 'no coding agent on this machine is connected, so nothing from it reaches a room — run: npx agentmash login' };
  }
  const claude = rows.find((row) => row.id === 'claude');
  if (claude?.found && !claude.connected) {
    return { id: 'claude', text: 'Claude Code is on this machine and not connected — run: npx agentmash tools add claude' };
  }
  return null;
}

/**
 * The coding agents on this machine, for status: those connected, what is
 * wrong (connectionProblem), any connected one that runs none of its hooks
 * until the person approves them, and those found here and not connected,
 * with the command that connects them. Those are no problem: login --skip
 * leaves one out on purpose, and some are connected only when asked for.
 */
function sayAgentsHere(rows) {
  const connected = rows.filter((row) => row.connected);
  if (connected.length) {
    ok(`coding agents connected: ${andList(connected.map((row) => `${row.agent.name}${row.agent.mcpOnly ? ' (MCP only)' : ''}`))}`);
  }
  const problem = connectionProblem(rows);
  if (problem) bad(problem.text);
  // as doctor says it: tools add and login only answer "fix it" while the file cannot be read
  for (const row of rows.filter((r) => r.state.invalid)) {
    bad(`${row.agent.name}: ${row.state.where} is not valid JSON, so ${row.agent.name} ${row.agent.mcpOnly ? 'starts no MCP server from it' : 'runs none of its hooks'} — fix it, then run: npx agentmash login`);
  }
  for (const row of connected) {
    const approval = row.state.approval;
    if (approval && approval.approved < approval.total) {
      warn(`${row.agent.name}: hooks not approved yet — ${row.agent.approvalHint?.long ?? 'approve them in the agent'}`);
    }
  }
  // the problem's own line gives its command: not said twice
  const unconnected = rows.filter((row) => row.found && !row.connected && !row.state.invalid && row.fix !== problem?.id);
  if (unconnected.length) {
    const ids = [...new Set(unconnected.map((row) => row.fix))];
    info(`found here, not connected: ${andList(unconnected.map((row) => row.agent.name))} — ${c.bold(`npx agentmash tools add ${ids.join(' ')}`)}`);
  }
}

/** Status for a machine signed in with `npx agentmash login`: who, which of its agents report, and what this checkout reports to. */
async function statusMachine(repo) {
  const login = readUserLogin();
  console.log(`\n${c.bold('agentmash')}\n`);
  if (!login) {
    bad('this machine is not signed in — run: npx agentmash login');
    console.log('');
    return;
  }
  const who = await api('GET', `${login.url}/api/whoami`, { user: login.token });
  if (who.status === 401) {
    bad(`this machine's sign-in has expired or was revoked — run: npx agentmash login`);
    console.log('');
    return;
  }
  ok(`signed in as ${c.cyan(who.json?.login ?? login.login)} ${c.dim(`· ${login.url}`)}`);
  const reauth = who.json?.reauth === true;
  if (reauth) bad(REAUTH_PAUSED);
  sayAgentsHere(agentsHere());
  if (repo) await warnFailedReports(repo);
  const lib = await import(pathToFileURL(path.join(hookSourceDir(), 'lib.mjs')).href);
  const slug = repo ? lib.repoSlug?.(repo) : null;
  // stale push access turns every lookup away: said once, above
  if (slug && !reauth) {
    const found = await api('GET', `${login.url}/api/lookup?repo=${encodeURIComponent(slug)}`, { user: login.token });
    if (found.ok) ok(`${c.bold(slug)} is connected ${c.dim(`→ ${found.json.dashboard_url}`)}`);
    else if (isReauth(found)) bad(REAUTH_PAUSED);
    else if (found.json?.code === 'not_connected') {
      warn(`${c.bold(slug)} is not connected yet — connect it at ${c.cyan(`${login.url}/install`)}`);
      await sayLookupMiss(slug, found, login.url, repo);
    } else warn(`could not look ${slug} up ${c.dim(found.json?.error ?? `HTTP ${found.status}`)}`);
  }
  const connected = who.json?.connected ?? [];
  if (connected.length) info(`connected repositories you can push to: ${connected.map((r) => r.repo).join(', ')}`);
  console.log('');
}

/** The entries a sign-in put in Claude Code's own settings, each with its event; [] when there is nothing to read. */
function machineHookEntries() {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(claudeSettingsFile(), 'utf8'));
  } catch {
    return [];
  }
  const hooks = settings?.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  return Object.entries(hooks).flatMap(([event, entries]) =>
    Array.isArray(entries) ? entries.filter(isMachineHookEntry).map((entry) => ({ event, entry })) : []
  );
}

/**
 * doctor for a machine signed in with `npx agentmash login`, in a checkout
 * with no room of its own. Its hooks are in each connected agent's own
 * settings (Claude Code's, Codex's, Cursor's, ...), not the repository's, and
 * find the room by the checkout's GitHub repository, so what is checked is
 * what they need: a sign-in the server still takes, every connected agent's
 * hooks in place with their scripts, a server they can reach, and a room this
 * repository is connected to. Claude Code is one of those agents: its hooks
 * missing are a problem only where it is installed, or where no agent is
 * connected at all (connectionProblem). Nothing a room-key install commits is
 * looked for, and init is never the fix: it would make a second room for a
 * repository that has one on the website already.
 */
async function doctorMachine(repo, { login, problems }) {
  const root = findRepoRoot(repo);
  const fail = (message) => {
    bad(message);
    problems++;
  };

  // the server the hooks use: AGENTMASH_URL, else the one signed in to
  const url = login ? (process.env.AGENTMASH_URL || login.url).replace(/\/+$/, '') : null;
  let who = null;
  if (!login) fail('this machine is not signed in — run: npx agentmash login');
  else {
    if (process.env.AGENTMASH_URL) info(`AGENTMASH_URL env overrides the sign-in's server → ${url}`);
    const first = await api('GET', `${url}/healthz`);
    const health = first.ok ? await api('GET', `${url}/healthz`) : first;
    if (health.ok) ok(`server reachable  ${c.dim(`${url} · ${health.ms}ms`)}`);
    else fail(`cannot reach ${url}  ${c.dim(health.text || `HTTP ${health.status}`)}`);
    who = health.ok ? await api('GET', `${url}/api/whoami`, { user: login.token }) : null;
    if (!who) info(`signed in as ${c.cyan(login.login || '?')}, which the server could not be asked to confirm`);
    else if (who.status === 401) fail("this machine's sign-in has expired or was revoked — run: npx agentmash login");
    else if (!who.ok) fail(`the server could not say who this machine is signed in as  ${c.dim(who.json?.error || `HTTP ${who.status}`)}`);
    else if (who.json?.closed_to_you) fail(`signed in as ${c.cyan(who.json.login)}, but this server isn't letting ${who.json.login} in (AGENTMASH_ALLOW): nothing they send is let in`);
    else {
      ok(`signed in as ${c.cyan(who.json?.login ?? login.login)}  ${c.dim(`· ${url}`)}`);
      if (who.json?.reauth === true) fail(REAUTH_PAUSED);
    }
  }

  const file = claudeSettingsFile();
  let readable = true;
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    readable = err?.code === 'ENOENT';
  }
  const entries = machineHookEntries();
  const events = new Set(entries.map(({ event }) => event));
  const lacking = Object.keys(HOOK_ENTRIES).filter((event) => !events.has(event));
  // what Claude Code runs is the script each entry names, wherever that is
  const scripts = entries.flatMap(({ entry }) => entry.hooks.map((h) => h?.args?.[0])).filter((p) => typeof p === 'string');
  const gone = [...new Set(scripts.filter((p) => !fs.existsSync(p)))];
  const places = agentPlaces();
  const here = agentsHere(places);
  if (!readable) fail(`${file} is not valid JSON, so Claude Code runs none of its hooks — fix it, then run: npx agentmash login`);
  else if (entries.length === 0) {
    // not connected: said when it is installed, or when nothing else is connected either; else the agents that are say below
    const problem = connectionProblem(here);
    if (problem) fail(problem.text);
  } else if (lacking.length) {
    fail(`Claude Code has no agentmash hook for ${andList(lacking)} ${c.dim(`(${file})`)} — run: npx agentmash login`);
  } else if (gone.length) {
    fail(`Claude Code runs ${andList(gone)}, which ${gone.length === 1 ? 'does' : 'do'} not exist — every call fails — run: npx agentmash login`);
  } else ok(`hooks installed in Claude Code  ${c.dim(`${file} · ${Object.keys(HOOK_ENTRIES).length} events`)}`);

  // The scripts every agent runs, as old as the login that copied them: an
  // MCP server from before advice-only stops hears the room's reconcile mode
  // as off (the server tells it so) and says so to the agent.
  const machineServer = serverVersionOf(path.join(machineHookDir(), MCP_SERVER_FILES[0]));
  if (machineServer && olderVersion(machineServer, version())) {
    warn(
      `the scripts in ${shown(machineHookDir())} are from ${machineServer}, older than this CLI (${version()}); ` +
        'their MCP server says reconciliation is switched off whatever the room is set to — run: npx agentmash login'
    );
  }

  // each other agent login connected: its entries there, their scripts there, and where the agent asks for it (Codex), approved
  for (const { id, agent, found, state } of here) {
    // Claude Code is checked above, and so is one that runs its hooks
    if (id === 'claude' || agent.readsClaude) continue;
    if (state.invalid) {
      fail(`${agent.name}: ${state.where} is not valid JSON, so ${agent.name} ${agent.mcpOnly ? 'starts no MCP server from it' : 'runs none of its hooks'} — fix it, then run: npx agentmash login`);
    }
    else if (!state.connected) {
      if (found) info(`${agent.name} is on this machine and not connected — ${c.bold(`npx agentmash tools add ${id}`)}`);
    } else if (state.missing.length) {
      fail(`${agent.name}: runs ${andList(state.missing)}, which ${state.missing.length === 1 ? 'does' : 'do'} not exist — every call fails — run: npx agentmash login`);
    } else if (agent.mcpOnly) {
      ok(`${agent.name}: MCP server in ${state.where} (it has no hooks)`);
    } else {
      const hint = agent.approvalHint;
      const approval = state.approval
        ? state.approval.approved < state.approval.total
          ? `, not approved yet — ${hint?.long ?? 'approve them in the agent'}`
          : `, approved${hint?.approvedIn ? ` in ${hint.approvedIn}` : ''}`
        : '';
      const said = `${agent.name}: hooks in ${state.where} (${plural(state.events.length, 'event')})${approval} · MCP server ${state.mcp ? 'registered' : 'not registered'}`;
      if (state.approval && state.approval.approved < state.approval.total) warn(said);
      else ok(said);
    }
    // what the agent's own settings say about ours (switched off, a folder it does not trust), once it is connected
    if (state.connected && !state.invalid) {
      for (const line of state.warnings ?? []) warn(`${agent.name}: ${line}`);
      for (const line of state.notes ?? []) info(`${agent.name}: ${line}`);
    }
  }

  const slug = root ? ((await hooksLib())?.repoSlug?.(root) ?? null) : null;
  let connected = false;
  if (!root) info('not inside a git repository: the hooks report from checkouts of repositories connected on the website');
  else if (!slug) {
    fail(
      'this checkout has no GitHub remote, so the hooks have no room to look up for it — ' +
        `a room carried in the repository works without one: ${c.bold('npx agentmash init')}`
    );
  } else if (who?.ok && !who.json?.closed_to_you && who.json?.reauth !== true) {
    const found = await api('GET', `${url}/api/lookup?repo=${encodeURIComponent(slug)}`, { user: login.token });
    connected = found.ok && typeof found.json?.room_ref === 'string';
    if (connected) ok(`${c.bold(slug)} is connected  ${c.dim(`→ ${found.json.dashboard_url ?? `${url}/r/${found.json.room_ref}`}`)}`);
    else if (isReauth(found)) fail(REAUTH_PAUSED);
    else if (found.json?.code === 'not_connected') {
      fail(`${c.bold(slug)} is not connected to a room, so nothing from this checkout reaches anyone — connect it at ${c.cyan(`${url}/install`)}`);
      await sayLookupMiss(slug, found, url, root);
    } else fail(`could not look ${slug} up  ${c.dim(found.json?.error || (found.status ? `HTTP ${found.status}` : found.text))}`);
  }
  if (connected) {
    const quiet = quietGitClient(root);
    if (quiet) warn(quiet);
  }

  await doctorCrew(repo);
  problems += await doctorReports(root || repo, { repoInstall: false, budgetMs: Number(process.env.AGENTMASH_TIMEOUT_MS) || 0 });

  if (problems > 0) {
    console.log(`\n${c.red(`${problems} problem(s) found.`)} Fix the ✗ lines above.\n`);
    process.exitCode = 1;
  } else if (connected) {
    console.log(`\n${c.green('All good.')} This machine is signed in, and your agent's edits in ${slug} are shared with its room.\n`);
  } else {
    console.log(`\n${c.green('This machine is signed in and its hooks are installed.')} Run doctor in a repository to check that one.\n`);
  }
}

// ── one room per repository ────────────────────────────────────────────────
// A checkout that ran `init` reports to the room committed in its
// config.json, and a signed-in machine's own hooks step aside for it. Login,
// the website and every lookup find the room by the GitHub repository
// instead. Nothing compared the two, so a repository could carry one room and
// be connected to another, each side looking fine on its own, while the work
// went to one room and everyone looked at the other. status, login and doctor
// compare them now, and `connect` makes them one.

const sameServer = (a, b) =>
  String(a || '').replace(/\/+$/, '').toLowerCase() === String(b || '').replace(/\/+$/, '').toLowerCase();

/**
 * This checkout's remotes, as lib.gitRemotes reads them: { remote, repo,
 * github } each, origin's first. A lib from before it gives the one
 * repository repoSlug names, by origin, as every command here once did.
 */
async function checkoutRemotes(repo) {
  const lib = await hooksLib();
  const remotes = lib?.gitRemotes?.(repo);
  if (Array.isArray(remotes)) return remotes;
  const slug = lib?.repoSlug?.(repo);
  return slug ? [{ remote: 'origin', repo: slug, github: true }] : [];
}

/** The GitHub repositories among a checkout's remotes, each once, origin's first. */
const githubReposOf = (remotes) => [...new Set(remotes.filter((r) => r.github).map((r) => r.repo))];

/** The repositories a checkout's remotes name, each once, origin's first, GitHub's for sure or not. */
const repoNamesOf = (remotes) => [...new Set(remotes.map((r) => r.repo))];

/**
 * The one GitHub repository a checkout's remotes all name, or null: there is
 * none, or there is more than one, as in a fork, where origin is the
 * developer's own and upstream the team's. Which of them a room is for is
 * not the checkout's to say, so nothing connects one of them by itself: the
 * team's room connected to a fork would open to the fork and turn the team
 * away.
 */
function onlyRepoOf(remotes) {
  const names = repoNamesOf(remotes);
  return names.length === 1 && remotes.some((r) => r.github) ? names[0] : null;
}

/** The connect command to give: the bare one, or, when there is no one repository to connect, one naming it. */
const connectCommand = (remotes) => (onlyRepoOf(remotes) ? 'npx agentmash connect' : 'npx agentmash connect <owner/name>');

/**
 * Whether the room this checkout reports to (`conn`, its committed config) is
 * the room its GitHub repository is connected to. `self` is what /rooms/self
 * answered for the committed key, when the caller asked already. Null when
 * there is nothing to compare, or no answer to compare it with; otherwise
 * `kind` is one of:
 *
 *   same           one room
 *   elsewhere      the committed room is connected to a repository none of
 *                  this checkout's remotes is, and opens to everyone who can
 *                  push to that one, whatever its key
 *   fork_of        the same, but this checkout's one repository is a fork
 *                  (the server says so): a fork carries its original's config,
 *                  so its room is the original's, as it should be
 *   elsewhere_unsure  the same, with one repository and no server to ask
 *                  (signed out): a fork, or a room someone else's; said, not counted
 *   bound          connected to a repository, and no remote here is GitHub's
 *                  for sure (an SSH host alias whose path is not that one, or
 *                  no remote at all), so whether it is this one cannot be told
 *   servers        this checkout and this machine's sign-in use two servers
 *   two_rooms      one of its repositories, `slug`, is connected to another room
 *   not_connected  none of them is: said to a signed-in machine only, since a
 *                  team on the committed install alone has nothing it needs to do
 *   fork           none of them is, and GitHub lists every one as a fork: the
 *                  server connects no fork to the room a key names, so there
 *                  is nothing to connect here
 *
 * Which repository is this checkout's is any remote's, whatever its name: in
 * a fork, origin is the developer's own and upstream the team's, and the
 * team's is the one its room is connected to.
 */
async function roomSplit(repo, conn, { login = readUserLogin(), self = null } = {}) {
  if (!conn.url || !conn.room) return null;
  const remotes = await checkoutRemotes(repo);
  const slugs = githubReposOf(remotes);
  // /rooms/self alone, never lookupRoom's way round for a server from before
  // it, which puts the key in a URL: a server without it has no repository
  // to compare, so its 404 is simply nothing to say
  const known = self ?? (await api('GET', `${conn.url}/rooms/self`, { room: conn.room, token: conn.token }));
  const said = { slugs, pick: onlyRepoOf(remotes), url: conn.url, committedRef: known.json?.room_ref || conn.roomRef || null };
  // a server from before rooms were connected this way says nothing of it
  if (known.ok && typeof known.json?.repo === 'string') {
    const bound = known.json.repo;
    if (remotes.some((r) => r.repo === bound.toLowerCase())) return { ...said, kind: 'same' };
    if (!slugs.length) return { ...said, kind: 'bound', bound };
    // A fork cloned with origin alone carries its original's config.json, so
    // its room is the original's, connected to a repository no remote here
    // names: the room working as it should. Nothing on this machine tells
    // that checkout from one whose config points at someone else's room; the
    // server does, from what GitHub said at sign-in, so ask it when we can.
    if (slugs.length === 1) {
      const asked =
        login && sameServer(login.url, conn.url)
          ? await api('GET', `${login.url}/api/lookup?repo=${encodeURIComponent(slugs[0])}`, { user: login.token })
          : null;
      if (asked?.json?.fork === true) return { ...said, kind: 'fork_of', bound };
      // no answer, a sign-in the server no longer takes, a closed server or a
      // broken one: none of them says this is not a fork
      const status = asked?.status ?? 0;
      if (!status || status === 401 || status === 403 || status >= 500) return { ...said, kind: 'elsewhere_unsure', bound };
    }
    return { ...said, kind: 'elsewhere', bound };
  }
  if (!login || !slugs.length) return null;
  if (!sameServer(login.url, conn.url)) return { ...said, kind: 'servers', loginUrl: login.url };
  const found = await Promise.all(
    slugs.map((slug) => api('GET', `${login.url}/api/lookup?repo=${encodeURIComponent(slug)}`, { user: login.token }))
  );
  const refs = found.map((res) => (res.ok && res.json?.room_ref) || null);
  if (said.committedRef && refs.includes(said.committedRef)) return { ...said, kind: 'same' };
  const other = refs.findIndex(Boolean);
  if (other !== -1) return { ...said, kind: 'two_rooms', slug: slugs[other], connectedRef: refs[other] };
  if (found.every((res) => res.status === 404 && res.json?.code === 'not_connected')) {
    // a checkout of a fork alone has only origin, and only the server, from
    // what GitHub said at sign-in, can tell it is one
    return { ...said, kind: found.every((res) => res.json?.fork === true) ? 'fork' : 'not_connected' };
  }
  return null;
}

/**
 * Say what roomSplit found, the same way in status, login and doctor. Null
 * when there was nothing to say; otherwise whether it is a problem, which
 * doctor counts: work going to a room nobody looks at, or a room open to a
 * repository that is not this one.
 */
function sayRoomSplit(split) {
  if (!split || split.kind === 'same') return null;
  const { slugs, url, committedRef } = split;
  // with no one repository to connect, connect is told which: your team's
  const fix = split.pick
    ? `fix: ${c.bold('npx agentmash connect')} ${c.dim('(binds the GitHub repo to the committed room, nothing to commit)')}`
    : `fix: ${c.bold('npx agentmash connect <owner/name>')} ` +
      c.dim("(naming your team's repository: binds it to the committed room, nothing to commit)");
  if (split.kind === 'elsewhere') {
    bad(
      `this room is connected to ${split.bound}, not ${slugs.join(' or ')}: ` +
        `everyone who can push to ${split.bound} reads and writes it, whatever its key`
    );
    info(`if that is not your team's repository: ${c.bold('npx agentmash disconnect')}`);
    // what the server knows of forks is what GitHub said at this machine's
    // last sign-in; a fork made since is news to it
    if (slugs.length === 1) {
      info(`if ${slugs[0]} is a fork of ${split.bound} made since you signed in: ${c.bold('npx agentmash login')}, then look again`);
    }
    return true;
  }
  if (split.kind === 'fork_of') {
    info(`${slugs[0]} is a fork of ${split.bound}: it reports to ${split.bound}'s room, with the key its config.json carries`);
    return false;
  }
  if (split.kind === 'elsewhere_unsure') {
    warn(`this room is connected to ${split.bound}, not ${slugs[0]}`);
    info(
      `that is expected in a fork of ${split.bound}. if this checkout is not one, everyone who can push to ` +
        `${split.bound} reads and writes the room: ${c.bold('npx agentmash disconnect')}`
    );
    return false;
  }
  if (split.kind === 'bound') {
    info(`this room is connected to ${split.bound}: everyone who can push to it reads and writes it, whatever its key`);
    return false;
  }
  if (split.kind === 'servers') {
    warn(`this checkout reports to ${url}, and this machine is signed in to ${split.loginUrl}: different servers`);
    // a machine has one sign-in, and its hooks go by it in every checkout
    info(
      `a machine is signed in to one server: ${c.bold(`npx agentmash login --server ${url}`)} moves it to this ` +
        `checkout's, and its hooks stop for every repository on ${split.loginUrl}`
    );
    return false;
  }
  if (split.kind === 'fork') {
    info(
      `${slugs.join(' and ')} ${slugs.length > 1 ? 'are forks' : 'is a fork'} on GitHub: a fork is not connected to ` +
        `the room its config.json names, and this checkout reports there with the key it carries`
    );
    return false;
  }
  if (split.kind === 'two_rooms') {
    bad(
      `two rooms for ${split.slug}: this checkout reports to ${committedRef} (committed .claude/agentmash/config.json); ` +
        `login and the website use ${split.connectedRef}`
    );
    info(fix);
    return true;
  }
  warn(
    `${slugs.length > 1 ? `none of ${slugs.join(', ')} is` : `${slugs[0]} is not`} connected on the website: ` +
      `login and the website do not know the room this checkout reports to`
  );
  info(fix);
  return false;
}

/** The URL a remote of `repo` fetches from, or null. */
function remoteUrl(repo, remote) {
  try {
    return (
      execFileSync('git', ['remote', 'get-url', remote], { cwd: repo, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * Say that GitHub knows `from` as `to` now: the repository was renamed or
 * transferred, and the remotes of this checkout that still name it get the
 * git command that points each one there, in the form its URL already has.
 * GitHub follows the old name for as long as nobody takes it, so git works
 * until then; agentmash goes by the new one, and says what that costs here.
 */
function sayMoved(repo, remotes, from, to) {
  const stale = remotes.filter((r) => r.repo === from);
  if (!stale.length) {
    warn(`GitHub moved ${from} to ${to}`);
    return;
  }
  const names = stale.map((r) => r.remote).join(' and ');
  warn(`GitHub moved ${from} to ${to}, and ${names} still ${stale.length > 1 ? 'say' : 'says'} ${from}${movedCost(repo, remotes, from, to)}`);
  for (const { remote } of stale) info(`point it there: ${c.bold(setUrlCommand(repo, remote, from, to))}`);
}

/**
 * What a remote still naming `from`, which GitHub moved to `to`, costs this
 * checkout until it is pointed there, as the end of sayMoved's line, or ''.
 * Pushes still work, so it reads as tidying, but the server knows the
 * repository by its new name only. With no room of its own, the checkout
 * reports where this machine's hooks look the room up, by origin or else its
 * one GitHub remote (repoSlug in hooks/lib.mjs): by the old name, nowhere.
 * One that carries a room reports there by its key all the same, and status,
 * doctor and login find the room connected to none of its remotes (roomSplit).
 */
function movedCost(repo, remotes, from, to) {
  if (readConfig(repo)?.room) {
    if (remotes.some((r) => r.repo === to)) return '';
    return `: status and doctor say its room is connected to another repository until a remote says ${to}`;
  }
  const github = remotes.filter((r) => r.github);
  const looked = github.find((r) => r.remote === 'origin') ?? (github.length === 1 ? github[0] : null);
  if (looked?.repo !== from) return '';
  return `: this machine's hooks find the room by ${looked.remote}, so nothing from this checkout reaches it until ${looked.remote} says ${to}`;
}

/** The git command that points `remote` of `repo` at `to` where it names `from`, in the form its URL has. */
function setUrlCommand(repo, remote, from, to) {
  const url = remoteUrl(repo, remote);
  const old = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return `git remote set-url ${remote} ${url && old.test(url) ? url.replace(old, to) : `https://github.com/${to}.git`}`;
}

/**
 * Why connect gives up on `slug` for want of push access, as the message to
 * die with: always after a sign-in this run, so what GitHub listed is what
 * it says now. An organization's repository adds what one that limits
 * third-party apps does (orgGrant). A person's repository that GitHub shows
 * nobody under that name (a private one, or none) may have moved, and its
 * old name leads only those who can see it to the new one: a sign-in an
 * organization keeps it from, like the one just made, hears nothing, so
 * nothing came back as moved. Under the signed-in person's own account that
 * is certain, as they can push to everything there: it was renamed,
 * transferred or deleted. Either way the remote and the organization's
 * access are what to put right, and both are said.
 */
async function noPushAccess(slug, refused, server, { repo, remotes, login }) {
  const refusal = `you could not push to ${slug} when you last signed in, and only someone who can connects it`;
  const org = await orgGrant(slug, refused, server);
  if (org) return [refusal, ...org].join('\n        ');
  if ((await repoVisibility(slug)).visibility === 'public') return refusal;
  const owner = slug.split('/')[0];
  const own = owner === String(login?.login ?? '').toLowerCase();
  return [
    own
      ? `GitHub lists no ${slug} you can push to, and ${owner} is your own account: it was renamed, transferred or deleted`
      : refusal,
    ...outOfSight(slug, {
      repo,
      remotes,
      grant: await grantLink(refused, server),
      lead: own ? 'if it moved' : undefined,
      after: ', then run: npx agentmash connect',
      then: `once it is granted, run: ${rerunCommand()}`,
    }),
  ].join('\n        ');
}

/**
 * What may keep `slug`, a person's repository GitHub shows nobody under that
 * name, out of a sign-in, as lines to print, the likelier first. Renamed or
 * transferred: the remotes still naming it get the git command that points
 * them at its new name, for the person to fill in, since GitHub tells only
 * those who can see it where it went (`lead` opens that line, `after` ends
 * it). Moved into an organization that limits third-party apps: a sign-in
 * cannot follow its old name there until an owner grants access, or approves
 * a request (grantSteps, ending with `then`; `grant` is grantLink's).
 */
function outOfSight(slug, { repo, remotes, grant, lead = `if ${slug} was renamed or transferred`, after = '', then }) {
  const stale = remotes.filter((r) => r.repo === slug);
  return [
    ...(stale.length
      ? [
          `${lead}, point ${stale.map((r) => r.remote).join(' and ')} at its new name: ` +
            `${stale.map(({ remote }) => c.bold(setUrlCommand(repo, remote, slug, '<owner>/<name>'))).join(' and ')}${after}`,
        ]
      : []),
    'if it moved into an organization that limits third-party apps, GitHub hides it from agentmash until an owner of that organization grants access',
    ...grantSteps(grant, null, then),
  ];
}

/**
 * What status and doctor say under the line that `slug`, the repository this
 * machine's hooks look the room up by, is not connected: the lookup (`found`,
 * on `server`) found no room for it. One this sign-in can push to (the
 * server says so as `can_push`) is simply not connected, which that line
 * says, and signing in again changes nothing. One it could not push to may
 * be listed by a sign-in now, if push access came since, which is said
 * first; but a sign-in lists it no more than the last did while an
 * organization that limits third-party apps keeps it out (orgGrant), or
 * while a remote of `repo` names it from before it was renamed or
 * transferred (outOfSight). Those are said too, or a sign-in is all anyone
 * would be sent round to, again and again. Where GitHub tells anyone where
 * it went, that is all there is to say (sayMoved). A server from before
 * `can_push` says nothing of a person's repository, so nothing is guessed
 * at there.
 */
async function sayLookupMiss(slug, found, server, repo) {
  if (found.json?.can_push === true) return;
  const again = () =>
    info(`already connected? you may not have been able to push to it when you signed in: run ${c.bold('npx agentmash login')} again`);
  // a fork they can push to is theirs: nothing hides it
  if (found.json?.fork) return again();
  const org = await orgGrant(slug, found, server, SIGN_IN_ONCE_GRANTED);
  if (org) {
    again();
    for (const line of org) info(line);
    return;
  }
  if (found.json?.can_push !== false || !repo) return again();
  const remotes = await checkoutRemotes(repo);
  const seen = await repoVisibility(slug);
  // a public repository's old name says where it went to anyone who asks
  if (seen.movedTo) return sayMoved(repo, remotes, slug, seen.movedTo);
  again();
  if (seen.visibility === 'public') return;
  for (const line of outOfSight(slug, { repo, remotes, grant: await grantLink(found, server), then: SIGN_IN_ONCE_GRANTED })) info(line);
}

/** orgGrant's answers, by repository: GitHub is asked once a run. */
const orgGrants = new Map();

/**
 * How the grant's lines end in status and doctor (sayLookupMiss), which find
 * the room by the repository: a sign-in after the grant is what lists it.
 */
const SIGN_IN_ONCE_GRANTED = 'once it is granted, run: npx agentmash login';

/**
 * What a refusal for want of push access to `slug` adds when its owner is a
 * GitHub organization, as lines to print, or null when the owner is a
 * person. An organization that limits third-party apps leaves its private
 * repositories out of everything GitHub lists for agentmash, so a member
 * who can push to one is refused as if they could not, until an owner of
 * the organization grants agentmash access, where grantLink says. Whether
 * the owner is an organization is asked of GitHub the way anyone can;
 * unanswered, the lines say "if".
 */
async function orgGrant(slug, refused, server, then = `once it is granted, run: ${rerunCommand()}`) {
  if (!orgGrants.has(slug)) {
    const owner = slug.split('/')[0];
    const org = await isOrganization(owner);
    orgGrants.set(slug, org === false ? null : { owner, org, grant: await grantLink(refused, server) });
  }
  const said = orgGrants.get(slug);
  if (!said) return null;
  const { owner, org, grant } = said;
  return [
    `${org ? `${owner} is an organization` : `if ${owner} is an organization`}: if it limits third-party apps, GitHub hides ` +
      `its private repositories from agentmash until an owner of ${owner} grants access`,
    ...grantSteps(grant, owner, then),
  ];
}

/**
 * Where the server's GitHub app is given an organization's access: the link
 * its no_access answer (`refused`) carries, or one made from /api/config on a
 * server older than that, since it names the server's own app. Null when
 * neither says.
 */
async function grantLink(refused, server) {
  if (typeof refused?.json?.grant_url === 'string') return refused.json.grant_url;
  const config = await api('GET', `${server}/api/config`);
  const id = config.json?.github_client_id;
  return typeof id === 'string' && id ? `https://github.com/settings/connections/applications/${encodeURIComponent(id)}` : null;
}

/**
 * How an organization's access is given to the server's GitHub app, from
 * `grant` (the app's page under the person's authorized apps, or null with
 * none to link to), as lines to print, the last ending with `then`. Only an
 * owner of the organization sees Grant on that page; a member sees Request,
 * and an owner approves the request in the settings of `owner` (null when
 * which organization is not known).
 */
function grantSteps(grant, owner, then) {
  const app = grant ? c.cyan(grant) : 'GitHub settings → applications → authorized OAuth apps → agentmash';
  const policy = owner
    ? `at ${c.cyan(`https://github.com/organizations/${encodeURIComponent(owner)}/settings/oauth_application_policy`)}`
    : "in the organization's settings → third-party access → OAuth application policy";
  return [
    `an owner grants it, anyone else requests it: ${app} → organization access → grant, or request`,
    `an owner approves a request ${policy}. ${then}`,
  ];
}

/**
 * `npx agentmash connect`: connect this checkout's GitHub repository to the
 * room it carries, the one committed in config.json, so login, the website
 * and every signed-in machine open the room its hooks report to. Nothing is
 * committed: it is one row on the server, for everyone at once. The room is
 * proved by its key, never its ref, and the repository by this machine's
 * GitHub sign-in. `npx agentmash connect owner/name` names the repository,
 * which a checkout with remotes for more than one has to.
 */
async function cmdConnect(args) {
  const repo = args.repo ? path.resolve(args.repo) : findRepoRoot() || process.cwd();
  const conn = requireConnection(repo);
  const remotes = await checkoutRemotes(repo);
  let slug = connectTarget(remotes, args._[0]);
  let login = readUserLogin();
  if (!login) die(`sign this machine in first: npx agentmash login --server ${conn.url}`);
  if (!sameServer(login.url, conn.url)) {
    die(
      `this checkout reports to ${conn.url}, and this machine is signed in to ${login.url} — ` +
        `a machine is signed in to one server: npx agentmash login --server ${conn.url} moves it to the ` +
        `checkout's, and its hooks stop for every repository on ${login.url}`
    );
  }
  console.log(`\n${c.bold('agentmash connect')} ${c.dim(`· ${slug} · ${conn.url}`)}\n`);
  const ask = () =>
    api('POST', `${conn.url}/api/connect/room`, {
      room: conn.room,
      user: login.token,
      body: { repo: slug, ...(args.replace ? { replace: true } : {}) },
    });
  // A machine keeps no GitHub token: what it can push to is what GitHub said
  // when it signed in. Signing it in again is how connect asks GitHub afresh,
  // once a run at most.
  let signedIn = false;
  // A repository renamed or transferred is listed under its new name, and a
  // remote can still say the old one: connect binds the new name, and says
  // how to point the remote there.
  const follow = (to) => {
    if (!to || to === slug) return false;
    sayMoved(repo, remotes, slug, to);
    slug = to;
    return true;
  };
  const signInAgain = async () => {
    signedIn = true;
    const stale = login;
    // GitHub is asked after the repository by name too, with this sign-in:
    // a private one's old name says where it went to nobody else
    const ready = await signInMachine(conn.url, args, { repos: [slug] });
    login = readUserLogin();
    // The sign-in just replaced was this machine's, and nothing reads it any
    // more: it is signed out on the server, so they do not pile up.
    if (login && login.token !== stale.token) await api('POST', `${conn.url}/api/logout`, { user: stale.token });
    follow(ready?.moved?.[slug]);
  };
  let res = await ask();
  if (res.status === 401 && res.json?.code === 'reauth') {
    // opening a room to a repository needs what GitHub said to be recent
    info('GitHub has to say again that you can push to it: signing this machine in once more');
    await signInAgain();
    res = await ask();
  }
  // a public repository's old name says where it went to anyone who asks
  if (res.json?.code === 'no_access' && follow((await repoVisibility(slug)).movedTo)) res = await ask();
  if (res.json?.code === 'no_access' && !signedIn) {
    // What GitHub listed at the last sign-in can be out of date: a repository
    // someone was given push access to since, or one in an organization that
    // has granted agentmash access since, is not on it until GitHub is asked
    // again. Refused on that list alone, connect used to give up there.
    info(`GitHub did not list ${slug} as one you can push to when this machine last signed in: signing it in once more, so GitHub says again`);
    // an owner can grant the organization's access before the browser is done: the sign-in reads the list then
    const grant = await orgGrant(slug, res, conn.url, 'granted before you finish signing in below, this sign-in sees it');
    if (grant) for (const line of grant) info(line);
    await signInAgain();
    res = await ask();
  }
  if (res.ok) {
    // what this machine's hooks looked up may be the room the repository just left
    fs.rmSync(path.join(agentmashHome(), 'rooms.json'), { force: true });
    ok(`${slug} → ${res.json.dashboard_url}`);
    if (res.json.already) info('it was connected to this room already: nothing changed');
    else if (res.json.replaced_ref) info(`it was connected to ${res.json.replaced_ref}; signed-in teammates follow it here on their own`);
    info('this checkout, login and the website open one room now, for everyone, with nothing to commit\n');
    return;
  }
  if (res.status === 0) die(`could not reach ${conn.url}\n        ${c.dim(res.text)}`);
  const code = res.json?.code;
  if (code === 'fork') {
    // A checkout of a fork alone has only origin, so nothing here could tell
    // before the server did, from what GitHub said when this machine signed in.
    bad(`${slug} is a fork on GitHub: a fork carries its original's config.json, key and all, so the server connects no fork to the room a key names`);
    info('this checkout reports to the room in its config.json with the key it carries already: there is nothing to connect here');
    info(`your team's room is connected from your team's repository, in a checkout of it\n`);
    process.exitCode = 1;
    return;
  }
  if (code === 'repo_taken') {
    bad(`${slug} is connected to another room, which has history of its own`);
    info(`this checkout's room  ${c.cyan(`${conn.url}/r/${res.json.committed_ref}`)}`);
    info(`the website's room    ${c.cyan(`${conn.url}/r/${res.json.connected_ref}`)}`);
    info(`to keep this checkout's: ${c.bold(`npx agentmash connect${args._[0] ? ` ${slug}` : ''} --replace`)}. the website's room stops opening`);
    info(`from ${slug}, and keeps what is in it for its owners\n`);
    process.exitCode = 1;
    return;
  }
  if (res.status === 404 && !code) die('this server is too old to connect a repository to the room it carries — upgrade it first');
  if (code === 'no_access') die(await noPushAccess(slug, res, conn.url, { repo, remotes, login }));
  const why = {
    signed_out: "this machine's sign-in has expired or was revoked — run: npx agentmash login",
    reauth: `GitHub still does not say you can push to ${slug} — run: npx agentmash login, then connect again`,
    room_key_rotated: "this checkout's room key has been rotated — pull for the current one, then connect again",
    room_unknown: `the room in .claude/agentmash/config.json does not open on ${conn.url}`,
  }[code];
  die(why || planRefusal(res) || `connect refused (HTTP ${res.status}) ${res.json?.error ?? ''}`);
}

/**
 * The GitHub repository `connect` connects the room to: `named`, which has to
 * be a remote of this checkout, or else the one GitHub repository all its
 * remotes name. With remotes for more than one, which is the team's is for
 * whoever runs it to say (onlyRepoOf), and a remote whose URL does not say
 * GitHub for sure, an SSH host alias, is connected only by name. Dies, saying
 * why, when there is no one repository to connect.
 */
function connectTarget(remotes, named) {
  const listed = remotes.map((r) => `${r.repo} (${r.remote})`).join(', ');
  if (named) {
    const repo = String(named).trim().replace(/\.git$/i, '').toLowerCase();
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) die('name the repository as owner/name: npx agentmash connect acme/app');
    if (!remotes.some((r) => r.repo === repo)) {
      // a remote still naming a repository by its name from before it moved
      // is followed by connect itself, from that name (see cmdConnect)
      const only = onlyRepoOf(remotes);
      die(
        `${repo} is not a remote of this checkout${listed ? ` (${listed})` : ''} — ` +
          `a room is connected to a repository its checkouts push to` +
          (only ? `\n        if ${only} moved to ${repo} on GitHub, a plain npx agentmash connect follows it there` : '')
      );
    }
    return repo;
  }
  const only = onlyRepoOf(remotes);
  if (only) return only;
  if (repoNamesOf(remotes).length > 1) {
    die(
      `this checkout has remotes for more than one repository: ${listed}. ` +
        `name the one the room is for, your team's: npx agentmash connect <owner/name>`
    );
  }
  if (remotes.length) {
    die(
      `no remote of this checkout is on github.com by its URL (${listed}): an SSH host alias, or another host. ` +
        `name the GitHub repository the room is for: npx agentmash connect <owner/name>`
    );
  }
  die('this checkout has no GitHub remote — a room is connected to a GitHub repository');
}

/**
 * `npx agentmash disconnect`: stop this room opening to everyone who can push
 * to the repository it is connected to. A new key does not do that, so this
 * is the other half of rotating a key that leaked.
 */
async function cmdDisconnect(args) {
  const repo = args.repo ? path.resolve(args.repo) : findRepoRoot() || process.cwd();
  const conn = requireConnection(repo);
  const res = await api('POST', `${conn.url}/rooms/disconnect`, { room: conn.room, token: conn.token });
  await assertSupported(res, 'disconnect a room from its repository', conn);
  if (!res.ok) die(`disconnect refused (HTTP ${res.status}) ${res.json?.error ?? ''}`);
  console.log('');
  if (res.json?.repo) {
    // a room that asks for a sign-in beside its key: no repository, nobody's sign-in, so nothing opens it
    ok(
      res.json.sign_in_required === true
        ? `${res.json.repo} no longer opens this room, and its key opens it only beside a sign-in that can push to the repository it is connected to: nothing opens it until it is connected again`
        : `${res.json.repo} no longer opens this room: its key does, and nothing else`
    );
    info(`to connect it again, from a checkout of it: ${c.bold('npx agentmash connect')}`);
    // and a copy of its key connects nothing there: the server lets in only whom the room vouched for
    if (res.json.sign_in_required === true) info('which only one of its owners, who connected it before, can run: a copy of its key connects nothing');
    console.log('');
  } else {
    ok('this room was not connected to any repository\n');
  }
}

async function cmdLogin(args) {
  // the one setup a developer does: sign this machine in, for every repository
  if (!args.room) return cmdLoginMachine(args);
  // a developer token is for the room a repository carries, and its ref is written into that config.json
  const repo = targetRepo(args, { strict: true });
  const conn = requireConnection(repo);
  const me = identity(repo);

  let roomRef = conn.roomRef;
  if (!roomRef) {
    const lookup = await lookupRoom(conn.url, conn.room, conn.token);
    roomRef = lookup.json?.room_ref;
    if (!roomRef) die((await keyTurnedAway(lookup, conn)) ?? 'this server is too old to issue developer tokens — upgrade it first');
    const config = { ...(conn.config ?? {}), room_ref: roomRef };
    writeConfig(repo, config);
  }

  // The GitHub path proves who you are; the fallback only proves you were
  // first. Prefer the former wherever the server can do it.
  if (!args.local) {
    const started = await api('POST', `${conn.url}/auth/cli/start`, {
      room: conn.room,
      body: { alias: me.who },
    });
    await assertSupported(started, 'sign in', conn);
    if (started.ok) {
      console.log(`\n${c.bold('Sign in with GitHub')}\n`);
      const seconds = codeSeconds(started.json);
      info(`open ${c.cyan(started.json.verify_url)}`);
      sayCode(started.json.code, seconds);
      info('this terminal is waiting');
      const signedIn = await waitForSignIn(conn.url, started.json.poll_token, seconds);
      writeToken(conn.url, roomRef, {
        token: signedIn.token,
        developer: signedIn.developer,
        alias: me.who,
        source: 'github',
        created_at: new Date().toISOString(),
      });
      console.log(`\n${c.bold('Signed in.')}`);
      ok(`events from this machine are now proven to be ${c.cyan(signedIn.developer)}`);
      ok(`token stored in ${c.dim(credentialsPath())} ${c.dim('(this machine only, never committed)')}\n`);
      return;
    }
    if (started.status !== 503) die(`sign-in refused (HTTP ${started.status}) ${started.json?.error ?? ''}`);
    warn('this server has no GitHub app configured — falling back to a first-use claim');
  }

  const developer = args.developer || me.who;
  const res = await api('POST', `${conn.url}/rooms/tokens`, {
    room: conn.room,
    body: { developer, alias: me.who },
  });
  await assertSupported(res, 'issue developer tokens', conn);
  if (res.status === 409) die(res.json?.error ?? 'this name is already enrolled from another machine');
  if (!res.ok) die(planRefusal(res) ?? `could not issue a token (HTTP ${res.status}) ${res.json?.error ?? ''}`);
  writeToken(conn.url, roomRef, {
    token: res.json.token,
    developer,
    alias: me.who,
    source: 'room-key',
    created_at: new Date().toISOString(),
  });
  console.log(`\n${c.bold('Enrolled.')}`);
  ok(`${c.cyan(developer)} is now bound to this machine for this room`);
  ok(`token stored in ${c.dim(credentialsPath())} ${c.dim('(this machine only, never committed)')}`);
  info('this proves first use, not identity — a server with GitHub sign-in proves more\n');
}

// Every mode only advises. The Stop hook used to block an agent's finish
// until it had reconciled, and to have it branch and open a pull request
// (approve) or commit (auto) on its own; with the permissions to, it did, for
// a teammate's change nobody had pushed. How two changes come together is a
// person's decision now, whatever the room is set to, and the two modes that
// once differed in what the agent did are kept, so a room set to either keeps
// working, and do the same.
const RECONCILE_EXPLAINED = {
  approve:
    'when a session finishes having changed a file a teammate also changed, agentmash tells the person once, ' +
    'with whose change it meets; a person decides what happens to the two, and the agent is never stopped',
  auto: 'the same as approve: agentmash tells the person once, as the session finishes, and a person decides',
  off: 'agentmash says nothing as a session finishes; overlaps show on the board and in get_collisions',
};

async function cmdReconcile(args) {
  const repo = args.repo ? path.resolve(args.repo) : findRepoRoot() || process.cwd();
  const conn = requireConnection(repo);
  const mode = args._[0];
  if (!mode) {
    const current = await api('GET', `${conn.url}/rooms/self`, { room: conn.room, token: conn.token });
    await assertSupported(current, 'report room settings', conn);
    if (!current.ok) die(`could not read room settings (HTTP ${current.status})`);
    const now = current.json.reconcile_mode ?? 'approve';
    console.log(`\n${c.bold('Reconciliation')}  ${c.cyan(now)}\n`);
    info(`${RECONCILE_EXPLAINED[now]}\n`);
    info(`change it with: agentmash reconcile <approve|auto|off>\n`);
    return;
  }
  if (!Object.hasOwn(RECONCILE_EXPLAINED, mode)) die('usage: agentmash reconcile <approve|auto|off>');
  const res = await api('POST', `${conn.url}/rooms/settings`, {
    room: conn.room,
    token: conn.token,
    body: { reconcile_mode: mode },
  });
  await assertSupported(res, 'change room settings', conn);
  if (!res.ok) die(`could not change settings (HTTP ${res.status}) ${res.json?.error ?? ''}`);
  console.log(`\n${c.bold('Updated.')} reconciliation ${c.cyan(res.json.reconcile_mode)}\n`);
  info(`${RECONCILE_EXPLAINED[res.json.reconcile_mode]}\n`);
}

async function cmdDiffs(args) {
  const repo = args.repo ? path.resolve(args.repo) : findRepoRoot() || process.cwd();
  const conn = requireConnection(repo);
  const want = args._[0];
  if (want !== undefined && want !== 'on' && want !== 'off') die('usage: agentmash diffs <on|off>');
  const explain = (on) =>
    on
      ? 'edits carry the changed text to the live view; it is shown live and kept in memory only, never written to disk on the server'
      : 'the live view shows who is where and what changed in a sentence; the changed text itself stays on each machine';
  if (want === undefined) {
    const current = await api('GET', `${conn.url}/rooms/self`, { room: conn.room, token: conn.token });
    await assertSupported(current, 'report room settings', conn);
    if (!current.ok) die(`could not read room settings (HTTP ${current.status})`);
    const on = current.json.stream_diffs === true;
    console.log(`\n${c.bold('Diff streaming')}  ${c.cyan(on ? 'on' : 'off')}\n`);
    info(`${explain(on)}\n`);
    info(`change it with: agentmash diffs <on|off> — any developer can still keep theirs home with AGENTMASH_DIFFS=0\n`);
    return;
  }
  const res = await api('POST', `${conn.url}/rooms/settings`, {
    room: conn.room,
    token: conn.token,
    body: { stream_diffs: want === 'on' },
  });
  await assertSupported(res, 'change room settings', conn);
  if (!res.ok) die(`could not change settings (HTTP ${res.status}) ${res.json?.error ?? ''}`);
  console.log(`\n${c.bold('Updated.')} diff streaming ${c.cyan(res.json.stream_diffs ? 'on' : 'off')}\n`);
  info(`${explain(res.json.stream_diffs === true)}\n`);
  if (res.json.stream_diffs) info('it takes effect for each agent at its next edit.\n');
}

async function cmdSecure(args) {
  const repo = args.repo ? path.resolve(args.repo) : findRepoRoot() || process.cwd();
  const conn = requireConnection(repo);
  const mode = args._[0];
  const body = {};
  // sign-in: the key opens the room only beside the sign-in of someone who
  // can push to its repository, the one-command upgrade for a room made
  // before init asked for that; key-only: the key alone again
  if (mode === 'sign-in' || mode === 'key-only') body.sign_in_required = mode === 'sign-in';
  else if (mode) {
    if (!['off', 'any', 'github'].includes(mode)) die('usage: agentmash secure <off|any|github|sign-in|key-only> [--retention-days N]');
    body.token_mode = mode;
  }
  const days = args['retention-days'];
  if (days !== undefined) {
    // Said here, in the CLI's words: Number('abc') went out as null, which the
    // server takes for its default, and its own refusal of 0 says "null"
    // where the CLI takes `default`.
    if (days !== 'default' && !(/^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 365)) {
      die(`--retention-days takes a number of days from 1 to 365, or default for the server's, not ${JSON.stringify(days)}`);
    }
    body.retention_days = days === 'default' ? null : Number(days);
  }
  if (Object.keys(body).length === 0) {
    const current = await api('GET', `${conn.url}/rooms/tokens`, { room: conn.room, token: conn.token });
    await assertSupported(current, 'report room settings', conn);
    if (!current.ok) die(`could not read room settings (HTTP ${current.status})`);
    console.log(`\n${c.bold('Room security')}  ${c.dim(`token_mode ${current.json.token_mode}`)}\n`);
    // a server from before rooms asked for a sign-in says nothing of it
    if (current.json.sign_in_required === true) ok(`the room key opens this room only beside the sign-in of someone who can push to its repository`);
    if (current.json.sign_in_required === false) {
      warn(
        'the room key alone opens this room: anyone who can read the repository holds it (a read-only collaborator, a fork, ' +
          `a CI log), and reads the room's prompts and posts claims with it. to need a sign-in beside it: ${c.bold('npx agentmash secure sign-in')}`
      );
    }
    for (const t of current.json.tokens) {
      const state = t.revoked ? c.dim('revoked') : c.green('live');
      console.log(`  ${c.cyan(t.developer)} ${c.dim(`${t.source} · ${state} · last used ${t.last_used ?? 'never'}`)}`);
    }
    if (current.json.tokens.length === 0) info('no developer tokens issued yet');
    console.log('');
    return;
  }
  const res = await api('POST', `${conn.url}/rooms/settings`, { room: conn.room, token: conn.token, body });
  await assertSupported(res, 'change room settings', conn);
  if (!res.ok) die(`could not change settings (HTTP ${res.status}) ${res.json?.error ?? ''}`);
  if (body.sign_in_required !== undefined) {
    // an older server answers with the settings it has, and none is this one
    if (typeof res.json.sign_in_required !== 'boolean') die("this server is too old to ask for a sign-in beside a room's key — upgrade the coordination server first");
    if (res.json.sign_in_required) {
      console.log(`\n${c.bold('Updated.')} the room key opens this room only beside the sign-in of someone who can push to its repository\n`);
      info(`every teammate signs in once on their machine: ${c.bold('npx agentmash login')}`);
      info('until they do, their agents\' reports are turned away, and each session says so as it starts\n');
      if (committedHooksPredateSignIn(repo)) {
        warn(
          'the hooks committed in .claude/agentmash are from before a room asked for a sign-in: older than cli 0.9 they send ' +
            'none, so every report is turned away even signed in, and later ones say nothing of why — run: npx agentmash init, ' +
            'then commit .claude\n'
        );
      }
    } else {
      console.log(`\n${c.bold('Updated.')} the room key alone opens this room again, to anyone who holds it\n`);
    }
    if (body.token_mode === undefined && body.retention_days === undefined) return;
  }
  console.log(`\n${c.bold('Updated.')} token_mode ${c.cyan(res.json.token_mode)}, retention ${c.cyan(res.json.retention_days ?? 'server default')} days\n`);
  if (res.json.token_mode !== 'off') {
    // each needs a token for this room, which only login --room gets: a bare login is for the website's rooms
    info('every teammate now needs to run: npx agentmash login --room');
    info('until they do, their edits stop being reported — silently, as always\n');
  }
}

async function cmdAudit(args) {
  const repo = args.repo ? path.resolve(args.repo) : findRepoRoot() || process.cwd();
  const conn = requireConnection(repo);
  const res = await api('GET', `${conn.url}/audit`, { room: conn.room, token: conn.token });
  await assertSupported(res, 'report an audit trail', conn);
  if (!res.ok) die(`could not read the audit trail (HTTP ${res.status})`);
  console.log(`\n${c.bold('AgentMash audit')} ${c.dim(`· ${res.json.room_ref}`)}\n`);
  if (res.json.deleted_at) {
    warn(`this room was deleted ${res.json.deleted_at} — what follows is all that is left of it`);
  }
  for (const entry of res.json.entries) {
    console.log(`  ${c.dim(entry.ts)}  ${c.bold(entry.action)}  ${c.cyan(entry.actor ?? '—')}`);
    if (entry.detail) console.log(`    ${c.dim(entry.detail)}`);
  }
  if (res.json.entries.length === 0) info('nothing recorded yet');
  console.log('');
}

async function cmdPurge(args) {
  const repo = args.repo ? path.resolve(args.repo) : findRepoRoot() || process.cwd();
  const conn = requireConnection(repo);
  // never a default: --yes confirms only a scope that was typed
  const scope = args._[0];
  if (scope !== 'prompts' && scope !== 'events') die('usage: agentmash purge <prompts|events> [--yes]');
  if (!args.yes) die(`this deletes ${scope} for the whole room and cannot be undone — re-run with --yes`);
  const res = await api('POST', `${conn.url}/rooms/purge`, { room: conn.room, token: conn.token, body: { scope } });
  await assertSupported(res, 'purge room data', conn);
  if (!res.ok) die(`purge refused (HTTP ${res.status}) ${res.json?.error ?? ''}`);
  console.log(`\n${c.bold('Purged.')} ${res.json.affected} row(s) of ${scope} removed. The room keeps working.\n`);
}

async function cmdDelete(args) {
  const repo = args.repo ? path.resolve(args.repo) : findRepoRoot() || process.cwd();
  const conn = requireConnection(repo);
  if (!args.yes) die('this deletes the room, its events and every developer token — re-run with --yes');
  const res = await api('DELETE', `${conn.url}/rooms`, { room: conn.room, token: conn.token });
  await assertSupported(res, 'delete rooms', conn);
  if (!res.ok) die(`deletion refused (HTTP ${res.status}) ${res.json?.error ?? ''}`);
  console.log(`\n${c.bold('Room deleted.')} ${res.json.events_removed} event(s) removed.\n`);
  if (res.json.audit_readable) {
    info(
      `the record of what was done to this room survives — ${c.bold('agentmash audit')} still reads it` +
        (res.json.audit_retention_days ? c.dim(` (for ${res.json.audit_retention_days} more days)`) : '')
    );
  }
  info('the hooks are still installed and now do nothing — run: agentmash init, or uninstall\n');
}

// ── crew teams ─────────────────────────────────────────────────────────────
// `agentmash crew` puts agents from the agentmash crew into the repo as a named
// team: agent files in .claude/agents, the shared skills, one skill per team,
// a guard hook, and a record of all of it in .claude/agentmash-crew/teams.json.
// It is not part of the room. It never calls the coordination server, needs no
// room, and works while the server is closed or unreachable.
//
// None of the planning happens here. The crew's own installer is vendored at
// crew/ by tools/sync-crew.mjs and imported as it is, so a team installed with
// this command is byte for byte the team the agentmash.dev pull request writes,
// and the crew's installer's but for each agent's model line, which the sync
// sets from tools/crew-models.json: all three run the same planChange.
//
// It was `agentmash team` until "team" came to mean too much at once: the
// people in a room, a paid plan and these subagents. `team` still runs it,
// saying the new name first, because the crew's own team skill, committed
// in every repository a team went into, tells an agent to run
// `npx agentmash team add`, and so does every page and pull request before.

const CREW_FILES = ['bundle.json', 'install.mjs', 'team-plan.mjs', 'crew.lock.json'];

// The bundle's meta.manifestPath. Kept as a constant so uninstall can look for
// it without loading a 300 KB bundle; the uninstall test installs a team the
// real way, so a bundle that moved the manifest fails that test.
const CREW_MANIFEST = path.join('.claude', 'agentmash-crew', 'teams.json');

/**
 * The vendored crew: the repo checkout's crew/ in dev, or the copy
 * sync-hooks.mjs packs into the published package. Checkout first, for the
 * reason hookSourceDir gives: cli/crew/ is a copy that goes stale the moment
 * someone syncs a new crew release.
 */
function crewSourceDir() {
  for (const candidate of [path.join(HERE, '..', 'crew'), path.join(HERE, 'crew')]) {
    if (CREW_FILES.every((f) => fs.existsSync(path.join(candidate, f)))) return candidate;
  }
  return null;
}

/**
 * The crew's installer module and its verified bundle. Throws instead of
 * dying, because doctor wants to say this as a warning. loadBundle checks the
 * sha256 of every file the bundle installs before anything is planned.
 */
async function loadCrew() {
  const dir = crewSourceDir();
  if (!dir) throw new Error('could not locate the crew files to install (broken package?)');
  const install = await import(pathToFileURL(path.join(dir, 'install.mjs')).href);
  return { install, bundle: install.loadBundle(path.join(dir, 'bundle.json')) };
}

// What each action takes. The rest of the CLI refuses a flag no command knows
// (refuseUnknownFlags); `crew` refuses one its action does not take as well,
// because an ignored `--dryrun` is a dry run that writes.
const TEAM_ACTIONS = {
  add: { name: true, flags: ['agents', 'slug', 'repo', 'dry-run', 'force'] },
  remove: { name: true, flags: ['agents', 'repo', 'dry-run', 'force'] },
  list: { name: false, flags: ['repo', 'json'] },
  update: { name: false, flags: ['repo', 'dry-run', 'force'] },
};
const TEAM_VALUE_FLAGS = ['agents', 'slug', 'repo'];
// parseArgs stores booleans under camelCase keys; turn them back into what was typed.
const FLAG_SPELLING = { dryRun: 'dry-run', noGitHook: 'no-git-hook', noOpen: 'no-open', forceHooksPath: 'force-hooks-path' };

const TEAM_ROW = { created: ok, updated: ok, deleted: ok, overwritten: warn, kept: warn, left: warn };

/** One line per file the plan touched (or would touch); unchanged files are only counted. */
function printTeamPlan(plan, dryRun) {
  const rows = plan.changes.filter((change) => change.action !== 'unchanged');
  if (plan.settings.action !== 'unchanged') rows.push({ path: plan.settings.path, action: plan.settings.action });
  if (plan.manifestAction !== 'unchanged') rows.push({ path: plan.manifestPath, action: plan.manifestAction });
  const width = Math.max(0, ...rows.map((row) => row.action.length));
  // A dry run's rows are what would happen, so none of them gets a ✓.
  for (const row of rows) {
    const mark = dryRun ? info : (TEAM_ROW[row.action] ?? info);
    mark(`${row.action.padEnd(width)}  ${c.dim(row.path)}`);
  }
  const same = plan.changes.filter((change) => change.action === 'unchanged').length;
  if (same > 0) info(`${same} file${same === 1 ? '' : 's'} unchanged`);
  for (const message of plan.warnings) warn(message);
  if (dryRun) info('dry run: nothing was written');
  else if (!plan.changed) info('nothing to change');
}

function printTeamSteps(steps) {
  console.log(`\n  ${c.bold('next:')}`);
  steps.forEach((step, i) => console.log(`    ${i + 1}. ${step}`));
  console.log('');
}

// Claude Code reads the project's .claude/settings.json, and with it the guard
// hook, only from the directory it starts in, while agents and skills also load
// from a subfolder. So the restart step names the repository root.
const TEAM_RESTART =
  'start a new Claude Code session at the repository root, so it loads the agents, skills and guard hook (the hook does not load when Claude Code starts in a subfolder)';

/**
 * Quotes a path for a POSIX shell, and for cmd and PowerShell too when the
 * path allows plain double quotes. On Windows a backslash does not stop them:
 * cmd keeps a POSIX shell's single quotes as part of the word, so a Windows
 * path in them names a folder that does not exist, while cmd, PowerShell and
 * Git Bash all take it in double quotes, a trailing backslash doubled so it
 * does not escape the closing quote.
 */
function shellQuote(value) {
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  if (process.platform === 'win32' && !/["$`!]/.test(value)) return `"${value.replace(/\\+$/, (tail) => tail + tail)}"`;
  if (!/["$`!\\]/.test(value)) return `"${value}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The commit steps, as the crew's own installer prints them. They stage exactly
 * the files the installer manages after this run (also those an earlier,
 * uncommitted run wrote) and the ones it deleted, so other work under .claude/
 * — including AgentMash's own hooks — and the files the plan kept or left
 * because someone changed them stay out of the commit. Deletions go through
 * `git rm --cached --ignore-unmatch`, because `git add` fails on a path that is
 * neither on disk nor tracked (a team removed before it was ever committed).
 * `git -C <root>` makes the commands work from any folder. One command to a
 * step, never joined with `&&`, which Windows PowerShell 5.1 does not have.
 */
function teamCommitSteps(plan, root, message) {
  const managed = plan.teams.length > 0;
  const added = [];
  const removed = [];
  const note = (rel, action) => {
    if (action === 'deleted') removed.push(rel);
    else if (['created', 'updated', 'overwritten'].includes(action) || (action === 'unchanged' && managed)) added.push(rel);
  };
  for (const change of plan.changes) note(change.path, change.action);
  note(plan.settings.path, plan.settings.action);
  note(plan.manifestPath, plan.manifestAction);

  const git = path.resolve(process.cwd()) === root ? 'git' : `git -C ${shellQuote(root)}`;
  const steps = [];
  if (added.length > 0) steps.push(`${git} add -- ${added.sort().join(' ')}`);
  if (removed.length > 0) steps.push(`${git} rm -q --cached --ignore-unmatch -- ${removed.sort().join(' ')}`);
  steps.push(`${git} commit -m "${message}"`);
  return steps;
}

const splitAgents = (value) => value.split(/[\s,]+/).filter(Boolean);

/**
 * `npx agentmash team`, crew's old name: the same command, after a line on
 * stderr with the new one, so the output a script reads (list --json) is
 * what it always was.
 */
function cmdTeamRenamed(args) {
  console.error(`  ${c.dim('·')} npx agentmash team is ${c.bold('npx agentmash crew')} now; team still works`);
  return cmdCrew(args);
}

async function cmdCrew(args) {
  const action = args._[0];
  const spec = Object.hasOwn(TEAM_ACTIONS, action ?? '') ? TEAM_ACTIONS[action] : null;
  if (!spec) {
    die(
      `${action ? `unknown crew command "${action}" — ` : ''}usage: agentmash crew <add|remove|list|update>\n` +
        `        e.g. npx agentmash crew add "agentmash crew" --agents pipe,flex,probe`
    );
  }
  for (const key of Object.keys(args)) {
    if (key === '_') continue;
    const flag = FLAG_SPELLING[key] ?? key;
    if (!spec.flags.includes(flag)) die(`--${flag} does not apply to crew ${action}`);
  }
  for (const flag of TEAM_VALUE_FLAGS) {
    const value = args[flag];
    if (Object.hasOwn(args, flag) && (typeof value !== 'string' || value.startsWith('--') || !value.trim())) {
      die(`--${flag} needs a value`);
    }
  }
  const rest = args._.slice(1);
  if (spec.name && rest.length === 0) die(`crew ${action} needs a team name, e.g. npx agentmash crew ${action} "agentmash crew"`);
  if (rest.length > (spec.name ? 1 : 0)) {
    die(
      spec.name
        ? `the team name must be one argument; quote it: npx agentmash crew ${action} "${rest.join(' ')}"`
        : `crew ${action} takes no arguments (got ${rest.join(' ')})`
    );
  }
  if (action === 'add' && args.agents === undefined) {
    die('crew add needs --agents, e.g. npx agentmash crew add "agentmash crew" --agents pipe,flex,probe');
  }

  // Any folder inside the repo will do; the crew's installer walks up to the
  // root itself, and refuses a home directory that happens to be a repo.
  const start = args.repo ? path.resolve(args.repo) : process.cwd();
  if (!findRepoRoot(start)) die("not inside a git repository — run this in your team's repo, or pass --repo <path>");

  let crew;
  try {
    crew = await loadCrew();
  } catch (err) {
    die(err.message);
  }
  const { install, bundle } = crew;
  const dryRun = Boolean(args.dryRun);
  const force = Boolean(args.force);

  // The installer validates everything before its first write and throws with
  // a message meant for people: a foreign file, a bad name, an unknown agent.
  const attempt = (fn) => {
    try {
      return fn();
    } catch (err) {
      die(err.message);
    }
  };

  if (action === 'list') {
    const { root, teams } = attempt(() => install.listTeams({ repo: start, bundle }));
    if (args.json) {
      console.log(JSON.stringify({ teams }, null, 2));
      return;
    }
    if (teams.length === 0) {
      console.log(`\n  no agentmash teams in ${c.dim(root)}\n`);
      return;
    }
    console.log('');
    for (const team of teams) {
      console.log(`  ${c.bold(team.name)} ${c.dim(`(${team.slug})`)}: ${team.members.map((m) => m.split('-')[0]).join(', ')}`);
    }
    console.log('');
    return;
  }

  let op;
  if (action === 'add') op = { type: 'add', name: rest[0], slug: args.slug, members: splitAgents(args.agents), force };
  else if (action === 'remove') {
    op = { type: 'remove', team: rest[0], members: args.agents === undefined ? undefined : splitAgents(args.agents), force };
  } else op = { type: 'update', force };

  const { root, plan } = attempt(() => install.runTeamOp({ repo: start, bundle, op, dryRun }));
  const team = plan.target;
  if (action === 'update') {
    const count = plan.teams.length;
    console.log(`\n${c.bold(`${count} team${count === 1 ? '' : 's'}`)}, agentmash-crew ${bundle.meta.version}\n`);
  } else if (team.members === null) {
    console.log(`\n${c.bold(`removed team ${team.name}`)} ${c.dim(`(${team.slug})`)}\n`);
  } else {
    console.log(`\n${c.bold(`team ${team.name}`)} ${c.dim(`(${team.slug})`)}: ${team.members.join(', ')}\n`);
  }
  printTeamPlan(plan, dryRun);
  if (dryRun || !plan.changed) {
    console.log('');
    return;
  }

  if (action === 'add') {
    printTeamSteps([
      ...teamCommitSteps(plan, root, `chore: ${plan.targetIsNew ? 'add' : 'update'} agentmash team ${team.name}`),
      TEAM_RESTART,
      `then say: ${team.name}, <your task>   (or type: /team-${team.slug} <your task>)`,
    ]);
  } else if (action === 'remove') {
    const message = team.members === null ? `chore: remove agentmash team ${team.name}` : `chore: update agentmash team ${team.name}`;
    printTeamSteps([...teamCommitSteps(plan, root, message), 'restart Claude Code in this repo so it reloads the agents']);
  } else {
    printTeamSteps([...teamCommitSteps(plan, root, `chore: update agentmash teams to ${bundle.meta.version}`), TEAM_RESTART]);
  }
}

/**
 * The crew section of doctor: whether teams.json parses, how many teams it
 * records, and which of the files it records no longer have the bytes it
 * wrote. Crew teams work without a room or a server, so nothing here is an
 * AgentMash problem: warnings at most, and doctor's verdict never changes.
 */
async function doctorCrew(repo) {
  if (pathKind(path.join(repo, CREW_MANIFEST)) === 'missing') return;
  let state;
  let bundle;
  try {
    const crew = await loadCrew();
    bundle = crew.bundle;
    // `update` is the operation that touches every file teams.json lists, so
    // its snapshot hashes exactly the files there are to compare.
    state = crew.install.readState(repo, bundle, { type: 'update' });
  } catch (err) {
    warn(`crew teams: ${err.message}`);
    return;
  }
  const { manifest } = state;
  if (!manifest) return; // removed between the look and the read
  const version = typeof manifest.source?.version === 'string' ? manifest.source.version : 'unknown version';
  const names = manifest.teams.map((team) => team.name).join(', ');
  ok(`crew teams: ${manifest.teams.length}  ${c.dim(`${names || 'none'} · agentmash-crew ${version}`)}`);

  const drifted = Object.keys(manifest.files).filter((file) => state.onDisk[file] !== manifest.files[file]);
  const missing = drifted.filter((file) => state.onDisk[file] === null);
  const changed = drifted.filter((file) => state.onDisk[file] !== null);
  if (missing.length > 0) {
    warn(`${missing.length} crew file${missing.length === 1 ? ' is' : 's are'} missing: ${missing.join(', ')}`);
    info(`${c.bold('npx agentmash crew update')} puts ${missing.length === 1 ? 'it' : 'them'} back`);
  }
  if (changed.length > 0) {
    warn(`${changed.length} crew file${changed.length === 1 ? '' : 's'} changed since install: ${changed.join(', ')}`);
    info(`fine if that was on purpose; ${c.bold('npx agentmash crew update --force')} puts the installed version back`);
  }

  let guarded = false;
  try {
    const settings = JSON.parse(state.settingsText ?? '{}');
    guarded = JSON.stringify(settings?.hooks?.[bundle.meta.hook.event] ?? []).includes(bundle.meta.hook.marker);
  } catch {
    /* an unparseable settings.json has no guard in it either */
  }
  if (manifest.teams.length > 0 && !guarded) {
    warn(`the crew guard hook is not in .claude/settings.json — ${c.bold('npx agentmash crew update')} adds it back`);
  }
}

/**
 * Words laid out in lines no wider than `width`, every line after the first
 * indented to `indent`: the help's agent list, which grows with agents/.
 */
function wrapped(words, indent, width = 96) {
  const lines = [''];
  for (const word of words) {
    const line = lines[lines.length - 1];
    if (line && indent + line.length + 1 + word.length > width) lines.push(word);
    else lines[lines.length - 1] = line ? `${line} ${word}` : word;
  }
  return lines.join(`\n${' '.repeat(indent)}`);
}

function usage() {
  // every agent login can connect, by name, in the order `tools` lists them
  const agentNames = Object.values(allAgents()).map((agent) => agent.name);
  const askedFor = Object.values(allAgents()).filter((agent) => agent.optIn).map((agent) => agent.name);
  const finds = `login connects every one it finds${askedFor.length ? `, ${andList(askedFor)} only when asked for` : ''}`;
  const agentList = wrapped(`${agentNames.join(', ')}; ${finds}`.split(' '), 33);
  console.log(`
${c.bold('agentmash')} — let your team see each other's work on one repository

  ${c.bold('npx agentmash init')}              create a room and wire up this repo
  ${c.bold('npx agentmash join')} <id|url>     point this repo at an existing room
  ${c.bold('npx agentmash doctor')}            check what is and isn't working
  ${c.bold('npx agentmash status')}            who is working on what, right now
  ${c.bold('npx agentmash git-hook')} [install|uninstall|status]
                                 the post-commit client, for teammates
                                 who are not using Claude Code
  ${c.bold('npx agentmash uninstall')}         remove the hooks from this repo
  ${c.bold('npx agentmash crew add')} <name> --agents <a,b|all>
                                 put agents from the crew in this repo as a
                                 named team; Mash conducts every team
  ${c.bold('npx agentmash crew remove')} <name> [--agents <a,b>]
                                 remove a team, or only the agents given
  ${c.bold('npx agentmash crew list')}         the teams installed here ${c.dim('(--json)')}
  ${c.bold('npx agentmash crew update')}       rewrite the team files from this version of the crew
                                 ${c.dim('(npx agentmash team, its old name, still works)')}
  ${c.dim('npx agentmash mcp')}               serve the MCP tools on stdio ${c.dim('(the server .mcp.json starts)')}

  ${c.bold('npx agentmash rotate')}            issue a new room key, old one on a grace period
  ${c.bold('npx agentmash revoke')}            end that grace period now
                                 ${c.dim("(--developer <name>: stop that name's tokens instead, so it can sign in elsewhere)")}
  ${c.bold('npx agentmash login')}             sign this machine in with GitHub, for every connected repo you can push to
                                 ${c.dim('(--room: in a committed install, prove this machine is you)')}
  ${c.bold('npx agentmash logout')}            sign this machine out and take agentmash back out of every agent
                                 ${c.dim('(--all: every other machine signed in as you too)')}
  ${c.bold('npx agentmash tools')} [add|remove <id>]  the coding agents on this machine:
                                 ${agentList}
  ${c.bold('npx agentmash token')} <create|list|revoke>  personal API tokens for /api/v1, made with this machine's
                                 sign-in ${c.dim('(npx agentmash token: its options)')}
  ${c.bold('npx agentmash ask')} teammate "text"   send a teammate in this repo's room a request for their agent:
                                 a suggestion, read only, that runs only if they accept it
  ${c.bold('npx agentmash inbox')} [show|accept|deny|cancel <id>]  requests waiting for you, and the ones
                                 you sent; accept gives you the text to paste into your own agent
  ${c.bold('npx agentmash hook')} --print-command --client <id> --event <event>
                                 the line to put in any agent's hook settings, for a tool agentmash
                                 has no connector for ${c.dim('(npx agentmash hook: its options)')}
  ${c.bold('npx agentmash scan')} [path]       how often this repo's agents changed the same files, from its git
                                 history ${c.dim('(npx agentmash scan --help: its options)')}
  ${c.bold('npx agentmash digest')} [--since 7d]  this repo's room over a week: who worked on what, where the agents
                                 collided, to the terminal, Slack or Telegram ${c.dim('(npx agentmash digest --help: its options)')}
  ${c.bold('npx agentmash connect')} [owner/name]  connect this repo, on the website, to the room it carries
                                 ${c.dim('(the name, when it has remotes for more than one, as a fork does)')}
  ${c.bold('npx agentmash disconnect')}        stop the room opening to whoever can push to its repo
  ${c.bold('npx agentmash secure')} <off|any|github>   require proven identities to write
                                 ${c.dim('(--retention-days: how long the room keeps its history)')}
  ${c.bold('npx agentmash secure sign-in')}    the room key opens the room only beside the sign-in of someone
                                 who can push to its repo ${c.dim('(secure key-only: the key alone again)')}
  ${c.bold('npx agentmash reconcile')} <approve|auto|off>  whether a finishing session that overlaps a teammate's says so
  ${c.bold('npx agentmash diffs')} <on|off>          stream the changed text to the live view (off by default)
  ${c.bold('npx agentmash audit')}             what was read and changed, by whom
  ${c.bold('npx agentmash purge')} <prompts|events>    delete what the room collected
  ${c.bold('npx agentmash delete')}            delete the room outright

  ${c.dim('--server <url>')}   coordination server ${c.dim(`(default ${DEFAULT_SERVER})`)}
  ${c.dim('--repo <path>')}    target repository   ${c.dim('(default: enclosing git repo)')}
  ${c.dim('--label <text>')}   name for the room   ${c.dim('(default: repo folder name)')}
  ${c.dim('--force')}          with init: replace an existing room
                   with crew: overwrite files changed locally or not written by the crew
  ${c.dim('--agents <a,b>')}   with crew: agents by short or full name (pipe, pipe-backend), or all
  ${c.dim('--slug <slug>')}    with crew add: folder name for the team skill ${c.dim('(default: from the name)')}
  ${c.dim('--dry-run')}        with crew: show what would change and write nothing
  ${c.dim('--allow-public-key')}
                   with init/join/rotate: commit the room key to a repository that is public on
                   GitHub, which they refuse otherwise: anyone who reads it can then read the room
  ${c.dim('--key-only')}       with init: a room its key alone opens, with no sign-in beside it, as rooms
                   made before this version did
  ${c.dim('--no-git-hook')}    with init/join: skip the post-commit client
  ${c.dim('--no-open')}        with init/join: do not open the browser
  ${c.dim('--force-hooks-path')}
                   with init/join/git-hook: install the git client into a core.hooksPath
                   inside the working tree, or one every repository shares (global);
                   with uninstall or git-hook uninstall: take it out of a shared one
  ${c.dim('--yes')}            with purge/delete: confirm, because it cannot be undone
  ${c.dim('--all')}            with logout: sign out every machine signed in as you, not this one alone
  ${c.dim('--grace-minutes')}  with rotate: how long the old key keeps working
  ${c.dim('--retention-days')} with secure: how many days of history the room keeps, 1 to 365
                   ${c.dim("(up to the plan's), or default for the server's")}
  ${c.dim('--developer')}      with revoke: whose tokens to stop; with login --room on a server with no
                   GitHub sign-in: the name this machine claims ${c.dim('(default: AGENTMASH_DEV, or git email)')}
  ${c.dim('--replace')}        with connect: move the repo here from a website room that has history
  ${c.dim('--skip <ids>')}     with login: leave these agents as they are ${c.dim('(codex,cursor)')}
  ${c.dim('--tools <ids>')}    with login: connect these agents, found or not, and no others

  ${c.dim('--version')}        print the installed version
`);
}

/**
 * The flags that take no value, as typed, and the key each is kept under.
 * Booleans have to be listed here: anything else takes the next token as its
 * value, so `crew add --dry-run "agentmash crew"` would lose the name.
 */
const BOOLEAN_FLAGS = {
  '--force': 'force',
  '--no-git-hook': 'noGitHook',
  '--no-open': 'noOpen',
  '--force-hooks-path': 'forceHooksPath',
  '--yes': 'yes',
  '--local': 'local',
  '--room': 'room',
  '--dry-run': 'dryRun',
  '--replace': 'replace',
  '--allow-public-key': 'allowPublicKey',
  '--key-only': 'keyOnly',
  '--all': 'all',
  '--json': 'json',
  '--help': 'help',
  '-h': 'help',
};

/** The flags that take a value, as typed. With BOOLEAN_FLAGS, every flag the shared parser knows. */
const VALUE_FLAGS = [
  '--server',
  '--repo',
  '--label',
  '--agents',
  '--slug',
  '--grace-minutes',
  '--retention-days',
  '--developer',
  '--skip',
  '--tools',
];

// Each flag as it was typed, with its value, kept beside the keys parseArgs
// files them under (which lose the spelling) for refuseUnknownFlags. A symbol,
// so crew's own check, which reads every key, never sees it.
const TYPED_FLAGS = Symbol('typed flags');

function parseArgs(argv) {
  const args = { _: [] };
  const typed = [];
  // The crew's own command refuses a flag given twice, and keeping the last
  // one would install a smaller team than was typed: --agents pipe --agents flex.
  const set = (key, value) => {
    if (Object.hasOwn(args, key)) die(`--${key} is given twice`);
    args[key] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    if (Object.hasOwn(BOOLEAN_FLAGS, token)) {
      args[BOOLEAN_FLAGS[token]] = true;
      typed.push({ flag: token });
    }
    // --agents=all as well as --agents all, as the crew's own command reads it.
    // A boolean spelled that way is refused, so --dry-run=false is not a yes.
    else if (eq > 2) {
      if (Object.hasOwn(BOOLEAN_FLAGS, token.slice(0, eq))) die(`${token.slice(0, eq)} takes no value`);
      typed.push({ flag: token.slice(0, eq), value: token.slice(eq + 1) });
      set(token.slice(2, eq), token.slice(eq + 1));
    } else if (token.startsWith('--')) {
      const value = argv[++i];
      typed.push({ flag: token, value });
      set(token.slice(2), value);
    } else args._.push(token);
  }
  args[TYPED_FLAGS] = typed;
  return args;
}

/**
 * A flag no command knows, or one that needs a value and has none, is
 * refused. Both used to be read as given and then ignored: `init --sever
 * <url>` made the room on the default server, and `rotate --grace-minutes`
 * with nothing after it rotated with the default grace.
 */
function refuseUnknownFlags(args) {
  for (const { flag, value } of args[TYPED_FLAGS] ?? []) {
    if (Object.hasOwn(BOOLEAN_FLAGS, flag)) continue;
    if (!VALUE_FLAGS.includes(flag)) {
      const meant = closestFlag(flag);
      die(`unknown option ${flag}${meant ? ` (did you mean ${meant}?)` : ''}`);
    }
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) die(`${flag} needs a value`);
  }
}

/** The known flag a mistyped one was most likely meant as: the start of it, or a letter or two off. Null when none is near. */
function closestFlag(typed) {
  const word = typed.replace(/^-+/, '');
  let best = null;
  let fewest = Infinity;
  for (const flag of [...VALUE_FLAGS, ...Object.keys(BOOLEAN_FLAGS)].filter((f) => f.startsWith('--'))) {
    const name = flag.slice(2);
    const edits = word.length >= 3 && name.startsWith(word) ? 0 : editDistance(word, name);
    if (edits < fewest) [best, fewest] = [flag, edits];
  }
  return fewest <= Math.max(1, Math.floor(word.length / 3)) ? best : null;
}

/** Edits from one word to another, two neighbours swapped counting as one: the typos a flag gets. */
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * How many words each command takes after its name. A command not listed
 * reads its own: crew (and team), tools, mcp and those in OWN_ARGS. A word a command
 * does not take used to be dropped, so `delete events --yes`, meant as a
 * purge, deleted the whole room. Now it is refused before anything is done.
 */
const COMMAND_WORDS = {
  init: 0,
  join: 1,
  doctor: 0,
  status: 0,
  'git-hook': 1,
  rotate: 0,
  revoke: 0,
  login: 0,
  logout: 0,
  connect: 1,
  disconnect: 0,
  secure: 1,
  reconcile: 1,
  diffs: 1,
  audit: 0,
  purge: 1,
  delete: 0,
  uninstall: 0,
};

function refuseExtraWords(command, words) {
  const takes = COMMAND_WORDS[command];
  if (takes === undefined || words.length <= takes) return;
  const extra = words.slice(takes).map((word) => JSON.stringify(word)).join(' ');
  die(
    `unexpected ${extra} after ${[command, ...words.slice(0, takes)].join(' ')}, which takes ${takes ? 'one word' : 'no words'}: ` +
      `nothing was done — npx agentmash --help says what each command takes`
  );
}

/** Read from the package we were installed as, so `--version` is the published one. */
function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const [, , command, ...rest] = process.argv;
// token, hook, ask and inbox read their own arguments, raw (token.mjs,
// hook.mjs, inbox.mjs): to the shared parser --read-only and --print-command
// would take the next word as their value, a second --repo would end the
// command, and a request's own words could read as flags. scan hands its
// words, as they are, to agentmash-scan (scan.mjs), which reads them itself,
// and digest to the digest the package carries (digest.mjs).
const OWN_ARGS = new Set(['token', 'hook', 'ask', 'inbox', 'scan', 'digest']);

/**
 * The room a teammate request goes through, for ask and inbox: the one this
 * checkout reports to, by its ref, with this machine's sign-in to the server
 * it is on. { server, ref, token, login, repo }, or { problem } saying what is
 * missing and what fixes it. The sign-in is the person: only someone who can
 * push to the room's repository sends, receives or answers a request, and the
 * server goes by who signed in, never by a name a checkout reports.
 */
async function inboxRoom(repoArg) {
  const repo = repoArg ? path.resolve(repoArg) : findRepoRoot();
  if (!repo || !findRepoRoot(repo)) {
    return { problem: `${repo || process.cwd()} is not inside a git repository — run this in your team's repository, or pass --repo <path>` };
  }
  const login = readUserLogin();
  if (!login?.token?.startsWith('amu_')) {
    return {
      problem:
        'this machine is not signed in — run: npx agentmash login. a request to a teammate is sent and answered as you, ' +
        'by your GitHub sign-in, and never with a room key alone',
    };
  }
  const conn = connection(repo);
  if (conn.url && conn.room) {
    // a repository install: its room, on its server, which has to be the one this machine signed in to
    if (!sameServer(login.url, conn.url)) {
      return { problem: `this machine is signed in to ${login.url}, and this repository's room is on ${conn.url} — run: npx agentmash login --server ${conn.url}` };
    }
    let ref = conn.roomRef || (conn.room.startsWith('rm_') ? conn.room : '');
    if (!ref) {
      // a config from before room_ref was written: the room says its own ref, to its key
      const res = await api('GET', `${conn.url}/api/v1/room`, { room: conn.room, token: conn.token });
      ref = typeof res.json?.room_ref === 'string' && res.json.room_ref.startsWith('rm_') ? res.json.room_ref : '';
      if (!ref) return { problem: `could not ask ${conn.url} which room this is ${c.dim(res.json?.error ?? `HTTP ${res.status}`)} — npx agentmash doctor says why` };
    }
    // the repository by its GitHub name where the checkout has one, for the inbox's heading
    const named = (await hooksLib())?.repoSlug?.(repo) ?? null;
    return { server: conn.url.replace(/\/+$/, ''), ref, token: login.token, login: login.login || '', repo: named || path.basename(repo) };
  }
  const found = await signedInRoom(repo, login);
  if (found.problem) return { problem: found.problem };
  return { server: found.server, ref: found.ref, token: login.token, login: login.login || found.developer || '', repo: found.slug };
}

/**
 * A signed-in machine's room for a checkout: the one its GitHub repository is
 * connected to, looked up with the machine's sign-in. { server, ref, slug,
 * label, developer }, or { problem, unreached } saying what is missing and
 * what fixes it, `unreached` when the server gave no answer to go by.
 */
async function signedInRoom(repo, login) {
  const lib = await hooksLib();
  const slug = lib?.repoSlug?.(repo) ?? null;
  if (!slug) {
    return {
      problem: `${repo} has no room: it is not set up with npx agentmash init, and has no GitHub remote this machine's sign-in could find a room by`,
    };
  }
  const found = await api('GET', `${login.url}/api/lookup?repo=${encodeURIComponent(slug)}`, { user: login.token });
  if (isReauth(found)) return { problem: REAUTH_PAUSED };
  if (found.status === 401) return { problem: `this machine's sign-in has expired or was revoked — run: npx agentmash login` };
  if (!found.ok || typeof found.json?.room_ref !== 'string') {
    return {
      problem:
        found.json?.code === 'not_connected'
          ? `${slug} is not connected to a room, or you could not push to it when you last signed in — connect it at ${login.url}/install, or run: npx agentmash login`
          : `could not look ${slug} up on ${login.url} ${c.dim(found.json?.error ?? (found.status ? `HTTP ${found.status}` : found.text))}`,
      unreached: found.status === 0 || found.status >= 500,
    };
  }
  return {
    server: String(login.url).replace(/\/+$/, ''),
    ref: found.json.room_ref,
    slug,
    label: typeof found.json.label === 'string' ? found.json.label : null,
    developer: found.json.developer || '',
  };
}

/**
 * The room `npx agentmash digest` reads, from what the digest found itself
 * (--server and --room, AGENTMASH_URL and AGENTMASH_ROOM, or the committed
 * config.json). A room key gets this machine's sign-in beside it, to the
 * key's own server only (signInBesideKey), which a room that asks for one
 * needs; a ref gets it too, on that server. With neither, it is the room
 * the checkout's GitHub repository is connected to, by its ref, read with
 * the sign-in, as ask and inbox find theirs. { server, room, user, label },
 * or { problem, code } for the digest to say: code 2 is a usage mistake, 1
 * a server that did not answer.
 */
async function digestRoom({ repo, server, room }) {
  const login = readUserLogin();
  const signedIn = login?.token?.startsWith('amu_') ? login : null;
  if (room) {
    const url = (server || DEFAULT_SERVER).replace(/\/+$/, '');
    if (!room.startsWith('rm_')) return { server: url, room, user: signInBesideKey(`${url}/events`, room) || null };
    if (signedIn && sameServer(signedIn.url, url)) return { server: url, room, user: signedIn.token };
    // a ref names a room and opens nothing: without the sign-in the server would only say the key is missing
    return {
      problem: `${room} is a room's ref, which opens it only beside this machine's sign-in to ${url} — run: npx agentmash login${sameServer(url, DEFAULT_SERVER) ? '' : ` --server ${url}`}`,
      code: 2,
    };
  }
  if (!signedIn) {
    return {
      problem:
        'no room to read — run this in a repository set up with npx agentmash init, or one connected on the website ' +
        'with this machine signed in (npx agentmash login), or pass --server and --room',
      code: 2,
    };
  }
  if (server && !sameServer(signedIn.url, server)) {
    return { problem: `this machine is signed in to ${signedIn.url}, not ${server} — run: npx agentmash login --server ${server}, or pass --room`, code: 2 };
  }
  if (!repo) {
    return { problem: `${process.cwd()} is not inside a git repository — run this in your team's repository, or pass --repo <path>`, code: 2 };
  }
  const found = await signedInRoom(repo, signedIn);
  if (found.problem) return { problem: found.problem, code: found.unreached ? 1 : 2 };
  return { server: found.server, room: found.ref, user: signedIn.token, label: found.label };
}

const commands = {
  init: cmdInit,
  join: cmdJoin,
  doctor: cmdDoctor,
  status: cmdStatus,
  'git-hook': async (a) => cmdGitHook(a),
  rotate: cmdRotate,
  revoke: cmdRevoke,
  login: cmdLogin,
  logout: cmdLogout,
  connect: cmdConnect,
  disconnect: cmdDisconnect,
  secure: cmdSecure,
  reconcile: cmdReconcile,
  diffs: cmdDiffs,
  audit: cmdAudit,
  purge: cmdPurge,
  delete: cmdDelete,
  uninstall: async (a) => cmdUninstall(a),
  crew: cmdCrew,
  team: cmdTeamRenamed,
  mcp: cmdMcp,
  tools: cmdTools,
  token: () => import('./token.mjs').then((m) => m.cmdToken(rest)),
  hook: () => import('./hook.mjs').then((m) => m.cmdHook(rest)),
  ask: () => import('./inbox.mjs').then((m) => m.cmdAsk(rest, { roomOf: inboxRoom })),
  inbox: () => import('./inbox.mjs').then((m) => m.cmdInbox(rest, { roomOf: inboxRoom })),
  scan: () => import('./scan.mjs').then((m) => m.cmdScan(rest)),
  digest: () => import('./digest.mjs').then((m) => m.cmdDigest(rest, { roomOf: digestRoom })),
};

// Every way out of a command is a return, or die(), which main's caller
// catches: the process ends when nothing is left open, with exitCode set,
// and never by process.exit() (see die).
async function main() {
  const args = OWN_ARGS.has(command) ? { _: [] } : parseArgs(rest);
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(version());
    return;
  }
  if (!command && !args.help) {
    // Bare `npx agentmash`: the person is standing in a repo wondering what to
    // do. Tell them that, not the whole manual — which --help still is.
    const repo = findRepoRoot();
    const config = repo ? readConfig(repo) : null;
    if (repo && !config?.room) {
      nudge();
      return;
    }
    if (repo && config?.room) {
      console.log(`
  This repo is connected.  ${c.bold('Dashboard')}  ${c.cyan(await dashboardLink(config))}`);
      console.log(`  ${c.bold('npx agentmash status')} says who is here; ${c.dim('--help')} lists the rest.
`);
      return;
    }
  }
  if (args.help || !command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }
  const handler = Object.hasOwn(commands, command) ? commands[command] : null;
  if (!handler) {
    console.error(`unknown command: ${command}`);
    usage();
    process.exitCode = 1;
    return;
  }
  // crew (and team, its old name) says which of the flags each of its actions
  // takes itself, and mcp starts whatever a client's settings hand it: a
  // refusal there would be an MCP server that never starts, which nobody sees
  if (!['crew', 'team', 'mcp'].includes(command)) refuseUnknownFlags(args);
  refuseExtraWords(command, args._);
  await handler(args);
}

main().catch(failed);
