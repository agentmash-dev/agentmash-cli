// A file git ignores (.env, a scratch folder, a build's output) is never
// merged: nobody's copy of it can conflict with anybody else's. So an edit to
// one is no business of the room's, and a teammate's edit to one is nothing to
// warn about, the same as a Bash command's never was (git status leaves
// ignored files out of the look at the working tree). A file .gitignore names
// that is tracked anyway (git add -f) is merged like any other, and stays
// reported. Against a real throwaway repository and a room that records what
// it was asked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOLDER, KEY, baseEnv, runHook, session, startServer } from './fixtures.mjs';
import * as lib from '../lib.mjs';

// git reads the global config of whoever runs the tests (a global excludes
// file above all), so it gets an empty one
const EMPTY_GITCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-ignored-git-')), 'gitconfig');
fs.writeFileSync(EMPTY_GITCONFIG, '');
const gitEnv = { GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG, GIT_CONFIG_NOSYSTEM: '1' };
// lib.gitIgnored, called in this process, runs git with this process's environment
Object.assign(process.env, gitEnv);

function writeFile(dir, rel, content) {
  const target = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

/** A committed repository with a space in its path, .env, scratch/ and dist/ ignored, and dist/vendor.js tracked anyway. */
function repository() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'comp programming-ignored-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: { ...baseEnv, ...gitEnv }, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'bob@example.com');
  git('config', 'user.name', 'bob');
  git('config', 'core.autocrlf', 'false');
  writeFile(dir, 'src/models/user.ts', 'export interface User { id: string }\n');
  writeFile(dir, 'src/models/team.ts', 'export interface Team { id: string }\n');
  writeFile(dir, 'dist/vendor.js', 'export const v = 1;\n');
  writeFile(dir, '.gitignore', '.env\nscratch/\ndist/\n');
  git('add', '-A');
  git('add', '-f', 'dist/vendor.js');
  git('commit', '-q', '-m', 'init');
  return dir;
}

const IGNORED = ['.env', 'scratch/notes.ts'];
const TRACKED = ['src/models/user.ts', 'dist/vendor.js'];

/** alice at work a minute ago in every one of these files, as an older hook that reported ignored files left the room. */
const holders = [...IGNORED, ...TRACKED, 'src/models/team.ts'].map((file_path) => ({ ...HOLDER, file_path }));

function env(repo, port) {
  return {
    AGENTMASH_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-ignored-home-')),
    AGENTMASH_URL: `http://127.0.0.1:${port}`,
    AGENTMASH_ROOM: KEY,
    AGENTMASH_DEV: 'bob',
    CLAUDE_PROJECT_DIR: repo,
    ...gitEnv,
  };
}

const write = (repo, sessionId, event, rel) => ({
  session_id: sessionId,
  cwd: repo,
  hook_event_name: event,
  tool_name: 'Write',
  tool_input: { file_path: path.join(repo, ...rel.split('/')), content: 'export const API_URL = 1;\n' },
});

const reported = (room) => room.requests.filter((r) => r.path === '/events').map((r) => r.body.file_path);
const checked = (room) => room.requests.filter((r) => r.path === '/check').map((r) => r.query.file_path);

test('an edit to a file git ignores is not reported to the room; a tracked one is, force-added or not', async () => {
  const room = await startServer({ holders });
  const repo = repository();
  try {
    const sessionId = session();
    for (const rel of [...IGNORED, ...TRACKED]) {
      writeFile(repo, rel, 'export const API_URL = 1;\n');
      const post = await runHook('post_tool_use.mjs', write(repo, sessionId, 'PostToolUse', rel), env(repo, room.port));
      assert.deepEqual([post.code, post.stdout, post.stderr], [0, '', ''], rel);
    }
    assert.deepEqual(reported(room), TRACKED);
  } finally {
    await room.close();
  }
});

test('before an edit to a file git ignores, the room is not asked and nothing is said, whoever wrote it', async () => {
  const room = await startServer({ holders });
  const repo = repository();
  try {
    const sessionId = session();
    for (const rel of IGNORED) {
      const pre = await runHook('pre_tool_use.mjs', write(repo, sessionId, 'PreToolUse', rel), env(repo, room.port));
      assert.deepEqual([pre.code, pre.stdout, pre.stderr], [0, '', ''], rel);
    }
    assert.deepEqual(checked(room), [], 'never merged, so nothing to ask');

    // a tracked file is still asked about, and alice's edit there still said
    for (const rel of TRACKED) {
      const pre = await runHook('pre_tool_use.mjs', write(repo, sessionId, 'PreToolUse', rel), env(repo, room.port));
      assert.equal(pre.code, 0);
      assert.match(JSON.parse(pre.stdout).hookSpecificOutput.additionalContext, /alice's agent/, rel);
    }
    assert.deepEqual(checked(room), TRACKED);
  } finally {
    await room.close();
  }
});

test('a patch is checked and reported for its tracked files only', async () => {
  const room = await startServer({ holders });
  const repo = repository();
  const patch = [
    '*** Begin Patch',
    '*** Add File: .env',
    '+API_URL=1',
    '*** Update File: src/models/team.ts',
    '@@',
    '-export interface Team { id: string }',
    '+export interface Team { id: string; name: string }',
    '*** Add File: scratch/notes.ts',
    '+export const API_URL = 1;',
    '*** End Patch',
  ].join('\n');
  const call = (event) => ({ session_id: session(), cwd: repo, hook_event_name: event, tool_name: 'apply_patch', tool_input: { command: patch } });
  try {
    const pre = await runHook('pre_tool_use.mjs', call('PreToolUse'), env(repo, room.port));
    assert.equal(pre.code, 0);
    const advice = JSON.parse(pre.stdout).hookSpecificOutput.additionalContext;
    assert.equal((advice.match(/\[AgentMash:/g) ?? []).length, 1, 'one advisory, for the one tracked file');
    assert.match(advice, /src\/models\/team\.ts/);
    assert.deepEqual(checked(room), ['src/models/team.ts']);

    const post = await runHook('post_tool_use.mjs', call('PostToolUse'), env(repo, room.port));
    assert.deepEqual([post.code, post.stdout, post.stderr], [0, '', '']);
    assert.deepEqual(reported(room), ['src/models/team.ts']);
  } finally {
    await room.close();
  }
});

// git never commits or merges its own directory, and `git check-ignore` says
// nothing about it either way: a hook script or info/exclude written there is
// nobody else's business, in the main checkout or in a linked worktree.
const IN_GIT_DIR = ['.git/hooks/pre-commit', '.git/info/exclude'];

test('a file under .git/ is not in the repository: not reported, not asked about, in a worktree too', async () => {
  const room = await startServer({ holders: IN_GIT_DIR.map((file_path) => ({ ...HOLDER, file_path })) });
  const repo = repository();
  try {
    const sessionId = session();
    for (const rel of IN_GIT_DIR) {
      writeFile(repo, rel, '#!/bin/sh\nnpm test\n');
      const post = await runHook('post_tool_use.mjs', write(repo, sessionId, 'PostToolUse', rel), env(repo, room.port));
      assert.deepEqual([post.code, post.stdout, post.stderr], [0, '', ''], rel);
      const pre = await runHook('pre_tool_use.mjs', write(repo, sessionId, 'PreToolUse', rel), env(repo, room.port));
      assert.deepEqual([pre.code, pre.stdout, pre.stderr], [0, '', ''], rel);
    }
    assert.deepEqual(reported(room), []);
    assert.deepEqual(checked(room), []);
  } finally {
    await room.close();
  }

  const worktree = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-ignored-wt-'))), 'feature');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature', worktree], { cwd: repo, env: { ...baseEnv, ...gitEnv }, stdio: 'ignore' });
  for (const rel of IN_GIT_DIR) assert.equal(lib.locateInRepo(repo, path.join(repo, ...rel.split('/'))), null, rel);
  assert.equal(lib.locateInRepo(worktree, path.join(worktree, '.git')), null, "a worktree's .git file");
  assert.equal(lib.locateInRepo(worktree, path.join(repo, '.git', 'worktrees', 'feature', 'HEAD')), null, "its git directory, in the main checkout's .git");
  assert.equal(lib.locateInRepo(worktree, path.join(repo, '.GIT', 'config')), null, 'any case, as git reads it');
  // a file whose name only starts with .git is in the repository like any other
  assert.deepEqual(lib.locateInRepo(worktree, path.join(worktree, '.gitignore')), { rel: '.gitignore', top: worktree });
  assert.deepEqual(lib.locateInRepo(repo, path.join(repo, '.github', 'workflows', 'ci.yml')), { rel: '.github/workflows/ci.yml', top: repo });
});

test('git is asked once a session about a file, until what its answer was read from changes', async () => {
  const repo = repository();
  const sessionId = session();
  const at = (rel) => ({ rel, top: repo });
  const rels = (set) => [...set].map((t) => t.rel).sort();
  const files = () => ['.env', 'scratch/notes.ts', 'src/models/user.ts', 'dist/vendor.js'].map(at);

  assert.deepEqual(rels(await lib.gitIgnored(files(), { sessionId })), ['.env', 'scratch/notes.ts']);
  assert.deepEqual(rels(await lib.gitIgnored(files(), { sessionId, budgetMs: 0 })), ['.env', 'scratch/notes.ts'], 'from the session, with no time to ask git');
  assert.deepEqual(rels(await lib.gitIgnored(files(), { sessionId: session(), budgetMs: 0 })), [], 'another session has no answers, and git no time');

  // .gitignore changed: every answer read from it is asked again
  writeFile(repo, '.gitignore', 'scratch/\ndist/\n');
  assert.deepEqual(rels(await lib.gitIgnored(files(), { sessionId, budgetMs: 0 })), [], 'no answer is taken from before the change');
  assert.deepEqual(rels(await lib.gitIgnored(files(), { sessionId })), ['scratch/notes.ts']);

  // a file added since is tracked, and merged like any other
  writeFile(repo, 'scratch/notes.ts', 'export const API_URL = 1;\n');
  execFileSync('git', ['add', '-f', 'scratch/notes.ts'], { cwd: repo, env: { ...baseEnv, ...gitEnv }, stdio: 'ignore' });
  assert.deepEqual(rels(await lib.gitIgnored(files(), { sessionId })), []);

  // in no repository at all, nothing is ignored, and git is not asked
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmash-ignored-plain-')));
  assert.deepEqual(rels(await lib.gitIgnored([{ rel: '.env', top: elsewhere }], { sessionId })), []);
});

// git quotes a name with a quote, a backslash, a tab, a newline or DEL in it
// ("scratch/q\"uote.ts") even with core.quotePath off, and a quoted name
// matches no file asked about. git answers about a name whether or not the
// file is there, so the ones Windows can't hold are asked about there too.
test('a file git ignores is found ignored whatever its name holds', async () => {
  const repo = repository();
  const names = ['scratch/q"uote.ts', 'scratch/t\tab.ts', 'scratch/new\nline.ts', 'scratch/del\x7f.ts', 'scratch/заметки.md', 'scratch/plain.ts'];
  const asked = [...names, 'src/models/user.ts', 'src/q"uote.ts'].map((rel) => ({ rel, top: repo }));
  const ignored = [...(await lib.gitIgnored(asked, { sessionId: session(), budgetMs: 5000 }))].map((t) => t.rel);
  assert.deepEqual(ignored.sort(), [...names].sort());
});
