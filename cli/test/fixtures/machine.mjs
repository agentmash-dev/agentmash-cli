// A machine for the tests of what `npx agentmash login` does to the coding
// agents on it: a home of its own, with Codex, Cursor and Copilot set up in
// it the way a person leaves them, the agents' commands replaced by
// stand-ins that record what they were asked (AGENTMASH_TOOL_PATH is where
// the CLI looks for them), and a server that signs the machine in at once.
// Nothing here may touch the real ~/.codex, ~/.cursor or ~/.copilot, or any
// folder an agent finds through the environment: every variable an agent
// module declares (its `env`) is cleared before the CLI runs.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENTS } from '../../tools.mjs';

export const CLI_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const CLI = path.join(CLI_DIR, 'agentmash.mjs');
export const TOKEN = 'amu_toolstokentoolstokentoolsxx';

/** The environment variables that point the CLI at someone's real configuration. */
export const CLEARED = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_PROJECT_DIR',
  'CODEX_HOME',
  'COPILOT_HOME',
  ...Object.values(AGENTS).flatMap((agent) => agent.env ?? []),
];

export const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTMASH_') && !CLEARED.includes(k))
);

/** Run the CLI: { code, stdout, stderr }. */
export function run(args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** A server that signs the machine in at once. */
export function startServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({ method: req.method, path: url.pathname, user: req.headers['x-agentmash-user'] });
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      const base = `http://127.0.0.1:${server.address().port}`;
      if (url.pathname === '/auth/cli/start') return send(201, { code: 'ABCD-EFGH', poll_token: 'poll', verify_url: `${base}/auth/github?cli=ABCD-EFGH` });
      if (url.pathname === '/auth/cli/token') return send(200, { status: 'ready', token: TOKEN, developer: 'bob', connected: [] });
      if (url.pathname === '/api/whoami') return send(200, { login: 'bob', connected: [] });
      if (url.pathname === '/api/lookup') return send(404, { error: 'not connected', code: 'not_connected' });
      if (url.pathname === '/api/logout') return send(200, { ok: true });
      if (url.pathname === '/healthz') return send(200, { ok: true });
      return send(404, { error: 'not here' });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) }))
  );
}

/**
 * What each stand-in does beyond logging its arguments: `codex mcp
 * add|remove` edits config.toml as Codex does, and `code --add-mcp` adds to
 * VS Code's user mcp.json as VS Code does. Each is the body of an ES module
 * with fs, os and path in scope.
 */
export const STAND_INS = {
  codex: `
      const [cmd, sub, name, , ...rest] = process.argv.slice(2);
      if (cmd === '--version') { console.log('codex-cli 0.160.0'); process.exit(0); }
      const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
      let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch {}
      if (cmd === 'mcp' && sub === 'add') fs.writeFileSync(file, text + '\\n[mcp_servers.' + name + ']\\ncommand = ' + JSON.stringify(rest[0]) + '\\nargs = ' + JSON.stringify(rest.slice(1)).replace(/,/g, ', ') + '\\n');
      if (cmd === 'mcp' && sub === 'remove') fs.writeFileSync(file, text.replace(/\\n\\[mcp_servers\\.agentmash\\]\\ncommand = [^\\n]*\\nargs = [^\\n]*\\n/, ''));`,
  code: `
      if (process.argv[2] === '--add-mcp') {
        const entry = JSON.parse(process.argv[3]);
        const dir = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User') : process.platform === 'win32' ? path.join(process.env.APPDATA, 'Code', 'User') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Code', 'User');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'mcp.json');
        let config = {}; try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
        const { name, ...server } = entry;
        config.servers = { ...(config.servers || {}), [name]: { type: 'stdio', ...server } };
        fs.writeFileSync(file, JSON.stringify(config, null, 2));
      }`,
  copilot: `if (process.argv[2] === '--version') console.log('GitHub Copilot CLI 1.0.91.');`,
};

/**
 * Stand-ins for the agents' own commands, in a folder of their own: each of
 * `names` logs its arguments to calls.log in `home`, then does what
 * `scripts` says for it (nothing, for a name it does not have).
 */
export function standIns(home, names, scripts = STAND_INS) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-tools-bin-'));
  const log = path.join(home, 'calls.log');
  for (const name of names) {
    command(
      bin,
      name,
      `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';\n` +
        `fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + ' ' + JSON.stringify(process.argv.slice(2)) + '\\n');\n` +
        (scripts[name] ?? '')
    );
  }
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

/**
 * A command called `name` in `bin` that runs `script`, an ES module, with
 * this node; its path. On POSIX it is the script itself, with node on its #!
 * line. Windows reads no #! line and finds a command by the extensions in
 * PATHEXT (agent-kit.mjs, which), so there it is the script as name.mjs
 * beside a name.cmd that runs it, as npm's shims do.
 */
export function command(bin, name, script) {
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, `${name}.mjs`), script);
    const shim = path.join(bin, `${name}.cmd`);
    fs.writeFileSync(shim, `@"${process.execPath}" "%~dp0${name}.mjs" %*\r\n`);
    return shim;
  }
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${script}`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** What is already in each agent's settings, which must come through login and logout untouched. */
export const THEIRS = {
  codexHooks: { hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'echo my-codex-hook' }] }] } },
  codexConfig: 'model = "gpt-5.5-codex"\n\n[projects."/Users/someone/app"]\ntrust_level = "trusted"\n',
  cursorHooks: { version: 1, hooks: { afterFileEdit: [{ command: './my-formatter.sh' }] } },
  cursorMcp: { mcpServers: { sentry: { command: 'npx', args: ['sentry-mcp'] } } },
};

/**
 * A home with Codex, Cursor and Copilot in it, Claude Code's settings, and
 * `with` the commands on the tool path (`scripts` for stand-ins of an agent's
 * own, beside STAND_INS).
 */
export function machine({ with: names = ['codex', 'code'], codex = true, cursor = true, copilot = true, scripts = {} } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-tools-home-')));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
  if (codex) {
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), JSON.stringify(THEIRS.codexHooks, null, 2));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), THEIRS.codexConfig);
  }
  if (cursor) {
    fs.mkdirSync(path.join(home, '.cursor'));
    fs.writeFileSync(path.join(home, '.cursor', 'hooks.json'), JSON.stringify(THEIRS.cursorHooks));
    fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify(THEIRS.cursorMcp));
  }
  if (copilot) fs.mkdirSync(path.join(home, '.copilot'));
  const tools = standIns(home, names, { ...STAND_INS, ...scripts });
  const env = {
    HOME: home,
    USERPROFILE: home,
    AGENTMASH_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    AGENTMASH_TOOL_PATH: tools.bin,
    AGENTMASH_APPS_DIR: path.join(home, 'Applications'),
    // where VS Code keeps its user folder off macOS: a CI runner sets
    // XDG_CONFIG_HOME to its own, which would take the test out of this home
    XDG_CONFIG_HOME: path.join(home, '.config'),
    // and where agents keep their folders on Windows, which would otherwise be the real ones there
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  };
  return { home, env, calls: tools.calls, hookDir: path.join(home, '.agentmash', 'hooks') };
}

/**
 * A pattern for what the CLI prints, with the paths in the home written as
 * this OS writes them. The tests write ~/.codex/hooks.json; agent-kit.mjs's
 * shown() prints ~\.codex\hooks.json on Windows. So there, and only there,
 * each / in a path of the pattern (one that starts at ~ or at a dot folder,
 * as .agentmash/hooks) becomes a \, and each OS is held to exactly what it
 * prints. A / anywhere else, as in `type /hooks`, stays.
 */
export function shownHere(pattern) {
  if (process.platform !== 'win32') return pattern;
  return new RegExp(pattern.source.replace(/(?:~|\\\.)(?:\\[/.]|[\w-])+/g, (p) => p.replaceAll('\\/', '\\\\')), pattern.flags);
}

export const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const md5 = (file) => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
/** A command of ours: it runs a script from a .agentmash/hooks folder. */
export const OURS = /[\\/]\.agentmash[\\/]hooks[\\/]/;
/**
 * Whether an agent's file, its text or a value read from it, has a command of
 * ours in it, with a Windows path's backslashes doubled as JSON writes them.
 */
export const runsOurs = (value) => OURS.test((typeof value === 'string' ? value : JSON.stringify(value)).replaceAll('\\\\', '\\'));
/** VS Code's user mcp.json in `home` (on Windows in %APPDATA%, which machine() puts in the home). */
export const vscodeMcp = (home) =>
  process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
    : process.platform === 'win32'
      ? path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json')
      : path.join(home, '.config', 'Code', 'User', 'mcp.json');
