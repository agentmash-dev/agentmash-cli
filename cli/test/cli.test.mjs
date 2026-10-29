import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOM, ROTATED_AWAY, ROTATED_ROOM, UNKNOWN_KEY, startMockServer } from './mock-server.mjs';
import { PUBLIC_REPO, startGitHub } from './fixtures/github.mjs';
import { KEY_OPENS, checkVisibility, githubApi, repoVisibility } from '../visibility.mjs';
import { within } from '../../tools/test-timing.mjs';

// Importing this runs the pack-time sync into cli/hooks/, cli/mcp/ and
// cli/clients/, which is the artefact the pin assertions below are about.
import { stampVersion } from '../sync-hooks.mjs';
import * as sync from '../sync-hooks.mjs';

const CLI_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(CLI_DIR, 'agentmash.mjs');

// Git reads the global config of whoever runs the tests, and a global
// core.hooksPath (a ~/.githooks every repository shares) is where init would
// put the post-commit client and uninstall would take it from. An empty global
// config keeps every git call inside the temporary repositories. So does an
// empty excludes file: with none set, git reads ~/.config/git/ignore, and what
// init says about ignored files would be about whoever runs the tests.
const EMPTY_GITCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-git-')), 'gitconfig');
const EMPTY_EXCLUDES = path.join(path.dirname(EMPTY_GITCONFIG), 'ignore');
fs.writeFileSync(EMPTY_EXCLUDES, '');
fs.writeFileSync(EMPTY_GITCONFIG, `[core]\n\texcludesFile = ${EMPTY_EXCLUDES.split(path.sep).join('/')}\n`);

// init and join ask GitHub whether a checkout's repository is public: here,
// a stand-in that says private unless a test says otherwise
const github = startGitHub();
await github.ready;

const baseEnv = {
  AGENTMASH_GITHUB_API: github.url,
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTMASH_') && k !== 'CLAUDE_PROJECT_DIR')
  ),
  GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  // A home of its own: the hooks log the reports that never arrived under
  // ~/.agentmash, and the MCP launcher looks there for a newer copy of its
  // server, so neither may be the developer's. A test that needs its own home
  // still passes one.
  AGENTMASH_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-home-')),
  // And Claude Code settings of its own: hooks a developer's sign-in put in
  // theirs would make doctor check this machine as a signed-in one.
  CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-claude-')),
};

function run(args, { cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...baseEnv, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    // strip ANSI so assertions read cleanly
    child.on('close', (code) =>
      resolve({
        code,
        stdout: stdout.replace(/\[[0-9;]*m/g, ''),
        stderr: stderr.replace(/\[[0-9;]*m/g, ''),
      })
    );
  });
}

function makeRepo(prefix = 'agentmash-cli-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  return fs.realpathSync(dir);
}

/**
 * A prompt as this version registers it. Claude Code waits on every
 * UserPromptSubmit hook that is not async, so the report runs in the
 * background, and only the heads-up runs in line, with a short timeout; a
 * session's start gets the heads-up too.
 */
function assertPromptHooks(settings) {
  const scriptOf = (hook) => /\.claude\/agentmash\/([\w.-]+\.mjs)/.exec(hook.command)?.[1] ?? null;
  const ours = (event) => (settings.hooks[event] ?? []).filter((g) => JSON.stringify(g).includes('.claude/agentmash/'));
  const [prompts, ...otherPrompts] = ours('UserPromptSubmit');
  assert.equal(otherPrompts.length, 0, 'one group of ours for a prompt');
  assert.deepEqual(
    prompts.hooks.map((h) => [scriptOf(h), h.async ?? false, h.timeout]),
    [
      ['user_prompt_submit.mjs', true, 6],
      ['prompt_note.mjs', false, 4],
    ],
    'the report in the background, the heads-up in line'
  );
  const [start, ...otherStarts] = ours('SessionStart');
  assert.equal(otherStarts.length, 0, 'one group of ours for a session start');
  assert.deepEqual(start.hooks.map((h) => [scriptOf(h), h.async ?? false]), [['session_start.mjs', false]]);
}

test('init creates a room and wires up the repo', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    const result = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /AgentMash is wired up/);
    assert.match(result.stdout, new RegExp(ROOM));
    assert.match(result.stdout, /Dashboard/);
    assert.doesNotMatch(result.stdout, /opened the dashboard/, 'a pipe is not a person: nothing is opened');
    // one command to a line: Windows PowerShell 5.1 has no &&, and stops a chained line at its first
    assert.match(result.stdout, /commit and push:\n {4}git add \.claude \.mcp\.json\n {4}git commit -m "add agentmash"\n {4}git push\n/);
    assert.doesNotMatch(result.stdout, /&&/);
    // what a teammate who only pulls has to have: the hooks and the MCP server run on it
    assert.match(result.stdout, /Teammates need Node\.js 18\.12 or newer on their PATH\./);

    for (const file of ['lib.mjs', 'pre_tool_use.mjs', 'post_tool_use.mjs', 'user_prompt_submit.mjs', 'prompt_note.mjs', 'session_start.mjs']) {
      assert.ok(fs.existsSync(path.join(repo, '.claude', 'agentmash', file)), `${file} should be installed`);
    }

    const config = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'agentmash', 'config.json'), 'utf8'));
    assert.equal(config.room, ROOM);
    assert.equal(config.url, mock.url);

    const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']) {
      assert.match(JSON.stringify(settings.hooks[event]), /\.claude\/agentmash\//, `${event} should be registered`);
    }
    assertPromptHooks(settings);
    // Exact tool names, joined by |: Claude Code compares each one whole, where
    // a regex would let "Write" match TodoWrite too. Notebook cells and shell
    // commands change files as well, and a command is checked beforehand for
    // the files its text says it writes, in Bash and in PowerShell alike.
    assert.equal(settings.hooks.PreToolUse[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit|write|edit|apply_patch|Bash|PowerShell');
    assert.equal(settings.hooks.PostToolUse[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit|write|edit|apply_patch|Bash|PowerShell');
    assert.equal(settings.hooks.PostToolUse[0].hooks[0].async, true);
    for (const event of Object.keys(settings.hooks)) {
      for (const group of settings.hooks[event]) {
        if (group.matcher !== undefined) assert.match(group.matcher, /^[A-Za-z0-9_|]+$/, `${event} matches names, not a pattern`);
      }
    }

    const created = mock.requests.find((r) => r.path === '/rooms' && r.method === 'POST');
    assert.ok(created, 'should have asked the server for a room');
    assert.equal(created.body.label, path.basename(repo));
  } finally {
    await mock.close();
  }
});

// init and join commit a room's key beside the hooks, and in a public
// repository that key is anyone's: they read the room and write to it. So
// both ask GitHub first, the way anyone can, and stop on a public one unless
// --allow-public-key says otherwise.

test('whether a repository is public is asked of GitHub as a stranger, and a missing answer says why', async () => {
  const asked = [];
  const answers = {
    'acme/app': { status: 200, body: { full_name: 'acme/app', private: false } },
    'acme/secret': { status: 200, body: { private: true } },
    'acme/down': { status: 502, body: {} },
    'acme/limited': { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } },
  };
  const fetch = async (url, init) => {
    asked.push({ url: String(url), headers: init?.headers ?? {} });
    const repo = new URL(url).pathname.replace(/^\/repos\//, '');
    if (repo === 'acme/cut') throw new TypeError('fetch failed');
    const answer = answers[repo] ?? { status: 404, body: { message: 'Not Found' } };
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: answer.headers });
  };
  const ask = (slug) => repoVisibility(slug, { fetch, api: 'https://api.github.test' });
  assert.deepEqual(await ask('acme/app'), { visibility: 'public' });
  assert.deepEqual(await ask('acme/gone'), { visibility: 'private' }, 'a 404 is private or missing, the same to a stranger');
  assert.deepEqual(await ask('acme/secret'), { visibility: 'private' });
  assert.deepEqual(await ask('acme/down'), { visibility: 'unknown', why: 'GitHub answered HTTP 502' });
  assert.deepEqual(await ask('acme/limited'), { visibility: 'unknown', why: "GitHub's hourly limit for this address is spent" });
  assert.deepEqual(await ask('acme/cut'), { visibility: 'unknown', why: 'GitHub could not be reached' });
  assert.equal(asked[0].url, 'https://api.github.test/repos/acme/app');
  assert.ok(!asked.some((a) => 'authorization' in a.headers), 'no credential of any kind goes to GitHub');
  assert.deepEqual(await checkVisibility(['acme/app', 'acme/gone', 'acme/cut'], { fetch, api: 'https://api.github.test' }), {
    public: ['acme/app'],
    private: ['acme/gone'],
    unknown: [{ slug: 'acme/cut', why: 'GitHub could not be reached' }],
  });
  assert.equal(githubApi({}), 'https://api.github.com');
  assert.equal(githubApi({ AGENTMASH_GITHUB_API: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9');
});

function addRemote(repo, name, url) {
  execFileSync('git', ['remote', 'add', name, url], { cwd: repo, stdio: 'ignore' });
}

test('init will not commit a room key to a public repository, and says what to do instead', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  addRemote(repo, 'origin', 'git@github.com:Acme/App.git');
  github.answers['acme/app'] = PUBLIC_REPO;
  try {
    const before = github.requests.length;
    const result = await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: repo });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /acme\/app is public on GitHub, so init will not commit a room key to it/);
    assert.match(result.stderr, /anyone who reads the repository could read the room and write to it/);
    assert.match(result.stderr, /npx agentmash login/);
    assert.match(result.stderr, new RegExp(`${mock.url}/install`));
    assert.match(result.stderr, /npx agentmash init --allow-public-key/);
    assert.equal(github.requests.length, before + 1, 'one question, about the one repository');
    assert.equal(github.requests.at(-1).path, '/repos/acme/app');
    assert.equal(github.requests.at(-1).authorization, undefined);
    assert.ok(!mock.requests.some((r) => r.path === '/rooms' && r.method === 'POST'), 'no room is made');
    assert.ok(!fs.existsSync(path.join(repo, '.claude', 'agentmash', 'config.json')), 'and no key is written');

    // a fork's checkout: origin the developer's own and private, upstream the team's and public
    const fork = makeRepo();
    addRemote(fork, 'origin', 'git@github.com:alice/app.git');
    addRemote(fork, 'upstream', 'https://github.com/acme/app.git');
    const forked = await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: fork });
    assert.equal(forked.code, 1, 'a key goes wherever it is pushed: any public remote stops it');
    assert.match(forked.stderr, /acme\/app is public on GitHub/);
  } finally {
    delete github.answers['acme/app'];
    await mock.close();
  }
});

test('init --allow-public-key commits it all the same, says what anyone can read, and tells the room', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  addRemote(repo, 'origin', 'https://github.com/acme/app.git');
  github.answers['acme/app'] = PUBLIC_REPO;
  try {
    const result = await run(['init', '--server', mock.url, '--no-git-hook', '--allow-public-key'], { cwd: repo });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /acme\/app is public on GitHub, and --allow-public-key commits the room key to it all the same/);
    assert.ok(result.stdout.includes(`anyone who reads it holds the key, and ${KEY_OPENS}`));
    assert.match(result.stdout, /first 500 characters of each prompt/);
    assert.match(result.stdout, /AgentMash is wired up/);
    const created = mock.requests.find((r) => r.path === '/rooms' && r.method === 'POST');
    assert.equal(created.body.allow_public_key, true, 'the room is made knowing its key is public on purpose');
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'agentmash', 'config.json'), 'utf8')).room, ROOM);
  } finally {
    delete github.answers['acme/app'];
    await mock.close();
  }
});

test('init goes ahead, saying so in a line, when GitHub cannot say or no remote is GitHub', async () => {
  const mock = await startMockServer();
  try {
    // private: nothing to say, and nothing told to the room
    const quiet = makeRepo();
    addRemote(quiet, 'origin', 'git@github.com:acme/private.git');
    const ok = await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: quiet });
    assert.equal(ok.code, 0, ok.stderr);
    assert.doesNotMatch(ok.stdout, /public|GitHub remote/);
    assert.equal(mock.requests.find((r) => r.path === '/rooms' && r.method === 'POST').body.allow_public_key, undefined);

    // GitHub down
    github.answers['acme/down'] = { status: 503, body: {} };
    const down = makeRepo();
    addRemote(down, 'origin', 'git@github.com:acme/down.git');
    const unsure = await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: down });
    assert.equal(unsure.code, 0, unsure.stderr);
    assert.match(unsure.stdout, /could not ask GitHub whether acme\/down is public \(GitHub answered HTTP 503\)/);
    assert.equal(unsure.stdout.split('\n').filter((l) => /public/.test(l)).length, 1, 'one line');

    // not GitHub at all
    const gitlab = makeRepo();
    addRemote(gitlab, 'origin', 'git@gitlab.com:acme/app.git');
    const elsewhere = await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: gitlab });
    assert.equal(elsewhere.code, 0, elsewhere.stderr);
    assert.match(elsewhere.stdout, /no remote of this checkout is GitHub's for sure .*, so whether it is public cannot be told/);
    assert.ok(fs.existsSync(path.join(gitlab, '.claude', 'agentmash', 'config.json')));

    // no remote at all
    const bare = makeRepo();
    const none = await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: bare });
    assert.equal(none.code, 0, none.stderr);
    assert.match(none.stdout, /this checkout has no GitHub remote, so whether it is public cannot be told/);
  } finally {
    delete github.answers['acme/down'];
    await mock.close();
  }
});

test('init asks about a remote through an SSH host alias named for GitHub, and a GitHub remote in any form', async () => {
  const mock = await startMockServer();
  github.answers['acme/app'] = PUBLIC_REPO;
  try {
    for (const url of ['git@github-work:acme/app.git', 'ssh://git@ssh.github.com:443/acme/app.git', 'org-123@github.com:acme/app.git']) {
      const repo = makeRepo();
      addRemote(repo, 'origin', url);
      const result = await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: repo });
      assert.equal(result.code, 1, url);
      assert.match(result.stderr, /acme\/app is public on GitHub, so init will not commit a room key to it/, url);
      assert.ok(!fs.existsSync(path.join(repo, '.claude', 'agentmash', 'config.json')), url);
    }
  } finally {
    delete github.answers['acme/app'];
    await mock.close();
  }
});

test('join will not commit a room key to a public repository either', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  addRemote(repo, 'origin', 'git@github.com:acme/app.git');
  github.answers['acme/app'] = PUBLIC_REPO;
  try {
    const refused = await run(['join', ROOM, '--server', mock.url, '--no-git-hook'], { cwd: repo });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /acme\/app is public on GitHub, so join will not commit a room key to it/);
    assert.match(refused.stderr, /npx agentmash join <room> --allow-public-key/);
    assert.doesNotMatch(refused.stderr, new RegExp(ROOM), 'the key is not printed back');
    assert.ok(!fs.existsSync(path.join(repo, '.claude', 'agentmash', 'config.json')));

    const joined = await run(['join', ROOM, '--server', mock.url, '--no-git-hook', '--allow-public-key'], { cwd: repo });
    assert.equal(joined.code, 0, joined.stderr);
    assert.ok(fs.existsSync(path.join(repo, '.claude', 'agentmash', 'config.json')));
  } finally {
    delete github.answers['acme/app'];
    await mock.close();
  }
});

test('init never clobbers existing settings and is idempotent', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(npm test:*)'] },
        hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo existing' }] }] },
      })
    );

    assert.equal((await run(['init', '--server', mock.url], { cwd: repo })).code, 0);
    const second = await run(['init', '--server', mock.url], { cwd: repo });
    assert.match(second.stdout, /already connected/);

    const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions.allow, ['Bash(npm test:*)'], 'existing settings must survive');
    assert.equal(settings.hooks.PostToolUse.length, 2, 'existing hook kept, ours appended');
    assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, 'echo existing');
  } finally {
    await mock.close();
  }
});

const ourHook = (script, dir = 'agentmash') => ({
  type: 'command',
  command: 'node',
  args: [`\${CLAUDE_PROJECT_DIR}/.claude/${dir}/${script}`],
  timeout: 5,
});

test('init replaces an older entry of ours and drops a stale .claude/agentmesh one, but keeps a foreign Bash hook', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo foreign' }] },
            // an install from before the matcher was widened
            { matcher: 'Write|Edit', hooks: [ourHook('post_tool_use.mjs')] },
            // the folder's old name, whose scripts are long gone
            { matcher: 'Write|Edit|MultiEdit', hooks: [{ ...ourHook('post_tool_use.mjs', 'agentmesh'), async: true }] },
          ],
          PreToolUse: [
            // one group holding a hook of theirs beside a stale one of ours
            {
              matcher: 'Write|Edit|MultiEdit',
              hooks: [ourHook('pre_tool_use.mjs', 'agentmesh'), { type: 'command', command: 'echo lint-guard' }],
            },
          ],
        },
      })
    );

    const result = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
    assert.ok(!JSON.stringify(settings).includes('.claude/agentmesh/'), 'no entry points at the old folder any more');
    // ours by the script it runs, which a committed line names twice (for sh and for PowerShell), theirs as it is
    const ranBy = (h) => (h.command.includes('.claude/agentmash/') ? [...new Set(h.command.match(/\.claude\/agentmash\/[\w.-]+\.mjs/g))].join() : h.command);
    assert.deepEqual(
      settings.hooks.PostToolUse.map((g) => [g.matcher, g.hooks.map(ranBy)]),
      [
        ['Bash', ['echo foreign']],
        ['Write|Edit|MultiEdit|NotebookEdit|write|edit|apply_patch|Bash|PowerShell', ['.claude/agentmash/post_tool_use.mjs']],
      ],
      'theirs kept as it was, ours once, as this version writes it'
    );
    assert.deepEqual(
      settings.hooks.PreToolUse.map((g) => g.hooks.map(ranBy)),
      [['echo lint-guard'], ['.claude/agentmash/pre_tool_use.mjs']],
      'a hook of theirs in a group with a stale one of ours stays'
    );
  } finally {
    await mock.close();
  }
});

test('init leaves an event of ours that this version does not register to the version that does', async () => {
  // A newer CLI hooked an event this one knows nothing about; running this
  // one's init again, from an older checkout say, must not take it out.
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    assert.equal((await run(['init', '--server', mock.url], { cwd: repo })).code, 0);
    const settingsFile = path.join(repo, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const newer = [{ hooks: [ourHook('subagent_start.mjs')] }];
    settings.hooks.SubagentStart = newer;
    settings.hooks.PostToolUse[0].matcher = 'Write|Edit|MultiEdit';
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

    const result = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(result.code, 0, result.stderr);
    const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(after.hooks.PostToolUse[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit|write|edit|apply_patch|Bash|PowerShell', 'its own events brought up to date');
    assert.deepEqual(after.hooks.SubagentStart, newer, 'and the newer one left as it was');
  } finally {
    await mock.close();
  }
});

test('re-running init in a connected repo brings its hooks up to date and keeps its room', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    assert.equal((await run(['init', '--server', mock.url], { cwd: repo })).code, 0);
    const settingsFile = path.join(repo, '.claude', 'settings.json');
    const configFile = path.join(repo, '.claude', 'agentmash', 'config.json');
    // what an install from an older version left: a narrower matcher, an older hook script
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.hooks.PostToolUse[0].matcher = 'Write|Edit|MultiEdit';
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    fs.writeFileSync(path.join(repo, '.claude', 'agentmash', 'post_tool_use.mjs'), '// an older hook\n');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, JSON.stringify({ ...config, timeout_ms: 3000 }, null, 2));

    const again = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /already connected/);
    assert.match(again.stdout, /hooks brought up to date/);
    const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(after.hooks.PostToolUse.length, 1);
    assert.equal(after.hooks.PostToolUse[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit|write|edit|apply_patch|Bash|PowerShell');
    assert.notEqual(
      fs.readFileSync(path.join(repo, '.claude', 'agentmash', 'post_tool_use.mjs'), 'utf8'),
      '// an older hook\n',
      'the scripts are this version\'s'
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { ...config, timeout_ms: 3000 }, 'the room and its settings stay');
    assert.equal(mock.requests.filter((r) => r.path === '/rooms' && r.method === 'POST').length, 1, 'no second room');

    const third = await run(['init', '--server', mock.url], { cwd: repo });
    assert.match(third.stdout, /hooks already up to date/);
  } finally {
    await mock.close();
  }
});

test('re-running init brings our own post-commit hook up to date, and leaves anyone else’s alone', async () => {
  // .git/hooks is never pulled, so an older version's shim stayed there for good
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    assert.equal((await run(['init', '--server', mock.url], { cwd: repo })).code, 0);
    const hook = path.join(repo, '.git', 'hooks', 'post-commit');
    const current = fs.readFileSync(hook, 'utf8');
    assert.match(current, /agentmash-git-hook/);
    const older = '#!/bin/sh\n# agentmash-git-hook — installed by an older `agentmash git-hook install`.\nexit 0\n';
    fs.writeFileSync(hook, older);

    const again = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /already connected/);
    assert.match(again.stdout, /git post-commit hook brought up to date/);
    assert.doesNotMatch(again.stdout, /commit \.claude/, '.git/hooks is this machine’s: nothing to commit');
    assert.equal(fs.readFileSync(hook, 'utf8'), current, 'this version’s shim');

    const third = await run(['init', '--server', mock.url], { cwd: repo });
    assert.match(third.stdout, /hooks already up to date/);
    assert.doesNotMatch(third.stdout, /post-commit hook brought up to date/);

    // a post-commit of someone else's is theirs
    fs.writeFileSync(hook, '#!/bin/sh\necho mine\n');
    const theirs = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(theirs.code, 0, theirs.stderr);
    assert.equal(fs.readFileSync(hook, 'utf8'), '#!/bin/sh\necho mine\n');
    assert.doesNotMatch(theirs.stdout, /post-commit hook brought up to date/);
  } finally {
    await mock.close();
  }
});

test('re-running init brings a repository registered before the heads-up up to date', async () => {
  // What a repository connected by an older version carries, agentmash-sandbox
  // among them: the prompt reported in the background and nothing in line, no
  // SessionStart, matchers from before commands and notebooks, older scripts.
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    const dir = path.join(repo, '.claude', 'agentmash');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ url: mock.url, room: ROOM, label: 'sandbox' }, null, 2));
    fs.writeFileSync(path.join(dir, 'user_prompt_submit.mjs'), '// an older hook\n');
    const older = (script, extra = {}) => ({ ...ourHook(script), ...extra });
    fs.writeFileSync(
      path.join(repo, '.claude', 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [{ hooks: [older('user_prompt_submit.mjs', { async: true })] }],
            PreToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [older('pre_tool_use.mjs')] }],
            PostToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [older('post_tool_use.mjs', { async: true })] }],
            SessionEnd: [{ hooks: [older('session_end.mjs', { timeout: 4 })] }],
          },
        },
        null,
        2
      )
    );

    const result = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /already connected/);
    assert.match(result.stdout, /hooks brought up to date/);
    const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
    assertPromptHooks(settings);
    for (const script of ['prompt_note.mjs', 'session_start.mjs']) {
      assert.ok(fs.existsSync(path.join(dir, script)), `${script} is installed`);
    }
    assert.notEqual(fs.readFileSync(path.join(dir, 'user_prompt_submit.mjs'), 'utf8'), '// an older hook\n', 'this version\'s report');
    assert.equal(mock.requests.filter((r) => r.path === '/rooms' && r.method === 'POST').length, 0, 'the room it has is kept');

    const again = await run(['init', '--server', mock.url], { cwd: repo });
    assert.match(again.stdout, /hooks already up to date/, 'and once it is current, init leaves it be');
  } finally {
    await mock.close();
  }
});

test('re-running init over hooks checked out with CRLF line endings leaves them as they are', async () => {
  // core.autocrlf=true, the Windows default, checks the committed scripts
  // out with CRLF: the same scripts, and git sees no change in them either
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    assert.equal((await run(['init', '--server', mock.url], { cwd: repo })).code, 0);
    const dir = path.join(repo, '.claude', 'agentmash');
    const scripts = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'));
    assert.ok(scripts.length > 3, scripts.join(', '));
    for (const script of scripts) {
      const file = path.join(dir, script);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'));
    }

    const again = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /hooks already up to date/);
    assert.doesNotMatch(again.stdout, /brought up to date|commit \.claude/);
    for (const script of scripts) {
      assert.match(fs.readFileSync(path.join(dir, script), 'utf8'), /\r\n/, `${script} is left as it was checked out`);
    }
  } finally {
    await mock.close();
  }
});

test('join accepts a bare room id and a dashboard url', async () => {
  const mock = await startMockServer();
  try {
    const byId = makeRepo();
    const a = await run(['join', ROOM, '--server', mock.url], { cwd: byId });
    assert.equal(a.code, 0, a.stderr);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(byId, '.claude', 'agentmash', 'config.json'), 'utf8')).room,
      ROOM
    );

    const byUrl = makeRepo();
    const b = await run(['join', `${mock.url}/r/${ROOM}`], { cwd: byUrl });
    assert.equal(b.code, 0, b.stderr);
    const config = JSON.parse(fs.readFileSync(path.join(byUrl, '.claude', 'agentmash', 'config.json'), 'utf8'));
    assert.equal(config.room, ROOM);
    assert.equal(config.url, mock.url, 'server should be taken from the pasted URL');
  } finally {
    await mock.close();
  }
});

// status, login and the dashboard's address bar show a room by its ref, so
// that is what people paste into join, which said it "does not look like a
// room id" and nothing more
test('join given a room ref says it is not the key, and what does get this repository into that room', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    for (const target of ['rm_0a1b2c3d4e', `${mock.url}/r/rm_0a1b2c3d4e`, `${mock.url}/r/rm_0a1b2c3d4e#live`]) {
      const result = await run(['join', target, '--server', mock.url, '--no-open'], { cwd: repo });
      assert.equal(result.code, 1, target);
      assert.match(result.stderr, /rm_0a1b2c3d4e is the room's ref, not its key: it names the room, and join takes the key \(mash_…\)/, target);
      assert.match(result.stderr, /connected to this repository on the website: npx agentmash login/, target);
      assert.match(result.stderr, /committed to this repository: pull/, target);
      assert.doesNotMatch(result.stderr, /does not look like a room id/, target);
    }
    assert.deepEqual(mock.requests, [], 'nothing was asked of the server');
    assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'and nothing was written');
  } finally {
    await mock.close();
  }
});

test('join reports a room that does not exist', async () => {
  const mock = await startMockServer({ roomExists: false });
  const repo = makeRepo();
  try {
    const result = await run(['join', ROOM, '--server', mock.url], { cwd: repo });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /does not exist/);
  } finally {
    await mock.close();
  }
});

test('init registers the MCP server and leaves the approval to each teammate', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    const result = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /MCP server registered/);

    // The launcher and the server it starts travel with the hooks, so a
    // teammate gets both by git pull, and neither needs an npm install.
    for (const file of ['mcp_launcher.mjs', 'mcp_server.mjs', 'mcp_coordination.mjs', 'mcp_render.mjs']) {
      assert.ok(fs.existsSync(path.join(repo, '.claude', 'agentmash', file)), `${file} should be installed`);
    }

    const mcp = JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8'));
    const entry = mcp.mcpServers.agentmash;
    assert.equal(entry.command, 'node');
    assert.deepEqual(
      entry.args.slice(0, 2),
      ['--input-type=module', '-e'],
      'a script that finds the launcher from whichever folder the session started in'
    );
    assert.equal(entry.args.length, 3);
    assert.ok(!entry.args[2].includes('${'), 'nothing for Claude Code to expand, so nothing it can expand wrongly');
    assert.match(entry.args[2], /mcp_launcher\.mjs/);

    const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
    assert.equal(
      settings.enabledMcpjsonServers,
      undefined,
      'one person running init is not the whole team consenting to run a server'
    );
    assert.match(result.stdout, /approves the MCP server once/);
  } finally {
    await mock.close();
  }
});

test('init says so when it replaces a different server already called agentmash', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    fs.writeFileSync(
      path.join(repo, '.mcp.json'),
      JSON.stringify({ mcpServers: { agentmash: { command: 'node', args: ['tools/ours.mjs'] } } }, null, 2)
    );
    const result = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /already had a server called "agentmash"/);
    assert.match(result.stdout, /tools\/ours\.mjs/, 'say what was overwritten, so it can be put back');
  } finally {
    await mock.close();
  }
});

/**
 * Expand `${VAR}` and `${VAR:-default}` in .mcp.json the way Claude Code does:
 * from its own environment, where CLAUDE_PROJECT_DIR is unset, since it sets
 * that only in the server's.
 */
function expandLikeClaudeCode(value) {
  const env = { ...baseEnv };
  delete env.CLAUDE_PROJECT_DIR;
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name, fallback) => {
    const set = env[name];
    if (fallback === undefined) return set === undefined ? whole : set;
    return set === undefined || set === '' ? fallback : set;
  });
}

/**
 * Start our server out of the repository's .mcp.json the way Claude Code
 * does: its command and args expanded, spawned with no shell in the folder the
 * session started in, with that folder as CLAUDE_PROJECT_DIR. Then talk to it
 * in newline-delimited JSON-RPC, a request at a time: initialize, tools/list,
 * and each of `calls`. Resolves with every answer, any line on stdout that is
 * not JSON-RPC, stderr, and how it ended when it did not answer them all.
 */
function talkToRegisteredServer(repo, { cwd = repo, calls = [] } = {}) {
  const entry = JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8')).mcpServers.agentmash;
  const requests = [
    {
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code-stand-in', version: '0' } },
    },
    { method: 'tools/list', params: {} },
    ...calls.map(([name, args]) => ({ method: 'tools/call', params: { name, arguments: args } })),
  ];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(expandLikeClaudeCode(entry.command), (entry.args ?? []).map(expandLikeClaudeCode), {
      cwd,
      env: { ...baseEnv, CLAUDE_PROJECT_DIR: cwd, AGENTMASH_DEV: 'bob' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const answers = [];
    const noise = [];
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (ended) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve({ answers, noise, stderr, ended, ms: Date.now() - started });
    };
    const timer = setTimeout(() => finish(`no answer within ${within(10_000) / 1000} s`), within(10_000));
    const send = (message) => {
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
      } catch {
        /* the exit handler says what happened */
      }
    };
    const ask = () => send({ id: answers.length + 1, ...requests[answers.length] });
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => finish(`could not start: ${err.message}`));
    child.on('exit', (code) => finish(`exited ${code} before answering`));
    child.stdout.on('data', (d) => {
      stdout += d;
      let index;
      while ((index = stdout.indexOf('\n')) !== -1) {
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (!line) continue;
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          // not JSON at all, which is noise just the same
        }
        if (message?.jsonrpc !== '2.0') {
          noise.push(line);
          continue;
        }
        answers.push(message);
        if (answers.length === 1) send({ method: 'notifications/initialized' });
        if (answers.length === requests.length) return finish(null);
        ask();
      }
    });
    ask();
  });
}

/** The real server answered, with real tools and a real answer from the room, and said nothing else. */
function assertRealServer(talk) {
  assert.equal(talk.ended, null, `the server has to answer; it ${talk.ended}: ${talk.stderr}`);
  assert.deepEqual(talk.noise, [], 'stdout carries the protocol and nothing else');
  const [init, list, who] = talk.answers;
  assert.deepEqual(talk.answers.map((a) => a.id), talk.answers.map((_, i) => i + 1));
  assert.doesNotMatch(
    init.result.serverInfo.version,
    /-unavailable$/,
    `the real server, not the stand-in that says it could not start: ${talk.stderr}`
  );
  const names = list.result.tools.map((t) => t.name);
  for (const name of ['who_is_working_on_what', 'has_anyone_touched', 'list_contested_files']) {
    assert.ok(names.includes(name), `${name} is served (got ${names.join(', ')})`);
  }
  const text = who.result.content.map((c) => c.text).join('\n');
  assert.notEqual(who.result.isError, true, text);
  assert.match(text, /alice@example\.com/, 'a real answer, from the room');
  assert.ok(talk.ms < within(5000), `the whole exchange took ${talk.ms}ms`);
}

test('a fresh init serves the real MCP tools from a path with a space, with no npm install', async () => {
  const mock = await startMockServer();
  // A space in the path, the way "comp programming" has one, and outside this
  // checkout: no node_modules above it holds the MCP SDK or the package.
  const repo = makeRepo('agentmash cli test ');
  try {
    const init = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(init.code, 0, init.stderr);
    assertRealServer(await talkToRegisteredServer(repo, { calls: [['who_is_working_on_what', {}]] }));
  } finally {
    await mock.close();
  }
});

test('the MCP server in .mcp.json starts from a subfolder too, where a session may have been started', async () => {
  // Claude Code reads .mcp.json from the folder a session starts in and every
  // folder above it, and starts the server in that folder.
  const mock = await startMockServer();
  const repo = makeRepo('agentmash cli test ');
  try {
    fs.mkdirSync(path.join(repo, 'src', 'models'), { recursive: true });
    assert.equal((await run(['init', '--server', mock.url], { cwd: repo })).code, 0);
    const talk = await talkToRegisteredServer(repo, {
      cwd: path.join(repo, 'src'),
      calls: [
        ['who_is_working_on_what', {}],
        ['has_anyone_touched', { path: 'src/models/user.ts' }],
      ],
    });
    assertRealServer(talk);
    // and a repo-relative path is the repository's, not the folder's the session started in
    const touched = talk.answers[3].result.content.map((c) => c.text).join('\n');
    assert.match(touched, /1 person has touched `src\/models\/user\.ts`/);
  } finally {
    await mock.close();
  }
});

/**
 * A launcher in a folder above a repository, where anyone who can write there
 * can leave one: C:\ on Windows, a shared drive, or another repository the
 * clone happens to sit in. It writes a file to say it ran, and nothing else.
 */
function plantLauncher(dir) {
  const ran = path.join(dir, 'the planted launcher ran');
  fs.mkdirSync(path.join(dir, '.claude', 'agentmash'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude', 'agentmash', 'mcp_launcher.mjs'),
    `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(ran)}, 'ran');\n`
  );
  return ran;
}

/**
 * The walk up to the launcher ends at the folder whose .mcp.json registered
 * it, or at a repository's own root, whichever it reaches first. Above that,
 * the launcher is code nobody in this repository put there, and the entry this
 * one replaced never ran it either: it failed instead, as this does.
 */
test('the MCP server in .mcp.json never starts a launcher from above the repository', async () => {
  const mock = await startMockServer();
  const source = makeRepo();
  try {
    assert.equal((await run(['init', '--server', mock.url], { cwd: source })).code, 0);
  } finally {
    await mock.close();
  }
  const registration = fs.readFileSync(path.join(source, '.mcp.json'));
  const layouts = [
    // A repository that registers the server with no .claude/agentmash of its
    // own: .claude is ignored, so a teammate got .mcp.json alone, or it was
    // deleted to turn AgentMash off.
    [
      'a repository with .mcp.json and no launcher',
      (above) => {
        const repo = path.join(above, 'team repo');
        fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore', env: baseEnv });
        fs.writeFileSync(path.join(repo, '.mcp.json'), registration);
        return { registered: repo, start: path.join(repo, 'src') };
      },
    ],
    // Not a repository at all: the .mcp.json that registered it is the end.
    [
      'a folder with .mcp.json and no launcher',
      (above) => {
        const notes = path.join(above, 'notes');
        fs.mkdirSync(path.join(notes, 'drafts'), { recursive: true });
        fs.writeFileSync(path.join(notes, '.mcp.json'), registration);
        return { registered: notes, start: path.join(notes, 'drafts') };
      },
    ],
    // A clone with no .mcp.json of its own, inside a folder AgentMash is
    // installed in (~/work, say): Claude Code finds that folder's .mcp.json,
    // but its room is not this clone's, and the clone's root is the end.
    [
      'a clone inside a folder AgentMash is installed in',
      (above) => {
        fs.writeFileSync(path.join(above, '.mcp.json'), registration);
        const clone = path.join(above, 'cloned');
        fs.mkdirSync(path.join(clone, 'src'), { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: clone, stdio: 'ignore', env: baseEnv });
        return { registered: above, start: path.join(clone, 'src') };
      },
    ],
  ];
  for (const [layout, build] of layouts) {
    const above = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash above ')));
    const ran = plantLauncher(above);
    const { registered, start } = build(above);
    const talk = await talkToRegisteredServer(registered, { cwd: start });
    assert.ok(!fs.existsSync(ran), `${layout}: the launcher above it must not run`);
    assert.equal(talk.ended, 'exited 1 before answering', `${layout}: ${talk.stderr}`);
    assert.match(talk.stderr, /no \.claude\/agentmash\/mcp_launcher\.mjs/, layout);
    assert.ok(talk.stderr.includes(start), `${layout}: it names the folder it started from: ${talk.stderr}`);
    assert.match(talk.stderr, /npx agentmash init/, `${layout}: and what puts it right`);
  }
});

test('a session in a worktree under .claude/worktrees falls back to the main checkout\'s launcher', async () => {
  // Claude Code makes its worktrees in .claude/worktrees/. One checked out from
  // a commit from before AgentMash was installed has no launcher and no
  // .mcp.json of its own: Claude Code finds the main checkout's .mcp.json, and
  // the walk goes on past the worktree's .git, a file, to its launcher.
  const mock = await startMockServer();
  const repo = makeRepo('agentmash cli test ');
  try {
    const git = (...args) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd: repo,
        stdio: 'ignore',
        env: baseEnv,
      });
    git('commit', '-q', '--allow-empty', '-m', 'before agentmash');
    assert.equal((await run(['init', '--server', mock.url], { cwd: repo })).code, 0);
    const worktree = path.join(repo, '.claude', 'worktrees', 'tidy otter');
    git('worktree', 'add', '-q', '--detach', worktree);
    assert.ok(fs.statSync(path.join(worktree, '.git')).isFile(), 'a worktree, not a clone');
    assert.ok(!fs.existsSync(path.join(worktree, '.claude', 'agentmash')), 'with no launcher of its own');
    assertRealServer(await talkToRegisteredServer(repo, { cwd: worktree, calls: [['who_is_working_on_what', {}]] }));
  } finally {
    await mock.close();
  }
});

/** .mcp.json's entry as init wrote it before it found the launcher from a subfolder too. */
const ROOT_ONLY_ENTRY = { command: 'node', args: ['${CLAUDE_PROJECT_DIR:-.}/.claude/agentmash/mcp_launcher.mjs'] };

test('re-running init brings an MCP registration that starts only from the root up to date', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  const sentry = { command: 'node', args: ['tools/sentry-mcp.mjs'] };
  try {
    assert.equal((await run(['init', '--server', mock.url], { cwd: repo })).code, 0);
    const file = path.join(repo, '.mcp.json');
    const current = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.agentmash;
    // `${CLAUDE_PROJECT_DIR:-.}` expands to ".", the folder a session started
    // in, so from a subfolder this entry named a launcher that was not there
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { sentry, agentmash: ROOT_ONLY_ENTRY } }, null, 2));

    const again = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /brought up to date[^\n]*\.mcp\.json/);
    assert.doesNotMatch(again.stdout, /already had a server called "agentmash"/, "an older entry of ours is nobody else's server");
    const after = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers;
    assert.deepEqual(after.agentmash, current, 'this version\'s entry');
    assert.deepEqual(after.sentry, sentry, 'and theirs as it was');

    const third = await run(['init', '--server', mock.url], { cwd: repo });
    assert.match(third.stdout, /hooks already up to date/);
  } finally {
    await mock.close();
  }
});

test('an entry of ours with keys someone added is still ours, and init keeps them', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    assert.equal((await run(['init', '--server', mock.url], { cwd: repo })).code, 0);
    const file = path.join(repo, '.mcp.json');
    const current = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.agentmash;
    // the type `claude mcp add-json` writes, and an env block a developer added
    const extra = { type: 'stdio', env: { AGENTMASH_MCP_TIMEOUT_MS: '8000' } };
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { agentmash: { ...current, ...extra } } }, null, 2));

    const doctor = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
    assert.match(doctor.stdout, /MCP server registered in \.mcp\.json/);
    assert.doesNotMatch(doctor.stdout, /the way an older version did/, 'the command is this version\'s');
    const again = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /hooks already up to date/, 'nothing of ours to bring up to date');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.agentmash, { ...current, ...extra });

    // an older entry of ours with the same keys: its command brought up to date, the keys kept
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { agentmash: { ...ROOT_ONLY_ENTRY, ...extra } } }, null, 2));
    const third = await run(['init', '--server', mock.url], { cwd: repo });
    assert.match(third.stdout, /brought up to date[^\n]*\.mcp\.json/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.agentmash, { ...current, ...extra });
  } finally {
    await mock.close();
  }
});

test('init keeps the MCP servers a team registered itself', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    fs.writeFileSync(
      path.join(repo, '.mcp.json'),
      JSON.stringify({ mcpServers: { sentry: { command: 'node', args: ['tools/sentry-mcp.mjs'] } } }, null, 2)
    );
    assert.equal((await run(['init', '--server', mock.url], { cwd: repo })).code, 0);

    const mcp = JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8'));
    assert.deepEqual(mcp.mcpServers.sentry, { command: 'node', args: ['tools/sentry-mcp.mjs'] });
    assert.ok(mcp.mcpServers.agentmash);
  } finally {
    await mock.close();
  }
});

test('doctor names who the hooks report as: the login this machine is signed in as for the room’s server, AGENTMASH_DEV over it', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-doctor-home-'));
  try {
    execFileSync('git', ['config', 'user.email', 'bob@example.com'], { cwd: repo });
    await run(['init', '--server', mock.url], { cwd: repo, env: { AGENTMASH_HOME: home } });
    const signIn = (url) => {
      fs.mkdirSync(path.join(home, '.agentmash'), { recursive: true });
      fs.writeFileSync(path.join(home, '.agentmash', 'user.json'), JSON.stringify({ url, token: 'amu_doctordoctordoctordoctor', login: 'Bob-GH' }));
    };
    signIn(mock.url);
    assert.match((await run(['doctor'], { cwd: repo, env: { AGENTMASH_HOME: home } })).stdout, /you are bob-gh {2}\(the GitHub login this machine is signed in as\)/);
    assert.match((await run(['doctor'], { cwd: repo, env: { AGENTMASH_HOME: home, AGENTMASH_DEV: 'bob' } })).stdout, /you are bob {2}\(AGENTMASH_DEV\)/);
    // signed in to another server: this one hears the git email
    signIn('https://agentmash.example');
    assert.match((await run(['doctor'], { cwd: repo, env: { AGENTMASH_HOME: home } })).stdout, /you are bob@example\.com {2}\(git config user\.email\)/);
  } finally {
    await mock.close();
  }
});

test('doctor never names the person running it as their own teammate, under the login it says they are or their git email', async () => {
  // the room shows this machine's work under its login; one server says which names are the asker's, an older one does not
  for (const you of [['bob-gh', 'bob@example.com'], null]) {
    const mock = await startMockServer({ alsoActive: ['bob-gh'], you });
    const repo = makeRepo();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-doctor-self-'));
    execFileSync('git', ['config', 'user.email', 'bob@example.com'], { cwd: repo });
    try {
      await run(['init', '--server', mock.url], { cwd: repo, env: { AGENTMASH_HOME: home } });
      fs.mkdirSync(path.join(home, '.agentmash'), { recursive: true });
      fs.writeFileSync(path.join(home, '.agentmash', 'user.json'), JSON.stringify({ url: mock.url, token: 'amu_doctordoctordoctordoctor', login: 'Bob-GH' }));
      const doctor = await run(['doctor'], { cwd: repo, env: { AGENTMASH_HOME: home } });
      assert.match(doctor.stdout, /you are bob-gh/);
      const teammates = doctor.stdout.split('\n').filter((line) => line.includes('teammate:'));
      assert.equal(teammates.length, 1, doctor.stdout);
      assert.match(teammates[0], /teammate: alice@example\.com/);
      assert.equal(mock.requests.find((r) => r.path === '/activity')?.query.developer, 'bob-gh', 'it names who is asking');
    } finally {
      await mock.close();
    }
  }
});

test('doctor passes on a healthy install', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    // Nothing pointed at a server elsewhere: what init committed is all there is.
    const result = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /All good/);
    assert.match(result.stdout, /hook scripts present/);
    assert.match(result.stdout, /hooks registered/);
    assert.match(result.stdout, /teammates need Node.js 18.12 or newer on their PATH too: these hooks and the MCP server run on it/);
    assert.match(result.stdout, /MCP launcher present/);
    assert.match(result.stdout, /MCP server registered in \.mcp\.json/);
    assert.match(result.stdout, /ask you once to approve the agentmash MCP server/);
    // The count is whatever the server exposes today; what doctor proves is that
    // it started and answered, so pin the shape, not the number.
    assert.match(result.stdout, /the command in \.mcp\.json starts and answers tools\/list  [1-9]\d* tools/);
    assert.match(result.stdout, /server reachable/);
    assert.match(result.stdout, /room valid/);
    assert.match(result.stdout, /you are bob/);
    assert.match(result.stdout, /teammate: alice@example\.com/);

    // and it never puts the room key anywhere a log will copy it verbatim
    const leaked = mock.requests.filter((r) => r.path.includes('mash_'));
    assert.deepEqual(leaked, [], 'no request may carry the room key in its path');
    assert.ok(mock.requests.some((r) => r.path === '/rooms/self'));
  } finally {
    await mock.close();
  }
});

// Many repositories ignore .claude/, and then `git add .claude` refuses the
// folder, a commit leaves the install out, and teammates never get it.
const gitIn = (repo, ...args) => execFileSync('git', args, { cwd: repo, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const tracked = (repo) => gitIn(repo, 'ls-files').split('\n').filter(Boolean).sort();
/** The commit step init printed, as the arguments to give git. */
const printedAdd = (stdout) => {
  const line = /commit and push:\n {4}git (add [^\n]+)\n/.exec(stdout)?.[1];
  assert.ok(line, 'a git add step');
  return line.split(' ');
};

test('init names the files git ignores here, with the rule, and commits them by name with -f; doctor finds them', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.claude/\n');
    const result = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /git ignores 15 files of this install, so a commit leaves them out: teammates never get them/);
    assert.match(result.stdout, /\.claude\/settings\.json, \.claude\/agentmash\/lib\.mjs and 13 more  ignored by \.gitignore:2: \.claude\//);
    assert.doesNotMatch(result.stdout, /\.mcp\.json[^\n]*ignored by/, '.mcp.json is not ignored');
    assert.doesNotMatch(result.stdout, /git add \.claude/, 'git refuses an ignored folder named whole');
    // -f takes settings.json whole, and whatever the repository kept in it: said, with how to look first
    assert.match(result.stdout, /-f commits \.claude\/settings\.json whole, with whatever else is in it: [^\n]*look before you commit: git diff --cached -- \.claude\/settings\.json\n/);

    // the doctor, before anything is committed: present here, missing for everyone else
    const before = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
    assert.equal(before.code, 1);
    assert.match(before.stdout, /✗ git ignores 15 files of this install/);
    assert.match(before.stdout, /commit them by name, with -f: git add -f -- \.claude\/settings\.json \.claude\/agentmash\/lib\.mjs/);
    assert.match(before.stdout, /-f commits \.claude\/settings\.json whole/);

    // what init printed, run as printed, takes every file of the install, and nothing else of .claude
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{}\n');
    gitIn(repo, ...printedAdd(result.stdout));
    const want = [
      '.claude/agentmash/config.json',
      ...['lib.mjs', 'pre_tool_use.mjs', 'post_tool_use.mjs', 'user_prompt_submit.mjs', 'prompt_note.mjs', 'session_start.mjs', 'session_end.mjs', 'stop.mjs', 'mcp_launcher.mjs', 'mcp_server.mjs', 'mcp_coordination.mjs', 'mcp_render.mjs', 'git_post_commit.mjs'].map((f) => `.claude/agentmash/${f}`),
      '.claude/settings.json',
      '.mcp.json',
    ].sort();
    assert.deepEqual(tracked(repo), want);

    // tracked now, so nothing of it is left out, whatever .gitignore says
    const after = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
    assert.doesNotMatch(after.stdout, /git ignores/);
    const again = await run(['init'], { cwd: repo });
    assert.doesNotMatch(again.stdout, /git ignores/);

    // a script brought up to date there is committed by name with -f too: git add .claude exits 1 on the rule
    const commit = (message) => gitIn(repo, '-c', 'user.name=bob', '-c', 'user.email=bob@example.com', 'commit', '-q', '-a', '-m', message);
    commit('add agentmash');
    // as an older version left it
    fs.appendFileSync(path.join(repo, '.claude', 'agentmash', 'stop.mjs'), '// older\n');
    commit('an older stop.mjs');
    const update = await run(['init'], { cwd: repo });
    assert.match(update.stdout, /hooks brought up to date/);
    const add = /commit them by name, with -f, so your teammates get them with their next pull: git (add -f -- [^\n]+)\n/.exec(update.stdout)?.[1];
    assert.ok(add, update.stdout);
    gitIn(repo, ...add.split(' '));
    assert.deepEqual(gitIn(repo, 'diff', '--cached', '--name-only').trim().split('\n'), ['.claude/agentmash/stop.mjs']);
  } finally {
    await mock.close();
  }
});

test('init says when git would commit settings.json without the scripts it runs, and leaves a file a !rule lets back in alone', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    // the scripts ignored, settings.json and .mcp.json let back in
    fs.writeFileSync(path.join(repo, '.gitignore'), '*.mjs\n*.json\n!.claude/settings.json\n!.mcp.json\n');
    const result = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /git ignores 14 files of this install, so a commit leaves them out: teammates get settings\.json without the scripts it runs, and every hook fails/);
    assert.match(result.stdout, /ignored by \.gitignore:1: \*\.mjs/);
    assert.match(result.stdout, /\.claude\/agentmash\/config\.json  ignored by \.gitignore:2: \*\.json/);
    assert.doesNotMatch(result.stdout, /settings\.json[^\n]*ignored by|\.mcp\.json[^\n]*ignored by/);
    assert.doesNotMatch(result.stdout, /-f commits/, 'nothing merged into is taken whole: settings.json and .mcp.json are let back in');
    gitIn(repo, ...printedAdd(result.stdout));
    assert.equal(tracked(repo).length, 16, 'every file of the install');

    // a later init that finds a script git ignores and nobody committed says so again
    gitIn(repo, 'rm', '-q', '--cached', '.claude/agentmash/stop.mjs');
    const again = await run(['init'], { cwd: repo });
    assert.match(again.stdout, /git ignores a file of this install, so a commit leaves it out/);
    assert.match(again.stdout, /commit them by name, with -f: git add -f -- \.claude\/agentmash\/stop\.mjs\n/);
  } finally {
    await mock.close();
  }
});

test('init says -f takes an ignored .mcp.json whole, another server and its token with it, and how to look first', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    // a repository that ignores its dotfiles, and keeps another server's token in .mcp.json
    fs.writeFileSync(path.join(repo, '.gitignore'), '.*\n');
    fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other-mcp', env: { OTHER_TOKEN: 'not-for-git' } } } }, null, 2));
    const result = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /git ignores 16 files of this install[^\n]*\n[^\n]* and 14 more  ignored by \.gitignore:1: \.\*\n/, '.mcp.json among them');
    assert.match(
      result.stdout,
      /-f commits \.claude\/settings\.json and \.mcp\.json whole, with whatever else is in them: if that is anything private \(another server's token, an env block\), look before you commit: git diff --cached -- \.claude\/settings\.json \.mcp\.json\n/
    );
    // and the look it names shows what the commit would take
    gitIn(repo, ...printedAdd(result.stdout));
    assert.match(gitIn(repo, 'diff', '--cached', '--', '.claude/settings.json', '.mcp.json'), /OTHER_TOKEN/);
  } finally {
    await mock.close();
  }
});

// Claude Code reads a repository's hooks only from the folder a session
// starts in: `cd web && claude` ran none of the committed ones, its MCP
// server looked fine, and nothing said it reported nothing. A sign-in's own
// hooks report from there now, with the room the repository carries.
test('doctor warns that a session started in a subfolder reports nothing, unless this machine has hooks that report from there', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-home-'));
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-claude-'));
  const env = { AGENTMASH_DEV: 'bob', AGENTMASH_HOME: home, CLAUDE_CONFIG_DIR: claude };
  try {
    assert.equal((await run(['init', '--server', mock.url], { cwd: repo, env })).code, 0);
    const alone = await run(['doctor'], { cwd: repo, env });
    assert.match(
      alone.stdout,
      /! a Claude Code session started in a subfolder of this repository runs none of its hooks, so it reports nothing\n\s+Start Claude Code at the repository root, or run npx agentmash login: its hooks report from any folder\./
    );
    assert.match(alone.stdout, /All good/, 'a warning, not a problem');

    // this machine's own hooks, where login puts them: a copy from before, then this version's
    const hooks = path.join(home, '.agentmash', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const entry = { matcher: 'Edit', hooks: [{ type: 'command', command: 'node', args: [path.join(hooks, 'post_tool_use.mjs'), '--global'] }] };
    fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [entry] } }));
    fs.writeFileSync(path.join(hooks, 'lib.mjs'), '// a copy from before\n');
    const older = await run(['doctor'], { cwd: repo, env });
    assert.match(older.stdout, /! this machine's hooks are from before they reported a session started in a subfolder of a repository, so one reports nothing/);
    assert.match(older.stdout, /Run npx agentmash login again to bring them up to date/);

    fs.copyFileSync(path.join(CLI_DIR, '..', 'hooks', 'lib.mjs'), path.join(hooks, 'lib.mjs'));
    const current = await run(['doctor'], { cwd: repo, env });
    assert.doesNotMatch(current.stdout, /runs none of its hooks|from before they reported a session/);
  } finally {
    await mock.close();
  }
});

test('doctor falls back to the legacy room lookup on a server without /rooms/self', async () => {
  const mock = await startMockServer({ supportsRoomSelf: false });
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    const result = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /room valid/);
    assert.ok(
      mock.requests.some((r) => r.path === `/rooms/${ROOM}`),
      'an older server still gets the request it understands'
    );
  } finally {
    await mock.close();
  }
});

test('doctor explains an unconfigured repo instead of failing silently', async () => {
  const repo = makeRepo();
  const result = await run(['doctor'], { cwd: repo });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /hook scripts missing/);
  assert.match(result.stdout, /no .claude\/agentmash\/config\.json/);
  assert.match(result.stdout, /Not connected/);
});

// init against a server that is not there said "fetch failed", and pointed
// whoever ran it through npx at an npm script only agentmash's own checkout has
test('init that cannot reach the server says why, in the system’s words, and what to do from anywhere', async () => {
  const mock = await startMockServer();
  const closed = mock.url;
  await mock.close();
  const repo = makeRepo();
  const result = await run(['init', '--server', closed, '--no-open', '--no-git-hook'], { cwd: repo });
  assert.equal(result.code, 1);
  const port = new URL(closed).port;
  assert.match(result.stderr, new RegExp(`could not reach http://127\\.0\\.0\\.1:${port}\\n\\s+connect ECONNREFUSED 127\\.0\\.0\\.1:${port}\\n`));
  assert.doesNotMatch(result.stderr, /fetch failed/);
  assert.match(result.stderr, /Is the address right, and the server up\? Another server: --server <url>\./);
  assert.match(result.stderr, /Running your own: https:\/\/agentmash\.dev\/docs\/self-host/);
  assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'nothing was written');
});

test('doctor reports an unreachable server', async () => {
  const mock = await startMockServer();
  const deadUrl = mock.url;
  const repo = makeRepo();
  await run(['init', '--server', mock.url], { cwd: repo });
  await mock.close();

  const result = await run(['doctor'], { cwd: repo });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /cannot reach/);
  assert.match(result.stdout, new RegExp(deadUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

/** Lines the hooks leave in ~/.agentmash/log/reports.jsonl for reports that never arrived. */
function seedReportLog(home, lines) {
  const file = path.join(home, '.agentmash', 'log', 'reports.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const failed = (repo, url, minutesAgo, fields) => ({
  at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  hook: 'post_tool_use',
  event_type: 'edit',
  tool: 'Edit',
  file_path: 'src/models/user.ts',
  repo,
  room_ref: 'rm_abc123',
  url,
  ms: 40,
  ...fields,
});

test('doctor lists reports that never reached the room, with a fix for each cause', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-home-'));
  const env = { AGENTMASH_HOME: home, AGENTMASH_DEV: 'bob' };
  try {
    await run(['init', '--server', mock.url], { cwd: repo, env });
    const elsewhere = makeRepo();
    seedReportLog(home, [
      failed(repo, mock.url, 60, { outcome: 'refused', status: 401, code: 'token_required' }),
      failed(repo, mock.url, 50, { outcome: 'refused', status: 401, code: 'token_required' }),
      failed(repo, mock.url, 30, { outcome: 'no_reply', error: 'timeout', ms: 2500 }),
      failed(repo, mock.url, 20, { outcome: 'cut_off', ms: 4400 }),
      failed(repo, mock.url, 10, { outcome: 'no_reply', error: 'ECONNREFUSED', ms: 3 }),
      // another repository's, and one from before the week doctor looks at
      failed(elsewhere, mock.url, 5, { outcome: 'refused', status: 410, code: 'room_deleted' }),
      failed(repo, mock.url, 8 * 24 * 60, { outcome: 'refused', status: 401, code: 'room_unauthorized' }),
    ]);

    const result = await run(['doctor'], { cwd: repo, env });
    assert.match(result.stdout, /5 reports from this machine never reached the room in the last 7 days/);
    assert.match(result.stdout, /2× refused \(401 token_required\)[^\n]*npx agentmash login --room/);
    assert.match(result.stdout, /1× no reply \(timeout\)[^\n]*timeout_ms/);
    assert.match(result.stdout, /1× cut off[^\n]*timeout_ms/);
    assert.match(result.stdout, /1× no reply \(ECONNREFUSED\)[^\n]*could not be reached/);
    assert.doesNotMatch(result.stdout, /room_deleted|room_unauthorized/, 'only this repository, only this week');
    assert.match(result.stdout, /reports\.jsonl/, 'and where the log is');
    // a warning, not a failure: they are what happened, and may be fixed by now
    assert.equal(result.code, 0, result.stdout + result.stderr);
  } finally {
    await mock.close();
  }
});

test('doctor does not ask for a longer timeout_ms than a hook has before Claude Code stops it', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-home-'));
  const env = { AGENTMASH_HOME: home, AGENTMASH_DEV: 'bob' };
  try {
    await run(['init', '--server', mock.url], { cwd: repo, env });
    const configFile = path.join(repo, '.claude', 'agentmash', 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, JSON.stringify({ ...config, timeout_ms: 6000 }, null, 2));
    seedReportLog(home, [
      failed(repo, mock.url, 30, { outcome: 'no_reply', error: 'timeout', ms: 4300 }),
      failed(repo, mock.url, 20, { outcome: 'cut_off', ms: 4450 }),
    ]);

    const result = await run(['doctor'], { cwd: repo, env });
    const lines = result.stdout.split('\n').filter((l) => /^\s+1× (cut off|no reply)/.test(l));
    assert.equal(lines.length, 2, result.stdout);
    for (const line of lines) {
      assert.doesNotMatch(line, /raise|higher/, 'a longer budget cannot help any more');
      assert.match(line, /4\.5 s/, 'the hook\'s own deadline is the cap');
    }
  } finally {
    await mock.close();
  }
});

test('doctor flags a hook entry whose script does not exist, and hooks from an older install', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    const file = path.join(repo, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    settings.hooks.PreToolUse.push({ matcher: 'Write|Edit|MultiEdit', hooks: [ourHook('pre_tool_use.mjs', 'agentmesh')] });
    settings.hooks.PostToolUse[0].matcher = 'Write|Edit|MultiEdit';
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));

    const result = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /PreToolUse runs \.claude\/agentmesh\/pre_tool_use\.mjs, which does not exist/);
    assert.match(result.stdout, /PostToolUse is registered for Write\|Edit\|MultiEdit/);
    assert.match(result.stdout, /Bash/);
    assert.match(result.stdout, /run: agentmash init/);
  } finally {
    await mock.close();
  }
});

// A settings file that does not read was counted as no hooks registered,
// with init for the fix, and init refuses to touch it: it says why instead.
test('doctor says a .claude/settings.json that is not JSON, or not an object, is that, as init does', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  const file = path.join(repo, '.claude', 'settings.json');
  try {
    await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: repo });
    for (const [text, said] of [
      ['{ "hooks": { this is not json', /✗ \.claude\/settings\.json is not valid JSON, so Claude Code runs none of its hooks — fix or move it, then run: agentmash init/],
      ['[]', /✗ \.claude\/settings\.json must contain a JSON object at the top level, so Claude Code runs none of its hooks/],
    ]) {
      fs.writeFileSync(file, text);
      const result = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
      assert.equal(result.code, 1, text);
      assert.match(result.stdout, said);
      assert.doesNotMatch(result.stdout, /hook events registered/, text);
    }
  } finally {
    await mock.close();
  }
});

test("an install from 0.6.0 hears that Devin's edit tools go unwatched, and init brings it up to date", async () => {
  // Devin reads .claude/settings.json and calls its edit tools write, edit and
  // apply_patch; the matchers 0.6.0 wrote follow Claude Code's names only.
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    const file = path.join(repo, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    settings.hooks.PreToolUse[0].matcher = 'Write|Edit|MultiEdit|NotebookEdit';
    settings.hooks.PostToolUse[0].matcher = 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell';
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));

    const doctor = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
    assert.match(doctor.stdout, /PreToolUse is registered for Write\|Edit\|MultiEdit\|NotebookEdit, from an older install: write, edit, apply_patch, Bash and PowerShell go unwatched/);

    const again = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /hooks brought up to date/);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.hooks.PreToolUse.length, 1);
    assert.equal(after.hooks.PreToolUse[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit|write|edit|apply_patch|Bash|PowerShell');
    assert.equal(after.hooks.PostToolUse[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit|write|edit|apply_patch|Bash|PowerShell');
    assert.doesNotMatch((await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } })).stdout, /unwatched/);
  } finally {
    await mock.close();
  }
});

test('an install from 0.13 hears that a PowerShell command goes unchecked before it runs, and init brings it up to date', async () => {
  // 0.13.1 checked a Bash command before it ran, and not Claude Code's PowerShell tool
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    const file = path.join(repo, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    settings.hooks.PreToolUse[0].matcher = 'Write|Edit|MultiEdit|NotebookEdit|write|edit|apply_patch|Bash';
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));

    const doctor = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
    assert.match(doctor.stdout, /PreToolUse is registered for [^\n]*\|Bash, from an older install: PowerShell goes unwatched — run: agentmash init/);
    const again = await run(['init', '--server', mock.url], { cwd: repo });
    assert.match(again.stdout, /hooks brought up to date/);
    assert.match(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse[0].matcher, /\|Bash\|PowerShell$/);
  } finally {
    await mock.close();
  }
});

test('every reconcile mode is advice: the CLI never says an agent will commit, push or open a pull request', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    const onItsOwn = /pull request|\bPR\b|\bcommit|\bpush|reconciles? and/i;
    for (const mode of ['approve', 'auto', 'off']) {
      const set = await run(['reconcile', mode], { cwd: repo });
      assert.equal(set.code, 0, set.stderr);
      assert.doesNotMatch(set.stdout, onItsOwn, mode);
      assert.match(set.stdout, mode === 'off' ? /says nothing/ : /tells the person/, mode);
      const shown = await run(['reconcile'], { cwd: repo });
      assert.match(shown.stdout, new RegExp(`Reconciliation\\s+${mode}`));
      const doctor = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
      const line = doctor.stdout.split('\n').find((l) => l.includes('reconciliation'));
      assert.ok(line, 'doctor says what the room does at a collision');
      assert.doesNotMatch(line, onItsOwn, `doctor, ${mode}`);
    }
    assert.doesNotMatch((await run(['--help'])).stdout.split('\n').find((l) => l.includes('reconcile')), onItsOwn);
  } finally {
    await mock.close();
  }
});

test('--help lists what exists, logout among it, with every flag in one column, and no colour into a pipe', () => {
  for (const env of [{}, { NO_COLOR: '1' }]) {
    const help = spawnSync(process.execPath, [CLI, '--help'], { env: { ...baseEnv, ...env }, encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.ok(!help.stdout.includes('\u001b['), 'no ANSI codes when stdout is not a terminal');
    assert.match(help.stdout, /npx agentmash logout/);
    // the digest the package carries, by the command that runs it: agentmash-digest is not on npm
    assert.match(help.stdout, /npx agentmash digest/);
    assert.doesNotMatch(help.stdout, /agentmash-digest/, 'not on npm: a command that 404s is not one to list');
    const flags = help.stdout.split('\n').filter((line) => /^  --[a-z]/.test(line));
    assert.ok(flags.length >= 10, `${flags.length} flag lines`);
    for (const line of flags) {
      const said = /^  --\S+(?: <[^>]+>)?\s+(?=\S)/.exec(line);
      if (!said) continue; // a flag whose words go on the next line
      assert.equal(said[0].length, 19, `"${line}" starts its words in column 19`);
    }
  }
});

// /pricing and /docs/security tell an admin to run `secure --retention-days 90`,
// and --help never said the option was there
test('--help says secure sets how long the room keeps its history, and how', async () => {
  const help = await run(['--help']);
  const lines = help.stdout.split('\n');
  const flag = lines.findIndex((line) => line.startsWith('  --retention-days '));
  assert.ok(flag !== -1, 'a line of its own among the flags');
  assert.match(`${lines[flag]} ${lines[flag + 1]}`, /with secure: how many days of history the room keeps, 1 to 365\s+\(up to the plan's\), or default/);
  const secure = lines.findIndex((line) => line.includes('npx agentmash secure'));
  assert.match(lines[secure + 1], /--retention-days/, 'and the command names it');
});

test('no command writes colour into a pipe, or with NO_COLOR set', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    for (const args of [['doctor'], ['status'], ['not-a-command']]) {
      const out = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env: { ...baseEnv, AGENTMASH_DEV: 'carol' }, encoding: 'utf8' });
      assert.ok(!`${out.stdout}${out.stderr}`.includes('\u001b['), `${args.join(' ')}: no ANSI codes`);
    }
  } finally {
    await mock.close();
  }
});

test('doctor says how long ago it heard a teammate, not a raw timestamp', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    const doctor = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'carol' } });
    const teammates = doctor.stdout.split('\n').filter((line) => line.includes('teammate:'));
    assert.equal(teammates.length, 2, doctor.stdout);
    assert.match(teammates.join('\n'), /teammate: alice@example\.com\s+22 min ago/);
    assert.match(teammates.join('\n'), /teammate: bob@example\.com\s+1 min ago/);
    assert.doesNotMatch(teammates.join('\n'), /\d{4}-\d{2}-\d{2}T/);
  } finally {
    await mock.close();
  }
});

test('outside a repository, status says the folder is the problem, and doctor asks nobody to approve a server', async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-not-a-repo-')));
  const status = await run(['status'], { cwd: folder });
  assert.equal(status.code, 1);
  const lines = `${status.stdout}${status.stderr}`.split('\n').filter((l) => /[✗!]/.test(l));
  assert.match(lines[0] ?? '', /not (?:inside )?a git repository/, 'the folder comes first');
  assert.doesNotMatch(lines[0] ?? '', /signed in/);

  const doctor = await run(['doctor'], { cwd: folder });
  assert.match(doctor.stdout, /not a git repository/);
  assert.doesNotMatch(doctor.stdout, /approve the agentmash MCP server/, 'no .mcp.json here registers one');
});

test('status says when edits have not been reaching the room', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-home-'));
  try {
    await run(['init', '--server', mock.url], { cwd: repo, env: { AGENTMASH_HOME: home } });
    const quiet = await run(['status'], { cwd: repo, env: { AGENTMASH_HOME: home } });
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.doesNotMatch(quiet.stdout, /never reached the room/);

    seedReportLog(home, [
      failed(repo, mock.url, 90, { outcome: 'refused', status: 401, code: 'token_required' }),
      failed(repo, mock.url, 3, { outcome: 'no_reply', error: 'timeout' }),
      failed(repo, mock.url, 3 * 24 * 60, { outcome: 'no_reply', error: 'timeout' }),
    ]);
    const result = await run(['status'], { cwd: repo, env: { AGENTMASH_HOME: home } });
    assert.equal(result.code, 0, result.stderr);
    const warnings = result.stdout.split('\n').filter((l) => /never reached the room/.test(l));
    assert.equal(warnings.length, 1, 'one line, not a list');
    assert.match(warnings[0], /2 reports from this machine never reached the room in the last 24 hours/);
    assert.match(warnings[0], /agentmash doctor/);
    assert.match(result.stdout, /alice@example\.com/, 'and the board as always');
  } finally {
    await mock.close();
  }
});

test('status prints who is working on what', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    const result = await run(['status'], { cwd: repo });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /alice@example\.com/);
    assert.match(result.stdout, /refactor the user model/);
    assert.match(result.stdout, /hot files/);
    assert.match(result.stdout, /src\/models\/user\.ts/);
    // A bare name and a timestamp read as "here"; the state has to be said out loud.
    assert.match(result.stdout, /no signal/);
  } finally {
    await mock.close();
  }
});

test('status pairs each file with the prompt it was edited under', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    const result = await run(['status'], { cwd: repo });
    assert.equal(result.code, 0, result.stderr);
    // bob edited the API for the role change, then asked for the README fix
    assert.match(result.stdout, /now: fix the typo in the README/);
    assert.match(result.stdout, /src\/api\/users\.ts · "add role and isAdmin to the user model"/);
    assert.doesNotMatch(result.stdout, /fix the typo in the README\n\S*\s+src\/api\/users\.ts\S*\n/, 'the new prompt is not the file\'s');
    // alice's file was edited for the prompt she is still on: said once, as always
    assert.doesNotMatch(result.stdout, /now: refactor the user model/);
    assert.doesNotMatch(result.stdout, /src\/models\/user\.ts · /);
  } finally {
    await mock.close();
  }
});

test('uninstall removes our hooks and leaves others alone', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo keep' }] }] } })
    );
    await run(['init', '--server', mock.url], { cwd: repo });
    const result = await run(['uninstall'], { cwd: repo });
    assert.equal(result.code, 0, result.stderr);

    assert.ok(!fs.existsSync(path.join(repo, '.claude', 'agentmash')), 'hook dir should be gone');
    const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.hooks.PostToolUse.length, 1);
    assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, 'echo keep');
    assert.equal(settings.hooks.PreToolUse, undefined, 'emptied events should be removed');
  } finally {
    await mock.close();
  }
});

/**
 * The check that claims to prove the install works has to run what Claude Code
 * runs. Spawning the launcher by its resolved path proves the file is fine and
 * says nothing about the registration — so a .mcp.json whose command cannot
 * start reports green, and the tools are silently absent from every session.
 */
test('doctor fails when the command in .mcp.json cannot start', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    // The documented failure mode: an unset variable with no default is left in
    // the path verbatim, so node is handed a path that cannot exist.
    fs.writeFileSync(
      path.join(repo, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            agentmash: {
              command: 'node',
              args: ['${AGENTMASH_NOT_SET}/.claude/agentmash/mcp_launcher.mjs'],
            },
          },
        },
        null,
        2
      )
    );

    // The launcher and the server beside it are perfect: only the registration
    // is broken, which is exactly what a check of the files would miss.
    const result = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /the command in \.mcp\.json did not start/);
    assert.match(result.stdout, /\$\{AGENTMASH_NOT_SET\}/, 'show the command that actually ran');
    assert.doesNotMatch(result.stdout, /starts and answers tools\/list/);
  } finally {
    await mock.close();
  }
});

test('doctor starts the server the way .mcp.json says, from the root and from a subfolder', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    fs.mkdirSync(path.join(repo, 'src'));
    const result = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /the command in \.mcp\.json starts and answers tools\/list  [1-9]\d* tools/);
    // the command out of .mcp.json, expanded the way Claude Code expands it,
    // not the launcher's resolved path, which would prove a path nobody takes
    assert.match(result.stdout, /node --input-type=module -e /);
    assert.match(result.stdout, /and from src\/ too/, 'where a session started in a subfolder runs it');
  } finally {
    await mock.close();
  }
});

/**
 * The walk up from .mcp.json stops by design at a folder with a launcher of its
 * own, a .mcp.json that registers the server itself, or a .git folder of its
 * own. A session started below one of those is that folder's business, so the
 * start from a subfolder that doctor makes has to come from a folder the walk
 * is meant to cross: src/ here, though each of these sorts before it.
 */
test('doctor starts the server from a subfolder that leads back to the root, not a clone kept inside it', async () => {
  const mock = await startMockServer();
  try {
    const layouts = [
      // a dependency cloned into the project to hack on, kept out of git
      [
        'a clone kept inside the repository',
        (repo) => {
          fs.mkdirSync(path.join(repo, 'api-client'));
          execFileSync('git', ['init', '-q'], { cwd: path.join(repo, 'api-client'), stdio: 'ignore', env: baseEnv });
          fs.appendFileSync(path.join(repo, '.gitignore'), 'api-client/\n');
          return 'api-client';
        },
      ],
      // a sample project that registers the server for itself
      [
        'a folder whose .mcp.json registers the server',
        (repo) => {
          fs.mkdirSync(path.join(repo, 'example'));
          fs.copyFileSync(path.join(repo, '.mcp.json'), path.join(repo, 'example', '.mcp.json'));
          return 'example';
        },
      ],
      // another install's launcher, which the walk would start instead of this one's
      [
        'a folder with a launcher of its own',
        (repo) => {
          plantLauncher(path.join(repo, 'bench'));
          return 'bench';
        },
      ],
    ];
    for (const [layout, build] of layouts) {
      const repo = makeRepo();
      assert.equal((await run(['init', '--server', mock.url], { cwd: repo })).code, 0, layout);
      fs.mkdirSync(path.join(repo, 'src'));
      const skipped = build(repo);
      const result = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
      assert.equal(result.code, 0, `${layout}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /and from src\/ too/, layout);
      assert.doesNotMatch(result.stdout, new RegExp(`not from ${skipped}/`), layout);
      assert.ok(!fs.existsSync(path.join(repo, skipped, 'the planted launcher ran')), `${layout}: nothing in it ran`);

      // and with no other folder, from .claude, which init made
      fs.rmSync(path.join(repo, 'src'), { recursive: true });
      const alone = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
      assert.equal(alone.code, 0, `${layout}, alone: ${alone.stdout}${alone.stderr}`);
      assert.match(alone.stdout, /and from \.claude\/ too/, layout);
    }
  } finally {
    await mock.close();
  }
});

test('doctor fails a registration that starts only from the root of the repository', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { agentmash: ROOT_ONLY_ENTRY } }, null, 2));
    const result = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /starts from the root of the repository but not from src\//);
    assert.match(result.stdout, /run: agentmash init/);
    assert.doesNotMatch(result.stdout, /npm install/);
  } finally {
    await mock.close();
  }
});

test('doctor calls out an MCP server that can only report itself unavailable', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    // The server gone from beside the launcher, no copy of it on this machine
    // (a home of the test's own), and no npm to fetch one from.
    fs.rmSync(path.join(repo, '.claude', 'agentmash', 'mcp_server.mjs'), { force: true });
    const result = await run(['doctor'], { cwd: repo, env: { AGENTMASH_MCP_NPX: '0' } });
    assert.equal(result.code, 1, 'a degraded MCP server is a problem, not a detail');
    assert.match(result.stdout, /MCP server started in degraded mode/);
    assert.match(result.stdout, /mcp_server\.mjs/, 'it says what is missing');
    assert.match(result.stdout, /agentmash init/, 'and what puts it back');
    assert.doesNotMatch(result.stdout, /npm install/, 'installing the package into the repo is not the fix');
    assert.doesNotMatch(result.stdout, /starts and answers tools\/list/);
  } finally {
    await mock.close();
  }
});

test('uninstall leaves a .mcp.json that had other servers in it', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    fs.writeFileSync(
      path.join(repo, '.mcp.json'),
      JSON.stringify({ mcpServers: { sentry: { command: 'node', args: ['tools/sentry-mcp.mjs'] } } }, null, 2)
    );
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.claude', 'settings.json'),
      JSON.stringify({ enabledMcpjsonServers: ['sentry'] })
    );
    await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal((await run(['uninstall'], { cwd: repo })).code, 0);

    const mcp = JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8'));
    assert.deepEqual(mcp.mcpServers.sentry, { command: 'node', args: ['tools/sentry-mcp.mjs'] });
    assert.equal(mcp.mcpServers.agentmash, undefined);

    const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.enabledMcpjsonServers, ['sentry'], 'their approval must survive ours');
  } finally {
    await mock.close();
  }
});

test('uninstall removes a .mcp.json and a .claude/settings.json it created, and the .claude it leaves empty', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    assert.ok(fs.existsSync(path.join(repo, '.mcp.json')));
    assert.equal((await run(['uninstall'], { cwd: repo })).code, 0);
    assert.ok(!fs.existsSync(path.join(repo, '.mcp.json')), 'a file we created and emptied should go');
    // it used to stay, untracked, holding {"hooks": {}}
    assert.ok(!fs.existsSync(path.join(repo, '.claude', 'settings.json')), 'and so should the settings it held nothing but ours in');
    assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'and the .claude/ init made for them');
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, env: baseEnv }).toString(), '', 'nothing left behind');
  } finally {
    await mock.close();
  }
});

test("uninstall never deletes a settings file with anything of the developer's in it", async () => {
  const mock = await startMockServer();
  try {
    for (const theirs of [{ model: 'opus' }, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }, { permissions: { allow: [] } }]) {
      const repo = makeRepo();
      fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify(theirs));
      fs.writeFileSync(path.join(repo, '.claude', 'notes.md'), 'mine\n');
      await run(['init', '--server', mock.url], { cwd: repo });
      assert.equal((await run(['uninstall'], { cwd: repo })).code, 0);
      const left = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
      assert.deepEqual(left, theirs, 'what was theirs, as it was');
      assert.ok(fs.existsSync(path.join(repo, '.claude', 'notes.md')));
    }
  } finally {
    await mock.close();
  }
});

/**
 * A home directory as a machine signed in with `npx agentmash login` has it:
 * Claude Code's own settings in ~/.claude/settings.json, with the sign-in's
 * hooks and someone's approval of an MCP server called agentmash in them, a
 * ~/.claude/agentmash/ and a ~/.mcp.json of theirs. Returns the home and
 * a snapshot of all of it, to compare after a command that must not touch it.
 */
function homeDirectory() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-homedir-')));
  const files = {
    '.claude/settings.json': JSON.stringify(
      {
        enabledMcpjsonServers: ['agentmash'],
        hooks: {
          PostToolUse: [
            { matcher: 'Edit', hooks: [{ type: 'command', command: 'node', args: [`${home}/.agentmash/hooks/post_tool_use.mjs`, '--global'] }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: [`${home}/.claude/agentmash/audit.mjs`] }] },
          ],
        },
      },
      null,
      2
    ),
    '.claude/agentmash/audit.mjs': '// theirs\n',
    '.mcp.json': JSON.stringify({ mcpServers: { agentmash: { command: 'npx', args: ['agentmash', 'mcp'] } } }),
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), content);
  }
  const snapshot = () => Object.fromEntries(Object.keys(files).map((rel) => [rel, fs.readFileSync(path.join(home, rel), 'utf8')]));
  return { home, files, snapshot, env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') } };
}

// uninstall takes AgentMash out of one repository. Outside one, it used to take
// the folder it was run in for the repository: in the home directory that is
// Claude Code's settings for every project, rewritten, and ~/.claude/agentmash
// deleted outright. Taking AgentMash off the machine is logout's to do.
test('uninstall refuses to run outside a repository, and says logout is what takes it off the machine', async () => {
  const { home, files, snapshot, env } = homeDirectory();
  const notes = path.join(home, 'notes');
  fs.mkdirSync(notes);
  for (const cwd of [home, notes]) {
    const result = await run(['uninstall'], { cwd, env });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /not inside a git repository/);
    assert.match(result.stderr, /npx agentmash logout/);
  }
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-not-a-repo-')));
  const named = await run(['uninstall', '--repo', elsewhere], { cwd: home, env });
  assert.equal(named.code, 1, named.stdout);
  assert.match(named.stderr, /not a git repository/);
  // --repo was the thing given: saying "or pass --repo <path>" back sent people in a circle
  assert.doesNotMatch(named.stderr, /pass --repo/);
  assert.match(named.stderr, /--repo/);
  assert.deepEqual(snapshot(), files, 'nothing in the home directory was touched');
});

// A dotfiles checkout makes the home directory a git repository, and it is
// still nobody's project: its .claude/ is the machine's.
test('no command takes the home directory for a repository, even when it is one', async () => {
  const mock = await startMockServer();
  const { home, files, snapshot, env } = homeDirectory();
  execFileSync('git', ['init', '-q'], { cwd: home, stdio: 'ignore' });
  const notes = path.join(home, 'notes');
  fs.mkdirSync(notes);
  const repo = makeRepo();
  try {
    const attempts = [
      { args: ['uninstall'], cwd: home },
      { args: ['uninstall'], cwd: notes },
      { args: ['uninstall', '--repo', home], cwd: repo },
      { args: ['init', '--server', mock.url, '--no-open'], cwd: notes },
      { args: ['join', ROOM, '--server', mock.url, '--no-open'], cwd: home },
      { args: ['git-hook', 'install'], cwd: home },
      { args: ['git-hook', 'uninstall'], cwd: home },
    ];
    for (const { args, cwd } of attempts) {
      const result = await run(args, { cwd, env });
      assert.equal(result.code, 1, `${args.join(' ')}: ${result.stdout}`);
      assert.match(result.stderr, /is your home directory/, args.join(' '));
    }
    const uninstall = await run(['uninstall'], { cwd: home, env });
    assert.match(uninstall.stderr, /npx agentmash logout/, 'uninstall says what does take it off the machine');
    assert.deepEqual(snapshot(), files, 'nothing in the home directory was touched');
    assert.ok(!fs.existsSync(path.join(home, '.git', 'hooks', 'post-commit')), 'and no git hook went into it');
    assert.deepEqual(mock.requests, [], 'and no room was made for it');
  } finally {
    await mock.close();
  }
});

// rotate and login --room write the room into .claude/agentmash/config.json,
// which reaches the team only in a commit. Outside a repository they took the
// folder they were run in, and with the room in the environment a rotation
// put the new key where nobody would ever commit it.
test('rotate and login --room refuse to run outside a repository', async () => {
  const mock = await startMockServer();
  const { home, files, snapshot, env } = homeDirectory();
  const roomEnv = { ...env, AGENTMASH_URL: mock.url, AGENTMASH_ROOM: ROOM, AGENTMASH_DEV: 'bob' };
  try {
    for (const args of [['rotate'], ['login', '--room', '--local']]) {
      const result = await run(args, { cwd: home, env: roomEnv });
      assert.equal(result.code, 1, `${args.join(' ')}: ${result.stdout}`);
      assert.match(result.stderr, /not inside a git repository/, args.join(' '));
    }
    assert.deepEqual(snapshot(), files);
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'agentmash', 'config.json')), 'no room was written into the home directory');
    assert.deepEqual(mock.requests, [], 'and the server was never asked to rotate a key nobody would receive');
  } finally {
    await mock.close();
  }
});

test('refuses to touch a settings.json it cannot parse', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{ this is not json');
    const result = await run(['init', '--server', mock.url], { cwd: repo });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not valid JSON/);
    assert.equal(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'), '{ this is not json');
    assert.equal(
      mock.requests.filter((r) => r.path === '/rooms' && r.method === 'POST').length,
      0,
      'must not create an orphan room before discovering the repo is unwritable'
    );
  } finally {
    await mock.close();
  }
});

/**
 * The launcher is committed into a consumer's repo, so whatever version it names
 * is frozen there until someone re-runs `init`. A hand-written constant is how
 * it came to pin a version that was never published; the packer generates it now.
 */
test('the packed launcher pins the version it was packed with', () => {
  const version = JSON.parse(fs.readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8')).version;
  const packed = fs.readFileSync(path.join(CLI_DIR, 'hooks', 'mcp_launcher.mjs'), 'utf8');
  assert.match(
    packed,
    new RegExp(`const PINNED_VERSION = '${version.replace(/\./g, '\\.')}'; // agentmash:pin`),
    'npm pack must stamp this package\'s own version into the launcher'
  );

  const source = fs.readFileSync(path.join(CLI_DIR, '..', 'hooks', 'mcp_launcher.mjs'), 'utf8');
  assert.match(stampVersion(source, '9.9.9'), /const PINNED_VERSION = '9\.9\.9'; \/\/ agentmash:pin/);
  assert.throws(
    () => stampVersion("const PINNED_VERSION = '0.0.0';", '9.9.9'),
    /agentmash:pin/,
    'a marker that has drifted must stop the pack, not ship an unstamped pin'
  );
});

/**
 * The server is committed beside the launcher and frozen there the same way.
 * Its version is what a launcher compares with the copy a newer `npx agentmash
 * login` put on the machine, and what doctor holds against this CLI's.
 */
test('the packed MCP server says the version it was packed with', () => {
  const version = JSON.parse(fs.readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8')).version;
  const stampServerVersion = sync.stampServerVersion;
  assert.equal(typeof stampServerVersion, 'function', 'sync-hooks.mjs stamps the server');
  const packed = fs.readFileSync(path.join(CLI_DIR, 'hooks', 'mcp_server.mjs'), 'utf8');
  assert.match(packed, new RegExp(`export const VERSION = '${version.replace(/\./g, '\\.')}'; // agentmash:version`));

  const source = fs.readFileSync(path.join(CLI_DIR, '..', 'hooks', 'mcp_server.mjs'), 'utf8');
  assert.match(stampServerVersion(source, '9.9.9'), /export const VERSION = '9\.9\.9'; \/\/ agentmash:version/);
  assert.throws(() => stampServerVersion("export const VERSION = '0.0.0';", '9.9.9'), /agentmash:version/);
});

/**
 * The hooks are committed and frozen the same way, and what they were packed
 * as is what they send with every request and what a newer login's copy holds
 * a repository's committed one against.
 */
test('the packed hooks say the version they were packed with', () => {
  const version = JSON.parse(fs.readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8')).version;
  const stampHooksVersion = sync.stampHooksVersion;
  assert.equal(typeof stampHooksVersion, 'function', 'sync-hooks.mjs stamps the hooks');
  const packed = fs.readFileSync(path.join(CLI_DIR, 'hooks', 'lib.mjs'), 'utf8');
  assert.match(packed, new RegExp(`export const HOOKS_VERSION = '${version.replace(/\./g, '\\.')}'; // agentmash:hooks-version`));

  const source = fs.readFileSync(path.join(CLI_DIR, '..', 'hooks', 'lib.mjs'), 'utf8');
  assert.match(stampHooksVersion(source, '9.9.9'), /export const HOOKS_VERSION = '9\.9\.9'; \/\/ agentmash:hooks-version/);
  assert.throws(() => stampHooksVersion("export const HOOKS_VERSION = '0.0.0';", '9.9.9'), /agentmash:hooks-version/);
});

/**
 * `files` in package.json packs whatever cli/hooks/ holds, so the sync takes
 * out what it no longer copies. A temporary file of a sync that is still
 * running is on its way to a rename and stays; one whose sync died before the
 * rename never gets there, and goes too.
 */
test('the sync takes out what it no longer copies, and the temporary files of a sync that died', () => {
  const pruneStale = sync.pruneStale;
  assert.equal(typeof pruneStale, 'function', 'sync-hooks.mjs exports the prune it runs');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-sync-'));
  // a process that has come and gone, the way a sync killed mid-copy has
  const died = spawnSync(process.execPath, ['-e', '']).pid;
  const running = `lib.mjs.${process.pid}.tmp`;
  for (const name of ['lib.mjs', 'coordination.mjs', running, `lib.mjs.${died}.tmp`]) {
    fs.writeFileSync(path.join(dest, name), '');
  }
  pruneStale(dest, ['lib.mjs']);
  assert.deepEqual(fs.readdirSync(dest).sort(), ['lib.mjs', running].sort());
});

/**
 * A pack from a Windows checkout with core.autocrlf would ship CRLF, as 0.12.0
 * did: the sync names the packed files that have a CRLF line ending so a pack
 * can stop on them, walks a folder whole, and leaves a binary file alone.
 */
test('the sync finds the packed files with CRLF line endings, and skips a binary one', () => {
  const crlfFiles = sync.crlfFiles;
  assert.equal(typeof crlfFiles, 'function', 'sync-hooks.mjs exports the line-ending check it runs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-eol-'));
  fs.mkdirSync(path.join(root, 'hooks', 'dialects'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agentmash.mjs'), '#!/usr/bin/env node\nconsole.log(1);\n');
  fs.writeFileSync(path.join(root, 'hooks', 'lib.mjs'), 'export const a = 1;\r\nexport const b = 2;\r\n');
  fs.writeFileSync(path.join(root, 'hooks', 'dialects', 'kiro.mjs'), 'export default {};\r\n');
  fs.writeFileSync(path.join(root, 'hooks', 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x0d, 0x0a]));
  assert.deepEqual(crlfFiles(root, ['agentmash.mjs', 'hooks/', 'missing.mjs']), ['hooks/dialects/kiro.mjs', 'hooks/lib.mjs']);
  assert.deepEqual(crlfFiles(root, ['agentmash.mjs']), []);
});

test('rotate writes the new room key into the committed config', async () => {
  const repo = makeRepo();
  const mock = await startMockServer();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    const before = JSON.parse(fs.readFileSync(path.join(repo, '.claude/agentmash/config.json'), 'utf8'));
    assert.equal(before.room, ROOM);

    const res = await run(['rotate'], { cwd: repo });
    assert.equal(res.code, 0);
    const after = JSON.parse(fs.readFileSync(path.join(repo, '.claude/agentmash/config.json'), 'utf8'));
    assert.equal(after.room, ROTATED_ROOM, 'the repo now carries the new key');
    assert.equal(after.label, before.label, 'everything else survives');
    assert.match(res.stdout, /old key keeps working until/);
    assert.match(res.stdout, /git add \.claude/, 'the flow ends in a commit and a teammate pull');
    assert.match(res.stdout, /\n {4}git add \.claude\n {4}git commit -m "Rotate the agentmash room key"\n {4}git push\n/, 'a command to a line');
    assert.doesNotMatch(res.stdout, /&&/, 'which every shell runs, PowerShell 5.1 among them');
  } finally {
    await mock.close();
  }
});

test('rotate, in a repository that ignores .claude/, prints an add git takes without an error', async () => {
  const repo = makeRepo();
  const mock = await startMockServer();
  try {
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.claude/\n');
    // no git hook: the commit below would report in the background, after this test's server has gone
    const init = await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: repo });
    gitIn(repo, ...printedAdd(init.stdout));
    gitIn(repo, '-c', 'user.name=bob', '-c', 'user.email=bob@example.com', 'commit', '-q', '-m', 'add agentmash');

    const res = await run(['rotate'], { cwd: repo });
    assert.equal(res.code, 0, res.stderr);
    // git add .claude, or the file named without -f, exits 1 on "paths are ignored" there
    assert.match(res.stdout, /\n {4}git add -f -- \.claude\/agentmash\/config\.json\n {4}git commit -m "Rotate the agentmash room key"\n/);
    const add = /\n {4}git (add -f [^\n]+)\n/.exec(res.stdout)[1].split(' ');
    gitIn(repo, ...add);
    assert.equal(gitIn(repo, 'diff', '--cached', '--name-only').trim(), '.claude/agentmash/config.json', 'the new key, and nothing else');
  } finally {
    await mock.close();
  }
});

test('rotate will not write a new key to commit to a public repository either, and leaves the old one working', async () => {
  const repo = makeRepo();
  const mock = await startMockServer();
  try {
    await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: repo });
    // the repository went public since: a fresh key committed there would be anyone's at once
    addRemote(repo, 'origin', 'git@github.com:acme/app.git');
    github.answers['acme/app'] = PUBLIC_REPO;
    const refused = await run(['rotate'], { cwd: repo });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /acme\/app is public on GitHub, so rotate will not commit a room key to it/);
    assert.match(refused.stderr, /npx agentmash rotate --allow-public-key/);
    assert.ok(!mock.requests.some((r) => r.path === '/rooms/rotate'), 'the server is not asked to rotate');
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.claude/agentmash/config.json'), 'utf8')).room, ROOM);

    const forced = await run(['rotate', '--allow-public-key'], { cwd: repo });
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.claude/agentmash/config.json'), 'utf8')).room, ROTATED_ROOM);
  } finally {
    delete github.answers['acme/app'];
    await mock.close();
  }
});

// `rotate --grace-minutes abc` sent null, which the server read as 0 minutes:
// every teammate's key stopped at once. `secure --retention-days abc` sent
// null too, which is the server's default.
test('rotate and secure refuse a number they cannot read, and send nothing', async () => {
  const repo = makeRepo();
  const mock = await startMockServer();
  const sent = () => mock.requests.filter((r) => r.path === '/rooms/rotate' || r.path === '/rooms/settings').map((r) => [r.path, r.body]);
  try {
    await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: repo });
    const refusals = [
      [['rotate', '--grace-minutes', 'abc'], /--grace-minutes takes a number of minutes, such as 60 \(0 ends the old key now\), not "abc"/],
      [['rotate', '--grace-minutes=-5'], /--grace-minutes takes a number of minutes/],
      [['rotate', '--grace-minutes', '1h'], /--grace-minutes takes a number of minutes/],
      [['secure', '--retention-days', 'abc'], /--retention-days takes a number of days from 1 to 365, or default for the server's, not "abc"/],
      [['secure', 'any', '--retention-days', '0'], /--retention-days takes a number of days from 1 to 365/],
      [['secure', '--retention-days', '366'], /--retention-days takes a number of days from 1 to 365/],
      [['secure', '--retention-days', '7d'], /--retention-days takes a number of days from 1 to 365/],
    ];
    for (const [args, message] of refusals) {
      const refused = await run(args, { cwd: repo });
      assert.equal(refused.code, 1, `${args.join(' ')} exits 1`);
      assert.match(refused.stderr, message, args.join(' '));
    }
    assert.deepEqual(sent(), [], 'nothing was rotated or changed');

    // and the numbers they take go out as numbers, `default` as the server's
    assert.equal((await run(['rotate', '--grace-minutes', '0'], { cwd: repo })).code, 0);
    assert.equal((await run(['secure', '--retention-days', '30'], { cwd: repo })).code, 0);
    assert.equal((await run(['secure', '--retention-days', 'default'], { cwd: repo })).code, 0);
    assert.deepEqual(sent(), [
      ['/rooms/rotate', { grace_minutes: 0 }],
      ['/rooms/settings', { retention_days: 30 }],
      ['/rooms/settings', { retention_days: null }],
    ]);
  } finally {
    await mock.close();
  }
});

// a second machine enrolling a name the first holds is told to revoke that
// token first, and nothing in the CLI called the route that does it
test('revoke --developer stops that name’s tokens, and leaves the room key’s grace alone', async () => {
  const repo = makeRepo();
  const mock = await startMockServer();
  try {
    await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: repo });
    const done = await run(['revoke', '--developer', 'alice@example.com'], { cwd: repo });
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /Revoked\. 1 token\(s\) of alice@example\.com stopped working just now/);
    assert.match(done.stdout, /npx agentmash login --room/);
    const nobody = await run(['revoke', '--developer', 'carol'], { cwd: repo });
    assert.equal(nobody.code, 0, nobody.stderr);
    assert.match(nobody.stdout, /carol held no live token in this room — npx agentmash secure lists the ones it has issued/);
    assert.deepEqual(
      mock.requests.filter((r) => r.path.startsWith('/rooms/') && r.path.endsWith('revoke')).map((r) => [r.path, r.body]),
      [
        ['/rooms/tokens/revoke', { developer: 'alice@example.com' }],
        ['/rooms/tokens/revoke', { developer: 'carol' }],
      ],
      'no old room key was cut off'
    );
    const help = await run(['--help']);
    assert.match(help.stdout, /--developer <name>: stop that name's tokens instead/);
  } finally {
    await mock.close();
  }
});

// After a rotation, a clone that has not pulled holds a key the server no
// longer opens a room to. Each room command printed the server's "send
// x-agentmash-room", which it had sent, status the server's JSON, and the
// ones that read /rooms/self called the server too old. They say what doctor
// says now: pull the repo for the new one.
test('a room key rotated or revoked away from says, in every room command, to pull the repo for the new one', async () => {
  const repo = makeRepo();
  const mock = await startMockServer();
  const file = path.join(repo, '.claude', 'agentmash', 'config.json');
  try {
    await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: repo });
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...config, room: ROTATED_AWAY }, null, 2));
    const commands = [
      ['status'],
      ['reconcile'],
      ['reconcile', 'off'],
      ['diffs'],
      ['diffs', 'on'],
      ['secure'],
      ['secure', 'any'],
      ['audit'],
      ['rotate'],
      ['revoke'],
      ['revoke', '--developer', 'alice@example.com'],
      ['disconnect'],
      ['purge', 'prompts', '--yes'],
      ['delete', '--yes'],
      ['login', '--room'],
    ];
    for (const args of commands) {
      const res = await run(args, { cwd: repo });
      const said = res.stdout + res.stderr;
      assert.equal(res.code, 1, `${args.join(' ')}: ${said}`);
      assert.match(res.stderr, /this room key has been rotated or revoked — pull the repo for the new one/, `${args.join(' ')}: ${said}`);
      assert.doesNotMatch(said, /x-agentmash-room|too old|\{"/, args.join(' '));
    }
    const doctor = await run(['doctor'], { cwd: repo });
    assert.match(doctor.stdout, /✗ this room key has been rotated or revoked — pull the repo for the new one/);

    // a key this server never had is not one a pull brings back
    fs.writeFileSync(file, JSON.stringify({ ...config, room: UNKNOWN_KEY }, null, 2));
    for (const args of [['status'], ['reconcile', 'off']]) {
      const res = await run(args, { cwd: repo });
      assert.equal(res.code, 1, args.join(' '));
      assert.match(res.stderr, /this room does not exist on this server — it may have been reset/, `${args.join(' ')}: ${res.stderr}`);
    }
  } finally {
    await mock.close();
  }
});

test('rotate against a server that has never heard of it says so plainly', async () => {
  const repo = makeRepo();
  const mock = await startMockServer({ supportsRotation: false });
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    const res = await run(['rotate'], { cwd: repo });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /too old to rotate room keys/);
    const config = JSON.parse(fs.readFileSync(path.join(repo, '.claude/agentmash/config.json'), 'utf8'));
    assert.equal(config.room, ROOM, 'a failed rotation must not disturb the repo');
  } finally {
    await mock.close();
  }
});

test('login stores the developer token outside the repo', async () => {
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-home-'));
  const mock = await startMockServer();
  try {
    await run(['init', '--server', mock.url], { cwd: repo, env: { AGENTMASH_HOME: home } });
    const res = await run(['login', '--room'], { cwd: repo, env: { AGENTMASH_HOME: home, AGENTMASH_DEV: 'bob' } });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /Enrolled/);

    const file = path.join(home, '.agentmash', 'credentials.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.tokens[`${mock.url}|rm_abc123`].token, 'amt_clitokenclitokenclitoken');
    // POSIX modes only: Windows exposes just a read-only bit, so a 0600 request
    // comes back as 0666 there. The credential still lives outside the repo,
    // which is what this test is really about.
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'a personal credential must not be world readable');
    }

    const committed = fs.readFileSync(path.join(repo, '.claude/agentmash/config.json'), 'utf8');
    assert.ok(!committed.includes('amt_'), 'no token may ever land in the repo');
  } finally {
    await mock.close();
  }
});

test('login --room shows the code to type in the browser, and a sign-in turned down there says why', async () => {
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-home-'));
  const signedIn = { status: 200, body: { token: 'amt_githubtokengithubtokengit', developer: 'bob', source: 'github' } };
  const denied = { status: 403, body: { code: 'denied', error: 'the code typed in the browser was not the one this terminal showed' } };
  const answers = [signedIn, denied];
  const mock = await startMockServer({ githubSignIn: answers });
  try {
    await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: repo, env: { AGENTMASH_HOME: home } });
    const ok = await run(['login', '--room'], { cwd: repo, env: { AGENTMASH_HOME: home, AGENTMASH_DEV: 'bob' } });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /type this code in your browser: WXYZ-2345/);
    assert.match(ok.stdout, /Signed in/);

    const turnedDown = await run(['login', '--room'], { cwd: repo, env: { AGENTMASH_HOME: home, AGENTMASH_DEV: 'bob' } });
    assert.equal(turnedDown.code, 1);
    assert.ok(turnedDown.stderr.includes(denied.body.error), turnedDown.stderr);
    assert.doesNotMatch(turnedDown.stderr, /sign-in failed|HTTP 403/);
  } finally {
    await mock.close();
  }
});

// A room that wants developer tokens takes one per machine, for that room,
// and `login --room` is what gets it. A bare `login` signs the machine in for
// the website's rooms instead, on the default server, and the reports go on
// being refused token_required.
test('a room that wants developer tokens says to get one with login --room, in secure and in doctor', async () => {
  const repo = makeRepo();
  const mock = await startMockServer();
  try {
    await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: repo });
    const secure = await run(['secure', 'any'], { cwd: repo });
    assert.equal(secure.code, 0, secure.stderr);
    assert.match(secure.stdout, /every teammate now needs to run: npx agentmash login --room\n/);

    const doctor = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
    assert.equal(doctor.code, 1, doctor.stdout);
    assert.match(doctor.stdout, /✗ this room requires a developer token \(token_mode any\) — run: agentmash login --room\n/);
  } finally {
    await mock.close();
  }
});

// A room made before init asked for a sign-in opens to its key alone, until
// its admin runs the one command that makes it need a sign-in beside it.
test('secure sign-in makes the key need a sign-in beside it, secure says where it does not, and key-only undoes it', async () => {
  const repo = makeRepo();
  const mock = await startMockServer();
  try {
    await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: repo });
    const view = await run(['secure'], { cwd: repo });
    assert.equal(view.code, 0, view.stderr);
    assert.match(view.stdout, /the room key alone opens this room: anyone who can read the repository holds it \(a read-only collaborator, a fork, a CI log\).*npx agentmash secure sign-in/s);

    const on = await run(['secure', 'sign-in'], { cwd: repo });
    assert.equal(on.code, 0, on.stderr);
    const asked = mock.requests.filter((r) => r.path === '/rooms/settings').at(-1);
    assert.deepEqual(asked.body, { sign_in_required: true });
    assert.match(on.stdout, /Updated\. the room key opens this room only beside the sign-in of someone who can push to its repository/);
    assert.match(on.stdout, /every teammate signs in once on their machine: npx agentmash login/);
    assert.doesNotMatch(on.stdout, /token_mode/, 'nothing about a setting it did not change');
    assert.doesNotMatch(on.stdout, /from before a room asked for a sign-in/, 'the hooks init just committed send it');

    // hooks committed before a room could ask send no sign-in, or say nothing of it: say to commit this version's
    const lib = path.join(repo, '.claude', 'agentmash', 'lib.mjs');
    const current = fs.readFileSync(lib, 'utf8');
    fs.writeFileSync(lib, 'export function readConfig() { return null; }\n');
    const old = await run(['secure', 'sign-in'], { cwd: repo });
    assert.equal(old.code, 0, old.stderr);
    assert.match(old.stdout, /the hooks committed in \.claude\/agentmash are from before a room asked for a sign-in: older than cli 0\.9 they send none, so every report is turned away even signed in, and later ones say nothing of why — run: npx agentmash init, then commit \.claude/);
    fs.writeFileSync(lib, current);

    const after = await run(['secure'], { cwd: repo });
    assert.match(after.stdout, /✓ the room key opens this room only beside the sign-in/);
    assert.doesNotMatch(after.stdout, /the room key alone opens this room/);
    const doctor = await run(['doctor'], { cwd: repo, env: { AGENTMASH_DEV: 'bob' } });
    assert.match(doctor.stdout, /✓ the room key opens this room only beside the sign-in of someone who can push to its repository/);

    // disconnected, a room that asks for a sign-in opens to nothing until it is connected again
    const disconnected = await run(['disconnect'], { cwd: repo });
    assert.equal(disconnected.code, 0, disconnected.stderr);
    assert.match(disconnected.stdout, /acme\/app no longer opens this room, and its key opens it only beside a sign-in .*: nothing opens it until it is connected again/);
    assert.match(disconnected.stdout, /to connect it again, from a checkout of it: npx agentmash connect/);
    // which the server lets only one of its owners do, not whoever holds a copy of the key
    assert.match(disconnected.stdout, /which only one of its owners, who connected it before, can run: a copy of its key connects nothing/);

    const off = await run(['secure', 'key-only'], { cwd: repo });
    assert.equal(off.code, 0, off.stderr);
    assert.deepEqual(mock.requests.filter((r) => r.path === '/rooms/settings').at(-1).body, { sign_in_required: false });
    assert.match(off.stdout, /Updated\. the room key alone opens this room again, to anyone who holds it/);
  } finally {
    await mock.close();
  }
});

test('secure sign-in against a server from before it says the server is too old, not that it worked', async () => {
  const repo = makeRepo();
  const mock = await startMockServer({ supportsSignIn: false });
  try {
    await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: repo });
    const res = await run(['secure', 'sign-in'], { cwd: repo });
    assert.equal(res.code, 1, res.stdout);
    assert.match(res.stderr, /this server is too old to ask for a sign-in beside a room's key/);
    assert.doesNotMatch(res.stdout, /Updated/);
    // and its view says nothing either way of what it cannot tell
    const view = await run(['secure'], { cwd: repo });
    assert.doesNotMatch(view.stdout, /opens this room/);
  } finally {
    await mock.close();
  }
});

test('a sign-in the team’s plan has no seat for says so in the server’s words, and where to upgrade', async () => {
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-home-'));
  const message =
    'acme is on the free plan, which covers 2 developers this month, and 2 have reported already. ' +
    'upgrade to the team plan to add bob: https://agentmash.dev/pricing';
  const signedIn = { status: 200, body: { token: 'amt_githubtokengithubtokengit', developer: 'ann', source: 'github' } };
  const noSeat = { status: 402, body: { error: 'seat_limit', code: 'seat_limit', message, upgrade_url: 'https://agentmash.dev/pricing' } };
  const mock = await startMockServer({ githubSignIn: [signedIn, noSeat] });
  try {
    await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: repo, env: { AGENTMASH_HOME: home } });
    // a teammate with a seat first, as in the test above: a fresh checkout's
    // first sign-in dying on Windows can trip a libuv assertion on exit
    const ann = await run(['login', '--room'], { cwd: repo, env: { AGENTMASH_HOME: home, AGENTMASH_DEV: 'ann' } });
    assert.equal(ann.code, 0, ann.stderr);
    const refused = await run(['login', '--room'], { cwd: repo, env: { AGENTMASH_HOME: home, AGENTMASH_DEV: 'bob' } });
    assert.equal(refused.code, 1);
    assert.ok(refused.stderr.includes(message), refused.stderr);
    assert.doesNotMatch(refused.stderr, /sign-in failed|HTTP 402|seat_limit/);
  } finally {
    await mock.close();
  }
});

test('doctor says a report turned away for want of a seat is the plan’s doing, with where to upgrade', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-cli-home-'));
  const env = { AGENTMASH_HOME: home, AGENTMASH_DEV: 'bob' };
  try {
    await run(['init', '--server', mock.url], { cwd: repo, env });
    // the address the server's 402 gave, which the hooks log beside it
    const upgrade = 'https://pay.example.com/agentmash';
    seedReportLog(home, [failed(repo, mock.url, 5, { outcome: 'refused', status: 402, code: 'seat_limit', upgrade_url: upgrade })]);
    const result = await run(['doctor'], { cwd: repo, env });
    assert.match(result.stdout, /1× refused \(402 seat_limit\)[^\n]*no seat left for this developer/);
    assert.ok(result.stdout.includes(upgrade), result.stdout);
    assert.ok(!result.stdout.includes(`${mock.url}/pricing`), 'never an address of its own making');
    // every report is turned away, and only the reports: the room, the key and
    // the server all check out, so this is the one line that says the edits
    // are not being shared, and the verdict goes by it
    assert.match(result.stdout, /✗ reports from this machine are being turned away: the team's plan has no seat left for this developer/);
    assert.doesNotMatch(result.stdout, /All good/);
    assert.equal(result.code, 1, result.stdout);

    // one from days ago is what happened, and may be fixed by now: a warning only
    seedReportLog(home, [failed(repo, mock.url, 2 * 24 * 60, { outcome: 'refused', status: 402, code: 'seat_limit', upgrade_url: upgrade })]);
    const later = await run(['doctor'], { cwd: repo, env });
    assert.match(later.stdout, /1× refused \(402 seat_limit\)/);
    assert.match(later.stdout, /All good/);
    assert.equal(later.code, 0, later.stdout);
  } finally {
    await mock.close();
  }
});

test('delete and purge refuse to run without --yes', async () => {
  const repo = makeRepo();
  const mock = await startMockServer();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    const del = await run(['delete'], { cwd: repo });
    assert.equal(del.code, 1);
    assert.match(del.stderr, /--yes/);
    const purge = await run(['purge', 'prompts'], { cwd: repo });
    assert.equal(purge.code, 1);
    assert.match(purge.stderr, /--yes/);
  } finally {
    await mock.close();
  }
});

// `delete events --yes`, meant as a purge, deleted the whole room: delete
// took no word and dropped the one it was given. Every command that takes
// fewer words than it is given refuses them, before it asks the server or
// touches the repository.
test('a destructive command refuses a word it does not take, and does nothing: delete events --yes deletes no room', async () => {
  const repo = makeRepo();
  const mock = await startMockServer();
  try {
    await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: repo });
    const asked = mock.requests.length;
    const refusals = [
      [['delete', 'events', '--yes'], /unexpected "events" after delete, which takes no words: nothing was done/],
      [['revoke', 'now'], /unexpected "now" after revoke, which takes no words/],
      [['disconnect', 'acme/app'], /unexpected "acme\/app" after disconnect, which takes no words/],
      [['rotate', '60'], /unexpected "60" after rotate, which takes no words/],
      [['uninstall', 'hooks'], /unexpected "hooks" after uninstall, which takes no words/],
      [['purge', 'events', 'prompts', '--yes'], /unexpected "prompts" after purge events, which takes one word/],
    ];
    for (const [args, message] of refusals) {
      const refused = await run(args, { cwd: repo });
      assert.equal(refused.code, 1, `${args.join(' ')} exits 1`);
      assert.match(refused.stderr, message, args.join(' '));
    }
    assert.deepEqual(mock.requests.slice(asked).map((r) => `${r.method} ${r.path}`), [], 'nothing was sent to the room');
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.claude/agentmash/config.json'), 'utf8')).room, ROOM, 'the key is the same one');
    assert.ok(fs.existsSync(path.join(repo, '.claude', 'settings.json')), 'uninstall took nothing out');
  } finally {
    await mock.close();
  }
});

// `init --sever <url>` made the room on the default server: any --word was
// read as a flag with a value, and one no command knows was then ignored.
test('an option no command knows is refused, with the one it was likely meant as: init --sever makes no room anywhere', async () => {
  const repo = makeRepo();
  const typed = await startMockServer();
  // the default server, for this test: a room made there is the bug
  const fallback = await startMockServer();
  try {
    const refusals = [
      [['init', '--sever', typed.url], /unknown option --sever \(did you mean --server\?\)/],
      [['init', `--sever=${typed.url}`], /unknown option --sever \(did you mean --server\?\)/],
      [['init', '--server', typed.url, '--no-opne'], /unknown option --no-opne \(did you mean --no-open\?\)/],
      [['rotate', '--grace', '5'], /unknown option --grace \(did you mean --grace-minutes\?\)/],
      [['delete', '--yse'], /unknown option --yse \(did you mean --yes\?\)/],
      [['status', '--frobnicate', 'x'], /unknown option --frobnicate\n/],
      [['init', '--server'], /--server needs a value/],
      [['init', '--server', typed.url, '--label', '--no-open'], /--label needs a value/],
    ];
    for (const [args, message] of refusals) {
      const refused = await run(args, { cwd: repo, env: { AGENTMASH_SERVER: fallback.url } });
      assert.equal(refused.code, 1, `${args.join(' ')} exits 1`);
      assert.match(refused.stderr, message, args.join(' '));
    }
    assert.deepEqual([...typed.requests, ...fallback.requests].map((r) => `${r.method} ${r.path}`), [], 'no server was asked for anything');
    assert.ok(!fs.existsSync(path.join(repo, '.claude')), 'and nothing was written');
  } finally {
    await typed.close();
    await fallback.close();
  }
});

test('purge refuses a scope it was not given, and --yes never confirms one it guessed', async () => {
  const repo = makeRepo();
  const mock = await startMockServer();
  const purges = () => mock.requests.filter((r) => r.path === '/rooms/purge').map((r) => r.body);
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    for (const args of [['purge', 'event', '--yes'], ['purge', 'everything', '--yes'], ['purge', '--yes']]) {
      const refused = await run(args, { cwd: repo });
      assert.equal(refused.code, 1, `${args.join(' ')} exits 1`);
      assert.match(refused.stderr, /usage: agentmash purge <prompts\|events>/, `${args.join(' ')} shows the usage`);
      assert.deepEqual(purges(), [], `${args.join(' ')} sent ${JSON.stringify(purges())}`);
    }
    // the two real scopes still go through, each as itself
    await run(['purge', 'prompts', '--yes'], { cwd: repo });
    await run(['purge', 'events', '--yes'], { cwd: repo });
    assert.deepEqual(purges(), [{ scope: 'prompts' }, { scope: 'events' }]);
  } finally {
    await mock.close();
  }
});

test('a bare npx agentmash in a repo that is not connected says what to do, in two lines', async () => {
  const repo = makeRepo();
  const result = await run([], { cwd: repo });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /not connected yet/);
  assert.match(result.stdout, /npx agentmash init/);
  assert.match(result.stdout, /https:\/\/agentmash\.dev\/how/, 'and where to see it first');
  assert.doesNotMatch(result.stdout, /rotate/, 'the manual is behind --help');
  assert.equal(result.stdout.trim().split('\n').length, 2);

  const help = await run(['--help'], { cwd: repo });
  assert.match(help.stdout, /npx agentmash rotate/, 'and --help is still the manual');
});

test('a bare npx agentmash in a connected repo points at the dashboard', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url], { cwd: repo });
    const result = await run([], { cwd: repo });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /This repo is connected/);
    assert.match(result.stdout, new RegExp(`${mock.url}/r/${ROOM}`));
  } finally {
    await mock.close();
  }
});

// A key in a link is a key in browser history, a screen share and every
// proxy's log. Where the server signs people in, every dashboard link the CLI
// prints or opens for a room connected to a repository names the room by its
// ref, which a browser signed in as one of its pushers opens. A room
// connected to nothing opens by its ref for nobody (and one that asks for a
// sign-in, not even once its key is pasted on /rooms), so it keeps its key
// link, as a server that signs nobody in does (the test above).
test('on a server that signs people in, a connected room is linked by its ref, never its key, and one connected to nothing by its key', async () => {
  const mock = await startMockServer({ signsIn: true, repo: 'acme/app' });
  const repo = makeRepo();
  const joined = makeRepo();
  for (const dir of [repo, joined]) execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: dir });
  try {
    // init --key-only connects nothing, so the room it just made is linked by its key
    const init = await run(['init', '--key-only', '--server', mock.url, '--no-git-hook'], { cwd: repo });
    assert.equal(init.code, 0, init.stderr);
    assert.ok(init.stdout.includes(`${mock.url}/r/${ROOM}`), init.stdout);
    assert.ok(!init.stdout.includes('/r/rm_abc123'), init.stdout);

    // connected (the server says so), every link names it by its ref
    const bare = await run([], { cwd: repo });
    const again = await run(['init', '--server', mock.url, '--no-git-hook'], { cwd: repo });
    const status = await run(['status'], { cwd: repo, env: { AGENTMASH_DEV: 'carol' } });
    const join = await run(['join', ROOM, '--server', mock.url, '--no-git-hook'], { cwd: joined });
    for (const [what, said] of [['bare', bare], ['init again', again], ['status', status], ['join', join]]) {
      assert.equal(said.code, 0, `${what}: ${said.stderr}`);
      assert.ok(said.stdout.includes(`${mock.url}/r/rm_abc123`), `${what}: ${said.stdout}`);
      assert.ok(!said.stdout.includes(`/r/${ROOM}`), `${what}: no key in a link`);
    }
  } finally {
    await mock.close();
  }

  // connected to nothing: a ref link would open for nobody, so the key link it always had
  const loose = await startMockServer({ signsIn: true });
  const unconnected = makeRepo();
  try {
    assert.equal((await run(['init', '--server', loose.url, '--no-git-hook'], { cwd: unconnected })).code, 0);
    const bare = await run([], { cwd: unconnected });
    const again = await run(['init', '--server', loose.url, '--no-git-hook'], { cwd: unconnected });
    const status = await run(['status'], { cwd: unconnected, env: { AGENTMASH_DEV: 'carol' } });
    const join = await run(['join', ROOM, '--server', loose.url, '--no-git-hook'], { cwd: makeRepo() });
    for (const [what, said] of [['bare', bare], ['init again', again], ['status', status], ['join', join]]) {
      assert.equal(said.code, 0, `${what}: ${said.stderr}`);
      assert.ok(said.stdout.includes(`${loose.url}/r/${ROOM}`), `${what}: ${said.stdout}`);
      assert.ok(!said.stdout.includes('/r/rm_abc123'), `${what}: no ref link that opens for nobody`);
    }
  } finally {
    await loose.close();
  }
});

// Ended with process.exit() right after a request, a command crashed Node on
// Windows while the request's socket was still closing ("Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c"), after the
// error it meant to print, and the exit code went with it. The crash cannot
// be called up on purpose, so this holds the CLI to never calling exit at
// all: a failed command sets exitCode, and the process ends when nothing is
// left open.
test('a failed command sets the exit code and never calls process.exit', async () => {
  for (const file of ['agentmash.mjs', 'token.mjs', 'hook.mjs', 'inbox.mjs']) {
    const source = fs.readFileSync(path.join(CLI_DIR, file), 'utf8');
    // the MCP entry's bootstrap is a program of its own, in a string, and runs in Claude Code
    const calls = source.split('\n').filter((line) => /process\.exit\(/.test(line) && !/^\s*(\/\/|\*)/.test(line) && !/^\s*"/.test(line));
    assert.deepEqual(calls, [], `${file} calls process.exit`);
  }
  const unknown = await run(['no-such-command']);
  assert.equal(unknown.code, 1);
  const twice = await run(['status', '--repo', 'a', '--repo', 'b']);
  assert.equal(twice.code, 1);
  assert.match(twice.stderr, /--repo is given twice/);
});

// A machine signed in with login steps aside for the hooks a repository
// commits, whatever their age: both would report everything twice. Committed
// before prompts had ids, those hooks send every edit without its prompt's
// id. The server keeps the prompt on their edits after a turn the harness
// sent, but only init brings the ids back.
test('status and doctor say when the committed hooks are older than prompt ids, and that init brings them up to date', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    await run(['init', '--server', mock.url, '--no-open'], { cwd: repo });
    assert.doesNotMatch((await run(['status'], { cwd: repo })).stdout, /older agentmash/, 'hooks of this version');

    fs.writeFileSync(path.join(repo, '.claude', 'agentmash', 'lib.mjs'), 'export function writeSessionCache() {}\n');
    const said =
      /the hooks committed in \.claude\/agentmash are from an older agentmash, and send edits without the id of the prompt they came from — run: npx agentmash init, then commit \.claude/;
    assert.match((await run(['status'], { cwd: repo })).stdout, said);
    assert.match((await run(['doctor'], { cwd: repo })).stdout, said);
  } finally {
    await mock.close();
  }
});
