#!/usr/bin/env node
// AgentMash git client — reports the files a commit touched.
//
// This is the half of the team Claude Code hooks cannot see: someone on Cursor,
// someone in vim, someone who never opens an agent at all. It cannot watch work
// in progress the way an editor hook can (see docs/ADAPTERS.md for exactly what
// that costs) — it reports where a person landed, not where they are.
//
// Invoked in the background by .git/hooks/post-commit, which has already
// returned control to git. Same contract as every other client: hard timeouts,
// no retries, exit 0 whatever happens, never a word on stdout.
//
//   node git_post_commit.mjs [repo-root] [commit-ish] [ref]
//
// The hook passes the commit it ran for and what HEAD named then
// (refs/heads/<branch>, or HEAD when detached): this runs after it, in the
// background, when a second commit or a checkout may have moved HEAD on.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Installed at .claude/agentmash/git_post_commit.mjs, next to lib.mjs; in this
// checkout it sits in clients/git/ instead. Try both rather than duplicating
// the config, identity and timeout rules that lib.mjs already owns.
const lib = await import(new URL('./lib.mjs', import.meta.url).href).catch(() =>
  import(new URL('../../hooks/lib.mjs', import.meta.url).href)
);
const { armExitGuard, finish, getDeveloper, getGitBranch, httpJson, loadConfig, truncate } = lib;

// A commit is many events, so this guard is looser than a hook's — but it still
// bounds a worker that finds a server which accepts connections and never answers.
armExitGuard(20_000);

// One commit that renames a directory can touch hundreds of files. Reporting all
// of them buries the room in noise for no extra signal, so take the first slice
// and say so.
const MAX_FILES = 50;
// Whole-run budget. Past this we stop mid-commit rather than keep a background
// process alive against a wedged server.
const TOTAL_BUDGET_MS = 10_000;
// Reserved out of that budget for the session_end, which is the one event the
// room cannot do without: skip it and `commit-<sha>` sits in the dashboard as an
// active session for the next hour, which is exactly the lie PROTOCOL.md §4.1
// forbids. It is one request, and it is the cheapest one in the batch.
const SESSION_END_RESERVE_MS = 2_500;
// One connection per event, closed after each (see lib.mjs), so a 300 ms server
// costs 300 ms per file when posted serially — 50 files does not fit in the
// budget on any ordinary network. A small pool does, and five in flight from a
// background process is nothing for a server that already accepts a whole team.
const EDIT_CONCURRENCY = 5;
// Bounded memory of what we have already reported. Enough to cover a long
// afternoon of rebasing; an amend is caught by the tree hash, not by this list.
const REMEMBERED_COMMITS = 100;

// Read as UTF-8, which is what git writes names and subjects in. windowsHide:
// started by a GUI git client, the worker has no console of its own, and on
// Windows each git it runs would flash one up.
function git(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    timeout: 3000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).toString('utf8');
}

/**
 * Where to keep the "already reported" list. The git directory, because it is
 * per-repository, survives reboots, and is never committed — this is local
 * bookkeeping, not something a teammate should receive.
 */
function reportedFile(repo) {
  let dir = '.git';
  try {
    dir = git(repo, ['rev-parse', '--git-dir']).trim() || '.git';
  } catch {
    // not a repo, or git is missing — the caller already bailed if so
  }
  return path.resolve(repo, dir, 'agentmash-reported.json');
}

function readReported(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    // Entries written before this client remembered trees are bare sha strings.
    return parsed.map((entry) => (typeof entry === 'string' ? { sha: entry } : entry)).filter(Boolean);
  } catch {
    return []; // first commit, or a corrupt file we are about to replace
  }
}

/**
 * The protocol promises no deduplication, so being idempotent over our own
 * re-runs is our job. post-commit fires again for a cherry-pick, and a
 * reset-then-recommit can reproduce a sha exactly.
 *
 * The tree hash is what catches an amend: `git commit --amend -m ...` mints a
 * new sha for work already in the room, so a sha-keyed list would report it
 * twice. Same tree, same files, same work — the cost of this is that a commit
 * which restores an earlier tree exactly (a revert of a revert) goes unreported,
 * which is a far rarer event than an amend.
 */
function alreadyReported(file, sha, tree) {
  return readReported(file).some((e) => e.sha === sha || (tree && e.tree === tree));
}

function rememberReported(file, sha, tree) {
  try {
    const list = readReported(file);
    list.push({ sha, tree });
    fs.writeFileSync(file, JSON.stringify(list.slice(-REMEMBERED_COMMITS)));
  } catch {
    // a read-only .git must not break the commit that just happened
  }
}

/**
 * AgentMash's own install, committed so a teammate's pull brings it: the
 * hooks, the MCP server, this script and the room's config. Its files are no
 * one's work in progress, and reported they read as a hot zone nobody is in.
 */
const OWN_INSTALL = '.claude/agentmash/';

/**
 * `added removed path` per file, and whether the commit deleted it: a file it
 * removed is reported as deleted, not as lines taken out, so a teammate about
 * to edit it is told it is gone (removalOf in lib.mjs). Binary files report
 * "-" for both counts.
 */
function changedFiles(repo, sha) {
  // --raw beside --numstat: its entries say what happened to each file, D for
  // deleted. -z gives each name as it is, where git would otherwise quote one
  // past ASCII ("\320\277...md" for привет.md, a file nobody has), and ends
  // each field with a NUL: a --raw entry is two fields, what happened and then
  // the name, a --numstat entry one.
  const out = git(repo, ['show', '--raw', '--numstat', '-z', '--format=', '--no-renames', sha]);
  const deleted = new Set();
  const files = [];
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const raw = fields[i].replace(/^\n+/, '').match(/^:[0-7]+ [0-7]+ \S+ \S+ (\S+)$/);
    if (raw) {
      const name = fields[++i] ?? '';
      if (raw[1] === 'D') deleted.add(name.replace(/\\/g, '/'));
      continue;
    }
    const m = fields[i].replace(/^\n+/, '').match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
    if (!m) continue;
    files.push({ added: m[1], removed: m[2], file: m[3].replace(/\\/g, '/') });
  }
  for (const f of files) f.deleted = deleted.has(f.file);
  return files;
}

async function main() {
  const repo = path.resolve(process.argv[2] || process.cwd());
  // the repository's room, with this machine's sign-in beside its key, as the
  // hooks send it (lib.withSignIn): a key in a public repository opens its room
  // only beside a sign-in that can push there. A lib from before it sends the key alone.
  let config = lib.withSignIn?.(loadConfig(repo)) ?? loadConfig(repo);
  // A repository connected on the website commits nothing, so it has no room
  // of its own to read. On a machine signed in with `npx agentmash login`,
  // the room is the one its GitHub repository is connected to, looked up as
  // the login's hooks look it up (lib.resolveConfig) and reported to under
  // the sign-in. A room the repository carries is never swapped for it.
  if (!config.room && !config.disabled && lib.resolveConfig && !lib.hasRepoInstall?.(repo)) {
    const signedIn = await lib.resolveConfig(repo, { global: true });
    if (signedIn.global && signedIn.room) config = signedIn;
  }
  if (config.disabled || !config.room) return;

  let head;
  try {
    // sha \n parents \n tree \n committer date \n subject
    head = git(repo, ['log', '-1', '--format=%H%n%P%n%T%n%cI%n%s', process.argv[3] || 'HEAD']).split('\n');
  } catch {
    return; // no commits, no git, shallow weirdness — none of it is our business
  }
  const [sha, parents, tree, when, ...subjectParts] = head;
  if (!sha) return;

  // A merge commit's diff is its whole branch. Reporting it would claim the
  // merger touched every file on it, which is false and drowns the room.
  if (parents.trim().split(/\s+/).filter(Boolean).length > 1) return;

  const seen = reportedFile(repo);
  if (alreadyReported(seen, sha, tree)) return;

  let files;
  try {
    files = changedFiles(repo, sha);
  } catch {
    return;
  }
  // a commit of nothing but the install, `git add .claude` after init, is
  // reported as nothing at all: no edits, and no session for none
  files = files.filter((f) => !f.file.startsWith(OWN_INSTALL));
  if (files.length === 0) return;

  const short = sha.slice(0, 7);
  const truncated = files.length > MAX_FILES;
  const reporting = files.slice(0, MAX_FILES);

  const developer = getDeveloper(config, repo);
  // The branch the commit was made on, as the hook saw it. A detached HEAD
  // (mid-rebase, say), or a hook from before it said one, leaves it to the
  // checkout as it is now, which is what getGitBranch has always read.
  const said = /^refs\/heads\/(.+)$/.exec(process.argv[4] || '');
  const branch = said ? said[1] : getGitBranch(repo);
  const timestamp = when || new Date().toISOString();
  // The commit is finished the moment we can see it, so it gets its own session
  // id and is closed out below — leaving it "active" would be a lie the
  // dashboard repeats for an hour.
  const sessionId = `commit-${short}`;
  // The subject is what the author says they did, sent where the hooks send a
  // prompt, so AGENTMASH_HINTS=0 (or share_hints false) keeps it on this
  // machine as it keeps a prompt there: the commit's files still go out. A
  // secret in it is masked as a prompt's is (redactSecrets in lib.mjs); a lib
  // from before that sends it as it is.
  const written = subjectParts.join('\n');
  const subject = config.shareHints ? truncate((lib.redactSecrets?.(written) ?? written) || `commit ${short}`, 200) : null;

  // With the credentials the hooks send: the room's key, and the developer
  // token this machine holds for the room, which a room that requires them
  // will not take an event without.
  const post = (body) =>
    httpJson('POST', `${config.url}/events`, {
      room: config.room,
      token: config.token,
      user: config.user,
      dev: config.dev,
      timeoutMs: config.reportTimeoutMs,
      body: { developer, session_id: sessionId, git_branch: branch, task_hint: subject, timestamp, ...body },
    });

  // Noted before anything is sent, not after: the hooks report a commit made
  // in a session from the reflog (commitCatchUp in lib.mjs) and leave alone
  // one this list has, so a commit noted only once it was posted could be
  // reported by both. A post that then fails costs the commit its report,
  // which is what a timeout here always cost.
  rememberReported(seen, sha, tree);

  const editDeadline = Date.now() + TOTAL_BUDGET_MS - SESSION_END_RESERVE_MS;
  const queue = reporting.slice();
  const note = truncated ? `, ${files.length} files in this commit` : '';
  const sendOne = async () => {
    while (queue.length > 0 && Date.now() < editDeadline) {
      const f = queue.shift();
      const scale = f.deleted
        ? 'deleted'
        : f.added === '-' || f.removed === '-'
          ? 'binary file'
          : `+${f.added}/-${f.removed} lines`;
      await post({
        event_type: 'edit',
        tool: 'git-commit',
        file_path: f.file,
        // the commit is in this checkout and in no other until it is pushed
        // and pulled: an id that names neither machine nor folder says which
        checkout_id: lib.checkoutId?.(repo) ?? null,
        change_summary: `commit ${short} · ${scale}${note}`,
      });
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(EDIT_CONCURRENCY, queue.length) }, sendOne)
    );
  } finally {
    // Always, even when the edits ran out of budget or threw: a half-reported
    // commit is a small inaccuracy, an unclosed session is a standing one.
    await post({ event_type: 'session_end', tool: 'git-commit' });
  }
}

main()
  .catch(() => {})
  .finally(finish);
