// What a stranger actually gets from `npx agentmash`.
//
// Everything here works from the built tarball rather than the checkout, because
// the checkout hides the two ways publishing breaks: a file that never made it
// into `files`, and hooks that quietly drift from the ones the web installer
// commits. The install-plan module imported here is the server-side installer's
// own code, so "byte-identical" is checked against the real thing.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOM, startMockServer } from './mock-server.mjs';
import { AGENTS } from '../tools.mjs';
// The files the web installer on agentmash.dev commits into a repo (its
// install-plan); listed here since the server isn't part of this repository.
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
const INSTALLED_FILES = [...HOOK_FILES, 'mcp_launcher.mjs', 'mcp_server.mjs', 'mcp_coordination.mjs', 'mcp_render.mjs'];

const CLI_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(CLI_DIR);
const PKG = JSON.parse(fs.readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8'));

// INSTALLED_FILES is HOOK_FILES plus the MCP launcher and the server it starts;
// mcp/server.mjs is that server where a launcher from before it shipped with
// the hooks looks for it, in node_modules/agentmash. Both are vendored into
// cli/ by sync-hooks.mjs.
const MCP_FILES = ['server.mjs'];
// The other protocol clients the package vendors, source-relative under clients/.
const PACKED_CLIENT_FILES = ['git/post_commit.mjs', 'cursor/after_file_edit.mjs', 'amp/plugin.mjs'];
// The vendored crew `agentmash crew` installs from; README.md carries its MIT notice.
const CREW_FILES = ['README.md', 'bundle.json', 'crew.lock.json', 'install.mjs', 'team-plan.mjs'];
// The digest `agentmash digest` runs: its command line and what it loads, not its bin.
const DIGEST_FILES = ['src/aggregate.mjs', 'src/cli.mjs', 'src/net.mjs', 'src/render.mjs'];
// Every agent login connects is a module in cli/agents/, and every dialect of
// the generic hook a file in hooks/dialects/: each one in its folder ships,
// with no list of them anywhere to forget to add a new one to.
const filesIn = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
const AGENT_FILES = filesIn(path.join(CLI_DIR, 'agents'));
// Beside the hooks a repository install commits, what only a login copies to
// ~/.agentmash/hooks: the generic hook, and the dialects it answers in.
const MACHINE_HOOK_FILES = ['agent_hook.mjs', ...filesIn(path.join(REPO, 'hooks', 'dialects')).map((f) => `dialects/${f}`)];
const EXPECTED_FILES = [
  'LICENSE',
  'README.md',
  'agentmash.mjs',
  'tools.mjs',
  'agent-kit.mjs',
  'token.mjs',
  'inbox.mjs',
  'scan.mjs',
  'digest.mjs',
  'visibility.mjs',
  'hook.mjs',
  ...AGENT_FILES.map((f) => `agents/${f}`),
  'toml.mjs',
  ...INSTALLED_FILES.map((f) => `hooks/${f}`),
  ...MACHINE_HOOK_FILES.map((f) => `hooks/${f}`),
  ...MCP_FILES.map((f) => `mcp/${f}`),
  ...PACKED_CLIENT_FILES.map((f) => `clients/${f}`),
  ...CREW_FILES.map((f) => `crew/${f}`),
  ...DIGEST_FILES.map((f) => `digest/${f}`),
  'package.json',
].sort();

// Git reads the global config of whoever runs the tests, and a global
// core.hooksPath (a ~/.githooks every repository shares) is where init would
// put the post-commit client and uninstall would take it from. An empty global
// config keeps every git call inside the temporary repositories.
const EMPTY_GITCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-pack-git-')), 'gitconfig');
fs.writeFileSync(EMPTY_GITCONFIG, '');

// A home of its own too: the hooks run below log a report the mock server
// turns away under ~/.agentmash, which must not be the developer's.
const baseEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTMASH_') && k !== 'CLAUDE_PROJECT_DIR')
  ),
  GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  AGENTMASH_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-pack-home-')),
};

// On Windows npm is npm.cmd and the installed bin is agentmash.cmd. Node has
// refused to spawn .cmd without a shell since the 2024 argument-injection fix,
// but a shell re-joins argv on spaces — which silently turned
// `--label "team repo"` into two arguments. Quote anything with whitespace so
// the argument boundaries survive the round trip.
const NEEDS_SHELL = process.platform === 'win32';
const shellSafe = (args) =>
  NEEDS_SHELL ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;

function npm(args, cwd) {
  return execFileSync('npm', shellSafe(args), {
    cwd,
    env: baseEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: NEEDS_SHELL,
  });
}

/** Build the real tarball once and install it the way a stranger would. */
let pack;
before(() => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-pack-')));
  // The `prepare` script prints to stdout ahead of npm's JSON, so start at the array.
  const raw = npm(['pack', '--json', '--pack-destination', dir, '-w', 'cli'], REPO);
  const meta = JSON.parse(raw.slice(raw.indexOf('[')))[0];

  const home = path.join(dir, 'stranger');
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(home, 'package.json'),
    JSON.stringify({ name: 'stranger', private: true, version: '1.0.0' })
  );
  npm(['install', '--no-audit', '--no-fund', path.join(dir, meta.filename)], home);

  pack = { dir, meta, home, installed: path.join(home, 'node_modules', 'agentmash') };
}, { timeout: 120_000 });

/** Spawn asynchronously: the mock server shares this process's event loop. */
function runInstalled(args, { cwd, env = {} } = {}) {
  const bin = path.join(pack.home, 'node_modules', '.bin', 'agentmash');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, shellSafe(args), {
      cwd,
      env: { ...baseEnv, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: NEEDS_SHELL,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code, stdout: stdout.replace(/\u001b\[[0-9;]*m/g, ''), stderr: stderr.replace(/\u001b\[[0-9;]*m/g, '') })
    );
  });
}

function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-stranger-repo-')));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

/** Every file in the repo but .git, as path -> sha256. */
function snapshot(repo) {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dir === repo && entry.name === '.git') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else {
        const rel = path.relative(repo, abs).split(path.sep).join('/');
        files[rel] = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      }
    }
  };
  walk(repo);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
}

test('the tarball ships exactly the files the CLI needs at run time', () => {
  assert.deepEqual(pack.meta.files.map((f) => f.path).sort(), EXPECTED_FILES);
  const bin = pack.meta.files.find((f) => f.path === 'agentmash.mjs');
  assert.ok(bin.mode & 0o111, 'the bin script must be packed executable');
});

test('every file the tarball ships has LF line endings, whatever the checkout', () => {
  const crlf = pack.meta.files
    .map((f) => f.path)
    .filter((p) => {
      const bytes = fs.readFileSync(path.join(pack.installed, p));
      return !bytes.includes(0) && bytes.includes('\r\n');
    });
  assert.deepEqual(crlf, [], 'a CRLF file in the package commits hooks that differ from the web installer\'s');
});

test('package metadata is complete enough for npm to publish', () => {
  assert.equal(PKG.name, 'agentmash');
  assert.match(PKG.version, /^\d+\.\d+\.\d+$/);
  assert.ok(PKG.description && PKG.license && PKG.engines?.node);
  assert.equal(PKG.publishConfig?.access, 'public');

  // npm's page is where many first read about agentmash, and what answer
  // engines quote: it says what agentmash is, in the site's words, and sends
  // people to the site. The client's source is public in agentmash-cli, so
  // the package names it, its folder in it, and its issue tracker.
  assert.match(PKG.description, /^One app for your team’s AI coding agents: Claude Code, Codex, Cursor and more on your own logins, each told which files a teammate’s agent is changing$/);
  assert.equal(PKG.homepage, 'https://agentmash.dev');
  assert.deepEqual(PKG.repository, { type: 'git', url: 'git+https://github.com/agentmash-dev/agentmash-cli.git', directory: 'cli' });
  assert.equal(PKG.bugs, 'https://github.com/agentmash-dev/agentmash-cli/issues');
  for (const keyword of ['claude-code', 'cursor', 'mcp', 'ai-agents', 'coding-agents', 'merge-conflicts', 'worktree', 'parallel-agents', 'claude-code-hooks']) {
    assert.ok(PKG.keywords.includes(keyword), keyword);
  }
  assert.equal(new Set(PKG.keywords).size, PKG.keywords.length, 'each keyword once');

  const bin = PKG.bin.agentmash.replace(/^\.\//, '');
  assert.ok(EXPECTED_FILES.includes(bin), 'the bin target must be one of the packed files');

  // Nothing to install with it: the MCP server is plain Node like the hooks,
  // so `npx agentmash` fetches one package and a repo's server needs none.
  assert.deepEqual(PKG.dependencies ?? {}, {}, 'the package has no dependencies');

  // The workspace root must never be publishable: it shares the CLI's name.
  const root = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(root.private, true);
});

test("the README npm shows opens with what agentmash is and the site's setup, and links the site", () => {
  const readme = fs.readFileSync(path.join(CLI_DIR, 'README.md'), 'utf8').replace(/\r\n?/g, '\n');
  const first = (text) => text.split('\n\n')[1].replace(/\s+/g, ' ');
  assert.match(first(readme), /^agentmash \(AgentMash\) is one app for your team’s AI coding agents: /);
  // the setup is the site's: connect once on the website, sign in once, restart; the committed install comes after
  const setup = readme.slice(readme.indexOf('## Setup'), readme.indexOf('## Commands'));
  const at = (s) => setup.indexOf(s);
  for (const step of ['agentmash.dev/install', 'npx agentmash login', 'Restart Claude Code', 'npx agentmash logout', 'npx agentmash init']) assert.ok(at(step) >= 0, step);
  assert.ok(at('agentmash.dev/install') < at('npx agentmash login') && at('npx agentmash login') < at('Restart Claude Code') && at('Restart Claude Code') < at('npx agentmash init'));
  for (const url of ['https://agentmash.dev/docs', 'https://agentmash.dev/security', 'https://agentmash.dev/agents']) assert.ok(readme.slice(0, readme.indexOf('## Setup')).includes(`(${url})`), url);
  // what leaves a machine, as the site says it: code only when the room turns diffs on
  assert.ok(!/No file contents, ever/.test(readme));
  assert.match(readme.replace(/\s+/g, ' '), /Your code stays on your machine unless your room turns diffs on/);
  assert.ok(!/see each other/.test(readme));
});

test('the installed bin resolves and reports the published version', async () => {
  const result = await runInstalled(['--version']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), PKG.version);
});

test('the installed package runs the digest from the copy it carries', async () => {
  // no ../digest beside node_modules/agentmash: this is cli/digest/, as sync-hooks.mjs packed it
  assert.ok(!fs.existsSync(path.join(pack.installed, '..', 'digest')));
  const help = await runInstalled(['digest', '--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /^  npx agentmash digest \[--since 7d\]/m);
  const repo = makeRepo();
  const none = await runInstalled(['digest', '--to', 'json'], { cwd: repo });
  assert.equal(none.code, 2);
  assert.match(none.stderr, /^agentmash digest: no room to read/);
});

test('the installed package lists every agent from its own agents/, signed in or not', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-pack-tools-')));
  // every folder an agent reads from the environment, in this home: nothing of the developer's is looked at
  const folders = Object.fromEntries(
    [...new Set(Object.values(AGENTS).flatMap((agent) => agent.env ?? []))].map((name) => [name, path.join(home, name.toLowerCase())])
  );
  const result = await runInstalled(['tools'], {
    env: {
      ...folders,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      AGENTMASH_HOME: home,
      AGENTMASH_TOOL_PATH: path.join(home, 'bin'),
      AGENTMASH_APPS_DIR: path.join(home, 'Applications'),
    },
  });
  assert.equal(result.code, 0, result.stderr);
  for (const id of ['claude', ...Object.keys(AGENTS)]) {
    assert.match(result.stdout, new RegExp(`^  ${id}\\s`, 'm'), id);
  }
});

test("the installed package prints the generic hook's line from its own copy, and finds its dialects", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-pack-hook-')));
  const result = await runInstalled(['hook', '--print-command', '--client', 'mytool', '--event', 'pre_edit', '--dialect', 'json'], {
    env: { HOME: home, USERPROFILE: home, AGENTMASH_HOME: home },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `node "${path.join(home, '.agentmash', 'hooks', 'agent_hook.mjs')}" pre_edit --global --client mytool --dialect json\n`);
});

test('the installed package carries its own hooks, with no checkout to fall back on', () => {
  for (const file of HOOK_FILES) {
    assert.ok(fs.existsSync(path.join(pack.installed, 'hooks', file)), `${file} should be bundled`);
  }
  // hookSourceDir() also tries <package>/../hooks; if that existed here the test
  // below would pass even with an empty bundle.
  assert.ok(!fs.existsSync(path.join(pack.installed, '..', 'hooks')), 'the repo fallback must not be reachable');
});

test('the hooks the installed package commits say which crew agent made an edit, and nothing for any other agent', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    assert.equal((await runInstalled(['init', '--server', mock.url], { cwd: repo })).code, 0);
    const hook = path.join(repo, '.claude', 'agentmash', 'post_tool_use.mjs');
    // What Claude Code passes a hook inside a subagent: the crew as a plugin, as
    // project agents, somebody's own agent, and the main agent (no agent_type).
    const cases = [
      ['agentmash-crew:pipe-backend', 'pipe-backend'],
      ['probe-qa', 'probe-qa'],
      ['my-own-reviewer', null],
      ['general-purpose', null],
      [undefined, null],
    ];
    for (const [agentType] of cases) {
      const stdin = {
        session_id: 'pkg-crew',
        cwd: repo,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(repo, 'src', 'x.ts'), old_string: 'a', new_string: 'b' },
        agent_id: 'agent-4c1d',
        ...(agentType === undefined ? {} : { agent_type: agentType }),
      };
      const code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [hook], { env: { ...baseEnv, CLAUDE_PROJECT_DIR: repo }, stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', reject);
        child.on('close', resolve);
        child.stdin.end(JSON.stringify(stdin));
      });
      assert.equal(code, 0);
    }
    const sent = mock.requests.filter((r) => r.path === '/events').map((r) => r.body);
    assert.deepEqual(sent.map((b) => b.agent_type), cases.map(([, expected]) => expected));
    assert.ok(!JSON.stringify(sent).includes('my-own-reviewer') && !JSON.stringify(sent).includes('agent-4c1d'));
  } finally {
    await mock.close();
  }
});

test('doctor, status and uninstall work from the installed package', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    assert.equal((await runInstalled(['init', '--server', mock.url], { cwd: repo })).code, 0);

    // A degraded MCP server is a doctor failure since fix/mcp-trust, and
    // nothing points the launcher anywhere: the server init committed beside it
    // is the one that answers.
    const doctor = await runInstalled(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
    assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
    assert.match(doctor.stdout, /All good/);

    const status = await runInstalled(['status'], { cwd: repo });
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /alice@example\.com/);

    assert.equal((await runInstalled(['uninstall'], { cwd: repo })).code, 0);
    assert.ok(!fs.existsSync(path.join(repo, '.claude', 'agentmash')));
  } finally {
    await mock.close();
  }
});

test('the installed package carries the vendored crew, with no checkout to fall back on', () => {
  for (const file of CREW_FILES) {
    assert.ok(
      fs.readFileSync(path.join(pack.installed, 'crew', file)).equals(fs.readFileSync(path.join(REPO, 'crew', file))),
      `crew/${file} should be the release crew/crew.lock.json pins`
    );
  }
  // crewSourceDir() also tries <package>/../crew, the checkout layout; if that
  // existed here the test below would pass even with no crew in the tarball.
  assert.ok(!fs.existsSync(path.join(pack.installed, '..', 'crew')), 'the repo fallback must not be reachable');
});

test('crew add from the installed package writes what the crew installer writes', async () => {
  const viaPackage = makeRepo();
  const viaCrew = makeRepo();
  const result = await runInstalled(['crew', 'add', 'Команда 123', '--agents', 'pipe,flex,probe'], { cwd: viaPackage });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /team Команда 123 \(komanda-123\)/);

  const { loadBundle, runTeamOp } = await import(pathToFileURL(path.join(REPO, 'crew', 'install.mjs')).href);
  const bundle = loadBundle(path.join(REPO, 'crew', 'bundle.json'));
  runTeamOp({ repo: viaCrew, bundle, op: { type: 'add', name: 'Команда 123', members: ['pipe', 'flex', 'probe'] } });
  const written = snapshot(viaPackage);
  assert.ok(Object.keys(written).length >= 8, 'agents, skills, guard, settings and teams.json');
  assert.deepEqual(written, snapshot(viaCrew));
});
