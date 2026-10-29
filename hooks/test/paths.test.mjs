// Which files belong to a room. A room is one repository, so a file is
// reported only when it is in the same repository as the session's project:
// the same checkout, or another worktree of it. Anything else (another
// repository open beside it, a scratch file, ~/.claude, another drive) is no
// business of the room's, and reported, it used to land there as an absolute
// path that named this machine's folders to the whole team.
//
// Every fixture here is real: directories on disk with a .git in them, laid
// out the way git leaves them. The lexical core is also run in both path
// flavours, so the Windows cases are checked on every platform.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Namespace access, so a helper that does not exist yet fails its own tests
// and not the whole file.
import * as lib from '../lib.mjs';

const WIN = process.platform === 'win32';

/** A fresh directory, as the disk spells it. The prefixes carry a space, as "comp programming" does. */
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/** A checkout: a .git directory with a HEAD, which is all these helpers read. */
function checkout(prefix, branch = 'main') {
  const dir = tmp(prefix);
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  return dir;
}

function touch(dir, rel, content = 'x\n') {
  const file = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Another worktree of `main`, laid out the way `git worktree add` leaves one. */
function worktree(main, name, branch) {
  const wt = tmp(`comp programming-${name}-`);
  const gitDir = path.join(main, '.git', 'worktrees', name);
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir.split(path.sep).join('/')}\n`);
  return wt;
}

/** A directory link, or null where this machine may not make one. Junctions need no privilege on Windows. */
function link(target, at) {
  try {
    fs.symlinkSync(target, at, 'junction');
    return at;
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') return null;
    throw err;
  }
}

const slashed = (p) => p.split(path.sep).join('/');

test('a file in another repository is not the room\'s, however its path is spelled', () => {
  const sandbox = checkout('comp programming-sandbox-');
  const hero = checkout('comp programming-hero-', 'dogfood');
  const film = touch(hero, 'landing/src/home/Film.tsx');

  for (const spelling of [film, slashed(film)]) {
    assert.equal(lib.toRepoRelative(sandbox, spelling), null, spelling);
    assert.equal(lib.locateInRepo(sandbox, spelling), null, spelling);
  }

  // A directory whose name only starts with the project's is somewhere else.
  const prefixSibling = `${sandbox}-researchquest`;
  fs.mkdirSync(prefixSibling);
  assert.equal(lib.toRepoRelative(sandbox, touch(prefixSibling, 'a.ts')), null, 'a shared prefix is not a directory');

  // Scratch files and the home directory are in no repository at all.
  assert.equal(lib.toRepoRelative(sandbox, touch(tmp('agentmash-scratch-'), 'notes.md')), null, 'a scratch file');
  assert.equal(lib.toRepoRelative(sandbox, '~/.claude/CLAUDE.md'), null, '~ is the home directory, not a folder in the repo');
  assert.equal(lib.toRepoRelative(sandbox, path.join(os.homedir(), '.claude', 'CLAUDE.md')), null);
});

test('another drive is another place', { skip: !WIN && 'drive letters are a Windows thing' }, () => {
  const sandbox = checkout('comp programming-sandbox-');
  const drive = sandbox[0].toUpperCase() === 'Q' ? 'R' : 'Q';
  assert.equal(lib.toRepoRelative(sandbox, `${drive}:\\notes\\a.ts`), null);
  assert.equal(lib.toRepoRelative(sandbox, `${drive}:/${slashed(sandbox).slice(3)}/src/a.ts`), null, 'the same folders on another drive');
});

test('inside the repository, every spelling of a path is the one path the room knows', () => {
  const sandbox = checkout('comp programming-sandbox-');
  const file = touch(sandbox, 'src/models/user.ts');
  const expected = 'src/models/user.ts';

  assert.equal(lib.toRepoRelative(sandbox, file), expected, 'native separators');
  assert.equal(lib.toRepoRelative(sandbox, slashed(file)), expected, 'forward slashes');
  assert.equal(lib.toRepoRelative(sandbox, `${sandbox}${path.sep}src/models${path.sep}user.ts`), expected, 'mixed');
  assert.deepEqual(lib.locateInRepo(sandbox, file), { rel: expected, top: sandbox });

  // A relative path is relative to where the agent is, else to the project.
  assert.equal(lib.toRepoRelative(sandbox, 'src/models/user.ts'), expected);
  assert.equal(lib.locateInRepo(sandbox, 'models/user.ts', { cwd: path.join(sandbox, 'src') })?.rel, expected);
  assert.equal(lib.locateInRepo(sandbox, '../README.md', { cwd: path.join(sandbox, 'src') })?.rel, 'README.md');
  assert.equal(lib.locateInRepo(sandbox, '../../elsewhere.ts', { cwd: path.join(sandbox, 'src') }), null);
});

test('on Windows, the case and the Git Bash spelling are the disk\'s', { skip: !WIN && 'Windows paths' }, () => {
  const sandbox = checkout('comp programming-sandbox-');
  const file = touch(sandbox, 'src/models/user.ts');

  assert.equal(lib.toRepoRelative(sandbox.toUpperCase(), file.toLowerCase()), 'src/models/user.ts');
  assert.equal(lib.toRepoRelative(sandbox, path.join(sandbox, 'SRC', 'Models', 'USER.ts')), 'src/models/user.ts');
  const msys = `/${sandbox[0].toLowerCase()}/${slashed(sandbox).slice(3)}/src/models/user.ts`;
  assert.equal(lib.toRepoRelative(sandbox, msys), 'src/models/user.ts', msys);
});

test('a file whose name starts with two dots is still in the repository', () => {
  const sandbox = checkout('comp programming-sandbox-');
  assert.equal(lib.toRepoRelative(sandbox, touch(sandbox, '..env')), '..env');
  assert.equal(lib.toRepoRelative(sandbox, touch(sandbox, '...x/y.ts')), '...x/y.ts');
});

test('a project opened below the repository\'s root reports paths from the root', () => {
  const repo = checkout('comp programming-mono-');
  const web = path.join(repo, 'packages', 'web');
  fs.mkdirSync(web, { recursive: true });
  // The same file is the same string whichever folder a teammate opened.
  assert.equal(lib.toRepoRelative(web, touch(repo, 'packages/web/src/a.ts')), 'packages/web/src/a.ts');
  assert.equal(lib.toRepoRelative(web, touch(repo, 'packages/api/b.ts')), 'packages/api/b.ts');
});

test('a repository inside this one, or a submodule, is its own', () => {
  const sandbox = checkout('comp programming-sandbox-');
  const nested = path.join(sandbox, 'vendor', 'other');
  fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
  assert.equal(lib.toRepoRelative(sandbox, touch(nested, 'index.js')), null, 'a nested repository');

  const moduleDir = path.join(sandbox, '.git', 'modules', 'sub');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'HEAD'), 'ref: refs/heads/main\n');
  const sub = path.join(sandbox, 'libs', 'sub');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../../.git/modules/sub\n');
  assert.equal(lib.toRepoRelative(sandbox, touch(sub, 'lib.c')), null, 'a submodule');

  assert.equal(lib.toRepoRelative(sandbox, touch(sandbox, 'vendor/readme.md')), 'vendor/readme.md', 'beside them is still ours');
});

test('another worktree of the same repository is the same repository', () => {
  const main = checkout('comp programming-agentmesh-');
  const hero = worktree(main, 'hero', 'dogfood');
  const film = touch(hero, 'landing/src/home/Film.tsx');

  // Relative to the worktree the file is in: what `git status` there prints.
  assert.deepEqual(lib.locateInRepo(main, film), { rel: 'landing/src/home/Film.tsx', top: hero });
  assert.deepEqual(lib.locateInRepo(hero, touch(main, 'server/src/app.ts')), { rel: 'server/src/app.ts', top: main });
  assert.equal(lib.getGitBranch(hero), 'dogfood', 'and its branch is its own');

  assert.deepEqual(lib.gitCheckout(path.join(hero, 'landing', 'src')), {
    top: hero,
    gitDir: path.join(main, '.git', 'worktrees', 'hero'),
    commonDir: path.join(main, '.git'),
  });
  assert.deepEqual(lib.gitCheckout(main), { top: main, gitDir: path.join(main, '.git'), commonDir: path.join(main, '.git') });
  assert.equal(lib.gitCheckout(tmp('agentmash-plain-')), null, 'not a checkout');
});

test('mid-rebase, the branch is the one being rebased, not the sha HEAD is detached at', () => {
  // A rebase detaches HEAD while it replays a branch, and an edit made then
  // (a conflict being resolved) was reported on "branch 3c271f4". Git keeps
  // the branch's name beside it, in the checkout's own git directory.
  const sha = '3c271f4aaed98c163cacd08f1d2e3a4b5c6d7e8f';
  const detached = (dir) => fs.writeFileSync(path.join(dir, 'HEAD'), `${sha}\n`);
  const headName = (dir, kind, text) => {
    fs.mkdirSync(path.join(dir, kind), { recursive: true });
    if (text !== null) fs.writeFileSync(path.join(dir, kind, 'head-name'), `${text}\n`);
  };

  for (const kind of ['rebase-merge', 'rebase-apply']) {
    const repo = checkout('comp programming-rebase-');
    detached(path.join(repo, '.git'));
    assert.equal(lib.getGitBranch(repo), '3c271f4', 'detached, and no rebase: the short sha, as before');
    headName(path.join(repo, '.git'), kind, 'refs/heads/feature/soft-delete');
    assert.equal(lib.getGitBranch(repo), 'feature/soft-delete', kind);
  }

  // a worktree rebases in its own git directory, and the main checkout is not rebasing
  const main = checkout('comp programming-agentmesh-', 'main');
  const hero = worktree(main, 'hero', 'dogfood');
  const heroGit = path.join(main, '.git', 'worktrees', 'hero');
  detached(heroGit);
  headName(heroGit, 'rebase-merge', 'refs/heads/dogfood');
  assert.equal(lib.getGitBranch(hero), 'dogfood');
  assert.equal(lib.getGitBranch(main), 'main');

  // `git am` keeps rebase-apply with no head-name, and a rebase of a detached HEAD names none: no branch either way
  const am = checkout('comp programming-am-');
  detached(path.join(am, '.git'));
  headName(path.join(am, '.git'), 'rebase-apply', null);
  assert.equal(lib.getGitBranch(am), '3c271f4');
  const loose = checkout('comp programming-loose-');
  detached(path.join(loose, '.git'));
  headName(path.join(loose, '.git'), 'rebase-merge', 'detached HEAD');
  assert.equal(lib.getGitBranch(loose), '3c271f4');
});

test('a Write into a directory that does not exist yet is still located', () => {
  const sandbox = checkout('comp programming-sandbox-');
  assert.equal(lib.toRepoRelative(sandbox, path.join(sandbox, 'src', 'brand', 'new', 'file.ts')), 'src/brand/new/file.ts');
  const hero = checkout('comp programming-hero-');
  assert.equal(lib.toRepoRelative(sandbox, path.join(hero, 'not', 'there', 'yet.ts')), null);
});

test('a project that is not a git checkout is its own boundary', () => {
  const plain = tmp('comp programming-plain-');
  assert.equal(lib.toRepoRelative(plain, path.join(plain, 'src', 'a.ts')), 'src/a.ts');
  assert.equal(lib.toRepoRelative(plain, touch(tmp('comp programming-beside-'), 'b.ts')), null, 'outside it');

  const inner = path.join(plain, 'inner');
  fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
  assert.equal(lib.toRepoRelative(plain, touch(inner, 'c.ts')), null, 'a repository inside it is somebody else\'s');
});

test('a link into the repository counts where it lands, and a link out of it does not', (t) => {
  const sandbox = checkout('comp programming-sandbox-');
  const hero = checkout('comp programming-hero-');
  touch(sandbox, 'src/a.ts');
  touch(hero, 'landing/x.ts');

  const viaLink = link(sandbox, path.join(tmp('comp programming-links-'), 'sandbox'));
  if (!viaLink) return t.skip('this machine may not make links');
  // The project opened through a link, the file named by its real path, and back.
  assert.equal(lib.toRepoRelative(viaLink, path.join(sandbox, 'src', 'a.ts')), 'src/a.ts');
  assert.equal(lib.toRepoRelative(sandbox, path.join(viaLink, 'src', 'a.ts')), 'src/a.ts');

  // A link inside the repository to another one: git keeps a link, not the files.
  const out = link(hero, path.join(sandbox, 'linked'));
  assert.equal(lib.toRepoRelative(sandbox, path.join(out, 'landing', 'x.ts')), null);
});

test('nothing a hook can be handed makes it throw', () => {
  const sandbox = checkout('comp programming-sandbox-');
  for (const bad of ['', undefined, null, '\0', `${sandbox}${path.sep}a\0b.ts`, 42, {}, []]) {
    assert.equal(lib.locateInRepo(sandbox, bad), null, JSON.stringify(bad));
    assert.equal(lib.toRepoRelative(sandbox, bad), null, JSON.stringify(bad));
  }
  assert.equal(lib.locateInRepo(undefined, path.join(sandbox, 'a.ts')), null, 'no project, no room');
  assert.equal(lib.locateInRepo(sandbox, sandbox), null, 'the repository itself is not a file in it');
  assert.equal(lib.gitCheckout('\0'), null);
});

test('inside means inside, in either path flavour', () => {
  const { win32, posix } = path;
  const inside = lib.relativeInside;
  assert.equal(inside('C:\\repo', 'C:\\repo\\src\\a.ts', win32), 'src/a.ts');
  assert.equal(inside('C:\\repo', 'c:\\REPO\\src\\a.ts', win32), 'src/a.ts', 'Windows paths ignore case');
  assert.equal(inside('C:\\repo', 'C:\\repo\\..env', win32), '..env');
  assert.equal(inside('C:\\repo', 'C:\\repo\\...x\\y.ts', win32), '...x/y.ts');
  assert.equal(inside('C:\\repo', 'D:\\repo\\a.ts', win32), null, 'another drive');
  assert.equal(inside('C:\\repo', 'C:\\repo-x\\a.ts', win32), null, 'a shared prefix');
  assert.equal(inside('C:\\repo', 'C:\\other\\a.ts', win32), null);
  assert.equal(inside('C:\\repo', '\\\\host\\share\\a.ts', win32), null, 'a network share');
  assert.equal(inside('C:\\repo', 'C:\\repo', win32), null, 'the root is not inside itself');

  assert.equal(inside('/home/u/sandbox', '/home/u/sandbox/src/a.ts', posix), 'src/a.ts');
  assert.equal(inside('/home/u/sandbox', '/home/u/hero/landing/x.ts', posix), null);
  assert.equal(inside('/home/u/sandbox', '/home/u/sandbox/..env', posix), '..env');
  assert.equal(inside('/home/u/sandbox', '/home/u/Sandbox/a.ts', posix), null, 'POSIX paths keep their case');
  assert.equal(inside('/home/u/sandbox', '/home/u/sandbox', posix), null);
});
