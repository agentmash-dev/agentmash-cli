#!/usr/bin/env node
// Copy the files the published package has to carry into the CLI package: the
// hook scripts it installs, with the MCP launcher and the server it starts and
// the generic hook other agents run (with every dialect it answers in),
// the other protocol clients it installs, mcp/server.mjs, the vendored
// crew `agentmash crew` installs from, and the digest `agentmash digest` runs.
//
// `files` in package.json cannot reach outside the package directory, so the
// only way the published tarball can carry ../hooks, ../clients, ../mcp,
// ../crew and ../digest is a copy made before the tarball is built. This runs
// as `prepare`, which npm fires both on a workspace install (so a checkout
// stays in sync) and before pack/publish. In the repo the CLI falls back to
// ../hooks, ../clients, ../mcp, ../crew and ../digest, so cli/hooks/,
// cli/clients/, cli/mcp/, cli/crew/ and cli/digest/ are build artifacts, not
// source — they are gitignored.
//
// The crew copy is checked against crew/crew.lock.json as well as against
// ../crew: the lock is what names the tagged release, so a crew/ edited by hand
// stops the pack here instead of shipping to everyone who runs npx. Its
// README.md goes along because it carries the crew's MIT notice, which has to
// travel with copies of its code.
//
// The MCP server is hooks/mcp_server.mjs, installed with the hooks. The
// package also carries mcp/server.mjs, which re-exports it from ../hooks/:
// that is where a launcher committed before the server shipped with the hooks
// looks for it, in node_modules/agentmash/mcp/. cli/mcp/ sits beside cli/hooks/
// exactly as mcp/ sits beside hooks/, so that import keeps resolving.
//
// It also stamps this package's own version into the launcher's `npx` pin,
// into the server and into the hooks' lib.mjs. All three are committed into a
// consumer's repo, so whatever they say is frozen there until someone re-runs
// `init`; generating it here is what keeps the pin naming a version that
// actually exists, and the server's and the hooks' versions true, which a
// launcher, and a newer login's hooks, compare with the copy a login keeps.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The line the launcher marks for stamping, e.g. `const PINNED_VERSION = '0.2.0'; // agentmash:pin` */
const PIN_LINE = /^(const PINNED_VERSION = ')([^']*)('; \/\/ agentmash:pin)$/m;

/**
 * Replace the launcher's pinned version with the one being packed. Throws
 * rather than returning the source unchanged: a silent miss here is exactly
 * how a shipped launcher comes to fetch a version nobody published.
 */
export function stampVersion(source, version) {
  if (!PIN_LINE.test(source)) {
    throw new Error('mcp_launcher.mjs has no `// agentmash:pin` line to stamp the version into');
  }
  return source.replace(PIN_LINE, `$1${version}$3`);
}

/** The server's own line, e.g. `export const VERSION = '0.5.0'; // agentmash:version` */
const VERSION_LINE = /^(export const VERSION = ')([^']*)('; \/\/ agentmash:version)$/m;

/** The same for the MCP server's version, and it throws for the same reason. */
export function stampServerVersion(source, version) {
  if (!VERSION_LINE.test(source)) {
    throw new Error('mcp_server.mjs has no `// agentmash:version` line to stamp the version into');
  }
  return source.replace(VERSION_LINE, `$1${version}$3`);
}

/** The hooks' own line in lib.mjs, e.g. `export const HOOKS_VERSION = '0.5.0'; // agentmash:hooks-version` */
const HOOKS_VERSION_LINE = /^(export const HOOKS_VERSION = ')([^']*)('; \/\/ agentmash:hooks-version)$/m;

/**
 * The same for the hooks' version, which they send with every request and a
 * login's newer copy compares a repository's committed one with. It throws
 * for the same reason: a copy that says no version reads as an old one.
 */
export function stampHooksVersion(source, version) {
  if (!HOOKS_VERSION_LINE.test(source)) {
    throw new Error('lib.mjs has no `// agentmash:hooks-version` line to stamp the version into');
  }
  return source.replace(HOOKS_VERSION_LINE, `$1${version}$3`);
}

/**
 * The generic hook's dialects, every file in hooks/dialects/: one is added
 * there and ships, with no line here (`npx agentmash login` copies them all).
 */
function dialectFiles(hooksDir = path.join(here, '..', 'hooks')) {
  try {
    return fs
      .readdirSync(path.join(hooksDir, 'dialects'))
      .filter((f) => f.endsWith('.mjs'))
      .sort()
      .map((f) => `dialects/${f}`);
  } catch {
    return [];
  }
}

const sets = [
  {
    dir: 'hooks',
    files: [
      'lib.mjs',
      'pre_tool_use.mjs',
      'post_tool_use.mjs',
      'user_prompt_submit.mjs',
      'prompt_note.mjs',
      'session_end.mjs',
      'stop.mjs',
      'session_start.mjs',
      'mcp_launcher.mjs',
      'mcp_server.mjs',
      'mcp_coordination.mjs',
      'mcp_render.mjs',
      // the generic hook any agent with hooks runs, and the answers it gives, at user level only
      'agent_hook.mjs',
      ...dialectFiles(),
    ],
  },
  { dir: 'mcp', files: ['server.mjs'] },
  { dir: 'clients', files: ['git/post_commit.mjs', 'cursor/after_file_edit.mjs', 'amp/plugin.mjs'] },
  { dir: 'crew', files: ['bundle.json', 'install.mjs', 'team-plan.mjs', 'crew.lock.json', 'README.md'] },
  // the digest's command line and what it loads (digest.mjs's DIGEST_FILES), not its bin or its tests
  { dir: 'digest', files: ['src/cli.mjs', 'src/aggregate.mjs', 'src/net.mjs', 'src/render.mjs'] },
];

/**
 * Throws unless every crew file in `dir` has the sha256 crew.lock.json gives
 * it. Only the files this package ships are checked; catalog.json and the
 * TypeScript declarations stay in the repo.
 */
export function verifyCrewCopy(dir, files) {
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'crew.lock.json'), 'utf8'));
  for (const file of files.filter((f) => f !== 'crew.lock.json')) {
    const actual = createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex');
    if (actual !== lock.files?.[file]) {
      throw new Error(
        `crew/${file} does not match crew/crew.lock.json; crew/ is written by tools/sync-crew.mjs, never by hand`
      );
    }
  }
}

/**
 * Replace `dest` through a sibling temporary file and a rename. `node --test`
 * runs the test files in parallel and more than one of them runs this sync (on
 * import, or through npm pack's prepare), so a copy that truncates in place can
 * be read half-written by another process's check or pack. A rename is atomic:
 * every reader sees a whole file, and every writer writes the same bytes.
 */
function replaceAtomically(dest, write) {
  const temp = `${dest}.${process.pid}.tmp`;
  try {
    write(temp);
    renameRetrying(temp, dest);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/**
 * Windows refuses a rename onto a file that another process is renaming onto
 * at that same moment (EPERM, at times EACCES or EBUSY), which is exactly what
 * the parallel syncs above do: three at once failed two times in three. Every
 * one of them writes the same bytes, so a refused rename is tried again for a
 * moment, the way graceful-fs retries one, and only then fails the sync.
 */
function renameRetrying(from, to) {
  const deadline = Date.now() + 3000;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err?.code) || Date.now() > deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

/**
 * Whether a temporary file replaceAtomically names `<file>.<pid>.tmp` belongs
 * to a sync that is still running, and so is on its way to a rename. One whose
 * process is gone, killed between the write and the rename, never gets there.
 * A process this one may not signal (EPERM) is running.
 */
function inFlight(name) {
  const pid = Number(name.match(/\.(\d+)\.tmp$/)?.[1]);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Take out what an earlier sync left in `dest` and this one no longer copies,
 * since `files` in package.json packs whatever these folders hold: when
 * mcp/coordination.mjs and mcp/render.mjs moved into hooks/, a checkout that
 * had synced before would have shipped the old copies beside the new ones.
 * Another process's temporary file, on its way to a rename, is left alone,
 * and one a dead sync left behind goes with the rest.
 */
export function pruneStale(dest, files) {
  const keep = new Set(files.map((f) => path.normalize(f)));
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (!keep.has(path.relative(dest, abs)) && !inFlight(entry.name)) fs.rmSync(abs, { force: true });
    }
  };
  walk(dest);
}

/**
 * The files among `rels` (paths under `root`; a folder is walked whole) with a
 * CRLF line ending, as `/`-separated paths. A Windows checkout with
 * core.autocrlf turns every text file CRLF, and a package packed from one
 * commits hooks that differ from the web installer's on every line: 0.12.0
 * shipped that way. A file with a NUL byte is binary and isn't looked at.
 */
export function crlfFiles(root, rels) {
  const found = [];
  const check = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isDirectory()) {
      for (const entry of fs.readdirSync(abs).sort()) check(path.join(rel, entry));
      return;
    }
    const bytes = fs.readFileSync(abs);
    if (!bytes.includes(0) && bytes.includes('\r\n')) found.push(rel.split(path.sep).join('/'));
  };
  for (const rel of rels) check(rel);
  return found;
}

export function sync() {
  const { version, files: packed = [] } = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
  for (const { dir, files } of sets) {
    const source = path.join(here, '..', dir);
    const dest = path.join(here, dir);
    const missing = files.filter((f) => !fs.existsSync(path.join(source, f)));
    if (missing.length) {
      console.error(`cannot build the CLI package: ${source} is missing ${missing.join(', ')}`);
      process.exit(1);
    }
    fs.mkdirSync(dest, { recursive: true });
    pruneStale(dest, files);
    for (const file of files) {
      // `clients` entries carry a subdirectory (git/, cursor/), and so do the hooks' dialects/ and the digest's src/.
      fs.mkdirSync(path.dirname(path.join(dest, file)), { recursive: true });
      replaceAtomically(path.join(dest, file), (temp) => fs.copyFileSync(path.join(source, file), temp));
      // The whole promise of this package is that its hooks match the ones the
      // web installer commits, so a half-written copy must fail the build, not
      // ship.
      if (!fs.readFileSync(path.join(dest, file)).equals(fs.readFileSync(path.join(source, file)))) {
        console.error(`copy of ${file} does not match ${path.join(source, file)}`);
        process.exit(1);
      }
    }
    if (dir === 'crew') {
      try {
        verifyCrewCopy(dest, files);
      } catch (err) {
        console.error(`cannot build the CLI package: ${err.message}`);
        process.exit(1);
      }
    }
    console.log(`synced ${files.length} files into cli/${dir}/`);
  }
  const launcher = path.join(here, 'hooks', 'mcp_launcher.mjs');
  const stamped = stampVersion(fs.readFileSync(launcher, 'utf8'), version);
  replaceAtomically(launcher, (temp) => fs.writeFileSync(temp, stamped));
  console.log(`pinned the launcher's npx fallback to agentmash@${version}`);
  const server = path.join(here, 'hooks', 'mcp_server.mjs');
  const versioned = stampServerVersion(fs.readFileSync(server, 'utf8'), version);
  replaceAtomically(server, (temp) => fs.writeFileSync(temp, versioned));
  console.log(`stamped the MCP server as ${version}`);
  const lib = path.join(here, 'hooks', 'lib.mjs');
  const hooksVersioned = stampHooksVersion(fs.readFileSync(lib, 'utf8'), version);
  replaceAtomically(lib, (temp) => fs.writeFileSync(temp, hooksVersioned));
  console.log(`stamped the hooks as ${version}`);
  // What npm packs: `files`, and the package.json, README.md and LICENSE it always takes. A pack or a publish of
  // a CRLF checkout stops here; an install or a test run on one still works, and says how to check it out again.
  const crlf = crlfFiles(here, ['package.json', 'README.md', 'LICENSE', ...packed]);
  if (crlf.length) {
    const which = `${crlf.slice(0, 3).join(', ')}${crlf.length > 3 ? ` and ${crlf.length - 3} more` : ''} ${crlf.length === 1 ? 'has' : 'have'}`;
    const how =
      'check them out again with LF, as .gitattributes asks (commit or stash first): ' +
      'git rm -r -q --cached cli hooks mcp clients digest && git reset -q --hard';
    if (['pack', 'publish', 'stage'].includes(process.env.npm_command ?? '')) {
      console.error(`cannot build the CLI package: ${which} CRLF line endings; ${how}`);
      process.exit(1);
    }
    console.warn(`${which} CRLF line endings, so a pack from this checkout would stop; ${how}`);
  }
  return version;
}

// Runs on import too: everything it writes is a build artefact under cli/, so a
// test can import `stampVersion` and check the stamped copy the packer produces.
sync();
