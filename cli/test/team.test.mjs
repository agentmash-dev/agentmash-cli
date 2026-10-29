// `agentmash crew`: teams from the agentmash crew, installed through the crew's
// own installer, vendored at crew/. Three promises are tested here. A team is
// the same bytes whichever installer wrote it. Nothing is written until the
// whole plan is known to be good. And none of it needs the coordination
// server: no room, no request, not even a socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMockServer } from './mock-server.mjs';

// Importing this runs the pack-time sync, which is what puts cli/crew/ there.
import { verifyCrewCopy } from '../sync-hooks.mjs';

const CLI_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(CLI_DIR, 'agentmash.mjs');
const REPO_ROOT = path.dirname(CLI_DIR);
const CREW = path.join(REPO_ROOT, 'crew');
const REAL_MCP_ENTRY = path.join(REPO_ROOT, 'mcp', 'server.mjs');
const NO_NETWORK = pathToFileURL(path.join(CLI_DIR, 'test', 'fixtures', 'no-network.mjs')).href;

// The crew's installer, exactly as `npx github:agentmash-dev/agentmash-crew` runs it.
const { loadBundle, runTeamOp } = await import(pathToFileURL(path.join(CREW, 'install.mjs')).href);
const BUNDLE = loadBundle(path.join(CREW, 'bundle.json'));

const TEAM = 'Команда 123';
const SLUG = 'komanda-123';
const MANIFEST = '.claude/agentmash-crew/teams.json';
const SETTINGS = '.claude/settings.json';
const MARKER = BUNDLE.meta.hook.marker;

// Git reads the global config of whoever runs the tests, and a global
// core.hooksPath (a ~/.githooks every repository shares) is where init would
// put the post-commit client and uninstall would take it from. An empty global
// config keeps every git call inside the temporary repositories.
const EMPTY_GITCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-team-git-')), 'gitconfig');
fs.writeFileSync(EMPTY_GITCONFIG, '');

const baseEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTMASH_') && k !== 'CLAUDE_PROJECT_DIR')
  ),
  GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
};

function run(args, { cwd, env = {}, offline = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(offline ? ['--import', NO_NETWORK] : []), CLI, ...args], {
      cwd,
      env: { ...baseEnv, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code,
        stdout: stdout.replace(/\u001b\[[0-9;]*m/g, ''),
        stderr: stderr.replace(/\u001b\[[0-9;]*m/g, ''),
      })
    );
  });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-team-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: baseEnv, stdio: 'ignore' });
  return fs.realpathSync(dir);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (repo, rel) => fs.readFileSync(path.join(repo, ...rel.split('/')), 'utf8');
const exists = (repo, rel) => fs.existsSync(path.join(repo, ...rel.split('/')));
const write = (repo, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, ...rel.split('/'))), { recursive: true });
  fs.writeFileSync(path.join(repo, ...rel.split('/')), text);
};
const agentFile = (name) => `.claude/agents/${name}.md`;
const bundleAgent = (name) => BUNDLE.agents.find((agent) => agent.name === name).content;

/** Every file in the repo but .git, as path -> sha256 (plus mtime, to prove a file was not rewritten). */
function snapshot(repo, { mtimes = false } = {}) {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dir === repo && entry.name === '.git') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      const rel = path.relative(repo, abs).split(path.sep).join('/');
      files[rel] = sha256(fs.readFileSync(abs)) + (mtimes ? ` ${fs.statSync(abs).mtimeMs}` : '');
    }
  };
  walk(repo);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
}

test('team add installs the agents, the skills, the guard hook and teams.json', async () => {
  const repo = makeRepo();
  const result = await run(['crew', 'add', TEAM, '--agents', 'pipe,flex,probe'], { cwd: repo });
  assert.equal(result.code, 0, result.stderr);

  for (const name of ['mash-coordinator', 'pipe-backend', 'flex-frontend', 'probe-qa']) {
    assert.equal(read(repo, agentFile(name)), bundleAgent(name), `${name} should be the bundle's bytes`);
  }
  assert.ok(!exists(repo, agentFile('gavel-reviewer')), 'only the agents asked for, and Mash');
  assert.ok(exists(repo, `.claude/skills/team-${SLUG}/SKILL.md`));
  assert.ok(exists(repo, '.claude/agentmash-crew/crew-guard.mjs'));
  assert.ok(!exists(repo, '.claude/agentmash'), 'a team is not an AgentMash install');

  const manifest = JSON.parse(read(repo, MANIFEST));
  assert.deepEqual(manifest.teams, [
    { slug: SLUG, name: TEAM, members: ['mash-coordinator', 'flex-frontend', 'pipe-backend', 'probe-qa'] },
  ]);
  const settings = JSON.parse(read(repo, SETTINGS));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Bash');
  assert.match(JSON.stringify(settings.hooks.PreToolUse[0]), new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));

  assert.match(result.stdout, /team Команда 123 \(komanda-123\): mash-coordinator, flex-frontend, pipe-backend, probe-qa/);
  assert.match(result.stdout, /✓ created\s+\.claude\/agents\/pipe-backend\.md/);
  assert.match(result.stdout, /git add -- \.claude\/agentmash-crew\/crew-guard\.mjs .*\.claude\/settings\.json/);
  assert.match(result.stdout, /git commit -m "chore: add agentmash team Команда 123"/);
  // a command to a step, never joined by &&, which Windows PowerShell 5.1 does not have
  assert.match(result.stdout, /\n {4}1\. git add -- [^\n&]*\n {4}2\. git commit -m "chore: add agentmash team Команда 123"\n {4}3\. start a new Claude Code session/);
  assert.doesNotMatch(result.stdout, /&&/);
  assert.match(result.stdout, /start a new Claude Code session at the repository root/);
  assert.match(result.stdout, /then say: Команда 123, <your task>\s+\(or type: \/team-komanda-123 <your task>\)/);
});

test('every team operation writes the bytes the crew installer writes, file for file', async () => {
  // The same operations through `npx agentmash team` and through the crew's own
  // installer, compared after each one: create, a second team, extend, remove a
  // member, update, remove a team.
  const viaCli = makeRepo();
  const viaCrew = makeRepo();
  const steps = [
    [['add', TEAM, '--agents', 'pipe,flex,probe'], { type: 'add', name: TEAM, members: ['pipe', 'flex', 'probe'] }],
    [['add', 'Релиз', '--agents', 'bump,rail,quill,gavel'], { type: 'add', name: 'Релиз', members: ['bump', 'rail', 'quill', 'gavel'] }],
    [['add', TEAM, '--agents', 'gavel-reviewer'], { type: 'add', name: TEAM, members: ['gavel-reviewer'] }],
    [['remove', TEAM, '--agents', 'probe'], { type: 'remove', team: TEAM, members: ['probe'] }],
    [['update'], { type: 'update' }],
    [['remove', 'Релиз'], { type: 'remove', team: 'Релиз' }],
  ];
  for (const [args, op] of steps) {
    const result = await run(['crew', ...args], { cwd: viaCli });
    assert.equal(result.code, 0, `crew ${args.join(' ')}: ${result.stderr}`);
    runTeamOp({ repo: viaCrew, bundle: BUNDLE, op });
    assert.deepEqual(snapshot(viaCli), snapshot(viaCrew), `after team ${args.join(' ')}`);
  }
  assert.ok(Object.keys(snapshot(viaCli)).length > 5, 'the comparison has to cover real files');
});

test('running the same team add again changes nothing and rewrites nothing', async () => {
  const repo = makeRepo();
  assert.equal((await run(['crew', 'add', TEAM, '--agents', 'pipe,flex'], { cwd: repo })).code, 0);
  const before = snapshot(repo, { mtimes: true });

  const again = await run(['crew', 'add', TEAM, '--agents', 'pipe,flex'], { cwd: repo });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /nothing to change/);
  // 3 shared files, Mash, pipe, flex and the team skill
  assert.match(again.stdout, /7 files unchanged/);
  assert.doesNotMatch(again.stdout, /next:/, 'nothing to commit, so no commit step');
  assert.deepEqual(snapshot(repo, { mtimes: true }), before);
});

test('team add on a team that exists adds the new agents to it', async () => {
  const repo = makeRepo();
  assert.equal((await run(['crew', 'add', TEAM, '--agents', 'pipe'], { cwd: repo })).code, 0);
  const result = await run(['crew', 'add', TEAM, '--agents', 'gavel'], { cwd: repo });
  assert.equal(result.code, 0, result.stderr);

  const { teams } = JSON.parse(read(repo, MANIFEST));
  assert.equal(teams.length, 1, 'the same team, not a second one');
  assert.deepEqual(teams[0].members, ['mash-coordinator', 'pipe-backend', 'gavel-reviewer']);
  assert.match(result.stdout, /✓ created\s+\.claude\/agents\/gavel-reviewer\.md/);
  assert.match(result.stdout, /✓ updated\s+\.claude\/skills\/team-komanda-123\/SKILL\.md/);
  assert.match(result.stdout, /git commit -m "chore: update agentmash team Команда 123"/);
});

test('team remove --agents deletes an agent file only when no other team still needs it', async () => {
  const repo = makeRepo();
  assert.equal((await run(['crew', 'add', TEAM, '--agents', 'pipe,flex,probe'], { cwd: repo })).code, 0);
  assert.equal((await run(['crew', 'add', 'Bugfix', '--agents', 'snag,probe'], { cwd: repo })).code, 0);

  const shared = await run(['crew', 'remove', TEAM, '--agents', 'probe'], { cwd: repo });
  assert.equal(shared.code, 0, shared.stderr);
  assert.ok(exists(repo, agentFile('probe-qa')), 'Bugfix still has probe');
  const teams = Object.fromEntries(JSON.parse(read(repo, MANIFEST)).teams.map((t) => [t.name, t.members]));
  assert.deepEqual(teams[TEAM], ['mash-coordinator', 'flex-frontend', 'pipe-backend']);

  const last = await run(['crew', 'remove', 'bugfix', '--agents', 'probe-qa'], { cwd: repo });
  assert.equal(last.code, 0, last.stderr);
  assert.ok(!exists(repo, agentFile('probe-qa')), 'no team has probe any more');
  assert.match(last.stdout, /✓ deleted\s+\.claude\/agents\/probe-qa\.md/);
  assert.match(last.stdout, /git rm -q --cached --ignore-unmatch -- \.claude\/agents\/probe-qa\.md/);
  assert.match(last.stdout, /restart Claude Code in this repo so it reloads the agents/);
});

test('team remove takes the whole team out and leaves the repo as it found it', async () => {
  const repo = makeRepo();
  // Somebody's own settings and agent, which the team has to leave alone.
  write(repo, SETTINGS, JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] } }, null, 2) + '\n');
  write(repo, '.claude/agents/ours.md', '---\nname: ours\n---\n');
  const before = snapshot(repo);

  assert.equal((await run(['crew', 'add', TEAM, '--agents', 'pipe,flex'], { cwd: repo })).code, 0);
  assert.equal(JSON.parse(read(repo, SETTINGS)).permissions.allow[0], 'Bash(npm test:*)');

  const result = await run(['crew', 'remove', TEAM], { cwd: repo });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /removed team Команда 123 \(komanda-123\)/);
  assert.match(result.stdout, /git commit -m "chore: remove agentmash team Команда 123"/);
  assert.deepEqual(snapshot(repo), before);
});

test('team update puts back a missing file and keeps a local change unless --force', async () => {
  const repo = makeRepo();
  assert.equal((await run(['crew', 'add', TEAM, '--agents', 'pipe,flex'], { cwd: repo })).code, 0);
  fs.rmSync(path.join(repo, '.claude', 'agents', 'flex-frontend.md'));
  write(repo, agentFile('pipe-backend'), 'edited by hand\n');

  const update = await run(['crew', 'update'], { cwd: repo });
  assert.equal(update.code, 0, update.stderr);
  assert.match(update.stdout, new RegExp(`1 team, agentmash-crew ${BUNDLE.meta.version.replace(/\./g, '\\.')}`));
  assert.equal(read(repo, agentFile('flex-frontend')), bundleAgent('flex-frontend'));
  assert.equal(read(repo, agentFile('pipe-backend')), 'edited by hand\n');
  assert.match(update.stdout, /! kept\s+\.claude\/agents\/pipe-backend\.md/);

  const forced = await run(['crew', 'update', '--force'], { cwd: repo });
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(read(repo, agentFile('pipe-backend')), bundleAgent('pipe-backend'));
  assert.match(forced.stdout, /! overwritten\s+\.claude\/agents\/pipe-backend\.md/);
});

test('--dry-run writes nothing, for add and for remove', async () => {
  const repo = makeRepo();
  const add = await run(['crew', 'add', TEAM, '--agents', 'pipe,flex', '--dry-run'], { cwd: repo });
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /· created\s+\.claude\/agents\/pipe-backend\.md/, 'says what it would do, without a ✓');
  assert.match(add.stdout, /dry run: nothing was written/);
  assert.doesNotMatch(add.stdout, /next:/);
  assert.ok(!exists(repo, '.claude'), 'not even a directory');

  assert.equal((await run(['crew', 'add', TEAM, '--agents', 'pipe,flex'], { cwd: repo })).code, 0);
  const before = snapshot(repo, { mtimes: true });
  const remove = await run(['crew', 'remove', TEAM, '--dry-run'], { cwd: repo });
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /· deleted\s+\.claude\/agentmash-crew\/teams\.json/);
  assert.deepEqual(snapshot(repo, { mtimes: true }), before);
});

test('--dry-run before the team name does not swallow the name', async () => {
  const repo = makeRepo();
  const result = await run(['crew', 'add', '--dry-run', TEAM, '--agents', 'pipe'], { cwd: repo });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /team Команда 123 \(komanda-123\): mash-coordinator, pipe-backend/);
  assert.match(result.stdout, /dry run: nothing was written/);
  assert.ok(!exists(repo, '.claude'));
});

test('--agents=all is --agents all, and a flag given twice is refused, as the crew command does', async () => {
  const repo = makeRepo();
  const joined = await run(['crew', 'add', TEAM, '--agents=all', '--dry-run'], { cwd: repo });
  assert.equal(joined.code, 0, joined.stderr);
  const spaced = await run(['crew', 'add', TEAM, '--agents', 'all', '--dry-run'], { cwd: repo });
  assert.equal(joined.stdout, spaced.stdout);
  assert.match(joined.stdout, new RegExp(`created\\s+\\.claude/agents/${BUNDLE.agents.at(-1).name}\\.md`), 'every agent');

  const before = await run(['crew', 'add', '--slug=team-123', TEAM, '--agents', 'pipe', '--dry-run'], { cwd: repo });
  assert.equal(before.code, 0, before.stderr);
  assert.match(before.stdout, /team Команда 123 \(team-123\): mash-coordinator, pipe-backend/, 'the name is not taken for a value');

  const refusals = [
    [['crew', 'add', TEAM, '--agents', 'pipe', '--agents', 'flex'], /--agents is given twice/],
    [['crew', 'add', TEAM, '--agents=pipe', '--agents', 'flex'], /--agents is given twice/],
    [['crew', 'add', TEAM, '--agents', 'pipe', '--dry-run=false'], /--dry-run takes no value/],
    [['crew', 'add', TEAM, '--agents='], /--agents needs a value/],
  ];
  for (const [args, message] of refusals) {
    const result = await run(args, { cwd: repo });
    assert.equal(result.code, 1, `${args.join(' ')} should fail`);
    assert.match(result.stderr, message, args.join(' '));
  }
  assert.ok(!exists(repo, '.claude'), 'nothing written');
});

test('a file the crew did not write stops the whole add before anything is written', async () => {
  const repo = makeRepo();
  write(repo, agentFile('pipe-backend'), 'our own pipe agent\n');
  const before = snapshot(repo);

  const refused = await run(['crew', 'add', TEAM, '--agents', 'pipe,flex'], { cwd: repo });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /refusing to overwrite files that agentmash-crew did not write:\n\s+\.claude\/agents\/pipe-backend\.md/);
  assert.match(refused.stderr, /rerun with --force/);
  assert.deepEqual(snapshot(repo), before, 'no agent, no skill, no settings, no teams.json');

  const forced = await run(['crew', 'add', TEAM, '--agents', 'pipe,flex', '--force'], { cwd: repo });
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /! overwritten\s+\.claude\/agents\/pipe-backend\.md/);
  assert.equal(read(repo, agentFile('pipe-backend')), bundleAgent('pipe-backend'));
});

test('team needs no server: no request to it, no socket at all, and it works with the server gone', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  const env = { AGENTMASH_SERVER: mock.url, AGENTMASH_URL: mock.url };
  try {
    // A repo that is connected to a room, so there is a server to be tempted by.
    assert.equal((await run(['init', '--server', mock.url, '--no-git-hook', '--no-open'], { cwd: repo })).code, 0);
    // The preload works: the same init, offline, dies at its first request.
    const guarded = await run(['init', '--server', mock.url, '--no-git-hook', '--force'], { cwd: repo, offline: true });
    assert.equal(guarded.code, 97, 'the no-network preload must catch a real request');

    const requests = mock.requests.length;
    const add = await run(['crew', 'add', TEAM, '--agents', 'pipe'], { cwd: repo, env, offline: true });
    assert.equal(add.code, 0, add.stderr);
    assert.equal(mock.requests.length, requests, 'team must not call the coordination server');
  } finally {
    await mock.close();
  }
  const extend = await run(['crew', 'add', TEAM, '--agents', 'flex'], { cwd: repo, env, offline: true });
  assert.equal(extend.code, 0, extend.stderr);
  const list = await run(['crew', 'list'], { cwd: repo, env, offline: true });
  assert.match(list.stdout, /Команда 123 \(komanda-123\): mash, flex, pipe/);
});

test('init and uninstall leave crew teams alone, and uninstall says how to remove them', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  try {
    assert.equal((await run(['crew', 'add', TEAM, '--agents', 'pipe,flex'], { cwd: repo })).code, 0);
    // Everything the team wrote except settings.json, which init and uninstall share with it.
    const notOurs = (p) => p.startsWith('.claude/agentmash/') || p === SETTINGS || p === '.mcp.json';
    const crewFiles = () => Object.fromEntries(Object.entries(snapshot(repo)).filter(([p]) => !notOurs(p)));
    const installed = crewFiles();

    assert.equal((await run(['init', '--server', mock.url, '--no-git-hook', '--no-open'], { cwd: repo })).code, 0);
    let settings = JSON.parse(read(repo, SETTINGS));
    const pre = JSON.stringify(settings.hooks.PreToolUse);
    assert.ok(pre.includes(MARKER), 'init keeps the crew guard');
    assert.ok(pre.includes('.claude/agentmash/pre_tool_use.mjs'), 'and still adds its own advisory hook beside it');
    assert.deepEqual(crewFiles(), installed);

    const result = await run(['uninstall'], { cwd: repo });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /crew teams stay installed — remove them with npx agentmash crew remove <name>/);
    assert.ok(!exists(repo, '.claude/agentmash'));
    settings = JSON.parse(read(repo, SETTINGS));
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.ok(JSON.stringify(settings.hooks.PreToolUse).includes(MARKER), 'the guard outlives AgentMash');
    assert.deepEqual(crewFiles(), installed);
  } finally {
    await mock.close();
  }
});

test('doctor reports crew teams, and never fails because of them', async () => {
  const mock = await startMockServer();
  const repo = makeRepo();
  const env = { AGENTMASH_DEV: 'bob', AGENTMASH_MCP_ENTRY: REAL_MCP_ENTRY };
  try {
    assert.equal((await run(['init', '--server', mock.url, '--no-git-hook', '--no-open'], { cwd: repo })).code, 0);
    assert.equal((await run(['crew', 'add', TEAM, '--agents', 'pipe,flex'], { cwd: repo })).code, 0);

    const healthy = await run(['doctor'], { cwd: repo, env });
    assert.equal(healthy.code, 0, healthy.stdout + healthy.stderr);
    assert.match(healthy.stdout, new RegExp(`✓ crew teams: 1  Команда 123 · agentmash-crew ${BUNDLE.meta.version.replace(/\./g, '\\.')}`));
    assert.doesNotMatch(healthy.stdout, /crew file/);

    // Drift of every kind the section knows: a file edited, a file deleted, the guard unregistered.
    write(repo, agentFile('pipe-backend'), 'edited by hand\n');
    fs.rmSync(path.join(repo, '.claude', 'skills', 'run-crew', 'SKILL.md'));
    const settings = JSON.parse(read(repo, SETTINGS));
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((g) => !JSON.stringify(g).includes(MARKER));
    write(repo, SETTINGS, JSON.stringify(settings, null, 2) + '\n');

    const drifted = await run(['doctor'], { cwd: repo, env });
    assert.equal(drifted.code, 0, 'crew drift is not an AgentMash problem');
    assert.match(drifted.stdout, /All good/);
    assert.match(drifted.stdout, /! 1 crew file is missing: \.claude\/skills\/run-crew\/SKILL\.md/);
    assert.match(drifted.stdout, /! 1 crew file changed since install: \.claude\/agents\/pipe-backend\.md/);
    assert.match(drifted.stdout, /! the crew guard hook is not in \.claude\/settings\.json/);

    write(repo, MANIFEST, '{ not json');
    const broken = await run(['doctor'], { cwd: repo, env });
    assert.equal(broken.code, 0);
    assert.match(broken.stdout, /! crew teams: \.claude\/agentmash-crew\/teams\.json: not valid JSON/);
  } finally {
    await mock.close();
  }
});

test('team list shows the installed teams, and --json at the end is a flag, not a missing value', async () => {
  const repo = makeRepo();
  const empty = await run(['crew', 'list'], { cwd: repo });
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /no agentmash teams in /);

  assert.equal((await run(['crew', 'add', TEAM, '--agents', 'pipe,flex,probe'], { cwd: repo })).code, 0);
  const list = await run(['crew', 'list'], { cwd: repo });
  assert.match(list.stdout, /Команда 123 \(komanda-123\): mash, flex, pipe, probe/);

  const json = await run(['crew', 'list', '--json'], { cwd: repo });
  assert.equal(json.code, 0, json.stderr);
  const { teams } = JSON.parse(json.stdout);
  assert.deepEqual(teams.map((t) => [t.slug, t.name]), [[SLUG, TEAM]]);
});

// The crew's team skill, committed in every repository a team went into,
// tells an agent to run `npx agentmash team add`, and so did the site: the old
// name keeps working, says the new one on stderr, and writes the same files.
test('team, crew\'s old name, still works and says the new name, with stdout as it was', async () => {
  const viaTeam = makeRepo();
  const viaCrew = makeRepo();
  const added = await run(['team', 'add', TEAM, '--agents', 'pipe,flex'], { cwd: viaTeam });
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stderr, /npx agentmash team is npx agentmash crew now; team still works/);
  assert.equal((await run(['crew', 'add', TEAM, '--agents', 'pipe,flex'], { cwd: viaCrew })).code, 0);
  assert.deepEqual(snapshot(viaTeam), snapshot(viaCrew));

  const json = await run(['team', 'list', '--json'], { cwd: viaTeam });
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), JSON.parse((await run(['crew', 'list', '--json'], { cwd: viaCrew })).stdout));
  const crew = await run(['crew', 'list'], { cwd: viaCrew });
  assert.doesNotMatch(crew.stderr, /old name|team still works/, 'crew itself says nothing of it');

  const refused = await run(['team', 'add', TEAM, '--agents', 'pipe', '--dryrun'], { cwd: viaTeam });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--dryrun does not apply to crew add/, 'and refuses what crew refuses');
});

test('team refuses what it cannot do safely, and writes nothing while refusing', async () => {
  const repo = makeRepo();
  const refusals = [
    [['crew', 'add', TEAM, '--agents', 'pipe', '--dryrun'], /--dryrun does not apply to crew add/],
    [['crew', 'add', TEAM, '--agents', 'pipe', '--server', 'http://127.0.0.1:9'], /--server does not apply to crew add/],
    [['crew', 'list', '--dry-run'], /--dry-run does not apply to crew list/],
    [['crew', 'add', 'Команда', '123', '--agents', 'pipe'], /the team name must be one argument; quote it: npx agentmash crew add "Команда 123"/],
    [['crew', 'add', TEAM], /crew add needs --agents/],
    [['crew', 'add', TEAM, '--agents'], /--agents needs a value/],
    [['crew', 'add', TEAM, '--agents', 'nope'], /unknown agent "nope"; valid names: mash, tally/],
    [['crew', 'add', TEAM, '--agents', 'mash'], /a new team needs at least one agent besides mash-coordinator/],
    [['crew', 'add', 'say "hi"', '--agents', 'pipe'], /must not contain double quotes/],
    [['crew', 'remove', TEAM], /no agentmash teams are installed in this repository/],
    [['crew'], /usage: agentmash crew <add\|remove\|list\|update>/],
    [['crew', 'install'], /unknown crew command "install"/],
  ];
  for (const [args, message] of refusals) {
    const result = await run(args, { cwd: repo });
    assert.equal(result.code, 1, `${args.join(' ')} should fail`);
    assert.match(result.stderr, message, args.join(' '));
  }
  assert.ok(!exists(repo, '.claude'), 'no refusal may leave anything behind');

  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-team-norepo-')));
  const noRepo = await run(['crew', 'add', TEAM, '--agents', 'pipe'], { cwd: outside });
  assert.equal(noRepo.code, 1);
  assert.match(noRepo.stderr, /not inside a git repository/);

  const help = await run(['--help'], { cwd: repo });
  assert.match(help.stdout, /npx agentmash crew add <name> --agents <a,b\|all>/);
  assert.match(help.stdout, /--dry-run/);
});

test('the packed crew is checked against the lock, so a hand-edited crew cannot ship', () => {
  const files = ['bundle.json', 'install.mjs', 'team-plan.mjs', 'crew.lock.json', 'README.md'];
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-crew-copy-'));
  for (const file of files) fs.copyFileSync(path.join(CLI_DIR, 'crew', file), path.join(copy, file));
  verifyCrewCopy(copy, files);

  fs.appendFileSync(path.join(copy, 'install.mjs'), '\n// one more line\n');
  assert.throws(() => verifyCrewCopy(copy, files), /crew\/install\.mjs does not match crew\/crew\.lock\.json/);
});
